/**
 * Licensed levels are not published: the prose matcher/rewriter that finds an OBSERVED level of a licensed series
 * in free text (a ladder leg's findings, verdict values, watch rows) and rewrites it to "—"; the leg walker also
 * nulls the level numbers of a licensed id's `shocks` entry (the one numeric level field).
 *
 * Which series: `LICENSED_ALIASES` — every prose word naming a series `src/licensed.ts` classifies licensed
 * (`isLicensedId` / `isLicensedSource`), in two classes:
 *  - INDEX (`INDEX_ALIASES`): the index families — credit spreads, vol indices, CAPE — whose levels print as a
 *    plain number, a % or a bp: a pinned alias table (`HY`, `CCC`, `VIX`, …) plus every restricted `FRED_NOTES` id.
 *  - CLOSE (`CLOSE_ALIASES`): a vendor equity / ETF / FX / commodity close (`SPX`, `MU`, `USD/JPY`, `DRAM spot`,
 *    `SXR8`): every licensed registry id spelled as a prose word (`XDEV`, `SPY`, `NVDA`), the ticker of every
 *    licensed id's level source (`SEC0.DE` → `SEC0`, `^MOVE` → `MOVE`), and a pinned table for the prose names a
 *    ticker does not spell (`SPX`, `USD/JPY`, `DRAM`, `SOX`). A close prints as a price, never a % or bp, and never
 *    signed: a signed or % number on a CLOSE subject is a move / share (`MU −4.7 %`, `SEC0 -26.9% off its high`)
 *    and stays; a `$`-prefixed number is a price (`MU $112.40`, `DRAM spot $3.85`) unless a magnitude suffix makes
 *    it money (`$108 B`, `$12.5 bn`; `$1.2T` is glued, never a number); a bare integer is a level only when grouped
 *    (`SPX 6,750`), `$`-prefixed, quoted or after a print verb — else a count (`NVDA 3 analysts`). A `$` number on a
 *    non-close subject is money and stays.
 *
 * The rule, per number in the text:
 *  1. SUBJECT — the last indicator label before it in its clause (a clause ends at `;`, a sentence-ending `. `
 *     or a newline; ` · ` and `,` carry it). A label is an alias, or any token with ≥ 2 capitals (`RV20`, `CDS`,
 *     `KBE/SPY`); a ratio label (`VIX/VIX3M`) is a derived series, never licensed (a pinned pair alias such as
 *     `USD/JPY` is one series). A publisher tag (`FRED`, `ICE`), `MA200`, `T1`, a quote's source right after a
 *     print verb (`SPX closed <source> 7,688.62`), a calendar-quarter tag and a rating (`BBB-`) are transparent; `OAS` makes the subject a licensed spread. A structured value
 *     with no label (`3.20/3.09 (peak …)`) takes `ctx.subject` — the leg walker passes the first label of the
 *     object's `tag.indicator`, else of its `rule` (a `rule` opening on a ratio label names that ratio). A realized-vol
 *     label of one close (`RV20 9.9/14.3` under tag `XDEV`) takes `ctx.subject` too. Only a licensed subject's numbers are candidates.
 *  2. NEVER A LEVEL (skipped before any other rule): a date (`11-03`), a token glued to letters (`10y`, `MA200`),
 *     a 4-digit 19xx/20xx year (`VIX 2025 peak`), a number glued to a word by a hyphen (`10-close high`), an
 *     integer counting something (`2 closes`, `2 days`, `3 of 5`, `30 members`; not a grouped or `$` number before a singular
 *     `close`: `6,750 close`, `SPX — 6,750 close 10-24`), and the second half of an en-dash range
 *     whose first half was not a hit.
 *  3. CANDIDATE — a decimal (`13.16`, `3.54%`, `-0.01`, `1,050.5`); a number right after the label (an `OAS`
 *     between them is transparent: `HY OAS 312 bp`) or after a `Δn` token (`VIX 17`, `Δ20 +39bp`); an unsigned
 *     number carrying a bp / % unit (`HY now 312 bp`); a number after a print verb (`at`, `to`, `now`, `ended`,
 *     `peaked`, `hit`, `closed`: `VIX rose to 24`); a number followed by a print annotation (rule 5); the
 *     second half of an en-dash range whose first half is a hit (`VIX 22.1–23.4`). A bare integer elsewhere is
 *     a count / threshold. Thousands groups are one number (`CCC 1,050 bp`).
 *  4. KEEP (a threshold — our own criterion): the half after `/` in a slash pair (`VIX 16.61/20.70` = observed
 *     / threshold); a multiplier (`1.3×`, `1.3x` — ours) and a count after a bare `×` (`line ×5`, `0.9 ×10`); a number right after
 *     a comparison (`≥ ≤ < > =`, a spaced `+`/`−`, `over`, `under`, `above`, `below`, `short of`, `crosses`,
 *     `through`, …); a number followed by a comparison tail (`30+`, `12.5 or above`, `4.0 % or wider`), a
 *     deadline (`25 by 12-05`) or a criterion noun, optionally behind `(our`, `is the` or one modifier word
 *     (`3.0 % bear`, `25 trigger`, `3.5 % level`, `0.22 velocity cap`, `17.5 (our re-entry line)`,
 *     `100 is the escalation`), or a move-size noun (`a 75 bp retrace`, `a 50 bp widening`) — UNLESS rule 5
 *     marks it a print.
 *  5. SCRUB (an observed or quoted level): the BASE of a multiplier (`1.3×73.39`, ASCII `1.3x73.39` alike — the
 *     multiplier is ours, the base is the series' observed MA / median). The whole `<mult>×<base>` span prints the
 *     PRODUCT, rounded to the base's decimals and carrying its unit, only where a comparison precedes it and no print
 *     annotation follows (`MOVE — > 1.3×73.39` → `MOVE — > 95.41`: the threshold stays readable, the level does not)
 *     — there rule 4 keeps the product on a re-scan. Anywhere else the product would read as an observed level
 *     (`VIX 1.2×18.5` → `VIX 22.2`, `MOVE trips at 1.3×73.39` → `… at 95.41`), so the span is `—`; a number followed
 *     by a print annotation (`close 11-03`,
 *     `intraday`, `on 10-28`, `13.56 % 10-23 high`, `(the 2025 peak)`, a dated slash half `3.40/3.44 (10-30)`)
 *     (`(FXStreet 10-30)`, `(10 back)` too) or carrying a unit after a past-tense / `now` print verb (`HY now 312 bp`, `closed at 3.4 %`); any
 *     candidate rule 4 did not keep. ECHO: a kept number repeating a scrubbed one verbatim in the same text
 *     (`max5 3.59 <3.64` beside `peak 3.64`) is that level and scrubs too.
 * PRECEDENCE where a print cue and a criterion cue meet: an explicit print cue (rule 5's annotation, or unit +
 * past-tense / `now` verb) scrubs; otherwise a criterion cue (rule 4) keeps; a bare print verb or unit only makes
 * a candidate. A signed bp / % move (`+100 bp over its 6-mo low`) is a relative criterion and stays unless it
 * follows the label or a `Δn`; the replaced span drops the number's sign and unit (`CCC 13.16 %` → `CCC —`).
 * The rewrite is idempotent and scan-stable — `scrub(scrub(x)) === scrub(x)` and `findLicensedLevels(scrub(x))` is
 * empty: `—` is never a number, and a printed product always sits behind the comparison that keeps it.
 */
