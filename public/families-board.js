/**
 * Families board — the /lab board region's build-once skeleton + in-place update, extracted
 * (MOVE-ONLY, 2026-09-05 P11) from lab.js so the read-only /overview page can render the SAME
 * implementation with `/api/lab` data and zero duplicated code.
 *
 * `renderFamiliesBoard(host, d, deps)` is the one entry: on the first call per host it writes the
 * board skeleton (tiles built via lab-board.js `buildTiles`), then — every call — repaints the
 * board head (regime / danger score / firing / band-reason / feed-lag residual) and updates each
 * tile in place, exactly as lab.js's applyBoard did. `deps.interactive` is OPTIONAL: absent, the
 * board is read-only — tiles never gain the `.clickable` class, `role="button"` or tabindex, and
 * this module attaches NO event listeners and fires NO fetch on any path (lab.js's tap-cycle
 * handlers are delegated on #lab, outside this seam; /overview simply never wires them).
 *
 * NEVER import lab.js from here (module-level DOM side effects — `.claude/rules/frontend.md`);
 * lab-board.js is the shared sibling both callers already lean on.
 */
import { setHTML } from "./help-bar.js";
import { secTip } from "./section-tips.js";
import { diffusionText } from "./diffusion-label.js";
import { cannotArmMarkText, isNoArmFamily, NO_ARM_TITLE, CANNOT_ARM_TITLE, dialLiveIdsOf } from "./tile-members.js";
import { attributionIndex } from "./leg-attribution.js";
import { armFireClause, estPushTag } from "./dial-headline.js";
import { familyLagSlotHtml, orphanLagSlotHtml } from "./family-lag.js";
import { coverageIndex } from "./coverage-marks.js";
import { esc } from "./chart-primitives.js";
import { buildTiles, famLagMarks, legStripHtml } from "./lab-board.js";

const STATE_CLASS = { GREEN: "g", AMBER: "a", RED: "r" };

// Human copy for the persisted band-reason (alert-band.ts BandReason).
// Explains why the LIVE notify band is what it is — dial regime vs a hard escalator
// floor vs the de-escalation lag holding a dropping dial above its raw read.
const BAND_REASON_LABEL = {
  regime: "band set by the dial regime",
  "lag-hold": "band held up by the de-escalation lag",
  "floor:credit": "band floored by the credit escalator",
  "floor:geo": "band floored by geopolitics",
  "floor:r4": "band floored by the cash / haven circuit-breaker",
  "floor:rate": "band floored by rate stress",
  "floor:ew": "EARLY-WARN: fast downside break - monitor, do not de-risk",
  "floor:coverage": "band floored by degraded coverage - a family's verdict is held by data that is not live",
  "verdict-hold": "band held up by a lagging feed - the prior band stands until it reports",
  divergence: "band bumped by divergence - credit widening into an equity high",
  "no-dial": "no dial - escalator floor only",
};
function bandReasonLabel(r) {
  return BAND_REASON_LABEL[r] ?? `band reason: ${r}`;
}

// Build-once-then-update-in-place, keyed PER HOST (lab.js's old module-level `built` flag,
// generalized): the skeleton (tiles + persistent markers) is written once so tile classes
// TRAVEL via CSS transitions on later updates.
const builtHosts = new WeakSet();

/** The board skeleton, written once into `host` (the #familiesBoard section). Exported separately
 *  so lab.js's buildBench can build it at skeleton time (before its build-time decorateHelp pass);
 *  renderFamiliesBoard calls it itself on a host nothing built yet (/overview's path). */
