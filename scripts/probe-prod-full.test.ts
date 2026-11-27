import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CADENCE_OF, compositeComponentLegIds } from "../src/feed-lag.js";
import { INPUT_SERIES } from "../src/input-series.js";
import { INTRADAY_CUTOFF_UTC_MIN } from "../src/intraday.js";
import { lagCutFor } from "../src/ladder.js";
import { isLicensedId } from "../src/licensed.js";
import { isSlotExcused } from "../src/market-closures.js";
import { ALL_INDICATORS } from "../src/registry.js";
import { releaseDelayFor } from "../src/release-delay.js";
import { provenanceDegradeEvents } from "../src/run-cycle-persist.js";
import type { AlertRecord } from "../src/store.js";
import { InMemoryStore } from "../src/store-memory.js";
import { makeAlert } from "../src/test-helpers.js";
import {
  type Check,
  type Deps,
  type Ran,
  BACKUP_MAX_RUN_AGE_MS,
  c1,
  c2,
  c3,
  c4,
  c5,
  C5_ACCEPTED_UNMEASURED,
  c6,
  c7,
  c8,
  c9,
  c10,
  c11,
  CRON_GRACE_MS,
  cronSchedules,
  INPUT_ONLY_IDS,
  INPUT_TWIN,
  INPUT_TWIN_SIBLING,
  inputSeriesFreshness,
  LADDER_MAX_RUN_AGE_MS,
  REDACTED_SERIES_ID,
  REDACTED_URLS,
  OPENAPI_PATH,
  runAll,
  VERCEL_JSON_PATH,
} from "./probe-prod-full.js";

const SHIP = "/fake/last-ship";
const SPEC = `paths:
  /obj:
    get:
      responses:
        "200":
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Obj" }
  /arr:
    get:
      parameters:
        - name: id
          in: query
          required: true
          example: F1
      responses:
        "200":
          content:
            application/json:
              schema:
                type: array
  /either:
    get:
      parameters:
        - name: mode
          in: query
          required: true
          schema: { type: string, enum: [live, past] }
      responses:
        "200":
          content:
            application/json:
              schema:
                oneOf:
                  - $ref: "#/components/schemas/Obj"
                  - { type: object, required: [other] }
  /cron/run:
    get:
      responses: {}
components:
  schemas:
    Obj:
      type: object
      required:
        [a,
         b]
`;
/** The two `/api/cron/run` schedules c4 reasons over: weekday EOD 22:00Z + the Saturday 05:00Z repair cron. */
const CRONS = (schedules = ["0 22 * * 1-5", "0 5 * * 6"]) =>
  JSON.stringify({ crons: [...schedules.map((schedule) => ({ path: "/api/cron/run", schedule })), { path: "/api/other", schedule: "@daily" }] });
const GOOD: Record<string, unknown> = { "/obj": { a: 1, b: 2 }, "/arr?id=F1": [], "/either?mode=live": { other: 1 } };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function deps(over: Partial<Deps> & { files?: Record<string, string>; ran?: Record<string, Ran> } = {}): Deps {
  const { files = {}, ran = {}, ...rest } = over;
  return {
    fetch: (url) => {
      const path = url.replace(/^https:\/\/[^/]+\/api/, "");
      return Promise.resolve(path in GOOD ? json(GOOD[path]) : json({}, 500));
    },
    run: (cmd) => Promise.resolve(ran[cmd] ?? { code: 0, stdout: "" }),
    readFile: (p) => ({ [OPENAPI_PATH]: SPEC, [VERCEL_JSON_PATH]: CRONS(), ...files })[p],
    now: () => new Date("2026-11-16T12:00:00Z"),
    lastShipPath: SHIP,
    store: () => new InMemoryStore(),
    freshness: () => Promise.resolve({ freshness: [] }),
    ...rest,
    // An `env` override keeps the alias unless it sets `PROD_ALIAS` itself (the probe has no default host).
    env: { PROD_ALIAS: "prod.example", ...rest.env },
  };
}

function storeWith(...alerts: AlertRecord[]): () => InMemoryStore {
  const mem = new InMemoryStore();
  mem.alerts.push(...alerts);
  return () => mem;
}

describe("c1 alias = last-ship", () => {
  const inspect = { npx: { code: 0, stdout: JSON.stringify({ id: "dpl_A" }) } };
  it("PASS when the inspected id equals the file", async () => {
    expect(await c1(deps({ files: { [SHIP]: "dpl_A\n" }, ran: inspect }))).toEqual({ ok: true });
  });
  it("FAIL missing-file / mismatch", async () => {
    expect(await c1(deps({ ran: inspect }))).toEqual({ ok: false, reason: "missing-file" });
    expect(await c1(deps({ files: { [SHIP]: "dpl_OLD" }, ran: inspect }))).toEqual({ ok: false, reason: "mismatch" });
  });
});

