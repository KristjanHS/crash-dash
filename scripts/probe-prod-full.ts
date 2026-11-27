/**
 * probe:prod-full — one PASS/FAIL line per prod check, exit 1 on any FAIL; never prints a value, topic or token.
 *   npm run -s probe:prod-full [-- --trigger-cron]
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { type Env, ntfyTopic, readEnv } from "../src/config.js";
import { prodConfigBaseUrl } from "./lib/prod-config.js";
import { todayOnFeedCalendar } from "../src/dates.js";
import { CADENCE_OF, compositeComponentLegIds, freshnessFrom, type FreshnessStamp, LAG_CHUNK_IDS } from "../src/feed-lag.js";
import { INPUT_SERIES } from "../src/input-series.js";
import { isIntradayRun, servedVerdict } from "../src/intraday.js";
import { lagCutFor } from "../src/ladder.js";
import { isLicensedId } from "../src/licensed.js";
import { isSlotExcused } from "../src/market-closures.js";
import { containmentGrid, LAG_SCAN_LIMIT, MIN_CALENDAR_SOURCES, type PublicationCalendar, slotAge } from "../src/publication-calendar.js";
import { ALL_INDICATORS } from "../src/registry.js";
import { slotLag } from "../src/release-delay.js";
import { type DegradeEffect, type DegradeEvent, getStore, type ReadStore } from "../src/store.js";

export interface Ran {
  code: number;
  stdout: string;
}
export interface Deps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  run: (cmd: string, args: readonly string[]) => Promise<Ran>;
  /** undefined when the file is absent. */
  readFile: (path: string) => string | undefined;
  env: ProbeEnv;
  now: () => Date;
  lastShipPath: string;
  /** A read-only store (`getStore("ro")`); throws without `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`. */
  store: () => ReadStore;
  freshness: (store: ReadStore, now: Date) => Promise<Pick<FreshnessStamp, "freshness">>;
}
export type ProbeEnv = Env;
export type Result = { ok: true } | { ok: false; reason: string };
export interface Check {
  id: string;
  run: (deps: Deps) => Promise<Result>;
}

const PASS: Result = { ok: true };
const fail = (reason: string): Result => ({ ok: false, reason });

const lastShipFile = (env: { XDG_CONFIG_HOME?: string; HOME?: string }): string =>
  `${env.XDG_CONFIG_HOME || `${env.HOME}/.config`}/crash-dash/last-ship`;

/** `https://<PROD_ALIAS>` (bare host or https URL); no default — an unset alias throws (the check FAILs `threw`). */
function baseUrl(env: Env): string {
  return prodConfigBaseUrl(env);
}

async function getJson(deps: Deps, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body?: unknown; mitigated: boolean }> {
  const res = await deps.fetch(url, { headers: { "Cache-Control": "no-cache", ...headers }, signal: AbortSignal.timeout(30_000) });
  const mitigated = res.headers.get("x-vercel-mitigated") != null;
  if (res.status !== 200) return { status: res.status, mitigated };
  try {
    return { status: 200, body: await res.json(), mitigated };
  } catch {
    return { status: 200, mitigated };
  }
}

export async function c1(deps: Deps): Promise<Result> {
  const shipped = deps.readFile(deps.lastShipPath)?.trim();
  if (shipped === undefined) return fail("missing-file");
  if (shipped === "") return fail("empty-file");
  const host = new URL(baseUrl(deps.env)).host;
  const r = await deps.run("npx", ["--yes", "--package=vercel@latest", "vercel", "inspect", host, "--format", "json"]);
  if (r.code !== 0) return fail("inspect-failed");
  let live: unknown;
  try {
    const v = JSON.parse(r.stdout) as { id?: unknown; uid?: unknown };
    live = v.id ?? v.uid;
  } catch {
    return fail("inspect-unparsed");
  }
  if (typeof live !== "string" || live === "") return fail("inspect-no-id");
  return live === shipped ? PASS : fail("mismatch");
}

export async function c2(deps: Deps): Promise<Result> {
  const r = await deps.run("npm", ["run", "-s", "probe:prod-smoke"]);
  return r.code === 0 ? PASS : fail(`exit-${r.code}`);
}

