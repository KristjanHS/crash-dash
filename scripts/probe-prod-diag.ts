/**
 * The prod truth chain in one read-only pass — alias, served deploy, edge cache, the two freshness
 * payloads with their disagreements NAMED, the last cron row, a log tail.
 * Never mutates prod: no cron trigger, no write. Exit 0 always — this reports, it does not gate
 * (`probe:prod-smoke` is the gate).
 */
import { prodBaseUrl } from "./lib/prod-base-url.js";

export {};

/** The prod read alias, resolved at use (`prodBaseUrl`) — never at import. */
const alias = (): string => prodBaseUrl();
const TIMEOUT_MS = 20_000;

const say = (s = "") => console.log(s ? `[diag:prod] ${s}` : "");
const pad = (s: string, n: number) => s.padEnd(n);

async function get(path: string): Promise<{ res: Response; body: string } | { err: string }> {
  try {
    const res = await fetch(`${alias()}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { res, body: await res.text() };
  } catch (err) {
    return { err: err instanceof Error ? err.message : String(err) };
  }
}

/** A `vercel` invocation that reports its own absence instead of throwing — the CLI may be unauthed. */
async function cli(args: readonly string[]): Promise<string | null> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const p = spawn("npx", ["--no-install", "vercel", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), TIMEOUT_MS);
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr.on("data", (d: Buffer) => (out += d.toString()));
    p.on("error", () => (clearTimeout(timer), resolve(null)));
    p.on("close", (code) => (clearTimeout(timer), resolve(code === 0 ? out : null)));
  });
}

const json = (body: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(body);
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

// ── 1. alias · served deploy · edge cache ────────────────────────────────────
say(`alias  ${alias()}`);
const root = await get("/");
if ("err" in root) {
  say(`UNREACHABLE — ${root.err}. Nothing below could be measured.`);
  process.exit(0);
}
const vid = root.res.headers.get("x-vercel-id") ?? "(absent)";
const cache = root.res.headers.get("x-vercel-cache") ?? "(absent)";
say(`root   HTTP ${root.res.status} · x-vercel-id ${vid} · x-vercel-cache ${cache}`);

// ── 2. the two freshness payloads ────────────────────────────────────────────
const [status, lab] = await Promise.all([get("/api/status"), get("/api/lab")]);
say();

/** `/api/status` serves `FeedLagRow[]` (the whole roster); `/api/lab` serves `FeedLagNote[]` (a subset —
 *  one note per feed it could not measure). `age` is the ONLY field both carry: `label` is note-only and
 *  `lag` is row-only, so neither is cross-checkable. */
type Entry = { id: string; age?: number | null; lag?: boolean };
const rowsOf = (p: Record<string, unknown> | null): Entry[] =>
  Array.isArray(p?.feedLag) ? (p.feedLag as Entry[]) : [];

let statusRows: Entry[] = [];
let labRows: Entry[] = [];
/** Non-MISS on either payload ⇒ the two may be snapshots of DIFFERENT vintages, so any cross-payload
 *  gap below is unattributable — cache skew and a real logic disagreement look identical. */
const edgeServed: string[] = [];
const cacheNote = (which: string, hdr: string) => {
  if (hdr === "MISS") return;
  edgeServed.push(`${which} ${hdr}`);
  say(`  ⚠ served from the edge (${hdr}) — these numbers may predate the last cron.`);
  say("  A request Cache-Control header does NOT bust s-maxage; only a MISS proves freshness.");
};

if ("err" in status) say(`/api/status  UNREACHABLE — ${status.err}`);
else {
  const sc = status.res.headers.get("x-vercel-cache") ?? "(absent)";
  const p = json(status.body);
  statusRows = rowsOf(p);
  const v = (p?.verdict ?? {}) as Record<string, unknown>;
  say(`/api/status  HTTP ${status.res.status} · x-vercel-cache ${sc}`);
  say(`  asOf ${String(p?.asOf)} · firedAt ${String(v.firedAt)}`);
  say(
    `  feedsLagging ${String(p?.feedsLagging ?? "(omitted)")} of ${String(p?.feedsTotal ?? "?")}` +
      ` · feedLag rows ${statusRows.length}`,
  );
  cacheNote("/api/status", sc);
}

if ("err" in lab) say(`/api/lab  UNREACHABLE — ${lab.err}`);
else {
  const lc = lab.res.headers.get("x-vercel-cache") ?? "(absent)";
  const p = json(lab.body);
  labRows = rowsOf(p);
  say(`/api/lab  HTTP ${lab.res.status} · x-vercel-cache ${lc}`);
  say(`  freshnessMissing ${String(p?.freshnessMissing)} · feedLag rows ${labRows.length}`);
  if (p?.freshnessMissing === true) {
    say("  ⚠ freshnessMissing: true — the observed census carries NO measurement (degraded serve).");
  }
  cacheNote("/api/lab", lc);
}

// ── 3. name the disagreements ────────────────────────────────────────────────
// Two payloads over ONE stamp with different shapes: status carries the whole roster, lab only the
// feeds it could not measure. A lab note whose status row reads measured is the contradiction (A1).
say();
const S = new Map(statusRows.map((r) => [r.id, r]));
const L = new Map(labRows.map((r) => [r.id, r]));
say(`freshness — status roster ${S.size} row(s) · lab notes ${L.size}`);

const disagree: string[] = [];
for (const [id, l] of L) {
  const s = S.get(id);
  if (!s) {
    disagree.push(`${pad(id, 16)} lab notes it, status roster has NO row`);
    continue;
  }
  if ((s.age ?? null) !== (l.age ?? null))
    disagree.push(`${pad(id, 16)} age  status=${String(s.age)}  lab=${String(l.age)}`);
}
if (L.size === 0) say("  lab served no notes — nothing to cross-check against the roster.");
else if (disagree.length === 0) say("  every lab note AGREES with its status roster row on age.");
else for (const d of disagree) say(`  ${d}`);
if (disagree.length > 0 && edgeServed.length > 0) {
  say(`  ⚠ UNATTRIBUTABLE — ${edgeServed.join(", ")} came off the edge, so the gap(s) above may be cache`);
  say("  skew between two vintages rather than a logic disagreement. Re-run until both read MISS.");
}

// `lag: true` with `age: null` is the ungriddable case — a full window whose calendar will not build.
// The verdict there is asserted, not measured; the roster cannot tell it from a zero-row feed.
const ageless = statusRows.filter((r) => r.lag === true && (r.age ?? null) === null).map((r) => r.id);
say(
  ageless.length > 0
    ? `  lag: true with age: null (UNMEASURED, not fresh-vs-stale): ${ageless.join(", ")}`
    : "  no roster row carries lag: true with a null age.",
);

// ── 4. last cron row + log tail (CLI-gated) ──────────────────────────────────
say();
const deploys = await cli(["ls", "crash-dash", "--prod"]);
const DEPLOYS_SHOWN = 3;
// The CLI prints a banner before the table, so slice by CONTENT (a deployment line names its URL),
// never by line index — a banner change would otherwise silently show zero deployments.
const deployLines = (deploys ?? "")
  .split("\n")
  .filter((l) => l.includes("vercel.app") && !l.startsWith(">"))
  .slice(0, DEPLOYS_SHOWN);
say(
  deployLines.length > 0
    ? `vercel ls --prod (newest ${deployLines.length})\n${deployLines.map((l) => l.trim()).join("\n")}`
    : "vercel ls --prod — CLI unavailable, unauthed, or no production deployment (skipped).",
);

say();
const logs = await cli(["logs", alias()]);
say(logs ? `runtime log tail\n${logs.trim().split("\n").slice(-20).join("\n")}` : "vercel logs — CLI unavailable or unauthed (skipped).");
