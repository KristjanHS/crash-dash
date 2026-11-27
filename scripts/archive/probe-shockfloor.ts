/**
 * probe-shockfloor.ts — compare candidate graded unarmed-shockFloor curves.
 *
 * Control arm = the REAL computeT1Dial (today's floor). An analytical base-rung model is
 * validated against the engine on AMBER worlds (RED-count 0 ⇒ floor inert), then each
 * candidate floor is applied on that validated base. Regime/notify come from the real
 * rungCut/regimeFor/notifyRegimeFor — so only the FLOOR formula varies between arms.
 *
 * Add a candidate: one entry in FLOORS below, `(redLive, live) => rung`. Run:
 *   npx tsx scripts/probe-shockfloor.ts
 */
import { computeT1Dial } from "../src/t1dial.js";
import { rungCut, regimeFor, notifyRegimeFor, type FamilyPanel } from "../src/families.js";

const LADDER_MIN = 1;
const SHOCK_RUNG = 6;
const F = 3; // COINCIDENT.length (volatility, cross-asset, trend)

/** Candidate floors, keyed by name. `live` = live coincident count, `redLive` = RED among them. */
const FLOORS: Record<string, (redLive: number, live: number) => number> = {
  today: (r) => LADDER_MIN + (SHOCK_RUNG - LADDER_MIN) * (r / F), // linear, fixed denominator F
  B: (r) => LADDER_MIN + (SHOCK_RUNG - LADDER_MIN) * (r / F) ** 2, // convex (γ=2), fixed denominator
  C: (r, live) => (live >= 2 ? LADDER_MIN + (SHOCK_RUNG - LADDER_MIN) * (r / live) ** 2 : LADDER_MIN), // convex + live denom + ≥2 guard
};

// ── Panel builders ────────────────────────────────────────────────────────────────────
type St = "GREEN" | "AMBER" | "RED";
const p = (key: string, state: St, members: { id: string; state: St }[] = []): FamilyPanel =>
  ({
    key,
    label: "",
    state,
    live: true,
    firing: state !== "GREEN",
    contribution: state === "RED" ? 1 : state === "AMBER" ? 0.5 : 0,
    members,
  }) as unknown as FamilyPanel;
const LEADERS_GREEN = ["credit", "rates"].map((k) => p(k, "GREEN")); // live+green ⇒ unarmed

/** Unarmed world with the first `r` coincidents at `st` (trend carries a GT member so
 *  coincidentContribution resolves it; cross-asset only at r=3, matching the shock world). */
function world(r: number, st: Exclude<St, "GREEN">): FamilyPanel[] {
  const order: [string, boolean][] = [
    ["volatility", false],
    ["trend", true],
    ["cross-asset", false],
  ];
  const c = order.map(([k, isTrend], i) => {
    const s: St = i < r ? st : "GREEN";
    return isTrend ? p(k, s, [{ id: "GT", state: s }]) : p(k, s);
  });
  return [...LEADERS_GREEN, ...c];
}

// ── Rung → labels (real cut layer) ────────────────────────────────────────────────────
const TIER = { Calm: "OK", Caution: "WATCH", Stress: "WARNING", Crisis: "CRITICAL" } as const;
const label = (rung: number) =>
  `rung ${rung.toFixed(3)}  ${regimeFor(rungCut(rung))}/${TIER[notifyRegimeFor(rungCut(rung))]}`;

// ── 1. Validate the analytical base model against the real engine (AMBER ⇒ floor inert) ──
const baseAmber = [1, 1.333, 1.667, 2.5]; // 1 + 2·coincidentP (+bump r=3), capped at UNARMED_CAP=3
const baseRed = [1, 1.667, 2.333, 3.0]; // same at RED contributions
console.log("=== base-model validation vs real computeT1Dial (AMBER, floor inert) ===");
let ok = true;
for (let r = 0; r <= 3; r++) {
  const eng = r === 0 ? 1 : computeT1Dial(world(r, "AMBER")).rung;
  const pass = Math.abs(eng - baseAmber[r]!) <= 0.02;
  ok &&= pass;
  console.log(`  r=${r}  engine ${eng.toFixed(3)}  model ${baseAmber[r]!.toFixed(3)}  [${pass ? "ok" : "MISMATCH"}]`);
}
if (!ok) throw new Error("base model diverged from engine — arms not comparable, aborting");

// ── 2. All feeds live: today vs every candidate (C ≡ B here — live denom only bites when dark) ──
console.log("\n=== all feeds live (live=3) ===");
for (let r = 0; r <= 3; r++) {
  console.log(`r=${r} RED of 3 live`);
  for (const [name, floor] of Object.entries(FLOORS))
    console.log(`   ${name.padEnd(6)} ${label(Math.max(baseRed[r]!, floor(r, 3)))}`);
}

// ── 3. Divergence cases: one feed dark, then a lone live feed ──
console.log("\n=== one feed dark (live=2, both survivors RED) — the case C exists for ===");
const baseDark = 3.0; // trend+cross-asset RED ⇒ bump fires ⇒ capped at UNARMED_CAP
for (const [name, floor] of Object.entries(FLOORS))
  console.log(`   ${name.padEnd(6)} ${label(Math.max(baseDark, floor(2, 2)))}`);

// NB: base=3, NOT 1 — a lone live coincident RED drives coincidentP = 1/liveCount = 1,
// so positionP lifts the base to UNARMED_CAP (rung 3) BEFORE any floor. Verified against
// the real engine. C's inert guard therefore changes nothing here: max(3, floor) = 3 either way.
console.log("\n=== lone live feed (live=1) RED — C's ≥2-guard is a NON-EVENT (base already rung 3) ===");
const baseLone = 3.0;
for (const [name, floor] of Object.entries(FLOORS))
  console.log(`   ${name.padEnd(6)} ${label(Math.max(baseLone, floor(1, 1)))}`);
