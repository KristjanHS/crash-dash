/**
 * Holdings-journal thin shell (W5-c / J-4): DOM + fetch + web storage only. Every decision
 * (validation, the J-3 snapshot, the row shape, the list markup) lives in the pure
 * journal-view.js seam, which is where the tests are. This file runs module-level DOM side
 * effects and is NEVER imported by a test (the lab.js side-effect trap, `frontend.md`).
 *
 * Write path (§E-4): browser → Supabase PostgREST directly, so this page costs ZERO Vercel
 * functions (`api/deploy-budget.test.ts` pins the handler count at exactly 8 and the Hobby
 * plan caps at 12). Auth is raw GoTrue REST — magic link only, no SDK — and is wired on THIS
 * page alone; index.html / lab.html / exposure.html keep reading anon with no login.
 *
 * Token storage: the shared `auth-session.js` seam owns it — one stored session across pages and
 * tabs, renewed by `ensureSession` (J0.4 reversed 2026-09-06); an expired access token is still
 * refused locally before any fetch.
 */
import {
  LIST_LIMIT,
  buildEntryRow,
  deleteAccountUrl,
  dialSnapshot,
  entryList,
  eraseConfirmed,
  eraseOutcome,
  insertUrl,
  magicLinkRedirect,
  normalizeConnection,
  otpUrl,
  parseAuthHash,
  rowsUrl,
  fetchLegReadings,
  drawdownLegIds,
  firstEntryDate,
  drawdownModel,
  drawdownCardHtml,
  sessionExpired,
  userIdFromJwt,
} from "./journal-view.js";
import { SUPABASE_ORIGIN } from "./supabase-host.js";
import { API_TIMEOUT_MS, getJson, send } from "./http.js";
import { sleeveLabel } from "./sleeve-label.js";
import { apiFetch, clearSession, ensureSession, revokeSession, storeSession } from "./auth-session.js";
// Trading-rules pure seam: the shell
// owns fetch/DOM/`crypto.randomUUID()`, the seam owns the fold, validation and row/URL shapes.
import {
  liveRules,
  nextVersion,
  ruleInsertRow,
  ruleInsertUrl,
  ruleListHTML,
  rulesUrl,
  validateRuleForm,
} from "./rules-view.js";

const $ = (id) => document.getElementById(id);
const CONN_KEY = "cd.journal.conn";

let conn = null;
let token = null;
let tokenExpiresAt = null;
let snapshot = null;
// J1.2: the 9 LADDER names from /api/config populate the sleeve <select>; the seam reads them to
// validate a saved sleeve and to relabel every list row as `ladder[rung-1]` (J1 ruling #2).
let ladder = null;
// J1.4/J1.5: the rung-ordered LEGP_* ids and the pension cuts (+ confirm buffer) the drawdown
// card scores against, taken off the SAME /api/config fetch as `ladder` (no second request).
let legIds = null;
let pensionCuts = null;
let confirmCloses = null;
// J0.5.2: once the account is gone the page is terminal. A latch, not a derived state — there is
// no signed-out view to fall back to that would not invite a magic link for a dead address.
let erased = false;
// The full version history the last `loadRules()` fetched, held so `nextVersion()` can derive the
// next version off the rows already in hand (slice 1 mints a fresh key per save, so this is 1).
let rulesRows = [];

