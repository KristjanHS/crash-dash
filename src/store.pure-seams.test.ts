import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test } from "vitest";
import { SupabaseStore, getStore, POSTGREST_MAX_ROWS, SERIES_BULK_MAX_IDS_PER_CALL, SERIES_BULK_CONCURRENCY, type SeriesPoint, type Store } from "./store.js";
import { assertNotTruncated, bucketShortfallIds, chunk, paginateRows } from "./store-guards.js";
import { alertRow, rowToAlert, encodeCissHistory, decodeCissHistory, ALERT_COLUMNS, ALERT_COLUMNS_WITH_PANEL } from "./store-rows.js";
import type { PersistedPanel } from "./dial-assembly.js";
import { makeDial } from "./test-helpers.js";
import { regimeToBand } from "./alert-band.js";
import { alert } from "./store.test-helpers.js";

// --- max_rows truncation cliff (rank 15): pagination + sentinel ---------------
//
// DB-free unit tests of the two mechanisms that make SupabaseStore's deep reads
// complete/honest past the PostgREST `[api] max_rows` wire cap. `paginateRows` and
// `assertNotTruncated` are the exported seams both halves are built on; a real DB isn't
// needed to prove the stitch loop and the cap-hit fingerprint fire correctly.
describe("paginateRows - stitches a deep read across pages past the wire cap", () => {
  test("collects EVERY row when the source exceeds the page size (short page ends it)", async () => {
    // 12 rows, page size 5 → pages of 5,5,2; the < count short page (2 < 5) stops the loop.
    const source = Array.from({ length: 12 }, (_, i) => i);
    const calls: Array<[number, number]> = [];
    const rows = await paginateRows(
      async (offset, count) => {
        calls.push([offset, count]);
        return source.slice(offset, offset + count);
      },
      Infinity, // "unbounded" want — take all the source has
      5,
    );
    expect(rows).toEqual(source); // all 12 stitched back, in order — no cap truncation
    expect(calls).toEqual([
      [0, 5],
      [5, 5],
      [10, 5],
    ]);
  });

  test("stops at `want` even when the source has more (bounded deep read)", async () => {
    const source = Array.from({ length: 100 }, (_, i) => i);
    const rows = await paginateRows(async (offset, count) => source.slice(offset, offset + count), 7, 3);
    expect(rows).toEqual([0, 1, 2, 3, 4, 5, 6]); // exactly `want`, across pages of 3
  });

  test("an exactly-full final page still ends via the next empty page", async () => {
    // 6 rows, page size 3 → pages 3,3,then a 0-length page (< count) breaks. Guards the
    // off-by-one where a full last page would otherwise loop forever / skip the stop.
    const source = [0, 1, 2, 3, 4, 5];
    const rows = await paginateRows(async (offset, count) => source.slice(offset, offset + count), Infinity, 3);
    expect(rows).toEqual(source);
  });
});

describe("assertNotTruncated - loud throw on a silent max_rows truncation", () => {
  test("throws when an UNREQUESTED read comes back exactly at the cap", () => {
    // Unbounded read (requestedLimit undefined) returning exactly max_rows = the truncation
    // fingerprint. Must throw, naming the query, not return a silently-short result.
    expect(() => assertNotTruncated(POSTGREST_MAX_ROWS, "getAlertsSince(alert_log)")).toThrow(
      /getAlertsSince\(alert_log\).*max_rows/s,
    );
  });

  test("does NOT throw when the caller legitimately requested exactly the cap", () => {
    // A bounded read that asked for exactly POSTGREST_MAX_ROWS rows and got them is complete,
    // not truncated — the sentinel must stay silent.
    expect(() => assertNotTruncated(POSTGREST_MAX_ROWS, "getRecentAlerts(alert_log)", POSTGREST_MAX_ROWS)).not.toThrow();
  });

  // The case `getLegPillarSeries` now relies on (W4 4.3 review, I2): its read is bounded
  // server-side by `.limit(n)`, so "came back at the cap" can no longer mean "an unbounded read
  // was cut". The surviving silent-cut class is a caller asking for MORE than `max_rows` — the
  // wire cap wins over `.limit()` and the response is short with no error. This is the assertion
  // that keeps that guard able to FIRE rather than decorative.
  test("throws when the caller requested MORE than the cap and got exactly the cap", () => {
    expect(() =>
      assertNotTruncated(POSTGREST_MAX_ROWS, "getLegPillarSeries(leg_pillars)", POSTGREST_MAX_ROWS + 1),
    ).toThrow(/getLegPillarSeries\(leg_pillars\).*max_rows/s);
  });

  test("does NOT throw below the cap (the common case)", () => {
    expect(() => assertNotTruncated(POSTGREST_MAX_ROWS - 1, "getReadingsForRun(readings)")).not.toThrow();
    expect(() => assertNotTruncated(42, "getRecentAlerts(alert_log)", 500)).not.toThrow();
  });
});

