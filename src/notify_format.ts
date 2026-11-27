/**
 * Presentation layer (D2 extraction): turns a scored run into human-facing text —
 * the per-reading lines, the FIN/RATE summary, and the notify-on-change payload +
 * decision. Pure (no IO); the run loop (`run-core.ts`) imports `formatRunSummary` (for the
 * console transcript), `buildNotification` (the push payload), and `PUSH_LABEL` (the
 * per-track push-log label) back from here. Extracted so notify-copy tweaks and new
 * indicators stop contending on the wiring in the run loop, and the pure formatters are
 * independently testable (`notify_format.test.ts`).
 */

import { ALL_INDICATORS } from "./registry.js";
import { CHART_ONLY_IDS } from "./registry-composite.js";
import { DUAL_AXIS_ID_SET, isVelocityLeg } from "./domain-legs.js";
import { VELOCITY_WINDOW, type Reading } from "./domain-types.js";
import { decideNotify, type AlertLevel, type Freshness } from "./ladder.js";
import type { VerdictHoldLeg } from "./alert-band.js";
import { cardGroupOf, diffusionLabel, familyOf, type FamilyPanel, rungOfSleeve, sleeveLabel } from "./families.js";
import { PILLAR_MEMBER_IDS } from "./danger-engine.js";

// Card-less CONTEXT ids (2026-08-11 `[USER]`) — scored and persisted, but with no card group and no
// family seat, NOTHING on the board shows them; a non-GREEN reading must never print in a push.
const CARDLESS_CONTEXT_IDS: readonly string[] = ALL_INDICATORS.filter(
  (i) => i.channel === "CONTEXT" && cardGroupOf(i.id) === undefined,
).map((i) => i.id);
// Display-only CONTEXT ids (card-only: no family, outside `PILLAR_MEMBER_IDS` — NVDA's weight row folds no
// cell) — carded, but they move no band, so "display-only: no notify change" keeps them out of the push body.
const DISPLAY_ONLY_CONTEXT_IDS: readonly string[] = ALL_INDICATORS.filter(
  (i) => i.channel === "CONTEXT" && familyOf(i.id) === undefined && !PILLAR_MEMBER_IDS.includes(i.id),
).map((i) => i.id);
/** The one body-exclusion predicate BOTH body inputs (driver lines, lagging-leg list) route through. */
const notifyBodyExcluded = (id: string): boolean =>
  CHART_ONLY_IDS.includes(id) || CARDLESS_CONTEXT_IDS.includes(id) || DISPLAY_ONLY_CONTEXT_IDS.includes(id);
import type { NtfyMessage } from "./ntfy.js";
import { type AlertRecord, type BandField, type DegradeEvent } from "./store.js";
import type { T1DialResult } from "./t1dial.js";
import { R4_RESTING, type R4Result } from "./r4.js";
import { resolveCash, type CashLevel } from "./cash-overlay.js";
import { BUDGET_ABORT_SCOPE } from "./fetch-budget.js";
import { oilEstDivergence, type OilNowcast } from "./oil-nowcast.js";
import { estimatorOf } from "./nowcast-score.js";
import { DISCLAIMER_SHORT } from "./disclaimer.js";

/**
 * Audit rank 6 — minimum non-live family count that annotates a push with the
 * calm-ward-bias caveat. One dead feed is routine noise; ≥2 means the band lost
 * material breadth and should be read with caution.
 */
const DEGRADE_ANNOTATE_MIN = 2;

/**
 * Transition-only degrade dedupe (audit-extras 1.2): the events from THIS run that were
 * NOT already present (exact scope+reason match) in the previous run's persisted
 * `degraded` trace. A feed that stays dead re-records the same event every run — the
 * persisted audit trace keeps the full per-run list, but the push annotation should fire
 * only on NEW information (a changed reason is new information and re-fires). A null
 * `previous` (first run / no prior trace) treats everything as new. Every event but `effect: "trace"` counts —
 * fail open: an un-normalized event (a legacy `run_inputs.degradeEvents` on rederive) has no `effect`.
 */
export function newDegradeEvents(current: DegradeEvent[], previous: DegradeEvent[] | null): DegradeEvent[] {
  const notify = current.filter((c) => c.effect !== "trace");
  if (previous == null) return notify;
  // Only a prior NOTIFY event was eligible to push; a trace one (a post-drain late event included) never dedupes.
  const prior = previous.filter((p) => p.effect !== "trace");
  return notify.filter((c) => !prior.some((p) => p.scope === c.scope && p.reason === c.reason));
}

/**
 * Scope of the `trace` marker a run records for EACH prior late-notify event its push logic saw on `last`, surfaced
 * or suppressed (`reason` = `lateNotifyKey` of that event). `trace` arms nothing: `newDegradeEvents` drops it on both
 * sides, and it carries no `late`, so `priorLateNotifyEvents` never reads it as an event of its own.
 */
export const LATE_NOTIFY_SEEN_SCOPE = "[seed-tail] late-notify seen";
/**
 * The seed-tail TASK a late reason names, parsed off the formats `runSeedTail` writes (run-cycle-seed-tail.ts):
 * `[tail.<name>] <ids> …` (rejected AND deadline-skipped) → that tag + id list; `[input-series] <id> seed non-live …` →
 * that tag + id; the roster-wide `[input-series] seed non-live this run (probe failed): …` → that fixed prefix.
 */
const SEED_TAIL_TASK = /^(\[tail\.[^\]\s]+\] \S+) |^(\[input-series\] \S+) seed non-live |^(\[input-series\] seed non-live this run \(probe failed\))/;
/**
 * A late event's dedupe key: scope + the task identity, never the full reason — the text embeds variable error detail
 * (a 429's retry-after, a request id) and one task alternates between "task rejected: <err>" and "skipped - unsettled
 * at the run hard deadline", so a full-text key re-pushes a chronic failure nightly. A reason no pattern matches keys
 * on its full text (fail open: an unknown format may re-surface, never merges two different tasks).
 */
