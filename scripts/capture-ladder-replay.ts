/** `npm run ladder:replay-capture` — the headless `/semis` runs' saved transcripts → `scripts/ladder-label-replay.semis.json`
 *  (state rows, `ladder-research` tables, applied labels + sources) for the Stage 6.4 label replay. */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFindings } from "../src/ladder-findings.js";

// Claude Code's transcript dir = the repo path with every non-alphanumeric char → "-".
const SLUG = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "").replace(/[^a-zA-Z0-9]/g, "-");
const DIR = join(homedir(), ".claude", "projects", SLUG);
const OUT = new URL("./ladder-label-replay.semis.json", import.meta.url);
const PROMPT = "Run the ladder skill in your system prompt";
const ROW_KEYS = ["sign", "since", "held", "label", "extended", "measured", "measuredOnly"] as const;

type Block = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: boolean | null; content?: unknown };
type Rec = { type: string; message?: { id?: string; content?: string | Block[] }; toolUseResult?: { agentId?: string; content?: Block[] } };
type Patch = { signs?: Record<string, { label?: string; sources?: unknown }> };

const lines = (file: string): Rec[] => readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Rec);
const blocks = (r: Rec): Block[] => (Array.isArray(r.message?.content) ? r.message.content : []);
const resultText = (b: Block): string =>
  typeof b.content === "string" ? b.content : Array.isArray(b.content) ? (b.content as Block[]).map((c) => c.text ?? "").join("\n") : "";
const stateLine = (text: string): Record<string, unknown> | undefined => {
  const line = text.split("\n").find((l) => l.startsWith("{") && l.includes('"research"'));
  return line ? (JSON.parse(line) as Record<string, unknown>) : undefined;
};

const finalText = (session: string, toolUseId: string): { agentId: string; text: string } => {
  const sub = join(DIR, session, "subagents");
  const meta = readdirSync(sub).find((f) => f.endsWith(".meta.json") && (JSON.parse(readFileSync(join(sub, f), "utf8")) as { toolUseId?: string }).toolUseId === toolUseId);
  if (!meta) throw new Error(`${session}: no subagent transcript for ${toolUseId}`);
  const asst = lines(join(sub, meta.replace(/\.meta\.json$/, ".jsonl"))).filter((r) => r.type === "assistant");
  const last = asst.at(-1)?.message?.id;
  const text = asst.filter((r) => r.message?.id === last).flatMap(blocks).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
  return { agentId: meta.replace(/^agent-|\.meta\.json$/g, ""), text };
};

