/**
 * Holdings-journal PURE seam (W5-c / J-4). DOM-free by construction: every function here
 * takes plain data and returns plain data or a markup STRING, so `journal-view.test.js`
 * can cover it with no jsdom (`frontend.md` §Testable slices go in a pure seam module).
 * `journal.js` is the shell
 * that owns `document`, `fetch` and `localStorage` — nothing in this file touches them.
 *
 * Three jobs, in the order the page performs them:
 *   1. read the served dial into the J-3 snapshot (flat five + provenance blob),
 *   2. validate the form and build the exact PostgREST insert row,
 *   3. render the last-N list.
 */

import { SUPABASE_ORIGIN } from "./supabase-host.js";
import { request } from "./http.js";
import { sleeveLabel } from "./sleeve-label.js";
// The drawdown math is the parity-pinned seam; the card reuses it rather than re-deriving (J1.5).
import { CASH, bookFromEntries, chainBook, drawdown, bandOf, confirmBand, legIdOf } from "./journal-drawdown.js";

/** The ladder is 1..9 (aggressive equities → cash); the DB carries the same check. */
export const RUNG_MIN = 1;
export const RUNG_MAX = 9;
/** Cash beside the leg, in percent of the account. */
export const CASH_MIN = 0;
export const CASH_MAX = 100;
/** How many rows the list shows. */
export const LIST_LIMIT = 20;

/**
 * The journal page's own path, as the site serves it (`vercel.json` rewrites `/journal`). S-3:
 * the magic-link `redirect_to` is `location.origin` + THIS constant, never `location.href`,
 * which carries whatever path/query/fragment the link the user clicked supplied. Also the
 * string the project's Redirect-URL allow-list must contain.
 */
export const JOURNAL_PATH = "/journal";

/** The magic-link return target: the site origin plus the fixed journal path, nothing else. */
export const magicLinkRedirect = (origin) => `${String(origin ?? "").replace(/\/+$/, "")}${JOURNAL_PATH}`;

/**
 * The J-3 snapshot, read off a GET /api/status body.
 *
 * The five flat fields are what the B1/M2 measurement groups on; `dial` is the provenance
 * blob — the served payload itself, so a later dial retune cannot silently re-interpret an
 * old row. Every flat field degrades to `null` independently: a pre-first-cron or degraded
 * store serves `verdict.dialState === null`, and a journal entry written then is still a
 * real entry. Reads `dialTargetRung`/`dialBand` (the PERSISTED notify-side fields) first and
 * falls back to the persisted dial blob, so the snapshot matches what was pushed rather than
 * a recompute. E12: the display dial rides the blob as its own `displayDialState` key (null when absent).
 */
export function dialSnapshot(status) {
  const verdict = status?.verdict ?? null;
  const dial = verdict?.dialState ?? null;
  return {
    suggested_rung: numOrNull(verdict?.dialTargetRung ?? dial?.targetRung),
    band: strOrNull(verdict?.dialBand ?? dial?.notifyRegime),
    armed: boolOrNull(dial?.armed),
    fired: boolOrNull(dial?.fired),
    severity: strOrNull(verdict?.level),
    dial: verdict
      ? {
          asOf: status?.asOf ?? null,
          obsDate: verdict.date ?? null,
          level: verdict.level ?? null,
          dialBand: verdict.dialBand ?? null,
          dialTargetRung: verdict.dialTargetRung ?? null,
          heldSleeve: verdict.heldSleeve ?? null,
          dialState: dial,
          displayDialState: verdict.displayDialState ?? null,
        }
      : null,
  };
}

const numOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strOrNull = (v) => (typeof v === "string" && v !== "" ? v : null);
const boolOrNull = (v) => (typeof v === "boolean" ? v : null);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate the form and build the PostgREST insert row.
 *
 * Returns `{ ok: true, row }` or `{ ok: false, errors }` — never throws, because the caller
 * is a submit handler. Keys are the SNAKE_CASE column names: PostgREST posts the object
 * verbatim, so a camelCase key here is a 400 from the database, not a client-side bug.
 * `user_id` is carried on the row because the insert policy checks it against `auth.uid()`;
 * a forged id is rejected by the database, not trusted here.
 */
