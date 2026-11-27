import { describe, expect, test } from "vitest";
import { InMemoryStore } from "./store-memory.js";
import type { AlertRecord, StoredReading } from "./store.js";
import type { State } from "./domain-types.js";
import { DIAL_FAMILIES } from "./dial-assembly.js";
import { ALERT_RANK } from "./ladder.js";
import { ALL_INDICATORS } from "./registry.js";
import { SLOW_INDICATOR_IDS } from "./registry-price.js";
import { GATE_FAILED_ESTIMATORS } from "./nowcast-score.js";
import { isProvisional } from "./intraday.js";
import type { RunInputs } from "./run-inputs.js";
import { alert } from "./store.test-helpers.js";
import { drainDegradeLog, resetDegradeLog } from "./tracks.js";
import {
  REDERIVE_STEP_FAILED_SCOPE, applyRederive, rederiveFailedScope, rederiveOnWrite, rederiveRun, rederiveVerdict, servedMatches, servedWithOriginals, supersedingFiredAt, twinsAgree,
} from "./rederive.js";

const D = "2026-01-30";
const PREV = "2026-01-29";
const FIRED = `${D}T22:00:00.000Z`;
const LATER = "2026-01-31T22:00:00.000Z"; // the next EOD cron's official write-back
const KNOWN = new Set(ALL_INDICATORS.map((i) => i.id));
const ROSTER = [...new Set(DIAL_FAMILIES.flatMap((f) => f.ids))].filter((id) => KNOWN.has(id));
// The rates family (the euro legs + the US legs): a whole family RED moves the band, a few cards don't.
const FLIP = DIAL_FAMILIES.find((f) => f.key === "rates")!.ids.filter((id) => ROSTER.includes(id));
const CHANNEL = new Map(ALL_INDICATORS.map((i) => [i.id, i.channel]));

const row = (indicatorId: string, state: State, over: Partial<StoredReading> = {}): StoredReading =>
  ({ date: D, indicatorId, value: 1, delta20: 0, rawState: state, state, decision: null, ...over });

/** The run at FIRED: every roster member GREEN on D (`lagged` on D−1), `estimated` on `est`. */
async function seed(est: readonly string[], opts: { runInputs?: RunInputs | null; orig?: Partial<AlertRecord>; lagged?: readonly string[] } = {}) {
  const store = new InMemoryStore();
  const rows = ROSTER.map((id) => row(id, "GREEN", { ...(est.includes(id) ? { estimated: true } : {}), ...(opts.lagged?.includes(id) ? { date: PREV } : {}) }));
  const orig = alert({ date: D, firedAt: FIRED, level: "OK", dialBand: "OK", ...opts.orig, ...(opts.runInputs !== undefined ? { runInputs: opts.runInputs } : {}) });
  await store.recordRun(rows, FIRED, orig);
  return { store, orig, rows };
}
const writeOfficial = (store: InMemoryStore, ids: readonly string[], state: State, over: Partial<StoredReading> = {}) =>
  store.recordReadings(ids.map((id) => row(id, state, { value: 2, ...over })), LATER);

const NO_DEADLINE = () => Infinity; // an un-anchored run (`runMsUntilHardDeadline`)
const prevRow = alert({ date: PREV, firedAt: `${PREV}T22:00:00.000Z`, level: "OK", dialBand: "OK" });
const STAMP = "2026-01-30T22:00:00.001Z"; // the run's estimate heads (`writeEstimateRows`)
// A replayed run that folded no estimate heads — its evidence is complete without them.
const noHeadInputs = (): RunInputs => ({ ...replayInputs(ROSTER.map((id) => row(id, "GREEN", FLIP.includes(id) ? { estimated: true } : {}))), heads: [] });
const replayInputs = (rows: readonly StoredReading[]): RunInputs => ({
  v: 1,
  refs: { last: prevRow.firedAt, prevDay: prevRow.firedAt, lastPush: null },
  geoFlags: 0, crisisStage: 0, scored: [], lastBands: [], exposurePosture: null, fallShape: null, spDistToHigh: null, nearHighTol: null, stamps: {},
  globalReadings: rows.filter((r) => CHANNEL.get(r.indicatorId) === "GLOBAL")
    .map((r) => ({ id: r.indicatorId, date: r.date, level: r.value, delta20: r.delta20, rawState: r.rawState, state: r.state })),
});

