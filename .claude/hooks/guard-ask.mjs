// PreToolUse (via guard-ask.sh): warn the agent (GUARD_ASK=1: ask the user) before an edit to a gate itself, a command that bypasses one, or a commit declaring a
// Guard-loosened trailer. A loosened baseline/roster is the commit-msg gate's (scripts/guard-loosen.ts), not this hook's.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, normalize, resolve } from "node:path";

let s = "";
for await (const c of process.stdin) s += c;
const { tool_name: tool, tool_input: input = {}, cwd = "" } = JSON.parse(s || "{}");
// Repo-relative: editing any of these disables the gate it is.
const PATHS = [
  [/^\.claude\/hooks\//, "a Claude Code hook"],
  [/^\.claude\/settings[^/]*\.json$/, "the Claude Code settings"],
  [/^scripts\/git-hooks\//, "a tracked git hook"],
  [/^scripts\/guard-loosen\.ts$/, "the commit-msg scorer"],
  [/^knip\.json$/, "the knip config"],
  [/^scripts\/size-ratchet\.test\.ts$/, "the size ratchet"],
  [/^scripts\/unused-exports\.test\.ts$/, "the knip gate"],
];
const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || `${homedir()}/.claude`;
let checkouts;
/** Every checkout of this repo (main + linked worktrees): a gate edited in a sibling is shared through its git dir or by merge. */
const siblings = () => (checkouts ??= (() => {
  const r = spawnSync("git", ["-C", process.env.CLAUDE_PROJECT_DIR || cwd || "/", "worktree", "list", "--porcelain"], { encoding: "utf8", timeout: 3000 });
  return r.status === 0 ? [...r.stdout.matchAll(/^worktree (.+)$/gm)].map((m) => m[1]) : [];
})());
/** [`p` relative to a checkout root, its gate] — the user-level settings count as their own root; null outside every root. */
function locate(p) {
  const abs = resolve(cwd || "/", p);
  if (abs.startsWith(`${CLAUDE_HOME}/`) && /^settings[^/]*\.json$/.test(abs.slice(CLAUDE_HOME.length + 1))) return [abs, "the user-level Claude Code settings"];
  const under = (roots) => roots.filter((b) => b && abs.startsWith(b + "/")).map((b) => abs.slice(b.length + 1));
  const near = under([process.env.CLAUDE_PROJECT_DIR, cwd]);
  for (const rels of [near, under(siblings())]) {
    for (const rel of rels) { const g = PATHS.find(([re]) => re.test(rel))?.[1]; if (g) return [rel, g]; }
  }
  return near.length ? [near[0], undefined] : null;
}
const pathHit = (p) => locate(p)?.[1];
const unquote = (w) => w.replace(/^["']|["']$/g, "");
const base = (v) => (/\s/.test(v) ? v : v.replace(/^.*\//, ""));
// A word that can run text this lexer treats as data; a hit hidden behind one falls back to the raw-text verdict.
const VECTOR = /^((ba|z|da|k|c|tc)?sh|fish|eval|source|exec|xargs|watch|script|alias)$/;
const SHELL = /^((ba|z|da|k|c|tc)?sh|fish)$/;
/** A shell handed a script file runs that file, not text on this line; `-c`, `-s`, stdin and every other VECTOR word do. */
const runsText = (name, after) => !SHELL.test(name) || after.some((a) => /^-\w*[cs]/.test(a)) || after.every((a) => a.startsWith("-"));
const WRAPPER = /^(sudo|env|command|builtin|nohup|time|nice|timeout|stdbuf|\w+=.*|-.*|\d[\d.]*[smhd]?)$/;

const ESC = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v" };
let scopeSeq = 0;
/** Shell text → simple commands (word `v` = unquoted value, `m` = value with whitespace-bearing quotes blanked, `subs` = ids of the
 *  substitutions inside it; redirect targets; `ins` = stdin sources; `scope` = enclosing subshell ids; `async` = pipeline or `&` member).
 *  Non-shell heredoc bodies are not lexed (unquoted ones keep their `$(…)`); `vector`/`bad` = the parse cannot vouch for it. */
function lex(t, body = false, outer = []) {
  const cmds = [];
  const stack = [];
  const pending = [];
  const scopes = [...outer];
  let i = 0, bad = false, vector = false, lineStart = 0;
  const merge = (r) => { cmds.push(...r.cmds); bad ||= r.bad; vector ||= r.vector; };
  const blanks = () => { while (/[ \t]/.test(t[i] ?? "")) i++; };
  function single() {
    const j = t.indexOf("'", i + 1);
    const v = t.slice(i + 1, j < 0 ? t.length : j);
    if (j < 0) bad = true;
    i = j < 0 ? t.length : j + 1;
    return v;
  }
  function ansi() {
    vector = true;
    let v = "";
    for (i += 2; i < t.length && t[i] !== "'"; i++) v += t[i] === "\\" ? t[++i] ?? "" : t[i];
    if (i >= t.length) bad = true;
    i++;
    return v;
  }
  // Double-quote (or unquoted-heredoc) content up to `stop`; substitutions are lexed as commands and read back as "$()".
  function dq(stop) {
    let v = "";
    while (i < t.length && t[i] !== stop) {
      if (t[i] === "\\") { v += t[i + 1] ?? ""; i += 2; }
      else if (t.startsWith("$(", i)) { i += 2; list(")"); v += "$()"; }
      else if (t[i] === "`") { tick(); v += "$()"; }
      else if (t.startsWith("${", i)) v += param();
      else v += t[i++];
    }
    return v;
  }
  function dquote() {
    i++;
    const v = dq('"');
    if (i >= t.length) bad = true;
    i++;
    return v;
  }
  function tick() {
    let j = i + 1, inner = "";
    for (; j < t.length && t[j] !== "`"; j++) inner += t[j] === "\\" && "`\\$".includes(t[j + 1]) ? t[++j] : t[j];
    if (j >= t.length) bad = true;
    merge(lex(inner, false, [...scopes, ++scopeSeq]));
    i = j + 1;
  }
  function param() {
    const from = i;
    let depth = 1;
    for (i += 2; i < t.length && depth; ) {
      if (t[i] === "\\") i += 2;
      else if (t[i] === "'") single();
      else if (t[i] === '"') dquote();
      else if (t.startsWith("$(", i)) { i += 2; list(")"); }
      else if (t[i] === "`") tick();
      else { depth += t[i] === "{" ? 1 : t[i] === "}" ? -1 : 0; i++; }
    }
    if (depth) bad = true;
    return t.slice(from, i);
  }
  function word() {
    const from = scopeSeq;
    let v = "", m = "", q = false;
    const add = (x, quoted) => { v += x; m += quoted && /\s/.test(x) ? "''" : x; q ||= quoted; };
    while (i < t.length && !/[\s;&|<>()]/.test(t[i])) {
      if (t[i] === "\\") { if (t[i + 1] !== "\n") add(t[i + 1] ?? "", false); i += 2; }
      else if (t[i] === "'") add(single(), true);
      else if (t[i] === '"') add(dquote(), true);
      else if (t.startsWith("$'", i)) add(ansi(), true);
      else if (t.startsWith("$(", i)) { i += 2; list(")"); add("$()", false); }
      else if (t[i] === "`") { tick(); add("$()", false); }
      else if (t.startsWith("${", i)) add(param(), false);
      else add(t[i++], false);
    }
    return { v, m, q, subs: Array.from({ length: scopeSeq - from }, (_, k) => from + k + 1) };
  }
  function heredocs() {
    const fed = [...cmds.slice(lineStart), ...stack].some((c) => c.words.some((w) => VECTOR.test(base(w.v))));
    for (const h of pending.splice(0)) {
      let p = i, end = -1;
      for (;;) {
        const e = t.indexOf("\n", p) < 0 ? t.length : t.indexOf("\n", p);
        if ((h.strip ? t.slice(p, e).replace(/^\t+/, "") : t.slice(p, e)) === h.delim) { end = e; break; }
        if (e >= t.length) break;
        p = e + 1;
      }
      if (end < 0) { bad = true; i = t.length; return; }
      h.body = t.slice(i, p);
      if (fed) merge(lex(h.body, false, [...scopes, ++scopeSeq]));
      else if (!h.quoted) merge(lex(h.body, true, scopes));
      i = end + 1;
    }
  }
  function redirect(frame) {
    if (t.startsWith("<<<", i)) { vector = true; i += 3; blanks(); const w = word(); frame.ins.push({ text: w.v, subs: w.subs }); return; }
    if (t.startsWith("<<", i)) {
      i += 2;
      const strip = t[i] === "-";
      if (strip) i++;
      blanks();
      const d = word();
      if (!d.v) bad = true;
      const h = { delim: d.v, strip, quoted: d.q };
      pending.push(h);
      frame.ins.push({ heredoc: h });
      return;
    }
    if (/^[<>]\(/.test(t.slice(i, i + 2))) { i += 2; const subs = [scopeSeq + 1]; list(")"); frame.words.push({ v: "$()", m: "$()", q: false, subs }); return; }
    const op = /^(&>>?|[<>]&|>>|>\||<>|[<>])/.exec(t.slice(i, i + 3))[0];
    i += op.length;
    blanks();
    const w = word();
    if (op.includes(">") && !/^(\d+|-)$/.test(w.v)) frame.redirs.push(w.v);
    else if (op === "<") frame.ins.push({ file: w.v });
  }
  function list(end) {
    const frame = { words: [], redirs: [], ins: [] };
    stack.push(frame);
    if (end) scopes.push(++scopeSeq);
    let piped = false;
    const flush = (op = "") => {
      const pipe = op === "|" || op === "|&";
      if (frame.words.length || frame.redirs.length || frame.ins.length) {
        cmds.push({ ...frame, scope: [...scopes], pipeIn: piped, pipeOut: pipe, async: piped || pipe || op === "&" });
      }
      Object.assign(frame, { words: [], redirs: [], ins: [] });
      piped = pipe;
    };
    let closed = !end;
    while (i < t.length) {
      const c = t[i];
      if (/[ \t\r\f\v]/.test(c)) i++;
      else if (c === "\n") { flush(); i++; if (pending.length) heredocs(); lineStart = cmds.length; }
      else if (c === ")") { i++; if (end) { closed = true; break; } bad = true; }
      else if (c === "(") { i++; list(")"); }
      else if (c === "#") i = t.indexOf("\n", i) < 0 ? t.length : t.indexOf("\n", i);
      else if (c === "<" || c === ">" || t.startsWith("&>", i)) redirect(frame);
      else if (";&|".includes(c)) {
        const op = /^(\|\||&&|;;&?|\|&|[;&|])/.exec(t.slice(i, i + 3))[0];
        i += op.length;
        flush(op);
      }
      else {
        const at = i;
        const w = word();
        if (i === at) i++;
        else if (!(/^\d+$/.test(w.v) && !w.q && /[<>]/.test(t[i] ?? ""))) frame.words.push(w);
      }
    }
    flush();
    stack.pop();
    if (end) scopes.pop();
    if (!closed) bad = true;
  }
  try {
    if (body) dq(undefined);
    else list(undefined);
  } catch {
    bad = true;
  }
  if (pending.length) bad = true;
  for (const c of cmds) {
    if (c.words.some((w, k) => VECTOR.test(base(w.v)) && runsText(base(w.v), c.words.slice(k + 1).map((x) => x.v)))) vector = true;
    const head = c.words.find((w) => !WRAPPER.test(w.v))?.v ?? "";
    if (/^[$`]/.test(head) || head === ".") vector = true;
  }
  return { cmds, bad, vector };
}

const values = (c) => c.words.map((w) => w.v);
/** `git [global opts] <sub> …` → `zone` = the global options, `at` = the index of `sub`; null without a `git` word. */
function gitCall(w) {
  let j = w.findIndex((v) => base(v) === "git") + 1;
  if (!j) return null;
  const from = j;
  while (w[j]?.startsWith("-")) j += /^(-[cC]|--(git-dir|work-tree|namespace|config-env|super-prefix))$/.test(w[j]) ? 2 : 1;
  return { zone: w.slice(from, j), from, at: j, sub: w[j] };
}
/** The argv after `git [global opts] <sub>`, or null; `zone` gets the global options. */
function gitArgs(w, sub, zone = []) {
  const g = gitCall(w);
  if (!g) return null;
  zone.push(...g.zone);
  return g.sub === sub ? w.slice(g.at + 1) : null;
}
const COMMIT_VALUE_OPTS = new Set(["--message", "--file", "--author", "--date", "--template", "--reuse-message", "--reedit-message", "--fixup", "--squash", "--trailer", "--cleanup", "--pathspec-from-file"]);
function commitSkipsHooks(cmds) {
  return cmds.some((c) => {
    const a = gitArgs(values(c), "commit");
    for (let k = 0; a && k < a.length; k++) {
      if (a[k] === "--") return false;
      if (COMMIT_VALUE_OPTS.has(a[k])) { k++; continue; }
      if (!/^-[a-zA-Z]+$/.test(a[k])) continue;
      for (let q = 1; q < a[k].length; q++) {
        const ch = a[k][q];
        if (ch === "n") return true;
        if ("mFcCt".includes(ch)) { if (q === a[k].length - 1) k++; break; }
        if ("Su".includes(ch)) break;
      }
    }
    return false;
  });
}
function setsHooksPath(cmds) {
  return cmds.some((c) => {
    const w = values(c);
    const zone = [];
    if (w.some((v) => /^GIT_CONFIG_\w+=.*core\.hookspath/i.test(v))) return true;
    const a = gitArgs(w, "config", zone);
    if (zone.some((v) => /core\.hookspath=/i.test(v))) return true;
    const k = a ? a.findIndex((t) => t.toLowerCase() === "core.hookspath") : -1;
    return k >= 0 && k < a.length - 1 && !a.some((t) => /^(--get(-all|-regexp|-urlmatch)?|--list|-l|--unset(-all)?|--show-(origin|scope)|--name-only|get|list|unset)$/.test(t));
  });
}
// [test on the lexed command, the pre-lexer regex over the raw text, reason]
const COMMANDS = [
  [/--no-verify\b/, /--no-verify\b/, "--no-verify skips the git hooks"],
  [commitSkipsHooks, /\bgit commit\b[^|;&]*\s-[a-zA-Z]*n[a-zA-Z]*\b/, "git commit -n skips the git hooks"],
  [setsHooksPath, /\bcore\.hooksPath\b/, "core.hooksPath re-points the git hooks"],
  [/\bSKIP_TESTS=["']?1\b/, /\bSKIP_TESTS=["']?1\b/, "SKIP_TESTS=1 skips the pre-push gate"],
  [/\b(vitest|npm (run )?test|run-unit-tests\.sh)\b[^|;&\n]*\s(-u(\s|$)|--update(=|\s|$))/, /\b(vitest|npm (run )?test|run-unit-tests\.sh)\b[^|;&]*\s(-u(\s|$)|--update(=|\s|$))/, "vitest -u rewrites snapshots"],
  [/\bnpm +(i|install|add)\b( +-\S+)* +[^-\s|;&]/, /\bnpm\s+(i|install|add)\b(\s+-\S+)*\s+[^-\s|;&]/, "npm install <pkg> adds a dependency"],
];
// A Bash segment that writes its path arguments (cp: only its destination); a redirect target is checked on its own.
const WRITER = /^\s*(\w+=\S*\s+)*(sudo\s+)?(sed\b[^|;&]*\s(-i|--in-place)|tee|mv|cp|rm|git\s+checkout\b[^|;&]*\s--|git\s+restore)(\s|$)/;
const writes = (t) => `this command writes ${t}, ${pathHit(t)} — rewriting it can silence the gate it is`;
/** Interpreter `-e`/`-c` bodies and quoted heredoc bodies on a line with no shell are data, not commands. */
function dataStripped(cmd) {
  const lines = cmd.replace(/\b(node|python3?|deno|bun|perl|ruby)\s+(-e|--eval|-c|-p|--print)\s+('[^']*'|"(?:[^"\\]|\\.)*")/g, "$1 $2 ''").split("\n");
  const out = [];
  for (let k = 0; k < lines.length; k++) {
    out.push(lines[k]);
    const h = /<<-?\s*(['"])(\w+)\1/.exec(lines[k]);
    if (!h || /\b((ba|z|da|k|c|tc)?sh|fish|eval|source|exec)\b/.test(lines[k])) continue;
    while (k + 1 < lines.length && lines[k + 1].replace(/^\t+/, "") !== h[2]) k++;
  }
  return out.join("\n");
}
/** The pre-lexer verdict on the raw text (mentions included): kept whenever the lexer cannot vouch for the command. */
function rawHit(cmd) {
  const text = dataStripped(cmd);
  const c = COMMANDS.find(([, re]) => re.test(text));
  if (c) return c[2];
  const targets = [...text.matchAll(/>>?\|?\s*([^\s|;&<>]+)/g)].map((m) => unquote(m[1]));
  for (const seg of text.split(/\|\||&&|[|;\n]/)) {
    const w = seg.trim().split(/\s+/).map(unquote);
    const verb = WRITER.exec(seg)?.[3];
    if (verb) targets.push(...(verb === "cp" ? w.slice(-1) : w));
  }
  const t = targets.find((w) => pathHit(w));
  return t && writes(t);
}

const isTmp = (d) => typeof d === "string" && (d.startsWith("/tmp/") || d.startsWith(`${tmpdir()}/`));
// A scratch repo's commit/add/status touch only its own index and refs; push, config & co reach the remote or the shared config.
const SCRATCH_ONLY = /^(commit|add|status|diff|log|show)$/;
const INIT_VALUE = /^(--template|-b|--initial-branch|--object-format|--ref-format)$/;
const CLONE_VALUE = /^(-[bocuj]|--(branch|origin|config|depth|reference(-if-able)?|template|upload-pack|filter|jobs|shallow-(since|exclude)|server-option|bundle-uri))$/;
/** Drops git commands acting only on a scratch repo under /tmp (via `cd`/`pushd`/`git -C`, scoped to its subshell); any dir that
 *  cannot be resolved counts as the real repo. A `git config` write drops only in a repo this command made (a worktree shares the config). */
function liveCmds(cmds) {
  const state = new Map([["", { dir: cwd.startsWith("/") ? normalize(cwd) : null, vars: {} }]]);
  const created = [];
  const gitEnv = cmds.some((c) => values(c).some((v) => /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE)=/.test(v)));
  /** A subshell starts from its parent's state when its first command runs; its own changes never flow back. */
  const stateOf = (c) => {
    for (let n = c.scope.length; ; n--) {
      const k = c.scope.slice(0, n).join("/");
      if (!state.has(k)) continue;
      const s = state.get(k);
      if (n < c.scope.length) state.set(c.scope.join("/"), { dir: s.dir, vars: { ...s.vars } });
      return state.get(c.scope.join("/"));
    }
  };
  return cmds.filter((c) => {
    const s = stateOf(c);
    const value = (w) => {
      let v = w.v;
      const src = v.includes("$()") ? cmds.filter((f) => f.scope.some((id) => w.subs.includes(id))) : [];
      if (src.length === 1 && values(src[0]).find((x) => !WRAPPER.test(x)) === "mktemp") v = v.replace("$()", `${tmpdir()}/mktemp-${w.subs[0]}`);
      return v.replace(/\$\{?(\w+)\}?/g, (m, k) => s.vars[k] ?? m);
    };
    const to = (from, w) => {
      const d = w && value(w);
      return !d || d === "-" || /[$~`]/.test(d) ? null : d.startsWith("/") ? normalize(d) : from === null ? null : resolve(from, d);
    };
    const w = values(c);
    const h = w.findIndex((v) => !WRAPPER.test(v));
    if (h < 0 || /^(export|local|declare|readonly)$/.test(w[h])) {
      for (const x of c.words) if (/^\w+=/.test(x.v)) s.vars[x.v.slice(0, x.v.indexOf("="))] = value(x).slice(x.v.indexOf("=") + 1);
      return true;
    }
    if (/^(cd|pushd|popd|chdir)$/.test(w[h])) {
      const arg = c.words.slice(h + 1).find((x) => !/^-[LPe@]+$/.test(x.v));
      if (!c.async) s.dir = w[h] === "popd" ? null : arg ? to(s.dir, arg) : w[h] === "cd" ? homedir() : null;
      return true;
    }
    const g = gitCall(w);
    if (!g) return true;
    let dir = s.dir, foreign = gitEnv;
    for (let k = g.from; k < g.at; k++) {
      if (w[k] === "-C") dir = to(dir, c.words[++k]);
      else if (/^--(git-dir|work-tree)/.test(w[k])) foreign = true;
    }
    c.dir = dir;
    if (foreign || !isTmp(dir)) return true;
    const args = c.words.slice(g.at + 1);
    if (g.sub === "init" || g.sub === "clone") {
      const pos = args.filter((x, k) => !x.v.startsWith("-") && !(g.sub === "init" ? INIT_VALUE : CLONE_VALUE).test(args[k - 1]?.v ?? ""));
      const target = g.sub === "init" ? (pos[0] ? to(dir, pos[0]) : dir) : pos[1] ? to(dir, pos[1]) : pos[0] && to(dir, { v: basename(pos[0].v).replace(/\.git$/, ""), subs: [] });
      if (target && !args.some((x) => x.v.startsWith("--separate-git-dir")) && !existsSync(`${target}/.git`)) created.push(target);
      return false;
    }
    if (g.sub === "config") {
      const own = created.some((r) => dir === r || dir.startsWith(`${r}/`));
      return !own || args.some((x) => /^(--global|--system|--file|-f|--blob)/.test(x.v));
    }
    return !SCRATCH_ONLY.test(g.sub ?? "");
  });
}

const trailersIn = (text) => [...text.matchAll(/^[ \t]*(Guard-loosened:[^\n]*)/gm)].map((m) => m[1].trim());
const unescape = (v) => v.replace(/\\(.)/g, (_, ch) => ESC[ch] ?? ch);
// Message sources whose text cannot carry a trailer; any other command feeding a message counts as unreadable.
const INERT = /^(date|pwd|basename|dirname|mktemp|whoami|hostname|uname|wc|cd|true)$/;
/** The `Guard-loosened:` trailers a live `git commit` carries (`found`), and the message sources this hook cannot read (`unread`). */
function declaredLoosenings(live, all) {
  const found = [], unread = [];
  const readFile = (f, dir, label) => {
    try { found.push(...trailersIn(readFileSync(resolve(dir ?? cwd ?? "/", f), "utf8"))); } catch { unread.push(label); }
  };
  const stdin = (c) => {
    for (const s of c.ins) {
      if (s.heredoc) found.push(...trailersIn(s.heredoc.body ?? ""));
      else if (s.file) readFile(s.file, c.dir, `< ${s.file}`);
      else { found.push(...trailersIn(s.text)); if (s.text.includes("$()")) feed(all.filter((f) => f.scope.some((id) => s.subs.includes(id)))); }
    }
  };
  /** Commands whose output becomes message text. */
  const feed = (src) => {
    for (const f of src) {
      const w = values(f);
      const h = w.findIndex((v) => !WRAPPER.test(v));
      const name = base(w[h] ?? "");
      if (/^(printf|echo)$/.test(name)) found.push(...trailersIn(w.slice(h + 1).map(unescape).join("\n")));
      else if (name === "cat") {
        for (const a of w.slice(h + 1)) if (!a.startsWith("-")) readFile(a, f.dir, `cat ${a}`);
        stdin(f);
      } else if (!INERT.test(name)) unread.push(`the output of ${name}`);
    }
  };
  const subsOf = (word) => all.filter((f) => f.scope.some((id) => word.subs.includes(id)));
  const message = (word, text) => {
    found.push(...trailersIn(text));
    if (text.includes("$()")) feed(subsOf(word));
  };
  const reuse = (c, rev) => {
    const r = c.dir ? spawnSync("git", ["-C", c.dir, "log", "-1", "--format=%B", rev, "--"], { encoding: "utf8", timeout: 3000 }) : { status: 1 };
    if (r.status === 0) found.push(...trailersIn(r.stdout));
    else unread.push(`the message of ${rev}`);
  };
  for (const c of live) {
    const g = gitCall(values(c));
    if (g?.sub !== "commit") continue;
    const ws = c.words.slice(g.at + 1);
    let sourced = false, amend = false;
    const take = (opt, word, v) => {
      sourced ||= /^(m|message|F|file|C|reuse-message|c|reedit-message)$/.test(opt);
      if (opt === "m" || opt === "message") message(word, v);
      else if (opt === "F" || opt === "file") {
        if (v !== "-") {
          const maker = all.slice(0, all.indexOf(c)).filter((p) => p.redirs.includes(v)).pop();
          if (maker) { feed([maker]); stdin(maker); } else readFile(v, c.dir, `-F ${v}`);
        } else {
          stdin(c);
          const i = all.indexOf(c), key = c.scope.join("/"), src = [];
          for (let k = i - 1; c.pipeIn && k >= 0 && !(all[k].scope.join("/") === key && !all[k].pipeOut); k--) src.push(all[k]);
          feed(src);
        }
      } else if (/^(C|reuse-message|c|reedit-message)$/.test(opt)) reuse(c, v);
      else if (opt === "fixup" && /^(amend|reword):/.test(v)) { sourced = true; reuse(c, v.slice(v.indexOf(":") + 1)); }
      else if (opt === "trailer" && /^Guard-loosened[ \t]*[:=]/.test(v)) found.push(`Guard-loosened: ${v.replace(/^Guard-loosened[ \t]*[:=][ \t]*/, "")}`);
    };
    for (let k = 0; k < ws.length; k++) {
      const x = ws[k].v;
      if (x === "--") break;
      if (x === "--amend") amend = true;
      const long = /^--([\w-]+)(?:=([\s\S]*))?$/.exec(x);
      if (long && COMMIT_VALUE_OPTS.has(`--${long[1]}`)) {
        if (long[2] !== undefined) take(long[1], ws[k], long[2]);
        else if (ws[k + 1]) { k++; take(long[1], ws[k], ws[k].v); }
        continue;
      }
      if (!/^-[a-zA-Z]/.test(x) || long) continue;
      for (let q = 1; q < x.length; q++) {
        if ("Su".includes(x[q])) break;
        if (!"mFcCt".includes(x[q])) continue;
        if (q < x.length - 1) take(x[q], ws[k], x.slice(q + 1));
        else if (ws[k + 1]) { k++; take(x[q], ws[k], ws[k].v); }
        break;
      }
    }
    if (amend && !sourced) reuse(c, "HEAD");
  }
  return { found: [...new Set(found)], unread: [...new Set(unread)] };
}

let hit;
if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool ?? "")) {
  const p = String(input.file_path ?? input.notebook_path ?? "");
  const [rel, gate] = locate(p) ?? [];
  if (gate) hit = `${rel} is ${gate} — editing it can silence the gate it is`;
} else if (tool === "Bash") {
  const cmd = String(input.command ?? "");
  const L = lex(cmd);
  const live = liveCmds(L.cmds);
  const masked = live.map((c) => c.words.map((w) => w.m).join(" ")).join("\n");
  hit = COMMANDS.find(([t]) => (typeof t === "function" ? t(live) : t.test(masked)))?.[2];
  const { found, unread } = hit ? { found: [], unread: [] } : declaredLoosenings(live, L.cmds);
  // An unparsed command's text is all there is: any Guard-loosened in it may be a trailer.
  if ((L.vector || L.bad) && /\bcommit\b/.test(cmd)) found.push(...[...cmd.matchAll(/Guard-loosened:[^\n"']*/g)].map((m) => m[0].trim()));
  if (found.length) hit = `this commit declares a guard loosening — proceed only if each reason holds: ${[...new Set(found)].join(" | ")}`;
  else if (unread.length) hit = `this commit's message comes from ${unread.join(", ")}, which this hook cannot read — proceed only if it declares no Guard-loosened trailer, or each reason holds`;
  const targets = [];
  for (const c of L.cmds) {
    targets.push(...c.redirs);
    const verb = WRITER.exec(c.words.map((w) => w.m).join(" "))?.[3];
    if (verb) targets.push(...(verb === "cp" ? values(c).slice(-1) : values(c)));
  }
  const t = hit ? undefined : targets.filter(Boolean).map(normalize).find(pathHit);
  if (t) hit = writes(t);
  const raw = (L.vector || L.bad) && rawHit(cmd);
  if (raw) hit ??= raw;
}

// Default: never prompt (the user approved every ask anyway, 2026-11-18) — allow and warn the agent instead.
// GUARD_ASK=1 opts back into prompting; an unattended stage (IMPAG_STAGE, set by an optional session driver — README
// §Agent tooling) never prompts (nobody answers).
const WARN = " — allowed, but this is how a guard gets silenced: do it only if the code is right and the list is wrong, and name the file + why in the commit message.";
const out = process.env.GUARD_ASK === "1" && !process.env.IMPAG_STAGE
  ? { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: hit }
  : { hookEventName: "PreToolUse", additionalContext: hit + WARN };
if (hit) console.log(JSON.stringify({ hookSpecificOutput: out }));
