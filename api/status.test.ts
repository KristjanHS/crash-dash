/**
 * Tests for GET /api/status (api/status.ts) — display-card readings + internal-series isolation.
 *
 * As of the all-indicators-cards overlay (2026-07-22), /status SERVES the SLOW/PENSION/BOTTOM
 * readings so the Dashboard's display cards render a live value; it strips only TRULY-internal
 * series (SB_, CMP_ prefixes) that must never surface as a card. The PENSION legs
 * ride the SAME atomic record_run as the fast readings (shared run_at), so getReadingsForRun
 * returns them — and now they must PASS through to the panel. An SB_ scoreboard row (same run)
 * must still be filtered (it is read only via /api/lab's `scoreboard` view).
 *
 * The handler takes an optional injected store (rung 8a); we hand it a pre-seeded
 * InMemoryStore directly.
 */
import { beforeAll, describe, expect, test } from "vitest";

import { InMemoryStore } from "../src/store-memory.js";
import type { StoredReading } from "../src/store.js";
import { makeAlert, makeStoredReading } from "../src/test-helpers.js";
import { priceLegReadingSeries } from "../src/pension.js";
import type { Observation } from "../src/domain-types.js";
import type { StatusResponse } from "../src/api/types.js";
import { CARD_ONLY_GROUPS } from "../src/families.js";

const store = new InMemoryStore();

const { handle, redactStatus, statusBody } = await import("./status.js");
// No test here asserts freshness (`api/status-freshness.test.ts` owns it) — skip the stamp's store reads.
const noFreshness = async () => undefined;
const get = () => handle(() => store, undefined, { env: {}, freshness: noFreshness });
type Seams = Parameters<typeof statusBody>[1];
/** The FULL body (`statusBody`, before `handle`'s response rule redacts it), as a Response. */
const full = async (storeOf: () => InMemoryStore, opts: Omit<Seams, "env">): Promise<Response> => {
  const body = await statusBody(storeOf, { env: {}, ...opts }, new WeakSet());
  return body instanceof Response ? body : Response.json(body);
};
/** A request carrying a bearer token — served exactly like a plain one. */
const bearer = (): Request => new Request("https://x/api/status", { headers: { authorization: "Bearer t" } });
const getFull = () => full(() => store, { freshness: noFreshness });
const getBearer = () => handle(() => store, bearer(), { env: {}, freshness: noFreshness });

const RUN_AT = "2026-06-25T21:00:00.000Z";

// A minimal alert whose firedAt === the run's run_at: /status reads getLastAlert() then
// getReadingsForRun(verdict.firedAt), so the alert is the commit point that surfaces the
// run's readings. Seeded with a NON-NULL panelState (P-1): the store holds a panel, so the
// "no panelState on the wire" falsifier below can red if the narrow read ever regresses to wide.
const PANEL_FIXTURE = { globalPanel: [], displayPanel: [], cissHistory: [], heldMemberState: {} };
const alert = makeAlert({ panelState: PANEL_FIXTURE });

