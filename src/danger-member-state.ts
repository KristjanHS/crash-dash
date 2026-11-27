/**
 * MEMBER-OBSERVATION STATE — the builders that turn a family panel (or a `?hist=` window) into a
 * `MemberStateMap`, split out of `danger-engine.ts` 2026-08-09 (audit round-2 §0 ruling R4) so the
 * engine module carries only the cell/pillar/leg layers that consume the map.
 *
 * Everything here is pure: no IO, no clock, same panel → same map. The four public builders are the
 * ONLY places a `MemberStateMap` is constructed —
 *   • `buildMemberState` — live, off `d.globalFamilies`;
 *   • `buildMemberStateAt` — reconstructed at t−N off the `?hist=` window;
 *   • `buildMemberStateHeldAt` / `buildMemberStateHeld` — the same two, RAISED by the per-member
 *     SIGNAL-HOLD window (one shared walk, `heldFoldMap`).
 * The OQ-5 Stage 5.2 invariant they exist to keep — **an absent member is a MISSING KEY, never
 * `calm`** — is documented on `MemberStateMap` (danger-engine.ts) and re-asserted at each `continue`
 * below; `buildMemberStateHeldAt` documents the ONE ruled exception to it.
 *
 * Dependency direction is one-way: this module imports `danger-engine.ts` for TYPES ONLY (erased at
 * runtime, so no value cycle); `danger-engine.ts` imports these builders back as values and must
 * never be imported here for a value.
 */

import { signalHoldClosesFor } from "./danger-ladder.js";
import type { State } from "./domain-types.js";
import type {
  DangerInput,
  MemberFreshness,
  MemberHistoryEntry,
  MemberObs,
  MemberStateMap,
} from "./danger-engine.js";
import type { Severity } from "./danger-cell.js";

/** Map a family-member's confirmed .state to the grid severity (RED→lit, AMBER→elev, else calm).
 *
 *  OQ-5 Stage 5.2 (was ruled WRONG in Stage 3.1): the OLD signature returned `Severity` and folded
 *  a null/undefined state — "this member did not report" — into `calm`, destroying the absence
 *  before `MemberStateMap` was even built. It now returns `null` for an unobserved state, and the
 *  two callers below OMIT THE KEY rather than inventing one. `GREEN` still maps to `calm`, because
 *  a GREEN reading is an observation. */
function severityOf(state: string | null | undefined): Severity | null {
  // STAND-IN AUDIT (OQ-5 Stage 3.1): OK — no longer a stand-in. Absence in ⇒ absence out; the
  // remaining ternary is a MAPPING over an observed value ("RED"/"AMBER"/other), not a default.
  if (state === null || state === undefined) return null;
  return state === "RED" ? "lit" : state === "AMBER" ? "elev" : "calm";
}

/** Resolve a member's `obs` axis from an optional Stage-5.1 freshness stamp.
 *  `lag === false` is the ONLY way to be `fresh`: an id absent from `freshness`, or present with
 *  `lag: undefined` (an unstamped `Reading`), is "not assessed" and therefore never fresh (S-4,
 *  `Reading.ageDays` in domain-types.ts). Per S-2 a lagging member is HELD at its last state and
 *  still counts toward severity, so this default is severity-neutral by construction. */
function obsOf(id: string, freshness: ReadonlyMap<string, MemberFreshness> | null): MemberObs {
  if (freshness === null) return "lag";
  return freshness.get(id)?.lag === false ? "fresh" : "lag";
}

/** Live member observations sourced from d.globalFamilies (§10.7) — the same panel the
 *  board tiles render, so the grid can never contradict the board.
 *
 *  A member the panel does not carry (feed failed, fetch threw, family not live) is simply NOT A
 *  KEY here — that is the whole OQ-5 Stage 5.2 change at this seam. Freshness rides `d.freshness`
 *  when the caller has the Stage-5.1 stamp in hand; with no stamp every member reads `lag`
 *  ("not assessed", never fresh), which is severity-neutral (S-2 holds a lagging member's state). */