import { FRED_NOTES, isLicensedId, isLicensedSource, levelSourceOf } from "./licensed.js";
import { ALL_INDICATORS } from "./registry.js";
import { CHART_ONLY_INDICATORS } from "./registry-composite.js";

type Ref = `id:${string}` | `src:${string}`;

/** INDEX prose alias → the `licensed.ts` id (`id:`) or raw source (`src:`) it names. An entry `licensed.ts` does not
 *  classify licensed drops out of `LICENSED_ALIASES`. */
const INDEX_ALIASES: Readonly<Record<string, Ref>> = {
  HY: "id:F1",
  OAS: "id:F1",
  IG: "id:F2",
  CCC: "id:CCC",
  BB: "src:BAMLH0A1HYBB",
  BBB: "id:BBB",
  VIX: "id:R5",
  VIX3M: "id:VIX3M",
  VXN: "id:VXNCLS",
  VXSMH: "id:VXSMH",
  SKEW: "src:^SKEW",
  OVX: "id:OVX",
  MOVE: "id:R6",
  CAPE: "id:F7",
};

/** CLOSE prose names no registry id or source ticker spells (the rest derive in `CLOSE_WORDS`). */
const CLOSE_ALIASES: Readonly<Record<string, Ref>> = {
  SPX: "src:^GSPC",
  SOX: "src:^SOX",
  "USD/JPY": "id:F17",
  "EUR/USD": "id:FXH",
  DRAM: "src:DRAM_SPOT", // `DRAM spot`: the spot quote (no served id)
};

