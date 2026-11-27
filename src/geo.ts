/**
 * GEO channel input (the "what"): the active manual geopolitical-flag count
 * that feeds GEO_score (v4 §6.4). One seam, one function — mirrors the
 * one-function-per-seam posture of fred.ts / prices.ts / ntfy.ts.
 *
 * The flag list is committed in config.json and statically imported, so it's
 * serverless-safe (no fs path resolution inside a Vercel function) and parsed
 * once at module load. Changing a flag requires a redeploy — the deliberate
 * "no maintenance workflow" the design asks for on a notify-only gauge.
 */

import geoConfig from "../config.json" with { type: "json" };

export interface GeoFlag {
  id: string; // e.g. "G4-hormuz"
  label: string; // human-readable, for logs / future payload
  since: string; // YYYY-MM-DD the flag was raised (audit; not scored)
}

interface GeoConfig {
  flags?: GeoFlag[];
  /** Declared crisis stage 0–4 (playbook §3 ladder) — see config.json `_crisisStage_comment`. */
  crisisStage?: number;
}

/** The GEO channel's manual inputs (Stage 4, 2026-07-24): the active flag count plus the
 *  declared crisis stage. Both come from committed config.json (redeploy-to-edit). */
export interface GeoInputs {
  flagCount: number;
  crisisStage: number;
}

/**
 * Manual GEO inputs → the alert-band geo floor. `flagCount` = active manual flags
 * (each elevated flag = 1, matching the ladder's 1=WATCH / 2=WARNING calibration);
 * `crisisStage` = the declared playbook §3 stage (0–4), folded into the same geo
 * base as `STAGE_TO_FLAGS[stage]` extra flags (alert-band.ts, Option A count-fold).
 * Pure + unit-testable: pass a fixture config; the default wires the committed
 * config.json. Absent/empty `flags` → 0; absent `crisisStage` → 0 (no crisis).
 * FAIL-LOUD: a present stage outside {0,2,4} throws — stage 1 is auto-scored
 * (run-core's geoCalmStreak machine) and declared 3 merged into 2 (A2, 2026-08-15:
 * both mapped +2, so two criteria sets bought zero band effect; frozen replays may
 * still carry a historic 3 — they bypass this loader, and STAGE_TO_FLAGS[3] stays +2).
 */
export function loadGeoInputs(config: GeoConfig = geoConfig): GeoInputs {
  const crisisStage = config.crisisStage ?? 0;
  if (!Number.isInteger(crisisStage) || ![0, 2, 4].includes(crisisStage)) {
    throw new Error(`config.json crisisStage must be one of {0,2,4} (1 is auto-scored; 3 merged into 2), got ${crisisStage}`);
  }
  return { flagCount: config.flags?.length ?? 0, crisisStage };
}

/**
 * Active manual geo-flag count → GEO_score. Kept as a one-line wrapper over
 * {@link loadGeoInputs} (Stage 4) so pre-stage call sites (api/lab.ts) keep working.
 */
export function loadGeoActiveCount(): number {
  return loadGeoInputs(geoConfig).flagCount;
}
