/** Replays every hook-asked tool call in the crash-dash transcripts through a guard-ask hook and prints its decision,
 *  then audits every `Guard-loosened` trailer since `--since` (`trailerAudit`).
 *  Usage: `npm run probe:guard-ask -- [--hook=<path>] [--since=YYYY-MM-DD] [--full]`. */
import { spawnSync } from "node:child_process";
import { createReadStream, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { trailerAudit } from "./guard-loosen.js";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const HOOK = arg("hook") ?? ".claude/hooks/guard-ask.sh";
const SINCE = arg("since") ?? "2026-11-04";
const ROOT = join(homedir(), ".claude/projects");

type Use = { name: string; input: Record<string, unknown> };
type Asked = { ts: string; cwd: string; use: Use };

async function askedCalls(file: string): Promise<Asked[]> {
  const uses = new Map<string, Use>();
  const asked: Asked[] = [];
  for await (const line of createInterface({ input: createReadStream(file) })) {
    if (!line.includes('"tool_use"') && !line.includes("hook:PreToolUse")) continue;
    const rec = JSON.parse(line) as { message?: { content?: unknown }; permissionDecision?: { reasonCode?: string }; timestamp?: string; cwd?: string };
    const content = Array.isArray(rec.message?.content) ? (rec.message.content as Record<string, unknown>[]) : [];
    for (const c of content) if (c.type === "tool_use") uses.set(String(c.id), { name: String(c.name), input: c.input as Record<string, unknown> });
    if (rec.permissionDecision?.reasonCode !== "hook:PreToolUse" || (rec.timestamp ?? "") < SINCE) continue;
    const use = uses.get(String(content.find((c) => c.type === "tool_result")?.tool_use_id));
    if (use) asked.push({ ts: rec.timestamp ?? "", cwd: rec.cwd ?? "", use });
  }
  return asked;
}

function decide({ cwd, use }: Asked): { decision: string; reason: string } {
  const { IMPAG_STAGE: _, ...env } = process.env;
  const r = spawnSync(HOOK, {
    input: JSON.stringify({ tool_name: use.name, tool_input: use.input, cwd, session_id: "replay" }),
    encoding: "utf8",
    env: { ...env, CLAUDE_PROJECT_DIR: cwd, GUARD_ASK: "1" },
  });
  const out = r.stdout.trim() ? (JSON.parse(r.stdout) as { hookSpecificOutput: Record<string, string | undefined> }).hookSpecificOutput : undefined;
  if (!out) return { decision: "allow", reason: "" };
  return out.permissionDecision ? { decision: out.permissionDecision, reason: out.permissionDecisionReason ?? "" } : { decision: "note", reason: out.additionalContext ?? "" };
}

const files = readdirSync(ROOT, { recursive: true, encoding: "utf8" }).filter((f) => f.includes("crash-dash") && f.endsWith(".jsonl"));
const calls = (await Promise.all(files.map((f) => askedCalls(join(ROOT, f))))).flat().sort((a, b) => a.ts.localeCompare(b.ts));
const tally: Record<string, number> = {};
for (const call of calls) {
  const { decision, reason } = decide(call);
  tally[decision] = (tally[decision] ?? 0) + 1;
  const raw = String(call.use.input.command ?? call.use.input.file_path ?? "");
  const what = process.argv.includes("--full") ? `\n${raw}\n` : raw.replace(/\s+/g, " ").slice(0, 70);
  console.log(`${call.ts.slice(0, 16)}  ${decision.padEnd(5)}  ${call.use.name.padEnd(5)}  ${what}  — ${reason.slice(0, 60)}`);
}
console.log(`\n${calls.length} asked calls since ${SINCE} via ${HOOK}: ${Object.entries(tally).map(([k, n]) => `${k} ${n}`).join(", ")}`);

const trailers = trailerAudit(".", SINCE);
const verdicts: Record<string, number> = {};
console.log(`\nGuard-loosened trailers since ${SINCE}:`);
for (const t of trailers) {
  verdicts[t.verdict] = (verdicts[t.verdict] ?? 0) + 1;
  console.log(`${t.sha}  ${t.date.slice(0, 16).replace("T", " ")}  ${t.verdict.padEnd(12)}  ${t.path}  — ${t.why.slice(0, 60)}`);
}
console.log(`${trailers.length} trailers: ${Object.entries(verdicts).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