export function buildEntryRow(form, snapshot, userId, ladder) {
  const errors = [];

  const entryDate = String(form?.entryDate ?? "").trim();
  if (!ISO_DATE.test(entryDate)) errors.push("Date must be YYYY-MM-DD.");

  // J1.2: the sleeve is chosen from the ladder <select>, so it MUST be a current LADDER name —
  // the only client-side constraint on the column (nothing server-side bounds `sleeve`).
  const sleeve = String(form?.sleeve ?? "").trim();
  if (!Array.isArray(ladder) || !ladder.includes(sleeve)) errors.push("Sleeve must be a ladder name.");

  const rung = Number(form?.rung);
  if (!Number.isInteger(rung) || rung < RUNG_MIN || rung > RUNG_MAX) {
    errors.push(`Rung must be a whole number ${RUNG_MIN}-${RUNG_MAX}.`);
  }

  const cashPct = Number(form?.cashPct);
  if (!Number.isFinite(cashPct) || cashPct < CASH_MIN || cashPct > CASH_MAX) {
    errors.push(`Cash % must be between ${CASH_MIN} and ${CASH_MAX}.`);
  }

  if (!userId) errors.push("Sign in before saving an entry.");

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    row: {
      user_id: userId,
      entry_date: entryDate,
      sleeve,
      rung,
      cash_pct: cashPct,
      note: String(form?.note ?? "").trim(),
      // Spread LAST is deliberate: the snapshot owns every column it names, so a form field
      // can never shadow a served dial value.
      ...(snapshot ?? emptySnapshot()),
    },
  };
}

function emptySnapshot() {
  return { suggested_rung: null, band: null, armed: null, fired: null, severity: null, dial: null };
}

/**
 * One list row as markup. Emits `.jr-*` classes ONLY — `journal-view.test.js` pins every one
 * of them against `journal.html`'s scoped stylesheet, because a markup test proves a class is
 * EMITTED and never that it is STYLED (`testing-project.md`).
 *
 * The "vs dial" cell is the point of the whole page: it prints what was held against what the
 * dial suggested, and marks the gap. A row with no snapshot prints "no dial" rather than 0.
 *
 * J1 ruling #2: the held leg is ALWAYS `ladder[rung-1]`, never the stored `sleeve` string — old
 * free-text rows relabel to their rung-derived name, and no unconstrained user text reaches the DOM.
 */
export function entryLine(row, ladder) {
  const gap = describeGap(row);
  const held = Array.isArray(ladder) && ladder[row.rung - 1] ? sleeveLabel(ladder[row.rung - 1]) : `rung ${row.rung}`;
  return [
    `<li class="jr-row">`,
    `<span class="jr-date">${esc(row.entry_date)}</span>`,
    `<span class="jr-held">rung ${esc(row.rung)} · ${esc(held)}</span>`,
    `<span class="jr-cash">${esc(row.cash_pct)}% cash</span>`,
    `<span class="jr-dial" data-gap="${gap.tone}">${esc(gap.text)}</span>`,
    row.note ? `<p class="jr-note">${esc(row.note)}</p>` : "",
    `</li>`,
  ].join("");
}

/** The last-N list, newest first. Empty history renders the empty state, never an empty `<ul>`. */
export function entryList(rows, ladder) {
  if (!rows || rows.length === 0) {
    return `<p class="jr-empty">No entries yet - the first one you save appears here.</p>`;
  }
  return `<ul class="jr-list">${rows.map((row) => entryLine(row, ladder)).join("")}</ul>`;
}

// ---- the drawdown card (J1.5) ------------------------------------------------------

/** Human band word + the journal-LOCAL colour class (J1 ruling #3; CALM carries none). */
const BAND_WORD = { CALM: "Calm", DIP: "Dip", CORRECTION: "Correction", BEAR: "Bear" };
const BAND_CLASS = { DIP: "dd-dip", CORRECTION: "dd-correction", BEAR: "dd-bear" };

/** A drawdown fraction (≤ 0) as a one-decimal percent; null → "n/a". */
export function fmtDd(dd) {
  if (!Number.isFinite(dd)) return "n/a";
  return `${(dd * 100).toFixed(1)}%`;
}

/**
 * The weights in force on `date` — the newest book segment whose `from` is ≤ it, or null when
 * the date precedes the first segment (the card must never chain such a day: chainBook throws).
 */