// --- getSeriesBulk shortfall decision (rank: fail-toward-calm) -----------------
//
// The pure predicate behind the sparse-cadence re-fetch: which ids came back below `limit`
// after the SupabaseStore's global-window bucketing. DB-free — the full heuristic path is
// exercised by store.contract.test.ts's sparse-cadence repair test; this pins the decision itself.
describe("bucketShortfallIds - flags ids whose global-window bucket is below limit", () => {
  const pt = (date: string): SeriesPoint => ({ date, value: 1, delta20: 0, rawState: "GREEN", state: "GREEN", decision: null });
  const buckets = new Map<string, SeriesPoint[]>([
    ["DENSE", [pt("a"), pt("b"), pt("c")]],
    ["SPARSE", [pt("a")]],
    ["EMPTY", []],
  ]);

  test("returns only short ids (bucket < limit), preserving input order; absent id counts as 0", () => {
    expect(bucketShortfallIds(["DENSE", "SPARSE", "EMPTY", "ABSENT"], buckets, 3)).toEqual(["SPARSE", "EMPTY", "ABSENT"]);
  });
});

describe("chunk - splits an `.in()` list into IN_LIST_CHUNK-sized requests", () => {
  test.each([
    [0, []],
    [1, [1]],
    [200, [200]],
    [201, [200, 1]],
    [4688, [...Array<number>(23).fill(200), 88]],
  ])("%i values -> chunk sizes %j, order and contents preserved", (n, sizes) => {
    const xs = Array.from({ length: n }, (_, i) => i);
    const parts = chunk(xs);
    expect(parts.map((p) => p.length)).toEqual(sizes);
    expect(parts.flat()).toEqual(xs);
  });
});

// The cron's member-history read (49 ids × 105 rows) walked 98 serial per-id reads past the wire cap and timed the run out (2026-10-19).
describe("getSeriesBulk - over the wire cap it chunks the RPC, never per-id reads", () => {
  test("ids × limit just past the cap: every chunk fits the cap, ids partition in order, zero per-id reads", async () => {
    const limit = 105;
    expect(Math.floor(POSTGREST_MAX_ROWS / limit)).toBeGreaterThan(1);
    const ids = Array.from({ length: Math.floor(POSTGREST_MAX_ROWS / limit) + 2 }, (_, i) => `ID${i}`);
    const rpcIds: string[][] = [];
    const client = {
      rpc: (_name: string, args: { p_ids: string[]; p_limit: number }) => {
        rpcIds.push(args.p_ids);
        const data = args.p_ids.flatMap((id) =>
          Array.from({ length: args.p_limit }, (_, d) => ({ indicator_id: id, obs_date: `2026-01-${String(d).padStart(3, "0")}`, value: d, delta20: 0, raw_state: "GREEN", state: "GREEN" })),
        );
        return Promise.resolve({ data, error: null });
      },
      from: () => {
        throw new Error("per-id getSeries read");
      },
    };
    const store = new SupabaseStore("http://127.0.0.1:1", "unused-key");
    (store as unknown as { client: unknown }).client = client;

    const out = await store.getSeriesBulk(ids, { limit });
    expect(rpcIds.length).toBeGreaterThan(1);
    expect(rpcIds.every((c) => c.length * limit <= POSTGREST_MAX_ROWS && c.length <= SERIES_BULK_MAX_IDS_PER_CALL)).toBe(true);
    expect(rpcIds.flat()).toEqual(ids);
    expect(ids.every((id) => out.get(id)?.length === limit)).toBe(true);
  });

  test("161 ids: at most SERIES_BULK_CONCURRENCY chunk RPCs in flight", async () => {
    const ids = Array.from({ length: 161 }, (_, i) => `ID${i}`);
    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    const client = {
      rpc: async (_name: string, args: { p_ids: string[]; p_limit: number }) => {
        calls++;
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        // Full buckets, so the shortfall repair takes no per-id read.
        const data = args.p_ids.flatMap((id) =>
          Array.from({ length: args.p_limit }, (_, d) => ({ indicator_id: id, obs_date: `2026-01-${String(d).padStart(3, "0")}`, value: d, delta20: 0, raw_state: "GREEN", state: "GREEN" })),
        );
        return { data, error: null };
      },
    };
    const store = new SupabaseStore("http://127.0.0.1:1", "unused-key");
    (store as unknown as { client: unknown }).client = client;
    await store.getSeriesBulk(ids, { limit: 31 });
    expect(calls).toBeGreaterThan(SERIES_BULK_CONCURRENCY);
    expect(peak).toBeLessThanOrEqual(SERIES_BULK_CONCURRENCY);
  });
});

