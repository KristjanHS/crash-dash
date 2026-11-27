#!/usr/bin/env node
// ladder-claude-summary.mjs [--research] <claude.json> <denials-file> <result-file> — reads one leg's `claude -p
// --output-format json --verbose` transcript (scripts/eufin-run-local.sh).
//   stdout        the last successful `<leg>:apply` output + the closing text + one status line (permission
//                 mode, result, error, `turns N` = distinct main-model message ids) for the journal
//   denials-file  one line per distinct denied tool call: `<tool> <target> [<why>]` (+ ` ×N` on repeats)
//   result-file   the closing text ONLY — what the API-limit check scans, never tool output or pages
//                 the model read (a file quoting the limit message must not pause the timer)
// Not JSON (claude died before printing) → the raw output goes to stdout AND result-file, exit 2.
// Init lists no WebFetch → exit 3 (the run's own check; the tools preflight cannot see it).
// --research: the runner's Rung 0+A pre-run transcript — its main model's web calls are the job, so no warning.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const research = args.includes("--research");
const [file, deniedFile, resultFile] = args.filter((a) => a !== "--research");
const raw = readFileSync(file, "utf8");
let msgs;
try {
  msgs = JSON.parse(raw);
  if (!Array.isArray(msgs)) msgs = [msgs];
} catch {
  process.stdout.write(raw);
  writeFileSync(resultFile, raw);
  process.exit(2);
}

const init = msgs.find((m) => m.type === "system" && m.subtype === "init");
const result = msgs.findLast((m) => m.type === "result");
// An API error comes back as subtype "success" + is_error; error_* subtypes carry `errors`, no `result`.
const text = result?.result ?? (result?.errors ?? []).join("\n");
writeFileSync(resultFile, text);
// Research belongs to the `ladder-research` agent (its calls carry a parent_tool_use_id).
const mainMsgs = msgs.filter((m) => m.type === "assistant" && !m.parent_tool_use_id);
const mainCalls = mainMsgs.flatMap((m) => (m.message?.content ?? []).filter((b) => b.type === "tool_use"));
// A headless step 5 replies one word, so apply's output comes off the transcript.
const applyIds = new Set(mainCalls.filter((b) => b.name === "Bash" && /\b[a-z0-9]+:apply\b/.test(b.input?.command ?? "")).map((b) => b.id));
const applied = msgs.flatMap((m) => (m.type === "user" && Array.isArray(m.message?.content) ? m.message.content : []))
  .findLast((b) => b.type === "tool_result" && applyIds.has(b.tool_use_id) && !b.is_error);
if (applied) console.log((typeof applied.content === "string" ? applied.content : (applied.content ?? []).map((c) => c.text ?? "").join("\n")).trimEnd());
if (text) console.log(text);
const err = result?.is_error ? ` · ERROR${result.api_error_status ? ` ${result.api_error_status}` : ""}` : "";
// One API turn streams one assistant entry per content block, all under one message id.
const turns = new Set(mainMsgs.map((m) => m.message?.id).filter(Boolean)).size;
console.log(`[permission mode: ${init?.permissionMode ?? "?"} · result: ${result?.subtype ?? "none"}${err} · turns ${turns}]`);
const web = mainCalls.filter((b) => /^Web(Search|Fetch)$/.test(b.name));
if (web.length && !research) console.error(`::warning:: main model made ${web.length} web call(s) — research belongs to the ladder-research agent`);
const stray = mainCalls.filter((b) => /^(Agent|Task)$/.test(b.name) && (b.input?.subagent_type !== "ladder-research" || b.input?.run_in_background === true));
if (stray.length) console.error(`::warning:: main model made ${stray.length} agent call(s) other than a foreground ladder-research: ${stray.map((b) => `${b.input?.subagent_type ?? "?"}${b.input?.run_in_background === true ? " (background)" : ""}`).join(", ")}`);

// Why each call was denied: the tool_result's meta (undocumented — absent → "not allowed"), and for the
// auto-mode classifier its "Reason: [..]" from the result text.
const why = new Map();
for (const m of msgs) {
  if (m.type !== "user" || !Array.isArray(m.message?.content)) continue;
  for (const b of m.message.content) {
    if (b.type !== "tool_result") continue;
    const meta = (m.tool_result_meta ?? []).find((x) => x.id === b.tool_use_id)?.permission_decision;
    const body = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
    const kind = meta?.reason_type;
    const reason = body.match(/Reason: \[([^\]]+)\]/)?.[1];
    why.set(b.tool_use_id, kind === "classifier" ? `auto-mode classifier${reason ? `: ${reason}` : ""}` : kind ?? "not allowed");
  }
}

// What the call aimed at, short enough for a phone notification.
const target = (d) => {
  const i = d.tool_input ?? {};
  const s = i.command ?? i.file_path ?? i.url ?? i.query ?? i.pattern ?? i.skill ?? JSON.stringify(i);
  return String(s).replace(/\s+/g, " ").slice(0, 160);
};
const seen = new Map();
for (const d of result?.permission_denials ?? []) {
  const line = `${d.tool_name} ${target(d)} [${why.get(d.tool_use_id) ?? "not allowed"}]`;
  seen.set(line, (seen.get(line) ?? 0) + 1);
}
for (const [line, n] of seen) appendFileSync(deniedFile, `${line}${n > 1 ? ` ×${n}` : ""}\n`);
if (!result) process.exit(2);
// WebFetch is policy-gated, so the invalid-key tools preflight skips it — this real init is its only check.
if (init && !(init.tools ?? []).includes("WebFetch")) process.exit(3);