function weightsAt(date, book) {
  let held = null;
  for (const seg of book) {
    if (seg.from <= date) held = seg.weights;
    else break;
  }
  return held;
}

/**
 * Fold the fetched leg rows (`readingsFromSeries`) into the aligned per-day legs `chainBook` consumes —
 * the browser twin of `alignPensionLegs`: the UNION of the leg calendars (no leg's gaps gate the
 * rest), each day `{ date, eur: { CASH: 1, [legId]: value } }`, and a day is KEPT only when every
 * positively-weighted leg held THAT day has a value (a dark-held-leg day drops out). Days before
 * the first book segment are dropped so chainBook never meets an uncovered date.
 */
function alignReadings(readings, book) {
  const byDate = new Map();
  for (const r of readings ?? []) {
    const date = String(r?.obs_date ?? "");
    const id = String(r?.indicator_id ?? "");
    const val = Number(r?.value);
    if (date === "" || id === "" || !Number.isFinite(val)) continue;
    let eur = byDate.get(date);
    if (!eur) {
      eur = { [CASH]: 1 };
      byDate.set(date, eur);
    }
    eur[id] = val;
  }
  const legs = [];
  for (const date of [...byDate.keys()].sort()) {
    const eur = byDate.get(date);
    const weights = weightsAt(date, book);
    if (weights === null) continue;
    const held = Object.entries(weights).every(([id, w]) => w <= 0 || eur[id] !== undefined);
    if (held) legs.push({ date, eur });
  }
  return legs;
}

/**
 * The drawdown card's view-model, computed from the user's rows + the fetched leg closes.
 * Pure: the shell fetches, this decides. Kinds: `empty` (no priceable entries), `nodata` (entries
 * but the series read returned nothing yet), `ok` (band · dd · peak · per-segment lines), and
 * `unavailable` — `readings === null` (the read failed or came back redacted, `fetchLegReadings`:
 * nothing is computed) or a broken join that throws in the parity math. The band is the CONFIRMED one
 * (J1 ruling #1) — folded through `confirmCloses`. `names` labels each segment by its rung's LADDER
 * name; the segment's leg id is still rung-derived, never the stored sleeve.
 */
export function drawdownModel({ rows, legIds, names, readings, cuts, confirmCloses }) {
  const book = bookFromEntries(rows, legIds ?? []);
  if (book.length === 0) return { kind: "empty" };
  const since = book[0].from;
  if (readings === null) return { kind: "unavailable", since };
  let series;
  let values;
  try {
    series = alignReadings(readings, book);
    if (series.length === 0) return { kind: "nodata", since };
    values = chainBook(series, book);
  } catch {
    return { kind: "unavailable", since };
  }
  const dd = drawdown(values);
  const rawBands = dd.map((d) => bandOf(d, cuts));
  const band = confirmBand(rawBands, confirmCloses);

  // Peak = the high-water day the trailing drawdown is measured from (first occurrence of the max).
  let peakIdx = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[peakIdx]) peakIdx = i;

  // The named-leg → LADDER-name lookup, so a segment prints its rung's name, not the LEGP id.
  const nameById = new Map((legIds ?? []).map((id, i) => [id, (names ?? [])[i] ?? id]));
  const segments = book.map((seg, s) => {
    const nextFrom = book[s + 1]?.from ?? null;
    const legEntry = Object.entries(seg.weights).find(([id, w]) => id !== CASH && w > 0);
    const legId = legEntry?.[0] ?? null;
    const cashPct = Math.round((seg.weights[CASH] ?? 0) * 1000) / 10;
    // The deepest drawdown reached while this segment was in force (its own window of the series).
    let worst = null;
    for (let i = 0; i < series.length; i++) {
      const d = series[i].date;
      if (d < seg.from) continue;
      if (nextFrom !== null && d >= nextFrom) break;
      if (worst === null || dd[i] < worst) worst = dd[i];
    }
    return { name: legId ? (nameById.get(legId) ?? legId) : "cash", cashPct, dd: worst };
  });

  return {
    kind: "ok",
    band,
    bandWord: BAND_WORD[band] ?? band,
    bandClass: BAND_CLASS[band] ?? "",
    ddPct: dd.at(-1),
    peakDate: series[peakIdx].date,
    since,
    clamped: since < series[0].date,
    seriesStart: series[0].date,
    segments,
  };
}

