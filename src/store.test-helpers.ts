/**
 * Shared fixtures + the DB-integration gate for the `store.*.test.ts` family.
 *
 * NOT a `*.test.ts`: vitest would collect it and report an empty suite. Split out of
 * `store.test.ts` (2026-08-09) — the `alert()` fixture and the four-layer `hasDb` gate
 * plus its `truncate()` are used by more than one of the subject files.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { assertDisposableStack, supabaseMarkerProbe } from "./disposable-guard.js";
import { SupabaseStore, type AlertRecord } from "./store.js";

export const alert = (over: Partial<AlertRecord> = {}): AlertRecord => ({
  date: "2026-06-25",
  level: "WATCH",
  bandReason: "regime",
  fin: 2,
  rate: 0,
  geoFlags: 0,
  geoCalmStreak: null,
  coincident: "GREEN",
  finReds: 0,
  firedAt: "2026-06-25T21:00:00.000Z",
  pushedAt: null,
  pushError: null,
  degraded: [],
  nonLiveFamilies: null,
  slowScore: null,
  slowBand: null,
  slowMaxScore: null,
  bottomState: null,
  vix: null,
  vix3m: null,
  ratio: null,
  r4Phase: null,
  r4EntryFiredAt: null,
  r4ReentryRung: null,
  dialBand: null,
  dialState: null,
  displayDialState: null,
  panelState: null,
  displayPanelState: null,
  heldSleeve: null,
  reriskConfirmCount: 0,
  heldDays: 0,
  cashOverlay: "off",
  cashOverlaySince: null,
  cashOverlayReason: null,
  dialTargetRung: null,
  fallShape: "indeterminate",
  fallVelocity: null,
  creditDwellCloses: null,
  ...over,
});

// --- Integration: SupabaseStore vs the local `supabase start` stack -----------
//
// Runs only when SUPABASE_URL + SUPABASE_SERVICE_KEY point at the LOCAL stack AND
// DB_TESTS=1 explicitly opts in (CI sets it). The extra gates exist because this
// suite TRUNCATES every table in whatever DB the creds reach (review §5-Q10):
// vitest.config loads .env.local, so before the opt-in a routine `vitest run`
// silently wiped an 82k-row local backfill (2026-07-16) — and pointed at prod it
// would empty prod. PostgREST DELETE needs a filter, so `.gte("id", 0)` matches every row.
//
// THREE layers, none of which replaces another (audit TEST-2, Stage 4.1):
//   1. isLocalUrl  — keeps prod creds out. Does NOT protect the dev DB: it IS localhost.
//   2. DB_TESTS=1  — an opt-in that lives only in prose; a .env.local line satisfies it.
//   3. the `_disposable_stack` marker — asserted inside truncate() BEFORE its first
//      delete. Seeded ONLY by ci.yml's CI-only step, so no .env.local line can forge it.
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
const isLocalUrl = Boolean(url && /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url));
export const hasDb = Boolean(url && key) && isLocalUrl && process.env.DB_TESTS === "1";

// `describe.runIf(hasDb)` (not a bare `if`) so the suite stays VISIBLE-as-skipped
// in the report when no DB is up — a silent omission lets DB-logic changes ship
// without anyone noticing the integration half never ran. runIf-false does not
// execute the body, so the lazy client construction below never touches undefined creds.
export let admin: SupabaseClient | undefined;
export let supa: SupabaseStore | undefined;
export const truncate = async () => {
  admin ??= createClient(url!, key!, { auth: { persistSession: false, autoRefreshToken: false } });
  supa ??= new SupabaseStore(url!, key!);
  // Layer 3 — MUST stay above the first delete: an unmarked stack throws here, untouched.
  await assertDisposableStack(url!, supabaseMarkerProbe(admin));
  // Independent tables, no FKs between them — wipe in one wave, not 4 serial round trips
  // (this runs beforeEach across ~40 integration tests).
  await Promise.all([
    admin.from("readings").delete().gte("id", 0),
    admin.from("intraday_verdict").delete().eq("id", true),
    admin.from("alert_log").delete().gte("id", 0),
    admin.from("calibration").delete().gte("id", 0),
    admin.from("overrides").delete().gte("id", 0),
    admin.from("readings_warmup").delete().gte("id", 0),
    // scorer_vintage's PK is indicator_id (text, no surrogate id) — key the filter on it.
    admin.from("scorer_vintage").delete().gte("indicator_id", ""),
    // leg_pillars has NO surrogate `id` (its PK is the 4-tuple), so the match-everything
    // filter keys on obs_date instead — PostgREST still refuses an unfiltered DELETE.
    admin.from("leg_pillars").delete().gte("obs_date", "1900-01-01"),
  ]);
};
