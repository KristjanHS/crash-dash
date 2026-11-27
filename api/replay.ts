/**
 * GET /api/replay — the exposure-dial episode replay (slice E2, Stage 6). One of the 8
 * live Vercel functions (api/deploy-budget.test.ts guards the cap).
 *
 * Returns ALL episodes in one payload so the /lab "Episode replay" section switches
 * between them with zero refetch. STORE-ONLY since load-tolerance P1.3: every input is a
 * cron-persisted raw series (src/input-series.ts; writer src/run-seeds.ts) — this handler
 * fetches NOTHING upstream (pinned by api/no-upstream-fetch.test.ts). Server flow:
 *   stitchHyOas(loadHyOasVintage(), stored BAMLH0A0HYM2)  → F1 credit series
 *   stored "^GSPC" | "ACWI"                               → buildFireSeries
 *   stored "IEF"                                          → bond-rung proxy line
 * then replayExposure(f1, fire, window) per EPISODES entry.
 *
 * Missing-row rule: an input id ABSENT
 * from the store serves the response WITHOUT that leg/companion (the field omitted / empty,
 * exactly the old fetch-failure degrade shape), `warnMissingInput` once per instance — never an upstream fetch, never
 * a 503. A stitchHyOas VIOLATION (overlap disagreement / gap) is data corruption, so it
 * THROWS and surfaces as a 500 (never masked as a degraded 200); the vintage loader is
 * fail-loud on a corrupt file for the same reason, while an ABSENT vintage file degrades exactly
 * like an absent BAMLH0A0HYM2 input (empty points). Vercel Node function (Web-handler).
 *
 * Caching: the response is a pure function of the persisted vintage, so every 200 ships
 * `VINTAGE_HEADERS` (nightly tag purge + deploy flush bust it) — the old degraded
 * `no-store` branch and the per-instance day memo are gone with the fetches.
 *
 * Redaction: the episode body and every restricted-source companion are served through
 * `serveRedactable` — every request gets the `redacted: true` body.
 */
import { loadHyOasVintage } from "../src/hyoas-vintage.js";
import { stitchHyOas } from "../src/hyoas-history.js";
import { HY_LIVE_TAIL_ROWS, readInputSeries, warnMissingInput } from "../src/input-series.js";
import { getStore, type ReadStore } from "../src/store.js";
import {
  EPISODES,
  buildFireSeries,
  exposureReplayNotes,
  fireSpliceDate,
  replayExposure,
} from "../src/exposure-replay.js";
import {
  rejectUnknownParams,
  serveRedactable,
  VINTAGE_HEADERS,
} from "../src/api/http.js";
import { isLicensedSource } from "../src/licensed.js";
import type { Observation } from "../src/domain-types.js";
import type { SeriesPoint } from "../src/store.js";
import type {
  ExposureReplayEpisodeDTO,
  ExposureReplayResponse,
  ReplayCompanionResponse,
} from "../src/api/types.js";
import { isoDay } from "../src/dates.js";
import { readEnv } from "../src/config.js";

// Newest-N row budget for the store reads. The deepest ask is the old ~31y fetch lookback
// (^GSPC must reach 1996 for the 2002 episode + FIRE splice; IEF/^IXIC likewise), and a
// daily series holds at most one row per calendar day, so N = 31y of calendar days always
// reaches at least as deep as the retired 31y fetch window did.
const INPUT_ROW_LIMIT = 31 * 365;

const IEF_ABSENT_NOTE =
  "No bond-rung (IEF) line: the 7-10yr Treasury ETF's history (from 2002-07-30) does not overlap this window.";
const iefPartialNote = (firstDate: string): string =>
  `No bond-rung (IEF) data before ${firstDate} - the ETF's first close; the bond line starts there.`;

/** F1 (ARM credit key) reads only date+value off each point; the trend/decision fields are
 *  inert for HY-OAS, so we fill the SeriesPoint shape with neutral placeholders. */
const toF1Point = (o: Observation): SeriesPoint => ({
  date: o.date,
  value: o.value,
  delta20: 0,
  rawState: "GREEN",
  state: "GREEN",
  decision: null,
});

const round2 = (x: number): number => Math.round(x * 100) / 100;

