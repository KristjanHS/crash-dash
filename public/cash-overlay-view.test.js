// W5-a Stage 3.1 — precedence pins for the footer cash claim. Plain `.js` so vitest collects it
// and tsc ignores it; no jsdom (pure string builder). Imports the seam module DIRECTLY — never
// lab.js, which has module-level DOM/localStorage side effects.
//
// The load-bearing assertion is the precedence one: R4 `cash` AND an active overlay must yield
// EXACTLY ONE cash claim (mirroring
// src/cash-overlay.ts's `resolveCash`).
import { describe, it, expect } from "vitest";
import { cashClaimHtml, resolveCashClaim } from "./cash-overlay-view.js";
import { loadEquityPct, makeEquityPctLoader } from "./exposure-equity.js";
// B-22 drift guard: generate a REAL v-shape-suppressed overlay through the SERVER's suppressor, so the
// FE's marker literal is pinned against `src/cash-overlay.ts`'s `V_SHAPE_SUPPRESS_PREFIX`, not a copy.
import { applyFallShape } from "../src/v-bear.ts";

const OVERLAY_ON = { level: "partial", since: "2026-07-18", reason: "target rung 3→5 (+2) within 3 closes" };
const OVERLAY_OFF = { level: "off", since: null, reason: "no acceleration (+0 over 3 closes)" };
const R4_IDLE = { cash: false, phase: "idle", reason: "" };

describe("resolveCashClaim precedence (mirrors resolveCash)", () => {
  it("the chip renders NOTHING on R4 cash - R4 already speaks twice in the same footer", () => {
    // lab.js's #dfFoot on the breaker path = the `⛔ BREAKER` base string ("leaves equities
    // entirely → held ▶ Cash") + r4TailHtml + this chip. A "cash: full" chip made that TWO cash
    // sentences painted together. The chip's job is the OVERLAY's claim only.
    const r4 = { cash: true, phase: "cash", reason: "breaker: HY-OAS + VIX/VIX3M" };
    expect(cashClaimHtml(r4, OVERLAY_ON)).toBe("");
    expect(cashClaimHtml(r4, OVERLAY_OFF)).toBe("");
    expect(cashClaimHtml(r4, undefined)).toBe("");
  });

  it("R4 reentry SUPPRESSES an active overlay (the whipsaw D8 forbids), and B-22 surfaces the hold", () => {
    const reentry = { cash: false, phase: "reentry", reentryRung: 4, reason: "climbing back" };
    const claim = resolveCashClaim(reentry, OVERLAY_ON);
    expect(claim.level).toBe("off");
    expect(claim.suppressedBy).toBe("r4-reentry");
    // B-22: the hold is now VISIBLE as a muted chip, not dropped to "".
    const html = cashClaimHtml(reentry, OVERLAY_ON);
    expect(html).toContain("cash-claim-suppressed");
    expect(html).toContain("cash overlay: suppressed");
    expect(html).toContain("r4 re-entry - overlay suppressed");
  });
});

describe("cashClaimHtml render", () => {
  // Accept path: the suite goes red if the renderer no-ops.
  it("partial → the heads-up copy, plus since + reason; no posture ⇒ the degraded 'not yet sized'", () => {
    const html = cashClaimHtml(R4_IDLE, OVERLAY_ON);
    expect(html).toContain("cash overlay: partial - heads-up only, not yet sized");
    expect(html).toContain("since 2026-07-18");
    expect(html).toContain("target rung 3→5 (+2) within 3 closes");
  });

  it("an ABSENT cashOverlay (scenario/replay, or a pre-migration row) renders exactly as off", () => {
    expect(cashClaimHtml(R4_IDLE, undefined)).toBe("");
    expect(cashClaimHtml(R4_IDLE, undefined)).toBe(cashClaimHtml(R4_IDLE, OVERLAY_OFF));
    // and never a fabricated "unknown" claim
    // `nonEquityPct` is null here because no posture was supplied, NOT because the level is off —
    // the standing scalar is live in every state (resolveCash §4.3.2).
    expect(resolveCashClaim(R4_IDLE, undefined)).toEqual({
      level: "off",
      nonEquityPct: null,
      reason: null,
      suppressedBy: null,
    });
    expect(resolveCashClaim(R4_IDLE, undefined, 70).nonEquityPct).toBe(30);
  });

  it("an absent r4 (stale pre-r4 payload) still lets a live overlay speak, and degrades to off otherwise", () => {
    expect(cashClaimHtml(undefined, OVERLAY_ON)).toContain("cash-claim-partial");
    expect(cashClaimHtml(undefined, undefined)).toBe("");
  });

  it("escapes the server-supplied reason", () => {
    const html = cashClaimHtml(R4_IDLE, { level: "partial", since: null, reason: "<b>x</b>" });
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
  });
});