export function buildFamiliesBoard(host, d) {
  setHTML(
    host,
    `<div class="stickyInner" id="board">
          <span class="lg-sectag sec-tip"${secTip("families")}>Families board</span>
          <div class="board-head">
            <div class="regime"><small>Regime</small><span id="regime">-</span><small class="regime-est" id="regimeEst" hidden></small></div>
            <div class="score"><small>danger score</small><b id="score">0.00</b>
              <span class="board-lag" id="boardLag"></span></div>
          </div>
          <p class="firing" id="firing"></p>
          <p class="band-reason" id="bandReason" hidden></p>
          <p class="band-reason" id="pruneNote" hidden></p>
          <div class="legend-row">
            <div class="legend">
              <span><i class="dot g"></i>calm</span>
              <span><i class="dot a"></i>elevated</span>
              <span><i class="dot r"></i>danger</span>
              <span><i class="dot s"></i>no feed</span>
            </div>
            <div class="r4knobs" id="r4knobs" aria-label="R4 breaker knobs"></div>
          </div>
          <div class="tiles" id="tiles"></div>
        </div>`,
  );
  // Scoped to THIS host's `#tiles` (just written above), never a document-wide lookup.
  buildTiles(d, host.querySelector("#tiles"));
  builtHosts.add(host);
}

/** Build-if-needed + in-place update. `d` is the `/api/lab` payload (reads `globalFamilies`,
 *  `t1dial`, `dangerRoster`, `dialFamilies`, `feedLag`, `bandReason`, `mode`, `coverage` — every
 *  field optional-tolerant except `globalFamilies`/`t1dial`). `deps.interactive` (optional):
 *  scenario-mode click-to-cycle AFFORDANCES only (`.clickable`, role/tabindex/aria) — the
 *  listeners themselves stay delegated in lab.js; absent ⇒ read-only board. */