export async function c3(deps: Deps): Promise<Result> {
  const secret = deps.env.CRON_SECRET;
  if (!secret) return fail("no-credential");
  const r = await getJson(deps, `${baseUrl(deps.env)}/api/health`, { Authorization: `Bearer ${secret}` });
  if (r.mitigated) return fail("mitigated");
  if (r.status !== 200) return fail(`http-${r.status}`);
  const body = r.body as { ok?: unknown; maxRows?: unknown; maxRowsMismatch?: unknown } | undefined;
  if (body?.ok !== true) return fail("not-ok");
  // `maxRows` rides only the deep (bearer-accepted) body — `healthView`, src/api/meta-views.ts.
  if (!("maxRows" in body)) return fail("shallow");
  return body.maxRowsMismatch === true ? fail("max-rows-mismatch") : PASS;
}

// ---- c7: every openapi path (relative to /api) answers 200 with its declared required top-level keys.
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v != null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
const SKIP_PATHS = ["/cron/run"];

type Expect = { kind: "array" } | { kind: "object"; required: string[] } | { kind: "any"; alts: Expect[] };

function expectOf(doc: unknown, schema: unknown): Expect {
  const s = obj(schema) ?? {};
  const ref = s.$ref;
  if (typeof ref === "string") return expectOf(doc, obj(obj(obj(doc)?.components)?.schemas)?.[ref.replace("#/components/schemas/", "")]);
  if (Array.isArray(s.oneOf)) return { kind: "any", alts: s.oneOf.map((alt) => expectOf(doc, alt)) };
  if (s.type === "array") return { kind: "array" };
  return { kind: "object", required: Array.isArray(s.required) ? s.required.map(String) : [] };
}

function satisfies(e: Expect, body: unknown): boolean {
  if (e.kind === "any") return e.alts.some((alt) => satisfies(alt, body));
  if (e.kind === "array") return Array.isArray(body);
  return body != null && typeof body === "object" && !Array.isArray(body) && e.required.every((k) => k in body);
}

/** The query string a GET needs, or undefined when a required param has no example/enum/default. */
function queryFor(op: Obj): string | undefined {
  const qs = new URLSearchParams();
  for (const p of Array.isArray(op.parameters) ? (op.parameters as unknown[]) : []) {
    const param = obj(p);
    if (param?.in !== "query" || param.required !== true) continue;
    const schema = obj(param.schema) ?? {};
    const v = param.example ?? schema.example ?? (Array.isArray(schema.enum) ? schema.enum[0] : undefined) ?? schema.default;
    if (v == null) return undefined;
    qs.set(String(param.name), String(v as string | number | boolean));
  }
  const s = qs.toString();
  return s === "" ? "" : `?${s}`;
}

export const OPENAPI_PATH = fileURLToPath(new URL("../openapi.yaml", import.meta.url));

export async function c7(deps: Deps): Promise<Result> {
  const text = deps.readFile(OPENAPI_PATH);
  if (text === undefined) return fail("missing-openapi");
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return fail("openapi-unparsed");
  }
  const paths = obj(obj(doc)?.paths) ?? {};
  const bad: string[] = [];
  for (const p of Object.keys(paths).filter((x) => !SKIP_PATHS.includes(x))) {
    const op = obj(obj(paths[p])?.get);
    if (!op) {
      bad.push(`${p}=no-get`);
      continue;
    }
    const q = queryFor(op);
    if (q === undefined) {
      bad.push(`${p}=no-example`);
      continue;
    }
    const schema = obj(obj(obj(obj(op.responses)?.["200"])?.content)?.["application/json"])?.schema;
    try {
      const r = await getJson(deps, `${baseUrl(deps.env)}/api${p}${q}`);
      if (r.mitigated) bad.push(`${p}=mitigated`);
      else if (r.status !== 200) bad.push(`${p}=http-${r.status}`);
      else if (!satisfies(expectOf(doc, schema), r.body)) bad.push(`${p}=missing-keys`);
    } catch {
      bad.push(`${p}=unreachable`);
    }
  }
  return bad.length === 0 ? PASS : fail(bad.join(","));
}

function storeOf(deps: Deps): ReadStore | undefined {
  try {
    return deps.store();
  } catch {
    return undefined;
  }
}