function say(el, text, tone) {
  el.textContent = text;
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

// ---- connection -------------------------------------------------------------------

/**
 * Restore the pasted connection, DROPPING it when it no longer normalizes (S-3): a value
 * stored before the host pin can name any https host, so it is purged rather than ignored.
 * Shell owns storage, seam owns validation — the only judgement here is the seam's.
 */
function loadConn() {
  let raw = null;
  try {
    raw = localStorage.getItem(CONN_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw);
    const next = normalizeConnection(stored.url, stored.anonKey);
    if (next) return next;
  } catch {
    // unparseable is as unusable as a rejected host — fall through to the purge
  }
  if (raw !== null) localStorage.removeItem(CONN_KEY);
  return null;
}

function saveConn() {
  const next = normalizeConnection($("conn-url").value, $("conn-key").value);
  if (!next) {
    // Names the one accepted URL — since S-3 the project URL is pinned.
    say($("conn-msg"), `Need the project URL ${SUPABASE_ORIGIN} and a non-empty anon key.`, "bad");
    return;
  }
  conn = next;
  localStorage.setItem(CONN_KEY, JSON.stringify(conn));
  say($("conn-msg"), "");
  render();
}

// ---- auth (GoTrue REST, magic link) ------------------------------------------------

async function sendMagicLink() {
  const email = $("auth-email").value.trim();
  if (!email) return say($("auth-msg"), "Enter your email first.", "bad");
  say($("auth-msg"), "Sending…");
  try {
    // `redirect_to` is a QUERY parameter, never a body field. GoTrue reads it off the request URL
    // (that is exactly what supabase-js does with `options.emailRedirectTo` — its `_request` puts
    // `redirect_to` in the query string), and POST /otp's body schema is `email` / `phone` /
    // `create_user` / `data` only. An `options: { email_redirect_to }` object in the BODY is silently
    // IGNORED, and the emailed link then targets the project's configured Site URL — i.e. `index.html`,
    // which has no `parseAuthHash`, so the fragment is dropped and sign-in is unreachable from here.
    // S-3: `origin + JOURNAL_PATH`, a CONSTANT path — never `location.href`, which hands GoTrue
    // whatever path/query/fragment the link the user arrived on carried.
    const res = await send(`${otpUrl(conn)}?redirect_to=${encodeURIComponent(magicLinkRedirect(location.origin))}`, {
      headers: { apikey: conn.anonKey },
      body: { email, create_user: false },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 400 || res.status === 422 ? ` — ${await res.text()}` : ""}`);
    say($("auth-msg"), "Link sent - open it on this device.", "good");
  } catch (err) {
    // `create_user: false` (§E-4) means GoTrue will NOT sign this address up on the fly: the auth
    // user has to exist already. Accounts are created on /subscribe (J0.1) — an unknown address is
    // the expected failure for a newcomer, so point there rather than leaving a bare non-2xx.
    say(
      $("auth-msg"),
      `Could not send the link - ${err.message}. This page never creates accounts: if you have not ` +
        `signed up yet, do it on /subscribe first (one confirmation mail), then request the link ` +
        `here or on /signin with the same address.`,
      "bad",
    );
  }
}

/** Consume the magic-link fragment, then strip it so a reload does not replay a used token. */
function adoptHashSession() {
  const parsed = parseAuthHash(location.hash);
  if (!parsed) return;
  history.replaceState(null, "", location.pathname + location.search);
  if (parsed.error) return say($("auth-msg"), parsed.error, "bad");
  const rec = storeSession(parsed);
  if (!rec) return dropSession();
  token = rec.accessToken;
  tokenExpiresAt = rec.expiresAt;
}

/** Restore the stored session, renewing it when the access token has run out (J0.4 reversed). */
async function restoreSession() {
  const rec = await ensureSession(conn);
  // A falsy result is NOT proof the credential is dead — offline, a 429 and a 5xx all land here,
  // and the seam kept the refresh token for the next try. Forget it in memory only; storage is
  // the seam's to clear, and it already has when the credential really was rejected.
  token = rec?.accessToken ?? null;
  tokenExpiresAt = rec?.expiresAt ?? null;
}

function dropSession() {
  token = null;
  tokenExpiresAt = null;
  clearSession();
}

async function signOut() {
  await revokeSession(conn);
  dropSession();
  render();
}

/**
 * Gate on every authenticated request: renew from the SHARED store rather than trusting the
 * in-memory pair this page booted with, then refuse locally instead of spending a round trip to
 * learn the same thing from a 401. Re-reading is what keeps a long-open tab correct — a sibling
 * tab renews the same session, and the boot-time token here goes stale without being wrong.
 * `render()` cannot recurse through here — `token` is already null when it runs.
 */
async function sessionLive() {
  await restoreSession();
  if (token && !sessionExpired(tokenExpiresAt)) return true;
  say($("auth-msg"), "Session expired - send yourself a fresh magic link.", "bad");
  render();
  return false;
}

const authHeaders = () => ({ apikey: conn.anonKey, authorization: `Bearer ${token}` });

// ---- the ladder <select> (J1.2) ----------------------------------------------------

/**
 * Load the 9 LADDER names off /api/config (public, no bearer) once and fill the sleeve <select>.
 * Options are built through the DOM, never innerHTML — the names are trusted config, but the shell
 * owns every DOM write. A failed fetch leaves the select empty, so a save reds on validation.
 */
async function loadLadder() {
  if (ladder) return ladder;
  try {
    const cfg = await getJson("/api/config", { timeoutMs: API_TIMEOUT_MS });
    ladder = cfg.ladder ?? null;
    legIds = cfg.legIds ?? null;
    pensionCuts = cfg.scoringCuts?.pension ?? null;
    confirmCloses = pensionCuts?.confirmCloses ?? null;
  } catch {
    ladder = null;
  }
  const sel = $("f-sleeve");
  if (Array.isArray(ladder)) {
    sel.replaceChildren(
      ...ladder.map((name, i) => {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = `rung ${i + 1} · ${sleeveLabel(name)}`;
        return opt;
      }),
    );
  }
  return ladder;
}

// ---- the dial snapshot (J-3) -------------------------------------------------------

async function loadSnapshot() {
  try {
    snapshot = dialSnapshot(await getJson("/api/status", { timeoutMs: API_TIMEOUT_MS }));
  } catch {
    snapshot = null;
  }
  const s = $("snapshot");
  if (!snapshot || snapshot.suggested_rung === null) {
    say(s, "No dial reading available - the entry will be saved without a snapshot.");
  } else {
    say(
      s,
      `Dial now: rung ${Math.round(snapshot.suggested_rung * 10) / 10}` +
        `${snapshot.band ? ` · ${snapshot.band}` : ""}` +
        `${snapshot.severity ? ` · ${snapshot.severity}` : ""} - stored with this entry.`,
    );
  }
}

// ---- write + list ------------------------------------------------------------------

async function save() {
  // J1.2: the sleeve <select> IS the rung control — the chosen name is the stored `sleeve` and the
  // 1-based rung is its index+1 (selectedIndex -1 → rung 0, which the seam rejects).
  const sel = $("f-sleeve");
  const built = buildEntryRow(
    {
      entryDate: $("f-date").value,
      sleeve: sel.value,
      rung: sel.selectedIndex + 1,
      cashPct: $("f-cash").value,
      note: $("f-note").value,
    },
    snapshot,
    userIdFromJwt(token),
    ladder,
  );
  if (!built.ok) return say($("entry-msg"), built.errors.join(" "), "bad");

  if (!(await sessionLive())) return;

  say($("entry-msg"), "Saving…");
  try {
    const res = await send(insertUrl(conn), {
      headers: { ...authHeaders(), prefer: "return=minimal" },
      body: built.row,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
    say($("entry-msg"), "Saved.", "good");
    $("f-note").value = "";
    await loadList();
  } catch (err) {
    say($("entry-msg"), `Could not save - ${err.message}`, "bad");
  }
}

async function loadList() {
  if (!(await sessionLive())) return;
  try {
    const rows = await getJson(rowsUrl(conn, LIST_LIMIT), { headers: authHeaders() });
    $("list").innerHTML = entryList(rows, ladder);
    await loadDrawdown(rows);
  } catch (err) {
    $("list").innerHTML = entryList([], ladder);
    await loadDrawdown([]);
    say($("entry-msg"), `Could not load entries - ${err.message}`, "bad");
  }
}

/**
 * J1.4/J1.5: chain the user's OWN rows into a blended drawdown and paint the card. One
 * `/api/series` GET per held leg through `apiFetch` (auth-session.js, the gated pages' one read seam); the id
 * list is rung-derived (`drawdownLegIds`), never the stored `sleeve`.
 * A failed or redacted read is `readings = null` → the card's "unavailable" line, never a drawdown
 * computed on nulls. The seam decides; this only fetches and writes.
 */
async function loadDrawdown(rows) {
  const body = $("dd-body");
  if (!Array.isArray(legIds) || !pensionCuts) return;
  const ids = drawdownLegIds(rows, legIds);
  const first = firstEntryDate(rows);
  if (ids.length === 0 || !first) {
    body.innerHTML = drawdownCardHtml({ kind: "empty" });
    return;
  }
  let readings = null;
  try {
    readings = await fetchLegReadings(apiFetch, ids, first, API_TIMEOUT_MS);
  } catch {
    readings = null;
  }
  body.innerHTML = drawdownCardHtml(
    drawdownModel({ rows, legIds, names: ladder, readings, cuts: pensionCuts, confirmCloses }),
  );
}

// ---- trading rules (slice 1) --------------------------------------------------------

/**
 * Fetch the full append-only version history and paint the LIVE list. Mirrors `loadList()`:
 * one bearer GET, the seam (`liveRules`) folds versions to the current wording. The fetched rows
 * are held in `rulesRows` so `saveRule()` derives the next version without a second round trip.
 */
async function loadRules() {
  if (!(await sessionLive())) return;
  try {
    rulesRows = await getJson(rulesUrl(conn), { headers: authHeaders() });
    $("rules-list").innerHTML = ruleListHTML(liveRules(rulesRows));
  } catch (err) {
    rulesRows = [];
    $("rules-list").innerHTML = ruleListHTML([]);
    say($("rule-msg"), `Could not load rules - ${err.message}`, "bad");
  }
}

/**
 * Insert one rule version. The shell mints the stable `rule_key` (`crypto.randomUUID()` — a first
 * for `public/`, kept out of the seam so every seam function stays deterministic under test) and
 * derives the version with `nextVersion()` over the rows `loadRules()` already fetched. A fresh key
 * always claims version 1; a `unique (user_id, rule_key, version)` collision surfaces as a 409 —
 * per spec, show the error and RELOAD, never retry the insert.
 */
async function saveRule() {
  // Double-click guard. Each call mints its OWN rule_key, so two in-flight saves take two DIFFERENT
  // keys and both claim version 1 — they never collide on `unique (user_id, rule_key, version)` and
  // the 409-reload path (§2) cannot see them. Append-only with no retire control in slice 1 means a
  // duplicate is unremovable, so the only place to stop it is here, before the first await.
  const btn = $("rule-save");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    await saveRuleOnce();
  } finally {
    btn.disabled = false;
  }
}

async function saveRuleOnce() {
  const fields = {
    mistake: $("rf-mistake").value,
    cost: $("rf-cost").value,
    rule: $("rf-rule").value,
    tags: $("rf-tags").value,
  };
  const check = validateRuleForm(fields);
  if (!check.ok) return say($("rule-msg"), check.errors.join(" "), "bad");

  if (!(await sessionLive())) return;

  const ruleKey = crypto.randomUUID();
  const version = nextVersion(rulesRows, ruleKey);
  const row = ruleInsertRow(fields, userIdFromJwt(token), ruleKey, version);

  say($("rule-msg"), "Saving…");
  try {
    const res = await send(ruleInsertUrl(conn), {
      headers: { ...authHeaders(), prefer: "return=minimal" },
      body: row,
    });
    // A 409 is the unique-constraint collision (§2): the message names it, then we reload so the
    // next attempt derives its version off fresh rows. No retry — a silent re-POST could stampede.
    if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
    say($("rule-msg"), "Saved.", "good");
    for (const id of ["rf-mistake", "rf-cost", "rf-rule", "rf-tags"]) $(id).value = "";
    await loadRules();
  } catch (err) {
    say($("rule-msg"), `Could not save - ${err.message}`, "bad");
    await loadRules();
  }
}

// ---- account erasure (J0.5.2) -------------------------------------------------------

/**
 * Art. 17 self-service erasure: ONE call to the `delete_my_account` definer RPC, which scopes
 * itself to `auth.uid()` — the bearer is the scope, so nothing identifying travels in the URL or
 * the body. Only a 2xx is success; the seam's `eraseOutcome` owns the 401/403-vs-404 split
 * ([USER 2026-09-07]) and says whether the stored session dies with it.
 */
async function eraseAccount() {
  if (!eraseConfirmed($("erase-confirm").value)) {
    return say($("erase-msg"), "Type DELETE in the box to confirm - nothing was deleted.", "bad");
  }
  // Disabled BEFORE the first await: a second click during `sessionLive()` would otherwise start
  // a second erase. Re-enabled on every exit path below except the takeover, which hides the card.
  $("erase-go").disabled = true;
  say($("erase-msg"), "Deleting…");
  if (!(await sessionLive())) {
    $("erase-go").disabled = false;
    return;
  }
  let outcome;
  try {
    const res = await send(deleteAccountUrl(conn), { headers: authHeaders(), body: {} });
    outcome = eraseOutcome(res.status);
  } catch (err) {
    // A network failure is NOT an erasure — never show the done text on a request that never landed.
    outcome = { kind: "failed", clear: false, tone: "bad", message: `Could not delete the account - ${err.message}` };
  }
  $("erase-go").disabled = false;

  if (outcome.clear) dropSession();
  if (outcome.kind === "erased") {
    erased = true;
    say($("erased-text"), outcome.message);
  }
  say($("erase-msg"), outcome.message, outcome.tone);
  render();
}

// ---- wiring -------------------------------------------------------------------------

function render() {
  // Terminal takeover: after an erasure EVERY other card goes, including the sign-in card — the
  // account it would ask for no longer exists, and `create_user: false` makes that a hard error.
  const signedIn = !erased && Boolean(conn && token);
  $("conn-card").hidden = erased || Boolean(conn);
  $("auth-card").hidden = erased || !conn || signedIn;
  $("entry-card").hidden = !signedIn;
  $("dd-card").hidden = !signedIn;
  $("list-card").hidden = !signedIn;
  // Same session-live gate the entry form uses — /journal ships to EVERY signed-in account, so the
  // rules card has no owner check by design (spec §"every signed-in account", 2026-09-19).
  $("rules-card").hidden = !signedIn;
  $("danger-card").hidden = !signedIn;
  $("erased-card").hidden = !erased;
  if (signedIn) {
    loadSnapshot();
    loadList();
    loadRules();
  }
}

$("conn-save").addEventListener("click", saveConn);
$("conn-edit").addEventListener("click", () => {
  $("conn-card").hidden = false;
  if (conn) {
    $("conn-url").value = conn.url;
    $("conn-key").value = conn.anonKey;
  }
});
$("auth-send").addEventListener("click", sendMagicLink);
$("auth-out").addEventListener("click", signOut);
$("f-save").addEventListener("click", save);
$("rule-save").addEventListener("click", saveRule);
// The "+ new rule" form ships collapsed; the toggle is shell-only DOM, no seam.
$("rule-new").addEventListener("click", () => {
  $("rule-form").hidden = !$("rule-form").hidden;
});
$("erase-go").addEventListener("click", eraseAccount);

// Since S-3 exactly one project URL is accepted, so the field prefills it rather than showing a
// `https://xxxx.supabase.co` placeholder that implies any project would do. Set from the constant,
// never a third hand-typed spelling of the host.
$("conn-url").placeholder = SUPABASE_ORIGIN;
$("conn-url").value = SUPABASE_ORIGIN;

conn = loadConn();
await restoreSession();
adoptHashSession();
$("f-date").value = new Date().toISOString().slice(0, 10);
await loadLadder();
render();