const isLicensedRef = (ref: string): boolean => (ref.startsWith("id:") ? isLicensedId(ref.slice(3)) : isLicensedSource(ref.slice(4)));
const licensedAliases = (table: Readonly<Record<string, Ref>>): string[] =>
  Object.entries(table)
    .filter(([, ref]) => isLicensedRef(ref))
    .map(([alias]) => alias);

/** A word the prose can carry as a label: a capital, then capitals / digits / `_`, ≥ 2 capitals (`F1` is a code, not prose). */
const PROSE_WORD = /^[A-Z][A-Z0-9_]*$/;
const proseWord = (w: string): boolean => PROSE_WORD.test(w) && (w.match(/[A-Z]/g) ?? []).length >= 2;
/** A vendor source's bare ticker: `SEC0.DE` → `SEC0`, `^MOVE` → `MOVE`, `JPY=X` → `JPY`, `HG=F` → `HG`. */
const tickerOf = (source: string): string => source.replace(/^\^/, "").replace(/=[XF]$/, "").replace(/\.[A-Z]{1,2}$/, "");

const INDEX_WORDS: ReadonlySet<string> = new Set([
  ...licensedAliases(INDEX_ALIASES),
  ...Object.entries(FRED_NOTES)
    .filter(([, n]) => n.restricted)
    .map(([id]) => id),
]);

/** Every licensed served id spelled as a prose word, and its level source's ticker — `isLicensedId` decides, never a hand list. */
const CLOSE_WORDS: ReadonlySet<string> = new Set(
  [
    ...licensedAliases(CLOSE_ALIASES),
    ...[...ALL_INDICATORS, ...CHART_ONLY_INDICATORS]
      .filter((ind) => isLicensedId(ind.id))
      .flatMap((ind) => [ind.id, ...((src) => (src === null ? [] : [tickerOf(src)]))(levelSourceOf(ind))]),
  ].filter((w) => !INDEX_WORDS.has(w) && (w.includes("/") || proseWord(w))),
);

/** Every word the matcher treats as a licensed series (INDEX ∪ CLOSE). */
export const LICENSED_ALIASES: ReadonlySet<string> = new Set([...INDEX_WORDS, ...CLOSE_WORDS]);

/** Is `subject` a CLOSE series (a price: a % / bp / signed number on it is a move, never a level)? */
const isCloseSubject = (subject: string): boolean => CLOSE_WORDS.has(subject);

type LevelContext = { readonly subject?: string };

