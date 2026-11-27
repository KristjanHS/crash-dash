/**
 * probe:defleg-live — the live post-deploy e2e.
 *
 * That arc swapped `FAMILY_LEG_WEIGHT` cr↔rt cells (a pin-preserving swap at a 0.15 spread)
 * so the two DEFENSIVE legs stop tracking each other. The swap is read at COMPUTE time — `api/lab.ts`
 * runs `computeField` live on every read — so a prod `/api/lab` GET runs the DEPLOYED weights and is a
 * genuine post-deploy falsifier. (Contrast `scripts/probe-leg-ordering.ts`, which computes
 * counterfactuals from live series LOCALLY and so returns the same answer before and after a deploy —
 * it cannot witness a deployment. This probe deliberately reads the served number, not a local recompute.)
 *
 * SHAPE: the VERDICT is pure — `verdict(body, cache)` maps a served `/api/lab` body + its `x-vercel-cache`
 * to an exit code + printable lines, with NO fetch and NO process.exit. `main()` does the IO (fetch → verdict
 * → print → exit) and runs ONLY when this file is the CLI entry, so `verdict` is drivable in-process.
 *
 * THREE DISTINCT EXITS (§4.4 ruling 2):
 *   0  PASS         — the two defensive legs' `danger` DIFFER on an EW-led close (pre-swap EW was
 *                     bit-identical) —
 *                     cache-independent: the swap is live on prod.
 *   1  FAIL         — the two are bit-identical, the read is PROVABLY FRESH, and the close is
 *                     EW-led — the EW swap SHOULD have separated them and did not. Prod is still
 *                     serving the pre-swap weights.
 *   2  INCONCLUSIVE — no PASS/FAIL verdict is warranted. Sub-reasons, printed:
 *                     (a) NON-EW-LED — STRESS-NOW, the gated trend or gp wins the worst-of max on ≥1
 *                         defensive leg, so the pair ties BY DESIGN (SN-led:
 *                         137/484 closes measured A/A; trend-led: 2026-11-05/06, trend=1.0 on both). Reporting this
 *                         by-design tie as a PASS would be vacuous by construction; this is the specific failure mode the probe
 *                         exists to avoid.
 *                     (b) NOT PROVABLY FRESH — the two are identical but `x-vercel-cache` is not MISS/
 *                         REVALIDATED, so the read may predate the deploy and cannot indict prod.
 *
 * EDGE CACHE: plain `/api/lab` carries `Cache-Control: s-maxage=86400` (`VINTAGE_HEADERS`, src/api/http.ts),
 * purged per cron run via `Vercel-Cache-Tag: vintage`. A `Cache-Control: no-cache` REQUEST header does NOT
 * bust `s-maxage`, and an UNKNOWN query param (`?cb=N`) is rejected 400 by `rejectUnknownParams` — so there
 * is no client-side buster here. Freshness is PROVEN off `x-vercel-cache` (MISS/REVALIDATED = the edge just
 * ran the deployed function). Run this right after `make ship`'s cron re-derive, which purges the tag and
 * guarantees the first read MISSes. A HIT/STALE read is reported as such and never yields a FAIL.
 */
import { pathToFileURL } from "node:url";

import { pillarValue } from "../src/danger-engine.js";
import type { SubDangersDTO } from "../src/api/types.js";
import { LEG_FIELD } from "../src/danger-ladder.js";
import { DANGER_CUTS } from "../src/danger-concentration.js";
import { prodBaseUrl } from "./lib/prod-base-url.js";

/** The prod read alias, resolved at use (`prodBaseUrl`) — never at import. */
const alias = (): string => prodBaseUrl();

// Exit codes — the three distinct outcomes.
const PASS = 0;
const FAIL = 1;
const INCONCLUSIVE = 2;

const TAG = "[probe:defleg-live]";