describe("B-22 - v-shape suppression surfaces (drift-guarded against the server marker)", () => {
  // A CALM overlay that FIRED (partial), then suppressed by a v-shaped fall via the SERVER suppressor —
  // so the FE marker literal is pinned against src/cash-overlay.ts's, not a hand copy.
  const suppressed = applyFallShape(
    {
      level: "partial",
      since: "2026-07-18",
      reason: "target rung 3→5 (+2) within 3 closes",
      nonEquityPct: null,
      recentTargetRungs: [],
    },
    "v-shaped",
    true,
  );

  it("detects the server-produced v-shape reason via the shared prefix", () => {
    expect(suppressed.level).toBe("off"); // sanity: the suppressor really fired
    expect(resolveCashClaim(R4_IDLE, suppressed).suppressedBy).toBe("v-shape");
  });

  it("renders the muted suppressed chip carrying the server reason, never beside a partial", () => {
    const html = cashClaimHtml(R4_IDLE, suppressed);
    expect(html).toContain("cash-claim-suppressed");
    expect(html).toContain("cash overlay: suppressed");
    expect(html).toContain("v-shaped fall - early overlay suppressed");
    expect(html).not.toContain("cash-claim-partial");
  });

  it("a plain quiet off (non-null reason) is NOT suppressed and still renders nothing", () => {
    // Guards the exact misfire a reason-presence fallback would have: OVERLAY_OFF carries a reason.
    const claim = resolveCashClaim(R4_IDLE, OVERLAY_OFF);
    expect(claim.reason).not.toBe(null);
    expect(claim.suppressedBy).toBe(null);
    expect(cashClaimHtml(R4_IDLE, OVERLAY_OFF)).toBe("");
  });
});

// ── W5-b Stage 5.2: the /lab wire (public/exposure-equity.js) ──────────────────────────────────
// lab.js itself is unimportable (module-level DOM/localStorage side effects), so the wire lives in
// an injectable seam and is pinned end-to-end THROUGH cashClaimHtml — the chip is the observable.
describe("Stage 5.2 wire - /api/exposure sizes the footer chip", () => {
  const okFetch = (body) => async () => ({ ok: true, json: async () => body });

  it("a successful /api/exposure SIZES the chip with 100 - equityPct", async () => {
    const pct = await loadEquityPct(okFetch({ posture: "Core", equityPct: 70 }));
    expect(pct).toBe(70);
    expect(cashClaimHtml(R4_IDLE, OVERLAY_ON, pct)).toContain("30% cash");
  });

  it("equityPct 0 is a REAL weight, not a missing one (no truthiness anywhere on the wire)", async () => {
    const pct = await loadEquityPct(okFetch({ posture: "Defensive", equityPct: 0 }));
    expect(pct).toBe(0);
    expect(cashClaimHtml(R4_IDLE, OVERLAY_ON, pct)).toContain("100% cash");
  });

  it("a FAILED or absent /api/exposure renders exactly the unsized chip - never a fabricated weight", async () => {
    const unsized = cashClaimHtml(R4_IDLE, OVERLAY_ON, null);
    expect(unsized).toContain("not yet sized");
    const cases = [
      async () => {
        throw new Error("network down");
      }, // transport failure
      // non-ok: the body carries a REAL weight, so dropping the `res.ok` guard goes red here
      async () => ({ ok: false, status: 500, json: async () => ({ posture: "Core", equityPct: 70 }) }),
      okFetch({ posture: null, equityPct: null }), // degraded 200 (pre-first-cron DB)
      okFetch({}), // field absent entirely
    ];
    for (const f of cases) {
      const pct = await loadEquityPct(f);
      expect(pct).toBe(null);
      expect(cashClaimHtml(R4_IDLE, OVERLAY_ON, pct)).toBe(unsized);
    }
  });
});

// `equityPct` is CURRENT state, not a constant table, so /lab's holder must re-issue per poll.
// Under the previous page-lifetime memo every assertion below except the dedupe one goes red.
describe("makeEquityPctLoader - a live scalar refreshes; a failure never sticks", () => {
  const ok = (equityPct) => async () => ({ ok: true, json: async () => ({ posture: "Core", equityPct }) });
  const boom = async () => {
    throw new Error("network down");
  };

  it("recovers: a first fetch that FAILS then one that succeeds sizes the chip", async () => {
    let impl = boom;
    const loader = makeEquityPctLoader((...a) => impl(...a));

    await loader.load();
    expect(loader.value).toBe(null);
    expect(cashClaimHtml(R4_IDLE, OVERLAY_ON, loader.value)).toContain("not yet sized");

    impl = ok(70);
    await loader.load();
    expect(loader.value).toBe(70);
    expect(cashClaimHtml(R4_IDLE, OVERLAY_ON, loader.value)).toContain("30% cash");
  });

  it("a later FAILURE drops back to unsized - a stale weight is as fabricated as an invented one", async () => {
    let impl = ok(70);
    const loader = makeEquityPctLoader((...a) => impl(...a));
    await loader.load();
    expect(loader.value).toBe(70);

    impl = boom;
    await loader.load();
    expect(loader.value).toBe(null);
  });

  it("the posture MOVING between polls moves the chip (no lifetime memo)", async () => {
    let impl = ok(70);
    const loader = makeEquityPctLoader((...a) => impl(...a));
    await loader.load();
    impl = ok(0);
    await loader.load();
    expect(loader.value).toBe(0); // 0 is a real weight; a memo would still read 70
    expect(cashClaimHtml(R4_IDLE, OVERLAY_ON, loader.value)).toContain("100% cash");
  });

  it("concurrent loads share ONE in-flight request (the dedupe the memo was really buying)", async () => {
    let calls = 0;
    const loader = makeEquityPctLoader(async () => {
      calls += 1;
      await Promise.resolve();
      return { ok: true, json: async () => ({ posture: "Core", equityPct: 70 }) };
    });
    await Promise.all([loader.load(), loader.load(), loader.load()]);
    expect(calls).toBe(1);
    await loader.load(); // ...but a load AFTER settle re-issues
    expect(calls).toBe(2);
  });
});