const lateNotifyKey = (e: DegradeEvent): string => {
  const m = SEED_TAIL_TASK.exec(e.reason);
  return `${e.scope}: ${m ? (m[1] ?? m[2] ?? m[3]) : e.reason}`;
};

/**
 * The previous run's post-drain events that were recorded `notify` (`late: "notify"`, `drainLateDegrades`) — they
 * ran after that run's push decision (the seed tail is the only post-drain notify recorder), so THIS push is the
 * first one able to carry them. Transition-only, like `newDegradeEvents`: `surface` drops an event `previous` also
 * marks seen (`LATE_NOTIFY_SEEN_SCOPE` — the run before already surfaced or suppressed it, so a seed failing every
 * night pushes once), and `seen` is this run's marker for every event read, which keeps the chain alive while the
 * failure persists. Keyed per task (`lateNotifyKey`), so a chronic failure whose error text changes nightly still
 * pushes once, while a different task failing surfaces on its own. A night without the late event drops the chain, so
 * a later recurrence surfaces again. Fail open on `lastPushFailed` (the previous row's `pushError`): that night's send
 * never reached the owner, so ALL its markers are dropped — not only the ones for lines it surfaced — and every late
 * event on `previous` surfaces again, a chronic one that night had suppressed included (it surfaces once more;
 * intended — a duplicate beats a lost line). Never fed to `newDegradeEvents` (stored `trace`, they dedupe nothing).
 */
function priorLateNotifyEvents(previous: DegradeEvent[] | null, lastPushFailed = false): { surface: DegradeEvent[]; seen: DegradeEvent[] } {
  const prior = previous ?? [];
  const marked = new Set(
    lastPushFailed ? [] : prior.filter((p) => p.scope === LATE_NOTIFY_SEEN_SCOPE && p.effect === "trace").map((p) => p.reason),
  );
  const late = prior.filter((p) => p.late === "notify");
  return {
    surface: late.filter((e) => !marked.has(lateNotifyKey(e))),
    seen: late.map((e) => ({ scope: LATE_NOTIFY_SEEN_SCOPE, reason: lateNotifyKey(e), effect: "trace" })),
  };
}

/**
 * Is this run's non-live family set NEW information vs. the previous run's persisted set?
 *
 * The calm-ward caveat FIRES on the non-live family count, so it must be GATED on the same
 * signal. It previously gated on the degrade LOG, an independent source: a family can go
 * non-live with no degrade event at all (its indicators are simply missing from `readings` —
 * the short-history `scoreIndicator` path), or its degrade can land AFTER the log snapshot
 * `assembleRun` reads. In those cases the caveat went silent on the FIRST occurrence, which is
 * exactly the alert the owner needs. Comparing the SETS keeps §1.2's dedupe (a chronically
 * non-live family stops re-inflating every push) while restoring first-occurrence firing.
 *
 * Fail open (a missed alert is worse than a duplicate): a null `previous` — a pre-migration
 * row, a first run, or any run that never persisted the set — is NEWS.
 */
export function nonLiveSetChanged(current: string[], previous: string[] | null): boolean {
  if (previous == null) return true;
  if (current.length !== previous.length) return true;
  const prev = new Set(previous);
  return current.some((k) => !prev.has(k));
}

/**
 * Direction-aware auto-hold note. `override` (held ≠ dialSleeve) fires in BOTH directions, so the
 * rendered copy names which way the held sleeve sits relative to the dial's ceiling rung. Higher
 * LADDER rung = more defensive. Unknown sleeve (`rungOfSleeve` → null) falls back to a neutral note that
 * makes no directional claim. Equality can't occur here (override implies held ≠ dialSleeve).
 */
function renderHoldNote(held: string, dialSleeve: string): string {
  const heldRung = rungOfSleeve(held);
  const dialRung = rungOfSleeve(dialSleeve);
  // Rungs read off the KEYS above; only the printed names go through the label map.
  const pair = `\nheld ${sleeveLabel(held)} · dial sleeve ${sleeveLabel(dialSleeve)}`;
  if (heldRung === null || dialRung === null) {
    return `${pair} (differ)`;
  }
  return heldRung < dialRung
    ? `${pair} - per-leg read held calmer within the band ceiling`
    : `${pair} - holding more defensively above the dial ceiling (de-risk lag)`;
}

/**
 * D3 Stage 2.3 — the driver-line axis suffix: ` — via velocity` / ` — via level`, e.g.
 * `F1 RED — via velocity`.
 *
 * E-a discipline: mechanical and calm. It names WHICH axis attributed the state and adds no
 * severity language, no adjective, no exclamation — the tier already carries the severity,
 * and this suffix must never read as an extra escalation (Stage 2 does not move the band).
 *
 * Emitted ONLY for `DUAL_AXIS_IDS`. R2/R3/R4 are velocity-ONLY, so for them "via velocity"
 * is a tautology carrying zero information — the same structural exclusion `/lab`'s
 * `dualAxisFiringIds` applies. An unattributed reading (`leg` undefined: raw ≠ confirmed, or
 * a hand-built/unscored reading) stays bare, exactly as today.
 */
export function driverAxisNote(r: Reading): string {
  if (!DUAL_AXIS_ID_SET.has(r.indicator.id) || r.leg === undefined) return "";
  return isVelocityLeg(r.leg) ? " - via velocity" : " - via level";
}

const LEVEL_TAGS: Record<AlertLevel, string> = {
  OK: "green_circle",
  WATCH: "yellow_circle",
  WARNING: "orange_circle",
  CRITICAL: "rotating_light",
};

/**
 * ntfy delivery priority per tier (v4 §6.5): WATCH near-silent, CRITICAL
 * bypasses Do-Not-Disturb. OK is mapped for completeness but never pushes
 * (an upward change *to* OK is impossible).
 */
