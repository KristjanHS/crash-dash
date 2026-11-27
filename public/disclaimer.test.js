// Pure-logic tests for disclaimer.js; DOM-touching paths run against mock doc/storage objects.
// Also owns the legal-page HTML pins (ex-legal-pages.test.js) — the
// disclaimer bar is the site's legal furniture's one JS seam, and links the same /terms page.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  DISMISS_KEY,
  buildDisclaimerBar,
  dismissDisclaimer,
  moveFocusToBar,
  shouldShowDisclaimer,
} from "./disclaimer.js";

/** A minimal localStorage double. */
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

describe("shouldShowDisclaimer / dismissDisclaimer", () => {
  it("shows on a fresh visitor and hides once dismissed (round-trip)", () => {
    const storage = fakeStorage();
    expect(shouldShowDisclaimer(storage)).toBe(true);
    dismissDisclaimer(storage);
    expect(storage.getItem(DISMISS_KEY)).toBe("1");
    expect(shouldShowDisclaimer(storage)).toBe(false);
  });

  it("hides when storage is unavailable (private mode / SSR) rather than nagging every load", () => {
    expect(shouldShowDisclaimer(null)).toBe(false);
    // A throwing storage (blocked cookies) is treated the same, never a crash.
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    expect(shouldShowDisclaimer(throwing)).toBe(false);
  });
});

describe("a11y focus management", () => {
  it("moves focus to the bar on paint and returns it to the previously-focused element on dismiss", () => {
    const prev = { focus: vi.fn() };
    const bar = { focus: vi.fn() };
    const doc = { activeElement: prev };

    const restore = moveFocusToBar(bar, doc);
    expect(bar.focus).toHaveBeenCalledTimes(1); // focus landed on the bar
    expect(prev.focus).not.toHaveBeenCalled(); // not yet restored

    restore();
    expect(prev.focus).toHaveBeenCalledTimes(1); // focus returned to the trigger
  });
});

describe("bar markup — a11y attributes and the required controls", () => {
  // A hand-rolled document double: createElement returns nodes that record their attributes/children,
  // enough to assert the structure buildDisclaimerBar emits without a DOM environment.
  function fakeDoc() {
    const make = (tag) => ({
      tag,
      attrs: {},
      children: [],
      className: "",
      href: undefined,
      type: undefined,
      textContent: "",
      setAttribute(k, v) {
        this.attrs[k] = v;
      },
      appendChild(c) {
        this.children.push(c);
        return c;
      },
    });
    return {
      createElement: (t) => make(t),
      createTextNode: (t) => ({ tag: "#text", textContent: t }),
    };
  }

  it("emits a non-modal region, a /terms link, and an OK button", () => {
    const { bar, ok } = buildDisclaimerBar(fakeDoc());
    expect(bar.attrs.role).toBe("region"); // non-blocking region, NOT role="dialog"/modal
    expect(bar.attrs["aria-label"]).toBe("Legal notice");
    expect(bar.attrs.tabindex).toBe("-1"); // programmatically focusable
    const link = bar.children[0].children.find((c) => c.tag === "a");
    expect(link.href).toBe("/terms");
    expect(ok.type).toBe("button");
    expect(ok.textContent).toBe("OK");
  });
});