/** c4 fails on a push-caveat event (`effect`, or `late` for a post-drain one) or a `provenanceDegradeEvents` provider hop. */
const FEED_DEGRADE_EFFECTS: readonly DegradeEffect[] = ["notify"];
const PROVIDER_HOP = / fell back to /;
const isFeedDegrade = (e: DegradeEvent): boolean =>
  FEED_DEGRADE_EFFECTS.includes(e.effect) || (e.late !== undefined && FEED_DEGRADE_EFFECTS.includes(e.late)) || PROVIDER_HOP.test(e.scope);

export const VERCEL_JSON_PATH = fileURLToPath(new URL("../vercel.json", import.meta.url));
const CRON_PATH = "/api/cron/run";
/** Hobby crons fire anywhere inside their scheduled hour (up to ~1h late), so an instant counts as due only 2h after it. */
export const CRON_GRACE_MS = 2 * 3_600_000;

export interface CronSchedule {
  minute: number;
  hour: number;
  /** UTC days of week (0 = Sun) the schedule fires on. */
  days: ReadonlySet<number>;
}

/** `M H * * DOW` with DOW `N`, `N-M` or `*`; any other form ⇒ undefined. */
export function parseCron(expr: string): CronSchedule | undefined {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (?:\*|([0-6])(?:-([0-6]))?)$/.exec(expr.trim());
  if (!m) return undefined;
  const [minute, hour] = [Number(m[1]), Number(m[2])];
  if (minute > 59 || hour > 23) return undefined;
  const lo = m[3] === undefined ? 0 : Number(m[3]);
  const hi = m[3] === undefined ? 6 : Number(m[4] ?? m[3]);
  if (hi < lo) return undefined;
  return { minute, hour, days: new Set(Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)) };
}

/** Every `/api/cron/run` schedule in vercel.json, or a fixed-word reason. */
export function cronSchedules(text: string | undefined): CronSchedule[] | string {
  if (text === undefined) return "missing-vercel-json";
  let crons: unknown;
  try {
    crons = obj(JSON.parse(text))?.crons;
  } catch {
    return "cron-unparsed";
  }
  const runs = (Array.isArray(crons) ? crons : []).map(obj).filter((c) => c?.path === CRON_PATH);
  if (runs.length === 0) return "no-cron";
  const out: CronSchedule[] = [];
  for (const c of runs) {
    const s = typeof c?.schedule === "string" ? parseCron(c.schedule) : undefined;
    if (!s) return "cron-unparsed";
    out.push(s);
  }
  return out;
}

/** The most recent instant ≤ `now` any of `schedules` fires at (a week back covers every DOW form). */
export function lastScheduledInstant(schedules: readonly CronSchedule[], now: Date): number {
  let best = -Infinity;
  const day0 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let back = 0; back <= 7; back++)
    for (const s of schedules) {
      const t = day0 - back * DAY_MS + (s.hour * 60 + s.minute) * 60_000;
      if (t <= now.getTime() && s.days.has(new Date(t).getUTCDay()) && t > best) best = t;
    }
  return best;
}

/** The EOD schedules: those firing on no weekend day (the Saturday repair cron writes an intraday slot, never a row). */
const eodSchedules = (schedules: readonly CronSchedule[]): CronSchedule[] => schedules.filter((s) => !s.days.has(0) && !s.days.has(6));

