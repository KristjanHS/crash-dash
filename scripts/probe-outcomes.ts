/**
 * Weekly outcome monitor: PSI mobile lab run on `/overview`
 * + the `probe-load-budget` Hobby-cap projection, judged against EXTERNAL limits — a breach means refactor,
 * never edit a limit. Alert → ntfy + exit 1; warn → low-priority ntfy, exit 0; green → priority-1 heartbeat
 * (absent on a Monday = monitor dead); crash → priority-4 ntfy + exit 1. A failed PSI call (Google-side
 * timeout/429/unreadable result) is a WARN row, not a crash — the cap rows still report.
 *
 *   npm run probe:outcomes -- [--base=<url>] [--dry]      (env: PSI_API_KEY optional, NTFY_TOPIC)
 */
import { ntfyPushEnabled, pushNtfy, type NtfyMessage } from "../src/ntfy.js";
import { HOBBY_CAPS, parseArgs, project, sampleHotSet, type Projection } from "./probe-load-budget.js";
import { readEnv, type Env } from "../src/config.js";

/** Google Core Web Vitals "good" (web.dev/vitals); TBT is the lab stand-in for INP. */
export const PSI_GOOD = { lcpMs: 2500, tbtMs: 200, cls: 0.1 } as const;
/** Anonymous `/` and `/lab` `location.replace` here — the only page PSI can paint. */
export const PSI_PATH = "/overview";
export const CAP_WARN = 0.5;
export const CAP_ALERT = 1;

export type Psi = { lcpMs: number; tbtMs: number; cls: number };
export type Level = "ok" | "warn" | "alert" | "info";
/** `pct` = share of a Hobby cap (cap rows only) — the heartbeat reports the largest. */
export type Finding = { metric: string; value: string; limit: string; level: Level; pct?: number };

/** Throws on a missing audit — the caller turns it into a WARN row, never a silent green. */
export function psiMetrics(json: unknown): Psi {
  const audits = (json as { lighthouseResult?: { audits?: Record<string, { numericValue?: unknown }> } })?.lighthouseResult?.audits;
  const num = (id: string) => {
    const v = audits?.[id]?.numericValue;
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`PSI result carries no numeric '${id}'`);
    return v;
  };
  return { lcpMs: num("largest-contentful-paint"), tbtMs: num("total-blocking-time"), cls: num("cumulative-layout-shift") };
}

const pctOf = (v: number, cap: number) => `${Math.round((100 * v) / cap)}%`;
const frac = (v: number, cap: number) => Math.round((100 * v) / cap);
const capLevel = (v: number, cap: number): Level => (v >= CAP_ALERT * cap ? "alert" : v >= CAP_WARN * cap ? "warn" : "ok");

/** `psi` as an Error = PSI unmeasured this run: one WARN row in place of the three vitals rows. */
export function judge(psi: Psi | Error, proj: Projection): Finding[] {
  const psiRow = (metric: string, v: number, good: number, fmt: (x: number) => string): Finding => ({
    metric: `PSI ${PSI_PATH} ${metric}`,
    value: fmt(v),
    limit: `<= ${fmt(good)}`,
    level: v > good ? "alert" : "ok",
  });
  const ms = (x: number) => `${Math.round(x)} ms`;
  const gb = (x: number) => `${(x / 1024 ** 3).toFixed(1)} GB`;
  const psiRows: Finding[] =
    psi instanceof Error
      ? [{ metric: `PSI ${PSI_PATH}`, value: `unmeasured (${psi.message.slice(0, 200)})`, limit: "a readable PSI run", level: "warn" }]
      : [
          psiRow("LCP", psi.lcpMs, PSI_GOOD.lcpMs, ms),
          psiRow("TBT", psi.tbtMs, PSI_GOOD.tbtMs, ms),
          psiRow("CLS", psi.cls, PSI_GOOD.cls, (x) => x.toFixed(3)),
        ];
  return [
    ...psiRows,
    { metric: "edge requests/mo", value: pctOf(proj.edgeRequests, HOBBY_CAPS.edgeRequestsPerMonth), limit: "1 M", level: capLevel(proj.edgeRequests, HOBBY_CAPS.edgeRequestsPerMonth), pct: frac(proj.edgeRequests, HOBBY_CAPS.edgeRequestsPerMonth) },
    { metric: "transfer/mo", value: `${gb(proj.transferBytes)} (${pctOf(proj.transferBytes, HOBBY_CAPS.transferBytesPerMonth)})`, limit: "100 GB", level: capLevel(proj.transferBytes, HOBBY_CAPS.transferBytesPerMonth), pct: frac(proj.transferBytes, HOBBY_CAPS.transferBytesPerMonth) },
    // ALL-MISS invocations are never green by construction — print, never alert (ruling 7).
    { metric: "invocations/mo (ALL-MISS)", value: pctOf(proj.missInvocations, HOBBY_CAPS.functionInvocationsPerMonth), limit: "1 M", level: "info" },
    Number.isFinite(proj.cpuSeconds)
      ? { metric: "active CPU/mo (key expiries)", value: pctOf(proj.cpuSeconds, HOBBY_CAPS.activeCpuSecondsPerMonth), limit: "4 h", level: capLevel(proj.cpuSeconds, HOBBY_CAPS.activeCpuSecondsPerMonth), pct: frac(proj.cpuSeconds, HOBBY_CAPS.activeCpuSecondsPerMonth) }
      : { metric: "active CPU/mo (key expiries)", value: "n/a (no MISS or no HIT baseline observed)", limit: "4 h", level: "info" },
  ];
}

