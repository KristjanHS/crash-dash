/**
 * B-10b vintage audit — how many stored VIX/VIX3M rows are MIS-DATED?
 *
 * An earlier commit stopped the bug (`src/tracks.ts` now dates the rows by `v.asOf`, the feed's own
 * date, not the run's `asOf`), but it did NOT repair rows already written. This probe SIZES
 * that residue so the re-seed decision is made on the shape, not a guess.
 *
 * Method: for each obs_date the store holds a VIX / VIX3M reading, compare the stored value
 * against what the LIVE closes provider ^VIX/^VIX3M series says that same date's close actually was.
 *   · stored == feed(date)      → CLEAN
 *   · stored == feed(otherDate) → MIS-DATED, and we name the date the value really belongs to
 *   · no feed row for the date  → UNCHECKABLE (feed window doesn't reach back that far)
 *
 * Reads `readings_latest` (one row per (indicator_id, obs_date), latest run_at) — the same
 * vintage every consumer sees. Shadowed rows underneath are never read by a consumer, so a clean
 * `readings_latest` IS a clean dashboard even while bad rows sit on disk awaiting the prune.
 *
 * `--raw` audits EVERY vintage in `readings` instead, shadowed rows included. That is both the
 * residue-sizing view and this probe's proof it CAN go red: the known-bad 2026-07-17 row (holding
 * 07-10's close) is shadowed, so it is invisible to the default mode and must surface here.
 *
 * READ-ONLY. It writes nothing and repairs nothing, by design.
 *
 * Usage:
 *   bash scripts/with-prod-config.sh tsx scripts/probe-vix-vintage.ts [--raw]   # prod; dev: tsx --env-file=.env.local …
 */
import { createClient } from "@supabase/supabase-js";
import { fetchVixSeries, VIX_SYMBOL, VIX3M_SYMBOL } from "../src/vix_term.js";
import { realFeeds } from "../src/feed-ports.js";
import { paginateRows } from "../src/store-guards.js";
import { POSTGREST_MAX_ROWS } from "../src/store.js";
import { readEnv } from "../src/config.js";

const env = readEnv();

const url = env.SUPABASE_URL;
const key = env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.error("need SUPABASE_URL + SUPABASE_SERVICE_KEY — run it through `bash scripts/with-prod-config.sh tsx …` (prod) or with --env-file=.env.local (dev)");
  process.exit(1);
}

const db = createClient(url, key);
const raw = process.argv.includes("--raw");
const source = raw ? "readings" : "readings_latest";

/**
 * ⚠ Compare doubles with a TOLERANCE, never `===` (a known trap, hit again authoring this
 * probe): PostgREST serializes the stored `double precision` to 15 significant digits, so the feed's
 * `21.18000030517578` comes back as `21.1800003051758` and a bit-exact test reports every single row
 * as a mismatch — 879 phantom hits. The real signature is a WHOLE-POINT gap (07-17 holding 07-10's
 * close), orders of magnitude outside this bound.
 */
const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

interface Row {
  obs_date: string;
  value: number;
  run_at: string;
}