/** The card's inner markup, from `drawdownModel`. Every value is escaped or a controlled string. */
export function drawdownCardHtml(model) {
  if (model.kind === "empty") return `<p class="dd-empty">record a holding to see its drawdown</p>`;
  if (model.kind === "nodata") {
    return `<p class="dd-empty">No leg prices yet for your entries - check back after the next update.</p>`;
  }
  if (model.kind === "unavailable") return `<p class="dd-empty">Drawdown unavailable for these entries.</p>`;
  const segs = model.segments
    .map(
      (s) =>
        `<li class="dd-seg"><span class="dd-seg-leg">${esc(sleeveLabel(s.name))}</span>` +
        `<span class="dd-seg-cash">${esc(s.cashPct)}% cash</span>` +
        `<span class="dd-seg-dd">${fmtDd(s.dd)}</span></li>`,
    )
    .join("");
  const clampNote = model.clamped ? ` (series starts ${esc(model.seriesStart)})` : "";
  return [
    `<p class="dd-head"><span class="dd-band ${model.bandClass}">${esc(model.bandWord)}</span>`,
    `<span class="dd-val">${fmtDd(model.ddPct)}</span></p>`,
    `<p class="dd-meta">peak ${esc(model.peakDate)} · since ${esc(model.since)}${clampNote}</p>`,
    `<ul class="dd-segs">${segs}</ul>`,
  ].join("");
}

/**
 * Held rung vs the dial's suggestion, as text + a tone the stylesheet colours.
 * `tone`: `none` (no snapshot), `match` (held is at or below the suggestion — no more risk
 * than suggested), `over` (held is RISKIER than suggested — the interesting disagreement).
 * Lower rung = more aggressive, so "held above the suggestion" means a LOWER number.
 */
export function describeGap(row) {
  const suggested = numOrNull(row?.suggested_rung);
  if (suggested === null) return { tone: "none", text: "no dial" };
  const band = row?.band ? ` (${row.band})` : "";
  const shown = Math.round(suggested * 10) / 10;
  if (row.rung < suggested) return { tone: "over", text: `dial ${shown}${band} - riskier by ${Math.round((suggested - row.rung) * 10) / 10}` };
  return { tone: "match", text: `dial ${shown}${band}` };
}

/** Minimal HTML escape — every value on this page is user-typed or server-served. */
export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Parse the tokens Supabase Auth returns in the URL FRAGMENT after a magic-link click
 * (`#access_token=…&refresh_token=…&expires_in=3600`). Returns `null` when the fragment
 * carries no access token, so a normal page load falls through to "signed out".
 * An auth ERROR comes back in the same fragment and is surfaced, not swallowed.
 */
export function parseAuthHash(hash) {
  const raw = String(hash ?? "").replace(/^#/, "");
  if (raw === "") return null;
  const p = new URLSearchParams(raw);
  const error = p.get("error_description") ?? p.get("error");
  if (error) return { error };
  const accessToken = p.get("access_token");
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: p.get("refresh_token"),
    expiresAt: Date.now() + Number(p.get("expires_in") ?? 3600) * 1000,
  };
}

/**
 * The same shape as `parseAuthHash`, read out of a GoTrue token-grant JSON body
 * (`{access_token, refresh_token, expires_in}`) instead of a URL fragment. Null when the body
 * carries no access token, so a malformed refresh answer reads as "no session" rather than
 * poisoning storage with `undefined`.
 */
export function parseTokenResponse(body, now = Date.now()) {
  const accessToken = body?.access_token;
  if (typeof accessToken !== "string" || accessToken === "") return null;
  return {
    accessToken,
    refreshToken: typeof body?.refresh_token === "string" && body.refresh_token !== "" ? body.refresh_token : null,
    expiresAt: now + Number(body?.expires_in ?? 3600) * 1000,
  };
}

/**
 * Has a stored magic-link session passed the `expiresAt` `parseAuthHash` computed? The token is
 * refused HERE rather than round-tripped into a 401: an expired bearer buys nothing and putting
 * it on the wire is the leak the H-3 finding named. A missing or unparseable expiry counts as
 * expired — an unbounded session is exactly what this check exists to prevent.
 */
