/**
 * Nav-link relabel shell: every page carries `<a data-auth-nav href="/signin">`, and this module
 * sets its text from the live stored session ("Sign in" / "Signed in · sign out"). DOM-only,
 * NEVER imported by a test — the label rule is `authNavLabel` in the pure `signin-view.js` seam.
 * Renews through `auth-session.js` (its one fetch); no gate, no redirect.
 */
import { ensureSession } from "./auth-session.js";
import { authNavLabel } from "./signin-view.js";

// No top-level await: the ship bundle inlines this BEFORE the page module, so one would serialize its gate.
void ensureSession().then((session) => {
  const label = authNavLabel(session);
  for (const a of document.querySelectorAll("a[data-auth-nav]")) {
    a.textContent = `${label} `;
    const arrow = document.createElement("span");
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "↗";
    a.append(arrow);
  }
});