export async function c4(deps: Deps): Promise<Result> {
  const schedules = cronSchedules(deps.readFile(VERCEL_JSON_PATH));
  if (typeof schedules === "string") return fail(schedules);
  const eod = eodSchedules(schedules);
  if (eod.length === 0) return fail("no-eod-cron");
  const store = storeOf(deps);
  if (!store) return fail("no-store");
  // The bare slot read, not `readIntradaySlot`: its degrade-to-null would read a failed read as "no daytime run" (PASS).
  const [row, slot] = await Promise.all([store.getLastAlert(), store.getIntradayVerdict()]);
  if (row === null) return fail("no-alert-row");
  // Reads /api/status's served heartbeat `lag` — never a second computation (run-path-freshness-callers.test.ts);
  // The edge copy is the cron's vintage (its tag purge). The served verdict must be `servedVerdict(eod, slot)`, the rule every read surface shares.
  const s = await getJson(deps, `${baseUrl(deps.env)}/api/status`);
  if (s.mitigated) return fail("mitigated");
  if (s.status !== 200) return fail(`status-http-${s.status}`);
  const status = s.body as { lag?: unknown; verdict?: { firedAt?: unknown } } | undefined;
  const served = servedVerdict(row, slot) ?? row; // `row` is non-null here, so `served` is too
  const intraday = served !== row;
  if (Date.parse(String(status?.verdict?.firedAt)) !== Date.parse(served.firedAt)) return fail(intraday ? "served-not-intraday" : "served-not-eod");
  if (!intraday) {
    if (status?.lag !== false) return fail("stale");
  } else {
    // No `lag` check here: api/status.ts computes it off the SERVED verdict's date, so under a served slot it describes the slot.
    // The slot must postdate the latest due `/api/cron/run` instant — the Sat repair cron's slot stays served until Mon EOD —
    // and be an intraday run; the EOD row must postdate the latest due weekday EOD instant (a missed EOD cron).
    const now = deps.now().getTime();
    const fired = new Date(served.firedAt);
    if (!(fired.getTime() >= lastScheduledInstant(schedules, new Date(now - CRON_GRACE_MS))) || !isIntradayRun(fired)) return fail("intraday-stale");
    if (!(Date.parse(row.firedAt) >= lastScheduledInstant(eod, new Date(now - CRON_GRACE_MS)))) return fail("eod-stale");
  }
  if (row.degraded === null) return fail("no-trace");
  return row.degraded.some(isFeedDegrade) ? fail("feed-degraded") : PASS;
}

/** Slot-scored cadences only: a monthly/quarterly id would need the calendar-day rule, which only scorers-core/run-core may
 *  compute (run-path-freshness-callers.test.ts). */
export type InputCadence = "daily" | "weekly";

/** Cadence per `INPUT_ONLY_IDS` id, default `"daily"`. Empty by measurement: the 2026-11-16 read-only prod pass printed a
 *  1-day median gap over the newest ~30 stored dates for every id it showed (45 of 49), so none is weekly/monthly. */
export const INPUT_CADENCE_OVERRIDE: Readonly<Record<string, InputCadence>> = {};

/** The `INPUT_SERIES` ids `freshnessFrom` does not stamp; the overlap rides `CADENCE_OF` in c5's stamp walk. */
export const INPUT_ONLY_IDS: readonly string[] = INPUT_SERIES.map((s) => s.id).filter((id) => !CADENCE_OF.has(id));

/** Input ids no registry `series` names, twinned by hand to a daily registry sibling on the SAME FRED publication (so its
 *  measured release delay, daily cut and US calendar hold). Measured 2026-11-19 upstream: H.15 levels (DGS2/DGS10/DGS3MO)
 *  and Moody's yields (BAA10Y/AAA10Y) post T+1, so twin-less at delay 0 each read lag every evening before FRED's next
 *  post (c5 `lag=DGS3MO,AAA10Y`); FRED's computed spreads post same-day, so their delay-0 reads hold (T10Y3M via its
 *  auto twin R1, T10Y2Y twin-less). */
export const INPUT_TWIN_SIBLING: Readonly<Record<string, string>> = {
  DGS3MO: "R2", // DGS10, H.15
  AAA10Y: "CQS", // BAA10Y − AAA10Y, Moody's: its own second input
};

/** input id → its {@link INPUT_TWIN_SIBLING}, else the first registry indicator (registry order) whose upstream `series` is
 *  that input's upstream symbol: the same feed, so its measured release delay and closure calendar hold for the raw copy.
 *  Twin-less ids map to themselves. */
export const INPUT_TWIN: ReadonlyMap<string, string> = new Map(
  INPUT_SERIES.filter((s) => !CADENCE_OF.has(s.id)).map((s) => [
    s.id,
    INPUT_TWIN_SIBLING[s.id] ?? ALL_INDICATORS.find((i) => i.series === (s.symbol ?? s.id))?.id ?? s.id,
  ]),
);

/** A `containmentGrid` throw whose cause is the {@link MIN_CALENDAR_SOURCES} floor (publication-calendar.ts throws a plain
 *  Error, so its message is the only handle; a reworded throw makes every accepted id unmeasured again — FAIL, never PASS). */
const isCalendarFloorError = (err: unknown): boolean => err instanceof Error && err.message.includes(`below the floor of ${MIN_CALENDAR_SOURCES}`);