export function buildMemberState(d: DangerInput): MemberStateMap {
  const freshness = d.freshness ? new Map(d.freshness.map((f) => [f.id, f])) : null;
  const st: MemberStateMap = {};
  for (const f of d.globalFamilies ?? []) {
    for (const m of f.members ?? []) {
      const sev = severityOf(m.state);
      if (sev === null) continue; // unobserved ⇒ ABSENT (no key), never calm
      // §I9.6 — the lag label rides BESIDE `obs`, never replacing it: `obs` stays the registry-cut
      // verdict `verdictHoldLegs`/`/api/status` share, `lag` is the feed-vs-itself classification. The key
      // is OMITTED when the caller measured none, so an unmeasured member is never labelled.
      const lag = freshness?.get(m.id)?.label;
      st[m.id] = { sev, obs: obsOf(m.id, freshness), ...(lag === undefined ? {} : { lag }) };
    }
  }
  return st;
}

/** Member observations at t−N reconstructed from the /api/lab?hist window (i5). For each
 *  {id, history} pick history[len−1−N].
 *
 *  OQ-5 Stage 5.2 (Stage 3.1 ruled this WRONG): a member whose history is SHORTER than the t−N
 *  lookback used to be imputed `calm`, fabricating a quiet past so the momentum/speed arrows read
 *  a rise that never happened. A too-short history is now **ABSENT** — no key — and every consumer
 *  excludes it from its max/worst-of. The `obs` axis is `lag` throughout: a reconstructed
 *  historical state carries no evaluation-clock freshness, and "not assessed" is never `fresh`. */
export function buildMemberStateAt(memberHistory: MemberHistoryEntry[], N: number): MemberStateMap {
  const st: MemberStateMap = {};
  for (const { id, history } of memberHistory ?? []) {
    const pt = history && history[history.length - 1 - N];
    if (!pt) continue; // history too short at t−N ⇒ ABSENT, not calm
    const sev = severityOf(pt.state);
    if (sev === null) continue;
    st[id] = { sev, obs: "lag" };
  }
  return st;
}

/** Member-history depth in closes: the fetch window, and every `SIGNAL_HOLD_CLOSES` entry stays below it.
 *  Falsifier: `npx vitest run --silent=true src/danger-ladder.test.ts`. */
export const MEMBER_HISTORY_WINDOW = 60;

/** `Severity` → the number every fold compares (cells, share, hold fold). ⛔ Never restate these three numbers. */
export const SEV_NUM: Record<Severity, number> = { lit: 1, elev: 0.5, calm: 0 };

/** `Severity` → the confirmed `State` string it was derived from — the exact inverse of
 *  `severityOf`'s three live arms (`RED→lit`, `AMBER→elev`, everything-else→`calm`, whose
 *  canonical pre-image is `GREEN`). Exported because the HELD member map (below) carries
 *  severities, while the tech-confirmer seam (`techConfirmerFromPanel`, t1dial.ts) is written
 *  against `State`; without a shared inverse that seam would grow a second copy of the mapping and
 *  the two could disagree. NOT a general state reconstructor: it round-trips `severityOf` only, and
 *  a `calm` severity that originally came from some non-GREEN string reads back as `GREEN`. */
export const SEV_STATE: Record<Severity, State> = { lit: "RED", elev: "AMBER", calm: "GREEN" };

/** The member's hold WINDOW LENGTH in closes — `signalHoldClosesFor` normalised by the `max(H, 1)` rule
 *  `buildMemberStateHeldAt` documents (a fire is always visible on the close it prints, so `H = 0` and
 *  `H = 1` denote the same one-close window). Lifted out
 *  so the normalisation has ONE touch
 *  point: the window loop below and the `SignalCell.held` mark that REPORTS it (`computeCells`,
 *  danger-engine.ts) must agree, or a `lag`-class member (`H = 0`) resurrected by the window would be
 *  reported as held for `0` closes. Exported for that reporting site alone (it was module-private
 *  before the R4 split moved this builder out of `danger-engine.ts`).
 *  ⛔ Never restate a `SIGNAL_HOLD_CLOSES` number anywhere — read the window through here or `signalHoldClosesFor`. */