const LABEL = /(?<![\p{L}\p{N}_$/])[A-Z][A-Za-z0-9_]*(?:\/[A-Z][A-Za-z0-9_]*)*(?![\p{L}\p{N}_])/gu;
const TRANSPARENT = /^(?:FRED|ICE|BofA|MA\d*|[TQH]\d)$/;
const CLAUSE_END = /;|\n|(?<![A-Z]|\best|\bvs|\bincl|\bapprox|\be\.g|\bi\.e)\.(?=\s)/g;
// A letter before the number bars it, except an ASCII multiplier `x` glued to a digit (`1.3x73.39` — the base).
const NUMBER = /(?<![\p{N}_.,Δ§@~\-−+])(?<!\p{L}(?<!\d[xX]))([+−-]?)(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(\s?%|\s?bp(?!\p{L}))?(?![\p{L}\p{N}_]|[.,]\d|-\d)/gu;
const DELTA = /Δ\d+\s*$/;
const YEAR = /^(?:19|20)\d{2}$/;
const HYPHENATED = /^-\p{L}/u;
const COUNT_NOUN = /^\s+(?:closes?(?!\s+\d{1,2}-\d{2}\b)|days?|sessions?|weeks?|months?|quarters?|years?|of|members?|names?|stocks?|shares?|analysts?|episodes?|cases|times)\b/;
const PRINT_VERB = /\b(?:at|to|now|ended|peaked|hit|closed)\s*$/;
const PAST_PRINT_VERB = /\b(?:now|ended|peaked|hit|closed)(?:\s+at)?\s*$/;
const COMPARISON = /(?:[≥≤<>=≠≈]|(?<=\s)[+−](?=\s)|\b(?:over|under|above|below|short of|crosses|cross|crossing|through|past|beyond|exceeds?|exceeding|than|toward|towards)\b)\s*(?:(?:both the|the|its|a|an)\s+)?$/;
const CRITERION_AFTER =
  /^(?:\+(?!\s*\d)|\s*or\s+(?:above|below|more|less|higher|lower|wider|tighter|worse)\b|\s*by\s+\d{1,2}-\d{2}\b|\s*\(?\s*(?:is\s+)?(?:(?:the|our|a|an)\s+)?(?:[\p{L}-]+\s+)?(?:lines?|bear|correction|fizzle|BLOCKING|blocking|guard|threshold|trigger|level|cap|floor|ceiling|escalation|re-entry|retrace|retracement|move|widening|tightening|swing)\b)/u;
/** A magnitude suffix after a `$` number: money (`$108 B`, `$12.5 bn`, `$40 million`), never a close. */
const MONEY_SUFFIX = /^\s?(?:[KMBT]|bn|mn|m|k|billion|million|trillion|thousand)(?![\p{L}\p{N}_])/u;
const PRINT_NOTE = /^\s*(?:\(\s*(?:the\s+)?(?:\d{4}\s+)?(?:peak|high|low|trough|close|print)\s*\)|(?:close|print|intraday)\b|on\s+\d{1,2}-\d{2}\b|\((?:[A-Za-z][\w.]*\s+)?\d{1,2}-\d{2}\)|\(\d+\s+back\)|\d{1,2}-\d{2}\s+(?:high|low|peak|close|print)\b)/;

type Label = { start: number; end: number; subject: string | null };
/** A label naming a series derived from ONE close (realized vol `RV10` / `RV20`): it takes `ctx.subject`, the close it derives from. */
const ONE_CLOSE_DERIVED = /^RV\d+$/;

/** The labels in `text` that move the subject (transparent ones omitted); `subject` null = a non-licensed label. */
function labelsOf(text: string): Label[] {
  const out: Label[] = [];
  for (const m of text.matchAll(LABEL)) {
    const word = m[0];
    const end = m.index + word.length;
    if (TRANSPARENT.test(word)) continue;
    // A rating (`BBB-`, `BBB+`); a `+` glued to a letter joins two ids (`EXSH+VSTOXX`) and is no rating.
    if (/^(?:[\-−](?!\d)|\+(?![\d\p{L}]))/u.test(text.slice(end, end + 2)) && !word.includes("/")) continue;
    const licensed = LICENSED_ALIASES.has(word); // a ratio (`VIX/VIX3M`) is never in it; a pinned pair (`USD/JPY`) is
    if (!licensed && PAST_PRINT_VERB.test(text.slice(0, m.index))) continue; // `closed <source> 7,688.62`: the quote's source
    if (word === "OAS") {
      const prev = out.at(-1);
      if (prev && prev.end >= m.index - 1 && prev.subject !== null) continue; // `HY OAS` stays HY
      out.push({ start: m.index, end, subject: "OAS" });
      continue;
    }
    if (!licensed && (word.match(/[A-Z]/g) ?? []).length < 2) continue;
    out.push({ start: m.index, end, subject: licensed ? word : null });
  }
  return out;
}

/** `replacement` = the span's rewrite (`—`, or a `<mult>×<base>` span's product); `token` = the span's text as quoted. */
type Hit = { start: number; end: number; subject: string; token: string; replacement: string };

/** `<mult>×` (or an ASCII `x` glued to the multiplier: `1.3x`) ending the text before a number; a spaced `×` glued to
 *  an integer (`0.9 ×10`) is a `×n` count, not a base. */
const MULTIPLIER = /(?<![\p{L}\p{N}_.,])(\d+(?:\.\d+)?)(\s*)(?:×|(?<=\d)[xX])(\s*)$/u;

/** `mult × base` rounded to the base's decimals, in the base's grouping and unit (`1.3`, `73.39` → `95.41`). */
function productOf(mult: string, value: string, unit: string | undefined): string {
  const dot = value.indexOf(".");
  const decimals = dot < 0 ? 0 : value.length - dot - 1; // an integer base has none
  const n = Number(mult) * Number(value.replace(/,/g, ""));
  const digits = value.includes(",") ? n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : n.toFixed(decimals);
  return `${digits}${unit ?? ""}`;
}

function hitsOf(text: string, ctx: LevelContext): Hit[] {
  if (/^https?:\/\//.test(text)) return [];
  const labels = labelsOf(text);
  const ends = [...text.matchAll(CLAUSE_END)].map((m) => m.index);
  const ctxSubject = ctx.subject !== undefined && LICENSED_ALIASES.has(ctx.subject) ? ctx.subject : null;
  const hits: Hit[] = [];
  const kept: (Hit & { value: string })[] = [];
  const values = new Set<string>();
  let lastHitEnd = -1;
  for (const m of text.matchAll(NUMBER)) {
    const start = m.index;
    const end = start + m[0].length;
    const clauseStart = ends.filter((e) => e < start).reduce((a, e) => Math.max(a, e + 1), 0);
    const label = labels.filter((l) => l.end <= start && l.start >= clauseStart).at(-1);
    const derived = label !== undefined && label.subject === null && ONE_CLOSE_DERIVED.test(text.slice(label.start, label.end));
    const subject = label ? (derived ? ctxSubject : label.subject) : clauseStart === 0 ? ctxSubject : null;
    if (subject === null) continue;
    const before = text.slice(clauseStart, start);
    const after = text.slice(end);
    const prevChar = before.at(-1) ?? "";
    const [, sign, value, unit] = m as unknown as [string, string, string, string | undefined];
    const decimal = value.includes(".");
    const grouped = value.includes(",");
    const close = isCloseSubject(subject);
    // `$`: a close's price (the span takes the `$`), unless a magnitude suffix makes it money; on any other subject, money.
    const dollar = prevChar === "$";
    if (dollar && (!close || sign !== "" || unit !== undefined || MONEY_SUFFIX.test(after))) continue;
    const spanStart = dollar ? start - 1 : start;
    const hit = { start: spanStart, end, subject, token: text.slice(spanStart, end), replacement: "—" };
    const scrub = (): void => {
      hits.push(hit);
      values.add(value);
      lastHitEnd = end;
    };
    const keep = (): void => void (decimal && kept.push({ ...hit, value }));
    // Rule 2 — never a level.
    if (prevChar === "–") {
      if (/^\s*–\s*$/.test(text.slice(lastHitEnd, start))) scrub(); // the range's first half was a hit
      continue;
    }
    if (HYPHENATED.test(after)) continue;
    const closePrint = (grouped || dollar) && /^\s+close\b(?!-)/.test(after); // `6,750 close`: a print, never a count
    if (!decimal && unit === undefined && (YEAR.test(value) || (COUNT_NOUN.test(after) && !closePrint))) continue;
    if (close && (sign !== "" || unit !== undefined || DELTA.test(before))) continue; // a close is a price: a signed / % / bp / Δn number is a move or share
    // Rule 5's base, then rule 4's structural keeps.
    const tight = before.trimEnd();
    const mult = MULTIPLIER.exec(before);
    if (mult && !(mult[2] !== "" && mult[3] === "" && !decimal && unit === undefined)) {
      // The base of a multiplier — the series' own observed MA / median: the `<mult>×<base>` span prints the product
      // only where a re-scan keeps it (a comparison before, no print annotation after); elsewhere it would read as a level.
      const multStart = clauseStart + mult.index;
      if (kept.at(-1)?.start === multStart) kept.pop(); // the multiplier was kept as ours; the product now carries it
      const stable = COMPARISON.test(text.slice(clauseStart, multStart)) && !PRINT_NOTE.test(after);
      hits.push({ start: multStart, end, subject, token: text.slice(multStart, end), replacement: stable ? productOf(mult[1]!, value, unit) : "—" });
      values.add(value);
      lastHitEnd = end;
      continue;
    }
    const quoted = PRINT_NOTE.test(after) || (unit !== undefined && PAST_PRINT_VERB.test(before));
    if (!quoted && (prevChar === "/" || tight.endsWith("×") || /^\s*×/.test(after))) {
      keep(); // slash-pair threshold half, a multiplier, or a `×n` count
      continue;
    }
    // Rule 3 — a candidate.
    const adjacent = (label !== undefined && text.slice(label.end, start).replace(/\bOAS\b/g, "").trim() === "") || DELTA.test(before);
    const unitLevel = unit !== undefined && sign === "";
    if (!decimal && !(close ? grouped || dollar : adjacent) && !quoted && !unitLevel && !PRINT_VERB.test(before)) continue;
    if (!quoted && (COMPARISON.test(before) || CRITERION_AFTER.test(after))) {
      keep();
      continue;
    }
    scrub();
  }
  // An echo: a kept threshold that repeats a scrubbed level verbatim (`max5 3.59 <3.64` beside `peak 3.64`) IS that level.
  for (const k of kept) if (values.has(k.value)) hits.push(k);
  hits.sort((a, b) => a.start - b.start);
  return hits;
}

/** Each observed licensed level in `text`, as `"<subject> <token>"` (e.g. `"CCC 13.16 %"`). */
export function findLicensedLevels(text: string, ctx: LevelContext = {}): string[] {
  return hitsOf(text, ctx).map((h) => `${h.subject} ${h.token}`);
}

/** `text` with every observed licensed level rewritten to `—` (a `<mult>×<level>` threshold to its product); thresholds, ✓/✗ and words stay. */
export function scrubLicensedLevels(text: string, ctx: LevelContext = {}): string {
  let out = text;
  for (const h of hitsOf(text, ctx).reverse()) out = `${out.slice(0, h.start)}${h.replacement}${out.slice(h.end)}`;
  return out;
}

/** Keys the leg walker never enters: the run stamps and the run history. */
const UNTOUCHED_KEYS: ReadonlySet<string> = new Set(["runs", "runAt", "asOf", "run"]);

/** The first non-transparent label of a leg's `tag.indicator` (else its `rule`) — the subject of its value strings; of a
 *  joined tag (`EXSH+VSTOXX`), the first id. */
function ruleSubject(rule: string): string | undefined {
  const first = labelsOf(rule)[0];
  return first ? (first.subject ?? rule.slice(first.start, first.end)) : undefined;
}

/** The numbers of a `shocks[<id>]` entry that print the series' own level (or its σ); its dates and flags are not levels. */
const SHOCK_LEVEL_KEYS: ReadonlySet<string> = new Set(["base", "peak", "last", "sigma"]);

/** A `shocks` map (keyed by registry id): each licensed id's level numbers pass through `num`, which returns the replacement. */
function shockLevels(shocks: unknown, path: string, num: (n: number, path: string, id: string) => number | null): unknown {
  if (shocks === null || typeof shocks !== "object" || Array.isArray(shocks)) return shocks;
  return Object.fromEntries(
    Object.entries(shocks as Record<string, unknown>).map(([id, sh]) => [
      id,
      sh === null || typeof sh !== "object" || !isLicensedId(id)
        ? sh
        : Object.fromEntries(Object.entries(sh as Record<string, unknown>).map(([k, n]) => [k, SHOCK_LEVEL_KEYS.has(k) && typeof n === "number" ? num(n, `${path}.${id}.${k}`, id) : n])),
    ]),
  );
}

/** Walk every string of a leg JSON (skipping `UNTOUCHED_KEYS` and `url`s) with the subject a sibling
 *  `tag.indicator` (else `rule`; a `rule` opening on a ratio wins) supplies — a derived series of a licensed tag (`RV10` under `EXSH`) scrubs as that close; `visit` returns the replacement. A `shocks` map's licensed level numbers go through `num`. */
function walk(v: unknown, path: string, ctx: LevelContext, visit: (s: string, path: string, ctx: LevelContext) => string, num: (n: number, path: string, id: string) => number | null): unknown {
  if (typeof v === "string") return visit(v, path, ctx);
  if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`, ctx, visit, num));
  if (v === null || typeof v !== "object") return v;
  const rec = v as Record<string, unknown>;
  const tag = rec.tag !== null && typeof rec.tag === "object" ? (rec.tag as Record<string, unknown>).indicator : undefined;
  const named = typeof tag === "string" ? tag : typeof rec.rule === "string" ? rec.rule : undefined;
  // A rule opening on a slash label names its own series: a ratio (`EXSH/SPY RS`, never the tag's close) or a pinned pair (`USD/JPY`).
  const ruled = typeof rec.rule === "string" ? ruleSubject(rec.rule) : undefined;
  const inner = named === undefined ? ctx : { subject: ruled?.includes("/") === true ? ruled : ruleSubject(named) };
  return Object.fromEntries(
    Object.entries(rec).map(([k, x]) => {
      if (UNTOUCHED_KEYS.has(k) || k === "url") return [k, x];
      const at = `${path}.${k}`;
      return [k, walk(k === "shocks" ? shockLevels(x, at, num) : x, at, inner, visit, num)];
    }),
  );
}

/** One observed licensed level in a leg JSON: `kind` = the subject's class (a CLOSE price or an INDEX level); `scrubbed` = the
 *  whole string at `path` as the scrub rewrites it (absent on a `shocks` number, which the scrub nulls). */
type LegLevelHit = { path: string; hit: string; kind: "close" | "index"; scrubbed?: string };

/** Every observed licensed level in a leg JSON — prose prints and a licensed id's `shocks` numbers. */
export function findLicensedLevelsInLeg(live: unknown): LegLevelHit[] {
  const out: LegLevelHit[] = [];
  walk(
    live,
    "",
    {},
    (s, path, ctx) => {
      const found = hitsOf(s, ctx);
      if (found.length) {
        const scrubbed = scrubLicensedLevels(s, ctx);
        for (const h of found) out.push({ path, hit: `${h.subject} ${h.token}`, kind: isCloseSubject(h.subject) ? "close" : "index", scrubbed });
      }
      return s;
    },
    (n, path, id) => (out.push({ path, hit: String(n), kind: isCloseSubject(id) ? "close" : "index" }), n),
  );
  return out;
}

/** The leg JSON with every string scrubbed and a licensed id's `shocks` numbers nulled (`UNTOUCHED_KEYS` byte-identical), plus the number of levels replaced. */
export function scrubLicensedLevelsInLeg<T>(live: T): { live: T; count: number } {
  let count = 0;
  const next = walk(
    live,
    "",
    {},
    (s, _path, ctx) => {
      count += findLicensedLevels(s, ctx).length;
      return scrubLicensedLevels(s, ctx);
    },
    () => (count++, null),
  ) as T;
  return { live: next, count };
}