export function sessionExpired(expiresAt, now = Date.now()) {
  const at = Number(expiresAt);
  return !Number.isFinite(at) || now >= at;
}

/** The `sub` claim of a JWT — the auth user id the insert policy checks. Null on anything unparseable. */
export function userIdFromJwt(token) {
  const part = String(token ?? "").split(".")[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json).sub ?? null;
  } catch {
    return null;
  }
}

/**
 * Normalize the Supabase connection the user pastes in once (project URL + PUBLIC anon key,
 * both of which the Supabase dashboard shows openly). The URL IS in the repo — S-3 pinned it to
 * `supabase-host.js` — and since the email-subscription page so is the anon key
 * (`SUPABASE_ANON_KEY`, same file); the journal keeps its paste box regardless (out of scope to
 * change) and validates only what is pasted here. Returns null when unusable.
 *
 * S-3: the URL must be EXACTLY `SUPABASE_ORIGIN`. The old any-https-host regex left the CSP
 * `connect-src` as the only thing stopping a typo'd project from relaying a magic-link flow —
 * a network policy standing in for input validation. RULED EDGE: a project reached through a
 * Supabase CUSTOM DOMAIN is blocked here and by the CSP. Accepted; no escape hatch.
 */
export function normalizeConnection(url, anonKey) {
  const trimmed = String(url ?? "").trim().replace(/\/+$/, "");
  const key = String(anonKey ?? "").trim();
  if (trimmed !== SUPABASE_ORIGIN || key === "") return null;
  return { url: trimmed, anonKey: key };
}

/** PostgREST/GoTrue endpoints, built from a normalized connection. */
export const otpUrl = (conn) => `${conn.url}/auth/v1/otp`;
/** The refresh-grant endpoint (J0.4 reversed 2026-09-06): trades a refresh token for a new pair. */
export const refreshUrl = (conn) => `${conn.url}/auth/v1/token?grant_type=refresh_token`;
/** Server-side session revoke — sign-out posts here with the bearer so the refresh token dies too. */
export const logoutUrl = (conn) => `${conn.url}/auth/v1/logout`;
export const rowsUrl = (conn, limit = LIST_LIMIT) =>
  `${conn.url}/rest/v1/holdings_journal?select=*&order=entry_date.desc,created_at.desc&limit=${limit}`;
export const insertUrl = (conn) => `${conn.url}/rest/v1/holdings_journal`;

/**
 * One leg's drawdown-card read (J1.4): `GET /api/series?id=<LEGP_*>&from=<month start>` — a
 * `from`-only range, which the handler serves up to its `MAX_LIMIT` newest in-window rows (paged in
 * the store). The handler accepts only a month-start `from` (`parseRange`, its edge-cache key grid),
 * so the first entry date is floored to its `YYYY-MM-01`; the extra leading days are dropped by
 * `alignReadings` (nothing before the first book segment is kept). `id` is one of the rung-derived
 * ids (`drawdownLegIds`), NEVER the stored `sleeve`. `firstDate` is REJECTED unless it is a real
 * `YYYY-MM-DD` — the guard is against a hand-edited row shape, not the DB (`entry_date` is a `date` column).
 */
export function legSeriesUrl(id, firstDate) {
  const date = String(firstDate ?? "").trim();
  if (!ISO_DATE.test(date)) {
    throw new Error(`[journal] first entry date must be YYYY-MM-DD, got ${JSON.stringify(firstDate)}`);
  }
  return `/api/series?id=${encodeURIComponent(String(id))}&from=${date.slice(0, 7)}-01`;
}

const byDateThenId = (a, b) =>
  a.obs_date < b.obs_date ? -1 : a.obs_date > b.obs_date ? 1 : a.indicator_id < b.indicator_id ? -1 : a.indicator_id > b.indicator_id ? 1 : 0;

/**
 * Reassemble N `/api/series` bodies into the `{ indicator_id, obs_date, value }` rows `drawdownModel`
 * reads, ordered by `obs_date` then `indicator_id`. Returns NULL — the "unavailable" signal — when ANY
 * body is `redacted: true` (its values are nulled, and a drawdown computed on the legs that did come
 * back would be a different book) or is not a series body at all.
 */
