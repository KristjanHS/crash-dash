import { isoDay } from "./dates.js";
/**
 * MARKET + PUBLISHER CLOSURES — the registry-free LEAF under `source-holidays.ts` (which adds the venue-derived
 * `LEGP_*` ids on top and owns `isSourceHoliday`/`recentMarketDay`). Zero `src/` imports, so BOTH slot-lag
 * resolution points — `feed-lag.ts` (read path) and `scorers-core.ts` (run path) — can hold it without closing
 * a cycle (`source-holidays.ts` → `scoreboard.ts` → `families.ts` → `feed-lag.ts` is a value chain already).
 *
 * TWO DISTINCT CLOSURE KINDS, kept apart on purpose:
 *   • a SOURCE closure ({@link MARKET_CLOSURES}) — the index/exchange prints nothing that day, so no print will
 *     ever supersede an estimate dated on it (the nowcast + hole probe read these via `isSourceHoliday`);
 *   • a PUBLISHER closure ({@link PUBLISHER_CLOSURES}) — the value EXISTS but its publisher cannot post it that day:
 *     FRED (St. Louis Fed) skips every US federal holiday, so ICE BofA's Columbus-Day OAS print lands a day late
 *     with nothing wrong. Only the slot-lag path reads these — an estimate dated on one is still a real session.
 *
 * {@link isSlotExcused} is their union, the ONE term the slot-age count subtracts (`slotAge`'s `excused`
 * predicate). Live cause (2026-10-13, "17 of 123 feeds behind"): the per-target containment grid cannot learn a
 * closure that falls AFTER the target's last print — nobody has printed since, so no peer can be charged for
 * printing on it — and NYSE-calendar peers (open on Columbus Day) unioned 10-12 into every FRED feed's grid.
 * Every FRED-published id then read one slot behind on a day FRED could not have posted anything.
 *
 * ⚠ SCOPE. Ids here are STATIC registry ids; the venue-derived `LEGP_*` legs are appended only in
 * `source-holidays.ts` (needs `scoreboard.ts`), so a Xetra leg is NOT slot-excused on its closures (May 1,
 * Dec 24/31). The pooled `LEGP_*` writer delay (release-delay.ts) absorbs only the leg's ordinary T+1 — NOT the
 * extra slot an NYSE-open/Xetra-closed day (e.g. 2026-12-24) adds to the shared grid, so after one a Xetra leg
 * carries one slot of age it never could have filled — behind if that crosses its cut (known limitation, not
 * excused). Coverage is 2026–2027 (`source-holidays.test.ts` reds when the UTC year outgrows it); outside the
 * window nothing is excused.
 */

export type Market = "US" | "US_RATES" | "UK" | "JP" | "TARGET" | "XETRA" | "ICE_BOFA" | "US_GAS";

/** Gregorian Easter Sunday (anonymous computus) → UTC epoch ms. */
function easterSundayUtc(year: number): number {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const h = (19 * a + b - Math.floor(b / 4) - Math.floor((b - Math.floor((b + 8) / 25) + 1) / 3) + 15) % 30;
  const l = (32 + 2 * (b % 4) + 2 * Math.floor(c / 4) - h - (c % 4)) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const n = h + l - 7 * m + 114;
  return Date.UTC(year, Math.floor(n / 31) - 1, (n % 31) + 1);
}

/** TARGET2 closing day: Jan 1, Good Friday, Easter Monday, May 1, Dec 25, Dec 26 (ECB calendar since 2002). */
export function isTargetClosed(isoDate: string): boolean {
  const md = isoDate.slice(5);
  if (md === "01-01" || md === "05-01" || md === "12-25" || md === "12-26") return true;
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  const easter = easterSundayUtc(Number(isoDate.slice(0, 4)));
  return t === easter - 2 * 86_400_000 || t === easter + 86_400_000;
}

/** The euro sovereign legs minus TARGET-closed days: the daily-bar feed still prints FR/IT/ES/DE 10y bars on them
 *  (a non-zero move off a thin market), which the old Bundesbank/Webstat joins never held. The ONE drop — run-cycle,
 *  backfill and the sovereign probes all apply it, so every consumer folds the same base. */
export function dropTargetHolidays<T extends { readonly date: string }>(obs: readonly T[]): T[] {
  return obs.filter((o) => !isTargetClosed(o.date));
}

/** Weekday closures over `years` under `closed` (weekends never need excusing). */
const weekdayClosures = (years: readonly number[], closed: (iso: string) => boolean): string[] =>
  years.flatMap((y) => {
    const out: string[] = [];
    for (let t = Date.UTC(y, 0, 1); t < Date.UTC(y + 1, 0, 1); t += 86_400_000) {
      const d = new Date(t);
      if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && closed(isoDay(d))) out.push(isoDay(d));
    }
    return out;
  });