// One fast reading (F1) + the three PENSION legs, all sharing RUN_AT via one atomic run.
const f1: StoredReading = makeStoredReading("F1", { value: 4.2, delta20: 0.3 });
const obs: Observation[] = [
  { date: "2026-06-24", value: 100 },
  { date: "2026-06-25", value: 101 },
];
const pensionRows: StoredReading[] = [
  ...priceLegReadingSeries("SPY", obs),
  ...priceLegReadingSeries("DEXUSEU", obs),
  ...priceLegReadingSeries("SP500IT", obs),
];
// A BOTTOM VIX leg rides the same builder (priceLegReadingSeries, via tracks.ts) → hardcoded-GREEN
// placeholder, so it must also be served value-only.
const bottomRows: StoredReading[] = priceLegReadingSeries("VIX", obs);
// DB_SMH is GENUINELY scored (in INDICATORS, B5 confirmer) — its state is real, so it must NOT be
// value-only. Seeded with a non-GREEN state so a false valueOnly (or a neutral detail ribbon) would be a lie.
const dbSmhRow: StoredReading = makeStoredReading("DB_SMH", {
  value: -0.08,
  delta20: -0.02,
  rawState: "AMBER",
  state: "AMBER",
});
// A scoreboard NAV row rides the same atomic run — it must STILL be filtered (internal series,
// read only via /api/lab's `scoreboard` view, never as a Dashboard card).
const sbRow: StoredReading = makeStoredReading("SB_STRAT", { value: 100 });
// F7 / CAPE — a FULL trailing window (VAL_Z_WINDOW + pad monthly obs) so computeCapeValuation does
// not degrade; written on a SEPARATE run_at (mirrors the cron backfill), so /status must bridge its
// value read-time (getReadingsForRun for THIS run never returns it). Anchored to the CURRENT month
// (newest obs ≤ ~31d old) so the read stays inside VAL_MAX_STALE_DAYS (60) whenever the suite runs.
const CAPE_N = 400;
const nowMonth = new Date();
const capeRows: StoredReading[] = Array.from({ length: CAPE_N }, (_, i) => {
  const monthsBack = CAPE_N - 1 - i; // i=CAPE_N-1 → this month (newest); i=0 → oldest
  const d = new Date(Date.UTC(nowMonth.getUTCFullYear(), nowMonth.getUTCMonth() - monthsBack, 1));
  return makeStoredReading("F7", { date: d.toISOString().slice(0, 10), value: 20 + i * 0.05 });
});
await store.recordReadings(capeRows, "2026-06-24T21:00:00.000Z");

// ETFs-group return20d: XDEV rides the run with 21 closes; LEGP_EUFIN + VGK sit on a distinct run_at (as on prod).
const closes21 = (base: number): Observation[] =>
  Array.from({ length: 21 }, (_, i) => ({ date: `2026-06-${String(5 + i).padStart(2, "0")}`, value: base + i }));
const xdevRows = priceLegReadingSeries("XDEV", closes21(200));
// Every card-seated LEGP_* leg (LEGP_EUFIN at base 50, the rest at 60) — seedLegClosesOnCron's off-run rows.
const LEGP_CARD_IDS = CARD_ONLY_GROUPS.find((g) => g.key === "pension-drawdown")!.ids.filter((id) => id.startsWith("LEGP_"));
await store.recordReadings(
  [
    ...LEGP_CARD_IDS.flatMap((id) => priceLegReadingSeries(id, closes21(id === "LEGP_EUFIN" ? 50 : 60))),
    ...priceLegReadingSeries("VGK", closes21(80)),
  ],
  "2026-06-25T21:30:00.000Z",
);
await store.recordReadings(priceLegReadingSeries("VWO", closes21(40)), "2026-06-25T15:00:00.000Z"); // intraday head

await store.recordRun([f1, ...pensionRows, ...bottomRows, ...xdevRows, dbSmhRow, sbRow], RUN_AT, alert);

// Licensed-level gate: its own store, so the verdict can carry VIX levels.
const licStore = new InMemoryStore();
await licStore.recordRun(
  [makeStoredReading("F1", { value: 4.2, delta20: 0.3 }), makeStoredReading("R1", { value: 1.5, delta20: 0.1 })],
  RUN_AT,
  makeAlert({ vix: 18.5, vix3m: 20.1, ratio: 0.92, fallVelocity: -0.4 }),
);
const getLic = (req?: Request) => handle(() => licStore, req, { env: {}, freshness: noFreshness });

describe("GET /api/status - licensed values withheld from every body", () => {
  test("served (with or without a bearer): F1 + verdict vix/vix3m null; R1 + ratio kept", async () => {
    for (const res of [await getLic(), await getLic(bearer())]) {
      const body = (await res.json()) as StatusResponse;
      const byId = new Map(body.readings.map((r) => [r.indicatorId, r]));
      expect(byId.get("F1")).toMatchObject({ value: null, delta20: null, state: "GREEN" });
      expect(byId.get("R1")).toMatchObject({ value: 1.5, delta20: 0.1 });
      expect(body.verdict).toMatchObject({ vix: null, vix3m: null, fallVelocity: null, ratio: 0.92 });
    }
  });

  test("the full body (`statusBody`) carries F1 + verdict vix/vix3m — the fixture the redaction above bites on", async () => {
    const res = await full(() => licStore, { freshness: noFreshness });
    const body = (await res.json()) as StatusResponse;
    expect(body.readings.find((r) => r.indicatorId === "F1")).toMatchObject({ value: 4.2, delta20: 0.3 });
    expect(body.verdict).toMatchObject({ vix: 18.5, vix3m: 20.1, fallVelocity: -0.4, ratio: 0.92 });
  });
});

