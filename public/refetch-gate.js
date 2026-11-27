/*
 * refetch-gate.js — the vintage gate behind app.js's fetch cycle (load-tolerance P9).
 *
 * Pure and DOM-free (vitest-importable, like app-state.js). Two decisions live here:
 *   P9.1 `refetchPlan` — a `visibilitychange` refocus fetches `/status` ONLY; when its
 *        `verdict.firedAt` equals the vintage already painted the cycle STOPS (72 → 1 edge
 *        request per refocus). Only a changed vintage (or the first paint) fans out.
 *   P9.2 `readBoot`/`writeBoot` — a fresh page load paints from `localStorage` when the stored
 *        bundle carries the SAME `firedAt` AND the SAME `deployId` (a deploy cannot reach a tab,
 *        so a deploy-id mismatch is the one thing that must force a full fetch — the browser
 *        `max-age` `src/api/http.ts` forbids, made safe by that check). No deploy id on either
 *        side ⇒ never paint from storage (local preview, a pre-P9 build).
 * Every storage access is try/catch'd: a private window, a full quota, or a garbage payload
 * degrades to the full fetch, never to a blank page.
 */

export const BOOT_KEY = "crash-dash:boot:v1";
/** Bundle size cap in UTF-16 code units (≈ bytes): metas + history + config + families
 *  ≲ 300 KB. */
export const BOOT_CAP_CHARS = 2_000_000;

/** The vintage stamp `/api/status` carries: the verdict's `firedAt` + the serving build's deploy id. */
export function vintageOf(status) {
  return {
    firedAt: typeof status?.verdict?.firedAt === "string" ? status.verdict.firedAt : null,
    deployId: typeof status?.deployId === "string" && status.deployId ? status.deployId : null,
  };
}

/**
 * `"stop"` when a painted vintage exists and `next.firedAt` equals it — the refocus was fully
 * served by the one `/status` request. `"full"` on the first paint, an unknown `firedAt`, or a
 * changed one. In-session the deploy id is NOT compared: the tab runs the build it loaded, and a
 * newer build's payloads would be foreign to it — a reload picks the new build up.
 */
export function refetchPlan(prev, next) {
  if (!prev || !prev.firedAt || !next?.firedAt) return "full";
  return prev.firedAt === next.firedAt ? "stop" : "full";
}

/**
 * The stored boot bundle, or null unless it matches `want` exactly: same `firedAt`, same non-empty
 * `deployId`, same `mult`, sane shape. A shape mismatch or parse error reads as "no bundle".
 */
export function readBoot(storage, want) {
  const { vintage, mult = 0 } = want ?? {};
  if (!storage || !vintage?.firedAt || !vintage.deployId) return null;
  let raw;
  try {
    raw = storage.getItem(BOOT_KEY);
  } catch {
    return null;
  }
  if (typeof raw !== "string") return null;
  let b;
  try {
    b = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!b || typeof b !== "object" || b.v !== 1) return null;
  if (b.firedAt !== vintage.firedAt || b.deployId !== vintage.deployId || (b.mult ?? 0) !== mult) return null;
  // `families: []` is the failed-fetch marker getFamilies() retries on — a restore paint never reaches that retry.
  if (!Array.isArray(b.indicators) || !Array.isArray(b.history) || !Array.isArray(b.families) || b.families.length === 0) return null;
  if (!b.config || typeof b.config !== "object") return null;
  return b;
}

/**
 * True when a bundle `readBoot` would accept for SOME vintage is stored for this `mult` — the P4
 * first load (load-cycle.js) then stays status-first, since only `/status` names the vintage to match.
 */
export function hasBoot(storage, mult = 0) {
  let b;
  try {
    b = JSON.parse(storage?.getItem(BOOT_KEY) ?? "null");
  } catch {
    return false;
  }
  return readBoot(storage, { vintage: { firedAt: b?.firedAt, deployId: b?.deployId }, mult }) !== null;
}

/**
 * Persist a boot bundle. Returns true on a successful write; false (and leaves storage as it was)
 * when the bundle is incomplete, over `BOOT_CAP_CHARS`, or the storage throws.
 */
export function writeBoot(storage, bundle) {
  if (!storage) return false;
  const { vintage, mult = 0, indicators, history, config, families } = bundle ?? {};
  if (!vintage?.firedAt || !vintage.deployId) return false;
  if (!Array.isArray(indicators) || !Array.isArray(history) || !Array.isArray(families) || families.length === 0 || !config) return false;
  const payload = { v: 1, firedAt: vintage.firedAt, deployId: vintage.deployId, mult, indicators, history, config, families };
  let raw;
  try {
    raw = JSON.stringify(payload);
  } catch {
    return false;
  }
  if (raw.length > BOOT_CAP_CHARS) return false;
  try {
    storage.setItem(BOOT_KEY, raw);
    return true;
  } catch {
    return false;
  }
}