describe("rederiveVerdict — twin gate over same-(id, date) official rows", () => {
  test("official closes that keep every state (values moved) → twins agree → null; no official row yet → null", async () => {
    const { store, orig } = await seed(FLIP);
    expect(await rederiveVerdict(store, orig)).toBeNull();
    await writeOfficial(store, FLIP, "GREEN");
    expect(await rederiveVerdict(store, orig)).toBeNull();
  });

  test("estimated sovereign cards whose official closes go RED lift the band → superseding row at fired_at + 2 ms (+1 ms is the run's own estimate stamp)", async () => {
    const ri = replayInputs(ROSTER.map((id) => row(id, "GREEN", FLIP.includes(id) ? { estimated: true } : {})));
    const { store, orig } = await seed(FLIP, { runInputs: ri });
    await store.recordAlert(prevRow);
    await writeOfficial(store, FLIP, "RED");
    const out = await rederiveVerdict(store, orig);
    expect(out?.rederivedFrom).toBe(FIRED);
    expect(out?.firedAt).toBe("2026-01-30T22:00:00.002Z");
    expect(out?.pushedAt).toBeNull();
    expect(out?.runInputs).toEqual(ri);
    expect(ALERT_RANK[out!.dialBand!]).toBeGreaterThan(ALERT_RANK.OK);
    // BUND is a run_inputs GLOBAL reading: its swap rides the replay's `globalReadings`, not the notify rows.
    expect(out!.panelState!.globalPanel.find((f) => f.key === "rates")!.members.find((m) => m.id === "BUND")?.state).toBe("RED");
  });

  test("a row without run_inputs recomputes the band but keeps the original's exposure/held/cash/fall/r4", async () => {
    const frozen: Partial<AlertRecord> = {
      heldSleeve: "Semis", reriskConfirmCount: 3, heldDays: 7, cashOverlay: "partial", cashOverlaySince: "2026-01-20T22:00:00.000Z", cashOverlayReason: "fixture",
      fallShape: "v-shaped", fallVelocity: -0.4, creditDwellCloses: 2, r4Phase: "cash", r4EntryFiredAt: "2026-01-21T22:00:00.000Z", r4ReentryRung: 4,
      exposureState: { posture: "Reduced", rawPosture: "Reduced", rungBlind: false } as AlertRecord["exposureState"],
    };
    const { store, orig } = await seed(FLIP, { orig: frozen });
    await writeOfficial(store, FLIP, "RED");
    const out = await rederiveVerdict(store, orig);
    expect(out).not.toBeNull();
    expect(out!.runInputs).toBeNull();
    for (const [k, v] of Object.entries(frozen)) expect(out![k as keyof AlertRecord], k).toEqual(v);
  });

  test("only a row that WAS estimated swaps, and only for its own date: a lagged reading never takes a newer official close", async () => {
    // Not estimated, dated D−1; RED official on D (≤ D) — a newest-≤D lookup would take it.
    const lagged = await seed([], { lagged: FLIP });
    await writeOfficial(lagged.store, FLIP, "RED");
    expect(await rederiveVerdict(lagged.store, lagged.orig)).toBeNull();
    // Estimated on D−1 with no D−1 official; the RED official sits on D.
    const estLagged = await seed(FLIP, { lagged: FLIP });
    await writeOfficial(estLagged.store, FLIP, "RED");
    expect(await rederiveVerdict(estLagged.store, estLagged.orig)).toBeNull();
  });

  test("a correction reaching the verdict only through the run's estimate heads (1 ms past fired_at) still supersedes", async () => {
    // Official readings lag on D−1; the heads on D are what the notify dial folded (`withEstimateHeads`).
    const withHeads = async (ids: readonly string[], official: State, over: Partial<StoredReading> = {}) => {
      const s = await seed([], { lagged: ids });
      await s.store.recordReadings(ids.map((id) => row(id, "GREEN", { estimated: true })), "2026-01-30T22:00:00.001Z");
      await writeOfficial(s.store, ids, official, over);
      return rederiveVerdict(s.store, s.orig);
    };
    const out = await withHeads(FLIP, "RED");
    expect(ALERT_RANK[out!.dialBand!]).toBeGreaterThan(ALERT_RANK.OK);
    expect(out!.panelState!.globalPanel.find((f) => f.key === "rates")!.members.find((m) => m.id === FLIP[0])?.state).toBe("RED");
    expect(await withHeads(FLIP, "GREEN", { value: 1 })).toBeNull();
  });

  // The twin's notify dial keys the stored-row keep off the run's fired date; both arms share the data date `asOf` (= D).
  test("the twin's notify dial folds a provisional estimate dated D when the run fired on D+1, never when it fired on D", async () => {
    const X = "F3";
    const estAt = `${D}T15:00:00.000Z`;
    expect([ROSTER.includes(X), FLIP.includes(X), GATE_FAILED_ESTIMATORS.has(X), isProvisional({ date: D, runAt: estAt })]).toEqual([true, false, false, true]);
    const tail = async (firedAt: string) => {
      const store = new InMemoryStore();
      const orig = alert({ date: D, firedAt, level: "OK", dialBand: "OK" });
      await store.recordRun(ROSTER.map((id) => row(id, "GREEN", id === X ? { date: PREV } : FLIP.includes(id) ? { estimated: true } : {})), firedAt, orig);
      await store.recordReadings([row(X, "RED", { estimated: true })], estAt);
      await writeOfficial(store, FLIP, "RED");
      // The member's history tail: the GREEN print on D−1, or the RED estimate on D once folded.
      return (await rederiveVerdict(store, orig))?.panelState?.cissHistory.find((h) => h.id === X)?.history.at(-1)?.state;
    };
    expect([await tail(FIRED), await tail("2026-01-31T01:00:00.000Z")]).toEqual(["GREEN", "RED"]);
  });

  // The SLOW legs persist with the run but score off the dial readings; the superseding row's display
  // panels must still carry them, else /lab's Volatility tile serves the four as absent for that date.
  test("a superseding row keeps the run's SLOW legs on both display volatility panels", async () => {
    const { store, orig } = await seed(FLIP);
    await store.recordReadings([...SLOW_INDICATOR_IDS].map((id) => row(id, "GREEN")), FIRED);
    await writeOfficial(store, FLIP, "RED");
    const sup = (await rederiveVerdict(store, orig))!;
    for (const p of [sup.panelState, sup.displayPanelState]) {
      expect(p?.displayPanel.find((f) => f.key === "volatility")?.members.map((m) => m.id)).toEqual(expect.arrayContaining([...SLOW_INDICATOR_IDS]));
    }
  });

  test("twinsAgree: a display-only dial or panel difference disagrees; a cissHistory-only one never does", async () => {
    const { store, orig } = await seed(FLIP);
    await writeOfficial(store, FLIP, "RED");
    const row = (await rederiveVerdict(store, orig))!;
    expect(row.displayDialState && row.displayPanelState).toBeTruthy(); // premise: the twin persists both display states
    const shift = (f: (c: AlertRecord) => void) => { const c = structuredClone(row); f(c); return c; };
    expect(twinsAgree(row, structuredClone(row))).toBe(true);
    expect(twinsAgree(row, shift((c) => { c.displayDialState!.targetRung += 1; }))).toBe(false);
    expect(twinsAgree(row, shift((c) => { c.displayPanelState!.globalPanel = []; }))).toBe(false);
    expect(row.displayPanelState!.cissHistory?.length).toBeGreaterThan(0); // premise: emptying it is a real change
    expect(twinsAgree(row, shift((c) => { c.displayPanelState!.cissHistory = []; }))).toBe(true);
  });
});