/** The subject pair, DERIVED from the shipped roster (never hard-coded): the ladder's defensive legs. */
const DEFENSIVE = LEG_FIELD.filter((l) => l.riskClass === "defensive").map((l) => l.sleeve);

interface LegRowLite {
  sleeve: string;
  danger: number;
  /** The SERVED shape (`SubDangersDTO`, a pinned alias of the engine's `SubDangers`) — never a hand copy, so a
   *  new engine term reaches `NON_EW_TERMS` below as a tsc error. */
  subDangers: SubDangersDTO;
}
interface LabLite {
  asOf?: string;
  field: { legRows: LegRowLite[]; held: { sleeve: string } | null };
}

/** `x-vercel-cache` values that mean the edge just RAN the function (deployed code produced this body). */
const FRESH_CACHE = new Set(["MISS", "REVALIDATED"]);

/** A NON-EW lead = a term other than EARLY-WARN WINS the worst-of max for this leg. `danger` is
 *  `max(ewV, snV, trend, gp)` (`SubDangers`, src/danger-engine.ts) — so a term wins iff `danger === term`. All
 *  sides come off the SAME served compute, so the equality is exact; `pillarValue` (the shipped narrowing seam)
 *  supplies `snV`, treating a non-live pillar as 0, and a null trend/gp reads 0, exactly as `danger` does. The
 *  swap only touches EARLY-WARN weights, so when SN, gp or a swap-proof gated trend wins, the EW swap cannot
 *  move `danger`: a by-design tie. (2026-11-05/06: a trend term at 1.0 saturated BOTH defensive legs — the probe
 *  predated the trend/gp terms and read that tie as "pre-swap weights".) EW tying the winner still counts as a
 *  non-EW lead — conservative: the swap could not have moved a max another term also holds. */
const snV = (r: LegRowLite) => pillarValue(r.subDangers.stressNow) ?? 0;
const ewV = (r: LegRowLite) => pillarValue(r.subDangers.earlyWarn) ?? 0;
// The trend gate is `min(1, max(ew, sn) / DANGER_CUTS.amber)` (`trendGateFactor`): EW moves it while the gate is part-open
// and EW drives it, so only a full or SN-driven gate makes a TREND lead swap-proof.
const trendSwapProof = (r: LegRowLite) => Math.max(ewV(r), snV(r)) >= DANGER_CUTS.amber || snV(r) >= ewV(r);
/** Every non-EW `SubDangers` term → its printed label + its swap-proof value. Keyed off the served type via
 *  `satisfies`, so a new engine term is a tsc error here until the probe decides how it leads. Key order IS the
 *  tie-break order (first match wins in `nonEwLead`): STRESS-NOW, then TREND, then GP. */
const NON_EW_TERMS = {
  stressNow: { label: "STRESS-NOW", value: snV },
  trend: { label: "TREND", value: (r: LegRowLite) => (trendSwapProof(r) ? (r.subDangers.trend ?? 0) : 0) },
  gp: { label: "GP", value: (r: LegRowLite) => r.subDangers.gp ?? 0 },
} as const satisfies Record<Exclude<keyof SubDangersDTO, "earlyWarn">, { label: string; value: (r: LegRowLite) => number }>;
type NonEwLabel = (typeof NON_EW_TERMS)[keyof typeof NON_EW_TERMS]["label"];

/** ⚠ `term > 0` is NOT redundant. On an all-calm close `danger === 0` and every absent term reads 0, so a
 *  bare `danger === term` would report a 0/0 tie as non-EW-led. The VERDICT would still be right (a 0/0 tie
 *  cannot witness the swap either) but the printed reason would be wrong; `allCalm` below carries that case. */
export function nonEwLead(r: LegRowLite): NonEwLabel | null {
  return Object.values(NON_EW_TERMS).find((t) => { const v = t.value(r); return v > 0 && r.danger === v; })?.label ?? null;
}
const nonEwLed = (r: LegRowLite) => nonEwLead(r) !== null;
const allCalm = (r: LegRowLite) => r.danger === 0;

