/**
 * NF-1 Stage 8.2 — the LIVE e2e for the r4 phase → fall-shape promotion.
 *
 * Drives the REAL `/lab` (public/lab.js + band-panel.js + overlay-strip.js) in headless Chromium
 * against `scripts/preview/server-live.mjs`, which routes `/api/*` to the REAL `api/*.ts` handlers
 * over the LOCAL Supabase. Nothing here reads code to decide a verdict: every assertion is either a
 * value off the served JSON or a node read out of the rendered DOM.
 *
 * ⚠ **`scripts/e2e/r4-fall-shape-lab.ts` mints SCRATCH `alert_log` rows on the dev DB** — needs a live
 * stack + `preview:live`, deliberately outside `npm run check`. **Never point it at prod.**
 *
 * ⚠ THE DEV DB'S HISTORY IS IRREPLACEABLE (free feeds may close). This script therefore:
 *   · never `UPDATE`s an existing row, never truncates, never resets;
 *   · forces the phase by INSERTing a throwaway CLONE of the newest real `alert_log` row, with the
 *     r4/fall columns overridden. The clone keeps the template's `fired_at` VERBATIM — two reasons:
 *     `getReadingsForRun` joins `readings.run_at = alert.fired_at` EXACTLY (a shifted instant serves
 *     an empty board), and `getRecentAlerts` orders `fired_at DESC, id DESC`, so the freshly
 *     inserted clone wins the tie on its higher identity id and IS the row `/api/lab` reads;
 *   · deletes ONLY by the identity ids it inserted, each guarded `id > maxRealId` — the table's
 *     high-water mark, read by `order=id.desc` (NOT off the template row: rows can be inserted out
 *     of `fired_at` order by a backfill, so the newest-by-`fired_at` row is not necessarily the
 *     largest id). No filter here can ever name a pre-existing row;
 *   · runs that delete from a `finally` AND from `SIGINT`/`SIGTERM` handlers. A `finally` alone
 *     would NOT cover Ctrl-C, which is the likely abort: the run parks in three 20 s
 *     `waitForFunction` calls. What is guaranteed: a throw, a normal exit, SIGINT and SIGTERM all
 *     reach the delete. What is NOT: `SIGKILL`, a power loss, or a REST error inside the delete
 *     itself — in those cases the surviving ids are PRINTED (never swallowed) so the rows can be
 *     removed by hand. Nor is `--specimen`'s spawned preview server guaranteed to die on SIGKILL:
 *     it is killed from a `process.on("exit")` handler, which SIGKILL does not run, so the child is
 *     orphaned and keeps holding the port (`kill` it by hand, or the next run's server loses the
 *     bind and the banner points at somebody else's /lab). A surviving clone matters because it
 *     inherits the template's `fired_at`
 *     and carries a higher id, so under `fired_at DESC, id DESC` it BECOMES the prior that
 *     `/api/lab` and the next cron read — a false `r4_phase='cash'` that floors the band to
 *     CRITICAL;
 *   · re-reads the ids afterwards to prove zero survived.
 *
 * Usage (the stack wrapper always tears down afterwards), with `server-live.mjs` already listening on E2E_PORT:
 *   bash scripts/db.sh with dev -- npx tsx --env-file-if-exists=.env.local scripts/e2e/r4-fall-shape-lab.ts
 *
 * Exit 0 = every arm green AND the non-vacuity control separated the arms. Exit 1 = anything else.
 */
// This repo's tsconfig carries no "dom" lib (it is a Node service), so the in-page globals the
// evaluate probes reference are declared locally. Ambient — emits nothing at runtime.
declare const document: any;

import { chromium } from "playwright";
import { R4_PHASE_FIELD_LABEL } from "../../src/lab-overlays.js";
import { readEnv } from "../../src/config.js";
import { requireProdWrites } from "../../src/prod-writes.js";

const PORT = Number(process.env.E2E_PORT ?? 4399);
const BASE = `http://127.0.0.1:${PORT}`;

const { SUPABASE_URL = "", SUPABASE_SERVICE_KEY = "" } = readEnv();
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("SUPABASE_URL + SUPABASE_SERVICE_KEY required (run under --env-file-if-exists=.env.local)");
}