describe("applyRederive — the idempotent write path (cron + CLI)", () => {
  const superseding = (store: InMemoryStore) => store.alerts.filter((a) => a.rederivedFrom === FIRED);

  test("writes ONE superseding row + twin B's readings at its fired_at; a repeat replaces it, never stacks", async () => {
    const { store, orig } = await seed(FLIP);
    await writeOfficial(store, FLIP, "RED");
    const first = await applyRederive(store, orig);
    expect(first.removed).toBe(0);
    const again = await applyRederive(store, orig);
    expect(again.removed).toBe(1);
    expect(superseding(store)).toHaveLength(1);
    const served = await store.getLastAlert();
    expect(served?.firedAt).toBe("2026-01-30T22:00:00.002Z");
    // The board under the served row: the run's readings, the swapped (id, D)s official — once, not twice.
    const board = await store.getReadingsForRun(served!.firedAt);
    expect(board).toHaveLength(ROSTER.length);
    expect(board.filter((r) => FLIP.includes(r.indicatorId)).map((r) => [r.state, r.estimated])).toEqual(FLIP.map(() => ["RED", undefined]));
    expect(await store.getReadingsForRun(FIRED)).toHaveLength(ROSTER.length);
  });

  test("twins that agree again drop the stale superseding row and its readings; the original stands", async () => {
    const { store, orig } = await seed(FLIP, { runInputs: noHeadInputs() });
    await store.recordAlert(prevRow);
    await writeOfficial(store, FLIP, "RED");
    await applyRederive(store, orig);
    await writeOfficial(store, FLIP, "GREEN", { value: 1 }); // a later official vintage: back to the estimate's state
    expect(await applyRederive(store, orig)).toEqual({ row: null, removed: 1 });
    expect(superseding(store)).toEqual([]);
    expect(await store.getReadingsForRun("2026-01-30T22:00:00.002Z")).toEqual([]);
    expect((await store.getLastAlert())?.firedAt).toBe(FIRED);
  });

  test("rederiveOnWrite fires only once an (id, date) the ORIGINAL read off an estimate holds a FINAL row", async () => {
    const { store } = await seed(FLIP);
    expect(await rederiveOnWrite(store, NO_DEADLINE)).toEqual([]);
    await writeOfficial(store, ROSTER.filter((id) => !FLIP.includes(id)), "GREEN"); // FINAL rows on the run's non-estimated (id, D)s
    await writeOfficial(store, FLIP, "RED", { date: PREV }); // FINAL rows on a date the run never read
    expect(await rederiveOnWrite(store, NO_DEADLINE)).toEqual([]);
    expect(superseding(store)).toEqual([]);
    await writeOfficial(store, FLIP, "RED");
    expect((await rederiveOnWrite(store, NO_DEADLINE)).map((r) => "orig" in r && r.row?.rederivedFrom)).toEqual([FIRED]);
    // The newest verdict has no later EOD check yet: a second call re-derives FIRED again, from the ORIGINAL.
    expect((await rederiveOnWrite(store, NO_DEADLINE)).map((r) => "orig" in r && r.removed)).toEqual([1]);
    expect(superseding(store)).toHaveLength(1);
  });

  test("rederiveOnWrite fires on an estimated row dated before the original's date", async () => {
    const { store } = await seed(FLIP, { lagged: FLIP }); // estimated on D−1, the run dated D by the rest of the roster
    await writeOfficial(store, FLIP, "RED", { date: PREV });
    expect((await rederiveOnWrite(store, NO_DEADLINE)).map((r) => "orig" in r && r.orig.firedAt)).toEqual([FIRED]);
  });

  const N = "2026-02-03";
  const NF = `${N}T22:00:00.000Z`;
  const recordNewer = (store: InMemoryStore, over: Partial<AlertRecord> = {}) =>
    store.recordRun(ROSTER.map((id) => row(id, "GREEN", { date: N })), NF, alert({ date: N, firedAt: NF, level: "OK", dialBand: "OK", ...over }));

  test("rederiveOnWrite: a late official close re-derives an OLDER original under a newer verdict", async () => {
    const { store } = await seed(FLIP);
    await recordNewer(store);
    await store.recordReadings(FLIP.map((id) => row(id, "RED", { value: 2 })), "2026-02-04T12:00:00.000Z"); // D's closes land after N's run
    expect((await rederiveOnWrite(store, NO_DEADLINE)).map((r) => "orig" in r && [r.orig.firedAt, r.row?.rederivedFrom])).toEqual([[FIRED, FIRED]]);
  });

  test("rederiveOnWrite: a FINAL row the newer verdict's run already read, or a same-content rewrite since, never re-fires an older original", async () => {
    const { store } = await seed(FLIP);
    await writeOfficial(store, FLIP, "RED"); // lands before N's run: N's own step read it
    await recordNewer(store);
    const versions = store.getReadingVersions.bind(store);
    let reads = 0;
    store.getReadingVersions = (id, date) => { reads++; return versions(id, date); };
    expect(await rederiveOnWrite(store, NO_DEADLINE)).toEqual([]);
    expect(reads).toBe(0); // a row written before the check is never news: no vintage read for it
    await store.recordReadings(FLIP.map((id) => row(id, "RED", { value: 2 })), "2026-02-04T12:00:00.000Z"); // an intraday persist re-writes it
    expect(await rederiveOnWrite(store, NO_DEADLINE)).toEqual([]);
    await store.recordReadings(FLIP.map((id) => row(id, "RED", { value: 3 })), "2026-02-04T13:00:00.000Z"); // a revised vintage
    reads = 0;
    expect((await rederiveOnWrite(store, NO_DEADLINE)).map((r) => "orig" in r && r.orig.firedAt)).toEqual([FIRED]);
    // Every FLIP row is news: the check stops at the first unseen batch, never reading each fresh row's vintages.
    expect([reads > 0, reads < FLIP.length]).toEqual([true, true]);
  });

  test("rederiveOnWrite: a check the newest row's step failed — on that verdict or the whole step — re-fires it; another verdict's failure does not", async () => {
    const OTHER = `${PREV}T22:00:00.000Z`;
    const fired = async (scope: string | null) => {
      const { store } = await seed(FLIP);
      await writeOfficial(store, FLIP, "RED"); // lands before N's run: read as seen, bar a failed check
      await recordNewer(store, scope === null ? {} : { degraded: [{ scope, reason: "transient 503", effect: "notify" }] });
      return (await rederiveOnWrite(store, NO_DEADLINE)).map((r) => "orig" in r && r.orig.firedAt);
    };
    expect([await fired(rederiveFailedScope(FIRED)), await fired(REDERIVE_STEP_FAILED_SCOPE), await fired(rederiveFailedScope(OTHER)), await fired(null)])
      .toEqual([[FIRED], [FIRED], [], []]);
  });

  test("rederiveOnWrite: two older verdicts on one late official close both re-derive — an older one's re-derive never masks a newer one's check", async () => {
    const M = "2026-02-02";
    const MF = `${M}T22:00:00.000Z`;
    const { store } = await seed(FLIP);
    // A middle verdict that read the same estimated (id, D)s, the rest of its roster on M.
    await store.recordRun(ROSTER.map((id) => row(id, "GREEN", FLIP.includes(id) ? { estimated: true } : { date: M })), MF, alert({ date: M, firedAt: MF, level: "OK", dialBand: "OK" }));
    await recordNewer(store);
    await store.recordReadings(FLIP.map((id) => row(id, "RED", { value: 2 })), "2026-02-04T12:00:00.000Z"); // D's closes land after N's run
    const out = await rederiveOnWrite(store, NO_DEADLINE);
    expect(out.map((r) => "orig" in r && r.orig.firedAt)).toEqual([FIRED, MF]);
    expect(out[0]).toMatchObject({ row: { rederivedFrom: FIRED } }); // premise: the older re-derive wrote a superseding row's readings first
  });

  test("rederiveOnWrite: verdict checks run concurrently but bounded — never every recent verdict's reads at once", async () => {
    const store = new InMemoryStore();
    const days = ["2026-01-26", "2026-01-27", "2026-01-28", "2026-01-29", "2026-01-30", "2026-02-02"];
    for (const d of days) await store.recordRun(ROSTER.map((id) => row(id, "GREEN", { date: d })), `${d}T22:00:00.000Z`, alert({ date: d, firedAt: `${d}T22:00:00.000Z`, level: "OK", dialBand: "OK" }));
    const at = store.getAlertAt.bind(store);
    let inFlight = 0;
    let peak = 0;
    store.getAlertAt = async (firedAt, opts) => {
      if (opts?.withPanel !== true) return at(firedAt, opts);
      peak = Math.max(peak, ++inFlight); // a check's first read (`loadRun`)
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return at(firedAt, opts);
    };
    expect(await rederiveOnWrite(store, NO_DEADLINE)).toEqual([]);
    expect([peak > 1, peak < days.length]).toEqual([true, true]);
  });

  test("rederiveOnWrite: a re-derive starting short of headroom is deferred under its verdict's retry scope; the next EOD applies it", async () => {
    const M = "2026-02-02";
    const MF = `${M}T22:00:00.000Z`;
    const { store } = await seed(FLIP);
    await store.recordRun(ROSTER.map((id) => row(id, "GREEN", FLIP.includes(id) ? { estimated: true } : { date: M })), MF, alert({ date: M, firedAt: MF, level: "OK", dialBand: "OK" }));
    await recordNewer(store);
    await store.recordReadings(FLIP.map((id) => row(id, "RED", { value: 2 })), "2026-02-04T12:00:00.000Z"); // D's closes land after N's run
    resetDegradeLog();
    let left = Infinity;
    const out = await rederiveOnWrite(store, () => { const l = left; left = 0; return l; }); // the clock runs out after one apply
    expect(out.map((r) => ("error" in r ? ["deferred", r.firedAt] : ["applied", r.orig.firedAt]))).toEqual([["applied", FIRED], ["deferred", MF]]);
    const degraded = drainDegradeLog();
    expect(degraded.map((e) => e.scope)).toEqual([rederiveFailedScope(MF)]);
    // The next EOD's row carries this run's degrades (`persistRun`): the deferred verdict alone re-fires.
    const N2 = "2026-02-05";
    await store.recordRun(ROSTER.map((id) => row(id, "GREEN", { date: N2 })), `${N2}T22:00:00.000Z`, alert({ date: N2, firedAt: `${N2}T22:00:00.000Z`, level: "OK", dialBand: "OK", degraded }));
    expect((await rederiveOnWrite(store, NO_DEADLINE)).map((r) => "orig" in r && r.orig.firedAt)).toEqual([MF]);
  });

  test("rederiveOnWrite: a FINAL row whose only earlier vintage was provisional is news to the newer verdict's check", async () => {
    const { store } = await seed(FLIP);
    await store.recordReadings(FLIP.map((id) => row(id, "RED", { value: 2 })), `${D}T06:00:00.000Z`); // before D's close: provisional
    await recordNewer(store);
    expect(await rederiveOnWrite(store, NO_DEADLINE)).toEqual([]);
    await store.recordReadings(FLIP.map((id) => row(id, "RED", { value: 2 })), "2026-02-04T12:00:00.000Z");
    expect((await rederiveOnWrite(store, NO_DEADLINE)).map((r) => "orig" in r && r.orig.firedAt)).toEqual([FIRED]);
  });

  test("rederiveOnWrite: a head dated past its run's date still re-derives that run (the window keys on the fired date)", async () => {
    const { store } = await seed([], { lagged: ROSTER, orig: { date: PREV } }); // every print on D−1: the run's date is D−1
    await store.recordReadings(FLIP.map((id) => row(id, "GREEN", { estimated: true })), STAMP); // heads on D
    await writeOfficial(store, FLIP, "RED");
    expect((await rederiveOnWrite(store, NO_DEADLINE)).map((r) => "orig" in r && r.orig.firedAt)).toEqual([FIRED]);
  });

  test("rederiveOnWrite: an older failing date is reported and never blocks a newer one", async () => {
    const { store } = await seed(FLIP);
    const poison = `${PREV}T22:00:00.000Z`;
    await store.recordAlert(alert({ date: PREV, firedAt: poison, level: "OK", dialBand: "OK", rederivedFrom: "2026-01-28T22:00:00.000Z" }));
    await writeOfficial(store, FLIP, "RED");
    const out = await rederiveOnWrite(store, NO_DEADLINE);
    // A failure names the verdict by its ORIGINAL's fired_at (`rederiveFailedScope`'s key), never the superseding row's.
    expect(out.map((r) => ("error" in r ? r.firedAt : r.row?.rederivedFrom))).toEqual(["2026-01-28T22:00:00.000Z", FIRED]);
  });

  test("rederiveOnWrite: a failed member-history bulk read reports the date, never a twin on an emptied history", async () => {
    const { store } = await seed(FLIP);
    await writeOfficial(store, FLIP, "RED");
    const bulk = store.getSeriesBulk.bind(store);
    // Every deep read fails; the official-row reads (limit 1) still serve.
    store.getSeriesBulk = (ids, opts) => ((opts?.limit ?? 0) > 1 ? Promise.reject(new Error("db down")) : bulk(ids, opts));
    const out = await rederiveOnWrite(store, NO_DEADLINE);
    expect(out).toEqual([{ firedAt: FIRED, error: "db down" }]);
  });

  test("the probe's check: served == a fresh re-derive, and a stale superseding row is a mismatch", async () => {
    const { store, orig } = await seed(FLIP, { runInputs: noHeadInputs() });
    await store.recordAlert(prevRow);
    const check = async () => {
      const [pair] = await servedWithOriginals(store, 5);
      return [pair!.orig.firedAt, servedMatches(pair!.served, pair!.orig, await rederiveVerdict(store, pair!.orig))];
    };
    expect(await check()).toEqual([FIRED, true]);
    await writeOfficial(store, FLIP, "RED");
    expect(await check()).toEqual([FIRED, false]); // a correction the cron never applied
    await applyRederive(store, orig);
    expect(await check()).toEqual([FIRED, true]);
    await writeOfficial(store, FLIP, "GREEN", { value: 1 });
    expect(await check()).toEqual([FIRED, false]); // the stale superseding row
  });
});

