/**
 * The DASHBOARD (`/`) feed-lag marks — one per indicator card, one roll-up per family heading.
 *
 * `/api/status` readings ALREADY carry `lag: boolean` + `ageDays: number` per indicator, so both
 * marks are a paint-only change — no wire change, no new handler, no `openapi.yaml` edit.
 *
 * A pure seam (`.claude/rules/frontend.md`): DOM-free, no module-level side effects, plain `.js` so
 * vitest collects it and `tsc` ignores it — `app.js` executes DOM side effects at import and can
 * never be reached from a test.
 *
 * ⚠ ONE TIER ONLY, AND THE COPY MUST STAY WEAK. `/lab` grades feed lag as LAG vs DEEP-LAG, but
 * that tier is measured only in `api/lab.ts`, by pulling 130 observations per suspect id via
 * `getSeriesBulk` — a real cost deliberately paid there. `/api/status` does NOT carry it and this
 * change does NOT add that walk. So these marks say "lag"/"behind" and NEVER "deep lag".
 * `deep lag ⊂ lag`, so the two surfaces stay consistent while the dashboard states only what it
 * measured. Any copy here asserting a tier this page did not measure is a defect — the
 * substitute-a-value-for-an-absence class this whole area exists to remove. The heading mark is a
 * COUNT of lagging members, not a tier roll-up.
 *
 * ⚠ The mark lights for reasons OUTSIDE OUR CONTROL: EU2's nine unpublished days were an ECB publication
 * pause, verified upstream. Copy must read "this feed is behind", never "something is broken here",
 * or every publication pause reads as an incident.
 *
 * ⚠ This is NOT `verdictHoldIds` / `coverageDegraded` (`src/families.ts`) and must never be folded
 * into them: that field fires only for a lagging member holding the family verdict UP, and it ARMS
 * THE COVERAGE FLOOR. EU2 was GREEN while `credit` was AMBER, so it was `[]` on the very day the
 * feed had been silent for nine days. THESE MARKS ARM NOTHING — display-only, end to end.
 *
 * ⚠ The heading count and the grid are in LOCKSTEP: `renderCard` has no omit path, so every meta the
 * heading counts also paints a card. (Until 2026-08-27 the low-signal toggle could omit a card, letting
 * a heading mark out-live it; that toggle is gone with the tracking-mode machinery.) A future omit path
 * would reopen the divergence — the heading counts every lagging member of the family, not every drawn one.
 */
import { esc } from "./chart-primitives.js";
import { idIfDistinct } from "./leading-name.js";

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/** `ageDays` is NULLABLE (absent, or null on a reading that carries no dated observation). It
 *  renders `—`; printing `0d` would claim a same-day observation the page never saw.
 *
 *  The UNIT is `unit` off the SAME `/api/status` reading — `"slots"` (the feed's own publication
 *  days) for a daily/weekly feed since the slot wire, `"days"`
 *  (calendar days) for monthly/quarterly and every run-row fallback. It is NOT defaulted: a MISSING
 *  unit renders `${n}?` (unknown), never a silent `${n}d` — fabricating "days" for an absent unit is
 *  the substitute-a-value-for-an-absence defect the `FreshnessStamp.ageDays` docblock (src/feed-lag.ts)
 *  exists to kill. The one rendered token feeds BOTH the badge (`⌁ 2 slots`) and the sentence
 *  ("newest observation is 2 slots old"), so the two can never disagree on the unit. */
export function ageText(ageDays, ageUnit) {
  if (!finite(ageDays)) return "-";
  if (ageUnit === "days") return `${ageDays}d`;
  if (ageUnit === "slots") return `${ageDays} slot${ageDays === 1 ? "" : "s"}`;
  return `${ageDays}?`;
}

/** Rule 2 (`public/prose-names.test.ts`): a registry id never renders bare as element text — it is
 *  paired with the label via `idIfDistinct`, exactly as `family-lag.js` / `feedLagFootHtml` do. */
function nameOf(id, label) {
  return [idIfDistinct(label, id), label].filter(Boolean).join(" ");
}

/** The weak-claim clause both marks end with. One sentence on WHY (not our fault), one on the
 *  limit of the claim (lag, ungraded). Kept in one place so the two surfaces cannot drift. */
const WEAK_CLAIM =
  "Usually an upstream publication pause - the source has simply not published since. Lag only: this page does not grade how far behind, the /lab board does.";

