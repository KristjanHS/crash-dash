<!-- docs-bloat-gate-override: canonical design doc, replaces v3 in docs/ root; §15 cites research sources -->
# Early-Warning Dashboard — Design Document (v4)

> **This doc = the canonical ANCHOR reference** — the numbered sections the code cites as `v4 §X.Y`.
> It is **not** wholly as-built: the live alert derivation is **§6.10 + `src/alert-band.ts`**, and the
> original composite-ladder spec (**§6.2, §6.3, §6.4, §6.4.1, §6.4.2, §6.5.1**) is **RETIRED 2026-07-15**
> and preserved verbatim in **Appendix A** solely so those anchors keep resolving.
> Forward changes live in `docs/backlog.md` (§OWED[USER], §In-flight arcs, §Plan-doc menu); the
> superseded crash-logic improvement plan + its evidence base are retired. Coming changes are flagged inline as a terse
> **⟳ see plan §X** pointer — the as-built description stays (the code still implements it).
> **Section numbers (§4, §5, §6.x, §9, §11, §15) are stable anchors the code references — never renumbered.**
> **Project refocused 2026-07-11** — the mission is now signal-driven rotation guidance
> (forming); this crash-detection engine becomes the
> rotation ladder's danger/band-selection axis. The as-built Goal/Non-goal below stay accurate — the code
> still implements them.

**Goal:** Get an *automated, unemotional notification* when the probability of a US big-tech
drawdown has risen materially versus the current state — early enough to make a considered decision
about a pension heavily exposed to the same Mag-7 names (S&P 500 fund + MSCI ACWI, which overlap).

**Non-goal:** Not a crash predictor, and it does not trade. It's a probability gauge whose value is
consistency — same rules every day, no panic. It will throw false alarms and can miss a crash with no
detectable tell.

**Output mode:** Notify-only, to a free push channel. The sell/hedge/hold decision stays with you.
*(Not financial advice; these indicators have no proven predictive reliability — an alert means
"look closer," never "act now.")*

**Calibration:** Balanced — confirmation buffers and moderate thresholds to limit alert fatigue
without losing all lead time.

---

## 1. Approach (as built on Track A)

Three-layer hybrid: **reuse** free data (FRED macro/credit/rates, daily price/vol closes) and a **free**
push service (ntfy); **build** only the orchestration — scoring, confirmation, the escalation ladder,
de-duping. The data and push are commodity and free; what no product fuses for you is
**financing-fragility + rate-shock + geopolitical, focused on big tech** — the irreducible custom part.

The project runs on **Track A** (self-hosted Node/TypeScript script). The buy-vs-build / A-B-C track
choice is *not* on the critical path: every indicator in the custom residue must be built under any
track, so continuing Track A wastes nothing.

---

## 4. Indicator set

### 4.0 What actually leads — the evidence base

The single most important research finding: **only two indicator classes have a genuine *leading*
track record for US equity drawdowns** — credit spreads and the yield-curve term spread. Most popular
"crash indicators" are *coincident* (they move with the selloff) or slow regime flags. Designing
around this is what separates a useful gauge from theatre.

| Class | Verdict | Role in v4 |
|---|---|---|
| **HY / IG credit spreads** | **Leading** equity stress, ~3–9mo at monthly freq; coincident on exogenous shocks. Best near-term financing tell. | Core financing channel (F1, F2). Track *widening-from-trough*, not just level. |
| **Yield-curve term spread (10y–3m)** | **Leading** — best-validated multi-month macro signal (inverts before recessions). But it leads *recessions*, not equity *peaks* (the S&P often rises ~12–18mo post-inversion). | Leading-rate signal (R1). Inversion is a **regime watch** → caps rate-alone at WARNING (§6.4). |
| **Yield velocity / rate shock** | The *fast* path — a rate shock can crater equities with no credit tell. | Rate channel (R2/R3). Can fire on its own (§6.4). |
| **VIX / MOVE spikes** | **Coincident**, not leading — "fear gauge, not forecaster." The one *leading* vol signal is sustained **low** vol (Minsky fragility), not spikes. | Coincident confirmation / "fuse is lit" modifier only (R5/R6) — never a standalone trigger. |
| **CAPE / valuation** | Predicts 10-yr returns, ~zero short-horizon (above-mean since ~1991). | Context only — severity weight, never fires alone (F7). |
| **Breadth at tops** | Mostly coincident; narrow markets were often *higher* 3–6mo later. Real signal is at *bottoms*. | Context only (F5). |
| **M2 / money supply, Mag-7 concentration %** | Coincident-to-lagging / amplifier, ~zero timing power. | **Excluded** as triggers. |

Two design rules fall out of the literature:

- **Channel diversity beats indicator count.** Central-bank early-warning research converged on
  **3–5 *weakly-correlated* indicators across *different channels*** (credit, rates, vol, valuation).
  Past that, false alarms rise faster than signal. The goal is covering the credit / rate / geo
  channels, then stopping — not "more F-indicators."