const LEVEL_PRIORITY: Record<AlertLevel, number> = {
  OK: 2,
  WATCH: 2,
  WARNING: 4,
  CRITICAL: 5,
};

/**
 * E-a — graduated, mechanical, calm notification guidance per tier. Each line states
 * one incremental step along the risk curve — never a binary "go to cash" or
 * "world ending" call, and de-escalation is implied to be as unemotional as
 * escalation. OK is blank (it never pushes). Surfaced in the notify body only.
 */
const GUIDANCE: Record<AlertLevel, string> = {
  OK: "",
  WATCH: "Guidance: risk is elevating one notch - monitor; no action required yet.",
  WARNING: "Guidance: shift one step down the risk curve - a graduated trim.",
  CRITICAL: "Guidance: continue de-risking one step at a time - steady and mechanical.",
};

/**
 * Per-track push-log label (`Pushed <label> alert …`) keyed by the track's alert
 * band field — the one per-tier string the generic push loop can't read off the
 * notification (the title carries "crash-dash bubble", not the bare "bubble"). Keeps
 * the transcript byte-identical to the old hand-written per-tier blocks.
 */
export const PUSH_LABEL: Record<BandField, string> = {
  slowBand: "bubble",
  bottomState: "bottom",
};

// Most indicator levels/deltas sit in the ~0.1–100 range where 2 decimals read
// well. Tiny ratios — CG's HG÷GC ≈ 0.0019 — collapse to a false "0.00" at 2dp, so
// widen to ~3 significant figures ONLY when 2dp would lose all signal (|v| < 0.005).
// Every other reading keeps its familiar 2-decimal render.
export function formatMagnitude(value: number): string {
  if (value !== 0 && Math.abs(value) < 0.005) {
    return value.toFixed(2 - Math.floor(Math.log10(Math.abs(value))));
  }
  return value.toFixed(2);
}

export function formatDelta(delta: number, unit: string): string {
  return `${delta >= 0 ? "+" : ""}${formatMagnitude(delta)}${unit}`;
}

/** `delta20` as pushed: a `velocityMode: "relative"` id's fraction renders as a signed percentage (`+6.8%`). */
export function formatVelocityDelta(delta: number, unit: string, mode: "relative" | undefined): string {
  return mode === "relative" ? `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}%` : formatDelta(delta, unit);
}

function formatReading(r: Reading): string {
  const unit = r.indicator.unit ?? "%";
  // NO `[raw X]` suffix. It marked a reading whose raw state had breached but not yet cleared the
  // per-indicator confirm buffer — impossible under the directional fold (2026-08-26): a worse
  // raw state confirms same-day, so raw can only diverge DOWNWARD (raw improved, state still
  // held worse during the 2-close stand-down), which is not what the suffix claimed.
  // delta20 spans `velocityWindow ?? VELOCITY_WINDOW(20)` observations, in the feed's own
  // cadence unit: N days for a daily feed, N months for a monthly one (EBP), N quarters for
  // a quarterly one (no live carrier since F12's 2026-07-17 retirement — the branch stays
  // for the next sparse feed). Both halves are read off the indicator so the label can never
  // claim a 20-quarter move is "20d", NOR a 30-day move (any id carrying its own
  // `velocityWindow`, EW-4/D-A) "20d" — the column is named `delta20`, but the number under it
  // is not always a 20-span.
  // ⚠ The unit word comes off the OBSERVATION grid (`obsCadence ?? cadence`), never `cadence`
  // alone: `cadence` is the RELEASE schedule, and G1 releases weekly over business-day
  // `DCOILWTICO` rows — which is exactly why it declares `obsCadence: "daily"` and
  // resolves to "d". Two DISTINCT cases, and the grid is what separates them:
  //   - released weekly, OBSERVED daily (G1, BRENT) → `obsCadence: "daily"` on the entry.
  //   - genuinely OBSERVED weekly (F3, `NFCIRISK`, `velocityWindow: 4`) → the `"weekly"` arm
  //     below. Declaring a grid cannot fix this one: its grid IS weekly, so the honest
  //     declaration lands on the same branch the arm serves. Before the arm existed, F3 pushed
  //     "4d Δ" for a 4-WEEK change — a 7× understatement on the notify path (I5, 2026-08-08).
  // F3 is the ONLY id the `"weekly"` arm moves: it is the sole indicator whose resolved
  // `obsCadence ?? cadence` is `"weekly"` (enumerated over all 58 `ALL_INDICATORS` entries,
  // 2026-08-08 — grid census: 49 declare no cadence at all and reach `"d"` via this map's default,
  // 6 resolve `"daily"`, 2 `"monthly"` (EBP/F7), 1 `"weekly"` (F3)). So the arm's blast radius is
  // exactly one id, and the default still carries the large majority.
  const span = r.indicator.velocityWindow ?? VELOCITY_WINDOW;
  const obsGrid = r.indicator.obsCadence ?? r.indicator.cadence;
  const spanUnit =
    obsGrid === "quarterly" ? "q" : obsGrid === "monthly" ? "mo" : obsGrid === "weekly" ? "w" : "d";
  const deltaSpan = `${span}${spanUnit} Δ`;
  // Step 3 (official short names): no id prefix in primary visible text — the label IS the
  // identifier now. Ids survive in tooltips/aria/data-attrs and in the API/DB `id` fields.
  return `${r.indicator.label}: ${formatMagnitude(r.level)}${unit} (${r.state}) · ${deltaSpan} ${formatVelocityDelta(r.delta20, unit, r.indicator.velocityMode)}`;
}