export function readingsFromSeries(bodies) {
  const rows = [];
  for (const body of bodies ?? []) {
    if (!body || body.redacted === true || typeof body.indicatorId !== "string" || !Array.isArray(body.points)) {
      return null;
    }
    for (const p of body.points) {
      // A warm-up gap rides `value: null`; Number(null) = 0 would read as a price in alignReadings.
      if (p?.value == null || !Number.isFinite(Number(p.value))) continue;
      rows.push({ indicator_id: body.indicatorId, obs_date: String(p?.date ?? ""), value: p.value });
    }
  }
  return rows.sort(byDateThenId);
}

/**
 * Every leg's series, one `/api/series` GET per id in parallel through `fetchFn` (the shell's
 * credential-carrying fetch), folded by `readingsFromSeries` (null = unavailable). A non-ok answer
 * THROWS — a partial book is the bug this exists to stop.
 */
export async function fetchLegReadings(fetchFn, ids, firstDate, timeoutMs) {
  const bodies = await Promise.all(
    [...(ids ?? [])].map(async (id) => {
      const res = await request(legSeriesUrl(id, firstDate), { fetchImpl: fetchFn, timeoutMs });
      if (!res.ok) throw new Error(`[journal] /api/series ${id}: HTTP ${res.status}`);
      return res.json();
    }),
  );
  return readingsFromSeries(bodies);
}

/**
 * The DISTINCT `LEGP_*` ids the user's rows name — resolved from `rung` via `legIds[rung - 1]`
 * ONLY (the security invariant), never the stored `sleeve` text. A row whose rung is off the
 * served ladder resolves to null and is dropped. Each id is one `legSeriesUrl` GET.
 */
export function drawdownLegIds(rows, legIds) {
  const set = new Set();
  for (const row of rows ?? []) {
    const id = legIdOf(Number(row?.rung), legIds ?? []);
    if (id) set.add(id);
  }
  return [...set];
}

/** The earliest `entry_date` among the rows (the drawdown window's `gte`), or null if none is ISO. */
export function firstEntryDate(rows) {
  let min = null;
  for (const row of rows ?? []) {
    const d = String(row?.entry_date ?? "").trim();
    if (ISO_DATE.test(d) && (min === null || d < min)) min = d;
  }
  return min;
}

/**
 * The self-erasure RPC (J0.5.1/J0.5.2). A definer function scoped to `auth.uid()` — the bearer
 * IS the scope, so the URL carries no id and there is nothing to tamper with. No cookie is
 * involved, so there is no CSRF surface; `connect-src` already allows the Supabase host.
 */
export const deleteAccountUrl = (conn) => `${conn.url}/rest/v1/rpc/delete_my_account`;

/** The exact word the danger card demands before it will call the RPC. */
export const ERASE_CONFIRM_WORD = "DELETE";

/**
 * UX friction against a slip, NOT the security boundary (that is the RPC's `auth.uid()` scope).
 * Case-sensitive and whitespace-trimmed: a lowercase "delete" is a near-miss, not a confirmation.
 */
export const eraseConfirmed = (typed) => String(typed ?? "").trim() === ERASE_CONFIRM_WORD;

/** The one success line, shown by the terminal takeover. */
export const ERASE_DONE_TEXT = "Everything about you has been removed - the sign-in link you used is now invalid.";

/**
 * Classify the RPC's answer. Only a 2xx is an erasure — J0.5.2 [USER 2026-09-07] splits 404 out
 * of the 401/403 bucket: PostgREST answers 404 for a function that does not EXIST, which is prod's
 * state until J0.5.1's migration is applied, and telling that visitor their session expired sends
 * them into a magic-link loop that cannot help. 401/403 really are a dead token (or an account
 * already gone) and drop the session; 404 keeps it.
 */
export function eraseOutcome(status) {
  if (status >= 200 && status < 300) return { kind: "erased", clear: true, tone: "good", message: ERASE_DONE_TEXT };
  if (status === 401 || status === 403)
    return { kind: "expired", clear: true, tone: "bad", message: "Session expired - sign in again." };
  if (status === 404)
    return {
      kind: "unavailable",
      clear: false,
      tone: "bad",
      message: "Account deletion isn't available on this deployment yet - contact the operator via /imprint.",
    };
  return { kind: "failed", clear: false, tone: "bad", message: `Could not delete the account - HTTP ${status}.` };
}