- **Combine with simple, transparent weights.** Equal / inverse-volatility weighting beats fitted
  "optimal" weights out-of-sample (the forecast-combination puzzle). Do **not** optimize thresholds
  on history — in-sample winners almost uniformly fail out-of-sample (Goyal–Welch).

> *⟳ The plan re-derives the signal set from what leads: adds **EBP**, **MOVE**, **VIX term-structure**
> to the fast track, and a separate **slow bubble-state track** (price-acceleration, put/call,
> margin-debt, IPO heat, breadth) on its own notification tier — off the fast ladder, not against the
> 3–5-channel cap. See plan §1, §3.*

Each indicator resolves to **Green (0) / Amber (1) / Red (2)**. **Source:** `API` = auto-pulled free;
`Manual` = a flag you flip in config; `Context` = shown in payload, never fires alone.

| ID | Indicator | Source | Free ref | Amber | Red |
|----|-----------|--------|----------|-------|-----|
| **F1** | **HY credit spread** (leads equity) | API | FRED `BAMLH0A0HYM2` | > 4.50% **or** +1.00%/20d | > 6.00% **or** +1.75%/20d |
| **F2** | **IG credit spread** | API | FRED `BAMLC0A0CM` | > 1.50% **or** +0.40%/20d | > 2.00% **or** +0.70%/20d |
| F4 | Semis / Nvidia momentum — **Context** | API | yfinance `SMH`,`NVDA` | SMH < MA200 & −15%/6mo | −25% & NVDA < MA200 |
| F5 | Leadership breadth — **Context** | API | yfinance `QQQ`÷`QQQE` | ratio 12-mo high & rising | — |
| F7 | Valuation air (CAPE) — **Context** | API | Shiller CAPE | > 37 | — |

*F4 is **CONTEXT** (Phase-2 C5, 2026-06-28): a −15/−25%-below-MA200 semis drawdown is coincident, not
leading; the harness found no leading deceleration leg, so F4 was demoted whole, not split.*

> *⟳ Phase 2 replaces the fixed absolute level cuts (F1 4.50/6.00, F2 1.50/2.00, R5 25/35) with a
> long-window / EVT level estimate + fast change z-score, point-in-time (absolutes kept only as a coarse
> backstop; trailing-percentile idea dropped). See plan Phase 2 / §6.9 below.*

**AI-specific fragility — partly-manual "fragility flags" tier** (was F3/F6/F8 in v3). Research verdict
(§15): free *daily* AI signals add little over the generic credit+semis core.

| ID | Indicator | Source | Why it's a flag, not a daily gauge |
|----|-----------|--------|-------------------------------------|
| A1 | Leveraged-node single-name **credit** (Oracle CDS, neocloud bond spreads) | Manual/💲 | The *only* genuinely additive AI signal — broad HY OAS structurally misses it (Oracle CDS tripled late-2025 while HY OAS sat near tights). But **no clean free daily feed.** |
| A2 | Hyperscaler capex guidance | Manual | Quarterly earnings calls; the loudest fundamental tell, but slow. |
| A3 | GPU 1-yr contract rental rate | Manual/💲 | SemiAnalysis (paid); weekly/monthly. |

The dropped CRWV/ORCL/NBIS equity proxy co-moves with semis momentum (F4) and is pumped by
circular-deal headlines — noisy duplication, not signal. Unmaintained A1–A3 flags read **Green**
(degrade gracefully); they're *regime context*, not the daily spine.

> *⟳ Plan detects AI-credit divergence **structurally** — the FRED OAS/EBP channel staying tight while
> the slow bubble composite is ELEVATED — not via a bespoke price proxy. See plan §3, Q6.*

### Family B — Rate channel (leading + shock)

| ID | Indicator | Source | Free ref | Amber | Red | Role |
|----|-----------|--------|----------|-------|-----|------|
| **R1** | **Yield-curve term spread (10y–3m)** | API | FRED `T10Y3M` | < 0.50 (flattening) | **< 0 (inverted)** | **Leading** — can trigger (capped) |
| **R2** | 10y yield velocity | API | FRED `DGS10` | +0.40/20d | +0.70/20d | Rate shock — can trigger |
| **R3** | 2y yield velocity (Fed-path) | API | FRED `DGS2` | +0.35/20d | +0.60/20d | Rate shock — can trigger |
| R4 | 10y real-yield velocity *(optional)* | API | FRED `DFII10` | +0.18/20d | +0.25/20d *(retuned 2026-07-23 from +0.30/+0.50, `registry.ts`)* | Rate shock — can trigger |
| **R5** | Equity vol (VIX) | API | FRED `VIXCLS` | > 20 | > 30 *(C4 cutpoint pass, `registry.ts`)* | **Coincident** — modifier only |
| R6 | Bond-market vol (MOVE) | API | daily closes (keyless) | > 120 | > 150 | **Coincident** confirmer — modifier only (bands = starting prior, pending calibration) |
| R7 | Bull steepener (2y-led) | derived | R1 `T10Y3M` + R3 `DGS2` (no new feed) | Δspread>0 & 2y/steepening in AMBER rolling-126 tail | either leg in RED rolling-126 tail *(tail probabilities on `R7_DESCRIPTOR`)* | **Rate** confirmer (T2.1) — sharpens only, can't move the ladder alone |