/**
 * The per-reading lines + the dial/families/level summary, shared by the console
 * transcript and the notification body so the two can't drift (P9 — was
 * duplicated between runScoringCycle and buildNotification).
 *
 * O2 step 4 (2026-07-15): repointed from the retired channel verdict
 * (FIN/RATE/GEO/VIX scores) to the operative gauge — the T1 dial's regime + rung
 * plus the 7-family danger breadth ("K/N firing (keys…)"). Step 5 — degraded-run
 * fallback: a dial-less run (pure-logic tests / dial computation failed) still
 * emits a usable summary: an explicit "degraded run (no dial)" head, whatever
 * family breadth is available, and the fallback alert band.
 */
export function formatRunSummary(
  readings: Reading[],
  band: AlertLevel,
  dial?: T1DialResult,
  families?: FamilyPanel[],
): { lines: string[]; summary: string } {
  const lines = readings.map(formatReading);
  const live = (families ?? []).filter((f) => f.live);
  const firing = live.filter((f) => f.firing);
  const firingList = firing.length ? ` (${firing.map((f) => f.key).join(", ")})` : "";
  // D5 — when NOTHING fires, name reds that cannot arm so the push never silently hides the board's
  // only red; byte-identical to today whenever something fires or no cannotArm mark is set.
  const cannotArm = firing.length === 0 ? (families ?? []).filter((f) => f.cannotArm) : [];
  const armNote = cannotArm.length
    ? ` (${cannotArm.map((f) => `${f.key}: ${f.cannotArm!.worstCount} ${f.cannotArm!.worst.toLowerCase()}`).join(", ")}, cannot arm)`
    : "";
  const familyNote = live.length ? ` · families ${firing.length}/${live.length} firing${firingList}${armNote}` : armNote;
  const head = dial ? `Dial ${dial.regime} r${dial.targetRung}` : "degraded run (no dial)";
  const summary = `${head}${familyNote} → ${band}`;
  return { lines, summary };
}

/**
 * IS-7 §17.3 — the member-level diffusion lines that sit UNDER the summary's family breadth.
 * Scoped to the families the summary already names as firing: an all-live render would put 7
 * extra lines on a lock screen, and a worst-family-only render would hide a second family
 * deteriorating in parallel. **Zero firing families ⇒ zero lines**, so a calm push is
 * byte-identical to the pre-IS-7 body (pinned in `notify_format.test.ts`).
 *
 * ⚠ This is DERIVED from the panel, NOT a hand-picked subset like `NOTIFY_ANCHOR_IDS` below:
 * widening a family widens its denominator here on purpose, and the ≤3 cap that governs the
 * anchor block does NOT apply — the line count is bounded by the outer `K/N firing` count the
 * reader has already been shown.
 *
 * The count itself comes from `diffusionLabel` (families.ts), the single formatter of record,
 * so the push and `/lab` cannot disagree. Wording duty (§17.0): the OUTER count is "firing",
 * the inner one is "red"/"elevated" — the two are never both called firing unqualified.
 * Keys are padded to a common width so the state column lines up in a monospace client.
 */
export function diffusionLines(families?: FamilyPanel[]): string[] {
  const firing = (families ?? []).filter((f) => f.live && f.firing);
  if (firing.length === 0) return [];
  const width = Math.max(...firing.map((f) => f.key.length));
  return firing.map((f) => `  ${f.key.padEnd(width)} ${f.state}, ${diffusionLabel(f)}`);
}

/**
 * Indicators rendered on the push even when GREEN (2026-07-24 compaction).
 *
 * WHY these three: F1 and R1 are the headline members of the two BAND-SELECTING families
 * (credit · rates — `families.ts` GLOBAL_FAMILIES), and R5 is the everyday volatility gauge.
 * Their job is to give every push a LEVEL sense — the dial rung says how dangerous, these say
 * what the danger is priced at — so a calm-but-drifting reading is visible without opening /lab.
 *
 * ⚠ This is a hand-picked subset, NOT a mirror of any family table (testing-project.md's hand-typed-list
 * rule): widening a family must NOT auto-add an anchor. Keep it ≤3 — every entry is a line on a
 * phone notification, and the block's whole point is that GREEN rows cost nothing.
 */
export const NOTIFY_ANCHOR_IDS = ["F1", "R1", "R5"] as const;

/**
 * The push body's reading block — the non-GREEN readings, the still-GREEN anchors, and a count
 * of everything omitted (2026-07-24).
 *
 * WHY: the block used to render ALL ~50 readings, of which ~47 are GREEN on a typical push and
 * carry no news, while a separate `Drivers:` line re-stated the non-GREEN set by id — the same
 * information twice, buried under 47 lines that never change. The drivers ARE this block now
 * (they keep `driverAxisNote`, which the reading line otherwise lacks), so nothing is lost and
 * ~45 lines go. The FULL list still exists on the console transcript (`formatRunSummary.lines`,
 * read by `run-core.ts`) and in the API/`/lab` — the push is a heads-up, not the record.
 *
 * The ids drop out of the body with the `Drivers:` line (labels only now), matching the Step-3
 * short-name direction: the label IS the identifier in primary visible text.
 */
export function compactBodyBlock(
  readings: Reading[],
  lineSuffix: (r: Reading) => string = () => "",
  // R12 (oil-nowcast): ids that surface in the driver block even when GREEN — a GREEN carried-oil id
  // whose same-day estimate cleared its cut, so its `est.` clause has a line to ride. Default: none.
  forceSurface: ReadonlySet<string> = new Set(),
): string[] {
  if (readings.length === 0) return [];
  const drivers = readings.filter((r) => r.state !== "GREEN" || forceSurface.has(r.indicator.id));
  const driverIds = new Set(drivers.map((r) => r.indicator.id));
  // A non-GREEN anchor is already in `drivers` — render it once, in the drivers block, where it
  // also carries its axis note. So anchors here are only the ones still GREEN.
  const anchors = NOTIFY_ANCHOR_IDS.map((id) => readings.find((r) => r.indicator.id === id)).filter(
    (r): r is Reading => r !== undefined && !driverIds.has(r.indicator.id),
  );
  const omitted = readings.length - drivers.length - anchors.length;
  return [
    ...drivers.map((r) => `${formatReading(r)}${driverAxisNote(r)}${lineSuffix(r)}`),
    ...(anchors.length > 0 ? ["── anchors ──", ...anchors.map((r) => `${formatReading(r)}${lineSuffix(r)}`)] : []),
    // An all-GREEN push is real (de-escalation lag, hold change, weekly re-assert), and reads
    // better as "all N GREEN" than "N others GREEN" beside a block of green anchors.
    ...(drivers.length === 0
      ? [`all ${readings.length} GREEN`]
      : omitted > 0
        ? [`${omitted} others GREEN`]
        : []),
  ];
}

