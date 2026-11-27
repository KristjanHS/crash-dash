/**
 * IS-4 ranking probe — READ-ONLY.
 *
 *   npx tsx scripts/probe-bespoke-family-flip.ts --env=prod [--closes=900]
 *
 * ## The question (§13.1)
 * Rank the BESPOKE scorers by how often each one actually CHANGES its family's state. The output
 * feeds IS-3's per-indicator arc order and the still-unruled IS-4 option choice. The probe scores
 * nothing new and writes nothing — it reads the states the store already produced.
 *
 * ## The set (§13.2) — a predicate, never a hand-list
 * Bespoke = **`thresholds` carries no cut** on the `Indicator` config (`src/registry.ts`). Those ids
 * bypass `classify()` and carry a hand-written scorer in `scorers-price.ts` / `scorers-composite.ts`;
 * the registry spells the condition `thresholds: {}` (the field is REQUIRED by the `Indicator`
 * interface, so "absent" is expressed as an empty object — `isBespoke` therefore tests for zero own
 * keys, not for `undefined`).
 *
 * ⚠ **`derived !== undefined` is NOT the predicate.** It selects 11 and was the first wrong guess of
 * the originating session — never swap it in.
 *
 * ⚠ **The count is NOT §13.2's 31** — that numeral is a stale vintage of a registry that keeps growing
 * (the walkthrough was written before the four PENSION comparator legs landed, 2026-08-02), so the LIVE
 * registry is the only authority. Two checks a reader can re-run against it, both re-measured 2026-11-21 at
 * 85 `ALL_INDICATORS` rows:
 *   (a) **the complement balances** — 22 rows carry a cut and 63 carry none;
 *       22 + 63 = 85 = `ALL_INDICATORS.length`. Either half alone would go unnoticed; the sum is what
 *       makes a miscount visible.
 *   (b) **the enumeration adds up to the same 63** — trend/price F4 NVDA F5 SPCONC F6 F8 F13 DB_SMH DB_XLK
 *       RS_SMH RS_XLK KBE_RS INS_RS EXSH_GATE AT1 MU_RS JPT = 17, + G1 BRENT NG R7 CG VT EURC ESTR EPATH
 *       EURGBP BUND FXH GT GB DISP CQS F7 ECY = 18, + price-accel and the 3 complacency rows = 4,
 *       + the 22 PENSION legs (SPY DEXUSEU SP500IT, the 10 `LEGP_*`, VWO VGK XDEV, KBE HYNIX
 *       AMAT KRW COPPER, + one since-retired spot input) = 22, + VIX VIX3M = 2.
 * Both are date-stamped statements about a moving table, NOT invariants: re-derive, never patch a numeral.
 * `BESPOKE_COUNT` below is the live-registry assert §13.2 asks for; it reds on any registry change, which
 * is its whole job — the count moves whenever a scorer-less row is added, and the fix is to re-derive it
 * from the predicate, never to widen the assert to a range.
 *
 * ## The metric (§13.3) — leave-one-out, TWO columns, not a raw fire count
 * "Flips the family state" is a COUNTERFACTUAL. Under worst-member-wins a member that fires alongside
 * a hotter sibling changes nothing, so a raw fire count would over-credit followers. For each stored
 * day and each bespoke member: the family's state with the FULL member set, then again with that one
 * member removed; the roll-up is production's own `computeFamilyPanel` (worst-of over `STATE_RANK`)
 * rather than a reimplementation — this probe makes no A/B claim, so there is no control arm to keep
 * frozen; the counterfactual IS the comparison.
 *
 * ⚠ **A bare `without !== full` conflates TWO different facts** (review finding, 2026-07-28). When the
 * id is the ONLY family member with a stored reading that day, `computeFamilyPanel` returns
 * `state: null, live: false` for the "without" panel, and `null !== "GREEN"` scored as a flip — so a
 * COVERAGE GAP in the id's siblings read as maximal sensitivity. Measured on prod at `--closes=900`,
 * G1's entire 632 was that artefact (geopolitics = G1/OVX/BRENT, and OVX+BRENT store 273 days against
 * G1's 900); F13 fell 119 → 6. The two facts are therefore reported in TWO columns:
 *  - `flips` — a genuine worst-of CHANGE among CO-PRESENT members (gated on `without.live`). This is
 *    the ranked column, and the one `assertNonVacuous` is pinned against.
 *  - `unpop` — days on which pulling the id left the family with NO live member. Printed, never
 *    dropped: it is a real coverage fact about the id's siblings, just not a sensitivity.
 *
 * The scored-day DENOMINATOR is printed beside both: a low flip count off a 40-day history is a
 * different fact from a low count off 900 days, and the ranking is unreadable without it.
 *
 * ## States (§13.4)
 * Per-day states come from the stored series' **`rawState`** — §13.4's anchor is `rawStateSeries`, so
 * the confirmed `state` column is NOT what this ranks. The distinction is not academic: over a 900-close
 * window the rows are almost entirely PRE-IS-5 vintages, which is exactly where the stored
 * `state`/`rawState` disagreements sit, and pivoting on `state` moved 10 of 21 rostered ids. The dated
 * disagreement count is still printed as a COVERAGE note (how much of the window predates the IS-5
 * zeroing) — it is NOT a validation of the metric, and must never be written up as one.
 * `GLOBAL_FAMILIES` is the canonical roster; bespoke ids in no family cannot flip by construction and
 * are printed in a separate section rather than scored 0 inside the ranking.
 *
 * ## Known limits, stated not fixed (§13.6)
 * - The three complacency ids and price-accel sit in `GLOBAL_FAMILIES.volatility` but are DARK TO THE
 *   DIAL (`DIAL_FAMILIES`): a flip there moves the veto panel, not the dial. Marked `[dark]` below.
 * - The tracking-mode (market × mode) cell system was removed 2026-08-27: every binding cut now
 *   resolves off the shared null/null calibration row, so the states the store produced are the
 *   only ones there are.
 *
 * STRICTLY READ-ONLY: `getSeriesBulk` selects only — never insert/update/delete/upsert.
 * The handle enforces it too: `getStore("ro")` returns a `ReadStore`, which holds no write method
 * (type AND run time), so no write can reach the DB from this probe.
 */