/** US federal holidays (OPM) 2026–2027, observed weekdays — the days FRED posts nothing (the St. Louis Fed is
 *  closed), i.e. `PUBLISHER_CLOSURES.FRED`. SIFMA's full closes (`US_RATES` below) are this list MINUS
 *  {@link SIFMA_OPEN_FEDERAL}: Columbus + Veterans Day in, Good Friday out, but not a Saturday-New-Year Friday. @internal */
export const US_FEDERAL_HOLIDAYS: readonly string[] = [
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-10-12",
  "2026-11-11", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06",
  "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-24",
  // 2028-01-01 is a Saturday: OPM observes Fri 2027-12-31 (federal + FRED closed); NYSE does NOT (its Saturday-Jan-1
  // rule) and SIFMA only early-closes, so the date is federal/FRED-only — `US` and `US_RATES` below must NOT list it
  // (pinned in market-closures.test.ts).
  "2027-12-31",
];

/** The one federal-holiday shape SIFMA does NOT fully close: a Friday Dec 31 observed for a Saturday Jan 1 (SIFMA
 *  recommends only an early close; H.15 printed 2021-12-31). Any federal Dec 31 is that shape, so derive it by date. */
const SIFMA_OPEN_FEDERAL = (d: string): boolean => d.endsWith("-12-31");

// Exchange closures (NYSE / SIFMA / England / TSE / TARGET / Xetra / ICE BofA / Henry Hub), 2026–2027; outside them a
// holiday reads as a hole (coverage pinned in `source-holidays.test.ts`). An id listed in two calendars closes on their union.
export const MARKET_CLOSURES: Record<Market, { holidays: readonly string[]; ids: readonly string[] }> = {
  US: {
    holidays: [
      "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07",
      "2026-11-26", "2026-12-25",
      "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06",
      "2027-11-25", "2027-12-24",
    ],
    ids: [
      "R5", "R6", "F4", "F5", "F6", "F8", "F9", "F13", "OVX", "NVDA",
      "SPCONC", "DB_SMH", "DB_XLK", "RS_SMH", "RS_XLK", "KBE_RS", "MU_RS", "G1", "NG", "CG", "VT", "GT", "GB", "DISP",
      "CQS", "price-accel", "complacency-vix", "complacency-high", "complacency-duration", "SPY", "VEA", "SP500IT",
      "SMH", "VWO", "VGK", "VIX", "VIX3M", "VTP", "HCX", "FDX", "VXNCLS", "VXNT", "VXSMH",
    ],
  },
  // SIFMA US full closes (https://www.sifma.org/resources/guides-playbooks/holiday-schedule): H.15/GSW skip Columbus +
  // Veterans Day but print an early-close Good Friday (2026-04-03); CQS (BAA10Y) and G1 (DCOILWTICO) skip both, so
  // sit in US too — FRED rows read 2026-10-13: both blank on Columbus 2025-10-13, Veterans 2025-11-11, Good Friday
  // 2026-04-03, printed either side.
  // R6 (ICE BofAML MOVE, the closes feed's `^MOVE`) sits in BOTH: no bar on Columbus 2025-10-13, Veterans 2025-11-11, Good Friday
  // 2026-04-03 or Memorial Day (prod rows, read 2026-10-13).
  US_RATES: {
    holidays: US_FEDERAL_HOLIDAYS.filter((d) => !SIFMA_OPEN_FEDERAL(d)),
    ids: ["R1", "R2", "R3", "R4", "R6", "R7", "R8", "T10YIE", "T5YIFR", "CQS", "G1", "T10Y3M_RAW"],
  },
  UK: {
    holidays: [
      "2026-01-01", "2026-04-03", "2026-04-06", "2026-05-04", "2026-05-25", "2026-08-31", "2026-12-25", "2026-12-28",
      "2027-01-01", "2027-03-26", "2027-03-29", "2027-05-03", "2027-05-31", "2027-08-30", "2027-12-27", "2027-12-28",
    ],
    ids: ["BRENT"],
  },
  // Weekday closures only, year-end Dec 31–Jan 3 included (a weekend date never needs excusing).
  JP: {
    holidays: [
      "2026-01-01", "2026-01-02", "2026-01-12", "2026-02-11", "2026-02-23", "2026-03-20", "2026-04-29", "2026-05-04",
      "2026-05-05", "2026-05-06", "2026-07-20", "2026-08-11", "2026-09-21", "2026-09-22", "2026-09-23", "2026-10-12",
      "2026-11-03", "2026-11-23", "2026-12-31",
      "2027-01-01", "2027-01-11", "2027-02-11", "2027-02-23", "2027-03-22", "2027-04-29", "2027-05-03", "2027-05-04",
      "2027-05-05", "2027-07-19", "2027-08-11", "2027-09-20", "2027-09-23", "2027-10-11", "2027-11-03", "2027-11-23",
      "2027-12-31",
    ],
    ids: ["JPT"],
  },
  // ECB fixings (€STR, YC, EXR) skip exactly the TARGET days (ECB API 2024–2026); sovereign-quote euro sovereigns are dropped on
  // them (`dropTargetHolidays`).
  TARGET: {
    holidays: weekdayClosures([2026, 2027], isTargetClosed),
    ids: ["ESTR", "EURC", "EPATH", "EURGBP", "BUND", "BONOS"],
  },
  // Xetra `.DE` listings: the TARGET days plus Dec 24 + Dec 31, when ECB fixings still print.
  XETRA: {
    holidays: weekdayClosures([2026, 2027], (d) => isTargetClosed(d) || /-12-(24|31)$/.test(d)),
    ids: ["EXSH_GATE", "INS_RS", "AT1"],
  },
  // FRED ICE BofA OAS (2023-10..2026-10, every series): blank on Jan 1, Good Friday, Dec 25 only. 2027-12-25 is a
  // Saturday and the observed weekday is unverifiable (FRED's ICE window starts 2023-10), so none is listed.
  ICE_BOFA: {
    holidays: ["2026-01-01", "2026-04-03", "2026-12-25", "2027-01-01", "2027-03-26"],
    ids: ["F1", "F2", "F10", "CCC", "BBB"],
  },
  // DHHNGSP extras over NYSE (NG also sits in US): blank on Veterans Day + the day after Thanksgiving in 2025 (Columbus
  // printed); 2024 had the reverse Columbus/Veterans split, so the newest regime is encoded.
  US_GAS: {
    holidays: ["2026-11-11", "2026-11-27", "2027-11-11", "2027-11-26"],
    ids: ["NG"],
  },
};

