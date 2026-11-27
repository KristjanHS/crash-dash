# Dial logic explainer — 4 core calculations

Concise, as-built (verified against code 2026-07-22). Each section: short text + one diagram.
Source symbols: `src/alert-band.ts`, `src/t1dial.ts`, `src/families.ts`, `src/danger-engine.ts`.

Shared primitive — **`rung`** (a continuous 1–9 position) drives everything below.
`dangerScore = rungCut(rung) = (rung − 1) / 8 ∈ [0,1]`. `targetRung = 1 + round(dangerScore·8) ≈ round(rung)`.

---

## 1. Alert band (the pushed OK / WATCH / WARNING / CRITICAL)

The band is the **max of two lifts** over the dial: the (lag-held) dial band, and the highest of 5
independent *escalator floors*. It can only ever LIFT — an escalator never lowers the dial. A `verdictHold`
guard can hold yesterday's band while a feed is stale. `computeAlertBandDetail` (`alert-band.ts`).

```mermaid
flowchart TD
  NR[dial.notifyRegime] --> RB["regimeToBand()<br/>Calm→OK · Caution→WATCH<br/>Stress→WARNING · Crisis→CRITICAL"]
  RB --> LAG["deEscalationLag()<br/>= maxBand(dialBand, last N bands)<br/>up now · down only after N holds"]
  subgraph FLOORS["escalatorFloor = max of 5"]
    C["credit: F1/F2 RED → FIRED/UNFIRED floor"]
    R4["r4: cash phase → CRITICAL"]
    GEO["geo: flags≥2→WARNING · ≥1→WATCH"]
    RATE["rate: rateBase≥floor → WATCH"]
    EW["ew: fastBreakEW → WATCH (hard-capped)"]
  end
  LAG --> MAX["band = maxBand(laggedBand, floor)"]
  FLOORS --> MAX
  MAX --> STALE{"stale feed &<br/>prior band higher?"}
  STALE -- yes --> HOLD["band = verdict-hold"]
  STALE -- no --> OUT["ALERT BAND + reason<br/>(floor:src · lag-hold · regime · verdict-hold · no-dial)"]
  HOLD --> OUT
```

---

## 2. Regime (Calm / Caution / Stress / Crisis)

A pure cut-table over `dangerScore`, then a **Crisis gate**. Two axes share the *same code* but different
cuts: `regime` (display, `DIAL_REGIME_CUTS`) and `notifyRegime` (notify, `NOTIFY_REGIME_CUTS = rungCut(3/5/7)
= 0.25 / 0.50 / 0.75`). The gate demotes a scored Crisis to Stress unless credit **or** volatility is
actually firing — so credit-blind deep rungs can't claim the top label. `regimeFor`/`applyCrisisGate`.

```mermaid
flowchart TD
  DS[dangerScore ∈ 0..1] --> CUT{regimeForCuts}
  CUT -->|"< caution"| CALM[Calm]
  CUT -->|"< stress"| CAUT[Caution]
  CUT -->|"< crisis"| STR[Stress]
  CUT -->|"≥ crisis"| CRI[Crisis]
  CRI --> GATE{"credit OR volatility firing?"}
  GATE -- no --> DEMOTE[demote → Stress]
  GATE -- yes --> KEEP[Crisis]
  CALM --> R[regime / notifyRegime]
  CAUT --> R
  STR --> R
  DEMOTE --> R
  KEEP --> R
```

---

## 3. Dial band `[lo, hi]` (min & max rung)

`hi` is the depth-selected **target rung**; `lo` widens *downward* only by how much the leaders
**disagree** (`leaderSplit`, Gini/2). Unanimous leaders → zero width → `lo = hi` (a point). The rung itself
is an ARM floor + within-band position, clamped by the **two-key caps** (unfired ≤ 5, unarmed ≤ 3; rungs
7–9 need both keys) and a graded unarmed `shockFloor`. `computeT1Dial` (`t1dial.ts`). Constants:
`POSITION_SPAN=2`, `LADDER_MIN=1`, `LADDER_MAX=9`.

```mermaid
flowchart TD
  LO["armFloor (leading breadth)"] --> RUNG["rung = armFloor + POSITION_SPAN·positionP + systemicBump"]
  PP["positionRaw = max(leadingP, coincidentP, techConfirmerP)<br/>positionP = positionRaw (identity — mEff retired, ruled O2 2026-08-11)"] --> RUNG
  RUNG --> CAPS["two-key caps: unfired≤5 · unarmed≤3"]
  CAPS --> SHOCK["max(rung, shockFloor)  then  min(rung, 9)"]
  SHOCK --> TR["targetRung = 1 + round(rungCut(rung)·8)"]
  TR --> HI["hi = targetRung"]
  SPLIT["leaderSplit = leader disagreement (0=unanimous)"] --> W["width = round(POSITION_SPAN · split)"]
  HI --> LOOUT["lo = max(LADDER_MIN, hi − width)"]
  W --> LOOUT
  HI --> BAND["band = { lo, hi }"]
  LOOUT --> BAND
```

---

## 4. Held leg (which sleeve to hold)

Filter legs to those whose **risk rank** sits inside the dial band, then pick the **most-aggressive**
(lowest risk rank) leg whose danger is within a directional `deadband` of the calmest one. Each leg's
danger is a worst-of `max(EARLY-WARN, STRESS-NOW, gatedTrend)`. The deadband is **asymmetric**: de-risk
instantly (deadband 0 → strict calmest), but resist re-risking to a more-defensive leg on a sub-band gap.
`computeField` (`danger-engine.ts`). `DERISK_DEADBAND = 0`; `RERISK_DEADBAND = DANGER_CUTS.amber / 2`
— **derived, never a literal**, so read it off `danger-engine.ts` (or `/api/danger-model`'s
`reriskDeadband`) rather than from this sentence. At the cuts shipped on 2026-08-07 that is `0.1206`;
it was `DANGER_CUTS.amber` until that date and was HALVED there as the counterweight to the retired timing gates.

The two re-risk TIMING gates are retired (same date, same plan): `RERISK_CONFIRM = 1` and
`RERISK_DWELL_DAYS = 0`, so a re-risk commits on the first close, exactly like a de-risk. The only
surviving re-risk brake besides this deadband is the trend veto (a confirmed-RED `uT` member).

```mermaid
flowchart TD
  LEGS["per-leg danger = max(EW, SN, gatedTrend)"] --> INB["inBand = legs with risk ∈ [band.lo, band.hi]"]
  INB --> EMPTY{"inBand empty?"}
  EMPTY -- yes --> NULL["held = null"]
  EMPTY -- no --> DIR{"band.hi > prevTarget?<br/>(cold-start ⇒ yes)"}
  DIR -- "rising (de-risk)" --> DB0["deadband = 0"]
  DIR -- "falling/stable" --> DBR["deadband = 0.129"]
  DB0 --> CAND["candidates = inBand with danger ≤ min(danger) + deadband"]
  DBR --> CAND
  CAND --> PICK["held = candidate with LOWEST risk rank<br/>(most aggressive)"]
```

---

### Cheat-sheet: how they chain

`rung → dangerScore → { regime (§2), band[lo,hi] (§3) }`; `band` filters legs → `held` (§4);
`notifyRegime → dialBand`, lifted by escalator floors → `ALERT BAND` (§1).
The alert band is what gets **pushed**; the held leg is what gets **persisted + shown** as the rotation pick.