// ── Companion series branch (`?companion=`, Rung E3) ───────────────────────────
// The replay chart's overlay indicators that are NOT dashboard indicators — served off
// their cron-persisted raw rows (src/input-series.ts), no live feed. Kept inside THIS
// function: the api/ function budget is pinned, so no new api/ file. Exported so the /lab picker's
// own EXTERNAL_COMPANIONS labels are pinned against it (public/exposure-replay-chart.test.js).
export const COMPANIONS: Readonly<Record<string, { label: string; unit: string }>> = {
  VIXCLS: { label: "VIX", unit: "" },
  T10Y2Y: { label: "10Y−2Y", unit: "%" },
  DCOILWTICO: { label: "WTI", unit: "$" },
  "^IXIC": { label: "Nasdaq", unit: "" },
};

const COMPANION_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The redacted episode body — whitelist: every raw vendor close (fire `price`, IEF `defensive[].price`)
 *  nulled; dates, ARM/FIRE keys, posture, notes stay. A new field stays OUT until listed here. */
function redactReplay(body: ExposureReplayResponse): ExposureReplayResponse {
  return {
    asOf: body.asOf,
    episodes: body.episodes.map((ep) => ({
      id: ep.id,
      label: ep.label,
      start: ep.start,
      end: ep.end,
      candidate: ep.candidate,
      rationale: ep.rationale,
      points: ep.points.map((p) => ({
        date: p.date,
        price: null,
        armed: p.armed,
        fired: p.fired,
        posture: p.posture,
        degraded: p.degraded,
      })),
      ...(ep.defensive ? { defensive: ep.defensive.map((d) => ({ date: d.date, price: null })) } : {}),
      notes: ep.notes,
    })),
    redacted: true,
  };
}

/** The served licensed companion: names/unit only, no points. */
function redactCompanion(body: ReplayCompanionResponse): ReplayCompanionResponse {
  return { indicatorId: body.indicatorId, label: body.label, unit: body.unit, points: [], redacted: true };
}

/**
 * `GET /api/replay?companion=<id>[&from=&to=]` — ONE companion series off its stored rows,
 * sliced server-side to the episode window (mirrors /api/series's `from`/`to` semantics).
 * An id with no stored rows serves the honest empty body (missing-row rule) — the points
 * simply are not there until the cron seeds them.
 */
async function companionGET(
  store: ReadStore,
  id: string,
  params: URLSearchParams,
  { now, warn }: ResolvedSeams,
): Promise<Response> {
  const companion = COMPANIONS[id];
  if (!companion) {
    return Response.json(
      { error: `companion must be one of: ${Object.keys(COMPANIONS).join(", ")}` },
      { status: 400 },
    );
  }
  for (const key of ["from", "to"] as const) {
    const raw = params.get(key);
    if (raw !== null && !COMPANION_DATE_RE.test(raw)) {
      return Response.json({ error: `${key} must be a valid YYYY-MM-DD date` }, { status: 400 });
    }
  }
  const series = await readInputSeries(store, [id], INPUT_ROW_LIMIT, { now });
  const obs = series.get(id);
  if (obs === undefined) warnMissingInput(id, "replay", warn);
  const from = params.get("from");
  const to = params.get("to");
  const body: ReplayCompanionResponse = {
    indicatorId: id,
    label: companion.label,
    unit: companion.unit,
    points: (obs ?? [])
      .filter((o) => (from === null || o.date >= from) && (to === null || o.date <= to))
      .map((o) => ({ date: o.date, value: o.value })),
  };
  // A restricted-source companion is redacted; any other one is served as is.
  if (isLicensedSource(id)) return serveRedactable(body, redactCompanion);
  return Response.json(body, { headers: VINTAGE_HEADERS });
}

/** `handle`'s injectable seams; each default is the production one `GET` runs with. */
export interface ReplaySeams {
  /** The committed HY-OAS vintage the stitch reads (default `loadHyOasVintage`: fail-loud on a corrupt file, `undefined` when absent). */
  vintage?: () => Observation[] | undefined;
  /** The request clock, read once: the input staleness gate and the all-absent `asOf` fallback. */
  now?: Date;
  /** Sink for the missing-input degrade log. */
  warn?: (...args: unknown[]) => void;
}
type ResolvedSeams = { now: Date; warn: (...args: unknown[]) => void };

// `request?` OPTIONAL: callers (scripts/*-probe) call GET() with no arg.
export async function GET(request?: Request): Promise<Response> {
  const env = readEnv();
  return handle(() => getStore("ro", env), request);
}

