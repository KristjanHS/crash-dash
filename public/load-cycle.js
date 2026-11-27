/*
 * load-cycle.js — the request ORDER of the dashboard's (app.js fetchAll) and /overview's
 * (overview.js loadAll) load cycles, perf P4. DOM-free so vitest can drive it with deferred fetch
 * stubs — neither page module is importable.
 *
 * First load (no painted vintage): the fan-out starts BESIDE `/api/status`, so a cold paint costs
 * max(status, fan-out), not their sum. Refocus (a vintage is painted): `/api/status` alone; the
 * fan-out starts only once `refetchPlan` says the vintage moved (P9.1). With a boot bundle stored the
 * dashboard stays status-first (its restore paint needs status's vintage).
 * A gated `/` boot prefetches the fan-out before its gate; a stored-boot visit discards those edge reads.
 * Each cycle returns an outcome the page dispatches on; showError/showEmpty stay the page's.
 * `fetch` is injectable (tests) and defaults to the global one.
 */
import { LAB_LOOKBACK } from "./lab-lookback.js";
import { hasBoot, readBoot, refetchPlan, vintageOf } from "./refetch-gate.js";
import { API_TIMEOUT_MS, baseFetch, request } from "./http.js";

const ERROR = Object.freeze({ kind: "error" });
// A signal-only init still takes the boot prefetch (gate-prefetch.js `takeOrFetch`).
const bare = (fetchImpl) => ({ fetchImpl, timeoutMs: API_TIMEOUT_MS });

/**
 * `start()` now when `eager`, else on the first `take()`. An eager start that a failed `/status`
 * abandons never surfaces as an unhandled rejection; `take()` still sees the rejection.
 */
export function fanOutHandle(eager, start) {
  const run = () => {
    try {
      return start();
    } catch (e) {
      return Promise.reject(e);
    }
  };
  let p = eager ? run() : null;
  p?.catch(() => {});
  return () => (p ??= run());
}

/**
 * /overview's cycle. `{kind:"error"}` | `{kind:"stop"}` (same vintage — nothing to repaint) |
 * `{kind:"paint", status, d, familyOrder, indicators}`, the danger model already settled.
 */
export async function loadOverview({ vintage, loadDangerModel, fetch = baseFetch }) {
  let dmReady;
  const via = bare(fetch);
  const take = fanOutHandle(!vintage, () => {
    dmReady = loadDangerModel(); // parallel with the board fetch; cached after the first
    return Promise.all([request("/api/lab?hist=" + LAB_LOOKBACK, via), request("/api/families", via), request("/api/indicators", via)]);
  });
  let status;
  try {
    const res = await request("/api/status", via);
    if (!res.ok) return ERROR;
    status = await res.json();
  } catch {
    return ERROR;
  }
  // P9 refocus gate: an unchanged vintage means everything on screen is current — stop at 1 request.
  if (refetchPlan(vintage, vintageOf(status)) === "stop") return { kind: "stop" };
  let out;
  try {
    const [labRes, famRes, indRes] = await take();
    if (!labRes.ok || !indRes.ok) return ERROR;
    const d = await labRes.json();
    out = { kind: "paint", status, d, familyOrder: famRes.ok ? await famRes.json() : [], indicators: await indRes.json() };
  } catch {
    return ERROR;
  }
  await dmReady; // ledger columns + detail explainer degrade soft if it failed (dangerModel null)
  return out;
}

/**
 * The dashboard's cycle. `{kind:"error"}` | `{kind:"empty"}` (`/status` 404 — no runs yet) |
 * `{kind:"stop", status}` (same vintage — repaint the wall-clock pills) |
 * `{kind:"stored", status, next, stored}` (P9.2 boot bundle) |
 * `{kind:"fresh", status, next, indicators, history, config}`. `onFull()` runs where a full
 * refetch is decided — after the stop/restore returns, before the fan-out is awaited.
 */
export async function loadDashboard({ api: API, vintage, storage, mult, getConfig, getFamilies, onFull, fetch = baseFetch }) {
  // Indicators meta + the two newest history rows (transition line only) + the ladder config
  // (getConfig short-circuits once cached) + families (populates the state.familyOrder cache).
  const via = bare(fetch);
  const take = fanOutHandle(!vintage && !hasBoot(storage, mult), () =>
    Promise.all([request(`${API}/indicators`, via), request(`${API}/history?limit=2`, via), getConfig(), getFamilies()]),
  );
  let statusRes;
  try {
    statusRes = await request(`${API}/status`, via);
  } catch {
    return ERROR; // network down
  }
  if (statusRes.status === 404) return { kind: "empty" };
  if (!statusRes.ok) return ERROR; // 5xx etc.
  let status;
  try {
    status = await statusRes.json();
  } catch {
    return ERROR;
  }
  const next = vintageOf(status);
  // P9.1 — a refocus on the vintage already painted stops here: `/status` (edge-HIT) is the whole
  // cost. The verdict moves once per weekday, so this is the common refocus outcome.
  if (refetchPlan(vintage, next) === "stop") return { kind: "stop", status };
  // P9.2 — a fresh page load whose stored bundle carries this exact firedAt + deployId paints from
  // storage. Never on a deploy (deployId differs), never without a deploy id, never a foreign mult.
  if (!vintage) {
    const stored = readBoot(storage, { vintage: next, mult });
    if (stored) return { kind: "stored", status, next, stored };
  }
  onFull();
  try {
    const [indRes, histRes, config] = await take();
    if (!indRes.ok || !histRes.ok) return ERROR; // a refocus retries the whole cycle — vintage stays unset
    const indicators = await indRes.json();
    const history = await histRes.json();
    return { kind: "fresh", status, next, indicators, history, config };
  } catch {
    return ERROR;
  }
}