// The ECY restate's open-month clear: the DB contract test pins it CI-only, this pins the
// Supabase query shape locally — non-estimate read, instant-compared alert pin, delete by id.
describe("SupabaseStore.deleteNonEstimatesOnDates(…, pinAlertRuns) - spares an alert run's row (no DB)", () => {
  test("reads estimated=false rows only, spares the row whose run_at is a fired_at (Z vs +00:00), deletes the rest by id", async () => {
    const calls: Array<{ table: string; op: string; filters: Array<[string, string, unknown]> }> = [];
    const readings = [
      { id: 1, run_at: "2026-10-02T21:00:00.000Z" }, // an alert run's row → pinned
      { id: 2, run_at: "2026-10-02T22:00:00.000Z" },
      { id: 3, run_at: "2026-10-03T22:00:00.000Z" },
    ];
    const client = {
      from: (table: string) => {
        const call = { table, op: "", filters: [] as Array<[string, string, unknown]> };
        calls.push(call);
        const q = {
          select: () => ((call.op = "select"), q),
          delete: () => ((call.op = "delete"), q),
          eq: (col: string, v: unknown) => (call.filters.push(["eq", col, v]), q),
          in: (col: string, v: unknown) => (call.filters.push(["in", col, v]), q),
          then: (resolve: (r: unknown) => void) => {
            if (call.op === "delete") resolve({ count: (call.filters.find(([op, col]) => op === "in" && col === "id")![2] as number[]).length, error: null });
            else if (table === "alert_log") resolve({ data: [{ fired_at: "2026-10-02T21:00:00+00:00" }], error: null });
            else resolve({ data: readings, error: null });
          },
        };
        return q;
      },
    };
    const store = new SupabaseStore("http://127.0.0.1:1", "unused-key");
    (store as unknown as { client: unknown }).client = client;

    expect(await store.deleteNonEstimatesOnDates("ECY", ["2026-10-02", "2026-10-03"], true)).toBe(2);
    const [read, pins, del] = calls;
    expect(read).toMatchObject({ table: "readings", op: "select" });
    // Scoping filters too: a dropped indicator filter would delete other ids' FINAL rows — the DB test seeds only one id.
    expect(read!.filters).toEqual(expect.arrayContaining([["eq", "estimated", false], ["eq", "indicator_id", "ECY"], ["in", "obs_date", ["2026-10-02", "2026-10-03"]]]));
    expect(pins).toMatchObject({ table: "alert_log", op: "select", filters: [["in", "fired_at", readings.map((r) => r.run_at)]] });
    expect(del).toMatchObject({ table: "readings", op: "delete", filters: [["in", "id", [2, 3]]] });
    expect(calls).toHaveLength(3);
  });
});