import { ALL_INDICATORS } from "../src/registry.js";
import { GLOBAL_FAMILIES, computeFamilyPanel, type FamilyDef } from "../src/families.js";
import { DIAL_FAMILIES } from "../src/danger-ladder.js";
import { getStore, type ReadStore, type SeriesPoint } from "../src/store.js";
import { isLocalUrl, liveResolveDeps, pullProdCreds } from "./backfill/resolve-store.js";
import { prodProjectRef, projectHost } from "./supabase-project.js";
import type { Indicator, State } from "../src/domain-types.js";
import { readEnv, type Env } from "../src/config.js";

// ══════════════════════════════════════════════════════════════════════════════════
// The set
// ══════════════════════════════════════════════════════════════════════════════════

/**
 * The bespoke-scorer count asserted against the live registry. See the header for the two derivations
 * that reach it and why it is not §13.2's 31. A registry change reds this deliberately: re-derive from the
 * predicate and re-read the ranking, never widen the assert to a range.
 */
// 36 → 37 when CQS shipped (2026-08-06): `thresholds: {}` + a bespoke quality-spread scorer.
// 37 → 38 when the `XDEV` pension comparator shipped (2026-08-08): the predicate is `thresholds: {}`
// alone, so every unscored PENSION display leg is already inside this count — the number tracks the
// registry, not the set of genuinely bespoke SCORERS.
// 40 → 42 when the RS_SMH/RS_XLK EW rel-strength legs shipped (2026-08-15): `thresholds: {}` +
// the bespoke scoreRelStrengthBreak scorer.
// 42 → 41 → 42 on 2026-09-04: a sovereign-spread row grew a registry absolute pair in the morning (no
// longer `thresholds: {}`) and lost it again hours later when it went velocity-only.
// 42 → 68 → 66 on 2026-10-10: re-derived (62 live before the six `LEGP_*` seats; −2 retiring SMH/VEA rows).
// 66 → 65 on 2026-10-12: CCC gained registry cuts (level + Δ20), so it left the `thresholds: {}` set.
// 65 → 63 on 2026-11-21: two `thresholds: {}` rows left the registry.
export const BESPOKE_COUNT = 63;

/**
 * §13.2's predicate: no cut on `thresholds` ⇒ the id does not run `classify()` and carries a
 * hand-written scorer instead. Written against own-key count because the registry spells the
 * condition `thresholds: {}` (the interface makes the field required).
 */
export function isBespoke(ind: Pick<Indicator, "thresholds">): boolean {
  return Object.keys(ind.thresholds ?? {}).length === 0;
}

