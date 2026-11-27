# Research — handling a LEADING/early-reacting member inside a "Confirming" family

Status: **research only** (2026-07-21). Grounds the deferred **DB_SMH false-RED fix** decision. No code decided here — the fix approach is USER-owned and
still open; this doc exists so that decision is made on evidence, not a blind pick.

## Problem being researched
The `trend` family is aggregated **worst-of** (family state = worst RAG among members) and is treated as a
**"Confirming"/coincident** signal — meant to corroborate a regime shift, not predict it. One member, the fast
**downside-break** detector (`DB_SMH`: price fell ≥8% AMBER / ≥15% RED off a 63-day high), is an **early/leading**
reactor (validated as *leading* the slower momentum proxy F4 by ≥3 trading days). In live prod it fired a **lone
RED** while every slower sibling was GREEN, and because the family is worst-of, one noisy fast member solo-tripped
the whole Confirming family → false regime signal → wrong de-risk. **Core tension:** a corroboration gate ("fast
member counts only if a slow sibling agrees") kills the very lead time that made the fast detector valuable.

## 1. Leading vs coincident vs lagging — why worst-of/AND/OR mixing is a trap
Standard taxonomy: **leading** (turn before the cycle), **coincident** (turn with it), **lagging** (turn after,
confirming) — the NBER / Conference Board framing behind the LEI/CEI/LAG composite trio. The Conference Board's
central methodological choice is to keep the three as **separate composites**, precisely because they have
different *timing signatures*: confidence in a turning point comes from leading+coincident firing *and then*
lagging confirming — not from collapsing them into one number. Mixing timing classes in one worst-of/AND/OR gate
is a known trap because a **worst-of rule inherits the noise profile of its fastest, most sensitive member while
claiming the semantics of its slowest** — the composite is labelled "confirming" but behaves like an early
reactor. In TA terms this is the classic leading-vs-lagging tension: leading signals fire early but false-positive
more; lagging signals confirm but late.
- Conference Board, *Description of Components* — https://www.conference-board.org/data/bci/index.cfm?id=2160
- NBER, *Composite Indexes of Leading, Coincident, and Lagging Indicators* — https://www.nber.org/system/files/chapters/c10382/c10382.pdf
- Conference Board FAQ (separate composites) — https://www.conference-board.org/data/bci/index.cfm?id=2157
- LiteFinance, *Leading and Lagging Indicators* — https://www.litefinance.org/blog/for-beginners/best-technical-indicators/leading-and-lagging-indicators/

## 2. Confirmation / corroboration techniques (N-of-M)
The practitioner remedy for one-indicator noise is **N-of-M / majority voting ("confluence")**: require ≥N of M
members to agree before the composite acts (common rules 3-of-5, or "2–4 must agree"), reported to cut signal
frequency 40–70% while raising quality. The economic analogue is the **diffusion index**: score the *breadth* of
members moving together — a broad-based decline (high diffusion) is stronger than a move driven by one or two
outliers. Both are explicit antidotes to a single member solo-tripping the composite. Best practice also warns
against redundancy — combine *different categories* (trend + momentum + volatility), not clones.
- ClearEdge, *Multi-Indicator Confluence* — https://clearedge.trading/post/automate-multi-indicator-confluence-futures-signals-fa59f
- FMZQuant, *Multi-Indicator Trend Confirmation* — https://medium.com/@FMZQuant/multi-indicator-trend-confirmation-trading-strategy-b2a7e69dbccd
- Conference Board, *How to Compute Diffusion Indexes* — https://www.conference-board.org/data/bci/index.cfm?id=2180

## 3. Whipsaw / false-positive reduction for fast signals (all cost lead time)
- **Time-confirmation / persistence gate** — require the condition to hold K extra periods before it counts.
- **Hysteresis / dead-band (Schmitt trigger)** — *different* thresholds to enter vs leave a state; once tripped
  it takes a large reversal to un-trip. Canonical debounce for a noisy input toggling a binary output.
- **Slower-sibling agreement / regime filter** — gate the fast signal on a slow indicator (ADX, multi-timeframe).

Universal caveat: filters delay entry/exit and shave the very moves you wanted — "you want to accept most of the
whipsaws since the idea is to catch the big moves." This is exactly the tension here.
- Investing for Dummies, *Filter Out Whipsaws* — https://www.dummies.com/article/business-careers-money/personal-finance/investing/general-investing/filter-out-whipsaws-from-your-trading-decisions-189994/
- Wikipedia, *Schmitt trigger* — https://en.wikipedia.org/wiki/Schmitt_trigger
- Ganssle, *Debouncing pt.2* — https://www.ganssle.com/debouncing-pt2.htm
- s2analytics, *Whipsaws in Trend Following* — https://s2analytics.com/blog/whipsaws-in-trend-following-systems/

## 4. Weighting / ensemble approaches
The Conference Board's design answer is **not** to give a fast member full weight in a confirming composite, nor
to merge timing classes: it **standardizes each component's volatility** (so a high-variance member can't dominate)
and routes leading vs lagging series to **separate indexes**. The early-warning literature
reinforces separation: warning *early* demands *higher confidence* than warning on time, and predictive performance
decays monotonically as lead time lengthens — so an early-warning axis is intrinsically noisier and belongs on its
own sensitivity/specificity (ROC) operating point, not blended into a confirmation score.
- Conference Board, *Updating the Composite Indexes* — https://www.conference-board.org/data/bci/index.cfm?id=2155
- ScienceDirect, *Early warning signals for critical transitions* — https://www.sciencedirect.com/science/article/pii/S2589004223012336
- EmergentMind, *Early Warning Index* — https://www.emergentmind.com/topics/early-warning-index-ewi

