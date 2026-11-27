/**
 * READ-ONLY: for the newest N EOD dates, the served alert_log row (superseding if present) must equal what
 * `rederiveRun` over the original returns now (twins agree ⇒ the original is served). Exit 1 on any mismatch;
 * an UNVERIFIABLE row (no stored heads, a superseding row served) is reported, never a failure.
 *   npx tsx scripts/probe-rederive.ts --env=prod [--n=5]   (drop `--env=prod` for the local store)
 * A mismatch on an older date = an official correction after that date's cron: `npm run rederive -- --from=<date> --apply`.
 */
import { resolveStore, liveResolveDeps } from "./backfill/resolve-store.js";
import { argOf, envArgStrict } from "./lib/cli.js";
import { rederiveRun, servedMatches, servedWithOriginals } from "../src/rederive.js";

const n = Number(argOf("n") ?? "5");
if (!Number.isInteger(n) || n < 1) {
  console.log(`ABORT: --n must be a positive integer (got ${argOf("n")}).`);
  process.exit(1);
}
const env = envArgStrict("local");
if (env === "local") {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // no .env.local: resolveStore fails loud below
  }
}
const store = await resolveStore(env, "ro", liveResolveDeps);
let bad = 0;
for (const { served, orig } of await servedWithOriginals(store, n)) {
  const kind = served.rederivedFrom == null ? "original" : "superseding";
  try {
    const out = await rederiveRun(store, orig);
    if (out.kind === "unverifiable") {
      console.log(`${orig.date}  UNVERIFIABLE  served ${kind} ${served.level}/${served.dialBand ?? "-"} - ${out.reason}`);
      continue;
    }
    const fresh = out.kind === "superseded" ? out.alert : null;
    const ok = servedMatches(served, orig, fresh);
    if (!ok) bad++;
    console.log(`${orig.date}  ${ok ? "OK      " : "MISMATCH"}  served ${kind} ${served.level}/${served.dialBand ?? "-"}, re-derive ${fresh === null ? "null (original)" : `${fresh.level}/${fresh.dialBand ?? "-"}`}`);
  } catch (err) {
    bad++;
    console.log(`${orig.date}  ERROR     ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log(bad === 0 ? `probe:rederive OK on the ${env} store` : `probe:rederive FAILED: ${bad} date(s)`);
process.exit(bad === 0 ? 0 : 1);