/**
 * Days a PUBLISHER posts nothing although its sources printed. FRED = every id whose live fetch is `fred.fetchSeries`
 * (the `INDICATORS` loop minus `FEED_OF` reroutes, plus the by-name FRED fetches in run-cycle-feeds/confirmers);
 * the `INDICATORS`-loop half is pinned against `FEED_OF` in `market-closures.test.ts`, the by-name half is restated
 * there by hand (a new by-name `fetchSeries` id is NOT caught — add it to both). A `US_RATES` id's federal holiday is ALSO its source
 * closure EXCEPT a Saturday-New-Year Friday (2027-12-31: Treasuries trade, FRED posts nothing), so for it the entry
 * matters only on that day — it matters every holiday for ICE BofA (prints Columbus Day, posted a day late), Henry
 * Hub and the weekly NFCI.
 * @internal
 */
export const PUBLISHER_CLOSURES: Record<"FRED", { holidays: readonly string[]; ids: readonly string[] }> = {
  FRED: {
    holidays: US_FEDERAL_HOLIDAYS,
    // R5 (VIXCLS) is listed for the predicate (every `fetchSeries` id).
    ids: ["F1", "F2", "F3", "F10", "CCC", "R1", "R2", "R3", "R4", "R5", "R7", "T10YIE", "T5YIFR", "CQS", "G1", "BRENT", "NG", "T10Y3M_RAW", "VXNCLS", "BBB"],
  },
};

/** True when `id`'s publisher posts nothing on `date` (FRED on a US federal holiday). @internal */
export function isPublisherClosed(id: string, date: string): boolean {
  return Object.values(PUBLISHER_CLOSURES).some((c) => c.ids.includes(id) && c.holidays.includes(date));
}

/** True when `date` is a listed closure of one of `id`'s SOURCE calendars. */
function isSourceClosed(id: string, date: string): boolean {
  return Object.values(MARKET_CLOSURES).some((c) => c.ids.includes(id) && c.holidays.includes(date));
}

/**
 * THE slot-excusal term: a grid day on which `id` could not have gained a print. `slotAge` drops such days from
 * `(asOf, today]`. Static ids only (see ⚠ SCOPE above); a `CMP_*` leg is excused through its parent (the grid target).
 *
 *   • SOURCE closure — unconditional: the day's value never exists, so nothing can ever land for it.
 *   • PUBLISHER closure — only while the publisher has not yet had a post day after it (`postDaysAfter ≤ 1`: the
 *     first grid day after the closure is "today", which may not have posted yet — the release-delay term covers
 *     that). The value DOES exist and FRED posts it together with the next day's on its first open day, so from
 *     D+2 on the closure is ordinary history: a feed still stuck before it has missed a real post and must flag
 *     (F1 stuck at 10-09 on Wed 10-14 reads 3 − 1 = 2 > 1 → behind, not 2 − 1 = 1 → fresh).
 */
export function isSlotExcused(id: string, date: string, postDaysAfter: number): boolean {
  return isSourceClosed(id, date) || (postDaysAfter <= 1 && isPublisherClosed(id, date));
}