/**
 * The per-card mark. Reads `lag` + `ageDays` + `unit` off one `/api/status` reading — the unit
 * rides the reading beside the age (`ReadingDTO.unit`) and is threaded into the rendered token,
 * so a daily feed at 2 slots prints "2 slots", never a wrong "2d".
 *
 * @param {{lag?: boolean, ageDays?: number|null, unit?: "slots"|"days"}|null|undefined} reading
 * @returns {{days: number|null, text: string, title: string, html: string}|null} `null` when the
 *   feed is not lagging, or when there is no reading at all — a fresh card renders an EMPTY slot,
 *   never a `⌁ 0d`. A degraded read (no reading) is "nothing fired", never a mark.
 */
export function cardLagMark(reading) {
  if (!reading || reading.lag !== true) return null;
  const days = finite(reading.ageDays) ? reading.ageDays : null;
  const text = ageText(reading.ageDays, reading.unit);
  const title = `feed behind - newest observation is ${text} old. ${WEAK_CLAIM}`;
  return {
    days,
    text,
    title,
    html: `<span class="card-lag" title="${esc(title)}">⌁ ${esc(text)}</span>`,
  };
}

/**
 * B5/B7 (R7/R9) + L3: the INTRADAY / EST copy for a served point that is an intraday row
 * (`provisional: true` on the wire) as data — `{text, title}`; null otherwise (an EOD row carries no
 * mark). ONE producer of the copy: `intradayMark` renders it as a visible badge (dashboard card), the
 * /lab board folds `title` into the member chip's own tooltip (no visible marker on the tiles —
 * user ruling 2026-09-30).
 * @param {{provisional?: boolean, estimated?: boolean}|null|undefined} row
 * @param {string|undefined} date the served row's own obs date
 */
export function intradayMarkLabel(row, date) {
  if (!row || (row.provisional !== true && row.estimated !== true)) return null;
  // L3/E3: an `estimated` row is the nowcast — EST; every daytime one (also `provisional`) reads
  // `EST · INTRADAY` (a retired plan `intradayMarkLabel`), still headed EST.
  if (row.estimated === true) {
    const text = row.provisional === true ? "EST · INTRADAY" : "EST";
    return {
      text,
      title: `${text}${date ? ` · ${date}` : ""} - estimate carried off the indicator's live proxy (the detail chart's ESTIMATED line); the print replaces it once it lands. The push reads an EOD estimate too, unless its estimator failed the backtest gate.`,
    };
  }
  return {
    text: "INTRADAY",
    title: `INTRADAY${date ? ` · ${date}` : ""} - written before the EOD cutoff, provisional until the EOD close replaces it; the push still reads the last EOD run.`,
  };
}

/**
 * The visible `INTRADAY` / `EST` badge on a dashboard board card whose served point is an intraday row.
 * "" otherwise — the EOD card carries no mark. (/lab tiles do NOT render this; see `intradayMarkLabel`.)
 * @param {{provisional?: boolean, estimated?: boolean}|null|undefined} row
 * @param {string|undefined} date the served row's own obs date
 */
export function intradayMark(row, date) {
  const label = intradayMarkLabel(row, date);
  if (!label) return "";
  const cls = label.text.startsWith("EST") ? "intraday-mark intraday-mark-est" : "intraday-mark";
  return `<span class="${cls}" title="${esc(label.title)}">${esc(label.text)}</span>`;
}

/** E22: `last print D-n · <cadence>` as {text, title} off a served `lastPrint`; null when absent. The server decides
 *  WHEN and WHY (`reason`, src/last-print.ts) — never re-derive it from `cadence` here. Feeds `lastPrintMark` + the /lab tooltip. */
export function lastPrintLabel(tag) {
  if (!tag || typeof tag.date !== "string" || !finite(tag.days)) return null;
  const text = `last print D-${tag.days}${tag.cadence ? ` · ${tag.cadence}` : ""}`;
  const why =
    tag.reason === "cap"
      ? "Behind its market day: no estimate heads the last print, so the card holds it until the next print lands."
      : "No estimate between releases: the card holds the last print until the next one lands.";
  const unit = tag.days === 1 ? "day" : "days";
  return { text, title: `${text} - newest print ${tag.date}, ${tag.days} calendar ${unit} before this run's date. ${why}` };
}

/** E22: the card tag, painted IN PLACE OF `cardLagMark` (app.js) when the reading carries `lastPrint`.
 *  Muted when current; amber + the weak claim only when `lag` is set. */