/** The handler body. The read-handler idiom: a store THUNK, resolved only after the param 400s. */
export async function handle(storeOf: () => ReadStore, request: Request | undefined, opts: ReplaySeams = {}): Promise<Response> {
  const { vintage: loadVintage = loadHyOasVintage, now = new Date(), warn = console.warn } = opts;
  const seams: ResolvedSeams = { now, warn };
  // Companion branch: `?companion=<id>` serves ONE overlay series instead of the episode
  // payload (the api/meta.ts view-router idiom, minus the rewrite — same function).
  const params = request ? new URL(request.url).searchParams : null;
  if (params) {
    const unknown = rejectUnknownParams(params, ["companion", "from", "to"]);
    if (unknown) return unknown;
  }
  const companionId = params?.get("companion") ?? null;
  if (params && companionId !== null) return companionGET(storeOf(), companionId, params, seams);

  // Fail-loud: a corrupt/short vintage throws → 500 (never a degraded 200) — poisoned
  // input must not masquerade as calm data. An absent file → undefined → the F1 leg degrades below.
  const vintage = loadVintage();
  if (vintage === undefined) warn("[replay] HY-OAS vintage file absent - every episode serves empty points");

  // One bulk store read per depth: the price legs at INPUT_ROW_LIMIT, the HY-OAS tail
  // capped at HY_LIVE_TAIL_ROWS — the retired live fetch's window — so the stitch never
  // compares the deep 1996→ overlap, where a routine FRED revision > GROSS_TOLERANCE
  // would 500 this page. An absent id degrades that member (missing-row rule).
  const store = storeOf();
  const [series, hySeries] = await Promise.all([
    readInputSeries(store, ["^GSPC", "ACWI", "IEF"], INPUT_ROW_LIMIT, { now }),
    readInputSeries(store, ["BAMLH0A0HYM2"], HY_LIVE_TAIL_ROWS, { now }),
  ]);
  for (const [id, obs] of hySeries) series.set(id, obs);
  const grab = (id: string): Observation[] | null => {
    const obs = series.get(id);
    if (obs === undefined) {
      warnMissingInput(id, "replay", warn);
      return null;
    }
    return obs;
  };

  const storedTail = grab("BAMLH0A0HYM2");
  const gspc = grab("^GSPC") ?? [];
  const acwi = grab("ACWI") ?? [];
  const iefResult = grab("IEF");
  const ief = iefResult ?? [];
  const iefPresent = iefResult !== null;

  // Only stitch when the vintage AND the stored rows exist — either absent degrades (empty points). A
  // stitch VIOLATION (disagreement/gap) throws here → propagates to a 500.
  const f1 = vintage !== undefined && storedTail !== null ? stitchHyOas(vintage, storedTail).map(toF1Point) : null;

  // FIRE input + splice date computed once, reused across every episode.
  const fire = buildFireSeries(gspc, acwi);
  const spliceDate = fireSpliceDate(acwi);

  const episodes: ExposureReplayEpisodeDTO[] = EPISODES.map((ep) => {
    const points = f1 ? replayExposure(f1, fire, { start: ep.start, end: ep.end }) : [];
    const notes = [...exposureReplayNotes(ep, spliceDate)];

    // Bond-rung (IEF) line: every covered day renders, even when coverage opens
    // mid-window (the 2002 episode opens 2002-03-01, IEF's first close is 2002-07-30) —
    // the B4 eyeball overturned the old "never start mid-crisis" omission; a partial
    // line + the honest inception note beats hiding the bond cost entirely. A window
    // IEF misses altogether gets the absent note; an id missing from the STORE omits
    // the line silently (the old fetch-failure shape — warnMissingInput covered it).
    let defensive: { date: string; price: number }[] | undefined;
    if (iefPresent) {
      const covered = ief
        .filter((o) => o.date >= ep.start && o.date <= ep.end)
        .map((o) => ({ date: o.date, price: round2(o.value) }));
      if (covered.length > 0) {
        defensive = covered;
        if (ief[0]!.date > ep.start) notes.push(iefPartialNote(ief[0]!.date));
      } else {
        notes.push(IEF_ABSENT_NOTE);
      }
    }

    return {
      id: ep.id,
      label: ep.label,
      start: ep.start,
      end: ep.end,
      candidate: ep.candidate,
      rationale: ep.rationale,
      points,
      ...(defensive ? { defensive } : {}),
      notes,
    };
  });

  // asOf = the newest underlying observation across the stored inputs (data freshness),
  // falling back to today when everything is absent.
  const asOf =
    [f1?.at(-1)?.date, gspc.at(-1)?.date, acwi.at(-1)?.date]
      .filter((d): d is string => d !== undefined)
      .sort()
      .at(-1) ?? isoDay(now);

  const body: ExposureReplayResponse = { asOf, episodes };
  return serveRedactable(body, redactReplay);
}