export function signalHoldWindowOf(id: string): number {
  return Math.max(signalHoldClosesFor(id), 1);
}

/** HELD member observations at t−N: the per-member SIGNAL-HOLD window (`SIGNAL_HOLD_CLOSES` /
 *  `signalHoldClosesFor`, danger-ladder.ts) applied to `buildMemberStateAt`'s reconstruction, so a
 *  member's fire stays visible to the danger path for the closes its timing class earns.
 *
 *  WINDOW = depths `N … N + max(H,1) − 1`, oldest-ward from the requested close. `H` counts the
 *  closes a fire is VISIBLE for and a fire is always visible on the close it prints, so `H = 0`
 *  and `H = 1` denote the SAME window — the member's own close alone — and `H = 0` (every `lag`
 *  member, and every UNCLASSED id) makes this function byte-identical to `buildMemberStateAt`.
 *  The fold over the window is a MAX in severity, matching every other fold on this path.
 *
 *  ⚠ THE HOLD SPANS ABSENT CLOSES, a knowing exception to the OQ-5 Stage 5.2 "absent is not a
 *  value" invariant, RULED and scoped to the held map ALONE.
 * A close the
 *  member did not report is `continue`d, not treated as calm, so a fire two closes back still reads
 *  lit through a reporting gap. `buildMemberState` / `buildMemberStateAt` are deliberately
 *  UNCHANGED and keep the invariant — never "unify" them with this one.
 *
 *  ⚠ …BUT IT STOPS AT A CONTRADICTION. The asymmetry is the whole rule: the window SPANS ABSENCE (the
 *  member said nothing, so its last word still stands) and STOPS AT CONTRADICTION (the member said it
 *  is over, so the hold has nothing left to carry). Concretely — a close OLDER than the requested one
 *  on which the member REPORTED `calm` ends the walk, so anything older than that recovery is
 *  unreachable (measured: 78% of held raises stood
 *  on a close whose own live print was GREEN). Two edges follow from the guard, not from luck: the
 *  REQUESTED close itself never releases (a member calm today with only calm behind it folds to `calm`
 *  either way, and a member lit today is never dulled by its own reading), and a PARTIAL cooldown
 *  (`lit` → `elev`) is not a contradiction — the member is still saying something, so the walk
 *  continues and the MAX keeps the older, higher severity.
 *
 *  Consequence, pinned in `danger-engine.growth-hold.test.ts`: this map may carry KEYS THE UNHELD MAP LACKS, so
 *  `censusOf` counts move (an `absent` becomes a `lag`). A resurrected entry is `obs: "lag"`
 *  (a reconstructed past carries no evaluation-clock freshness) and carries NO `lag` label — the
 *  lag axis is a live feed measurement and there is none for a held-over close. */
export function buildMemberStateHeldAt(
  memberHistory: MemberHistoryEntry[],
  N: number,
  /** PROBE-ONLY: the pre-arm-C (CUR) walk — see `heldFoldMap`'s `noRelease`. Omitted in production. */
  noRelease = false,
): MemberStateMap {
  const st: MemberStateMap = {};
  const fold = heldFoldMap(memberHistory, N, noRelease);
  for (const id of Object.keys(fold)) {
    // The AGE is deliberately DROPPED here: this builder reconstructs a past close with no live map to
    // disagree with, so nothing on this arm carries `held: true` (see `MemberObservation.held`) and an
    // age without that flag would claim provenance for readings the window never raised. The age
    // survives on the ONE arm that stamps the flag, `buildMemberStateHeld` below.
    st[id] = { sev: fold[id]!.sev, obs: "lag" };
  }
  return st;
}