// --- tier_state jsonb split (Stage 3): alertRow build ↔ rowToAlert unpack (no DB) ---
//
// The off-ladder tier fields moved into the tier_state jsonb column. These pin the NEW pure
// logic locally (the DB round-trip lives in the DB_TESTS storeContract, CI-only): the jsonb is
// built strip-null, unpacked back with correct types, and a value arriving as TEXT (the `->>`
// accessor's shape) still coerces to a number.
describe("alertRow ↔ rowToAlert - tier_state jsonb split", () => {
  test("round-trips the tier fields through tier_state; nulls are stripped (absent key → null)", () => {
    // Non-null across every value flavor: numbers (slowScore/vix/…), bands (slowBand/…) —
    // plus one deliberately-null tier field (bottomState).
    const a = alert({
      slowScore: 3,
      slowBand: "ELEVATED",
      bottomState: null, // stays null → its tier_state key must be ABSENT, read back null
      vix: 38.2,
      vix3m: 34.1,
      ratio: 1.12,
    });
    const row = alertRow(a);
    // The jsonb column is a stripped-null object: the null field is absent, not a literal null.
    const tier = row.tier_state as Record<string, unknown>;
    expect(tier).not.toHaveProperty("bottom_state");
    expect(tier.slow_score).toBe(3);
    // PostgREST returns the whole column decoded, so rowToAlert sees the object as-is.
    const back = rowToAlert(row);
    // Every tier field round-trips with its type intact (numbers strict-equal, not "38.2").
    expect(back.slowScore).toBe(3);
    expect(back.vix).toBe(38.2);
    expect(back.ratio).toBe(1.12);
    expect(back.slowBand).toBe("ELEVATED");
    expect(back.bottomState).toBeNull();
    // The non-tier core still round-trips unchanged.
    expect(back.level).toBe(a.level);
    expect(back.bandReason).toBe(a.bandReason);
    // `rederived_from` is written null on an original (no key read back) and round-trips on a superseding row.
    expect(row.rederived_from).toBeNull();
    expect(back).not.toHaveProperty("rederivedFrom");
    expect(rowToAlert(alertRow({ ...a, rederivedFrom: a.firedAt })).rederivedFrom).toBe(a.firedAt);
  });

  // OFF-2 — `slowMaxScore` is jsonb-only (no column, no migration), the denominator the panel
  // renders `slowScore` over. Pins alertRow's write key against rowToAlert's read AND the
  // strip-null contract, so a degraded/pre-OFF-2 row reads back null instead of a stale constant.
  test("slow_max_score round-trips through tier_state; absent ⇒ null (never a constant)", () => {
    // NOT 4 — the live denominator today. A reader that hardcoded the constant would pass a
    // 4-valued fixture and fail this one.
    const row = alertRow(alert({ slowScore: 5, slowMaxScore: 6 }));
    expect((row.tier_state as Record<string, unknown>).slow_max_score).toBe(6);
    expect(rowToAlert(row).slowMaxScore).toBe(6);
    // A degraded slow run (null) is STRIPPED, not written as a literal null, and reads back null.
    const nullRow = alertRow(alert({ slowScore: null, slowMaxScore: null }));
    expect(nullRow.tier_state as Record<string, unknown>).not.toHaveProperty("slow_max_score");
    expect(rowToAlert(nullRow).slowMaxScore).toBeNull();
  });

  // Lever 2(a) — `provisionalPushedAt` is jsonb-only (no column, no migration), the same
  // treatment as `nonLiveFamilies`. Pins alertRow's write key against rowToAlert's read AND
  // against the strip-null contract (absent key ⇒ null ⇒ "cooldown open").
  test("provisional_pushed_at round-trips through tier_state; absent ⇒ null", () => {
    const stamp = "2026-07-22T22:00:00.000Z";
    const row = alertRow(alert({ provisionalPushedAt: stamp }));
    expect((row.tier_state as Record<string, unknown>).provisional_pushed_at).toBe(stamp);
    expect(rowToAlert(row).provisionalPushedAt).toBe(stamp);
    // A null (never pushed) stamp is STRIPPED, not written as a literal null, and reads back null.
    const nullRow = alertRow(alert({ provisionalPushedAt: null }));
    expect(nullRow.tier_state as Record<string, unknown>).not.toHaveProperty("provisional_pushed_at");
    expect(rowToAlert(nullRow).provisionalPushedAt).toBeNull();
  });

  test("a legacy `degraded` event without `effect` reads back `notify`; a stored `trace` is kept", () => {
    const row = { ...alertRow(alert()), degraded: [{ scope: "[legacy] feed down", reason: "x" }, { scope: "[t] hop", reason: "y", effect: "trace" }] };
    expect(rowToAlert(row).degraded?.map((e) => e.effect)).toEqual(["notify", "trace"]);
  });

  // The exposure push's dedup baseline (2026-08-09) — jsonb-only, same treatment. The read is
  // STRUCTURALLY validated, not cast: a legacy/hand-edited row missing `rawPosture` would otherwise
  // reach the comparator as `undefined` and, on a rung-blind pair, compare `undefined` against a
  // real posture — a manufactured transition, which is the failure class the whole seam exists to
  // stop. An absent key ⇒ null ⇒ "no baseline" ⇒ a silent establish-only run.
  test("exposure_state round-trips through tier_state; absent or malformed ⇒ null", () => {
    const state = {
      posture: "Core" as const,
      rawPosture: "Full" as const,
      rungBlind: false,
      arm: { armed: false, approaching: true },
      fire: { fired: false, approaching: false },
    };
    const row = alertRow(alert({ exposureState: state }));
    expect((row.tier_state as Record<string, unknown>).exposure_state).toEqual(state);
    expect(rowToAlert(row).exposureState).toEqual(state);

    const nullRow = alertRow(alert({ exposureState: null }));
    expect(nullRow.tier_state as Record<string, unknown>).not.toHaveProperty("exposure_state");
    expect(rowToAlert(nullRow).exposureState).toBeNull();

    // Each field the comparator reads is load-bearing on its own — drop any one and the row is
    // rejected WHOLE, never half-decoded.
    for (const drop of ["posture", "rawPosture", "rungBlind", "arm", "fire"] as const) {
      const { [drop]: _dropped, ...partial } = state;
      const broken = alertRow(alert({ exposureState: partial as typeof state }));
      expect(rowToAlert(broken).exposureState).toBeNull();
    }
    // …and a key present but half-shaped (`fire` carrying ARM's latch name) is malformed too.
    const swapped = alertRow(alert({ exposureState: { ...state, fire: { armed: false, approaching: false } } as unknown as typeof state }));
    expect(rowToAlert(swapped).exposureState).toBeNull();
  });

  test("a numeric tier field arriving as TEXT (the `->>` shape) coerces to a number", () => {
    // Guards the Number() pin in tierFieldsFromRow: were the read ever switched to per-key
    // `tier_state->>'vix'` (text), the value must still land as a number, never the string "38.2".
    const back = rowToAlert({ ...alertRow(alert()), tier_state: { vix: "38.2", slow_score: "3" } });
    expect(back.vix).toBe(38.2);
    expect(back.slowScore).toBe(3);
  });

  // W5-d Stage 3.1 — the three fall-shape columns are REAL columns (not tier_state jsonb), so this
  // pins alertRow's write keys against rowToAlert's read AND against the migration's column names.
  // Values are deliberately NON-default: 'indeterminate'/null/null is what the DB default and every
  // degraded branch already produce, so a fixture using them would pass even if alertRow dropped the
  // keys entirely. PostgREST hands numerics back as TEXT on some paths, hence the string vintages.
  test("W5-d: fall_shape / fall_velocity / credit_dwell_closes round-trip through alertRow ↔ rowToAlert", () => {
    const a = alert({ fallShape: "v-shaped", fallVelocity: -0.0105, creditDwellCloses: 3 });
    const row = alertRow(a);
    expect(row["fall_shape"]).toBe("v-shaped");
    expect(row["fall_velocity"]).toBe(-0.0105);
    expect(row["credit_dwell_closes"]).toBe(3);

    const back = rowToAlert(row);
    expect(back.fallShape).toBe("v-shaped");
    expect(back.fallVelocity).toBe(-0.0105);
    expect(back.creditDwellCloses).toBe(3);

    // Text vintages coerce to numbers, never to the strings.
    const coerced = rowToAlert({ ...row, fall_velocity: "-0.0105", credit_dwell_closes: "3" });
    expect(coerced.fallVelocity).toBe(-0.0105);
    expect(coerced.creditDwellCloses).toBe(3);
  });

  // Auto-geo Stage 1 — `geo_calm_streak` is a REAL nullable column. 0 is a live value (streak just
  // reset), so the fixture uses a non-zero streak and the null case is asserted separately.
  test("geo_calm_streak round-trips through alertRow ↔ rowToAlert; null and absent read back null", () => {
    const row = alertRow(alert({ geoCalmStreak: 3 }));
    expect(row["geo_calm_streak"]).toBe(3);
    expect(rowToAlert(row).geoCalmStreak).toBe(3);
    expect(rowToAlert({ ...row, geo_calm_streak: "3" }).geoCalmStreak).toBe(3);
    expect(rowToAlert({ ...row, geo_calm_streak: null }).geoCalmStreak).toBeNull();
    // An absent field (pre-Stage-1 caller) writes the column as null, not undefined.
    const { geoCalmStreak: _g, ...withoutStreak } = alert();
    expect(alertRow(withoutStreak)["geo_calm_streak"]).toBeNull();
  });

  // §7 Stage C′ — `panel_state` is a jsonb blob (the four `assembleDial` fields /api/lab consumes).
  // PostgREST returns it DECODED, so the round-trip is identity; the test pins alertRow's write key
  // against rowToAlert's read AND the migration's column name. Dropping either turns it red.
  // `cissHistory` is the ONE field that is NOT identity: it rides the column as a G/A/R string per id
  // and rehydrates to `{ state }`-only points.
  test("panel_state round-trips through alertRow ↔ rowToAlert; null and absent read back null", () => {
    const panel = {
      globalPanel: [{ key: "credit", label: "Credit", state: "GREEN", live: true, firing: false, contribution: 1, members: [{ id: "F1", label: "HY", state: "GREEN" }], absent: 0 }],
      displayPanel: [{ key: "credit", label: "Credit", state: "GREEN", live: true, firing: false, contribution: 1, members: [{ id: "F1", label: "HY", state: "GREEN" }], absent: 0 }],
      cissHistory: [{ id: "F1", history: [{ state: "GREEN" }, { state: "AMBER" }, { state: "RED" }] }, { id: "F2", history: [] }],
      heldMemberState: { F1: { severity: "calm" } },
    } as unknown as PersistedPanel;
    const row = alertRow(alert({ panelState: panel }));
    expect(row["panel_state"]).toEqual({ ...panel, cissHistory: [{ id: "F1", states: "GAR" }, { id: "F2", states: "" }] });
    // PostgREST returns the whole column decoded; rowToAlert expands the strings back to points.
    expect(rowToAlert(row).panelState).toEqual(panel);
    const nullRow = alertRow(alert({ panelState: null }));
    expect(nullRow["panel_state"]).toBeNull();
    expect(rowToAlert(nullRow).panelState).toBeNull();
    // An absent field (a pre-migration decoded row) reads back null, the DEGRADED-fallback trigger.
    expect(rowToAlert({ ...row, panel_state: null }).panelState).toBeNull();
  });

  test("E12 display_* twins round-trip; dial_band stays projected off the NOTIFY dial; narrow read omits display_panel_state", () => {
    const dial = makeDial({ rung: 2 });
    const displayDial = makeDial({ rung: 9, positionP: 0.9 });
    expect(regimeToBand(displayDial.notifyRegime)).not.toBe(regimeToBand(dial.notifyRegime)); // discriminating fixture
    const panel = {
      globalPanel: [], displayPanel: [], heldMemberState: {},
      cissHistory: [{ id: "F1", history: [{ state: "GREEN" }, { state: "RED" }] }],
    } as unknown as PersistedPanel;
    const row = alertRow(alert({ dialState: dial, displayDialState: displayDial, displayPanelState: panel }));
    expect(row["display_dial_state"]).toEqual(displayDial);
    expect(row["display_panel_state"]).toEqual({ ...panel, cissHistory: [{ id: "F1", states: "GR" }] });
    expect(row["dial_band"]).toBe(regimeToBand(dial.notifyRegime));
    const back = rowToAlert(row);
    expect(back.displayDialState).toEqual(displayDial);
    expect(back.displayPanelState).toEqual(panel);
    // Narrow projection: display dial rides ALERT_COLUMNS, display panel only the wide set.
    const narrowCols = ALERT_COLUMNS.split(",");
    expect(narrowCols).toContain("display_dial_state");
    expect(narrowCols).not.toContain("display_panel_state");
    expect(ALERT_COLUMNS_WITH_PANEL.split(",")).toContain("display_panel_state");
    const narrow = rowToAlert(Object.fromEntries(narrowCols.map((c) => [c, row[c]])));
    expect(narrow.displayDialState).toEqual(displayDial);
    expect(narrow).not.toHaveProperty("displayPanelState");
    // Legacy (pre-migration / dial-less) row: both read back null.
    const legacy = rowToAlert({ ...row, display_dial_state: null, display_panel_state: null });
    expect(legacy.displayDialState).toBeNull();
    expect(legacy.displayPanelState).toBeNull();
  });

  test("cissHistory codec: G/A/R strings round-trip to state-only points; unknown states throw both ways", () => {
    expect(decodeCissHistory([{ id: "F1", states: "RAG" }])).toEqual([{ id: "F1", history: [{ state: "RED" }, { state: "AMBER" }, { state: "GREEN" }] }]);
    expect(encodeCissHistory(decodeCissHistory([{ id: "F1", states: "RAG" }]))).toEqual([{ id: "F1", states: "RAG" }]);
    // A silent drop would shift every later close by one — both directions throw instead.
    expect(() => encodeCissHistory([{ id: "F1", history: [{ state: "BLUE" as never }] }])).toThrow(/unknown state "BLUE" on F1/);
    expect(() => decodeCissHistory([{ id: "F1", states: "GX" }])).toThrow(/unknown state char "X" on F1/);
  });

  // The narrowing is BY VALUE, not by cast — the column is free text (no DB CHECK; the enum is owned
  // by src/v-bear.ts). A stray/legacy value must read back as the today's-behaviour class, since only
  // 'v-shaped' diverges; asserting it into FallShape would let a junk row steer the overlay.
  test("W5-d: a pre-migration null and a stray fall_shape value both read back as 'indeterminate'", () => {
    const row = alertRow(alert({ fallShape: "bear", fallVelocity: -0.001, creditDwellCloses: 40 }));
    expect(rowToAlert(row).fallShape).toBe("bear"); // non-vacuity: a VALID class survives
    expect(rowToAlert({ ...row, fall_shape: null }).fallShape).toBe("indeterminate");
    expect(rowToAlert({ ...row, fall_shape: "V-SHAPED" }).fallShape).toBe("indeterminate");
    expect(rowToAlert({ ...row, fall_velocity: null }).fallVelocity).toBeNull();
    expect(rowToAlert({ ...row, credit_dwell_closes: null }).creditDwellCloses).toBeNull();
  });

  // NF-1(A) Stage 3.2 — `r4_phase` is plain `text` with no CHECK constraint, so prod rows written
  // before 2026-07-26 still carry the RETIRED `arm1`/`arm2`. The read seam narrows by VALUE to the
  // resting state: hydrating `arm2` as-is would hand `computeR4` a prior outside `R4Phase`, and
  // that prior is what the next cron run folds — a legacy row must not steer the CRITICAL floor.
  test("NF-1: a retired arm1/arm2 r4_phase hydrates to 'equity'; the live phases survive", () => {
    const row = alertRow(alert({ r4Phase: "cash", r4EntryFiredAt: "2026-07-01T00:00:00Z" }));
    expect(rowToAlert(row).r4Phase).toBe("cash"); // non-vacuity: a VALID phase survives untouched
    expect(rowToAlert({ ...row, r4_phase: "reentry" }).r4Phase).toBe("reentry");
    expect(rowToAlert({ ...row, r4_phase: "arm2" }).r4Phase).toBe("equity");
    expect(rowToAlert({ ...row, r4_phase: "arm1" }).r4Phase).toBe("equity");
    expect(rowToAlert({ ...row, r4_phase: "CASH" }).r4Phase).toBe("equity"); // case-sensitive, no fuzzy match
    // null is NOT narrowed — it means "no r4 state at all" (pre-migration / degraded run).
    expect(rowToAlert({ ...row, r4_phase: null }).r4Phase).toBeNull();
  });

  // "compute once, read once" (2026-07-21): the WHOLE assembled dial persists into `dial_state`
  // jsonb, and `dial_band`/`dial_target_rung` become PROJECTIONS of it — never independently truthful
  // once the blob is present. The dial's projected fields are DERIVED from the fixture dial here (not
  // hand-typed), per .claude/rules/testing-project.md.
  test("dial_state persists the whole dial; dial_band/dial_target_rung are PROJECTIONS of it", () => {
    const dial = makeDial({
      // rung 5.7 ⇒ dangerScore 0.5875 ⇒ targetRung 6 and BOTH regime axes "Stress" (all derived by
      // makeDial from the production functions) → regimeToBand ⇒ WARNING, not the passed OK.
      rung: 5.7,
      positionP: 0.42,
      leadingP: 0.71,
      coincidentP: 0.33,
      armed: true,
      fired: true,
      headline: "primed (credit) + fired (volatility) → Stress, rung 6",
    });
    // Pass DELIBERATELY WRONG scalars: the projection must OVERRIDE them (proving it is not a
    // passthrough of a.dialBand / a.dialTargetRung when dialState is present).
    const a = alert({ dialState: dial, dialBand: "OK", dialTargetRung: 1 });
    const row = alertRow(a);
    // The jsonb blob is the whole dial (object passed through; Supabase serializes it, like tier_state).
    expect(row.dial_state).toEqual(dial);
    // Scalars projected from the blob, overriding the wrong passed values.
    expect(row.dial_band).toBe(regimeToBand(dial.notifyRegime));
    expect(row.dial_target_rung).toBe(dial.targetRung);
    // Non-vacuity: the projection differs from the wrong scalar the fixture passed.
    expect(row.dial_band).not.toBe("OK");
    expect(row.dial_target_rung).not.toBe(1);

    const back = rowToAlert(row);
    // The whole dial survives alertRow → rowToAlert as a deep-equal identity.
    expect(back.dialState).toEqual(dial);
    // And the derived scalars read back as the projection, not the passed scalar.
    expect(back.dialBand).toBe(regimeToBand(dial.notifyRegime));
    expect(back.dialTargetRung).toBe(dial.targetRung);
  });

  test("legacy null dialState: dial_band/dial_target_rung fall back to the passed scalar", () => {
    const a = alert({ dialState: null, dialBand: "WATCH", dialTargetRung: 4 });
    const row = alertRow(a);
    expect(row.dial_state).toBeNull();
    // No blob to project from → the independently-passed scalars are written verbatim.
    expect(row.dial_band).toBe("WATCH");
    expect(row.dial_target_rung).toBe(4);

    const back = rowToAlert(row);
    expect(back.dialState).toBeNull();
    expect(back.dialBand).toBe("WATCH");
    expect(back.dialTargetRung).toBe(4);
  });

  test("Stage 2a: tier_state carries all live keys and the legacy columns are NOT written (dual-write retired)", () => {
    // Stage 2a retired the dual-write: the moved fields build ONLY the tier_state jsonb; the
    // like-named legacy columns still exist but go unwritten (NULL on new rows) until the Stage-2b
    // DROP migration removes them. This test keeps them OUT of the write path — it goes red if the
    // dual-write is reintroduced (reintroducing it, then dropping the columns in 2b, would abort the
    // ENTIRE atomic write on the next cron via record_run's unknown-key guard, 20260716180000). The
    // tier_state key set must match the migration backfill's keys MINUS the retired mode cells:
    // those 9 columns stay in the DDL (nullable, unwritten) but were dropped from the write map —
    // as was `pension_nonus_source` on 2026-09-05 (the CHSI holding leg it named was removed).
    const RETIRED_MODE_KEYS = [
      "pension_nonus_source",
      // Retired in place by J4 (server-side pension track removed 2026-09-07): these four
      // jsonb keys stay in the immutable migration's build map but no longer round-trip.
      "pension_band",
      "pension_dd",
      "pension_us_dd",
      "pension_nonus_dd",
      "mode_correction",
      "mode_bear",
      "mode_crash",
      "spx_mode_correction",
      "spx_mode_bear",
      "spx_mode_crash",
      "eafe_mode_correction",
      "eafe_mode_bear",
      "eafe_mode_crash",
    ];
    const migration = readFileSync(
      new URL("../supabase/migrations/20260716210000_alert_tier_state.sql", import.meta.url),
      "utf8",
    );
    const backfill = /jsonb_build_object\(([\s\S]*?)\)\);/.exec(migration)?.[1] ?? "";
    const declared = [...backfill.matchAll(/'([a-z0-9_]+)'/g)]
      .map((m) => m[1]!)
      .filter((k) => !RETIRED_MODE_KEYS.includes(k))
      .sort();
    expect(declared).toHaveLength(6); // the parse itself must not silently degrade to []

    // Every tier field non-null ⇒ tier_state carries all 6 live keys (nulls are stripped on write).
    const row = alertRow(
      alert({
        slowScore: 3,
        slowBand: "ELEVATED",
        bottomState: "CALM",
        vix: 38.2,
        vix3m: 34.1,
        ratio: 1.12,
      }),
    );
    const tierKeys = new Set(Object.keys(row.tier_state as Record<string, unknown>));
    expect([...tierKeys].sort()).toEqual(declared);
    // Retired write path (Stage 2a): NONE of those legacy columns appear as top-level payload keys.
    const legacyWritten = Object.keys(row).filter((k) => tierKeys.has(k));
    expect(legacyWritten).toEqual([]);
  });
});