const capture = (id: string) => {
  if (!readFileSync(join(DIR, `${id}.jsonl`), "utf8").includes(PROMPT)) return undefined;
  const recs = lines(join(DIR, `${id}.jsonl`)).filter((r) => r.type === "user" || r.type === "assistant");
  const first = recs.find((r) => r.type === "user");
  const prompt = typeof first?.message?.content === "string" ? first.message.content : blocks(first ?? { type: "" }).map((b) => b.text ?? "").join("\n");
  if (!prompt.startsWith(PROMPT)) return undefined;
  const uses = recs.filter((r) => r.type === "assistant").flatMap(blocks).filter((b) => b.type === "tool_use");
  const results = new Map(recs.filter((r) => r.type === "user").flatMap(blocks).filter((b) => b.type === "tool_result").map((b) => [b.tool_use_id, b]));
  const ok = (b: Block): boolean => results.has(b.id) && results.get(b.id)!.is_error !== true;
  const cmd = (b: Block): string => (b.name === "Bash" ? String(b.input?.command ?? "") : "");
  const applyAt = uses.findLastIndex((b) => /\bsemis:apply\b/.test(cmd(b)) && ok(b));
  if (applyAt < 0) return undefined;

  const research = uses.filter((b) => b.name === "Agent" && b.input?.subagent_type === "ladder-research");
  const firstResearch = research[0] ? uses.indexOf(research[0]) : uses.length;
  const states = [stateLine(prompt), ...uses.slice(0, firstResearch).filter((b) => /\bsemis:state\b/.test(cmd(b)) && ok(b)).map((b) => stateLine(resultText(results.get(b.id)!)))];
  const state = states.filter((s) => s !== undefined).at(-1);
  if (!state) throw new Error(`${id}: no semis:state output before the first ladder-research call`);
  const rows = (state.research as Record<string, unknown>[]).map((r) => Object.fromEntries(ROW_KEYS.filter((k) => k in r).map((k) => [k, r[k]])));

  const parentById = new Map(recs.flatMap((r) => (r.toolUseResult?.agentId ? [[r.toolUseResult.agentId, r.toolUseResult.content ?? []] as const] : [])));
  const tables = research.filter(ok).map((b) => {
    const { agentId, text } = finalText(id, b.id!);
    const parent = (parentById.get(agentId) ?? []).filter((x) => !x.text?.startsWith("<tools-used-before-summary>")).map((x) => x.text ?? "").join("\n").trim();
    if (parent !== text) throw new Error(`${id}: subagent final text for ${b.id} differs from the parent's Agent result`);
    return text;
  });

  const path = /\bsemis:apply\s+--\s+(\S+)/.exec(cmd(uses[applyAt]!))?.[1];
  if (!path) throw new Error(`${id}: no patch path on the applied semis:apply call`);
  let body: string | undefined;
  for (const b of uses.slice(0, applyAt)) {
    if (b.input?.file_path !== path || !ok(b)) {
      if (b.name === "Bash" && ok(b) && cmd(b).includes(path) && !/^npm run -s semis:apply /.test(cmd(b))) throw new Error(`${id}: un-replayable Bash touches ${path}: ${cmd(b).slice(0, 120)}`);
      continue;
    }
    if (b.name === "Write") body = String(b.input.content);
    else if (b.name === "Edit") {
      const [from, to] = [String(b.input.old_string), String(b.input.new_string)];
      if (body === undefined || !body.includes(from)) throw new Error(`${id}: Edit ${b.id} does not apply to ${path}`);
      body = b.input.replace_all ? body.split(from).join(to) : body.replace(from, () => to);
    }
  }
  if (body === undefined) throw new Error(`${id}: no successful Write to ${path} before the applied call`);
  const signs = (JSON.parse(body) as Patch).signs ?? {};
  const applied = Object.fromEntries(Object.entries(signs).map(([sign, p]) => [sign, { label: p.label, sources: p.sources }]));
  return { id, today: String(state.today), rows, tables, applied };
};

const sessions = readdirSync(DIR)
  .filter((f) => f.endsWith(".jsonl"))
  .flatMap((f) => capture(f.replace(/\.jsonl$/, "")) ?? [])
  .sort((a, b) => a.today.localeCompare(b.today) || a.id.localeCompare(b.id));

const rejected = sessions.flatMap((s) =>
  s.tables.flatMap((t, i) =>
    t.split("\n").flatMap((line) => {
      try {
        parseFindings(line);
        return [];
      } catch (e) {
        return [`${s.today} ${s.id} table ${i + 1}: ${(e as Error).message}`];
      }
    }),
  ),
);
if (sessions.length === 0) throw new Error(`no ladder sessions under ${DIR}`);
writeFileSync(OUT, `${JSON.stringify({ generatedBy: "npm run ladder:replay-capture", sessions }, null, 1)}\n`);
for (const s of sessions) console.log(`${s.today} ${s.id} rows=${s.rows.length} tables=${s.tables.length} applied=${Object.keys(s.applied).length}`);
console.log(`${sessions.length} sessions → ${OUT.pathname}`);
if (rejected.length) {
  console.error(`parseFindings rejected ${rejected.length} line(s):\n${rejected.join("\n")}`);
  process.exit(1);
}
