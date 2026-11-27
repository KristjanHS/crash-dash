/**
 * Exposure-dial thin shell (slice E1): fetch /api/exposure → the pure
 * exposure-view.js seam → DOM. NO markup/format logic lives here (it is all in
 * the seam, unit-pinned by exposure-view.test.js). This file runs module-level
 * DOM side effects and is NEVER imported by a test (the lab.js side-effect trap).
 */
import { exposureViewModel } from "./exposure-view.js";
import { intradayVerdictLabel } from "./feed-age-mark.js";
import { canViewPage } from "./auth-session.js";
import { fetchOnce, prefetchThenGate } from "./gate-prefetch.js";
import { API_TIMEOUT_MS, request } from "./http.js";

// The public read starts before the gate (taken by `fetchOnce`), off the renewal path.
const BOOT_URLS = ["/api/exposure"];
// P11-gate — before any localStorage paint: `canViewPage` says no ⇒ /overview.
if (!(await prefetchThenGate(BOOT_URLS, canViewPage))) {
  location.replace("/overview");
  await new Promise(() => {}); // hold the module while the navigation lands
}

const $ = (id) => document.getElementById(id);

/** Paint one chip container ({label, tone, detail, asOf, what, cuts, why}) from a view model.
 *  Each chip carries its OWN as-of date (R10) — there is no page-level `as of` line — and its
 *  own three-part footnote (R1: what it is / which thresholds / why only these metrics). The
 *  threshold text is built in the seam from the SERVED cuts; no number is typed here. */
function paintChip(el, model) {
  el.dataset.tone = model.tone;
  el.querySelector(".exp-chip-label").textContent = model.label;
  el.querySelector(".exp-chip-tone").textContent = model.tone;
  el.querySelector(".exp-chip-detail").textContent = model.detail;
  el.querySelector(".exp-chip-asof").textContent = model.asOf;
  el.querySelector(".exp-chip-what").textContent = model.what;
  el.querySelector(".exp-chip-cuts").textContent = model.cuts;
  el.querySelector(".exp-chip-why").textContent = model.why;
}

function paint(resp) {
  const vm = exposureViewModel(resp);

  const posture = $("posture");
  posture.textContent = vm.posture.label;
  posture.dataset.tone = vm.posture.tone;
  // The held rung / cash level behind the posture came off the daytime run (`provisional`) — say so.
  const intraday = intradayVerdictLabel({ provisional: resp?.provisional });
  $("posture-weight").textContent = intraday ? `${vm.posture.detail} · ${intraday.text}` : vm.posture.detail;
  $("posture-weight").title = intraday ? intraday.title : "";

  paintChip($("arm-chip"), vm.arm);
  paintChip($("fire-chip"), vm.fire);

  $("message").hidden = true;
  $("exposure").hidden = false;
}

async function load() {
  try {
    const res = await request("/api/exposure", { fetchImpl: fetchOnce, timeoutMs: API_TIMEOUT_MS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    paint(await res.json());
  } catch (err) {
    const msg = $("message");
    msg.textContent = `Could not load exposure - ${err.message}`;
    msg.hidden = false;
  }
}

load();
