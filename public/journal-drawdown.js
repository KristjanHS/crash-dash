/**
 * Per-user pension DRAWDOWN, computed in the browser from the user's own journal rows
 * (Stage J1.3). A pure, DOM-free, IO-free seam — every function takes plain data and
 * returns plain data, so `journal-drawdown.test.js` covers it with no jsdom and pins it
 * for byte-equality against the real `src/pension.ts` engine (`frontend.md` §Testable
 * slices go in a pure seam module).
 *
 * It is a deliberate re-implementation, NOT an import: the browser cannot import a `.ts`
 * seam at runtime, so this file carries the same blend/drawdown/confirm math as
 * `src/pension.ts` and the parity test is what keeps the two in lock-step. Nothing here
 * imports from `src/` — the one live constant it would otherwise copy (the nine leg-close
 * slugs, `LEG_SLUG`/`legCloseId` in `src/scoreboard.ts`) is NEVER re-typed here; it is
 * received through the `ladder` argument, which the server derives from that single source
 * and serves on `/api/config` (see `legIdOf`).
 *
 * SECURITY INVARIANT (plan J1.3): the `LEGP_*` leg id is derived from the row's `rung`
 * via `ladder[rung - 1]` ONLY — never from the stored `sleeve` text. RLS constrains
 * `user_id` and the DB constrains `rung between 1 and 9`, but NOTHING server-side
 * constrains `sleeve`: any authenticated caller can write arbitrary text straight to
 * PostgREST. So `sleeve` stays display-only and never reaches an id lookup or a URL.
 */

/** The synthetic cash sleeve's key — a constant-1 series minted client-side, never fetched. */
export const CASH = "CASH";

/**
 * The leg-close id for a 1-based ladder rung, resolved from the rung ONLY (the security
 * invariant). `ladder` is the rung-ordered array of leg ids the server serves on
 * `/api/config` (`LADDER.map(legCloseId)`, single-sourced from `src/scoreboard.ts`); this
 * function reads `ladder[rung - 1]` and touches the stored `sleeve` string nowhere.
 * Returns `null` for a rung outside the served ladder — the caller drops such a row rather
 * than fabricating an id.
 */
export function legIdOf(rung, ladder) {
  if (!Number.isInteger(rung) || rung < 1 || rung > ladder.length) return null;
  return ladder[rung - 1];
}

/**
 * Fold the user's journal rows into a `DatedWeights`-shaped book: one segment per DISTINCT
 * `entry_date`, oldest→newest, each `{ from: entry_date, weights: { [legId]: 1 - cash,
 * CASH: cash } }` where `cash = cash_pct / 100` and `legId = ladder[rung - 1]`.
 *
 * On a date tie the row with the LATEST `created_at` wins (the last decision recorded that
 * day is the one held). A row whose rung falls outside the served ladder is dropped (its id
 * cannot be resolved from the rung). Rows are copied, never mutated.
 *
 * Mirrors the shape `src/pension_holdings.ts` validates and `portfolioSeries` consumes, so
 * the output feeds `chainBook` directly.
 */
export function bookFromEntries(rows, ladder) {
  const winnerByDate = new Map();
  for (const row of rows ?? []) {
    const date = String(row?.entry_date ?? "");
    if (date === "") continue;
    const prev = winnerByDate.get(date);
    // Latest `created_at` wins the date; a missing timestamp sorts oldest so a real row beats it.
    if (prev === undefined || String(row?.created_at ?? "") >= String(prev.created_at ?? "")) {
      winnerByDate.set(date, row);
    }
  }
  const book = [];
  for (const [date, row] of winnerByDate) {
    const legId = legIdOf(Number(row?.rung), ladder);
    if (legId === null) continue;
    const cash = Number(row?.cash_pct) / 100;
    book.push({ from: date, weights: { [legId]: 1 - cash, [CASH]: cash } });
  }
  book.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  return book;
}

/**
 * The weights in force at `obsDate` — the newest segment whose `from` is at or before it.
 * Returns the segment's OWN `weights` object (reference-stable per segment) so a
 * switch-date is detected by reference inequality, exactly as `src/pension.ts`
 * `effectiveWeights` + `portfolioSeries` do. Throws when no segment covers the date.
 */
function effectiveWeights(obsDate, dated) {
  let held;
  for (const seg of dated) {
    if (seg.from <= obsDate) held = seg.weights;
    else break;
  }
  if (held === undefined) {
    throw new Error(`[journal-drawdown] no book segment covers ${obsDate} (earliest is ${dated[0]?.from ?? "<empty>"})`);
  }
  return held;
}

/**
 * The newest index STRICTLY BEFORE `i` at which every positively-weighted sleeve of the
 * incoming book has a usable (present, > 0) value, or `null` when none exists (day 0, or an
 * incoming book whose feeds start at `i`). Mirrors `pricedBaseIdx` in `src/pension.ts`.
 */
