/**
 * D9 momentum probe — READ-ONLY.
 *
 * Gates D8's severity-space momentum BEFORE the eyeball. `/lab` has a read-API, so the
 * quadrant's numbers are precomputable server-side and must NOT be handed to an eye to
 * squint at. This dumps, for all nine legs:
 *
 *   y_old  — the retired danger-space ROC over the root-scale literal: (danger − dPrev)/0.3
 *   y_new  — the shipped severity-space ROC: clamp((√danger − √dPrev)/√DANGER_CUTS.amber, −1, 1)
 *
 * and flags the two things that would otherwise be misread at the board:
 *
 *   A. CLAMPS — any leg pinned at ±1 (a clamped leg carries no y-axis information).
 *   B. HISTORY PRESENT AT ALL — whether `?hist=20` actually returned momentum. This is the
 *      critical one per D9: with no stored history every legRow's momentum is `undefined` and
 *      the quadrant renders EMPTY — which reads as a formula bug when it is really a DATA GAP.
 *      Distinguishing the two is most of this probe's value.
 *
 * The eye is then left exactly ONE question (`docs/backlog.md` §OWED[USER]): does the mixed-axis
 * quadrant read? (x = danger, cut-coloured; y = d(severity) — D8's accepted cost.)
 *
 * STRICTLY READ-ONLY: drives `api/lab.ts`'s `handle` (GET's body) on a "ro" store, whose live path only selects (getSeries /
 * getLatest). No insert/update/delete/upsert, no migration, no write of any kind.
 *
 * Usage:
 *   npx tsx --env-file-if-exists=.env.local scripts/backtest/d9-momentum-probe.ts [--hist=20] [--env=local|prod]
 * Store resolution mirrors scripts/backfill (resolve-store.ts): SUPABASE_URL+KEY in env → that
 * store; else --env=prod pulls prod creds via the Management API (host). `--env=local` needs the
 * local Supabase stack up. The ladder is hand-rolled here (see the creds block) because api/lab.ts
 * builds its own store from process.env — so all THREE of resolve-store's guards are replicated
 * below, project check included. Change one there, change it here.
 *
 * y_old RECOVERY — read this before trusting a `—` in the y_old column. `dPrev` is a closure
 * local inside `computeField` and is not served, so the probe recovers it from the served
 * momentum by inverting D8's formula: dPrev = (√danger − y_new·√amber)². That inversion is
 * EXACT while |y_new| < 1 and IMPOSSIBLE once the clamp bites (the clamp destroys the
 * information), so a clamped leg prints y_old as `—` and is listed under flag A. Recomputing
 * dPrev locally instead would mean reimplementing engine internals in a probe — the parallel
 * reimplementation the engine's own comments forbid — so the inversion is the honest trade.
 */
import { handle } from "../../api/lab.js";
import { DANGER_CUTS } from "../../src/danger-engine.js";
import { getStore } from "../../src/store.js";
import { pullProdCreds, isLocalUrl, liveResolveDeps } from "../backfill/resolve-store.js";
import { prodProjectRef, projectHost } from "../supabase-project.js";
import { argOf, envArg as envArgOf } from "../lib/cli.js";
import { readEnv, type Env } from "../../src/config.js";

// ---------- args ----------
const HIST = Number(argOf("hist") ?? 20);
const envArg = envArgOf("prod");

// ---------- creds (same precedence ladder + cross-guard as resolve-store) ----------
// Resolved into an env literal `api/lab.ts`'s `handle` reads through a "ro" store thunk — `handle` also takes that
// env (`{ env }`), so the creds land in the env rather than in a `resolveStore(env, "ro")` handle.
let appEnv: Env = readEnv();
const envUrl = appEnv.SUPABASE_URL;
if (envUrl && appEnv.SUPABASE_SERVICE_KEY) {
  const host = (() => {
    try {
      return new URL(envUrl).host;
    } catch {
      return envUrl;
    }
  })();
  if (envArg === "local" && !isLocalUrl(envUrl))
    throw new Error(`[d9-probe] --env=local but SUPABASE_URL points at ${host} — unset it or pass --env=prod`);
  if (envArg === "prod" && isLocalUrl(envUrl))
    throw new Error(`[d9-probe] --env=prod but SUPABASE_URL points at ${host} (local) — unset the local creds`);
  // Third guard, mirroring resolve-store's project check (SCRIPT-9): non-local was never enough.
  if (envArg === "prod") {
    const expected = projectHost(prodProjectRef(appEnv));
    if (host !== expected)
      throw new Error(
        `[d9-probe] --env=prod but SUPABASE_URL points at ${host}, not the expected project ${expected} (set SUPABASE_PROJECT_REF if deliberate)`,
      );
  }
  console.log(`[d9-probe] store: ${host} (--env=${envArg}, creds from env)`);
} else if (envArg === "prod") {
  const { url, key, anonKey } = await pullProdCreds(liveResolveDeps, "ro");
  appEnv = { ...appEnv, SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key, SUPABASE_ANON_KEY: anonKey };
  console.log(`[d9-probe] store: ${new URL(url).host} (--env=prod, creds via Management API)`);
} else {
  throw new Error(
    "[d9-probe] --env=local but no SUPABASE_URL/SUPABASE_SERVICE_KEY — the dev stack defaults DOWN. Re-run as `scripts/db.sh with dev -- <this command>` (or hold it open with `scripts/db.sh up dev`) and populate .env.local",
  );
}