/** THE window walk itself — one traversal per member, returning BOTH the severity the fold chose and
 *  the DEPTH it came from. Window semantics, the spanning exception and the release rule are all
 *  documented on `buildMemberStateHeldAt` above; this is that function's loop, lifted out
 *  for one reason: `HeldMark` must report the age
 *  of the severity it names, and the only way that number cannot disagree with the fold is for the same
 *  traversal to produce both. ⛔ Never re-derive an age by a second scan.
 *
 *  `age` is relative to the REQUESTED close (`k - N`), so `0` is that close itself. The max advances on
 *  strict `>`, so under a tie the NEWEST close carrying the winning severity owns the age — the same
 *  first-wins rule `observedWeightedMax` (danger-engine.ts) uses for the argmax member. */
function heldFoldMap(
  memberHistory: MemberHistoryEntry[],
  N: number,
  /** PROBE-ONLY MEASUREMENT SEAM — the pre-arm-C (CUR) walk. `true` SKIPS the release branch below and
   *  nothing else, so the fold reverts to the plain MAX over the whole window that shipped between
   *  Stage 2.1 and the release fix. Reaches here from
   *  `computeFieldProbe`'s `probeHoldNoRelease` arm (danger-engine.ts — see its `ProbeArms` docblock for why it is
   *  a SECOND arm rather than a
   *  widening of `probeHoldOff`) and from `probe-leg-ordering.ts --before=holdrelease`'s dial-chip seam.
   *  Every production call site omits it. */
  noRelease = false,
): Record<string, { sev: Severity; age: number }> {
  const out: Record<string, { sev: Severity; age: number }> = {};
  for (const { id, history } of memberHistory ?? []) {
    if (!history) continue;
    const hold = signalHoldWindowOf(id);
    let best: Severity | null = null;
    let bestAge = 0;
    for (let k = N; k < N + hold; k++) {
      const pt = history[history.length - 1 - k];
      if (!pt) continue; // the member did not report at this depth — the hold SPANS it (see above)
      const sev = severityOf(pt.state);
      if (sev === null) continue;
      // OBSERVED RECOVERY RELEASES THE HOLD (see the asymmetry above): a close the member REPORTED
      // calm, older than the requested one, ends the walk. `k > N` is what exempts the requested
      // close itself; `elev` falls through, so a partial cooldown does not release.
      if (!noRelease && sev === "calm" && k > N) break;
      if (best === null || SEV_NUM[sev] > SEV_NUM[best]) {
        best = sev;
        bestAge = k - N;
      }
    }
    if (best === null) continue; // nothing observed anywhere in the window ⇒ ABSENT, not calm
    out[id] = { sev: best, age: bestAge };
  }
  return out;
}

/** The LIVE member map (`buildMemberState`) RAISED — never lowered — by the hold window at t
 *  (`buildMemberStateHeldAt(cissHistory, 0)`).
 *
 *  Raised-only is what keeps this a HOLD rather than a smoother: a member that has cooled since its
 *  fire keeps the fire until its window runs out, but a member firing TODAY is never dulled by a
 *  calmer yesterday. The live entry's `obs` and `lag` ride through unchanged when its severity is
 *  raised — those describe the live feed, which the hold does not touch. A member the live panel
 *  lacks entirely but the window resurrects enters as `{ sev, obs: "lag" }`, no `lag`.
 *
 *  No `cissHistory` ⇒ the live map unchanged (the merge is the identity). The CALLER decides whether
 *  the hold is on at all and owns the degrade emission — `computeField` gates both, because "an array
 *  of zero-length histories" is also no depth and this function cannot report that to a run record. */