> **Implementation note — R1 is inverted-polarity.** For F1/F2/R2–R4, *higher = worse*. For the term
> spread, *lower/negative = worse*. The scoring function must flip the comparison for R1 (or store a
> per-indicator `direction`). Easy to get wrong — stated explicitly.

### Family C — Geopolitical (manual flags; can raise WATCH alone)

Research is thin here — geo is idiosyncratic and un-backtestable. Best implemented as **cheap manual
flags**, not chased price feeds.

| ID | Indicator | Source | Amber | Red |
|----|-----------|--------|-------|-----|
| G1 | Oil shock (Hormuz) | API *(opt.)* | FRED `DCOILWTICO` +20%/1mo | +40%/1mo **or** Hormuz flag |
| **G4** | Curated event watchlist | **Manual** | one flag | two+ flags |
| CG | Copper/gold ratio (**Context** confirmer, T2.2) | API | copper ÷ gold futures daily closes (keyless) | ratio ≤0%/20d | −2%/20d |

**G4 flags:** Taiwan-Strait military action; US–China chip-export escalation; major-power conflict
spillover; US debt-ceiling/fiscal shock; coordinated sovereign-fund AI de-risking.

*CG is **CONTEXT** + `confirmer` (T2.2, 2026-07-04), NOT a GEO auto-flag: CONTEXT is excluded from the
base roll-up by construction, so CG can never solo-trigger. It only AMPLIFIES an already-elevated GEO
signal (pairing with its commodity sibling oil G1), and GEO is `crit: null` so it never reaches CRITICAL.
A falling copper/gold ratio (industrial demand weakening vs the safe-haven gold bid) is the risk-off
tell. Bands are an **UNVALIDATED starting prior — backtest-gated (Phase-2)**, pending harness calibration.*

**Slow-track leg — duration-of-calm (T3.2, 2026-07-04).** A new **observability leg** of the slow
complacency signal (channel SLOW, alongside price-acceleration / complacency-vix / complacency-high) —
`scoreDurationOfCalm` in `slow.ts`. It measures the run-length that VIX has stayed continuously **at or
below its own median** (`SLOW_CALM_PCTILE = 0.5`), operationalizing the §4.0 evidence-base finding that the
one *leading* vol signal is sustained **low** vol (Minsky fragility), not spikes — persistence, not depth.
It confirms **Amber** (`fragileCalm`) once the calm run reaches `SLOW_CALM_RUN_MIN = 63` trading days
(~3 months). SLOW band math is unchanged (stays 2-active); the leg is off the fast ladder **except** one
narrow floor — it can raise the FAST verdict **OK→WATCH only** (never higher), the T3.2 G-b gate (§6.4.2).
`SLOW_CALM_PCTILE` / `SLOW_CALM_RUN_MIN` are an **UNVALIDATED starting prior — backtest-gated (Phase-2)**,
pending harness calibration.

**Shipped since ~2026-07-12 (not tabled here):** F3, F6/F8/F13, F9–F12 (EM), F14–F16 (ex-US),
EURC/EHY/FXH/GT/GB/DISP — full config in `src/registry.ts`.

---

## 5. Build vs reuse

FRED-series indicators (F1/F2/R1–R4) and the manual AI/geo flags (A1–A3/G4) are the custom residue —
reuse the free data, custom-score it. Generic price/vol/macro legs (F4/F5/F7/R5/R6/G1) are what reused
engines (§8) cover. The composite ladder + confirmation is the build. *(Full Track-A/C map: git history.)*

---

## 6. The composite ladder spec

### 6.1 Per-indicator confirmation (balanced)
Hold the threshold **2 consecutive daily closes** before the state counts (tunable: 1 = more
sensitive, 3 = more confirmed). This is the literature's "persistence filter" — the single most
effective noise reducer, because real vulnerability builds slowly while noise mean-reverts.
Implemented as a fold over full FRED history (`deriveConfirmedState`), so no stored state is needed
for confirmation itself.

### 6.10 As-built danger/rotation layer (live since 2026-07-15)
The live alert derivation: the family panel (`families.ts`) feeds the **T1 dial**, whose regime
(Calm/Caution/Stress/Crisis ↔ OK/WATCH/WARNING/CRITICAL) sets the band via `computeAlertBand` (§6.6),
and a **9-leg rotation field** picks which risk rung to hold — `heldSleeve` — with anti-whipsaw hold
logic (`danger-engine.ts`, `rotation-commit.ts`, `r4.ts` cash-breaker).