describe("c2 prod-smoke", () => {
  it("PASS iff exit 0", async () => {
    expect(await c2(deps())).toEqual({ ok: true });
    expect(await c2(deps({ ran: { npm: { code: 1, stdout: "" } } }))).toEqual({ ok: false, reason: "exit-1" });
  });
});

describe("c3 deep health", () => {
  const health = (init?: RequestInit) =>
    Promise.resolve(
      new Headers(init?.headers).get("authorization") === "Bearer s3"
        ? json({ ok: true, maxRows: 1000, maxRowsObserved: null })
        : json({ ok: true }),
    );
  it("PASS on the deep body under the bearer", async () => {
    expect(await c3(deps({ env: { CRON_SECRET: "s3" }, fetch: (_u, i) => health(i) }))).toEqual({ ok: true });
  });
  it("FAIL no-credential / shallow (bearer rejected) / http-503", async () => {
    expect(await c3(deps({ fetch: (_u, i) => health(i) }))).toEqual({ ok: false, reason: "no-credential" });
    expect(await c3(deps({ env: { CRON_SECRET: "wrong" }, fetch: (_u, i) => health(i) }))).toEqual({ ok: false, reason: "shallow" });
    expect(await c3(deps({ env: { CRON_SECRET: "s3" }, fetch: () => Promise.resolve(json({ ok: false }, 503)) }))).toEqual({ ok: false, reason: "http-503" });
  });
});