export function bespokeIds(indicators: readonly Indicator[] = ALL_INDICATORS): string[] {
  return indicators.filter(isBespoke).map((i) => i.id);
}

/** id → the `GLOBAL_FAMILIES` family that owns it (the roster has no id in two families). */
export function familyOf(familyDefs: readonly FamilyDef[] = GLOBAL_FAMILIES): Map<string, FamilyDef> {
  const out = new Map<string, FamilyDef>();
  for (const f of familyDefs) for (const id of f.ids) if (!out.has(id)) out.set(id, f);
  return out;
}

/** Family keys the DIAL actually aggregates — a flip outside these moves the veto panel only. */
export function dialFamilyKeys(): Set<string> {
  return new Set(DIAL_FAMILIES.map((f) => f.key));
}

/** The ids `DIAL_FAMILIES` carries — an id can be pruned off the dial view of its own family. */
export function dialMemberIds(): Set<string> {
  return new Set(DIAL_FAMILIES.flatMap((f) => f.ids));
}

// ══════════════════════════════════════════════════════════════════════════════════
// The metric
// ══════════════════════════════════════════════════════════════════════════════════

/** One stored day: the state of every id that has a reading on that date. */
export interface DayStates {
  date: string;
  states: ReadonlyMap<string, State>;
}

export interface FlipRow {
  id: string;
  /** the `GLOBAL_FAMILIES` key that owns the id, or null when it is in no family. */
  family: string | null;
  /** days on which the id had a stored state (the ranking's denominator). */
  scoredDays: number;
  /**
   * days on which removing the id changed its family's worst-of state **while the family still had
   * a live member without it**. The ranked column — a genuine sensitivity.
   */
  flips: number;
  /**
   * days on which removing the id left the family with NO live member (`without.live === false`).
   * A coverage fact about the id's SIBLINGS, reported separately and never folded into `flips` —
   * see the header's ⚠ on the conflation this column exists to break out.
   */
  unpopulated: number;
}

/**
 * Fold the per-day states into one leave-one-out `FlipRow` per bespoke id.
 *
 * The family state on both sides of the counterfactual comes from `computeFamilyPanel`, called with
 * a single-family def so the roll-up under test is exactly the production one. A day counts toward
 * `scoredDays` for an id iff that id had a stored state that day — an id with no reading cannot be
 * removed, so it can neither flip nor be charged a denominator day for the absence.
 *
 * The `without` panel going NON-LIVE (the id was the family's only populated member that day) is
 * counted in `unpopulated`, never in `flips`: `null !== "GREEN"` is a coverage gap wearing a
 * sensitivity's clothes.
 */
export function flipRows(
  days: readonly DayStates[],
  ids: readonly string[],
  familyDefs: readonly FamilyDef[] = GLOBAL_FAMILIES,
): FlipRow[] {
  const fam = familyOf(familyDefs);
  const rows = new Map<string, FlipRow>(
    ids.map((id) => [
      id,
      { id, family: fam.get(id)?.key ?? null, scoredDays: 0, flips: 0, unpopulated: 0 },
    ]),
  );

  for (const day of days) {
    const readings = [...day.states].map(([id, state]) => ({ id, state }));
    // Cache the full-set state per family so it is computed once per day, not once per member.
    const fullState = new Map<string, State | null>();
    for (const id of ids) {
      const row = rows.get(id)!;
      if (!day.states.has(id)) continue;
      row.scoredDays++;
      const f = fam.get(id);
      if (!f) continue; // no family ⇒ cannot flip by construction (§13.4)
      if (!fullState.has(f.key)) {
        fullState.set(f.key, computeFamilyPanel(readings, [f]).families[0]!.state);
      }
      const without = computeFamilyPanel(
        readings.filter((r) => r.id !== id),
        [f],
      ).families[0]!;
      if (!without.live) {
        row.unpopulated++; // coverage gap, NOT a sensitivity — see the header ⚠
        continue;
      }
      if (without.state !== fullState.get(f.key)) row.flips++;
    }
  }
  return [...rows.values()];
}