export function lastPrintMark(reading) {
  const label = lastPrintLabel(reading?.lastPrint);
  if (!label) return null;
  const behind = reading.lag === true;
  const title = behind ? `${label.title} Feed behind its own release cut. ${WEAK_CLAIM}` : label.title;
  const cls = `card-lag card-last-print${behind ? " card-last-print-behind" : ""}`;
  return { text: label.text, title, html: `<span class="${cls}" title="${esc(title)}">${esc(label.text)}</span>` };
}

/**
 * L1: the `INTRADAY · <date>` chip on a /lab section head (floors strip, Families board, Danger ledger) and the
 * dashboard verdict head when the served verdict is the daytime `intraday_verdict` slot (`provisional: true` on
 * the LabResponse / StatusResponse). "" otherwise.
 * @param {{provisional?: boolean, asOf?: string}|null|undefined} d the LabResponse or StatusResponse
 */
export function intradayVerdictChip(d) {
  const label = intradayVerdictLabel(d);
  return label ? `<span class="intraday-mark intraday-verdict" title="${esc(label.title)}">${esc(label.text)}</span>` : "";
}

/** The chip's copy as data ({text, title}) for a textContent/title paint (lab.js upserts it in place); null when
 *  the payload is not a provisional verdict. ONE producer of the copy — `intradayVerdictChip` renders this. */
export function intradayVerdictLabel(d) {
  if (!d || d.provisional !== true) return null;
  const text = `INTRADAY${d.asOf ? ` · ${d.asOf}` : ""}`;
  return {
    text,
    title: `${text} - this section reads the daytime run (intraday bars + same-day estimates); the push still reads the last EOD run, which replaces this view at the evening cron.`,
  };
}

/**
 * The per-family heading roll-up — the dashboard's mirror of the `/lab` tile-header mark, at the
 * weaker claim. `⌁` is the same glyph the `/lab` roll-ups use (`legLagMark`, `family-lag.js`),
 * with the COUNT as a superscript (`⌁²`); `◌` stays the per-cell mark and is not used here.
 *
 * ⚠ NAMED `…CountMark`, NOT `familyLagMark` — that name is TAKEN by `public/family-lag.js`, the
 * `/lab` families-board roll-up, which reads `FeedLagNote[]` off `/api/lab` and claims a TIER. This
 * one reads `/api/status` readings and claims a COUNT (see the ⚠ weak-claim block above). The two
 * must stay greppably distinct — a shared name is exactly the tier-vs-count misread the weak-claim
 * rule exists to prevent.
 *
 * @param {ReadonlyArray<{id: string, label?: string, lag?: boolean, ageDays?: number|null, unit?: "slots"|"days"}>}
 *   members the family's indicators joined to their `/api/status` readings (the reading's `unit`
 *   rides each member, threaded into `ageText` so a slot age never prints as days)
 * @returns {{count: number, ids: string[], which: string, title: string, html: string}|null} `null` when no member
 *   is behind — the happy path renders an EMPTY slot, never a `⌁⁰` (the rule `family-lag.js` and
 *   `legCellLagMark` both follow). Degrades to `null` on a missing/short member list.
 */
export function familyLagCountMark(members) {
  const lagging = (Array.isArray(members) ? members : []).filter((m) => m && m.lag === true && m.id);
  if (lagging.length === 0) return null;
  const which = lagging.map((m) => `${nameOf(m.id, m.label)} · ${ageText(m.ageDays, m.unit)}`).join(" · ");
  const title =
    `feed lag - this family: ${lagging.length} ${lagging.length === 1 ? "feed is" : "feeds are"} behind. ` +
    `${WEAK_CLAIM} ${which}`;
  return {
    count: lagging.length,
    ids: lagging.map((m) => m.id),
    which,
    title,
    html: `<span class="chan-lag" title="${esc(title)}">⌁<sup class="chan-lag-n">${lagging.length}</sup></span>`,
  };
}

/** How many ids the pill tooltip names before it stops listing.
 *  `freshnessFrom`'s roster is ~70 ids, and a native `title=` has no scrollbar and no wrap control —
 *  a 70-id dump renders as an unreadable wall on desktop hover and is invisible on mobile anyway. So
 *  the tooltip names the first `TIP_ID_CAP` and states the remainder as a count: the pill's own text
 *  already carries the exact total, so nothing measured is lost by truncating the NAMES. Display-only
 *  cap — it never changes `feedsLagging`. */
const TIP_ID_CAP = 10;