describe("c4 newest EOD row + intraday slot", () => {
  const status = (lag: boolean, firedAt: string) => (url: string) =>
    Promise.resolve(url.endsWith("/api/status") ? json({ lag, verdict: { firedAt } }) : json({}, 599));
  const at = (date: string, over: Partial<AlertRecord> = {}, lag = false, served = `${date}T22:00:00.000Z`) =>
    deps({ store: storeWith(makeAlert({ date, firedAt: `${date}T22:00:00.000Z`, ...over })), fetch: status(lag, served) });
  /** EOD row fired at `eodAt` (default Fri 2026-11-13T22:00Z) + an intraday slot fired at `slotAt`; /api/status serves `served`
   *  with heartbeat `lag`; the clock reads `now` (default Mon 2026-11-16T12:00Z). */
  const withSlot = (slotAt: string, served: string, lag = false, now = "2026-11-16T12:00:00Z", eodAt = "2026-11-13T22:00:00.000Z", files?: Record<string, string>) => {
    const mem = new InMemoryStore();
    mem.alerts.push(makeAlert({ date: eodAt.slice(0, 10), firedAt: eodAt }));
    mem.intradayVerdict = makeAlert({ date: slotAt.slice(0, 10), firedAt: slotAt });
    return deps({ store: () => mem, fetch: status(lag, served), now: () => new Date(now), files });
  };
  const hop = provenanceDegradeEvents([], [{ symbol: "SPY", from: "primary", to: "fallback", summary: "HTTP 429" }]);
  it("PASS on a fresh, feed-clean EOD row with no slot (no intraday claim)", async () => {
    expect(await c4(at("2026-11-12", { degraded: [{ scope: "[nowcast] VXNT EOD estimate row not written", reason: "x", effect: "trace" }] }))).toEqual({ ok: true });
  });
  it("PASS on a served slot fired today before the cutoff, whatever the slot-dated `lag` reads", async () => {
    expect(await c4(withSlot("2026-11-16T10:00:00.000Z", "2026-11-16T10:00:00+00:00", true))).toEqual({ ok: true });
  });
  it("a slot not newer than the EOD row makes no claim: the EOD verdict must be served", async () => {
    expect(await c4(withSlot("2026-11-13T15:00:00.000Z", "2026-11-13T22:00:00.000Z"))).toEqual({ ok: true });
    expect(await c4(withSlot("2026-11-13T15:00:00.000Z", "2026-11-13T15:00:00.000Z"))).toEqual({ ok: false, reason: "served-not-eod" });
  });
  it("PASS on the Saturday repair cron's slot still served on Monday daytime, under the fixture and the real vercel.json", async () => {
    const sat = "2026-11-14T05:00:00.000Z";
    expect(await c4(withSlot(sat, sat, false, "2026-11-16T10:00:00Z"))).toEqual({ ok: true });
    const real = readFileSync(VERCEL_JSON_PATH, "utf8");
    expect(cronSchedules(real)).toBeInstanceOf(Array);
    expect(await c4(withSlot(sat, sat, false, "2026-11-16T10:00:00Z", undefined, { [VERCEL_JSON_PATH]: real }))).toEqual({ ok: true });
  });
  it("FAIL cron-unparsed on a cron form outside `M H * * DOW`", async () => {
    const sat = "2026-11-14T05:00:00.000Z";
    expect(await c4(withSlot(sat, sat, false, "2026-11-16T10:00:00Z", undefined, { [VERCEL_JSON_PATH]: CRONS(["0 22 * * MON-FRI", "0 5 * * 6"]) }))).toEqual({ ok: false, reason: "cron-unparsed" });
  });
  it("FAIL eod-stale when a served slot hides a missed weekday EOD cron; PASS once the EOD row postdates it", async () => {
    const wed = "2026-11-18T10:00:00.000Z";
    expect(await c4(withSlot(wed, wed, false, "2026-11-18T12:00:00Z", "2026-11-16T22:00:00.000Z"))).toEqual({ ok: false, reason: "eod-stale" });
    expect(await c4(withSlot(wed, wed, false, "2026-11-18T12:00:00Z", "2026-11-17T22:30:00.000Z"))).toEqual({ ok: true });
  });
  it("a due cron instant counts only CRON_GRACE_MS after it: a slot from before Tue's 22:00 EOD cron passes inside the grace, not past it", async () => {
    const tue = "2026-11-17T10:00:00.000Z";
    const at = (ms: number) => new Date(Date.parse("2026-11-17T22:00:00Z") + CRON_GRACE_MS + ms).toISOString();
    // 22:30: the 22:00 cron is due but a Hobby cron may still be pending — inside any grace over 30 min.
    expect(CRON_GRACE_MS).toBeGreaterThan(30 * 60_000);
    expect(await c4(withSlot(tue, tue, false, "2026-11-17T22:30:00Z", "2026-11-16T22:00:00.000Z"))).toEqual({ ok: true });
    expect(await c4(withSlot(tue, tue, false, at(60_000), "2026-11-16T22:00:00.000Z"))).toEqual({ ok: false, reason: "intraday-stale" });
  });
  it("FAIL served-not-intraday / intraday-stale (a weekday slot older than the last cron; today at the cutoff)", async () => {
    expect(await c4(withSlot("2026-11-16T10:00:00.000Z", "2026-11-13T22:00:00.000Z"))).toEqual({ ok: false, reason: "served-not-intraday" });
    const tue = "2026-11-17T15:00:00.000Z";
    expect(await c4(withSlot(tue, tue, false, "2026-11-18T10:00:00Z", "2026-11-16T22:00:00.000Z"))).toEqual({ ok: false, reason: "intraday-stale" });
    const cutoff = new Date(Date.parse("2026-11-16T00:00:00Z") + INTRADAY_CUTOFF_UTC_MIN * 60_000).toISOString();
    expect(await c4(withSlot(cutoff, cutoff, false, "2026-11-16T23:00:00Z"))).toEqual({ ok: false, reason: "intraday-stale" });
  });
  it("FAIL no-store / no-alert-row / stale / served-not-eod / feed-degraded (notify, late notify, provider hop)", async () => {
    expect(await c4(deps({ store: () => { throw new Error("no key"); } }))).toEqual({ ok: false, reason: "no-store" });
    expect(await c4(deps())).toEqual({ ok: false, reason: "no-alert-row" });
    expect(await c4(at("2026-11-11", {}, true))).toEqual({ ok: false, reason: "stale" });
    expect(await c4(at("2026-11-12", {}, false, "2026-11-13T15:00:00.000Z"))).toEqual({ ok: false, reason: "served-not-eod" });
    expect(hop).toHaveLength(1);
    const traces = [hop.map((e) => ({ ...e, effect: "trace" as const })), [{ scope: "[F1] feed down", reason: "x", effect: "notify" as const }], [{ scope: "[seed]", reason: "x", effect: "trace" as const, late: "notify" as const }]];
    for (const degraded of traces) expect(await c4(at("2026-11-12", { degraded }))).toEqual({ ok: false, reason: "feed-degraded" });
  });
});