async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`REST ${path} -> ${res.status} ${await res.text()}`);
  return res;
}

/** Ids minted by this run. `scratchIds` is the CURRENTLY-live set (cleared after each mid-run
 *  delete); `allMinted` is the cumulative set and never shrinks — the final cleanup deletes from
 *  IT, so an id a mid-run delete failed to remove is still retried rather than dropped on the
 *  floor. `maxRealId` is the REAL table's id high-water mark before the run started; the delete
 *  path reads both, so it can only ever name an id it minted. */
const scratchIds: number[] = [];
const allMinted: number[] = [];
let maxRealId = -1;

/** The TEMPLATE row: newest by `fired_at` — that is the row `/api/lab` actually reads, and the
 *  `fired_at` the clone must inherit for the `readings.run_at` join to resolve. */
async function newestAlertRow(): Promise<Record<string, unknown>> {
  const res = await rest("alert_log?select=*&order=fired_at.desc,id.desc&limit=1");
  const rows = (await res.json()) as Record<string, unknown>[];
  const row = rows[0];
  if (!row) throw new Error("no alert_log row to clone — run the cron path first");
  return row;
}

/** The SAFETY high-water mark: largest id in the table, by `id` order. A SEPARATE query from
 *  `newestAlertRow` on purpose — a backfilled row can carry a large id and an early `fired_at`,
 *  so the newest-by-`fired_at` row's id is not the maximum. Do not collapse the two. */
async function maxAlertId(): Promise<number> {
  const res = await rest("alert_log?select=id&order=id.desc&limit=1");
  const rows = (await res.json()) as { id: number }[];
  const id = rows[0]?.id;
  if (typeof id !== "number") throw new Error("no alert_log row — run the cron path first");
  return id;
}

/** ⚠ NEVER point this script at prod: it INSERTS. A non-loopback host aborts before any write.
 *  The allowlist is a deliberate superset of `isLocalUrl` (scripts/backfill/resolve-store.ts), which
 *  matches `127.0.0.1|localhost` on the URL; the two extra IPv6 loopback spellings are the same
 *  local stack under a different literal, and nothing legitimate is rejected. */
function assertLocalSupabase(): void {
  const host = new URL(SUPABASE_URL).hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && host !== "[::1]") {
    throw new Error(`refusing to write: SUPABASE_URL host '${host}' is not local — this script only ever writes to the local stack`);
  }
}

/** INSERT one scratch clone (never an UPDATE). `id` is dropped so the identity default mints a new,
 *  strictly larger one; `fired_at` is inherited so the readings join still resolves.
 *
 *  ⚠ The local-stack guard sits HERE, at the ONLY write in the file, so "guarded before every write"
 *  is structural rather than by inspection: `lab:specimen:raw` and a bare `npx tsx …` both bypass
 *  `scripts/db.sh`, and shell-exported creds silently beat `.env.local` (`process.loadEnvFile` never
 *  overrides an existing var — the same hazard `isLocalUrl` in scripts/backfill/resolve-store.ts
 *  guards). A caller-side check would be one forgotten call site away from writing prod. */
async function insertScratch(template: Record<string, unknown>, overrides: Record<string, unknown>): Promise<number> {
  assertLocalSupabase();
  // The prod-writes switch blocks every host-side rw store, the local stack included. The DELETEs need no
  // check of their own: they only ever name ids an insert minted, so they run only after this one passed.
  requireProdWrites("the scratch alert_log insert", process.env);
  const { id: _id, ...cols } = template;
  void _id;
  const res = await rest("alert_log", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ ...cols, ...overrides }),
  });
  const [row] = (await res.json()) as { id: number }[];
  const id = row?.id;
  if (typeof id !== "number") throw new Error("scratch insert returned no id");
  if (id <= maxRealId) throw new Error(`scratch id ${id} is not past the real id high-water mark ${maxRealId}`);
  scratchIds.push(id);
  allMinted.push(id);
  return id;
}

/** Delete the named ids, which must all be ones THIS run minted. Two guards, both fatal rather
 *  than silent: the caller may only pass a list built by `insertScratch`, and each id must sit
 *  past `maxRealId` (the id high-water mark of the real table). */