/**
 * The PURE verdict: a served `/api/lab` body + its `x-vercel-cache` → the exit code and the lines to print.
 * NO fetch, NO process.exit — `main()` owns the IO; the test drives this directly, no subprocess.
 */
/** `url` only labels the log line (the CLI passes the fetched URL) — the verdict reads no config. */
export function verdict(body: LabLite, cache: string, url = "/api/lab"): { code: number; lines: string[] } {
  const lines: string[] = [];
  const log = (s: string) => lines.push(s);
  const fresh = FRESH_CACHE.has(cache.toUpperCase());

  const legOf = (sleeve: string): LegRowLite => {
    const row = body.field?.legRows?.find((l) => l.sleeve === sleeve);
    if (!row) throw new Error(`${TAG} served /api/lab has no leg row for "${sleeve}"`);
    return row;
  };

  const held = body.field?.held?.sleeve ?? "(none)";

  if (DEFENSIVE.length !== 2) {
    log(`${TAG} expected exactly 2 defensive legs in LEG_FIELD, found ${DEFENSIVE.length}: ${DEFENSIVE.join(", ")}`);
    return { code: INCONCLUSIVE, lines };
  }
  const [a, b] = DEFENSIVE.map(legOf) as [LegRowLite, LegRowLite];

  const line = (r: LegRowLite) =>
    `${r.sleeve.padEnd(8)} danger=${r.danger.toFixed(6)}  EW=${ewV(r).toFixed(6)}  SN=${snV(r).toFixed(6)}  ` +
    `trend=${(r.subDangers.trend ?? 0).toFixed(6)}  gp=${(r.subDangers.gp ?? 0).toFixed(6)}  winner=${nonEwLead(r) ?? "EARLY-WARN"}`;

  log(`${TAG} ${url}  asOf=${body.asOf ?? "?"}  x-vercel-cache=${cache} (${fresh ? "PROVABLY FRESH" : "may be cached"})`);
  log(`${TAG} defensive pair (LEG_FIELD riskClass=defensive): ${DEFENSIVE.join(", ")}`);
  log(`    ${line(a)}`);
  log(`    ${line(b)}`);
  log(`${TAG} held leg: ${held}`);

  const differ = a.danger !== b.danger;
  const nonEwDominated = nonEwLed(a) || nonEwLed(b);
  const leads = [a, b].filter(nonEwLed).map((r) => `${r.sleeve}=${nonEwLead(r)}`).join(" & ");

  if (differ && !nonEwDominated) {
    log(`${TAG} VERDICT=PASS`);
    log(
      `${TAG} PASS — the defensive legs carry DIFFERENT danger on an EW-LED close ` +
        `(${a.sleeve} ${a.danger.toFixed(6)} ≠ ${b.sleeve} ${b.danger.toFixed(6)}). ` +
        `A differing pair can only be produced by post-swap weights (pre-swap: bit-identical), so this is ` +
        `cache-independent. The cr↔rt swap is LIVE on prod. held=${held}.`,
    );
    return { code: PASS, lines };
  }

  // ⛔ Separated, but a non-EW term (SN / trend / gp) leads. This is NOT a PASS, and the asymmetry is the reason:
  // the two defensive legs also carry SIX differing `MEMBER_WEIGHT` rows (equity-vol / trend /
  // EM-credit — all SN, trend and exo families), none of them touched by the cr↔rt swap. A regime
  // where one of those asymmetric members both LEADS the worst-of and differs across the pair would
  // separate Health from Staples with the pre-swap weights still deployed. Treating that as a PASS
  // would be a FALSE GREEN on the exact question this probe exists to answer, so the separation is
  // only admissible as evidence when EARLY-WARN — the family the swap actually moves — is leading.
  if (differ) {
    log(`${TAG} VERDICT=INCONCLUSIVE (separated, but non-EW-led: ${leads})`);
    log(
      `${TAG} INCONCLUSIVE — the pair SEPARATES (${a.sleeve} ${a.danger.toFixed(6)} ≠ ` +
        `${b.sleeve} ${b.danger.toFixed(6)}) but a non-EW term wins the worst-of max (${leads}), and the ` +
        `cr↔rt swap touches only EARLY-WARN weights. The six asymmetric MEMBER_WEIGHT rows in the SN / ` +
        `trend / exo families can separate these legs WITHOUT the swap, so this separation does not ` +
        `witness it. Re-run on an EW-led close. held=${held}.`,
    );
    return { code: INCONCLUSIVE, lines };
  }

  // From here the two are bit-identical.
  if (allCalm(a) && allCalm(b)) {
    log(`${TAG} VERDICT=INCONCLUSIVE (all-calm close)`);
    log(
      `${TAG} INCONCLUSIVE — both defensive legs read danger=0, so NO pillar is leading and there is ` +
        `nothing for the swap to move. A 0/0 tie cannot witness the swap in either direction. ` +
        `Re-run on a close where the defensive legs carry danger. held=${held}.`,
    );
    return { code: INCONCLUSIVE, lines };
  }

  if (nonEwDominated) {
    log(`${TAG} VERDICT=INCONCLUSIVE (non-EW-led: ${leads})`);
    log(
      `${TAG} INCONCLUSIVE — NON-EW-LED close: a term other than EARLY-WARN wins the worst-of max on ` +
        `${leads}, so the pair ties BY DESIGN ` +
        `(the swap touches only EARLY-WARN weights; when SN / trend / gp leads, danger cannot move). This is NOT a PASS ` +
        `and NOT a FAIL — an earlier audit measured 137/484 ` +
        `closes A/A for exactly this reason. Re-run on a ` +
        `separating (EW-led) close. held=${held}.`,
    );
    return { code: INCONCLUSIVE, lines };
  }

  if (!fresh) {
    log(`${TAG} VERDICT=INCONCLUSIVE (not provably fresh)`);
    log(
      `${TAG} INCONCLUSIVE — the defensive legs are identical and EW-led, which WOULD indict prod, ` +
        `but the read is not provably fresh (x-vercel-cache=${cache}); it may predate the deploy. Cannot ` +
        `indict prod on a cached body. Re-run right after \`make ship\`'s cron re-derive (it purges the ` +
        `\`vintage\` cache tag, so the first read MISSes). held=${held}.`,
    );
    return { code: INCONCLUSIVE, lines };
  }

  log(`${TAG} VERDICT=FAIL`);
  log(
    `${TAG} FAIL — the defensive legs carry BIT-IDENTICAL danger (${a.danger.toFixed(6)}) on a PROVABLY-FRESH, ` +
      `EW-LED close (no SN / trend / gp term wins on either leg). The cr↔rt swap should have separated them and did ` +
      `not — prod is STILL SERVING THE PRE-SWAP WEIGHTS. held=${held}.`,
  );
  return { code: FAIL, lines };
}

/** CLI: fetch prod's `/api/lab`, run `verdict`, print, exit with its code. */
async function main(): Promise<void> {
  const url = `${alias()}/api/lab`;
  const res = await fetch(url, {
    headers: { "Cache-Control": "no-cache" }, // best-effort only — does NOT bust s-maxage; see docblock.
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    console.log(`${TAG} could not read prod: /api/lab → HTTP ${res.status}`);
    process.exit(INCONCLUSIVE);
  }

  const cache = (res.headers.get("x-vercel-cache") ?? "ABSENT").toUpperCase();
  const body = (await res.json()) as LabLite;
  const { code, lines } = verdict(body, cache, url);
  for (const l of lines) console.log(l);
  process.exit(code);
}

// Run the fetch → verdict → exit shell ONLY as the CLI entry, so importing this file (the test) does not
// hit the network or kill the runner.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