/** Every weekday in `[from, to]`: the calendar-free grid an accepted id's age is read on once its own grid is below the floor. */
function weekdayGrid(id: string, from: string, to: string): PublicationCalendar {
  const dates: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    const day = new Date(t);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) dates.push(day.toISOString().slice(0, 10));
  }
  return { cohort: id, dates };
}

/** `freshnessFrom`'s per-id rule for ids it never stamps: `slotLag(slotAge(...))` on the id's containment grid over every daily
 *  `CADENCE_OF` peer (estimated rows dropped, legs not independent), delay and closures read through `INPUT_TWIN`. A grid
 *  that throws makes the id `unmeasured` — unless the id is in `C5_ACCEPTED_UNMEASURED` AND the throw is the calendar floor:
 *  then its age is weekdays since its newest row (`weekdayGrid`), held to the same cut, delay and closures. `ids` defaults to
 *  `INPUT_ONLY_IDS`; c5 appends the accepted stamp ids `freshnessFrom` left unmeasured. */
export async function inputSeriesFreshness(
  store: ReadStore,
  now: Date,
  overrides: Readonly<Record<string, InputCadence>> = INPUT_CADENCE_OVERRIDE,
  ids: readonly string[] = INPUT_ONLY_IDS,
): Promise<{ missing: string[]; lag: string[]; unmeasured: string[] }> {
  const legIds = compositeComponentLegIds();
  const peerIds = [...CADENCE_OF].filter(([, c]) => c === "daily").map(([id]) => id);
  const read = [...new Set([...peerIds, ...ids])];
  const chunks: string[][] = [];
  for (let i = 0; i < read.length; i += LAG_CHUNK_IDS) chunks.push(read.slice(i, i + LAG_CHUNK_IDS));
  const dates = new Map<string, string[]>();
  for (const m of await Promise.all(chunks.map((c) => store.getSeriesBulk(c, { limit: LAG_SCAN_LIMIT }))))
    for (const [id, pts] of m) dates.set(id, pts.filter((p) => p.estimated !== true).map((p) => p.date));
  const peers = peerIds.map((id) => ({ id, dates: dates.get(id) ?? [], independent: !legIds.has(id) }));
  // No input id registers a feed time zone (`FEED_TZ_OF` walks the registry), so all share the default feed calendar.
  const today = todayOnFeedCalendar(undefined, now);
  const out = { missing: [] as string[], lag: [] as string[], unmeasured: [] as string[] };
  for (const id of ids) {
    const own = dates.get(id) ?? [];
    const newest = own.at(-1);
    if (newest === undefined) {
      out.missing.push(id);
      continue;
    }
    let grid: PublicationCalendar;
    try {
      grid = containmentGrid({ id, dates: own, independent: true }, peers);
    } catch (err) {
      if (!Object.hasOwn(C5_ACCEPTED_UNMEASURED, id) || !isCalendarFloorError(err)) {
        out.unmeasured.push(id);
        continue;
      }
      grid = weekdayGrid(id, newest, today);
    }
    const twin = INPUT_TWIN.get(id) ?? id;
    const age = slotAge(newest, today, grid, (d, post) => isSlotExcused(twin, d, post));
    // The twin's own cut (`lagAfterDays`/cadence) — R8 and G1 carry multi-day cuts the generic daily cut false-lags.
    const twinInd = ALL_INDICATORS.find((i) => i.id === twin);
    const cut = overrides[id] !== undefined || twinInd === undefined ? lagCutFor({ cadence: overrides[id] ?? "daily" }) : lagCutFor(twinInd);
    if (slotLag(age, cut, twin)) out.lag.push(id);
  }
  return out;
}

/** `^GSPC` fails `SAFE_REASON`: an id prints with every other character mapped to `_`. */
const printable = (id: string): string => id.replace(/[^\w.=-]/g, "_");

/** Ids c5 excuses from `unmeasured` (missing/lag still FAIL), each with its recorded cause [USER 2026-11-16]. Measured
 *  2026-11-16 read-only on prod: each throws `containmentGrid` "1 independent source(s), below the floor of 2" — its own
 *  publication calendar has no second daily peer in the registry, so no feed can tell its silence from a holiday. The excuse
 *  holds only for THAT throw (`isCalendarFloorError`; any other grid failure stays unmeasured), and swaps the grid for a
 *  weekday one so the id still lags on its own cut + delay: an unregistered closure of its calendar can read as lag. */