// --- getStore selection: Supabase when creds set, else fail loud --------------

describe("getStore - env selection", () => {
  test("fails loud when either cred is unset (no silent in-memory fallback)", () => {
    expect(() => getStore("rw", {})).toThrow(/SUPABASE_URL and SUPABASE_SERVICE_KEY/);
    expect(() => getStore("rw", { SUPABASE_URL: "https://x.supabase.co" })).toThrow();
    expect(() => getStore("rw", { SUPABASE_SERVICE_KEY: "k" })).toThrow();
  });
});

// --- getStore mode: both modes on the service key; "ro" narrows the handle to a ReadStore ----
describe("getStore - read-only handle", () => {
  const base = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_KEY: "svc" } as const;
  // Records the (url, key) `getStore` hands its store factory, then builds the real store.
  const createClientCalls: Array<{ url: string; key: string }> = [];
  const make = (url: string, key: string) => {
    createClientCalls.push({ url, key });
    return new SupabaseStore(url, key);
  };

  beforeEach(() => {
    createClientCalls.length = 0;
  });

  test.each([
    ["set", { ...base, SUPABASE_ANON_KEY: "anon-key" }],
    ["unset", base],
  ])("ro + SUPABASE_ANON_KEY %s → the SERVICE key reaches createClient, no throw", (_, env) => {
    getStore("ro", env, make);
    expect(createClientCalls.map((c) => c.key)).toEqual(["svc"]);
  });

  test("ro holds every read method and NO write method (runtime, not just the type)", () => {
    const ro = getStore("ro", base, make);
    const isRead = (k: string) => /^(get|checkSchema$|maxRowsProbe$)/.test(k);
    const methods = Object.getOwnPropertyNames(SupabaseStore.prototype).filter((k) => k !== "constructor");
    const writes = methods.filter((k) => !isRead(k));
    expect(writes.length).toBeGreaterThan(0); // non-vacuous: the write set the intersection runs against
    // `in`, not Object.keys: a write inherited through a prototype chain must count too.
    expect(writes.filter((k) => k in ro)).toEqual([]);
    const reads = methods.filter(isRead);
    expect(reads.filter((k) => typeof (ro as unknown as Record<string, unknown>)[k] !== "function")).toEqual([]);
    expect((ro as unknown as Store).recordRun).toBeUndefined();
    // @ts-expect-error — a ReadStore has no write method
    void ro.recordRun;
    // @ts-expect-error — the subscriber list is not part of the read set
    void ro.listSubscriberEmails;
  });

  test("rw ignores SUPABASE_ANON_KEY - always the service key", () => {
    getStore("rw", { ...base, SUPABASE_ANON_KEY: "anon-key" }, make);
    expect(createClientCalls.at(-1)?.key).toBe("svc");
  });
});