### 6.5 Notification discipline (kills alert fatigue)
- Notify only on an **upward** level change; no repeats at the same level. De-escalation is **gated**,
  not merely silent. The gate as originally specified — D1, hold while the coincident channel is Red —
  is RETIRED (§6.5.1, Appendix A); the live gate is `alert-band.ts`'s `deEscalationLag` sliding-window
  max (`DE_ESCALATION_N = 2`), which likewise holds the *persisted* level, not just the notification.
- Level persists 2 closes before notifying up (anti-flap).
- Delivery priority scales by tier (WATCH near-silent; CRITICAL high-priority push).
- Payload lists which indicators are Amber/Red, live values + % moves, and whether a modifier is active.
  When a hold is active it also emits a `Held at <level> (raw <rawLevel>) …` line so a propped-up badge
  over an all-green driver list doesn't read as a bug (I2).
- **Heartbeat:** any feed stale > 3 days → dashboard-health alert.

#### 6.5.2 D2 — Kiley overheat crit-unlock (retired 2026-07-02)
An *overheated-regime AND-gate* that unlocked RATE→CRITICAL — the only path off the §6.4 WARNING cap —
when a confirmed Kiley overheating regime (K1: CPI-sticky ∧ unemployment-low) was Red. It shipped in
`ladder.ts` but was never in this spec. A Stage-0 backtest look falsified it: the crit bar (RATE ≥ 6,
eff-5 under a VIX-Red modifier) was **unreachable** at the two precedents it existed to catch — RATE
topped out at 4 / 2 / 3 in 2000 / 2006 / 2007 vs the velocity-driven 6–7 of the 2022 hiking cycle — and
the lone historical fire (2022-09-19) landed ~10mo *into* the decline, near the bottom, on a −10.7%
forward drawdown: late and shallow, not a crash-from-the-top catch. **Removed from the ladder; RATE is
now unconditionally WARNING-capped. K1 is retired to replay-audit-only** (kept in the registry for the
backtest overlay, out of the live product). Evidence: `scripts/backtest/report.md`.

### 6.6 Run loop (pseudocode)
```
for each indicator: value = fetch(source); state = score(value, thresholds, history)
dial = computeT1Dial(GLOBAL_FAMILIES panel)                 # family panel → graded dial/regime
band = computeAlertBand(dial, readings, geoFlags, r4Phase, recentDialBands)
held = computeField(...).held                               # 9-leg danger field picks heldSleeve
persist(readings, band, heldSleeve)   # Supabase (store.ts) — notify-on-change + heartbeat
decideNotify(band, last) → ntfy_publish(payload)            # notify on UPWARD change only
heartbeat_check()
```
*(run.ts — score → dial → band → held → persist → notify.)*

### 6.7 Persistence & notify-on-change (the highest-value mechanics layer)
The early-warning-systems literature and SRE alerting practice agree: **a stateless "report current
level every run" system is the noisiest possible design and trains you to ignore it.** State unlocks
the three highest-value mechanics — all impossible without memory of prior readings:
1. **Notify-on-change** — push only when the *alert level* changes (needs the previous level).
2. **Hysteresis** (§6.8) — needs to know whether you're currently *in* an alert state.
3. **Heartbeat** — needs the last-seen timestamp per feed.

Implementation: **Supabase** behind the `store.ts` seam (`getStore()` → Supabase / in-memory).
Append-only `readings` (`run_at, indicator, value, delta20, rawState, state` — never overwritten, so it
accumulates a true **as-of-vintage** history) plus an `alert_log`. Schema lives in
`supabase/migrations/` (single source).

### 6.8 Threshold hysteresis
Use a **higher level to *enter*** an alert state and a **lower level to *exit***, so a reading hovering
on a boundary doesn't chatter on/off between runs. Borrowed from control systems and centile-based
clinical early-warning scores. Complements the 2-close buffer (which filters *time*; hysteresis filters
*level*).

### 6.9 Regime-relative thresholds & recalibration

> *⟳ This is the plan's central thrust. Phase 1 builds a replayable **backtest/calibration harness**
> (base rates, lead-time, ROC with block-bootstrap CIs, alert-to-actionable ratio) as the measuring
> stick; Phase 2 then moves thresholds to a **long-window / EVT peaks-over-threshold level + fast change
> z-score**, point-in-time (trailing-3yr percentile explicitly dropped — ≤3yr OAS is ~4 effective obs).
> With only ~5–6 credit-stress episodes ever, Phase 2 runs as **falsification against a pre-registered
> candidate set, not optimization**. See plan Phase 1 + Phase 2.*

The audit/recalibration *principles* hold regardless:

- **Prefer percentile / z-score / gap-from-trend over fixed absolute levels.** A 5% HY-OAS means
  different things in 2008 vs 2021; the credit-gap *gap from trend* normalizes across regimes. Keep the
  **level *and* velocity** pairing (slow stock + fast flow).