export const C5_ACCEPTED_UNMEASURED: Readonly<Record<string, string>> = {
  JPT: "Tokyo exchange calendar, no second daily peer (MIN_CALENDAR_SOURCES)",
  HYNIX: "Seoul exchange calendar, no second daily peer (MIN_CALENDAR_SOURCES)",
  // [USER 2026-11-22] London calendar: its UK peers (GILT, UKDE) left the registry 2026-11-21.
  BRENT: "London (ICE) calendar, no second daily peer since GILT/UKDE retired (MIN_CALENDAR_SOURCES)",
};

/** Walks `CADENCE_OF` (the roster `freshnessFrom` stamps), so a stamp's foreign id never reaches stdout, then `INPUT_ONLY_IDS`. */
export async function c5(deps: Deps): Promise<Result> {
  const store = storeOf(deps);
  if (!store) return fail("no-store");
  const now = deps.now();
  const stamp = await deps.freshness(store, now);
  const byId = new Map(stamp.freshness.map((f) => [f.id, f]));
  const ids = [...CADENCE_OF.keys()];
  const unstamped = ids.filter((id) => byId.has(id) && byId.get(id)!.lag === undefined);
  const accepted = (id: string) => Object.hasOwn(C5_ACCEPTED_UNMEASURED, id);
  // An accepted stamp id the stamp left unmeasured is re-read off the store with the input ids: same floor check, same cut.
  const inputs = await inputSeriesFreshness(store, now, INPUT_CADENCE_OVERRIDE, [...INPUT_ONLY_IDS, ...unstamped.filter(accepted)]);
  const groups = {
    missing: [...ids.filter((id) => !byId.has(id)), ...inputs.missing],
    lag: [...ids.filter((id) => byId.get(id)?.lag === true), ...inputs.lag],
    unmeasured: [...unstamped.filter((id) => !accepted(id)), ...inputs.unmeasured],
  };
  const bad = Object.entries(groups).flatMap(([k, v]) => (v.length > 0 ? [`${k}=${v.map(printable).join(",")}`] : []));
  return bad.length === 0 ? PASS : fail(bad.join("/"));
}

/** getRecentAlerts counts UTC fired-dates; a failed push re-fires next run (`decideReassert`), so 30 reaches it. */
const PUSH_SCAN_DATES = 30;

export async function c6(deps: Deps): Promise<Result> {
  const store = storeOf(deps);
  if (!store) return fail("no-store");
  const [recent, lastPush] = await Promise.all([store.getRecentAlerts(PUSH_SCAN_DATES), store.getLastPush()]);
  // `recent` is newest-first and holds the newest dates, so `lastPush` only answers when no recent row attempted.
  const newest = [...recent, ...(lastPush ? [lastPush] : [])].find((a) => a.pushedAt !== null || a.pushError !== null);
  if (!newest) return fail("no-push-row");
  if (newest.pushError !== null) return fail("push-error");
  const topic = ntfyTopic(deps.env);
  if (topic === ntfyTopic({})) return fail("dev-topic");
  const res = await deps.fetch(`https://ntfy.sh/${encodeURIComponent(topic)}/json?poll=1&since=1m`, { signal: AbortSignal.timeout(30_000) });
  return res.status === 200 ? PASS : fail(`ntfy-http-${res.status}`);
}

/** An `isLicensedId` id `/api/series` serves redacted (pinned on the roster in the test). */
export const REDACTED_SERIES_ID = "F1";

type Count = (body: unknown) => number;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const nonNull = (xs: unknown[], key: string): number => xs.filter((x) => obj(x)?.[key] != null).length;
/** A redacted body (`redacted: true`) counts 0 whatever it carries. */
const unredacted = (count: Count): Count => (b) => (obj(b)?.redacted === true ? 0 : count(b));

/** The read endpoints that null redacted fields (`serveRedactable`, src/api/http.ts) → a count of non-null redacted fields. */
export const REDACTED_URLS: readonly { key: string; path: string; count: Count }[] = [
  { key: "status", path: "/api/status", count: (b) => nonNull(arr(obj(b)?.readings).filter((r) => isLicensedId(String(obj(r)?.indicatorId))), "value") },
  { key: "history", path: "/api/history", count: (b) => nonNull(arr(b), "vix") },
  { key: "series", path: `/api/series?id=${REDACTED_SERIES_ID}`, count: unredacted((b) => nonNull(arr(obj(b)?.points), "value")) },
  { key: "replay", path: "/api/replay", count: unredacted((b) => arr(obj(b)?.episodes).reduce((n: number, ep) => n + nonNull(arr(obj(ep)?.points), "price"), 0)) },
];