async function deleteScratch(target: number[]): Promise<number> {
  const ids = target.filter((id) => id > maxRealId);
  if (ids.length !== target.length) throw new Error("refusing to delete: an id is not past the real id high-water mark");
  if (!ids.length) return 0;
  const res = await rest(`alert_log?id=in.(${ids.join(",")})`, {
    method: "DELETE",
    headers: { Prefer: "return=representation" },
  });
  const rows = (await res.json()) as unknown[];
  return rows.length;
}

/** How many of the ids this run minted still exist. Must be 0 after the finally. */
async function survivingScratch(all: number[]): Promise<number> {
  if (!all.length) return 0;
  const res = await rest(`alert_log?select=id&id=in.(${all.join(",")})`);
  return ((await res.json()) as unknown[]).length;
}

/** ⚠ A `finally` does NOT run on SIGINT/SIGTERM, and Ctrl-C is the likely abort here — the run
 *  parks in three 20 s `waitForFunction` calls. Without these handlers an interrupted run leaves a
 *  scratch clone that, sharing the template's `fired_at` with a higher id, WINS the
 *  `fired_at DESC, id DESC` order and becomes the prior `/api/lab` and the next cron read. Delete
 *  first, then exit non-zero (never 0 — an interrupted run proved nothing). */
let aborting = false;
/** The tail of the specimen's write chain (`--specimen` swaps run off a readline event, i.e. OUTSIDE
 *  any await this file controls). `insertScratch` only pushes to `allMinted` AFTER its POST resolves,
 *  so a Ctrl-C landing mid-POST would otherwise snapshot an `allMinted` that does not yet name the
 *  in-flight row, delete what it knows, `process.exit(1)`, and let the insert land afterwards —
 *  an orphaned clone in the dev DB under a printed `surviving=0`. `abortCleanup` therefore AWAITS
 *  this chain before it deletes, and each swap re-checks `aborting` before starting a write. */
let pendingWrite: Promise<unknown> = Promise.resolve();
async function abortCleanup(signal: string): Promise<void> {
  if (aborting) return; // a second Ctrl-C must not race a half-finished delete
  aborting = true;
  console.log(`\n[${signal}] aborting — clearing scratch rows before exit`);
  // Let any in-flight write finish and register its id in `allMinted` first. Its own rejection is
  // already reported by the swap's catch; here it must not skip the delete.
  try {
    await pendingWrite;
  } catch {
    /* reported at the swap */
  }
  try {
    const deleted = await deleteScratch(allMinted);
    const left = await survivingScratch(allMinted);
    console.log(`[${signal}] minted=${JSON.stringify(allMinted)} deleted-now=${deleted} surviving=${left}`);
    if (left !== 0) console.log(`[${signal}] ⚠ DELETE THESE BY HAND: ${JSON.stringify(allMinted)}`);
  } catch (err) {
    // Printed, never swallowed: these ids are the only record of what has to be removed by hand.
    console.log(`[${signal}] ⚠ CLEANUP FAILED — delete these by hand: ${JSON.stringify(allMinted)} — ${String(err)}`);
  }
  process.exit(1);
}
process.on("SIGINT", () => void abortCleanup("SIGINT"));
process.on("SIGTERM", () => void abortCleanup("SIGTERM"));

// --- assertions -------------------------------------------------------------------------------
const failures: string[] = [];
function check(name: string, ok: boolean, detail: string): void {
  if (!ok) failures.push(`${name}: ${detail}`);
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : ` — ${detail}`}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// --- what one arm observes --------------------------------------------------------------------
type Chip = { text: string; cls: string[] };
type Dom = { r4Phase: string; chips: Chip[]; fallRow: string | null; idle: string | null };
type Api = { phase: unknown; confidence: unknown; hasConfidenceKey: boolean; floorChips: unknown; promoted: boolean };

const CONFIDENCES = new Set(["measured", "conflicting", "no-fall", "dark"]);

