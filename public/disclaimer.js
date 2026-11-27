// MIRROR of src/disclaimer.ts — the browser cannot import a .ts constant and tsconfig has no allowJs.
// The two legal literals live in BOTH files; src/disclaimer-parity.test.ts reads both as TEXT and
// fails on any drift. Keep each literal on ONE line, double-quoted, byte-identical to the source.
export const DISCLAIMER_SHORT = "Not investment advice. Informational only; data may be delayed or wrong.";
export const DISCLAIMER_LONG = "Nothing here is investment advice, a personal recommendation, or a solicitation to buy, sell or hold any instrument. It considers no reader's objectives. Data may be delayed, incomplete or wrong, and signals may stop without notice. Any decision is the reader's own.";

// localStorage key for the first-visit acknowledgement (versioned so a wording change can re-nag).
export const DISMISS_KEY = "cd-disclaimer-ack-v1";

// True unless the visitor has dismissed the bar. No storage (private mode / SSR) ⇒ false: we cannot
// persist a dismissal, so nagging every load is worse than staying silent (the footer line still shows).
export function shouldShowDisclaimer(storage) {
  if (!storage) return false;
  try {
    return storage.getItem(DISMISS_KEY) !== "1";
  } catch {
    return false;
  }
}

export function dismissDisclaimer(storage) {
  if (!storage) return;
  try {
    storage.setItem(DISMISS_KEY, "1");
  } catch {
    /* private mode — dismissal simply won't persist */
  }
}

// The DISCLAIMER_SHORT footer line, injected below the legal nav. textContent, never innerHTML.
export function footerLine(doc) {
  const p = doc.createElement("p");
  p.className = "site-footer-legal";
  p.textContent = DISCLAIMER_SHORT;
  return p;
}

// The first-visit bar: a non-blocking region (NOT a modal) carrying DISCLAIMER_LONG + a /terms link
// + an OK control. tabindex=-1 so focus can move to it on first paint. Built via DOM API (no innerHTML).
export function buildDisclaimerBar(doc) {
  const bar = doc.createElement("div");
  bar.className = "disclaimer-bar";
  bar.setAttribute("role", "region");
  bar.setAttribute("aria-label", "Legal notice");
  bar.setAttribute("tabindex", "-1");

  const text = doc.createElement("p");
  text.className = "disclaimer-bar-text";
  text.textContent = DISCLAIMER_LONG + " ";
  const link = doc.createElement("a");
  link.href = "/terms";
  link.textContent = "Read the full terms";
  text.appendChild(link);
  text.appendChild(doc.createTextNode("."));

  const ok = doc.createElement("button");
  ok.type = "button";
  ok.className = "disclaimer-dismiss";
  ok.textContent = "OK";

  bar.appendChild(text);
  bar.appendChild(ok);
  return { bar, ok };
}

// Move focus to the bar; return a closure that restores focus to whatever held it before (a11y:
// focus must not be left stranded on a removed element after dismiss).
export function moveFocusToBar(bar, doc) {
  const prev = doc.activeElement;
  if (typeof bar.focus === "function") bar.focus();
  return function restoreFocus() {
    if (prev && typeof prev.focus === "function") prev.focus();
  };
}

// Full wiring: inject the footer line on every page, then show the first-visit bar if undismissed.
// Pure in its inputs (doc, storage) so tests drive it with mocks; the guarded call at the bottom is
// the only DOM touch that runs at import time in the browser.
export function initDisclaimer(doc, storage) {
  const footer = doc.querySelector(".site-footer");
  if (footer && !footer.querySelector(".site-footer-legal")) {
    const nav = footer.querySelector(".site-footer-links");
    const line = footerLine(doc);
    if (nav && nav.nextSibling) footer.insertBefore(line, nav.nextSibling);
    else footer.appendChild(line);
  }

  if (!shouldShowDisclaimer(storage)) return;
  const { bar, ok } = buildDisclaimerBar(doc);
  doc.body.appendChild(bar);
  const restoreFocus = moveFocusToBar(bar, doc);
  ok.addEventListener("click", () => {
    dismissDisclaimer(storage);
    bar.remove();
    restoreFocus();
  });
}

function safeStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

if (typeof document !== "undefined") {
  initDisclaimer(document, safeStorage());
}