/** Each redacting URL carries 0 non-null redacted fields (`anon-leak` otherwise); counts only, never a field. */
export async function c8(deps: Deps): Promise<Result> {
  const bad: string[] = [];
  for (const u of REDACTED_URLS) {
    const r = await getJson(deps, `${baseUrl(deps.env)}${u.path}`);
    if (r.mitigated) bad.push(`${u.key}=anon-mitigated`);
    else if (r.status !== 200) bad.push(`${u.key}=anon-http-${r.status}`);
    else if (u.count(r.body) !== 0) bad.push(`${u.key}=anon-leak`);
  }
  return bad.length === 0 ? PASS : fail(bad.join(","));
}

const DAY_MS = 86_400_000;

/** Optional operator-side schedules, not in `.github/workflows/` (README §Scheduled jobs and leg runs); `gh run list` runs at the
 *  checkout root, so it queries `GH_REPO`, else the repo of the checkout's git remote — one without them FAILs c9. */
export const BACKUP_WORKFLOWS = ["backup-prod-data", "dead-man-ping"] as const;
/** README §Scheduled jobs and leg runs: each job completes at least every 3 days (a weekday schedule's Fri→Mon gap); +1 day slack. */
export const BACKUP_MAX_RUN_AGE_MS = 4 * DAY_MS;

export async function c9(deps: Deps): Promise<Result> {
  const bad: string[] = [];
  for (const wf of BACKUP_WORKFLOWS) {
    const r = await deps.run("gh", ["run", "list", `--workflow=${wf}.yml`, "--status=completed", "--limit=1", "--json", "conclusion,status,createdAt"]);
    if (r.code !== 0) {
      bad.push(`${wf}=gh-failed`);
      continue;
    }
    let runs: unknown;
    try {
      runs = JSON.parse(r.stdout);
    } catch {
      bad.push(`${wf}=unparsed`);
      continue;
    }
    const newest = Array.isArray(runs) ? (runs[0] as { conclusion?: unknown; createdAt?: unknown } | undefined) : undefined;
    const created = typeof newest?.createdAt === "string" ? Date.parse(newest.createdAt) : NaN;
    if (newest === undefined) bad.push(`${wf}=no-run`);
    else if (newest.conclusion !== "success") bad.push(`${wf}=not-success`);
    else if (!(deps.now().getTime() - created <= BACKUP_MAX_RUN_AGE_MS)) bad.push(`${wf}=stale-run`);
  }
  return bad.length === 0 ? PASS : fail(bad.join(","));
}

const LADDER_UNIT = "crash-dash-eufin";
/** `OnCalendar=Mon..Fri 07:40:00` (scripts/systemd/crash-dash-eufin.timer): widest gap Fri→Mon = 3 days; +1 day slack. */
export const LADDER_MAX_RUN_AGE_MS = 4 * DAY_MS;