/**
 * §13.5's PRE-REGISTERED non-vacuity guard. Two throws, both able to fire:
 *  - zero scored days across every id ⇒ the store read came back empty (wrong env, wrong window,
 *    an id-name drift) and every rank below would be a uniform 0 that LOOKS like a finding;
 *  - zero TOTAL REAL flips ⇒ the leave-one-out silently recomputed the same state on every day — the
 *    exact failure mode where the counterfactual is built wrong (e.g. the "without" panel is fed
 *    the unfiltered readings) and the probe reports "nothing matters" as if measured.
 *
 * ⚠ The second throw sums `flips` ONLY. `unpopulated` is deliberately excluded: before the split it
 * was folded in, so a roster whose families are all single-populated could carry the guard green on
 * coverage gaps alone while every real counterfactual was broken. The guard must be able to red on
 * the column it certifies.
 *
 * A PER-ID zero is a legitimate result — an inert leg, or a follower always masked by a hotter
 * sibling — and must NOT throw. That asymmetry is the point of the guard.
 */
export function assertNonVacuous(rows: readonly FlipRow[]): void {
  const scored = rows.reduce((s, r) => s + r.scoredDays, 0);
  if (scored === 0) {
    throw new Error(
      `VACUOUS PROBE: 0 scored days across all ${rows.length} bespoke ids. The store returned no ` +
        `readings for any of them — check --env (prod has the cron history; the dev DB does not) ` +
        `and --closes. Every rank this would print is a uniform zero that reads like a finding.`,
    );
  }
  const flips = rows.reduce((s, r) => s + r.flips, 0);
  if (flips === 0) {
    throw new Error(
      `VACUOUS PROBE: 0 TOTAL leave-one-out flips over ${scored} scored id-days (unpopulated days ` +
        `are NOT counted here). Removing a member never changed its family's worst-of state on ANY ` +
        `day where the family stayed live, which over this much history means the counterfactual is ` +
        `not being taken — most likely the "without" panel is being fed the full member set. Fix ` +
        `\`flipRows\` before reading any number below. (A per-id zero is fine and does NOT reach here.)`,
    );
  }
}

// ══════════════════════════════════════════════════════════════════════════════════
// Args
// ══════════════════════════════════════════════════════════════════════════════════

export const DEFAULT_CLOSES = 900;

/**
 * The date IS-5 zeroed every `CONFIRM_TIERS` entry (symmetric zero, 2026-07-26). Rows stored BEFORE
 * it can legitimately carry state !== rawState — they are pre-IS-5 vintages nothing re-derived —
 * so the premise check below is dated rather than global.
 */
export const IS5_SHIP_DATE = "2026-07-26";

export const argOf = (argv: readonly string[], name: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

/** `--closes=N` — defaults to `DEFAULT_CLOSES`; `null` = present but not a positive integer. */
export function parseCloses(argv: readonly string[]): number | null {
  const raw = argOf(argv, "closes");
  if (raw === undefined) return DEFAULT_CLOSES;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** `--env=local|prod` — defaults to prod, the only env with cron history (§13.4). */
export function parseEnv(argv: readonly string[]): "local" | "prod" {
  return argOf(argv, "env") === "local" ? "local" : "prod";
}

// ══════════════════════════════════════════════════════════════════════════════════
// Store (read-only)
// ══════════════════════════════════════════════════════════════════════════════════

/**
 * `getStore("ro")` over whichever creds the run targets. With the prod config loaded (or `.env.local`
 * for a local run) the vars are already in env; a bare host `--env=prod` pulls them live from the
 * Management API instead.
 *
 * The cross-guards mirror `resolveStore`'s (`scripts/backfill/resolve-store.ts`) — **all three of
 * them**, and the returned host is printed. The `--env=prod` half was MISSING until the 2026-07-28
 * review: local creds exported in the shell + `--env=prod` read the dev DB and printed `env=prod`,
 * and because the dev DB is backfilled the non-vacuity guard passed, yielding a plausible ranking
 * under a false label. This probe's whole deliverable is a measured claim, so the target host is
 * part of the output, not a debug aid.
 *
 * `resolveStore(env, "ro")` would give the same guards and the same `"ro"` handle; the copy predates its
 * mode param.
 */
async function openStore(env: "local" | "prod", appEnv: Env): Promise<{ store: ReadStore; host: string }> {
  const envUrl = appEnv.SUPABASE_URL;
  if (envUrl && appEnv.SUPABASE_SERVICE_KEY) {
    let host: string;
    try {
      host = new URL(envUrl).host;
    } catch {
      host = envUrl;
    }
    if (env === "local" && !isLocalUrl(envUrl)) {
      throw new Error(
        `--env=local but SUPABASE_URL in the environment points at ${host} — unset ` +
          `SUPABASE_URL/SUPABASE_SERVICE_KEY in the shell (or pass --env=prod deliberately).`,
      );
    }
    if (env === "prod" && isLocalUrl(envUrl)) {
      throw new Error(
        `--env=prod but SUPABASE_URL in the environment points at ${host} — unset the local creds ` +
          `so prod creds are pulled via the Management API. A ranking measured on the dev DB under ` +
          `a "prod" label is worse than no ranking.`,
      );
    }
    if (env === "prod") {
      const expected = projectHost(prodProjectRef(appEnv));
      if (host !== expected) {
        throw new Error(
          `--env=prod but SUPABASE_URL in the environment points at ${host}, not the expected ` +
            `project ${expected} — refusing to measure against a different Supabase project ` +
            `(set SUPABASE_PROJECT_REF if this is deliberate).`,
        );
      }
    }
    return { store: getStore("ro", appEnv), host };
  }
  if (env === "prod") {
    const { url, key, anonKey } = await pullProdCreds(liveResolveDeps, "ro");
    return { store: getStore("ro", { ...appEnv, SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key, SUPABASE_ANON_KEY: anonKey }), host: new URL(url).host };
  }
  throw new Error(
    `--env=local but no SUPABASE_URL/SUPABASE_SERVICE_KEY in the environment — source .env.local ` +
      `(or hold the dev stack open with \`scripts/db.sh up dev\`). Or use --env=prod.`,
  );
}

/**
 * Pivot per-id series into per-date state maps (only the ids handed in).
 *
 * ⚠ Reads **`rawState`**, per §13.4's `rawStateSeries` anchor. Reading the confirmed `state` column
 * makes this a CONFIRMED-state ranking, which over a 900-close window is a materially different
 * answer (10 of 21 rostered ids moved) — the window is mostly pre-IS-5 vintages, exactly where the
 * two columns disagree.
 */
export function toDayStates(series: ReadonlyMap<string, SeriesPoint[]>): DayStates[] {
  const byDate = new Map<string, Map<string, State>>();
  for (const [id, points] of series) {
    for (const p of points) {
      let m = byDate.get(p.date);
      if (!m) byDate.set(p.date, (m = new Map()));
      m.set(id, p.rawState);
    }
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, states]) => ({ date, states }));
}