export function renderFamiliesBoard(host, d, deps = {}) {
  if (!builtHosts.has(host)) buildFamiliesBoard(host, d);
  const $ = (sel) => host.querySelector(sel);
  const t1 = d.t1dial;
  // Firing headline must reflect the GLOBAL panel (matching the now-global tiles + T1 dial),
  // not the US-panel top-level d.firingCount/d.liveFamilyCount. Mirror families.ts's exact
  // predicate: firingCount = live families with f.firing (= live && state !== "GREEN").
  const gLive = d.globalFamilies.filter((f) => f.live).length;
  const gFiring = d.globalFamilies.filter((f) => f.firing).length;

  // --- board head (sourced from the T1 dial — now the sole danger read on /lab) ---
  $("#regime").textContent = t1.regime;
  $("#score").textContent = t1.dangerScore.toFixed(2);
  const est = estPushTag(d);
  $("#regimeEst").textContent = est;
  $("#regimeEst").hidden = !est;
  // The dial headline's ARM/FIRE clause rides THIS row instead of taking one of its own.
  // The `→ <regime>, rung N` tail is sliced off (armFireClause): the regime
  // and score are painted two rows up, so the tail would restate them.
  // ⚠ This row WRAPS to 2–3 lines in any primed state (~40–46 mono chars fit; the clause runs 48–95).
  // Do not "fix" it by re-deriving a shorter clause here; the copy choice is the user's.
  // The `""` fallback is defensive and unreachable today — `t1dial` is non-optional on the live and
  // scenario payloads, replay never reaches this line, and `t1.regime` above would throw first.
  const armFire = armFireClause(t1.headline);
  setHTML(
    $("#firing"),
    `<b>${gFiring}</b> of ${gLive} families firing` + (armFire ? ` · ${esc(armFire)}` : ""),
  );
  // Why this band: live-only — the scenario/replay paths omit d.bandReason
  // (raw dial band, no persisted notify decision to name), so the caption stays hidden.
  const reasonEl = $("#bandReason");
  const reasonText = d.bandReason ? bandReasonLabel(d.bandReason) : "";
  reasonEl.textContent = reasonText;
  reasonEl.hidden = !reasonText;
  // Live-only: the latest EOD run's failed cron prune (`d.pruneFailed`, api/lab.ts); absent ⇒ hidden.
  const pruneEl = $("#pruneNote");
  const pruneText = d.pruneFailed ? `⚠ prune failed ${String(d.pruneFailed.firedAt).slice(0, 10)}` : "";
  pruneEl.textContent = pruneText;
  pruneEl.hidden = !pruneText;

  // --- tiles (click-to-cycle only in Scenario, and only for an interactive caller) ---
  const clickable = d.mode === "scenario" && !!deps.interactive;
  // Hoisted out of the per-tile loop: ONE derivation per payload, which is exactly what
  // `coverageIndex`'s docblock claims (the `attributionIndex` idiom; `buildTiles` calls it once too).
  const flips = coverageIndex(d);
  // D3/D4 served roster (family-colour-follows-danger) — the browser's ONLY source for chip tone +
  // no-arm; empty on an old cached payload, which paints every member `live` and no family no-arm.
  const legWeighted = new Set((d.dangerRoster && d.dangerRoster.legWeightedIds) || []);
  const perLegOnly = new Set((d.dangerRoster && d.dangerRoster.perLegOnlyIds) || []);
  const pillar = d.dangerRoster && d.dangerRoster.pillarIds ? new Set(d.dangerRoster.pillarIds) : undefined;
  const dialLive = dialLiveIdsOf(d);
  const noArm = (d.dangerRoster && d.dangerRoster.noArmFamilies) || [];
  // Feed-lag marks, re-derived every poll (a feed falls behind between runs) and painted through the
  // SAME producers buildTiles uses. The board-head slot carries the RESIDUAL — every marked feed on
  // no family's roster (`F7`/CAPE is the live one: it sits in no tile roster) — so no lagging feed
  // vanishes from the board even when a roster is incomplete. Empty ⇒ nothing painted, never a `⌁⁰`.
  const lagMarks = famLagMarks(d);
  const boardLag = $("#boardLag");
  if (boardLag) {
    // The `⌁ⁿ` mark is a `[title]` host and the ONLY carrier of "which feed is behind".
    setHTML(boardLag, orphanLagSlotHtml(lagMarks));
  }
  host.querySelectorAll("#tiles .tile").forEach((t) => {
    const f = d.globalFamilies.find((x) => x.key === t.dataset.key);
    // D4: a no-arm family that would read GREEN paints the `noarm` tone instead — never green, so the
    // calm colour keeps ONE meaning (genuinely calm AND able to arm). An elevated no-arm family keeps
    // its amber/red so the live member still shows; the `◇ no-arm` label + D2 mark carry the context.
    const noArmF = f && f.live && isNoArmFamily(f.key, noArm);
    const cls = f && f.live ? (noArmF && f.state === "GREEN" ? "noarm" : STATE_CLASS[f.state]) : "s";
    t.className = "tile " + cls + (clickable ? " clickable" : "");
    if (clickable) {
      t.setAttribute("role", "button");
      t.setAttribute("tabindex", "0");
      // The family desc is the tile's ⓘ host; the cycle affordance lives on aria-label
      // so it doesn't become a 2nd help target.
      t.setAttribute("aria-label", `${f ? f.label : t.dataset.key} - click to cycle state`);
    } else {
      t.removeAttribute("role");
      t.removeAttribute("tabindex");
      t.removeAttribute("aria-label");
    }
    t.querySelector(".dot").className = "dot " + cls;
    // D4 label + D2 mark. `.st`: `◇ no-arm` (never the state word) for a no-arm family. `.t-cannot`:
    // the served cannot-arm reds/ambers this family can't seat (D2).
    // D6c copy (2026-08-20): both titles say DEEPENS, not "scores legs". D6 gave off-band and no-arm
    // members `legP`, a real within-band deepener on `dangerScore` — "scores legs" understated it by
    // naming only the per-leg ledger. Neither can ever arm, which is what the marks still promise.
    const st = t.querySelector(".st");
    st.textContent = !f || !f.live ? "stub" : noArmF ? "◇ no-arm" : f.state;
    if (noArmF) st.title = NO_ARM_TITLE;
    else st.removeAttribute("title");
    const cannot = t.querySelector(".t-cannot");
    if (cannot) {
      const markText = f && f.live ? cannotArmMarkText(f) : "";
      cannot.textContent = markText;
      if (markText) cannot.title = CANNOT_ARM_TITLE;
      else cannot.removeAttribute("title");
      const worst = f && f.live && f.cannotArm ? f.cannotArm.worst : null;
      cannot.className = "t-cannot" + (worst === "RED" ? " ca-red" : worst ? " ca-amber" : "");
    }
    // The SAME `familyLagSlotHtml` producer as buildTiles. buildTiles paints `.t-h` once and this
    // loop never rewrites it, so a mark emitted only there would freeze at its build-time vintage
    // and keep claiming a feed is behind after it caught up —
    // pinned by the double-render test in `lab.family-lag.test.js`.
    const lagSlot = t.querySelector(".t-lag");
    if (lagSlot) {
      // `.tile .fam-lag[title]` is HELP_TAP_PRIORITY: the capture branch stopPropagation()s, so a
      // tap on the mark reads help and never cycles the tile in Scenario mode.
      setHTML(lagSlot, familyLagSlotHtml(lagMarks, t.dataset.key));
    }
    // The member-level diffusion count, rendered directly under the
    // worst-of state it qualifies — "RED, but 1 of 6" reads very differently from "RED, 5 of 6".
    // ⚠ The count folds
    // the **DIAL** axis — `d.dialFamilies` (DIAL_FAMILIES, what the pushed body counts) — NOT the
    // display panel `d.globalFamilies` the rest of this tile renders from. The two tables differ for
    // `volatility` alone (a 7-id roster against a 3-id one: DIAL_FAMILIES = GLOBAL_FAMILIES minus
    // `SLOW_INDICATOR_IDS`), so serving the display fold here would print a count and an `(N dark)`
    // denominator the push would never print on the same day. One number on both surfaces.
    // ⚠ Still the SERVED dial fold — never a front-end prune of the display members (that
    // re-breaks the `(N dark)` half the moment a SLOW member fails to
    // report). The volatility strip below paints all 7 members, so its "of 3" is narrower than
    // its own chips BY DESIGN: the bubble-watch group feeds no push.
    const diff = t.querySelector(".t-diff");
    if (diff) {
      // Match by family key — the two panels share `GLOBAL_FAMILIES`' keys/order today, but a
      // positional read would silently mis-label if either table's order ever moved.
      const dialF = (d.dialFamilies || []).find((x) => x.key === t.dataset.key);
      // Only where a worst-of state is actually painted: a NON-live family (any family whose
      // feed is dark) shows "stub", has no folded population, and would otherwise print a bare
      // "no members reporting" that reads as a fault. And only
      // when the DIAL panel actually carries this family: a payload without `dialFamilies` (a
      // response cached across the deploy that added it) or a family the dial table omits paints
      // NOTHING rather than falling back to the display fold — a wrong number reads as measured.
      diff.textContent = dialF && f && f.live ? diffusionText(dialF) : "";
    }
    // Re-render the member legs each board update so per-leg colours track the current
    // states (buildTiles only paints them once — stale after a scenario refetch).
    const ids = t.querySelector(".ids");
    if (ids && f) {
      const members = f.members || [];
      // The SAME `legStripHtml` producer as buildTiles — this refresh path overwrites the first
      // build, so anything applied only there (empty-state copy, axis badges, R2-3's role
      // grouping) would paint once and vanish on the first board update.
      const attrs = attributionIndex(d);
      setHTML(ids, legStripHtml(f, members, attrs, flips, legWeighted, perLegOnly, pillar, dialLive));
    }
    // Per-leg toggle affordance (scenario only): each member id is its own click/keyboard
    // target that cycles that indicator's state; live mode strips the a11y attrs.
    // The aria-label names the member by its real LABEL (prose surface — full spacing, not the
    // chip's underscore token; Addendum C-b full replacement of the bare id), looked up from the
    // SAME members the chips were built from. Falls back to the id when a leg carries no reachable
    // member.
    const memberLabelById = new Map(((f && f.members) || []).map((mm) => [mm.id, mm.label]));
    t.querySelectorAll(".ids [data-id]").forEach((leg) => {
      if (clickable) {
        leg.setAttribute("role", "button");
        leg.setAttribute("tabindex", "0");
        leg.setAttribute("aria-label", `${memberLabelById.get(leg.dataset.id) || leg.dataset.id} - click to cycle state`);
      } else {
        leg.removeAttribute("role");
        leg.removeAttribute("tabindex");
        leg.removeAttribute("aria-label");
      }
    });
  });
}