## 5. Resolving the specific tension — re-route, don't suppress
A gate ("fast member counts only if a slow sibling agrees") destroys the lead by construction — it can't fire
before the slow one. The literature's resolution is **don't suppress the lead signal, re-route it**: keep the fast
detector as a *distinct early-warning output* with its own (looser) threshold and its own tolerance for false
positives, and let the *confirming* composite stay slow (coincident members only, or breadth-gated). Leading and
confirming signals kept on **separate axes**, each at its own operating point — the fast one keeps full lead time
on the warning axis; the confirming axis stays clean.
- Conference Board FAQ — https://www.conference-board.org/data/bci/index.cfm?id=2157
- ScienceDirect (EWS) — https://www.sciencedirect.com/science/article/pii/S2589004223012336

## Recommendation — worst-of Confirming family with one fast leading member (ranked)
1. **Move the fast downside-break detector OFF the Confirming axis onto a separate "Early-Warning" axis.** Best
   fidelity to both the economics and the EWS literature. Confirming family reverts to slow/coincident members only
   → can never solo-trip; the fast detector keeps full 3-day lead on a distinct output with its own looser
   threshold. Cost: adds an axis/UI surface + a decision on how the early-warning axis feeds notifications. The
   only option that loses **zero** lead time.
2. **Replace worst-of with N-of-M / diffusion inside the family** (RED requires 2-of-N, or ≥50% breadth). Cheap,
   one axis, kills lone-member trips directly. Cost: the fast member no longer leads *within the family* — this
   reintroduces corroboration-defeats-lead-time *inside* the family; acceptable only if the family is genuinely
   meant to be confirming and you accept losing the lead there.
3. **Hysteresis + K-day persistence on the fast member only** (Schmitt dead-band: ≥15% to trip RED, must *stay*
   worse than ~10% for K days to hold; wider band to clear). Keeps worst-of + member on family. Cost: ~K days of
   lead time + two tunable knobs; a partial fix, not clean separation.
4. **Volatility-standardize weights and drop worst-of for a weighted/averaged family state** — a lone fast RED
   becomes a partial contribution, not a full flip. Cost: changes family semantics from a worst-of ladder to a
   score; the fast member is diluted, not routed — lead time muted, not preserved.

Options **1 and 3 are compatible** (separate axis *plus* debounce on it); 2 and 4 are alternatives to worst-of.
**Option 1** is what the standing leading/coincident/lagging methodology most strongly endorses: don't merge
timing classes — separate them and confirm across axes. This maps directly onto crash-dash's existing
EARLY-WARN vs STRESS-NOW two-axis leg model (`danger-engine.ts`), which is worth weighing when the decision is made.