- **Recalibrate slowly and out-of-sample.** Never retune reactively after a near-miss — that overfits.
- **Audit your own alert log.** SRE benchmark: aim 30–50% alert-to-actionable; < 20% = a noise problem
  → retune or drop the offending gauge.
- **Mind FRED data revisions** if you backtest — use the value knowable *at the time* (look-ahead bias).
  The keyless CSV returns revised history, not real-time vintages.

v4 ships fixed thresholds first (simple, transparent); the regime-relative replacement is the plan's
Phase 1→2 work (EVT / long-window, **not** rolling percentiles).

---

## 7. Notification — reuse a free service
1. **ntfy.sh** (in use) — free, open-source, simplest Android push. Topic `<ntfy-topic>`; publish
   with a `POST`. No account; self-hostable later. 2. **Telegram bot** — richer formatting. 3. **Email
   (`smtplib`)** — daily-digest fallback. The notifier stays behind one function (`pushNtfy`) so swapping
   is a single edit (§9). Secrets live in `.env` / OS keychain — never in git.

---

## 8. Reference engines
Institutional checklists — **Citi Bear-Market Checklist** (18-indicator flag-count), **Goldman BMRI**
(5 equal-weighted factors), **Conference Board LEI** — all percentile-rank indicators vs their own
history and equal/volatility-weight them, proving the pattern is industry-standard. All have documented
*failure modes* (Goldman stuck >70% through 2018–21 on low yields; LEI broke at the 2022–23 regime shift
and retro-changed its rule). Lesson reinforced: transparent weights, slow recalibration, no fitted
optimization (§6.9). Forkable/subscription options (TradingView Pine crash-filters, RecessionAlert,
MacroMicro) exist but aren't on the critical path for Track A.

---

## 9. Pre-mortem — failure modes & mitigations

| Failure mode | Mitigation |
|--------------|------------|
| Crash with **no credit tell** (rate/geo path) | Rate channel (R1–R3) + geo flags fire on their own (§6.4), not just as modifiers |
| **Alert fatigue** → you ignore it | Balanced thresholds + 2-close confirmation + hysteresis + **notify-on-upgrade-only** (§6.5–6.8) + notify-only is cheap to ignore |
| **Silent data-feed failure** | Heartbeat staleness check (needs state, §6.7) |
| **Coincident proxies mistaken for leading** | VIX/MOVE confined to the modifier role (§6.2); only credit spreads + term spread treated as leading (§4.0) |
| **Too many indicators → more noise** | Cap at 3–5 weakly-correlated channels (§4.0); resist proliferation |
| **Thresholds overfit / drift** | Velocity thresholds resist regime shifts; move to percentile/z-score (§6.9); recalibrate slowly, never reactively |
| **Free service rate-limits/disappears** (yfinance, ntfy) | Abstract feed + notifier behind one function each (`fetchSeries`, `pushNtfy`); fallbacks; ntfy self-hostable |
| **Manual flags go stale** | Calendar reminder each earnings season; unmaintained flags read Green (degrades gracefully) |
| **AI-specific signal is duplicative/noisy** | AI equity names dropped; AI layer is partly-manual credit/capex flags (§4 Family A) |
| **You miss the best AI signal** (single-name CDS paywalled) | Documented upgrade: a CDS/credit feed for A1; until then it's a manual flag |

**Most fragile thresholds:** F1 absolute HY-OAS levels and R1's inversion point. Repeated false WATCH
→ loosen first; a drawdown with no alert → tighten the relevant velocity trigger.

---

## 10. Review cadence & success test
- **Quarterly recalibration**, just after big-tech earnings (so the AI capex flag A2 is fresh).
- **Annual** review of the indicator set and of whether a reused engine still earns its keep.
- **Event-driven post-mortem:** every false positive / false negative → diagnose which indicator
  failed, adjust (slowly — §6.9).
- **Success test (be honest):** over a year, did WARNING alerts precede real drawdowns more than
  chance, with usable lead time? If not, it's theatre — revisit or retire.

---

## 11. Current build state & roadmap

**Stack / seams / price feeds** → see `.claude/rules/dev-workflow.md`.

**Built (shipped):** F1/F2 credit + R1/R2/R3/R4/R5 rate + G1 oil & manual geo → 2-close confirmation
fold → the **T1 dial + `computeAlertBand`** danger layer (§6.10) → **Supabase** persistence (as-of vintage) →
notify-on-change + heartbeat → ntfy push; read API (`api/*`, `openapi.yaml`) + Vercel cron. R6 (MOVE) is
LIVE on the keyless price feed as a coincident confirmer (T1.1); F7 (CAPE) remains a reserved seam, default GREEN/context.

**Retired (shipped once, no longer live):** the per-channel roll-up (§6.2), the "fuse is lit" sensitivity
modifier (§6.3), the per-channel/cross-channel alert ladder (§6.4) with its T2.2 and T3.2 gates (§6.4.1,
§6.4.2), and D1 asymmetric de-escalation (§6.5.1) — all replaced 2026-07-15 by §6.10 and frozen in
`scripts/backtest/legacy-ladder.ts`. Text preserved in Appendix A.