export function buildMemberStateHeld(
  d: DangerInput,
  cissHistory?: MemberHistoryEntry[],
  /** PROBE-ONLY: the pre-arm-C (CUR) walk — see `heldFoldMap`'s `noRelease`. It reaches this builder as
   *  well as `buildMemberStateHeldAt` because the arm is a WHOLE-PIPELINE control: `computeField`'s
   *  `stateNow` and `probe-leg-ordering.ts`'s dial-chip held map both come from here, and unreleasing one
   *  while releasing the other would put the field and the band on two different folds. Omitted in
   *  production. */
  noRelease = false,
): MemberStateMap {
  const live = buildMemberState(d);
  if (!cissHistory) return live;
  // The FOLD, not `buildMemberStateHeldAt`'s projection of it — this is the one arm that stamps
  // `held: true`, so it is the one arm entitled to the walk's AGE (`MemberObservation.heldAge`).
  const held = heldFoldMap(cissHistory, 0, noRelease);
  const out: MemberStateMap = { ...live };
  for (const id of Object.keys(held)) {
    const h = held[id]!;
    const cur = out[id];
    if (cur === undefined) {
      // RESURRECT — the live panel lacks this member entirely and the window brings it back. The
      // ENTRY is unconditional (its absence→presence is what the census must report); the `held`
      // STAMP is not. `SEV_NUM[h.sev] > 0` is this branch's form of the raise branch's strict `>`:
      // a member the live map lacks contributes NOTHING to the max, so only a non-calm held state
      // actually raises anything. THE SINGLE SEAM for the invariant "`held: true` ⇒ the window put
      // a severity here that the live map did not" — chosen over gating the MARK in `computeCells`
      // (`raw.value > 0`) because the flag itself would otherwise stay false-positive for every
      // other reader of `MemberObservation.held`, and one downstream patch cannot fix that.
      // ⚠ Review 2026-08-07: the
      // unconditional stamp painted `sig-held` on ALL NINE legs of an all-calm cell — every
      // `observedWeightedMax` value is 0 there, so the running max keeps the FIRST member in
      // `FAMILY_MEMBERS` order, which is exactly the calm-resurrected entry, and the cell claimed
      // its severity came from the window at `wsev 0`.
      // `heldAge` rides WITH the flag and only with it (Stage 2 of the hold-release plan): the
      // resurrected severity is wholly the window's, so its age is the walk's own depth.
      out[id] =
        SEV_NUM[h.sev] > 0
          ? { sev: h.sev, obs: "lag", held: true, heldAge: h.age }
          : { sev: h.sev, obs: "lag" };
      continue;
    }
    // RAISE — the held severity outranks today's live one, so what the cell will read is the older
    // close, not the chip. `held: true` is what lets `computeCells` say so (B2), and `heldAge` says
    // HOW FAR BACK that close is — under arm C the window length no longer answers that.
    if (SEV_NUM[h.sev] > SEV_NUM[cur.sev]) {
      out[id] = { ...cur, sev: h.sev, held: true, heldAge: h.age };
    }
  }
  return out;
}

/** THE cold-store test both hold seams branch on — `computeField` (danger-engine.ts) and `assembleDial`
 *  (dial-assembly.ts), which converged onto it
 *  so the two fallbacks are identical:
 *  no depth ⇒ the UNHELD builder at both, one fallback whole rather than half of it.
 *
 *  ⚠ DELIBERATELY WIDER THAN `cissHistory === undefined`. `fetchCissHistory` ALWAYS returns an array —
 *  one entry per panel member — and `[]` is truthy, so a bare "no cissHistory" test could never fire on
 *  the prod path. A cold/unconfigured store yields entries whose histories are all EMPTY, and that is
 *  the real degraded shape. ⛔ Do not re-type this expression at a call site: the definition of "cold
 *  store" must move in ONE place. */
export function noHoldDepth(cissHistory?: MemberHistoryEntry[]): boolean {
  return cissHistory === undefined || cissHistory.every((h) => h.history.length === 0);
}