async function readApi(): Promise<Api> {
  const res = await fetch(`${BASE}/api/lab`);
  const d = (await res.json()) as any;
  const fall = d.overlays?.fallShape;
  const floor = (d.band?.floors ?? []).find((f: any) => f.id === "r4");
  const phase = d.overlays?.r4?.fields?.find((f: any) => f.label === R4_PHASE_FIELD_LABEL)?.value;
  return {
    phase,
    // RUNTIME presence, never a structural claim: src/lab-served-field.ts's `toServedField` ends in
    // `as unknown as FieldResult`, so the type system proves nothing about any served key.
    hasConfidenceKey: !!fall && Object.prototype.hasOwnProperty.call(fall, "confidence"),
    confidence: fall?.confidence,
    floorChips: floor?.chips,
    promoted: String(phase) !== "equity",
  };
}

/** The r4 floor head + the danger-ledger footer, read out of the LIVE page. */
const DOM_PROBE = `(() => {
  const heads = [...document.querySelectorAll('.bp-floor-head')];
  const head = heads.find((h) => (h.querySelector('.bp-floor-id')||{}).textContent === 'r4') || null;
  const phaseEl = head ? head.querySelector('.bp-floor-phase') : null;
  const rows = [...document.querySelectorAll('.overlay-row')].map((r) => r.textContent.trim());
  const idleEl = document.querySelector('.overlay-idle');
  return {
    r4Phase: phaseEl ? phaseEl.textContent.trim() : '',
    chips: head ? [...head.querySelectorAll('.bp-floor-fchip')].map((c) => ({ text: c.textContent.trim(), cls: [...c.classList] })) : [],
    fallRow: rows.find((t) => t.startsWith('Fall shape')) || null,
    idle: idleEl ? idleEl.textContent.trim() : null,
  };
})()`;