/**
 * The zone-A PER-FEED pill — the second, independent freshness surface beside the run-wide
 * `feed fresh ✓` heartbeat. Reads ONLY the `/api/status` wire fields `feedsLagging` / `laggingFeedIds` /
 * `feedsTotal`; the heartbeat is untouched and the two CAN disagree — surfacing that is the point.
 *
 * Same weak claim as the marks above: it states a COUNT of feeds past their own cut, never a tier.
 *
 * ⚠ The named ids are paired with their served label via `idIfDistinct`, exactly as `familyLagCountMark`
 * and `public/family-lag.js`'s `nameOf` do — following Rule 2's spirit (`public/prose-names.test.ts`):
 * a feed id IS a registry key and never stands alone as prose. ⚠ That guard does NOT pin this site:
 * it scans for `>${esc(x.id)}`, element text only, with attributes excluded by design, and these ids
 * live in a `title=`. The composition is a convention here, not an enforced one — `feed-age-mark.test.js`
 * is what actually pins it. This matters most for the roster's COMPONENT ids:
 * `freshnessFrom`'s roster is the served registry PLUS the composite components, and the `CMP_*` /
 * `SB_*` ids are stripped from `readings` by `api/status.ts`'s
 * `INTERNAL_SERIES_PREFIXES`, so the dashboard renders them nowhere else — the tooltip was the one
 * place a bare `CMP_FXH_DEXUSEU` could surface. An id with NO label in the map keeps its bare id
 * (`idIfDistinct` returns it unchanged when the label is missing), which is the correct degrade:
 * a component id that `/api/indicators` does not carry still names itself rather than vanishing.
 * The pairing is display-only and CANNOT move `feedsLagging` — the count comes off the wire field.
 *
 * @param {{feedsLagging?: number, laggingFeedIds?: string[], feedsTotal?: number, unmeasuredFeedIds?: string[]}|null|undefined} status
 * @param {string} legend the `LEGEND.feedsBehind` copy from `app.js` (single-sourced there, where
 *   `feed-age-mark.test.js` scans it against the FORBIDDEN vocabulary)
 * @param {Record<string, string>|null|undefined} labels served `id → Indicator.label`, built by
 *   `renderZoneA` from its `indicators`. Omitted/empty ⇒ every id renders bare, the prior behavior.
 * @returns {{lag: boolean, count: number, text: string, title: string, html: string}|null} `null`
 *   when the wire fields are absent (an old cached payload) — a degraded read renders NO pill rather
 *   than a fabricated "0 of 0".
 */
export function feedsBehindPill(status, legend = "", labels = null) {
  if (!status || !finite(status.feedsLagging) || !finite(status.feedsTotal) || status.feedsTotal <= 0) {
    return null;
  }
  const count = status.feedsLagging;
  const total = status.feedsTotal;
  const ids = Array.isArray(status.laggingFeedIds) ? status.laggingFeedIds.filter(Boolean) : [];
  const lag = count > 0; // ruled: ANY id past its own cut, no threshold
  // Feeds whose calendar was uncomputable — NOT behind, appended only when > 0 (an old cached payload
  // has no such field ⇒ 0 ⇒ no clause). Keeps "behind" in both texts (feed-age-mark.test.js:59-61).
  const unmeasured = Array.isArray(status.unmeasuredFeedIds) ? status.unmeasuredFeedIds.filter(Boolean).length : 0;
  const un = unmeasured > 0 ? ` · ${unmeasured} unmeasured` : "";
  const text = lag ? `⌁ ${count} of ${total} feeds behind${un}` : `0 of ${total} feeds behind${un} ✓`;
  // Rule 2: pair each id with its served label. `TIP_ID_CAP` still caps the NAMES, not the count —
  // slice BEFORE naming so the pairing never changes how many ids are listed.
  const nameOf = (id) => {
    const lab = (labels || {})[id];
    return [idIfDistinct(lab, id), lab].filter(Boolean).join(" ");
  };
  const named = ids.slice(0, TIP_ID_CAP).map(nameOf).join(" · ");
  // The remainder is measured against the COUNT the pill prints, not against `ids.length`: the two
  // are independent wire fields (the server derives both from one expression, but a skewed/older
  // cached payload can still pair "3 behind" with one id). Naming one id under a claim of three
  // would read as a complete list — this states the gap instead. Identical output when they agree.
  const rest = Math.max(0, count - Math.min(ids.length, TIP_ID_CAP));
  const which = ids.length === 0 ? "" : ` Behind: ${named}${rest > 0 ? ` … +${rest} more` : ""}.`;
  const title = `${legend}${which} ${WEAK_CLAIM}`.trim();
  return {
    lag,
    count,
    text,
    title,
    html: `<span class="pill ${lag ? "pill-lag" : "pill-fresh"}" title="${esc(title)}">${esc(text)}</span>`,
  };
}