The v3→v4→env-parity→GEO roadmap (rate channel, mechanics+persistence, geo flags) is **done**.

> *⟳ Forward work → `docs/backlog.md` §Plan-doc menu.* The superseded crash-logic plan — Phase 2
> (EVT/long-window thresholds, EBP/MOVE, PC1 financing, T10Y2Y) and Phase 3 (slow bubble-state track) — is archived.
> The 3–5-channel cap (§4.0) means the *fast-ladder* set is roughly complete (credit + rate + geo); the
> slow bubble track is a separate tier on top, not a breach of the cap.

---

## 12. Out of scope
Auto-trading; position sizing; the sell/hedge/hold decision (yours); tax; intraday signals; options
strategies; portfolio-overlap analysis (separate task — quantifying ACWI vs S&P 500 duplication, which
decides how much a CRITICAL alert should even move you).

---

## 13. Open questions
1. Track **A** (current) vs B/C — *not blocking*; revisit only if Track-A upkeep outweighs its value.
2. Maintain the manual flags (A1–A3 / G4), or ship fully automated and read them Green (weaker, zero upkeep)?
3. Notification: stay on ntfy, or add Telegram for richer payloads?
4. Want the **portfolio-overlap** companion (§12) so a CRITICAL alert maps to your *actual* exposure?

---

## 14. Glossary

→ see `docs/glossary.md`.

---

## 15. Sources (research underpinning v4)

**What leads (indicators):**
- Gilchrist & Zakrajšek, *Credit Spreads and Business Cycle Fluctuations* (the Excess Bond Premium) —
  nber.org/papers/w17021; Fed FEDS Note on EBP & recession risk (2016).
- NY Fed, *Predicting Recession Probabilities Using the Yield-Curve Slope* (10y–3m calibration, 2018).
- Danielsson, Valenzuela & Zer, *Learning from History: Volatility and Financial Crises* (low vol →
  fragility) — Fed FEDS 2016-093 / RFS 2018.