/**
 * Build the notify-on-change decision + payload (v4 §6.5, Slice 3). Pure: no IO.
 * The operative gauge is now the T1 dial `band` (max of the de-escalation-lagged dial
 * regime and the hard-escalator floor), NOT the channel verdict — pushes only on an
 * upward `band` change vs. `last` (decideNotify). The body carries the "what changed":
 * the band transition, the non-Green driver indicators, the dial regime + rung, and the
 * R4 cash-breaker phase when armed. `families` (the GLOBAL_FAMILIES panel) feeds the
 * summary line's family breadth (O2 step 4 — the verdict param is retired). The
 * transition (and thus the Title header) is ASCII-only; the rich `→` appears
 * only in the body. The retired legacy-verdict held/modifier notes are dropped (they
 * described the deleted channel de-escalation gate, not the dial lag).
 */
export function buildNotification(
  last: AlertRecord | null,
  band: AlertLevel,
  dial: T1DialResult | undefined,
  families: FamilyPanel[] | undefined,
  allReadings: Reading[],
  asOf: string,
  opts: {
    freshness?: Freshness;
    reassertDue?: boolean;
    /**
     * The whole `R4Result`, not just its phase (W5-b Stage 4.2). The push renders TWO cash
     * voices — the `R4:` line and the overlay line — and the second now delegates precedence to
     * `resolveCash` (cash-overlay.ts §3), which takes an `R4Result`. Passing the object rather
     * than re-deriving `phase === "cash" || "reentry"` here is the consolidation: one total,
     * one caller shape, nothing to drift.
     */
    r4?: R4Result;
    /**
     * Auto-hold state (Slice 3, i7a) — the SINGLE GLOBAL hold trigger, independent of the
     * per-track own-tier band notifications. `held` = the danger field's calmest-in-band
     * sleeve; `dialSleeve` = the dial's LADDER[targetRung−1] (the ceiling band top); `override` =
     * the held sleeve differs from the dial sleeve in EITHER direction (held ≠ dialSleeve) — calmer/
     * below the ceiling on a re-risk hold, or more defensive/above it on a de-risk lag; the rendered
     * note names the direction. The dial sets a CEILING band and the read chooses the sleeve, so this
     * is NOT a veto and there is no default sleeve overridden; `prevHeld` = the sleeve on the ABSOLUTE latest persisted alert
     * row (the notify baseline `last`, same as decideNotify — never the prior fired-DAY row, which
     * is scoring state); `changed` = held !== prevHeld (bidirectional dedup — a lateral EM→Value
     * change with no band move still fires; a same-day re-run at the same hold stays silent).
     * Absent on a dial-less/degraded run (no auto-hold that run).
     */
    hold?: { held: string; dialSleeve: string; override: boolean; prevHeld: string | null; changed: boolean };
    /**
     * This run's collected degrade events so far (audit-extras 1.2). A SECONDARY, additive
     * re-fire reason for the calm-ward caveat: a degrade event that is new vs the previous
     * run's persisted `degraded` trace re-fires the caveat even when the non-live family set
     * is unchanged. The PRIMARY gate is the non-live family set itself (`nonLiveSetChanged`) —
     * this option can only add news, never suppress it, so absence changes nothing.
     */
    degradeEvents?: DegradeEvent[];
    /**
     * W5-a Stage 4.1 (UD-3 = (b) FOLDED LINE) — the Tier-1 cash overlay's OWN state, rendered as
     * ONE appended body line on the pushes that already fire. Deliberately NOT a new push, tier,
     * priority or dedup key: W3-d ruled this same week that the notify path is already too loud, so
     * the overlay speaks only when the band (or the hold) already spoke. `'full'` is unreachable
     * here by construction — that magnitude is R4's terminal cash, carried by the `r4` option.
     */
    cashOverlay?: { level: Exclude<CashLevel, "full">; reason: string };
    /**
     * The K5 posture's equity weight, which `resolveCash` turns into the standing non-equity
     * scalar (DEC-15). Absent/null ⇒ the degraded render ("not yet sized"), never a fabricated
     * number. Stage 4.2 added the seam and the render; Stage 5.1 hoisted the run loop's exposure fetch
     * above the notify site, so the cron path NOW supplies this on every healthy run — the `null`
     * branch is the degraded-exposure path, no longer the standing case.
     */
    equityPct?: number | null;
    /**
     * W4-e FLAG slice — the per-leg lag guard (`verdictHoldLegs`, alert-band.ts). Each entry is
     * an indicator whose freshest observation exceeds its RESOLVED lag cut
     * (`ind.lagAfterDays ?? LAG_THRESHOLDS[ind.cadence ?? "daily"]`, via `lagCutFor` in
     * ladder.ts — a per-indicator override where registered, else the cadence tier), so a
     * benign frozen reading is not silently trusted. Rendered as ONE body line next to `lagNote`;
     * band is UNCHANGED (FLAG-only). Absent/empty ⇒ no line (the common, all-fresh case).
     */
    verdictHoldLegs?: VerdictHoldLeg[];
    /** S5 (oil-nowcast): this run's same-day BRENT/G1 spot estimates — a divergence past that id's OWN
     *  `cutPct` (R6) appends one clause to that id's line, and SURFACES the line if it is GREEN (R12).
     *  Missing input ⇒ null ⇒ no clause. Display-only: never a band/scoring input (R3). Any other id is a
     *  notify-dial estimate head: it gets a clause only where `families` scored it at a state its print is not. */
    oilEst?: Partial<Record<string, OilNowcast | null>>;
    /** GLOBAL-channel prints — rendered ONLY as the line a head-moved member's `est.` clause rides. */
    globalReadings?: Reading[];
  } = {},
): { push: boolean; message: NtfyMessage; lateSeen: DegradeEvent[] } {
  // CHART-ONLY ids (`CHART_ONLY_IDS`, registry.ts) are persisted and charted but must NEVER reach
  // notify ("persist + chart, stay OFF
  // notify"). B.1 put VTP into `readings[]`, and the three structural reasons that keep it off the
  // BAND (CONTEXT channel, no dial family, provisional path behaviorally inert) say nothing about the BODY:
  // `compactBodyBlock` renders EVERY non-GREEN reading it is handed, so a RED VTP printed a driver
  // line in the push ("VIX backwardation: 20.00 (RED) · 20d Δ +0.00", measured 2026-07-31 before
  // this filter). Filtered HERE, the single payload builder both push sites (run-core.ts,
  // run-cycle-push.ts) go through, so a new chart-only id inherits the exclusion. The console
  // transcript (`formatRunSummary` in run-core.ts) gets the unfiltered list — the push is a
  // heads-up, not the record.
  // …and since 2026-08-11 the same fate covers CARD-LESS CONTEXT ids (`CARDLESS_CONTEXT_IDS`
  // above): BAA10Y lost its card 2026-08-06 but kept scoring, so a RED it could never show on
  // the board still printed a "Baa−10y RED" driver line in the prod push (measured 2026-08-11;
  // the indicator itself retired outright 2026-08-11).
  const readings = allReadings.filter((r) => !notifyBodyExcluded(r.indicator.id));
  const { push: upwardPush, transition } = decideNotify(last?.level ?? null, band);
  // Push on an upward change OR a weekly re-assert of a still-elevated level
  // (Phase 3). A re-assert has no transition (level didn't move), so the header
  // reads "still <level>" instead.
  const reassert = opts.reassertDue ?? false;
  const hold = opts.hold;
  // Auto-hold push (i7a) — an INDEPENDENT, bidirectional trigger OR'd into the band-transition
  // push: a run pushes for a band change, a held-sleeve change, or both. A held-only push
  // (band unchanged — the hold IS the reason) still fires and renders a legible "hold changed".
  const holdChangedOnly = !!hold?.changed && !upwardPush && !reassert;
  // `priorLateNotifyEvents`: the last run's seed-tail `notify` degrades ran after its push,
  // so they trigger THIS one — a no-push day would otherwise drop them for good (the next row no longer carries them).
  // Only the ones `last` did not already mark seen; `lateSeen` is the marker the IO shell records on THIS run's row.
  const { surface: priorLate, seen: lateSeen } = priorLateNotifyEvents(last?.degraded ?? null, last?.pushError != null);
  const push = upwardPush || reassert || !!hold?.changed || priorLate.length > 0;

  // `lines` (the FULL per-reading list) is deliberately NOT read here — the console transcript
  // (`run-core.ts`) keeps it as the run receipt; the push carries `bodyBlock` below instead.
  const { summary } = formatRunSummary(readings, band, dial, families);
  // IS-7 §17.3 — the inner, member-level diffusion count, one line per FIRING family, directly
  // under the summary's outer `K/N firing` breadth. Empty (and so byte-neutral) when nothing fires.
  const diffusion = diffusionLines(families);
  const diffusionNote = diffusion.length ? `\n${diffusion.join("\n")}` : "";
  // S5 (oil-nowcast): each carried id's estimate vs ITS print, past its OWN cutPct (R6). Percent delta,
  // suffixed `%` on the clause; BRENT alone carries the glued `↓bias` under-shoot token (R7/R13).
  const oilDivFor = (id: "BRENT" | "G1"): { est: OilNowcast; deltaPct: number } | null => {
    const r = readings.find((x) => x.indicator.id === id);
    return r ? oilEstDivergence(r.level, opts.oilEst?.[id] ?? null, estimatorOf(id, "carry-log").cutPct) : null;
  };
  const oilDiv: Record<"BRENT" | "G1", ReturnType<typeof oilDivFor>> = { BRENT: oilDivFor("BRENT"), G1: oilDivFor("G1") };
  // A folded head whose own state is not its print's — the band may have moved off it, so it names itself (oil's clause wins BRENT/G1).
  const globals = (opts.globalReadings ?? []).filter((r) => !notifyBodyExcluded(r.indicator.id));
  const headMoved = new Map(
    [...readings, ...globals].flatMap((r) => {
      const id = r.indicator.id;
      const est = (id === "BRENT" || id === "G1") && oilDiv[id] !== null ? null : opts.oilEst?.[id];
      return est?.state !== undefined && est.state !== r.state ? [[id, { value: est.value, state: est.state }] as const] : [];
    }),
  );
  const estClauseFor = (r: Reading): string => {
    if (r.indicator.id === "BRENT" || r.indicator.id === "G1") {
      const div = oilDiv[r.indicator.id];
      if (div !== null) {
        const unit = r.indicator.unit ?? "%"; // BRENT/G1 carry unit "" — the value renders as the id's own line does
        const bias = r.indicator.id === "BRENT" ? "↓bias" : ""; // R13: glued to the value, BRENT only
        return ` · est. ${formatMagnitude(div.est.value)}${unit}${bias} today (${formatDelta(div.deltaPct, "%")}, ${estimatorOf(r.indicator.id, "carry-log").leads[0]})`;
      }
    }
    const head = headMoved.get(r.indicator.id);
    return head ? ` · est. ${formatMagnitude(head.value)}${r.indicator.unit ?? "%"} (${head.state})` : "";
  };
  // R12: a GREEN BRENT/G1 whose estimate cleared its cut must SURFACE its line to carry the clause; a
  // non-GREEN one is already a driver, so the force-set is harmless there. A head-moved id surfaces the same way.
  const surfaceIds = new Set([...(["BRENT", "G1"] as const).filter((id) => oilDiv[id] !== null), ...headMoved.keys()]);
  const bodyBlock = compactBodyBlock([...readings, ...globals.filter((r) => headMoved.has(r.indicator.id))], estClauseFor, surfaceIds);
  // Slice 3 — the dial is the operative gauge: name its regime + integer rung so a
  // band held by the de-escalation lag or an escalator floor self-explains (replaces
  // the retired held/modifier notes). Absent on a dial-less pure-logic/degraded run.
  const dialNote = dial ? `\nDial: ${dial.regime} (rung ${dial.targetRung}/9)` : "";
  // R4 cash-breaker phase — surfaced whenever the breaker has left its resting
  // "equity" phase (decision #5: the phase is the load-bearing message; the band-move
  // is secondary belt-and-suspenders).
  const r4Note = opts.r4 && opts.r4.phase !== "equity" ? `\nR4: ${opts.r4.phase}` : "";
  // W5-a Stage 4.1 — the cash overlay's folded line. Mirrors `resolveCash` (cash-overlay.ts §3) so
  // the push can never carry two contradictory cash claims: R4's `cash` is TOTAL and subsumes any
  // early partial, and R4 `reentry` is already walking back onto the ladder (the whipsaw D8
  // forbids), so in both phases the overlay stays silent and `r4Note` is the single cash voice.
  // Copy matches the `/lab` chip verbatim (`public/cash-overlay-view.js`). W5-b Stage 4.2: the
  // precedence total is NO LONGER re-derived here — `resolveCash` IS the total, and this is its
  // production caller. The notify-only FRAMING outlives 4.1's sizing: the line carries a number
  // but must still read as a heads-up, never as a position instruction.
  //
  // ⚠ `nonEquityPct === 0` (the `Full` posture) is FALSY and is a REAL, renderable size. The
  // branch below is `=== null` for exactly that reason; a truthiness test would render the
  // fully-invested posture identically to a degraded one. `public/cash-overlay-view.js` mirrors
  // this and `public/cash-precedence-parity.test.js` pins the pair, `Full` fixture included.
  //
  // ⚠ DELIBERATELY-DEAD FIELDS (verified 2026-07-20): `since`, `nonEquityPct` and
  // `recentTargetRungs` are fabricated below purely to satisfy `CashOverlayResult` structurally —
  // `resolveCash` reads NONE of them on ANY path (it reads only `overlay.level`/`overlay.reason`
  // and the `R4Result`). HAZARD: the fabrication cannot fail typecheck (the spread satisfies the
  // shape), so if `resolveCash` ever starts reading one of the three, this mirror silently
  // diverges from `run-core.ts`'s real overlay object — and the parity test will NOT catch it, because
  // its helper fabricates the same narrow shape. Anyone widening `resolveCash`'s reads must
  // thread the real values in here (and into the parity helper) in the same change.
  const cashClaim = opts.cashOverlay
    ? resolveCash(
        opts.r4 ?? R4_RESTING,
        { ...opts.cashOverlay, since: null, nonEquityPct: null, recentTargetRungs: [] },
        opts.equityPct ?? null,
      )
    : null;
  // E10b (2026-07-26): mirrors `public/cash-overlay-view.js` exactly — three states, not two.
  // `nonEquityPct === 0` is a REAL sizing (the `Full` posture), but a lone `0%` reads as an
  // unfilled field on the push as much as on screen, so zero gets its own words. Change one of
  // these two branches and you must change the other; `public/cash-precedence-parity.test.js`
  // pins the pair.
  const cashSize =
    cashClaim === null || cashClaim.nonEquityPct === null
      ? "not yet sized"
      : cashClaim.nonEquityPct === 0
        ? "fully invested - 0% cash"
        : `${cashClaim.nonEquityPct}% cash`;
  const cashOverlayNote =
    cashClaim?.level === "partial"
      ? `\nCash overlay: partial - heads-up only, ${cashSize} (${cashClaim.reason})`
      : // B-22 — surface a v-shape-suppressed overlay instead of silently swallowing it (W5-d holds an
        // early overlay when the fall reads v-shaped; `V_BEAR_INFLUENCE_ENABLED` is live). ONE calm line,
        // no size (a hold has no position). r4-reentry suppression is NOT surfaced here — `r4Note` is
        // already its voice on the push; only the v-shape hold is otherwise invisible.
        cashClaim?.suppressedBy === "v-shape"
        ? `\nCash overlay: suppressed - v-shaped fall; early de-risking deferred`
        : "";
  // E-a — graduated, mechanical, calm copy: state the incremental step along the
  // risk curve, never a binary to-cash / "world ending" call. De-escalation copy is
  // equally unemotional. One calm line per elevated tier; OK never pushes so no line.
  const guidanceNote = GUIDANCE[band] ? `\n${GUIDANCE[band]}` : "";
  // Heartbeat (Phase 3): when a push fires for some other reason, flag a lagging
  // feed in the body. ASCII-only — the body carries the rich `→` already, but a
  // plain marker keeps the lag line legible across clients.
  const lagNote = opts.freshness?.lag
    ? `\n[!] feed lag: latest data ${opts.freshness.ageDays}d old (FRED not updating?)`
    : "";
  // W4-e FLAG slice — per-leg lag: name each leg whose vintage exceeds its cadence
  // threshold so a benign frozen reading isn't trusted as an improvement. FLAG only, band
  // unchanged. ASCII `[!]` marker matching lagNote. Empty ⇒ no line.
  // CHART-ONLY ids are filtered HERE too, not only out of `allReadings` above: `run-core.ts`
  // computes `verdictHoldLegs` over the UNFILTERED readings array, so a lagging VTP printed its label
  // into the push body through this line ("[!] lagging legs: VIX backwardation (16d)", measured
  // 2026-07-31) even with the driver-line filter in place. Both entry points into the body now
  // route through the same exclusion, which is what makes "the single payload builder" claim true.
  const visibleVerdictHoldLegs = (opts.verdictHoldLegs ?? []).filter((l) => !notifyBodyExcluded(l.id));
  const verdictHoldLegsNote =
    visibleVerdictHoldLegs.length > 0
      ? `\n[!] lagging legs: ${visibleVerdictHoldLegs.map((l) => `${l.label} (${l.ageDays}d)`).join(", ")}`
      : "";
  // Audit rank 6 — degradation annotation: every degrade path lowers danger, so when
  // ≥DEGRADE_ANNOTATE_MIN families are non-live the reported band is systematically biased
  // calm-ward. Flag it on the push so the owner reads the band with that caveat. ASCII `[!]`
  // marker (matching lagNote) for legibility across clients.
  const nonLive = (families ?? []).filter((f) => !f.live);
  // Transition-only (audit-extras 1.2), keyed on the TRIGGER's own signal (fix 2026-07-18):
  // the caveat fires on the non-live family COUNT, so it dedupes on the non-live family SET —
  // a chronically non-live family stops re-inflating every push, but a first occurrence (or any
  // change in WHICH families are dark) always fires, including via paths that record no degrade
  // event. A new degrade event is OR'd in as a second, independent reason to re-fire: both
  // sources only ever ADD news, so the gate can never suppress a first occurrence.
  const degradeIsNews =
    nonLiveSetChanged(
      nonLive.map((f) => f.key),
      last?.nonLiveFamilies ?? null,
    ) ||
    (opts.degradeEvents !== undefined && newDegradeEvents(opts.degradeEvents, last?.degraded ?? null).length > 0);
  // Stage 8.1 audit fix: a run-wide FETCH-BUDGET abort forces the caveat unconditionally —
  // neither the ≥DEGRADE_ANNOTATE_MIN count gate nor the transition-only dedupe applies. Rationale:
  // the count gate encodes "one dead feed is routine noise", which is true of a chronically dark
  // feed but FALSE of a deadline — a timeout can starve exactly one family and still shrink the
  // live denominator under a push (the bidirectional hold trigger fires calm-ward on `hold.changed`
  // alone), producing "hold changed <defensive> → <aggressive>" with nothing saying the cause was
  // the clock. Keyed on the scope constant, so it distinguishes a timeout from a genuinely dark feed.
  const budgetAborted = (opts.degradeEvents ?? []).some((e) => e.scope === BUDGET_ABORT_SCOPE);
  const degradeNote = budgetAborted
    ? `\n[!] run fetch budget exhausted - feeds incomplete (${nonLive.length} families non-live), band may read calm-ward`
    : nonLive.length >= DEGRADE_ANNOTATE_MIN && degradeIsNews
      ? `\n[!] ${nonLive.length} families non-live - band may read calm-ward`
      : "";
  const priorLateNote = priorLate.map((e) => `\n[!] last run's seed tail: ${e.reason}`).join("");
  const reassertLabel = `still ${band} (weekly re-assert)`;
  // Auto-hold (i7a): name the held sleeve on the summary line; ALWAYS annotate when the per-leg
  // read holds calmer than the dial sleeve (held ≠ dialSleeve) — on band-transition pushes too, not
  // only held-only ones (§10). The dial sets a ceiling band; the read chooses the sleeve (no veto,
  // no default sleeve). On a held-only push (band unchanged) the header reads "hold changed X → Y".
  const holdSuffix = hold ? ` · hold ${sleeveLabel(hold.held)}` : "";
  // Direction-aware hold note: compare the held sleeve's LADDER rung to the dial sleeve's.
  // Higher LADDER index = MORE defensive. `override` fires in BOTH directions (held ≠ dialSleeve),
  // so the copy must name which way: calmer/below the ceiling (the common re-risk-hold case) vs
  // more defensive/above the ceiling (the de-risk-lag case, where a re-risk rotation is dwell/streak
  // -blocked and `held` stays at the stickier prevHeld above the dial's target rung).
  const ceilingNote = hold?.override ? renderHoldNote(hold.held, hold.dialSleeve) : "";
  const holdChangedLine = hold ? `hold changed ${hold.prevHeld === null ? "—" : sleeveLabel(hold.prevHeld)} → ${sleeveLabel(hold.held)} (band ${band} unchanged)` : "";
  const transitionLine = holdChangedOnly
    ? holdChangedLine
    : transition ?? (reassert ? reassertLabel : `level ${band} (no change)`);
  // Title is an ASCII HTTP header (no rich →). A held-only push titles the hold change.
  const title = holdChangedOnly
    ? `crash-dash - hold changed ${hold.prevHeld === null ? "—" : sleeveLabel(hold.prevHeld)} -> ${sleeveLabel(hold.held)}`
    : `crash-dash - ${transition ?? (reassert ? `still ${band}` : band)}`;

  return {
    push,
    message: {
      title,
      body: `${transitionLine}${dialNote}${r4Note}${cashOverlayNote}${ceilingNote}${guidanceNote}${lagNote}${verdictHoldLegsNote}${degradeNote}${priorLateNote}\n\n${bodyBlock.join("\n")}\n${summary}${holdSuffix}${diffusionNote}\nas of ${asOf}\n\n${DISCLAIMER_SHORT}`,
      tags: LEVEL_TAGS[band],
      priority: LEVEL_PRIORITY[band],
    },
    lateSeen,
  };
}