async function readDom(browser: Awaited<ReturnType<typeof chromium.launch>>, expectPhase: string): Promise<Dom> {
  // A FRESH context per arm plus a no-cache request header: /api/lab ships an s-maxage, and a
  // browser-cached payload would let a later arm assert the previous arm's board. (A `?_cb=`
  // query-buster is now a 400 — the handlers reject params outside their known set.)
  const ctx = await browser.newContext();
  await ctx.route("**/api/**", (route) => {
    const headers = { ...route.request().headers(), "Cache-Control": "no-cache", Pragma: "no-cache" };
    void route.continue({ headers });
  });
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE}/lab`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      `(() => { const h=[...document.querySelectorAll('.bp-floor-head')].find(x => (x.querySelector('.bp-floor-id')||{}).textContent==='r4'); const p=h && h.querySelector('.bp-floor-phase'); return !!p && p.textContent.trim()==='phase: ${expectPhase}'; })()`,
      undefined,
      { timeout: 20_000 },
    );
    return (await page.evaluate(DOM_PROBE)) as Dom;
  } finally {
    await ctx.close();
  }
}

/** A chip's tone class — everything except the structural `bp-floor-fchip`. */
function chipCls(c: Chip): string {
  return c.cls.filter((x) => x !== "bp-floor-fchip").join("+");
}

async function main(): Promise<void> {
  const template = await newestAlertRow();
  // Two DIFFERENT reads, two different purposes: the template is newest-by-`fired_at` (the row
  // /api/lab serves); the guard is max-by-`id` (which a backfill can put on some other row).
  maxRealId = await maxAlertId();
  console.log(
    `template alert row id=${String(template.id)} obs_date=${String(template.obs_date)} fired_at=${String(template.fired_at)}` +
      ` · real id high-water mark=${maxRealId}`,
  );
  const browser = await chromium.launch();
  const seen: Record<string, Dom> = {};
  try {
    // ---- ARM 1: the live close, no scratch row at all -----------------------------------------
    console.log("\n[arm equity] live cron row, no scratch row");
    const apiEq = await readApi();
    const domEq = await readDom(browser, "equity");
    seen.equity = domEq;
    eq("equity/api phase", apiEq.phase, "equity");
    check("equity/api confidence key present", apiEq.hasConfidenceKey, "overlays.fallShape.confidence missing");
    check("equity/api confidence in the 4-set", CONFIDENCES.has(String(apiEq.confidence)), `got ${JSON.stringify(apiEq.confidence)}`);
    check("equity/api promotion predicate off", !apiEq.promoted, `promoted=${apiEq.promoted}`);
    eq("equity/api r4 floor carries no chips", apiEq.floorChips, undefined);
    eq("equity/dom phase chip", domEq.r4Phase, "phase: equity");
    eq("equity/dom fall-shape chip count", domEq.chips.length, 0);
    eq("equity/dom fall-shape overlay row", domEq.fallRow, null);
    check("equity/dom fall shape is FOLDED into the idle line", !!domEq.idle && domEq.idle.includes("shape:"), `idle=${domEq.idle}`);

    // ---- ARM 2: forced cash, a MEASURED bear ---------------------------------------------------
    const cashId = await insertScratch(template, {
      r4_phase: "cash",
      r4_reentry_rung: null,
      fall_shape: "bear",
      fall_velocity: -0.012,
      credit_dwell_closes: 35,
    });
    console.log(`\n[arm cash] scratch row id=${cashId} — r4_phase=cash, fall_shape=bear`);
    const apiCash = await readApi();
    const domCash = await readDom(browser, "cash");
    seen.cash = domCash;
    eq("cash/api phase", apiCash.phase, "cash");
    check("cash/api confidence key present", apiCash.hasConfidenceKey, "overlays.fallShape.confidence missing");
    eq("cash/api confidence", apiCash.confidence, "measured");
    check("cash/api promotion predicate on", apiCash.promoted, `promoted=${apiCash.promoted}`);
    eq("cash/api r4 floor chip count", Array.isArray(apiCash.floorChips) ? (apiCash.floorChips as unknown[]).length : -1, 2);
    eq("cash/dom phase chip", domCash.r4Phase, "phase: cash");
    eq("cash/dom fall-shape chip count", domCash.chips.length, 2);
    eq("cash/dom chip labels", domCash.chips.map((c) => c.text).join(" | "), "bear | measured");
    check(
      "cash/dom the two chips are INDEPENDENTLY toned",
      domCash.chips.length === 2 && chipCls(domCash.chips[0]!) !== chipCls(domCash.chips[1]!),
      `tones=${domCash.chips.map(chipCls).join(" | ")}`,
    );
    eq("cash/dom shape chip tone", chipCls(domCash.chips[0]!), "a");
    eq("cash/dom confidence chip tone", chipCls(domCash.chips[1]!), "s");
    check("cash/dom fall-shape overlay row NOT folded", !!domCash.fallRow, `fallRow=${domCash.fallRow}`);
    check(
      "cash/dom confidence WORDING on screen",
      !!domCash.fallRow && domCash.fallRow.includes("measured — both axes measured and agreeing"),
      `fallRow=${domCash.fallRow}`,
    );

    // ---- ARM 3: forced re-entry, a CONFLICTING indeterminate ------------------------------------
    // Mid-run deletes clear only the LIVE set; `allMinted` keeps every id, so a delete that
    // removed fewer rows than minted is retried by the final cleanup instead of being forgotten.
    await deleteScratch(scratchIds);
    scratchIds.length = 0;
    const reId = await insertScratch(template, {
      r4_phase: "reentry",
      r4_reentry_rung: 7,
      fall_shape: "indeterminate",
      fall_velocity: null,
      credit_dwell_closes: 12,
    });
    console.log(`\n[arm reentry] scratch row id=${reId} — r4_phase=reentry, indeterminate + dwell`);
    const apiRe = await readApi();
    const domRe = await readDom(browser, "reentry");
    seen.reentry = domRe;
    eq("reentry/api phase", apiRe.phase, "reentry");
    check("reentry/api confidence key present", apiRe.hasConfidenceKey, "overlays.fallShape.confidence missing");
    eq("reentry/api confidence", apiRe.confidence, "conflicting");
    check("reentry/api promotion predicate on", apiRe.promoted, `promoted=${apiRe.promoted}`);
    eq("reentry/api r4 floor chip count", Array.isArray(apiRe.floorChips) ? (apiRe.floorChips as unknown[]).length : -1, 2);
    eq("reentry/dom phase chip", domRe.r4Phase, "phase: reentry");
    eq("reentry/dom fall-shape chip count", domRe.chips.length, 2);
    eq("reentry/dom chip labels", domRe.chips.map((c) => c.text).join(" | "), "unclear | AXES DISAGREE");
    check(
      "reentry/dom the two chips are INDEPENDENTLY toned",
      domRe.chips.length === 2 && chipCls(domRe.chips[0]!) !== chipCls(domRe.chips[1]!),
      `tones=${domRe.chips.map(chipCls).join(" | ")}`,
    );
    eq("reentry/dom shape chip tone", chipCls(domRe.chips[0]!), "s");
    eq("reentry/dom confidence chip tone", chipCls(domRe.chips[1]!), "a");
    check("reentry/dom fall-shape overlay row NOT folded", !!domRe.fallRow, `fallRow=${domRe.fallRow}`);
    check(
      "reentry/dom confidence WORDING on screen",
      !!domRe.fallRow && domRe.fallRow.includes("conflicting — velocity and credit dwell DISAGREE — a bear is NOT excluded"),
      `fallRow=${domRe.fallRow}`,
    );

    // ---- ARM 4: an unrecognised persisted value hydrates to equity -----------------------------
    // The fall triple is the TEMPLATE's, so this arm differs from the forced ones in the PHASE
    // alone — which is what makes it evidence that the phase is what gates the promotion.
    await deleteScratch(scratchIds); // again: LIVE set only — `allMinted` is the cleanup set
    scratchIds.length = 0;
    const bogusId = await insertScratch(template, { r4_phase: "bogus", r4_reentry_rung: null });
    console.log(`\n[arm bogus] scratch row id=${bogusId} — r4_phase='bogus' ⇒ hydrateR4Phase ⇒ equity`);
    const apiBogus = await readApi();
    const domBogus = await readDom(browser, "equity");
    seen.bogus = domBogus;
    eq("bogus/api phase hydrates to equity", apiBogus.phase, "equity");
    check("bogus/api promotion predicate off", !apiBogus.promoted, `promoted=${apiBogus.promoted}`);
    eq("bogus/api r4 floor carries no chips", apiBogus.floorChips, undefined);
    eq("bogus/dom phase chip", domBogus.r4Phase, "phase: equity");
    eq("bogus/dom fall-shape chip count", domBogus.chips.length, 0);
    check("bogus/dom fall shape is FOLDED into the idle line", !!domBogus.idle && domBogus.idle.includes("shape:"), `idle=${domBogus.idle}`);

    // ---- the NON-VACUITY control (docs/claim-verification.md §28) ------------------------------
    // If `equity` and a forced arm render the SAME DOM, this harness is insensitive and nothing
    // above is evidence. The control compares the WHOLE probe, not one field.
    console.log("\n[control] non-vacuity — equity vs the forced arms must render DIFFERENT DOM");
    const sig = (d: Dom) => JSON.stringify([d.r4Phase, d.chips, d.fallRow, d.idle]);
    check("control: equity DOM != cash DOM", sig(seen.equity) !== sig(seen.cash), "identical DOM — harness insensitive");
    check("control: equity DOM != reentry DOM", sig(seen.equity) !== sig(seen.reentry), "identical DOM — harness insensitive");
    check("control: cash DOM != reentry DOM", sig(seen.cash) !== sig(seen.reentry), "identical DOM — harness insensitive");
  } finally {
    // finally-shaped, per the Stage 8.2 ruling: a throw anywhere above still clears the scratch
    // (Ctrl-C / SIGTERM go through `abortCleanup` instead — a `finally` does not cover a signal).
    // Deletes from `allMinted`, not the live set, so an id a mid-run delete missed is retried.
    //
    // ⚠ The delete gets its OWN try/catch. A transient REST failure here must not skip the two
    // things that follow it: the surviving-id report (the only record of what to remove by hand)
    // and `browser.close()` (otherwise a headless Chromium leaks alongside the rows).
    let deleted = -1;
    let deleteErr: unknown = null;
    try {
      deleted = await deleteScratch(allMinted);
    } catch (err) {
      deleteErr = err;
    }
    let left = -1; // -1 = "could not be re-read", which is NOT 0 and therefore still a failure
    try {
      left = await survivingScratch(allMinted);
    } catch (err) {
      console.log(`[cleanup] survivor re-read FAILED: ${String(err)}`);
    }
    console.log(`\n[cleanup] scratch ids minted=${JSON.stringify(allMinted)} deleted-now=${deleted} surviving=${left}`);
    if (deleteErr) {
      console.log(`[cleanup] ⚠ DELETE THREW — remove these by hand if they survive: ${JSON.stringify(allMinted)}`);
      failures.push(`cleanup: delete threw — ${String(deleteErr)}`);
    }
    if (left !== 0) failures.push(`cleanup: ${left} scratch row(s) survived (-1 = re-read failed)`);
    await browser.close();
  }

  console.log(`\n${failures.length === 0 ? "PASS" : `FAIL (${failures.length})`}`);
  for (const f of failures) console.log(`  · ${f}`);
  if (failures.length) process.exitCode = 1;
}

// --- specimen mode (`--specimen`) ---------------------------------------------------------------
// NF-1 paint: the assertion arms above machine-pin the render, but "is the V-vs-bear hint
// UNMISSABLE" is a purely visual judgement only the user can make, and prod sits at
// `r4Phase: "equity"` (which folds the row by design), so nothing paints there. This mode seeds the
// same two forced states the arms use, serves the REAL /lab locally, and parks until Ctrl-C.
//
// It is ADDITIVE: `main()` and every assertion above are untouched, and nothing in this block runs
// unless `--specimen` is on argv.
//
// Only ONE alert row can be the board: `getRecentAlerts` orders `fired_at DESC, id DESC` and all
// clones inherit the template's `fired_at`, so the largest id wins. Both states are therefore
// seeded up front and the user TOGGLES which is on top — a toggle re-inserts the wanted state (new,
// larger id) and deletes that state's previous id, so the live set stays at exactly two rows, one
// per state, and every delete still goes through the `id > maxRealId` guard.

const SPECIMEN_PHASES = {
  cash: {
    overrides: { r4_phase: "cash", r4_reentry_rung: null, fall_shape: "bear", fall_velocity: -0.012, credit_dwell_closes: 35 },
    expect: "chips `bear` + `measured` on the r4 floor head, and an unfolded `Fall shape` overlay row",
  },
  reentry: {
    overrides: { r4_phase: "reentry", r4_reentry_rung: 7, fall_shape: "indeterminate", fall_velocity: null, credit_dwell_closes: 12 },
    expect: "chips `unclear` + `AXES DISAGREE` on the r4 floor head, and an unfolded `Fall shape` overlay row",
  },
} as const;
type SpecimenPhase = keyof typeof SPECIMEN_PHASES;

/** Read the served phase off the REAL /api/lab, by the same `R4_PHASE_FIELD_LABEL` lookup the
 *  FE matches on (that label string is a LOOKUP KEY — never rename it). */
async function servedPhase(base: string): Promise<unknown> {
  const res = await fetch(`${base}/api/lab`);
  if (!res.ok) throw new Error(`/api/lab -> ${res.status} ${res.statusText}`);
  const d = (await res.json()) as any;
  return d.overlays?.r4?.fields?.find((f: any) => f.label === R4_PHASE_FIELD_LABEL)?.value;
}

async function specimen(): Promise<void> {
  // The prod-write guard is NOT here — it lives inside `insertScratch`, at the write itself.
  const port = Number(process.env.PORT ?? 4321);
  const base = `http://127.0.0.1:${port}`;

  const template = await newestAlertRow();
  maxRealId = await maxAlertId();
  console.log(
    `template alert row id=${String(template.id)} obs_date=${String(template.obs_date)} fired_at=${String(template.fired_at)}` +
      ` · real id high-water mark=${maxRealId} (nothing at or below this can ever be deleted)`,
  );

  // Seed BOTH states. `reentry` goes last, so it holds the largest id and is the state on screen first.
  const live: Record<SpecimenPhase, number> = {
    cash: await insertScratch(template, SPECIMEN_PHASES.cash.overrides),
    reentry: await insertScratch(template, SPECIMEN_PHASES.reentry.overrides),
  };
  let active: SpecimenPhase = "reentry";

  const { spawn } = await import("node:child_process");
  const { createInterface } = await import("node:readline");
  const { fileURLToPath } = await import("node:url");
  // Compose with the EXISTING live server rather than re-implementing routing: it serves public/
  // and routes /api/* to the real api/*.ts handlers over the same local Supabase. It has to run
  // under tsx (those handler imports are .ts), hence the child process rather than an import.
  const serverPath = fileURLToPath(new URL("../preview/server-live.mjs", import.meta.url));
  // The tsx BINARY, never `npx tsx`: `npx` is a wrapper process, so the `server.kill()` below would
  // SIGTERM the wrapper and leave the real node process alive, ORPHANED and still holding the port
  // (observed 2026-07-31 — the next run's child then dies on EADDRINUSE while the banner points at
  // the stale server). Spawning the binary directly makes the kill reach the process that listens.
  const tsxBin = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
  const server = spawn(tsxBin, [serverPath], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "inherit", "inherit"],
  });
  // A dead child is otherwise INVISIBLE: the readiness loop just retries 60× and then falls through
  // to the banner, and — worse — if port `port` is already bound (a stray `preview:live`) the child
  // dies on EADDRINUSE while `servedPhase` happily succeeds against THAT other server, so the run
  // reads as green while the page under judgement is not the one this script seeded for.
  server.on("error", (err) => {
    console.log(`\n⚠ preview server FAILED TO SPAWN: ${String(err)} — nothing is serving ${base}`);
  });
  server.on("exit", (code, sig) => {
    if (code === 0 && !sig) return;
    console.log(
      `\n⚠ preview server EXITED code=${String(code)} signal=${String(sig)} — port ${port} is likely already bound` +
        ` (a stray \`preview:live\`?). Anything answering on ${base} is NOT this run's server; Ctrl-C and retry.`,
    );
  });

  const banner = (): void => {
    const spec = SPECIMEN_PHASES[active];
    console.log(`
────────────────────────────────────────────────────────────────────────────
  NF-1 PAINT SPECIMEN — judge PROMINENCE only (the values are machine-pinned)

  open:      ${base}/lab
  scratch:   cash id=${live.cash}   reentry id=${live.reentry}   (real rows end at id ${maxRealId})

  ON SCREEN NOW →  r4_phase = ${active}
    look for: ${spec.expect}

  press ENTER  → swap to the other state (${active === "cash" ? "reentry" : "cash"}), then RELOAD /lab
  press Ctrl-C → delete both scratch rows and put the DB back exactly as found
────────────────────────────────────────────────────────────────────────────`);
  };

  // Wait for the server, then report the phase the API actually serves for the active row.
  for (let i = 0; i < 60; i++) {
    try {
      const phase = await servedPhase(base);
      console.log(`\n/api/lab serves overlays.r4.fields[label="phase"].value = ${JSON.stringify(phase)}`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  banner();

  const rl = createInterface({ input: process.stdin });
  rl.on("line", () => {
    // Every write goes on ONE chain, and `abortCleanup` awaits that chain before deleting — so a
    // Ctrl-C can no longer interleave between an insert's POST and its `allMinted` push. The
    // `aborting` re-check keeps a swap queued behind the signal from starting a NEW write at all.
    const swap = (pendingWrite = pendingWrite.then(async (): Promise<SpecimenPhase | null> => {
      if (aborting) return null;
      const next: SpecimenPhase = active === "cash" ? "reentry" : "cash";
      const stale = live[next];
      // Re-insert FIRST (so a failure mid-swap leaves the board on a real row, never on nothing),
      // then drop the state's previous id through the guarded delete.
      live[next] = await insertScratch(template, SPECIMEN_PHASES[next].overrides);
      await deleteScratch([stale]);
      active = next;
      return next;
    }));
    // The read-back and the banner sit OFF the write chain: they must not make `abortCleanup` wait
    // on a fetch, and they are pure reporting.
    void swap
      .then(async (next) => {
        if (!next || aborting) return;
        const phase = await servedPhase(base);
        console.log(`\nswapped → /api/lab now serves phase = ${JSON.stringify(phase)}`);
        banner();
      })
      .catch((err) => console.log(`swap FAILED: ${String(err)}`));
  });

  // Park. Ctrl-C is the only exit: SIGINT/SIGTERM reach `abortCleanup`, which deletes `allMinted`
  // (every id ever minted, including ones a swap already removed — a re-delete is a harmless no-op)
  // and prints any survivor. `process.exit` DOES run this "exit" handler, so the server child is
  // killed on Ctrl-C too — but only because it is the tsx binary and not an `npx` wrapper (above).
  process.on("exit", () => server.kill());
  await new Promise(() => {});
}

if (process.argv.includes("--specimen")) {
  await specimen();
} else {
  await main();
}
