/**
 * DB-first rollout falsifier.
 *
 *   npm run probe:db-first-rollout            # prod, read-only (bash scripts/with-prod-config.sh tsx …)
 *
 * After each staged `make ship` of a fullHistory site, the FIRST cron writes the id's whole scored
 * history back; every later run must take the 14-day TAIL arm. The row-count half of that claim is
 * checkable off the DB alone: for each DB-first site, `readings_latest` must hold ≥ its need
 * (`needRowsForSeedDepth` for a FRED id, the 20y calendar floor for a price id like CG) — the comparison `dbFirstOrDirect` makes at run time
 * (`src/series-db-first.ts`). A shortfall means the unchunked first insert was rejected (the cron
 * logs only a `persist failed` degrade line) and the site sits on the deep arm EVERY run.
 * The log half (no `fullHistory` fetch on the 2nd run) is a `vercel logs` grep, not a DB fact.
 *
 * Exit 1 on any shortfall among the SHIPPED sites so the check can actually fail; unshipped sites
 * are listed as `pending` and never fail the run — flip a site to `shipped` in the SAME commit as
 * its `make ship`.
 */
import { needRowsForCalendarDays, needRowsForSeedDepth } from "../src/series-db-first.js";
import { DEEP_LOOKBACK_DAYS } from "../src/lookback.js";
import { BREADTH_LOOKBACK_DAYS } from "../src/registry-price.js";
import { readEnv } from "../src/config.js";

// `needRows` overrides the shared seed-depth row need for a PRICE site (CG stores the HG=F÷GC=F
// ratio) whose own window is deeper — its need is the 20y calendar floor.
// The DB-first roster: the single source of which ids run through the ratio-identity splice. It drives
// this falsifier's row-count check AND scopes `probe-e6b-overlap.ts`'s aliasing guard
// — a new db-first site added here joins both
// automatically. `shipped` gates THIS check's fail behaviour only.
export const DB_FIRST_SITES: ReadonlyArray<{ id: string; series: string; shipped: boolean; needRows?: number; warmup?: boolean }> = [
  { id: "R3", series: "DGS2", shipped: true },
  { id: "R2", series: "DGS10", shipped: true },
  { id: "R1", series: "T10Y3M", shipped: true },
  { id: "R4", series: "DFII10", shipped: true },
  { id: "R5", series: "VIXCLS", shipped: true },
  // `warmup`: the seam counts readings ∪ readings_warmup for CG — mirror it.
  { id: "CG", series: "HG=F÷GC=F", shipped: true, needRows: needRowsForCalendarDays(DEEP_LOOKBACK_DAYS), warmup: true },
  // Breadth raw-close backing ids (§6.2) — price ids, need = the breadth window.
  // SPY is NOT rostered: it is read-only reuse of the pension id, never written by the breadth path.
  { id: "BR_QQQ", series: "QQQ", shipped: true, needRows: needRowsForCalendarDays(BREADTH_LOOKBACK_DAYS) },
  { id: "BR_QQQE", series: "QQQE", shipped: true, needRows: needRowsForCalendarDays(BREADTH_LOOKBACK_DAYS) },
  { id: "BR_RSP", series: "RSP", shipped: true, needRows: needRowsForCalendarDays(BREADTH_LOOKBACK_DAYS) },
];

/** Every rostered db-first id (shipped or not) — the aliasing guard's scope in `probe-e6b-overlap.ts`. */
export const DB_FIRST_IDS: readonly string[] = DB_FIRST_SITES.map((s) => s.id);

async function countRows(url: string, key: string, id: string, table = "readings_latest", extra = ""): Promise<number> {
  const res = await fetch(`${url}/rest/v1/${table}?indicator_id=eq.${id}&select=obs_date${extra}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact", Range: "0-0" },
  });
  if (!res.ok && res.status !== 206) throw new Error(`count ${id}: HTTP ${res.status}`);
  const cr = res.headers.get("content-range") ?? "";
  const total = Number(cr.split("/")[1]);
  if (!Number.isFinite(total)) throw new Error(`count ${id}: unparsable Content-Range "${cr}"`);
  return total;
}

async function countWarmupBelowFirst(url: string, key: string, id: string): Promise<number> {
  const res = await fetch(`${url}/rest/v1/readings_latest?indicator_id=eq.${id}&select=obs_date&order=obs_date.asc&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`first ${id}: HTTP ${res.status}`);
  const first = ((await res.json()) as Array<{ obs_date: string }>)[0]?.obs_date;
  return countRows(url, key, id, "readings_warmup", first === undefined ? "" : `&obs_date=lt.${first}`);
}

async function main(): Promise<void> {
  const { SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key } = readEnv();
  if (!url || !key) throw new Error("SUPABASE_URL + SUPABASE_SERVICE_KEY required (npm run probe:db-first-rollout loads the checkout's prod config)");
  let failed = false;
  for (const s of DB_FIRST_SITES) {
    // Union of distinct dates (the seam's `have=`): count warm-up rows only BELOW the first reading — the head
    // is written below it, but a later deep run off a shorter fetch (or a restate) can leave warm-up rows
    // that overlap `readings`, and nothing deletes them. Bounding keeps the sum equal to the seam's distinct count.
    const have = (await countRows(url, key, s.id)) + (s.warmup ? await countWarmupBelowFirst(url, key, s.id) : 0);
    const need = s.needRows ?? needRowsForSeedDepth();
    const arm = have >= need ? "tail" : "DEEP";
    // `have === 0` on a shipped site is EXPECTED between its `make ship` and the first post-ship cron (nothing
    // has written yet) — and indistinguishable off the DB from a rejected first insert. The verdict names both
    // readings so the pre-cron run is not misread as a defect; it still fails (a falsifier must be able to).
    const verdict = !s.shipped
      ? "pending"
      : have >= need
        ? "ok"
        : have === 0
          ? "EMPTY (expected before the first post-ship cron; after it = the insert was rejected)"
          : "SHORTFALL";
    if (s.shipped && have < need) failed = true;
    console.log(`${s.id.padEnd(3)} ${s.series.padEnd(7)} rows=${String(have).padStart(6)} need=${String(need).padStart(6)} arm=${arm.padEnd(4)} ${verdict}`);
  }
  process.exit(failed ? 1 : 0);
}

// Importing this module (e.g. `probe-e6b-overlap.ts` reads DB_FIRST_IDS) runs NO store read.
const isMain = process.argv[1]?.endsWith("probe-db-first-rollout.ts") ?? false;
if (isMain) await main();