/** `n` weekday dates ending at `to` (inclusive), oldest first. */
function weekdays(to: string, n: number): string[] {
  const out: string[] = [];
  for (let t = Date.parse(to); out.length < n; t -= 86_400_000) if (![0, 6].includes(new Date(t).getUTCDay())) out.unshift(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** A store holding weekday rows per id, each ending at its newest date. */
function seriesStore(newestById: Record<string, string>, n = 30): InMemoryStore {
  const mem = new InMemoryStore();
  for (const [id, newest] of Object.entries(newestById))
    for (const date of weekdays(newest, n)) mem.readings.push({ indicatorId: id, date, value: 1, delta20: 0, rawState: "GREEN", state: "GREEN", runAt: `${date}T22:00:00.000Z` });
  return mem;
}

describe("c5 freshnessFrom roster + INPUT_SERIES", () => {
  const ids = [...CADENCE_OF.keys()];
  const legs = compositeComponentLegIds();
  const PEERS = [...CADENCE_OF].filter(([id, c]) => c === "daily" && !legs.has(id)).slice(0, 2).map(([id]) => id);
  const NOW = new Date("2026-11-16T12:00:00Z");
  /** Two daily peers 60 weekdays deep to Fri `end`, every input-only id fresh to the same day unless `over` moves it. */
  const inputs = (over: Record<string, string> = {}, end = "2026-11-13") => {
    const mem = seriesStore(Object.fromEntries(PEERS.map((id) => [id, end])), 60);
    const rest = seriesStore({ ...Object.fromEntries(INPUT_ONLY_IDS.map((id) => [id, end])), ...over });
    mem.readings.push(...rest.readings);
    return mem;
  };
  const allFresh = () => Promise.resolve({ freshness: ids.map((id) => ({ id, lag: false })) });
  it("the input-only roster is INPUT_SERIES minus the stamp roster, and the fixture has independent daily peers", () => {
    expect(INPUT_ONLY_IDS.length).toBeGreaterThan(0);
    expect(INPUT_ONLY_IDS).toEqual(INPUT_SERIES.map((s) => s.id).filter((id) => !CADENCE_OF.has(id)));
    // The peers extend the grid past a stale input id's own newest row — the lag tests below go vacuous without one.
    expect(PEERS.length).toBeGreaterThan(0);
  });
  it("PASS when every roster id reads lag false and every input-only id is fresh", async () => {
    expect(await c5(deps({ store: () => inputs(), now: () => NOW, freshness: allFresh }))).toEqual({ ok: true });
  });
  it("FAIL names a lagging and a missing input-only id (a `^` id printed SAFE_REASON-clean)", async () => {
    const mem = inputs({ "^GSPC": "2026-11-11" });
    mem.readings.splice(0, mem.readings.length, ...mem.readings.filter((r) => r.indicatorId !== "NTFS"));
    expect(await c5(deps({ store: () => mem, now: () => NOW, freshness: allFresh }))).toEqual({ ok: false, reason: "missing=NTFS/lag=_GSPC" });
  });
  /** `k` weekdays before Fri `end`: `k` grid slots behind on a holiday-free window. */
  const behind = (k: number, end = "2026-11-13"): string => weekdays(end, k + 1)[0]!;
  const CUT = lagCutFor({ cadence: "daily" });
  /** A twin-less input id: its own (zero) delay and closures apply. */
  const RAW = INPUT_ONLY_IDS.find((id) => INPUT_TWIN.get(id) === id && releaseDelayFor(id) === 0)!;
  /** A FRED input id whose registry twin carries a measured release delay. */
  const TWINNED = INPUT_SERIES.find((s) => s.feed === "fred" && INPUT_TWIN.get(s.id) !== s.id && releaseDelayFor(INPUT_TWIN.get(s.id)!) > 0)!.id;
  const DELAY = releaseDelayFor(INPUT_TWIN.get(TWINNED)!);
  it("a weekly override reads a row one slot past the daily cut fresh; the same row under the daily default lags", async () => {
    const mem = inputs({ [RAW]: behind(CUT + 1) });
    expect((await inputSeriesFreshness(mem, NOW, { [RAW]: "weekly" })).lag).toEqual([]);
    expect((await inputSeriesFreshness(mem, NOW)).lag).toEqual([RAW]);
  });
  it("delay resolves through the registry twin: fresh at delay+cut slots behind, lagging one past; a twin-less id keeps delay 0", async () => {
    // Fri 2026-11-06 → Mon 11-09: a weekday window with no US closure, so the age is the raw slot count.
    const now = new Date("2026-11-09T12:00:00Z");
    expect(RAW).toBeDefined();
    expect((await inputSeriesFreshness(inputs({ [TWINNED]: behind(DELAY + CUT, "2026-11-06") }, "2026-11-06"), now)).lag).toEqual([]);
    expect((await inputSeriesFreshness(inputs({ [TWINNED]: behind(DELAY + CUT + 1, "2026-11-06") }, "2026-11-06"), now)).lag).toEqual([TWINNED]);
    expect((await inputSeriesFreshness(inputs({ [RAW]: behind(DELAY + CUT, "2026-11-06") }, "2026-11-06"), now)).lag).toEqual([RAW]);
  });
  it("a hand-set sibling twin lends its T+1 delay: DGS3MO / AAA10Y read fresh one publication behind (prod c5, 2026-11-19)", async () => {
    const now = new Date("2026-11-09T12:00:00Z");
    for (const [id, twin] of Object.entries(INPUT_TWIN_SIBLING)) {
      const ind = ALL_INDICATORS.find((i) => i.id === twin);
      // The premise: a registry twin on the daily cut with a measured delay — else the fixture below reads fresh at delay 0 too,
      // and a wide-cut twin (lagAfterDays) would silently make the input lenient.
      expect([INPUT_ONLY_IDS.includes(id), ind !== undefined && lagCutFor(ind) === CUT, releaseDelayFor(twin) > 0]).toEqual([true, true, true]);
      expect((await inputSeriesFreshness(inputs({ [id]: behind(releaseDelayFor(twin) + CUT, "2026-11-06") }, "2026-11-06"), now)).lag).toEqual([]);
    }
  });
  it("the lag cut resolves through the registry twin: a multi-day-cut twin reads fresh where the daily cut lags", async () => {
    const cutOf = (id: string) => lagCutFor(ALL_INDICATORS.find((i) => i.id === INPUT_TWIN.get(id))!);
    const WIDE = INPUT_ONLY_IDS.find((id) => INPUT_TWIN.get(id) !== id && cutOf(id) > CUT + 1);
    expect(WIDE).toBeDefined();
    const now = new Date("2026-11-09T12:00:00Z");
    const k = releaseDelayFor(INPUT_TWIN.get(WIDE!)!) + CUT + 1;
    expect((await inputSeriesFreshness(inputs({ [WIDE!]: behind(k, "2026-11-06") }, "2026-11-06"), now)).lag).toEqual([]);
  });
  it("closure excusal resolves through the registry twin (2026-11-11, a closure of the twin's calendar, not the raw id's)", async () => {
    const twin = INPUT_TWIN.get(TWINNED)!;
    expect([isSlotExcused(twin, "2026-11-11", 0), isSlotExcused(TWINNED, "2026-11-11", 0)]).toEqual([true, false]);
    expect((await inputSeriesFreshness(inputs({ [TWINNED]: behind(DELAY + CUT + 1) }), NOW)).lag).toEqual([]);
  });
  it("FAIL lists missing, lagging and unmeasured ids; a foreign stamp id is never printed", async () => {
    const freshness = [...ids.filter((id) => id !== "LEGP_SPX").map((id) => (id === "BUND" ? { id, lag: true } : id === "BONOS" ? { id, unmeasured: true } : { id, lag: false })), { id: "FOREIGN", lag: true }];
    expect(await c5(deps({ store: () => inputs(), now: () => NOW, freshness: () => Promise.resolve({ freshness }) }))).toEqual({ ok: false, reason: "missing=LEGP_SPX/lag=BUND/unmeasured=BONOS" });
  });
  // Prod's shape (2026-11-16): an accepted id is a roster id `freshnessFrom` leaves unmeasured because it is silent on a day
  // every daily peer printed (its own exchange's holiday), so containment rejects every peer and the grid throws the
  // calendar floor. ALL daily roster ids are seeded — a zero-row peer is never charged and would prop the floor up.
  // Fri 2026-11-06 back 3 weekdays carries no closure of HYNIX's calendar, so its age is the raw weekday count.
  describe("an accepted id below the calendar floor (store-driven)", () => {
    const END = "2026-11-06";
    const now = new Date(`${END}T12:00:00Z`);
    const HOLIDAY = weekdays(END, 10)[0]!;
    const daily = [...CADENCE_OF].filter(([, c]) => c === "daily").map(([id]) => id);
    /** Every daily roster id + input-only id fresh to END; `own` ids get a one-calendar history (HOLIDAY dropped) to their date. */
    const store = (own: Record<string, string>) => {
      const mem = seriesStore(Object.fromEntries([...daily, ...INPUT_ONLY_IDS].filter((id) => !(id in own)).map((id) => [id, END])), 60);
      mem.readings.push(...seriesStore(own).readings.filter((r) => r.date !== HOLIDAY));
      return mem;
    };
    const ACC = "HYNIX";
    const K = releaseDelayFor(ACC) + lagCutFor(ALL_INDICATORS.find((i) => i.id === ACC)!);
    /** The stamp prod produces for a griddable-less id: present, `lag` undefined. */
    const stamp = (unmeasured: string) => () => Promise.resolve({ freshness: ids.map((id) => (id === unmeasured ? { id, unmeasured: true } : { id, lag: false })) });
    const run = (mem: InMemoryStore, unmeasured = ACC) => c5(deps({ store: () => mem, now: () => now, freshness: stamp(unmeasured) }));
    it("fresh at delay+cut weekdays PASSes; one weekday older FAILs lag", async () => {
      expect([Object.hasOwn(C5_ACCEPTED_UNMEASURED, ACC), CADENCE_OF.get(ACC)]).toEqual([true, "daily"]);
      expect(await run(store({ [ACC]: behind(K, END) }))).toEqual({ ok: true });
      expect(await run(store({ [ACC]: behind(K + 1, END) }))).toEqual({ ok: false, reason: `lag=${ACC}` });
    });
    it("an unaccepted unmeasured id, or an accepted id whose grid fails on anything but the floor, stays unmeasured", async () => {
      expect(Object.hasOwn(C5_ACCEPTED_UNMEASURED, "BONOS")).toBe(false);
      expect(await run(store({ BONOS: END }), "BONOS")).toEqual({ ok: false, reason: "unmeasured=BONOS" });
      const corrupt = store({ [ACC]: END });
      corrupt.readings.push({ ...corrupt.readings.find((r) => r.indicatorId === ACC)!, date: "2026-10-1x" });
      // A non-ISO row throws "non-ISO observation date", not the floor. ACC is also every input id's peer, so they go
      // unmeasured beside it — the pin is that ACC itself is never excused onto the weekday grid.
      const { reason } = (await run(corrupt)) as { reason?: string };
      expect(/^unmeasured=([^/]*)$/.exec(reason ?? "")?.[1]?.split(",")).toContain(ACC);
    });
  });
  it("the roster carries the plan's named rows", () => {
    const named = ["F1", "BUND", "BONOS", "CMP_BUND_DE10Y", "CMP_BONOS_ES10Y"];
    expect(named.filter((id) => !CADENCE_OF.has(id))).toEqual([]);
    expect(ids.filter((id) => id.startsWith("LEGP_")).length).toBeGreaterThan(0);
  });
});

describe("c6 ntfy", () => {
  const row = (day: string, over: Partial<AlertRecord>) => makeAlert({ date: day, firedAt: `${day}T22:00:00.000Z`, ...over });
  const ok = row("2026-11-13", { pushedAt: "2026-11-13T22:00:01.000Z" });
  const bad = row("2026-11-12", { pushError: "HTTP 500" });
  const ntfy = (status: number) => (url: string) => Promise.resolve(url.startsWith("https://ntfy.sh/t0p/json?poll=1") ? json({}, status) : json({}, 599));
  it("PASS when the newest attempt pushed and the topic polls 200", async () => {
    expect(await c6(deps({ env: { NTFY_TOPIC: "t0p" }, store: storeWith(bad, ok), fetch: ntfy(200) }))).toEqual({ ok: true });
  });
  it("FAIL push-error (newest attempt) / no-push-row / dev-topic / ntfy-http-404", async () => {
    const newerBad = row("2026-11-14", { pushError: "HTTP 500" });
    expect(await c6(deps({ env: { NTFY_TOPIC: "t0p" }, store: storeWith(ok, newerBad), fetch: ntfy(200) }))).toEqual({ ok: false, reason: "push-error" });
    expect(await c6(deps({ env: { NTFY_TOPIC: "t0p" }, store: storeWith(row("2026-11-13", {})), fetch: ntfy(200) }))).toEqual({ ok: false, reason: "no-push-row" });
    expect(await c6(deps({ store: storeWith(ok), fetch: ntfy(200) }))).toEqual({ ok: false, reason: "dev-topic" });
    expect(await c6(deps({ env: { NTFY_TOPIC: "t0p" }, store: storeWith(ok), fetch: ntfy(404) }))).toEqual({ ok: false, reason: "ntfy-http-404" });
  });
});

describe("c8 redacted fields", () => {
  const rosterStatusId = "F1";
  const freeId = ALL_INDICATORS.map((i) => i.id).find((id) => !isLicensedId(id));
  /** Bodies with every redacted field non-null — a broken redaction. */
  const full: Record<string, unknown> = {
    status: { readings: [{ indicatorId: rosterStatusId, value: 1.5 }, { indicatorId: freeId, value: 4 }] },
    history: [{ vix: null }, { vix: 17 }],
    series: { points: [{ value: 2 }] },
    replay: { episodes: [{ points: [{ price: null }] }, { points: [{ price: 3 }] }] },
  };
  /** The served shape (`serveRedactable`): redacted fields null, the off-roster row kept. */
  const redacted: Record<string, unknown> = {
    status: { readings: [{ indicatorId: rosterStatusId, value: null }, { indicatorId: freeId, value: 4 }] },
    history: [{ vix: null }],
    series: { points: [{ value: 2 }], redacted: true },
    replay: { episodes: [{ points: [{ price: null }] }], redacted: true },
  };
  const api = (body: (key: string) => unknown) => (url: string) => {
    const u = REDACTED_URLS.find((x) => url.endsWith(x.path));
    return Promise.resolve(u ? json(body(u.key)) : json({}, 599));
  };
  it("the fixtures' roster ids are on the roster, and an off-roster registry id exists for the visible row", () => {
    expect([rosterStatusId, REDACTED_SERIES_ID].filter((id) => !isLicensedId(id))).toEqual([]);
    expect(freeId).toBeDefined();
  });
  it("PASS when every redacting URL answers redacted", async () => {
    expect(await c8(deps({ fetch: api((k) => redacted[k]) }))).toEqual({ ok: true });
  });
  it("FAIL anon-leak per URL serving a non-null redacted field, and anon-http-<n>", async () => {
    expect(await c8(deps({ fetch: api((k) => full[k]) }))).toEqual({ ok: false, reason: REDACTED_URLS.map((u) => `${u.key}=anon-leak`).join(",") });
    expect(await c8(deps({ fetch: api((k) => (k === "history" ? full : redacted)[k]) }))).toEqual({ ok: false, reason: "history=anon-leak" });
    const http401 = REDACTED_URLS.map((u) => `${u.key}=anon-http-401`).join(",");
    expect(await c8(deps({ fetch: () => Promise.resolve(json({}, 401)) }))).toEqual({ ok: false, reason: http401 });
  });
});

describe("c9 backup + dead-man runs", () => {
  const gh = (by: Record<string, Ran>) => (_cmd: string, args: readonly string[]) => Promise.resolve(by[args.find((a) => a.startsWith("--workflow="))!] ?? { code: 1, stdout: "" });
  const ago = (ms: number) => new Date(Date.parse("2026-11-16T12:00:00Z") - ms).toISOString();
  const runs = (conclusion: string, createdAt = ago(BACKUP_MAX_RUN_AGE_MS)) => ({ code: 0, stdout: JSON.stringify([{ conclusion, status: "completed", createdAt }]) });
  it("PASS when both newest completed runs succeeded", async () => {
    expect(await c9(deps({ run: gh({ "--workflow=backup-prod-data.yml": runs("success"), "--workflow=dead-man-ping.yml": runs("success") }) }))).toEqual({ ok: true });
  });
  it("FAIL no-run / not-success / gh-failed / stale-run per workflow", async () => {
    expect(await c9(deps({ run: gh({ "--workflow=backup-prod-data.yml": runs("success", ago(BACKUP_MAX_RUN_AGE_MS + 1)), "--workflow=dead-man-ping.yml": runs("success") }) }))).toEqual({ ok: false, reason: "backup-prod-data=stale-run" });
    expect(await c9(deps({ run: gh({ "--workflow=backup-prod-data.yml": { code: 0, stdout: "[]" }, "--workflow=dead-man-ping.yml": runs("failure") }) }))).toEqual({ ok: false, reason: "backup-prod-data=no-run,dead-man-ping=not-success" });
    expect(await c9(deps({ run: gh({ "--workflow=dead-man-ping.yml": runs("success") }) }))).toEqual({ ok: false, reason: "backup-prod-data=gh-failed" });
  });
});

describe("c10 ladder unit", () => {
  const start = (ms: number) => new Date(Date.parse("2026-11-16T12:00:00Z") - ms).toISOString().replace(/^(.{10})T(.{8}).*$/, "Mon $1 $2 UTC");
  const svc = (over: Record<string, string> = {}) =>
    Object.entries({ LoadState: "loaded", Result: "success", ExecMainStatus: "0", ExecMainStartTimestamp: start(LADDER_MAX_RUN_AGE_MS - 1000), ...over }).map(([k, v]) => `${k}=${v}`).join("\n");
  const show = (service: string, timer = "ActiveState=active") =>
    deps({ run: (_cmd, args) => Promise.resolve({ code: 0, stdout: args.some((a) => a.endsWith(".timer")) ? timer : service }) });
  it("PASS when loaded, recently run, exit 0 and the timer is active", async () => {
    expect(await c10(show(svc()))).toEqual({ ok: true });
  });
  it("FAIL not-loaded / never-ran / stale-run / result-not-success / exit-nonzero / timer-inactive / show-failed", async () => {
    const cases: [Record<string, string>, string][] = [
      [{ LoadState: "not-found" }, "not-loaded"],
      [{ ExecMainStartTimestamp: "n/a" }, "never-ran"],
      [{ ExecMainStartTimestamp: start(LADDER_MAX_RUN_AGE_MS + 1000) }, "stale-run"],
      [{ Result: "exit-code" }, "result-not-success"],
      [{ ExecMainStatus: "1" }, "exit-nonzero"],
    ];
    for (const [over, reason] of cases) expect(await c10(show(svc(over)))).toEqual({ ok: false, reason });
    expect(await c10(show(svc(), "ActiveState=inactive"))).toEqual({ ok: false, reason: "timer-inactive" });
    expect(await c10(deps({ ran: { env: { code: 1, stdout: "" } } }))).toEqual({ ok: false, reason: "show-failed" });
  });
});

describe("c11 alert links resolved on the deploy", () => {
  const served = (body: unknown, status = 200) => (url: string) =>
    Promise.resolve(url === "https://prod.example/api/status" ? json(body, status) : json({}, 599));
  it("PASS iff /api/status serves alertLinks === true", async () => {
    expect(await c11(deps({ fetch: served({ alertLinks: true }) }))).toEqual({ ok: true });
    for (const body of [{ alertLinks: false }, {}, { alertLinks: "true" }]) {
      expect(await c11(deps({ fetch: served(body) }))).toEqual({ ok: false, reason: "alert-links-unresolved/set-PROD_ALIAS-or-redeploy" });
    }
    expect(await c11(deps({ fetch: served({}, 503) }))).toEqual({ ok: false, reason: "status-http-503" });
  });
  it("no PROD_ALIAS ⇒ throws (no default host), which runAll prints as FAIL threw", async () => {
    const noAlias = { PROD_ALIAS: undefined };
    await expect(c11(deps({ env: noAlias, fetch: served({ alertLinks: true }) }))).rejects.toThrow(/PROD_ALIAS/);
    expect((await runAll(deps({ env: noAlias }), [], [{ id: "c11", run: c11 }])).lines).toEqual(["FAIL c11 threw"]);
  });
});

describe("c7 openapi paths", () => {
  it("PASS when every path but /cron/run answers its required keys", async () => {
    expect(await c7(deps())).toEqual({ ok: true });
  });
  it("FAIL names missing-keys, http status and no-example per path", async () => {
    const drop = deps({ fetch: (url) => Promise.resolve(url.endsWith("/obj") ? json({ a: 1 }) : json(GOOD[url.replace(/^.*\/api/, "")])) });
    expect(await c7(drop)).toEqual({ ok: false, reason: "/obj=missing-keys" });
    const noEx = deps({ files: { [OPENAPI_PATH]: SPEC.replace("          example: F1\n", "") } });
    expect(await c7(noEx)).toEqual({ ok: false, reason: "/arr=no-example" });
    expect(await c7(deps({ files: { [OPENAPI_PATH]: `${SPEC}  /dup:\n    get: {}\n  /dup: {}\n` } }))).toEqual({ ok: false, reason: "openapi-unparsed" });
    const down = deps({ fetch: () => Promise.resolve(json({}, 503)) });
    expect(await c7(down)).toEqual({ ok: false, reason: "/obj=http-503,/arr=http-503,/either=http-503" });
  });
});

describe("runAll", () => {
  it("prints no injected secret, topic or token and exits 1 on a FAIL", async () => {
    const SECRET = "sekret-xyz";
    const leaky = deps({
      env: { CRON_SECRET: SECRET, NTFY_TOPIC: SECRET, PROD_ALIAS: "prod.example" },
      files: { [SHIP]: `${SECRET}-old` },
      ran: {
        npx: { code: 0, stdout: JSON.stringify({ id: SECRET }) },
        npm: { code: 2, stdout: SECRET },
        bash: { code: 0, stdout: SECRET },
        gh: { code: 0, stdout: JSON.stringify([{ conclusion: SECRET, status: SECRET, createdAt: SECRET }]) },
        env: { code: 0, stdout: `LoadState=${SECRET}\nResult=${SECRET}\nExecMainStatus=${SECRET}` },
      },
      fetch: () => Promise.resolve(json({ ok: SECRET, error: SECRET }, 404)),
      store: storeWith(makeAlert({ date: SECRET, pushError: SECRET, degraded: [{ scope: SECRET, reason: SECRET, effect: "notify" }] })),
      freshness: () => Promise.resolve({ freshness: [{ id: SECRET, lag: true }] }),
    });
    const thrower: Check = { id: "cx", run: () => Promise.reject(new Error(SECRET)) };
    const { lines, code } = await runAll(leaky, ["--trigger-cron"]);
    const extra = await runAll(leaky, [], [thrower]);
    expect(lines[0]).toBe("PASS trigger-cron");
    expect(lines).toContain(`FAIL c8 ${REDACTED_URLS.map((u) => `${u.key}=anon-http-404`).join(",")}`);
    expect(extra.lines).toEqual(["FAIL cx threw"]);
    expect([...lines, ...extra.lines].filter((l) => l.includes(SECRET))).toEqual([]);
    expect(code).toBe(1);
  });

  it("--trigger-cron runs the prod scoring cron trigger (scripts/smoke-cron.sh) and FAILs on its exit", async () => {
    const calls: string[] = [];
    const run: Deps["run"] = (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      return Promise.resolve({ code: cmd === "bash" ? 3 : 0, stdout: "" });
    };
    expect((await runAll(deps({ run }), ["--trigger-cron"], [])).lines).toEqual(["FAIL trigger-cron exit-3"]);
    expect(calls).toEqual(["bash scripts/smoke-cron.sh"]);
  });
});