// ---------- drive the real read-API ----------
interface LegRowLike {
  sleeve: string;
  danger: number;
  momentum?: number;
}
const res = await handle(() => getStore("ro", appEnv), new Request(`https://probe.local/api/lab?hist=${HIST}`));
if (!res.ok) throw new Error(`[d9-probe] /api/lab?hist=${HIST} → ${res.status} ${res.statusText}`);
const body = (await res.json()) as { field?: { legRows?: LegRowLike[] } };
const legRows = body.field?.legRows ?? [];

// ---------- flag B: is there any history at all? ----------
const withMomentum = legRows.filter((l) => l.momentum !== undefined);
console.log(`\n=== D9 momentum probe — /api/lab?hist=${HIST} ===`);
console.log(`legs served: ${legRows.length}   legs with momentum: ${withMomentum.length}`);
if (withMomentum.length === 0) {
  console.log(
    `\n⚠ FLAG B — NO MOMENTUM SERVED. Every leg's momentum is undefined, so the /lab View-C quadrant
  renders EMPTY. This is a DATA GAP, not a formula bug: ?hist=${HIST} found no stored member history
  (fresh/unseeded store — seed with \`npm run backfill -- all\`). D8 cannot be eyeballed from this
  store; re-run against one with ≥${HIST}+30 closes of member history before booking the eyeball.`,
  );
  process.exit(0);
}
if (withMomentum.length < legRows.length) {
  console.log(
    `⚠ FLAG B (partial) — ${legRows.length - withMomentum.length} leg(s) have NO momentum: those dots are absent from the
  quadrant for want of history, not for want of deflection.`,
  );
}

// ---------- the dump: y_old vs y_new, all nine legs ----------
const SQRT_AMBER = Math.sqrt(DANGER_CUTS.amber);
const OLD_DIVISOR = 0.3; // the retired root-scale literal, kept HERE only as the probe's baseline
const fmt = (n: number | null, w = 8) => (n === null ? "—" : n.toFixed(4)).padStart(w);

console.log(`\n${"leg".padEnd(14)}${"danger".padStart(8)}${"dPrev".padStart(9)}${"y_old".padStart(9)}${"y_new".padStart(9)}${"  ratio".padStart(9)}  flag`);
console.log("-".repeat(66));

const clamped: string[] = [];
let maxAbsOld = 0;
let maxAbsNew = 0;
for (const l of legRows) {
  const yNew = l.momentum;
  if (yNew === undefined) {
    console.log(`${l.sleeve.padEnd(14)}${fmt(l.danger)}${fmt(null, 9)}${fmt(null, 9)}${fmt(null, 9)}${fmt(null, 9)}  no history`);
    continue;
  }
  const isClamped = Math.abs(yNew) >= 1;
  if (isClamped) clamped.push(l.sleeve);
  // Exact while unclamped; unrecoverable once the clamp bit (see the y_old RECOVERY note above).
  const dPrev = isClamped ? null : (Math.sqrt(l.danger) - yNew * SQRT_AMBER) ** 2;
  const yOld = dPrev === null ? null : Math.max(-1, Math.min(1, (l.danger - dPrev) / OLD_DIVISOR));
  const ratio = yOld === null || yOld === 0 ? null : Math.abs(yNew / yOld);
  maxAbsNew = Math.max(maxAbsNew, Math.abs(yNew));
  if (yOld !== null) maxAbsOld = Math.max(maxAbsOld, Math.abs(yOld));
  console.log(
    `${l.sleeve.padEnd(14)}${fmt(l.danger)}${fmt(dPrev, 9)}${fmt(yOld, 9)}${fmt(yNew, 9)}${
      ratio === null ? "—".padStart(9) : `${ratio.toFixed(2)}×`.padStart(9)
    }  ${isClamped ? "CLAMPED" : ""}`,
  );
}

// ---------- flag A: clamps ----------
console.log("");
if (clamped.length > 0) {
  console.log(`⚠ FLAG A — ${clamped.length} leg(s) CLAMP at ±1: ${clamped.join(", ")}. A clamped dot is pinned to the
  quadrant's edge and carries no y information; y_old is unrecoverable for it (clamp destroys dPrev).`);
} else {
  console.log("FLAG A — no leg clamps: every dot's y is live, the full [−1,1] range is informative.");
}

// ---------- separation: the thing D8 was for ----------
console.log(
  `\nspread |y| — old max ${maxAbsOld.toFixed(4)} · new max ${maxAbsNew.toFixed(4)}` +
    (maxAbsOld > 0 ? ` (${(maxAbsNew / maxAbsOld).toFixed(2)}× the deflection)` : ""),
);
console.log(
  `\nEYEBALL (docs/backlog.md §OWED[USER]) — open /lab with ?hist=${HIST} and answer ONE question: does the
  MIXED-AXIS quadrant read? x = danger (squared scale, cut-coloured) · y = d(severity) (above).
  Expectation baked in: the y values printed above, legs ordered as printed. If the quadrant
  disagrees with these numbers, THAT is a bug; two scales feeling odd to hold is the accepted cost.`,
);