async function audit(indicatorId: string, symbol: string) {
  // ⚠ PostgREST caps EVERY response at `POSTGREST_MAX_ROWS` REGARDLESS of `.limit(n)`
  // (`src/store.ts`), and this query orders obs_date ASCENDING — so a silent truncation would
  // drop the NEWEST rows, which is exactly where the mis-dating lives. Page it to completeness
  // with the repo's own helper rather than trusting a big `.limit()`.
  const rows = (await paginateRows<Row>(async (offset, count) => {
    const { data, error } = await db
      .from(source)
      .select("obs_date, value, run_at")
      .eq("indicator_id", indicatorId)
      .order("obs_date", { ascending: true })
      .order("run_at", { ascending: true })
      .range(offset, offset + count - 1);
    if (error) throw error;
    return (data ?? []);
  }, 200_000));

  const feed = await fetchVixSeries(symbol, (s) => realFeeds.fetchSeries(s, { now: new Date(), env }));
  // ⚠ THE VACUITY GUARD. `fetchVixSeries` DEGRADES TO `[]` on any error (non-200, timeout,
  // a closes-feed 429, parse failure — it warns and returns, never throws). With an empty feed every
  // row falls into UNCHECKABLE, `bad` stays 0, and this probe prints a confident ✅ that is
  // indistinguishable from a real pass — a green reachable by feed loss alone. Caught in review
  // by replaying the two known-bad rows through the classifier: RED with a live feed, GREEN with
  // a degraded one. Fail loud instead, and require the checkable window to be non-trivial.
  if (feed.length === 0) {
    throw new Error(
      `${symbol}: feed returned 0 points — fetchVixSeries degraded (it swallows errors and returns []). ` +
        `REFUSING to audit: an empty feed makes every row UNCHECKABLE and manufactures a false ✅.`,
    );
  }
  const byDate = new Map(feed.map((o) => [o.date, o.value]));
  // Reverse lookup: which date(s) does the feed actually assign this value? Lets a mis-dated row
  // name its true home, which is what tells a re-seed how far the damage reaches. Linear rather
  // than a Map because the match is by tolerance, not by key identity (see `same`).
  const datesHolding = (v: number) => feed.filter((o) => same(o.value, v)).map((o) => o.date);

  const clean: Row[] = [];
  const misdated: Array<{ row: Row; belongsTo: string[] }> = [];
  const mismatch: Row[] = [];
  const uncheckable: Row[] = [];

  for (const r of rows) {
    const truth = byDate.get(r.obs_date);
    if (truth === undefined) {
      uncheckable.push(r);
    } else if (same(r.value, truth)) {
      clean.push(r);
    } else {
      const homes = datesHolding(r.value);
      if (homes.length) misdated.push({ row: r, belongsTo: homes });
      else mismatch.push(r);
    }
  }

  if (rows.length >= POSTGREST_MAX_ROWS && clean.length + misdated.length + mismatch.length === 0) {
    throw new Error(`${indicatorId}: ${rows.length} rows but ZERO checkable — the audit proved nothing.`);
  }

  console.log(`\n=== ${indicatorId} (${symbol}) — source ${source} ===`);
  console.log(
    `${rows.length} row(s) · feed covers ${feed.length} date(s) (${feed[0]?.date} … ${feed.at(-1)?.date})`,
  );
  // ⚠ Report the RECENT tail separately. "100% clean over 503 dates" reads as ~500 dates of
  // evidence, but the bug only ever wrote at the run's current FRED-driven asOf — the newest
  // obs_dates. Older rows in `readings_latest` were unreachable by the defect and are clean by
  // construction, not by test. The last-30 line is the number that actually carries the verdict.
  const recent = new Set(feed.slice(-30).map((o) => o.date));
  const recentChecked = clean.filter((r) => recent.has(r.obs_date)).length;
  const recentBad = misdated.filter((m) => recent.has(m.row.obs_date)).length;
  console.log(
    `  recent tail (last 30 feed dates — the only window the defect could reach): ${recentChecked} clean, ${recentBad} mis-dated`,
  );
  console.log(
    `  CLEAN ${clean.length} · MIS-DATED ${misdated.length} · UNEXPLAINED ${mismatch.length} · UNCHECKABLE ${uncheckable.length}`,
  );
  for (const m of misdated) {
    console.log(
      `  ✗ obs_date ${m.row.obs_date} holds ${m.row.value} — the feed dates that value ${m.belongsTo.join(", ")} (run_at ${m.row.run_at})`,
    );
  }
  for (const m of mismatch) {
    console.log(
      `  ? obs_date ${m.obs_date} holds ${m.value}, feed says ${byDate.get(m.obs_date)} — value not found anywhere in the feed window`,
    );
  }
  return misdated.length + mismatch.length;
}

const bad = (await audit("VIX", VIX_SYMBOL)) + (await audit("VIX3M", VIX3M_SYMBOL));
console.log(
  `\n${bad === 0 ? "✅ no mis-dated rows in the feed-checkable window" : `⚠ ${bad} bad row(s) — decide re-seed on this shape`}`,
);
// Exit non-zero on findings so this is wirable into `make verify`/CI, not only eyeballable.
process.exit(bad === 0 ? 0 : 1);