// ── legal pages (ex-legal-pages.test.js) ────────────────────────────────────────────────────────
describe("legal pages", () => {
  // The site's legal furniture.
  // These pins guard three things: the imprint cannot ship with an unfilled operator field, every
  // entry + legal page carries the five-link footer, and the attribution page states both ECB limbs.

  const readRaw = (name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
  const read = (name) => readRaw(name).replace(/<!--[\s\S]*?-->/g, "");

  /** The five legal pages the footer links, by cleanUrls route. */
  const LEGAL_ROUTES = ["/imprint", "/terms", "/privacy", "/cookies", "/attribution"];
  /** Every page that must carry the footer: the six entries + /about + the five legal pages themselves. */
  const FOOTER_PAGES = [
    "index.html",
    "about.html",
    "lab.html",
    "exposure.html",
    "journal.html",
    "subscribe.html",
    "signin.html",
    "imprint.html",
    "terms.html",
    "privacy.html",
    "cookies.html",
    "attribution.html",
  ];

  describe("Stage 1 - imprint fields this site publishes", () => {
    it("carries every mandatory imprint field, and marks each unfilled one with the sentinel", () => {
      // The imprint's *content* gate — that no `OPERATOR TODO` sentinel survives to prod — is a
      // SHIP gate (`scripts/ship.sh`, beside the WAF check), NOT an assertion here: a pin that is
      // red by design would commit a red suite, poisoning bisect and every later `npm run check`.
      // What this pin guards instead is that the operator block cannot be quietly gutted — deleting
      // a mandatory row reds here, and deleting the sentinel without supplying a value reds at ship.
      const imprint = readRaw("imprint.html");
      for (const field of ["Legal form", "Name", "Email"]) {
        expect(imprint.includes(`<dt>${field}</dt>`), `imprint.html lost its mandatory "${field}" row`).toBe(true);
      }
      // Ruled 2026-08-20 (§10.1): a named natural person, NOT an OÜ. A silent switch to a company
      // form would change who carries the liability, so it is pinned rather than left to prose.
      expect(imprint, "imprint.html no longer states the ruled natural-person legal form").toMatch(
        /natural person/i,
      );
      // Every field still awaiting the operator renders as `<dd class="todo">`, and the ship gate
      // greps the `OPERATOR TODO` sentinel — so a todo cell whose sentinel was edited away would
      // deploy silently with a visible blank. Pin the two together rather than counting either.
      const todoCells = imprint.match(/<dd class="todo">[\s\S]*?<\/dd>/g) ?? [];
      for (const cell of todoCells) {
        expect(
          cell,
          `an unfilled imprint cell lost its OPERATOR TODO sentinel - the ship gate greps that string, so this would deploy blank: ${cell}`,
        ).toMatch(/OPERATOR TODO/);
      }
    });
  });

  describe("Stage 1 - the five-link legal footer", () => {
    it("links all five legal pages from every entry and legal page", () => {
      for (const page of FOOTER_PAGES) {
        const html = read(page);
        for (const route of LEGAL_ROUTES) {
          expect(html, `${page} is missing a footer link to ${route}`).toMatch(
            new RegExp(`href="${route}"`),
          );
        }
      }
    });
  });

  describe("Stage 1 - the footer donation line", () => {
    it("offers the gift on every footer page, pointing at the one live handle", () => {
      // Donations are a GIFT: the footer ask and the terms clause that says it buys nothing must
      // travel together, or the site solicits money with no published basis. A second payment
      // handle appearing anywhere would be a silent misdirection of donor money, so the URL is
      // pinned exactly rather than matched loosely. The footer states the no-consideration clause
      // in plain text (its link to /terms#donations was dropped 2026-08-20); the footer's /terms
      // link above still reaches the clause, and the anchor itself stays pinned below.
      for (const page of FOOTER_PAGES) {
        const html = read(page);
        expect(html, `${page} lost its footer donation line`).toMatch(
          /href="https:\/\/paypal\.me\/kristjanhs"/,
        );
        expect(html, `${page} asks for a gift without stating it buys nothing`).toMatch(
          /buys nothing/i,
        );
      }
      const terms = read("terms.html");
      expect(terms, "terms.html lost the #donations anchor the footer links").toMatch(
        /id="donations"/,
      );
      expect(terms, "terms.html no longer states donations buy nothing").toMatch(/buys nothing/i);
    });
  });

  describe("Stage 1 - attribution page credits (legal audit §1.5)", () => {
    it("names FRED and ECB and states both ECB reuse limbs, consistent with X-Data-Terms", () => {
      const attribution = read("attribution.html");
      // Limb 1 — cite the source.
      expect(attribution).toMatch(/FRED, Federal Reserve Bank of St\. Louis/);
      expect(attribution).toMatch(/European Central Bank/);
      // Limb 2 — state the values were modified/derived by the operator, not published by the source.
      // Same two phrases the shipped `X-Data-Terms` header carries (vercel.json).
      expect(attribution).toMatch(/derived and transformed/i);
      expect(attribution).toMatch(/not published by/i);
    });

    it("credits the US-federal and Bundesbank sources the dashboard reads", () => {
      const attribution = read("attribution.html");
      for (const name of [/Source: US Treasury/, /Source: Federal Reserve Board/, /Source: Deutsche Bundesbank/]) expect(attribution).toMatch(name);
    });
  });
});