export function worst(findings: readonly Finding[]): "ok" | "warn" | "alert" {
  if (findings.some((f) => f.level === "alert")) return "alert";
  return findings.some((f) => f.level === "warn") ? "warn" : "ok";
}

export const renderFinding = (f: Finding) => `${f.level.toUpperCase().padEnd(5)} ${f.metric}: ${f.value} (limit ${f.limit})`;

/** Every run pushes: alert/warn list the breaches; green is the priority-1 heartbeat (N2+N4). */
export function outcomeMessage(findings: readonly Finding[]): NtfyMessage {
  const level = worst(findings);
  if (level === "ok") {
    const top = findings.filter((f) => f.pct != null).reduce<Finding | undefined>((a, f) => (a && a.pct! >= f.pct! ? a : f), undefined);
    return { title: "crash-dash outcome monitor OK", body: top ? `worst: ${top.metric} ${top.pct}% of cap` : "no cap rows", tags: "white_check_mark", priority: 1 };
  }
  return {
    title: `crash-dash outcome monitor: ${level.toUpperCase()}`,
    body: findings.filter((f) => f.level === "alert" || f.level === "warn").map(renderFinding).join("\n") + "\nBreach = refactor to fit; never raise the limit.",
    tags: level === "alert" ? "rotating_light" : "warning",
    priority: level === "alert" ? 4 : 2,
  };
}

export const crashMessage = (e: unknown): NtfyMessage => ({
  title: "crash-dash outcome monitor CRASHED",
  body: (e instanceof Error ? e.message : String(e)).slice(0, 500),
  tags: "boom",
  priority: 4,
});

// ─── IO shell ────────────────────────────────────────────────────────────────────────────

async function fetchPsi(base: string, env: Env): Promise<Psi> {
  const q = new URLSearchParams({ url: base + PSI_PATH, strategy: "mobile", category: "performance" });
  const key = env.PSI_API_KEY?.trim();
  if (key) q.set("key", key);
  const res = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${q}`, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`PSI ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
  return psiMetrics(await res.json());
}

async function main(env: Env): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  // A blank secret would drop a WARN (exit 0) with no channel at all.
  if (!argv.includes("--dry") && !ntfyPushEnabled(env)) throw new Error("NTFY_TOPIC is blank — set the repo secret (or pass --dry)");
  const psi = await fetchPsi(args.base, env).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
  const { pages, samples, warmHitMs } = await sampleHotSet(args);
  const findings = judge(psi, project(pages, samples, args, warmHitMs));
  const level = worst(findings);
  console.log(`== outcomes @ ${args.audience} audience + ${args.owners} owners × ${args.loads} loads/day → ${level.toUpperCase()}`);
  for (const f of findings) console.log(`  ${renderFinding(f)}`);
  if (!argv.includes("--dry")) await pushNtfy(outcomeMessage(findings), { env });
  if (level === "alert") process.exitCode = 1;
}

if (process.argv[1] && /probe-outcomes\.ts$/.test(process.argv[1])) {
  const env = readEnv();
  main(env).catch(async (e) => {
    console.error(e instanceof Error ? e.message : e);
    // Best-effort: a failed push must not mask the original error (N3).
    if (!process.argv.includes("--dry") && ntfyPushEnabled(env)) await pushNtfy(crashMessage(e), { env }).catch((pe) => console.error(`crash ntfy failed: ${pe instanceof Error ? pe.message : pe}`));
    process.exit(1);
  });
}