// --- getStore write switch: a host-side rw store from the default factory consults `requireProdWrites` ----
// Every env below names PROD_WRITES (or never reaches the switch), so a developer's `.prod-writes` file cannot sway it.
describe("getStore - prod-writes switch", () => {
  const base = { SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SERVICE_KEY: "svc" } as const;

  test("rw + default factory + PROD_WRITES=off → refuses (local target too), naming the override", () => {
    expect(() => getStore("rw", { ...base, PROD_WRITES: "off" })).toThrow(
      /refusing a read-write store — prod writes are not on \(env PROD_WRITES\).*PROD_WRITES=on/,
    );
  });

  test("rw + default factory + PROD_WRITES=on → the real store", () => {
    expect(getStore("rw", { ...base, PROD_WRITES: "on" })).toBeInstanceOf(SupabaseStore);
  });

  // A deployed function carries VERCEL=1 AND a `dpl_` deployment id (prod /api/status serves one); host-side runs
  // that merely carry VERCEL — `vercel dev`, a pulled env file — have no deployment id and still hit the switch.
  test.each([
    ["VERCEL=1 alone", { VERCEL: "1" }],
    ["`vercel dev` (VERCEL=1, VERCEL_ENV=development, VERCEL_REGION=dev1)", { VERCEL: "1", VERCEL_ENV: "development", VERCEL_REGION: "dev1" }],
    ["a deployment id without VERCEL=1", { VERCEL_DEPLOYMENT_ID: "dpl_7Gw5ZMBpQA8h9GF832KGp7nwbuh3" }],
    ["VERCEL=1 + a non-deployment id", { VERCEL: "1", VERCEL_DEPLOYMENT_ID: "local" }],
  ])("rw + PROD_WRITES=off + %s → refuses (not a deployed function)", (_, markers) => {
    const env = { ...base, PROD_WRITES: "off", ...markers };
    expect(() => getStore("rw", env)).toThrow(/refusing a read-write store/);
  });

  test("rw in a deployed Vercel function (VERCEL=1 + dpl_ deployment id) → the switch is not consulted", () => {
    const env = { ...base, PROD_WRITES: "off", VERCEL: "1", VERCEL_DEPLOYMENT_ID: "dpl_7Gw5ZMBpQA8h9GF832KGp7nwbuh3" };
    expect(getStore("rw", env)).toBeInstanceOf(SupabaseStore);
  });

  // tsx never typechecks, so a stale caller can land anything in the mode slot; it must not read as "not rw ⇒ no switch".
  test.each([
    ["a string outside the union", "write"],
    ["a deps object (stale `(env, deps)` caller)", { fetch: () => undefined }],
    ["undefined", undefined],
  ])("mode = %s → throws before the store factory runs, even with PROD_WRITES=on", (_, mode) => {
    const built: string[] = [];
    const make = (url: string, key: string) => (built.push(key), new SupabaseStore(url, key));
    expect(() => getStore(mode as never, { ...base, PROD_WRITES: "on" }, make)).toThrow(/mode must be "ro" or "rw"/);
    expect(built).toEqual([]);
  });

  test("rw + injected factory → the switch is not consulted (a fake never reaches a database)", () => {
    const built: string[] = [];
    getStore("rw", { ...base, PROD_WRITES: "off" }, (url, key) => (built.push(key), new SupabaseStore(url, key)));
    expect(built).toEqual(["svc"]);
  });

  test("ro + default factory + PROD_WRITES=off → a read handle (reads never consult the switch)", () => {
    expect(typeof getStore("ro", { ...base, PROD_WRITES: "off" }).getSeries).toBe("function");
  });
});