const pad = (s: string | number, n: number): string => String(s).padStart(n);
const padEnd = (s: string | number, n: number): string => String(s).padEnd(n);

// ══════════════════════════════════════════════════════════════════════════════════
// CLI
// ══════════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const closes = parseCloses(process.argv);
  if (closes === null) {
    console.log("ABORT: --closes must be a positive integer.");
    process.exit(1);
  }
  const env = parseEnv(process.argv);

  const ids = bespokeIds();
  if (ids.length !== BESPOKE_COUNT) {
    throw new Error(
      `bespoke-set assert failed: the \`thresholds\`-absent predicate selects ${ids.length} ids, ` +
        `expected ${BESPOKE_COUNT} (${ids.join(" ")}). The registry moved — re-derive the set and ` +
        `re-read §13.2 before trusting the ranking.`,
    );
  }

  const fam = familyOf();
  const dialKeys = dialFamilyKeys();
  const dialIds = dialMemberIds();
  const inFamily = ids.filter((id) => fam.has(id));
  const noFamily = ids.filter((id) => !fam.has(id));

  // Every family member is fetched, not just the bespoke ones: the counterfactual is
  // worst-of over the FULL member set, so a missing sibling would fake flips. The no-family
  // bespoke ids are fetched too — they cannot flip, but their stored-day counts are the
  // difference between "inert here" and "has no history at all", and a section printing a
  // hard-coded 0 for both would be indistinguishable from never having looked.
  const needed = [...new Set([...inFamily.flatMap((id) => fam.get(id)!.ids), ...noFamily])];
  const { store, host } = await openStore(env, readEnv());

  console.log(
    `IS-4 ranking probe — leave-one-out family-state FLIPS per bespoke scorer (READ-ONLY)\n` +
      `target: ${host} (${env})  closes=${closes}  bespoke ids=${ids.length} ` +
      `(${inFamily.length} in a GLOBAL_FAMILIES family, ${noFamily.length} in none)\n` +
      `states: rawState (§13.4's rawStateSeries anchor), NOT the confirmed state column\n` +
      `read-only: SELECT-only calls over a getStore("ro") handle — it holds no write method.`,
  );

  const series = await store.getSeriesBulk(needed, { limit: closes });

  const days = toDayStates(series);
  const rows = flipRows(days, ids);
  assertNonVacuous(rows);

  // COVERAGE note, not a validation. Since IS-5 every `CONFIRM_TIERS` entry is zero, so a row WRITTEN
  // since the zeroing must carry state === rawState; rows older than the cut are pre-IS-5 vintages
  // nothing re-derived, and their disagreements are expected. What the counts below tell the reader is
  // HOW MUCH of this window predates the cut — i.e. how much the raw/confirmed choice would have
  // mattered. It says nothing about the ranking's correctness: the ranking pivots on `rawState`
  // unconditionally, so it is a raw-state ranking whichever way these counts fall.
  // ⚠ Do NOT write this up as "premise HOLDS ⇒ these are raw-state flips" (2026-07-28 review): the
  // dated check only covers rows since the cut, while a 900-close window is almost entirely pre-cut —
  // exactly where the disagreements live. That phrasing converted a true dated observation into a
  // false claim about the measurement.
  let preCut = 0;
  let postCut = 0;
  let lastDisagreement = "";
  let storedRows = 0;
  for (const points of series.values()) {
    for (const p of points) {
      storedRows++;
      if (p.state === p.rawState) continue;
      if (p.date >= IS5_SHIP_DATE) postCut++;
      else preCut++;
      if (p.date > lastDisagreement) lastDisagreement = p.date;
    }
  }

  const dateSpan = days.length ? `${days[0]!.date} → ${days.at(-1)!.date}` : "—";
  const disagree = preCut + postCut;
  console.log(
    `fetched: ${storedRows} rows over ${needed.length} ids, ${days.length} distinct dates (${dateSpan})\n` +
      `coverage note (state !== rawState): ${disagree} of ${storedRows} FETCHED rows — ` +
      `${postCut} dated on/after the ${IS5_SHIP_DATE} IS-5 zeroing, ${preCut} before it ` +
      `(pre-IS-5 vintages, never re-derived)` +
      (lastDisagreement ? `; last disagreement ${lastDisagreement}` : "") +
      `\n    → this sizes how much of the window predates the cut. It does NOT validate the metric:\n` +
      `      the ranking pivots on rawState unconditionally, so it is a raw-state ranking either way.\n`,
  );

  const ranked = [...rows]
    .filter((r) => r.family !== null)
    .sort((a, b) => b.flips - a.flips || b.scoredDays - a.scoredDays || a.id.localeCompare(b.id));

  console.log(`══ RANKED — REAL leave-one-out flips / scored days (descending) ══`);
  console.log(
    `    ${padEnd("id", 22)}${padEnd("family", 13)}${pad("flips", 6)}${pad("days", 7)}   ${pad("share", 6)}${pad("unpop", 8)}`,
  );
  for (const r of ranked) {
    const dark = !dialKeys.has(r.family!) || !dialIds.has(r.id) ? "  [dark to the dial]" : "";
    const share = r.scoredDays ? `${((100 * r.flips) / r.scoredDays).toFixed(1)}%` : "—";
    console.log(
      `    ${padEnd(r.id, 22)}${padEnd(r.family!, 13)}${pad(r.flips, 6)}${pad(r.scoredDays, 7)}   ${pad(share, 6)}${pad(r.unpopulated, 8)}${dark}`,
    );
  }

  console.log(`\n══ no family — cannot flip by construction (§13.4) ══`);
  for (const r of rows.filter((x) => x.family === null).sort((a, b) => a.id.localeCompare(b.id))) {
    console.log(`    ${padEnd(r.id, 22)}${pad(r.scoredDays, 7)} stored days`);
  }

  console.log(
    `\n    flips = removing the id CHANGED its family's worst-of state while the family still had a\n` +
      `    live member. unpop = removing it left the family with NO live member — a coverage gap in\n` +
      `    the id's SIBLINGS, not a sensitivity, so it is reported beside the ranking and never in it.\n` +
      `    [dark to the dial] = the id's flip moves the veto panel, not the dial: its family (or the\n` +
      `    id itself) is pruned off DIAL_FAMILIES — the three complacency ids and price-accel sit in\n` +
      `    GLOBAL_FAMILIES.volatility but the dial never sees them (§13.6).\n` +
      `    ⚠ A flip count is a SENSITIVITY, not an endorsement: it says the family's worst-of moves\n` +
      `    when this member is pulled, not that the move was right.`,
  );
}

const isMain = process.argv[1]?.endsWith("probe-bespoke-family-flip.ts") ?? false;
if (isMain) void main();