- Asness (AQR), *Market Timing: Sin a Little* / *An Old Friend: The Stock Market's Shiller P/E*
  (CAPE's near-zero short-horizon power).
- Stock & Watson (forecast combination beats single indicators) — NBER w6702; Goyal–Welch, RFS 2008
  (in-sample winners fail out-of-sample); Clemen 1989 (combination puzzle).

**System design (EWS + alerting):**
- Kaminsky-Lizondo-Reinhart signals approach (noise-to-signal ratio) — bis.org/publ/confer08m.pdf;
  BIS Quarterly, *EWIs of banking crises: expanding the family* (bis.org/publ/qtrpdf/r_qt1803e.htm).
- Drehmann & Juselius, BIS WP421 (evaluating EWIs); Fed IFDP 1307, *Optimizing Credit Gaps*
  (stability-preferring thresholds); IMF WP/04/52 (spreads often *don't* lead — backward-looking).
- Greenwood, Hanson & Shleifer, *Predictable Financial Crises* (two complementary signals suffice).
- Google SRE, *Monitoring Distributed Systems* ("every page actionable"); incident.io, *SRE alerting
  best practices* (notify-on-change, debounce, 30–50% alert-to-actionable benchmark).

**AI / big-tech fragility (2025–2026):**
- Bloomberg, *AI circular deals* graphic; Bloomberg, *Oracle default swaps jump* (29-Oct-2025) — CDS
  tripled to ~128–139bps while broad HY OAS sat near tights.
- io-fund, *Nvidia/CoreWeave/Nebius circular financing*; MUFG, *Financing the AI Supercycle*
  (19-Dec-2025); Bain via StrongMocha, *the $725B question* (capex/revenue gap).
- SemiAnalysis GPU rental index; SiliconANGLE, *Resetting GPU depreciation* (22-Nov-2025); ECB FSR
  (May-2026) on debt-financed AI capex.
- *Verdict:* the AI layer is additive only via single-name **credit** (no free daily feed); AI
  **equity** names duplicate semis momentum and are pumped by deal sentiment.

---

## Appendix A — RETIRED spec (stable anchors)

These sections were retired on 2026-07-15 and are kept **only** because 43 code comments cite them by
number as `v4 §X.Y`; deleting or renumbering them would dangle those cites. Nothing below describes live
behaviour — the live derivation is **§6.10** plus `src/alert-band.ts` (with the frozen original in
`scripts/backtest/legacy-ladder.ts`). Read them as history, and never as a description of what the code
does today.

### 6.2 Channel roll-ups — separate scores per channel
> **RETIRED 2026-07-15** → frozen in `scripts/backtest/legacy-ladder.ts`; live derivation = `alert-band.ts` (T1 dial band + escalator floors; note: a single F1 **or** F2 confirmed RED → CRITICAL — more aggressive than the old cross-channel rule).

Each channel is scored **independently** so a non-financing channel can raise an alert on its own:

- **`FIN_score`** = Σ confirmed states over the **financing** family (F1, F2; Red=2, Amber=1).
  *F4/F5/F7 excluded — context only.* (Code: `finScore()`.)
- **`RATE_score`** = Σ confirmed states over the **leading-rate** indicators (R1 term spread +
  R2/R3/R4 velocity), **plus the R7 bull-steepener confirmer credited only once the R1–R4 base is
  already elevated** (a confirmer-gate mirroring FIN/EBP — R7 sharpens severity but can't move the
  ladder alone; excluded from the cross-channel red-count). **VIX/MOVE excluded** — coincident, not leading.
  The channel is **unconditionally capped at WARNING** — there is no RATE→CRITICAL path (an overheat
  crit-unlock, D2, was tried and retired; §6.5.2).
- **`GEO_score`** = active-flag count over Family C (0 / 1 / 2+).
- **`COINCIDENT_flag`** = max confirmed state of the coincident gauges (R5 VIX, R6 MOVE). The "fuse is
  lit" sensitivity gauge — it *escalates* but never triggers alone.

> *⟳ Phase 2 reworks the financing channel: aggregate HY+IG (ρ≈0.9, one latent factor) via **PC1 of
> standardized [HY, IG]** instead of summing state-ranks, and wire in **EBP** — so `CHANNEL_CUTS.FIN`
> must be re-derived. See plan §3, Q4.*

### 6.3 Sensitivity modifier ("fuse is lit")
> **RETIRED 2026-07-15** — the "fuse is lit" gate went with `computeVerdict` (frozen in `scripts/backtest/legacy-ladder.ts`).

If `COINCIDENT_flag == Red`, subtract 1 from each ladder threshold below (the move is already underway
→ lower the bar to escalate). The coincident vol gauges (VIX/MOVE) play the modifier role the research
assigns them; rate and geo trigger directly instead.

### 6.4 Alert ladder — per-channel, take the max
> **RETIRED 2026-07-15** → frozen in `scripts/backtest/legacy-ladder.ts`; live derivation = `alert-band.ts` (T1 dial band + escalator floors; note: a single F1 **or** F2 confirmed RED → CRITICAL — more aggressive than the old cross-channel rule).

Each channel maps its score to a level; the verdict is the **max across channels**, plus a
cross-channel CRITICAL rule. Thresholds are tunable and slated to become regime-relative (§6.9).

| Channel | WATCH | WARNING | CRITICAL |
|---|---|---|---|
| **Financing** (`FIN_score`) | ≥ 2 | ≥ 4 | ≥ 6 |
| **Rate** (`RATE_score`) | ≥ 2 | ≥ 4 | *(capped at WARNING)* |
| **Geo** (`GEO_score`) | ≥ 1 flag | ≥ 2 flags | *(capped at WARNING)* |

- **Rate/geo are capped at WARNING when alone.** The term spread leads *recessions*, not equity peaks
  (the index often rises for a year+ post-inversion), so a rate-only or geo-only signal means
  "elevated, look closer," not "systemic." Evidence-driven, not arbitrary. The RATE cap is
  **unconditional** — the former overheat-regime unlock (D2) was removed 2026-07-02 after a Stage-0
  backtest falsified it (§6.5.2).
- **Cross-channel CRITICAL:** fire CRITICAL if **two or more of {financing, rate} are simultaneously
  ≥ WARNING**, *or* `FIN_score` shows ≥ 2 Reds with `COINCIDENT_flag == Red`. *Geo is excluded from this
  count (Phase-2 C2, 2026-06-28): the weakest-evidence, un-backtestable channel doesn't carry full
  cross-channel escalation power.*
- The `COINCIDENT_flag == Red` modifier (§6.3) lowers every threshold above by 1 before evaluation.

> *⟳ Phase 2 adds **`T10Y2Y`** alongside R1's `T10Y3M` (2022 lesson: 10y-3m inverted ~10mo after the
> peak while 10y-2y inverted earlier). See plan Q8.*

#### 6.4.1 T2.2 — copper/gold GEO-confirmer gate (amplify-only)
> **RETIRED 2026-07-15** — CG now feeds only the cross-asset danger family (`families.ts`); the live GEO escalator counts manual flags + GEO-channel readings only.

The copper/gold ratio (CG, §4) is wired as a CONTEXT **confirmer** on the GEO channel: when CG's
*confirmed* state is elevated **and** the GEO channel is already elevated (≥ 1 manual/auto flag), it adds
**+1** to `GEO_score` — pairing with its commodity sibling oil (G1). It reads the confirmed (2-close) state,
not the raw print.

- **UNVALIDATED starting prior.** The `CG_AMBER_RET = −0.10` / `CG_RED_RET = −0.20` bands (20-day ratio
  return) are a starting prior, not a fitted or backtested value.
- **NARROWS-only.** The gate can only **amplify** — it credits at most **+1** to an *already-elevated* GEO
  and **never solos** (CONTEXT is excluded from the base roll-up by construction, so CG can never originate
  a flag or a push) and **never reaches CRITICAL** (GEO is `crit: null`, capped at WARNING). It cannot move
  any channel other than GEO, and cannot lift a quiet board off OK.
- **Backtest-gated (Phase-2).** Both the prior and the amplify behavior remain unvalidated until the
  REQUIRED harness rerun (§6.4.2 note / `docs/backlog.md` §Plan-doc menu) clears them.
- **Deliberate deviation.** This gate ships a knowingly-UNVALIDATED prior into the live verdict before the
  harness has cleared it — a conscious departure from Phase-2 falsify-before-adopt discipline, taken only
  because the gate is narrow enough (amplify-only, never-solo, never-CRITICAL) that a wrong prior is cheap.
  The standing cautionary precedent is the former **D2 Kiley overheat AND-gate** (§6.5.2): a
  similarly-reasoned, plausible prior that shipped ahead of validation and was later **FALSIFIED by a
  Stage-0 backtest and removed (2026-07-02)**. D2 is the reminder that a reasonable-sounding prior can still
  be wrong — so this gate is deliberately NARROWS-only and carries a REQUIRED backtest-rerun follow-up
  before it is considered validated.

#### 6.4.2 T3.2 — duration-of-calm G-b WATCH-floor (anti-complacency)
> **RETIRED from the fast path 2026-07-15** — `fragileCalm` now feeds only `computeSlowVerdict` on the SLOW track (`tracks.ts`).

The duration-of-calm leg (§4) floors the FAST verdict: when its confirmed state is Amber (`fragileCalm` —
a VIX low-vol run sustained ≥ `SLOW_CALM_RUN_MIN = 63` trading days), the fast verdict is lifted **OK→WATCH**
if it would otherwise sit at OK. Threaded slow→fast via `tracks.ts` / `run.ts`; the slow band math is
untouched (SLOW stays 2-active).

- **UNVALIDATED starting prior.** `SLOW_CALM_PCTILE = 0.5` and `SLOW_CALM_RUN_MIN = 63` are a starting
  prior, not a fitted or backtested value (63 vs 126 is the sweep the harness owes).
- **NARROWS-only.** The floor **raises OK→WATCH only — never higher.** It cannot lift WATCH to WARNING or
  CRITICAL, cannot lower any level, and touches only the FAST verdict (not the 9 `(market,mode)` cells).
  WATCH is the lowest, near-silent rung, so a false floor is the cheapest possible alert.
- **Backtest-gated (Phase-2).** The prior and the floor behavior remain unvalidated until the REQUIRED
  harness rerun clears them (sweep `SLOW_CALM_PCTILE × SLOW_CALM_RUN_MIN`, confirm lead + acceptable
  false-positive rate). See the flip-flop residual in §6.5 / `docs/backlog.md` (the floor is a new OK↔WATCH
  oscillation source).
- **Deliberate deviation.** Like §6.4.1, this floor ships a knowingly-UNVALIDATED prior into the live
  verdict ahead of the harness — a conscious departure from Phase-2 falsify-before-adopt discipline, taken
  only because the floor is narrow (OK→WATCH-only, the lowest rung). The standing cautionary precedent is
  the former **D2 Kiley overheat AND-gate** (§6.5.2): a similarly-reasoned, plausible prior that shipped
  ahead of validation and was later **FALSIFIED by a Stage-0 backtest and removed (2026-07-02)** — the
  reminder that a plausible prior can still be wrong. Hence the NARROWS-only design and the REQUIRED
  backtest follow-up before this floor is considered validated.

#### 6.5.1 D1 — asymmetric de-escalation ("stabilize the plumbing first")
> **RETIRED 2026-07-15** — replaced by the `deEscalationLag` sliding-window max (`DE_ESCALATION_N = 2`, `alert-band.ts`).

`computeVerdict(readings, geoFlags, prevLevel?)` **was removed from `src/` on 2026-07-15** and survives only
in `scripts/backtest/legacy-ladder.ts`. As it worked: while `COINCIDENT_flag == Red`, the verdict could **not
drop below the prior run's level** — fast up, slow down, gated on the coincident (VIX/MOVE) channel. That
blocked the *persisted* level (not just the notification), so a receding raw signal was held until bond/equity
vol settled. **WARNING cap (C1):** the hold floor was itself capped at **WARNING** — a prior CRITICAL could not
pin the board at CRITICAL indefinitely on the coincident gate alone (`holdFloor = rank(prevLevel) >
rank(WARNING) ? WARNING : prevLevel`). The verdict carried both the held `level` and the pre-hold `rawLevel`
so the notification and `/status` could show the divergence. `prevLevel == null` or a non-Red coincident
channel reduced this to the plain max-across-channels behavior.