function pricedBaseIdx(legs, i, weights) {
  const held = Object.entries(weights).filter(([, w]) => w > 0);
  for (let j = i - 1; j >= 0; j--) {
    const eur = legs[j].eur;
    if (held.every(([sleeve]) => (eur[sleeve] ?? 0) > 0)) return j;
  }
  return null;
}

/**
 * One day's constant-weight blend of `legs[i]` against the segment base `legs[base]`:
 * `Σ_sleeve w_s · (v_s,i / v_s,base)`, exactly `1` at `i === base`. Zero-weight sleeves are
 * skipped; a weighted sleeve missing at the base or at `i` throws. Mirrors `blendAt`.
 */
function blendAt(legs, i, base, weights) {
  const baseEur = legs[base].eur;
  const leg = legs[i];
  let blend = 0;
  for (const [sleeve, w] of Object.entries(weights)) {
    if (w <= 0) continue;
    const v0 = baseEur[sleeve];
    if (v0 === undefined || v0 <= 0) {
      throw new Error(`[journal-drawdown] weighted sleeve ${sleeve} is absent from the aligned legs (or opens at ${String(v0)}) - cannot blend`);
    }
    const v = leg.eur[sleeve];
    if (v === undefined) {
      throw new Error(`[journal-drawdown] sleeve ${sleeve} missing on aligned day ${leg.date} - inner join is broken`);
    }
    blend += w * (v / v0);
  }
  return blend;
}

/**
 * The blended synthetic portfolio over the dated book, chain-linked at every switch date.
 * A faithful re-implementation of `portfolioSeries(legs, series)` in `src/pension.ts`
 * (parity-pinned): `series` is the aligned per-day leg values (each day carries the leg id's
 * value plus a minted `CASH: 1`); `dated` is the `bookFromEntries` output.
 */
export function chainBook(series, dated) {
  const out = [];
  let baseIdx = 0;
  let baseLevel = 1;
  let held;
  for (let i = 0; i < series.length; i++) {
    const leg = series[i];
    const w = effectiveWeights(leg.date, dated);
    if (w !== held) {
      const priced = pricedBaseIdx(series, i, w);
      baseIdx = priced ?? i;
      baseLevel = (priced === null ? out[i - 1] : out[priced]) ?? 1;
      held = w;
    }
    out.push(blendAt(series, i, baseIdx, w) * baseLevel);
  }
  return out;
}

/**
 * Trailing-peak drawdown for each day: `dd_t = v_t / max(v_{≤t}) − 1`, in [−1, 0]. A new
 * high resets the drawdown to 0. Mirrors `drawdownSeries` in `src/pension.ts`.
 */
export function drawdown(values) {
  const out = [];
  let peak = -Infinity;
  for (const v of values) {
    if (v > peak) peak = v;
    out.push(peak > 0 ? v / peak - 1 : 0);
  }
  return out;
}

/**
 * Classify a (negative) drawdown into a band by the deepest cut it has breached, inclusive
 * at the cut (`dd ≤ cut`). `cuts` is `config.scoringCuts.pension` (`{ dip, correction, bear }`,
 * served from the `src/pension.ts` constants). Mirrors `bandOf`.
 */
export function bandOf(dd, cuts) {
  if (dd <= cuts.bear) return "BEAR";
  if (dd <= cuts.correction) return "CORRECTION";
  if (dd <= cuts.dip) return "DIP";
  return "CALM";
}

/**
 * The confirmation fold: a candidate band is adopted only once it has held for `closes`
 * consecutive closes, so a one-day head-fake doesn't flip the card. A faithful
 * re-implementation of the generic `confirmedSeries<T>` fold (`src/domain-fold.ts`), the
 * same audited logic the fast ladder and the off-ladder tracks share. `closes ≤ 1`
 * degenerates to the identity. Throws on an empty series.
 */
export function confirmedSeries(rawBands, closes) {
  if (rawBands.length === 0) throw new Error("confirmedSeries: empty history");
  const out = [];
  let confirmed = rawBands[0];
  for (let i = 0; i < rawBands.length; i++) {
    if (i >= closes - 1) {
      const candidate = rawBands[i];
      if (candidate !== confirmed) {
        let held = true;
        for (let j = i - closes + 1; j <= i; j++) {
          if (rawBands[j] !== candidate) {
            held = false;
            break;
          }
        }
        if (held) confirmed = candidate;
      }
    }
    out.push(confirmed);
  }
  return out;
}

/**
 * The latest CONFIRMED band — the card's headline. Mirrors `pensionConfirmBand` in
 * `src/pension.ts`. Throws on an empty series (the bootstrap needs ≥1 day).
 */
export function confirmBand(rawBands, closes) {
  return confirmedSeries(rawBands, closes).at(-1);
}