// The three distinct /status bodies the display tests read, each computed ONCE.
type Got = {
  status: number;
  cache: string | null;
  raw: string;
  body: StatusResponse;
  byId: Map<string, StatusResponse["readings"][number]>;
};
const got = async (res: Response): Promise<Got> => {
  const raw = await res.text();
  const body = JSON.parse(raw) as StatusResponse;
  const byId = new Map(body.readings.map((r) => [r.indicatorId, r]));
  return { status: res.status, cache: res.headers.get("Cache-Control"), raw, body, byId };
};
let served: Got, fullBody: Got, rejected: Got;
beforeAll(async () => {
  [served, fullBody, rejected] = await Promise.all([
    get().then(got),
    getFull().then(got),
    getBearer().then(got),
  ]);
});

describe("GET /api/status - display readings + internal-series isolation", () => {
  test("public response: F1 + SPY/DEXUSEU served, SB_ stripped; placeholder legs valueOnly, NOT scored DB_SMH; no panelState key", async () => {
    expect(served.status).toBe(200);
    const ids = served.body.readings.map((r) => r.indicatorId);
    const byId = served.byId;
    // Sanity: the seed wired a non-null verdict reading the run's readings.
    expect(ids).toContain("F1");
    // Display cards: the PENSION legs persisted in the same run must now be SERVED (they back the
    // Dashboard "Pension drawdown" cards' values).
    for (const leg of ["SPY", "DEXUSEU"]) {
      expect(ids).toContain(leg);
    }
    // Internal series: the scoreboard NAV row must NOT leak into the panel.
    expect(ids).not.toContain("SB_STRAT");

    // Pension + bottom legs carry a hardcoded-GREEN placeholder no scorer reads → value-only, so the FE
    // suppresses their false-calm RAG dot + green detail ribbon. (Red-demo: drop the api/status.ts
    // PLACEHOLDER_STATE_IDS guard and these flip undefined.)
    expect(byId.get("SPY")?.valueOnly, "SPY is value-only").toBe(true);
    expect(byId.get("SP500IT")?.valueOnly, "SP500IT is value-only").toBe(true);
    expect(byId.get("VIX")?.valueOnly, "VIX is value-only").toBe(true);
    // DB_SMH is genuinely scored — its AMBER dot is real, so valueOnly must be ABSENT (never suppressed).
    // (Red-demo: add "DB_SMH" to PLACEHOLDER_STATE_IDS and this asserts undefined but reads true.)
    expect(byId.get("DB_SMH"), "DB_SMH served").toBeDefined();
    expect(byId.get("DB_SMH")?.valueOnly, "scored DB_SMH is NOT value-only").toBeUndefined();
    expect(byId.get("DB_SMH")?.state, "scored DB_SMH keeps its real state").toBe("AMBER");

    // P-1 FALSIFIER: /status must ship NO `panelState` key — not `panelState:null`, absent entirely.
    // The seeded verdict HOLDS a non-null panel (PANEL_FIXTURE), so this reds if the narrow read ever
    // regresses to wide. Red demo: pass `{ withPanel: true }` to getLastAlert in api/status.ts (or drop
    // the strip in InMemoryStore.getLastAlert) ⇒ the key reappears on the wire and both asserts fail.
    expect(served.raw.includes('"panelState"')).toBe(false);
    // Vacuity anchor: the fixture really does hold a panel, so the absence above is a strip, not an
    // empty store — a wide read WOULD have emitted the key.
    expect(await store.getLastAlert({ withPanel: true })).toHaveProperty("panelState");
  });

  test("full body: ETFs cards carry return20d off the stored closes; off-run ids (every card-seated LEGP_*) bridged at their real head; <21 rows ⇒ absent", () => {
    const byId = fullBody.byId;
    expect(byId.get("XDEV")?.return20d).toBeCloseTo(220 / 200 - 1, 12);
    expect(byId.get("LEGP_EUFIN")).toMatchObject({ value: 70, valueOnly: true, date: "2026-06-25" });
    expect(Number.isFinite(byId.get("LEGP_EUFIN")?.delta20)).toBe(true);
    expect(byId.get("LEGP_EUFIN")?.return20d).toBeCloseTo(70 / 50 - 1, 12);
    expect(byId.get("VGK")).toMatchObject({ value: 100, valueOnly: true, return20d: 100 / 80 - 1 });
    expect(byId.get("VGK")?.provisional).toBeUndefined();
    expect(byId.get("VWO")?.provisional, "an intraday bridged head reads INTRADAY").toBe(true);
    expect(byId.get("SPY")?.return20d).toBeUndefined();
    expect(byId.get("SPY")?.value, "a PENSION run row serves its stored close (obs 2026-06-25)").toBe(101);
    // Every card-seated LEGP_* leg reaches /status through the ETF-card bridge with its return20d.
    expect(LEGP_CARD_IDS).toContain("LEGP_SEMIS");
    for (const id of LEGP_CARD_IDS.filter((id) => id !== "LEGP_EUFIN"))
      expect(byId.get(id)?.return20d, id).toBeCloseTo(80 / 60 - 1, 12);
  });

  test("R7a served (with or without a bearer): PENSION + ETFs-card value/delta20/return20d null, vintage-cached", () => {
    for (const [g, cache] of [
      [served, "s-maxage=86400, stale-while-revalidate=86400"],
      [rejected, "s-maxage=86400, stale-while-revalidate=86400"],
    ] as const) {
      expect(g.cache).toBe(cache);
      for (const id of ["SPY", "DEXUSEU", "XDEV", "LEGP_EUFIN", "VGK"]) {
        expect(g.byId.get(id), id).toMatchObject({ value: null, delta20: null });
      }
      for (const id of ["XDEV", "LEGP_EUFIN", "VGK"]) expect(g.byId.get(id)?.return20d, id).toBeNull();
      // CAPE (F7): value + delta20 redacted in the served body, the state kept as the full body has it.
      expect(g.byId.get("F7"), "F7").toMatchObject({ value: null, delta20: null, state: fullBody.byId.get("F7")!.state });
    }
    expect(Number.isFinite(fullBody.byId.get("F7")?.value), "the full body keeps the CAPE value").toBe(true);
  });

  test("`auth` is an unknown param ⇒ 400 no-store", async () => {
    const res = await handle(() => store, new Request("https://x/api/status?auth=1"), { env: {} });
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  // The per-id assertions above can only reach ids the fixture SERVES, so a context leg whose feed
  // is not wired yet would sit unguarded. This one is source-level and derived from FAMILY_OF: a
  // `"context"` id is unscored by construction (`thresholds: {}`), so its GREEN is always a
  // placeholder and MUST be suppressed on the FE.
  // Red-demo verified 2026-08-05: dropping "F7" from PLACEHOLDER_STATE_IDS reds this line.
  test("every context-tagged id is a placeholder-state id (no false Green can be served)", async () => {
    const { PLACEHOLDER_STATE_IDS } = await import("./status.js");
    const { FAMILY_OF } = await import("../src/family-descriptor-rows.js");
    const contextIds = Object.entries(FAMILY_OF)
      .filter(([, tag]) => tag === "context")
      .map(([id]) => id);
    // Vacuity anchor: the tag must actually be in use — an emptied FAMILY_OF would pass silently.
    // Floor is 1 since PMKT's removal (2026-08-05) left F7 the only `"context"` id.
    expect(contextIds.length).toBeGreaterThan(0);
    expect(contextIds.filter((id) => !PLACEHOLDER_STATE_IDS.has(id))).toEqual([]);
  });

  // Same class, the PENSION channel: every value-ladder / pension input is unscored (`thresholds: {}`), so its
  // stored GREEN is a placeholder — a newly registered input must not paint a calm dot + ribbon on /api/series.
  test("every PENSION-channel id is a placeholder-state id", async () => {
    const { PLACEHOLDER_STATE_IDS } = await import("./status.js");
    const { ALL_INDICATORS } = await import("../src/registry.js");
    const pension = ALL_INDICATORS.filter((i) => i.channel === "PENSION");
    expect(pension.some((i) => i.id === "HYNIX")).toBe(true);
    expect(pension.filter((i) => Object.keys(i.thresholds).length > 0).map((i) => i.id)).toEqual([]);
    expect(pension.filter((i) => !PLACEHOLDER_STATE_IDS.has(i.id)).map((i) => i.id)).toEqual([]);
  });

  // S-1: /status takes NO query param, so any param (`?cb=`) is a 400 no-store BEFORE the store
  // read — closing the caller-selectable cache key that guaranteed a MISS with full work behind it.
  test("an unknown query param is a 400 no-store", async () => {
    const res = await handle(() => store, new Request("https://x/api/status?cb=1"), { env: {} });
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

// Parity (redaction seam): the served body is the handler's raw body passed through `redactStatus`. The served
// body is frozen below as captured BEFORE the seam refactor, so the redact cannot drift from it.
describe("GET /api/status - served body = redactStatus(raw body)", () => {
  const parity = new InMemoryStore();
  const NOW = new Date("2026-06-26T12:00:00.000Z");
  const at = (req: Request | undefined) => handle(() => parity, req, { env: {}, now: NOW, freshness: noFreshness });
  let raw: StatusResponse, redacted: StatusResponse;
  beforeAll(async () => {
    // XDEV: 20 off-run closes + its run-row head (the in-run return20d branch); VGK: off-run only (the bridge).
    const xdev = priceLegReadingSeries("XDEV", closes21(200));
    await parity.recordReadings([...xdev.slice(0, -1), ...priceLegReadingSeries("VGK", closes21(80))], "2026-06-25T21:30:00.000Z");
    await parity.recordRun(
      [makeStoredReading("F1", { value: 4.2, delta20: 0.3 }), makeStoredReading("R1", { value: 1.5, delta20: 0.1 }), xdev.at(-1)!],
      RUN_AT,
      makeAlert({ vix: 18.5, vix3m: 20.1, ratio: 0.92, fallVelocity: -0.4 }),
    );
    [raw, redacted] = (await Promise.all([
      full(() => parity, { now: NOW, freshness: noFreshness }).then((r) => r.json()),
      at(undefined).then((r) => r.json()),
    ])) as [StatusResponse, StatusResponse];
  });

  test("redactStatus(raw) is the served body", () => {
    expect(redactStatus(raw, new Set())).toEqual(redacted); // this world carries no estimate rows
  });

  test("alertLinks = whether dashboardUrl(env) resolves; the derived boolean only, never the host", async () => {
    const linked = (await (await handle(() => parity, undefined, { env: { PROD_ALIAS: "dash.example" }, now: NOW, freshness: noFreshness })).json()) as StatusResponse;
    expect(linked.alertLinks).toBe(true);
    expect(JSON.stringify(linked)).not.toContain("dash.example");
    expect(redacted.alertLinks).toBe(false); // env {} — no PROD_ALIAS, no Vercel production url
  });

  test("the served body is unchanged across the seam refactor", () => {
    expect(raw).not.toEqual(redacted); // the world reaches the redacted regime
    expect(redacted).toMatchInlineSnapshot(`
      {
        "alertLinks": false,
        "asOf": "2026-06-25",
        "deployId": null,
        "feedAgeDays": 1,
        "lag": false,
        "readings": [
          {
            "ageDays": 1,
            "date": "2026-06-25",
            "delta20": null,
            "indicatorId": "F1",
            "label": "HY OAS",
            "lag": false,
            "rawState": "GREEN",
            "source": "run-row",
            "state": "GREEN",
            "unit": "days",
            "value": null,
          },
          {
            "ageDays": 1,
            "date": "2026-06-25",
            "delta20": 0.1,
            "indicatorId": "R1",
            "label": "10y−3m",
            "lag": false,
            "rawState": "GREEN",
            "source": "run-row",
            "state": "GREEN",
            "unit": "days",
            "value": 1.5,
          },
          {
            "ageDays": 1,
            "date": "2026-06-25",
            "delta20": null,
            "indicatorId": "XDEV",
            "label": "Value XDEV",
            "lag": false,
            "rawState": "GREEN",
            "return20d": null,
            "source": "run-row",
            "state": "GREEN",
            "unit": "days",
            "value": null,
            "valueOnly": true,
          },
          {
            "ageDays": 1,
            "date": "2026-06-25",
            "delta20": null,
            "indicatorId": "VGK",
            "label": "Dev Europe VGK",
            "lag": false,
            "rawState": "GREEN",
            "return20d": null,
            "source": "run-row",
            "state": "GREEN",
            "unit": "days",
            "value": null,
            "valueOnly": true,
          },
        ],
        "verdict": {
          "bandReason": "regime",
          "bottomState": null,
          "cashOverlay": "off",
          "cashOverlayReason": null,
          "cashOverlaySince": null,
          "coincident": "GREEN",
          "creditDwellCloses": null,
          "date": "2026-06-25",
          "degraded": [],
          "dialBand": null,
          "dialState": null,
          "dialTargetRung": null,
          "displayDialState": null,
          "fallShape": "indeterminate",
          "fallVelocity": null,
          "fin": 0,
          "finReds": 0,
          "firedAt": "2026-06-25T21:00:00.000Z",
          "geoFlags": 0,
          "heldDays": 0,
          "heldSleeve": null,
          "level": "OK",
          "nonLiveFamilies": null,
          "pushError": null,
          "pushedAt": null,
          "r4EntryFiredAt": null,
          "r4Phase": null,
          "r4ReentryRung": null,
          "rate": 0,
          "ratio": 0.92,
          "reriskConfirmCount": 0,
          "slowBand": null,
          "slowMaxScore": null,
          "slowScore": null,
          "vix": null,
          "vix3m": null,
        },
      }
    `);
  });
});

// An unlicensed id whose estimate rows carry ONE licensed lead (`isLicensedEstimateId`: G1 ← CL=F): when the served
// row is such an estimate — here the EOD run's OWN row, which carries no `estimated` card label — the served body has value/delta20
// null, state kept; a print of the same class (BRENT) and a two-lead estimate (R1) stay public.
describe("GET /api/status - a licensed-lead estimate row is redacted in the served body", () => {
  const est = new InMemoryStore();
  const NOW = new Date("2026-06-26T12:00:00.000Z");
  const at = (req: Request | undefined) => handle(() => est, req, { env: {}, now: NOW, freshness: noFreshness });
  let unredacted: Map<string, StatusResponse["readings"][number]>, redacted: Map<string, StatusResponse["readings"][number]>;
  beforeAll(async () => {
    await est.recordRun(
      [
        makeStoredReading("G1", { value: 81.5, delta20: 2, state: "AMBER", rawState: "AMBER", estimated: true }),
        makeStoredReading("R1", { value: 1.5, delta20: 0.1, estimated: true }),
        makeStoredReading("BRENT", { value: 84, delta20: 1 }),
      ],
      RUN_AT,
      makeAlert(),
    );
    const byId = (b: StatusResponse) => new Map(b.readings.map((r) => [r.indicatorId, r]));
    const [r, a] = (await Promise.all([
      full(() => est, { now: NOW, freshness: noFreshness }).then((x) => x.json()),
      at(undefined).then((x) => x.json()),
    ])) as [StatusResponse, StatusResponse];
    [unredacted, redacted] = [byId(r), byId(a)];
  });

  test("public: the G1 estimate's value + delta20 null, its state kept", () => {
    expect(redacted.get("G1")).toMatchObject({ value: null, delta20: null, state: "AMBER", rawState: "AMBER" });
  });

  test("the full body keeps the G1 estimate value", () => {
    expect(unredacted.get("G1")).toMatchObject({ value: 81.5, delta20: 2 });
  });

  test("a print (BRENT) and a two-licensed-lead estimate (R1) stay public", () => {
    expect(redacted.get("BRENT")?.value).toBe(84);
    expect(redacted.get("R1")?.value).toBe(1.5);
  });
});