/** `systemctl show` props; `TZ=UTC` renders timestamps as `Day YYYY-MM-DD HH:MM:SS UTC` (systemd 249 has no `--timestamp=unix`). */
async function unitProps(deps: Deps, unit: string, props: readonly string[]): Promise<Map<string, string> | undefined> {
  const r = await deps.run("env", ["TZ=UTC", "systemctl", "--user", "show", unit, ...props.flatMap((p) => ["-p", p])]);
  if (r.code !== 0) return undefined;
  return new Map(r.stdout.split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
}

/** `scripts/ladder-check.sh` `status`'s "last run ok" test, plus load, recency and timer liveness. */
export async function c10(deps: Deps): Promise<Result> {
  const svc = await unitProps(deps, `${LADDER_UNIT}.service`, ["LoadState", "Result", "ExecMainStatus", "ExecMainStartTimestamp"]);
  if (!svc) return fail("show-failed");
  if (svc.get("LoadState") !== "loaded") return fail("not-loaded");
  const start = /^\w{3} (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/.exec(svc.get("ExecMainStartTimestamp") ?? "");
  if (!start) return fail("never-ran");
  if (!(deps.now().getTime() - Date.parse(`${start[1]}T${start[2]}Z`) <= LADDER_MAX_RUN_AGE_MS)) return fail("stale-run");
  if (svc.get("Result") !== "success") return fail("result-not-success");
  if (svc.get("ExecMainStatus") !== "0") return fail("exit-nonzero");
  const timer = await unitProps(deps, `${LADDER_UNIT}.timer`, ["ActiveState"]);
  if (!timer) return fail("show-failed");
  return timer.get("ActiveState") === "active" ? PASS : fail("timer-inactive");
}

/** The deploy resolves the push/mail link host: `/api/status` `alertLinks` (derived; catches a set-but-not-redeployed alias). */
export async function c11(deps: Deps): Promise<Result> {
  const s = await getJson(deps, `${baseUrl(deps.env)}/api/status`);
  if (s.mitigated) return fail("mitigated");
  if (s.status !== 200) return fail(`status-http-${s.status}`);
  const links = (s.body as { alertLinks?: unknown } | undefined)?.alertLinks;
  // Fixed-word reason (SAFE_REASON): link host not resolved on the deploy — set PROD_ALIAS or redeploy.
  return links === true ? PASS : fail("alert-links-unresolved/set-PROD_ALIAS-or-redeploy");
}

export const CHECKS: readonly Check[] = [
  { id: "c1", run: c1 },
  { id: "c2", run: c2 },
  { id: "c3", run: c3 },
  { id: "c4", run: c4 },
  { id: "c5", run: c5 },
  { id: "c6", run: c6 },
  { id: "c7", run: c7 },
  { id: "c8", run: c8 },
  { id: "c9", run: c9 },
  { id: "c10", run: c10 },
  { id: "c11", run: c11 },
];

/** Guards line formatting only (one token per FAIL line); secrecy rests on fixed-word reasons + the runAll secret-echo test. */
const SAFE_REASON = /^[\w/=,.-]+$/;

export async function runAll(deps: Deps, argv: readonly string[], checks: readonly Check[] = CHECKS): Promise<{ lines: string[]; code: 0 | 1 }> {
  const lines: string[] = [];
  if (argv.includes("--trigger-cron")) {
    const r = await deps.run("bash", ["scripts/smoke-cron.sh"]);
    lines.push(r.code === 0 ? "PASS trigger-cron" : `FAIL trigger-cron exit-${r.code}`);
  }
  for (const c of checks) {
    let r: Result;
    try {
      r = await c.run(deps);
    } catch {
      r = fail("threw");
    }
    lines.push(r.ok ? `PASS ${c.id}` : `FAIL ${c.id} ${SAFE_REASON.test(r.reason) ? r.reason : "unprintable"}`);
  }
  return { lines, code: lines.some((l) => l.startsWith("FAIL")) ? 1 : 0 };
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const withBypass = (headers: RequestInit["headers"], secret: string): Headers => {
  const h = new Headers(headers);
  h.set("x-vercel-protection-bypass", secret);
  return h;
};

function realDeps(): Deps {
  const env: ProbeEnv = readEnv();
  let store: ReadStore | undefined;
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  return {
    // The Deployment Protection bypass rides only requests to the probed deployment, never ntfy.sh.
    fetch: (url, init) =>
      bypass && url.startsWith(`${baseUrl(env)}/`)
        ? fetch(url, { ...init, redirect: "manual", headers: withBypass(init?.headers, bypass) })
        : fetch(url, init),
    run: (cmd, args) =>
      new Promise((resolve) => {
        execFile(cmd, args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, timeout: 900_000 }, (err, stdout) => {
          const code = err == null ? 0 : typeof err.code === "number" ? err.code : 1;
          resolve({ code, stdout: String(stdout) });
        });
      }),
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    env,
    now: () => new Date(),
    lastShipPath: lastShipFile(process.env),
    store: () => (store ??= getStore("ro", env)),
    freshness: (s, now) => freshnessFrom(s, now, () => {}),
  };
}

if (process.argv[1]?.endsWith("probe-prod-full.ts") === true) {
  const { lines, code } = await runAll(realDeps(), process.argv.slice(2));
  for (const l of lines) console.log(l);
  process.exitCode = code;
}