describe("re-derive evidence after the cleaners", () => {
  const superseding = (store: InMemoryStore) => store.alerts.filter((a) => a.rederivedFrom === FIRED);
  // Official readings lag on D−1; the heads on D (1 ms past fired_at) are what the dials folded.
  const headed = async (withInputs: boolean) => {
    const heads = FLIP.map((id) => row(id, "GREEN", { estimated: true }));
    const rows = ROSTER.map((id) => row(id, "GREEN", FLIP.includes(id) ? { date: PREV } : {}));
    const ri = withInputs ? { ...replayInputs(rows), heads: heads.map(({ estimated: _e, ...h }) => ({ ...h, decision: null, bandCuts: null })) } : undefined;
    const s = await seed([], { lagged: FLIP, ...(ri !== undefined ? { runInputs: ri } : {}) });
    await s.store.recordAlert(prevRow);
    await s.store.recordReadings(heads, STAMP);
    await writeOfficial(s.store, FLIP, "RED");
    return s;
  };
  // What the next EOD cleaner (or a later run's estimate dedupe) does to a non-alert run_at's estimates.
  const sweepHeads = async (store: InMemoryStore) => {
    for (const id of FLIP) await store.deleteEstimatesOnDates(id, [D]);
    expect(await store.getReadingsForRun(STAMP)).toEqual([]);
  };
  const probe = async (store: InMemoryStore, orig: AlertRecord) => {
    const out = await rederiveRun(store, orig);
    if (out.kind === "unverifiable") return "unverifiable";
    const [pair] = await servedWithOriginals(store, 5);
    return servedMatches(pair!.served, pair!.orig, out.kind === "superseded" ? out.alert : null) ? "match" : "mismatch";
  };

  test("heads stored in run_inputs: the superseding row still verifies after its heads' rows are swept", async () => {
    const { store, orig } = await headed(true);
    expect((await applyRederive(store, orig)).row?.rederivedFrom).toBe(FIRED);
    await sweepHeads(store);
    expect(await probe(store, orig)).toBe("match");
    expect((await applyRederive(store, orig)).row?.rederivedFrom).toBe(FIRED);
    expect(superseding(store)).toHaveLength(1);
  });

  test("no run_inputs and the heads swept: unverifiable — the probe reports it, apply never deletes the superseding row", async () => {
    const { store, orig } = await headed(false);
    const [row] = [(await applyRederive(store, orig)).row];
    expect(row?.rederivedFrom).toBe(FIRED);
    await sweepHeads(store);
    expect(await probe(store, orig)).toBe("unverifiable");
    const out = await applyRederive(store, orig);
    expect([out.row, out.removed, typeof out.unverifiable]).toEqual([null, 0, "string"]);
    expect(superseding(store)).toEqual([row]);
    expect(await store.getReadingsForRun(supersedingFiredAt(FIRED))).toHaveLength(ROSTER.length);
  });

  test("a run_inputs ref deleted by deleteRederived falls back to the row served for its fired-date", async () => {
    const heldPrev = alert({ ...prevRow, level: "CRITICAL", dialBand: "CRITICAL" });
    const prevSup = alert({ ...heldPrev, firedAt: supersedingFiredAt(heldPrev.firedAt), rederivedFrom: heldPrev.firedAt });
    const ri = { ...replayInputs(ROSTER.map((id) => row(id, "GREEN", FLIP.includes(id) ? { estimated: true } : {}))), refs: { last: heldPrev.firedAt, prevDay: prevSup.firedAt, lastPush: null } };
    const { store, orig } = await seed(FLIP, { runInputs: ri });
    await store.recordAlert(heldPrev);
    await store.recordAlert(prevSup);
    expect(await store.deleteRederived(heldPrev.firedAt)).toBe(1);
    await writeOfficial(store, FLIP, "RED");
    const out = await rederiveVerdict(store, orig);
    // The prev-day CRITICAL dial band holds the level: the fallback row is the served original.
    expect([out?.level, ALERT_RANK[out!.dialBand!] < ALERT_RANK.CRITICAL]).toEqual(["CRITICAL", true]);
  });

  test("a row without run_inputs replays the prev-day row and dial-band tail, not a reset", async () => {
    const { store, orig } = await seed(FLIP);
    await store.recordAlert(alert({ ...prevRow, level: "CRITICAL", dialBand: "CRITICAL" }));
    await writeOfficial(store, FLIP, "RED");
    const out = await rederiveVerdict(store, orig);
    expect([out?.level, ALERT_RANK[out!.dialBand!] < ALERT_RANK.CRITICAL]).toEqual(["CRITICAL", true]);
  });
});
