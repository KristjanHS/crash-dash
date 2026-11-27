/**
 * `docs/reference.md` shape contract — the one module the gate (`scripts/reference-shape.test.ts`) and the
 * fixer (`scripts/fix-reference-shape.ts`) both read, so no ceiling or section name is restated.
 *
 * Two failure modes (round-4 B4): a unit over `MAX_UNIT_LINES` is MECHANICAL — `joinOverlongUnits` collapses
 * it and `npm run check` runs the fixer first, so it never blocks; a section over its ceiling means the
 * section GREW and stays blocking — never auto-trim prose.
 *
 * Ceilings are hand-set with headroom over the shipped unit count (ruled 2026-08-31, generalized
 * 2026-09-02): no prose-count pin — a passed section's guard is shape.
 */
export const MAX_UNIT_LINES = 2;

export const SECTIONS: ReadonlyArray<{ start: string; ceiling: number }> = [
  { start: "## [arch] 9.", ceiling: 50 },
  { start: "## [indicator] Bands & the threshold multiplier", ceiling: 42 },
  { start: "## [live] Live constraints", ceiling: 80 },
  { start: "## [prod] ⚠️ Gotchas", ceiling: 16 },
  { start: "## [live] Standing closures", ceiling: 24 },
  { start: "## [runbook] Front-end", ceiling: 20 },
  { start: "## [runbook] Database (local Supabase)", ceiling: 18 },
  { start: "## [runbook] Deploying to prod", ceiling: 16 },
];

/** Absolute [start, end) line range of a section, or null when its heading is missing. */
export function sectionRange(lines: string[], start: string): { s: number; e: number } | null {
  const s = lines.findIndex((l) => l.startsWith(start));
  if (s === -1) return null;
  let e = lines.findIndex((l, i) => i > s && l.startsWith("## "));
  if (e === -1) e = lines.length;
  return { s, e };
}

// A unit = one `- ` bullet with its indented continuation lines, or one paragraph (a run of unindented
// non-bullet lines). Headings and blank lines close the open unit.
export function unitRanges(lines: string[]): Array<{ s: number; e: number }> {
  const out: Array<{ s: number; e: number }> = [];
  let s: number | null = null;
  let head = "";
  const flush = (i: number) => {
    if (s !== null) out.push({ s, e: i });
    s = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || /^#/.test(line)) flush(i);
    else if (/^- /.test(line)) {
      flush(i);
      s = i;
      head = line;
    } else if (s !== null && (/^\s+\S/.test(line) || !/^- /.test(head))) {
      // continuation of the open unit
    } else {
      flush(i);
      s = i;
      head = line;
    }
  }
  flush(lines.length);
  return out;
}

export function units(lines: string[]): string[][] {
  return unitRanges(lines).map((r) => lines.slice(r.s, r.e));
}

/**
 * A continuation line carrying its own block structure — a sub-bullet, an ordered item, a table row, a
 * quote, a fence, a thematic break — cannot be joined into the line above without destroying it.
 */
export function isStructural(line: string): boolean {
  return /^\s*(?:[-*+]\s|\d+\.\s|\||>|```|(?:-{3,}|\*{3,}|_{3,})\s*$)/.test(line);
}

/** A markdown hard break (trailing two spaces, or a trailing backslash) is erased by joining. */
export function hasHardBreak(line: string): boolean {
  return /(?: {2}|\\)$/.test(line);
}

/** Why a unit cannot be auto-joined, or null when the joiner may collapse it. */
export function unjoinableReason(chunk: string[]): string | null {
  if (chunk.slice(1).some(isStructural)) return "structural continuation";
  if (chunk.slice(0, -1).some(hasHardBreak)) return "hard break would be erased";
  return null;
}

export type JoinResult = {
  text: string;
  joined: Array<{ section: string; lines: number; head: string }>;
  unjoinable: Array<{ section: string; lines: number; head: string; reason: string }>;
};

/**
 * Collapse every over-long unit to a single line (continuations trimmed, single-space joined).
 * Never wraps at a column; never truncates. A unit whose continuations are structural is left alone and
 * reported — the gate then fails it, which is the intended outcome.
 */
export function joinOverlongUnits(text: string): JoinResult {
  const lines = text.split("\n");
  const joined: JoinResult["joined"] = [];
  const unjoinable: JoinResult["unjoinable"] = [];
  // Collect edits first, apply back-to-front so earlier indices stay valid.
  const edits: Array<{ s: number; e: number; line: string }> = [];

  for (const { start } of SECTIONS) {
    const range = sectionRange(lines, start);
    if (!range) continue;
    const body = lines.slice(range.s, range.e);
    for (const u of unitRanges(body)) {
      const n = u.e - u.s;
      if (n <= MAX_UNIT_LINES) continue;
      const abs = { s: range.s + u.s, e: range.s + u.e };
      const chunk = lines.slice(abs.s, abs.e);
      const head = (chunk[0] ?? "").trim();
      const reason = unjoinableReason(chunk);
      if (reason) {
        unjoinable.push({ section: start, lines: n, head, reason });
        continue;
      }
      const merged = chunk
        .map((l, i) => (i === 0 ? l.replace(/\s+$/, "") : l.trim()))
        .filter((l) => l !== "")
        .join(" ");
      edits.push({ ...abs, line: merged });
      joined.push({ section: start, lines: n, head });
    }
  }

  for (const edit of edits.sort((a, b) => b.s - a.s)) {
    lines.splice(edit.s, edit.e - edit.s, edit.line);
  }
  return { text: lines.join("\n"), joined, unjoinable };
}

export const REFERENCE_PATH = new URL("../docs/reference.md", import.meta.url).pathname;
