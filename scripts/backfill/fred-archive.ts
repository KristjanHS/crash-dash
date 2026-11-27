/**
 * Archived FRED closes beneath a CLAMPED feed's rolling window, keyed by FRED series id.
 *
 * Keyless FRED serves the ICE BofA OAS series over a rolling ~3y window, so a `full` backfill of an id
 * declaring a deeper `backfill.years` cannot reach it from the feed alone; an archive laid beneath the
 * feed deepens the store (backfill is insert-missing, so the stored rows survive a later window).
 */
import { readFileSync } from "node:fs";

import type { Observation } from "../../src/domain-types.js";
import { dropWeekendMarks } from "../../src/ice-weekend-marks.js";
import { loadHyOasVintage } from "../../src/hyoas-vintage.js";

const HY_VINTAGE = loadHyOasVintage();

/** A committed `date,value` CSV under `scripts/backfill/` (`file` resolves against this directory), archived
 *  for `series` — a `BAML*` id sheds its ICE BofA weekend month-end marks here (`dropWeekendMarks`), so the
 *  archive never re-injects what the live feed drops; any other id passes through as filed. */
export function readArchive(file: string, series: string): Observation[] {
  const rows = readFileSync(new URL(file, import.meta.url), "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const [date, value] = line.split(",");
      return { date: date!, value: Number(value) };
    });
  return dropWeekendMarks(series, rows);
}

export const FRED_ARCHIVE: Readonly<Record<string, readonly Observation[]>> = {
  // F1 (Semis 5y): the repo's validated HY vintage (src/hyoas-vintage.ts, → 2025-04-10).
  // ⚠ It ends 2025-04-10: once FRED's window starts later (~2028-04) a `full` rebuild has a hole between the two;
  // only a `--restate` sees it. Absent file (not distributed with this repository) → no archive entry.
  ...(HY_VINTAGE && { BAMLH0A0HYM2: HY_VINTAGE }),
};

/** `feed` with the series' archived closes dated BEFORE the feed's first observation prepended — the live
 *  feed wins wherever the two overlap. A series with no archive passes through untouched. */
export function withFredArchive(series: string, feed: Observation[]): Observation[] {
  const archive = FRED_ARCHIVE[series];
  if (!archive) return feed;
  const first = feed[0]?.date;
  return [...archive.filter((o) => first === undefined || o.date < first), ...feed];
}
