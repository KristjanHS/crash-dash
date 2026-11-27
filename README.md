<div align="center">

# crash-dash

**Signal-driven rotation guidance — which risk-laddered legs to hold as market danger shifts, from aggressive equities down to cash. Notify-only, never a trade.**

[![CI](https://github.com/KristjanHS/crash-dash/actions/workflows/ci.yml/badge.svg)](https://github.com/KristjanHS/crash-dash/actions/workflows/ci.yml)
[![Node 24](https://img.shields.io/badge/Node-24-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)

[What it is](#-what-it-is-and-isnt) · [Run it](#-running-it) · [Decode a notification](#-decoding-a-notification) · [Indicators](#-indicators-tracked) · [Scoring](#-how-the-score-works) · [Glossary](docs/glossary.md) · [Design](docs/bigtech-crash-dashboard-design-v4.md)

</div>

> **Refocused 2026-07-11:** the mission is now signal-driven **rotation guidance** across a 9-leg risk ladder. The current build still implements the crash-detection base described below.

It checks a basket of financial indicators once a day, decides whether stress is rising, and **pushes a single
notification to your phone**. It never trades and it is not financial advice — an alert means *"look
closer,"* never *"act now."*

## Contents

**Start here** — the short version

- 🎯 [What it is (and isn't)](#-what-it-is-and-isnt)
- 🪜 [How it works in five steps](#-how-it-works-in-five-steps)
- 🚀 [Running it](#-running-it) — incl. [data sources and extension points](#data-sources-and-extension-points), [scheduled jobs and leg runs](#scheduled-jobs-and-leg-runs), [agent tooling](#agent-tooling-claude) and [signing in](#signing-in)

**How it works** — the logic, in detail

- 📨 [Decoding a notification](#-decoding-a-notification)
- 📊 [Indicators tracked](#-indicators-tracked) — incl. [how a raw number becomes a traffic light](#how-a-raw-number-becomes-a-traffic-light)
- 🧮 [How the score works](#-how-the-score-works)

**Reference**

- 📖 [Glossary](docs/glossary.md) — every financial term, in plain English
- 🗺️ [Status and roadmap](#-status-and-roadmap)
- 📐 [Full design](docs/bigtech-crash-dashboard-design-v4.md)

---

## 🎯 What it is (and isn't)

- **Is:** a consistent, rules-based "is risk rising vs normal?" gauge that pings your phone once a day.
- **Isn't:** a crash predictor, a trading bot, or advice. It will produce false alarms and can miss a
  crash that gives no warning. The buy/sell/hold decision stays entirely with you.

---

## 🪜 How it works in five steps

1. **Feeds** — once a day, a cron job downloads free public data: US rates and the yield curve, inflation
   expectations, financial-conditions indices and oil (FRED, the US Treasury), the Fed's excess bond premium,
   and the ECB's euro rates and stress index. Credit spreads, VIX and ETF/index prices have no free source in
   this tree, so the indicators built on them degrade ([Data sources](#data-sources-and-extension-points)).
2. **Indicators** — each number gets a traffic light (🟢 fine · 🟡 worrying · 🔴 bad). A light only changes
   after **two closes in a row** agree, so one odd day can't flip it.
3. **Families** — indicators are grouped into related families (Credit, Rates & curve, Volatility,
   Trend & breadth, Geopolitics, Cross-asset, Valuation). A family *fires* when its members say danger.
4. **Dial and floors** — the families roll up into a 1–9 danger **dial**, and five **floors**
   (`credit` · `r4` cash breaker · `geo` · `rate` · `ew`) can force the alert level up regardless of the
   dial. The floor that bites is named on screen as the band reason.
5. **Output** — the resulting band goes to your phone via ntfy, and the full picture is drawn on `/`
   (simple) and `/lab` (the instrument bench).

Detail for each step: [Indicators tracked](#-indicators-tracked) · [How the score works](#-how-the-score-works).

---

## 🚀 Running it

```bash
npm start          # fetch indicators, score, push one notification
npm run check      # typecheck + tests
```

`npm start` reads `.env.local`: `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` are **required** (the store fails
loud without a DB), and `NTFY_TOPIC` enables real pushes.

To receive alerts: install the **ntfy** app on your phone and subscribe to your `NTFY_TOPIC`. The
hard-coded `crash-dash-dev` is a placeholder **dev default** only (`src/config.ts`); prod must set a
private `NTFY_TOPIC`, and off-prod pushes are suppressed when it's unset.

### Data sources and extension points

Only free sources are wired in. Licences and attribution are in [docs/data-licensing.md](docs/data-licensing.md).
If you hold your own data licences, the code is built around ports you can bind:

- Feed ports, in `src/feed-ports.ts`. A series with no free source throws `NoFreeSourceError`
  (`src/no-free-source.ts`). Six `FeedPorts` members are `noFreeSource()` bindings, one slot each:
  `fetchHourlyBars` (hourly bars), `fetchSovereignBars` and `fetchSovereignQuote` (sovereign-yield bars and
  live quotes), `fetchOfficialLeg` (official 10y yield legs), `fetchCape` (monthly CAPE) and `fetchDramSpot`
  (DRAM spot). `fetchDailyCloses` (daily adjusted closes) is a member too, but it is not a `noFreeSource()`
  binding: `src/prices.ts` raises `NoFreeSourceError` itself, behind its close cache. Two more slots in the
  same file are source ports, not `FeedPorts` members: `fetchIndexEod` (index end-of-day closes,
  injectable into `fetchOfficialLeg`) and the vol-index closes that the real `fetchSeries` binding reads; both are `noFreeSource()`
  bindings. The caller's `degrade()` serves its fallback and logs the miss to the run's degrade trace. The
  intraday, fallback and quote-graft code stays in, so a provider plugs into the same port.
- Provider fallback, in `src/prices.ts`. `ProviderFallback` records one provider-to-provider hop for one
  symbol, and `drainProviderFallbacks()` hands the run's hops to the persist step, which writes them to the
  degrade trace. With no daily-closes source there is no hop, so the drain is always empty. The backfill's
  `--require-primary-feed` flag (`scripts/backfill/run.ts`) is accepted but inert in this tree:
  `setRequirePrimaryFeed` does nothing, since there is no fallback to refuse. A bound provider would implement
  the refusal there. `--confirm-destructive` implies the flag unless `--allow-fallback-feed` is also passed.
- `REFUSED_SERIES` in `src/fred-series-policy.ts` lists FRED ids whose owners bar redistribution: the
  volatility indices (VIX, VIX3M, VXN), the ICE BofA option-adjusted spreads and Moody's corporate yields.
  They are refused before any request. Pass `fetchSeries` a `refusedSeries` option to change the set.
- Redaction, in `src/api/http.ts`. A read whose body can carry a licensed value builds the full body, then
  `serveRedactable` serves every request `redact(body)` as one shared edge copy; the full body is never sent.
  `isLicensedId` (`src/licensed.ts`) decides which ids count. Each handler has its own redact step: for example
  `redactIndicators` (`api/indicators.ts`) drops a licensed id's history-derived band cuts and any sensitivity
  report over a licensed series, and `redactSeries` (`api/series.ts`) serves a licensed id's points with
  `value` and `delta20` blanked, keeping dates and states. The reason is licensing: the served state is derived,
  the raw value belongs to the data's owner.
- `retainable()` in `src/retention.ts` decides which ids the store may write to `readings`. Every id passes
  by default. Narrow it if a licence forbids storing a series, but note the `alert_log` writers ignore it:
  their `run_inputs` blob still carries per-id values. The leg probes and backtests that read stored
  `LEGP_*` price rows (e.g. `scripts/probe-semis-tranches.ts`) find none here: no daily-closes source is bound.
- Deploys are explicit. `scripts/deploy-prod-local.sh` ships the local tree using the config in
  `$PROD_CONFIG_DIR` (`.env.prod` plus the Vercel link; defaults to the checkout's main worktree root), and
  `vercel.json` sets `git.deploymentEnabled: false` so a push never deploys. DR snapshots of `readings` and
  `alert_log` go to the `backups` branch of a separate data-only repo (`scripts/backup/`), not this one.
- Deploy config is stamped, not committed. The repo copy of every value that names the deploy target (the
  Supabase host and anon key in `public/supabase-host.js`, the CSP `connect-src` in `vercel.json`, page
  preconnects, the `openapi.yaml` server URL) holds a placeholder such as `configrefplaceholder`. After bundling,
  `scripts/stamp-deploy-config.ts` replaces each placeholder in the upload tree from the prod config. It
  refuses, writing nothing, on a missing or malformed value, an anon key that is not this project's, or a
  placeholder left over.

### Scheduled jobs and leg runs

This repo's workflows are `ci.yml` (the check gate, plus a deploy job that runs only with `CI_DEPLOY=true`)
and `integration.yml` (dispatch only); neither is scheduled. The DR backup (`scripts/backup/`), a dead-man
ping and a migration-drift check are optional operator-side schedules; a break-glass migrate job is an
optional operator-side manual dispatch.
`probe:prod-full`'s c9 check reads the latest `backup-prod-data` and `dead-man-ping` runs with `gh run list`
in the repo `gh` resolves (`GH_REPO`, else the checkout's git remote), and fails where they do not run.
It expects each to complete at least every 3 days (e.g. weekdays) and fails a run older than 4.

A *leg run* refreshes one re-entry ladder leg (`eufin`, `value`, `semis`, `spit`, `sp500`). An agent CLI
(`claude -p`) follows the leg's skill file, `.claude/skills/<leg>/SKILL.md`: `npm run <leg>:state` prints
the run's plan (`planRun`, `src/ladder-run.ts`), and `npm run <leg>:apply` (`applyRun`) writes every
per-run field of `public/<leg>.json`; the leg's `probe:<leg>-tranches -- --into=` writes only its `verdict`.
`scripts/eufin-run-local.sh` runs the legs headless, one after another. It calls two make targets through
`LADDER_RELEASE_MAKE` (default `make`): `prodcron` before the first leg and `ship` for any commit. The operator
sets it to a make invocation whose Makefile defines both; this repo's Makefile defines `ship` only, so with the
default the run stops at `prodcron`, before any leg.
Its API key comes from the operator's environment (the unit's `EnvironmentFile=`), never from the repo.
Scheduling is optional: `scripts/systemd/crash-dash-eufin.timer` is a user-level systemd timer (weekdays
07:40) that the operator links in by hand.

### Agent tooling (`.claude/`)

The repo is developed with Claude Code; `.claude/` holds its project rules, skills and hooks. Some rules and
docs defer to the developer's per-user Claude Code config under `~/.claude/` (global rules and references,
auto-memory such as `project_state.md`, an optional session driver that sets `IMPAG_STAGE`), which is not part
of the repo. Without it the hooks keep their default mode: `guard-ask.mjs` allows a guarded write with a
warning, and prompts instead only under `GUARD_ASK=1`.
Plan docs under `docs/plans/` are working notes, mostly not kept in the tree; the commit log carries provenance.

### Signing in

The overview page (`/overview`) is open to everyone. Signing in (`public/signin.html`) is by an emailed
link, and the first link you confirm on the email-alerts page (`/subscribe`) creates the account. A signed-in
browser can open:

- the dashboard (`/`), the lab (`/lab`) and the exposure page (`/exposure`), which send a signed-out visitor
  to `/overview`;
- the holdings journal (`/journal`), a private log of which ladder leg you hold and how much cash sits beside
  it, with a snapshot of what the dial said at the time. Row-level security limits each row to its owner.

Email alerts come from subscribing on `/subscribe`, not from signing in: each band push also goes by email,
through Brevo, to every subscribed address (`src/email.ts`). Nothing is sent unless both `BREVO_API_KEY` and
`EMAIL_FROM` are set; without them `sendBandEmail` logs a warning and skips the send.

The `/api` reads serve the same redacted body whether or not you are signed in.

---

## 📨 Decoding a notification

You only get pinged when things get **worse** (see [When it pings you](#-how-the-score-works)), so a
real message is an alert. Here is one and what every part means:

```
crash-dash - OK -> WATCH                          ← title: the band change that fired the push
OK -> WATCH                                       ← same transition, in the body
Dial: Caution (rung 4/9)                          ← the T1 dial regime + its rung on the 9-leg ladder
Guidance: risk is elevating one notch — monitor; no action required yet.

HY OAS: 6.12% (RED) · 30d Δ +1.80%                ← one line per NON-GREEN indicator — what moved
IG OAS: 1.62% (AMBER) · 20d Δ +0.45%
10y−3m: 0.42% (AMBER) · 20d Δ -0.15%
── anchors ──                                     ← three gauges that print even when calm,
VIX: 14.30 (GREEN) · 20d Δ +0.12                     so every push carries a level sense
46 others GREEN                                   ← everything else: counted, not listed
Dial Caution r4 · families 2/7 firing (credit, rates) → WATCH   ← dial + family breadth → band
as of 2026-06-23                                  ← date of the latest data
```

The push is a **heads-up, not the record**: only the indicators carrying news print. The full
per-indicator list still lives on the dashboard (`/lab`, the read API) and in the local `npm start`
console transcript.

Read one indicator line left to right:

| Piece | Example | Meaning |
|---|---|---|
| **Name** | `HY OAS` | Which indicator, by its short name (see [Indicators tracked](#-indicators-tracked)). |
| **Level** | `6.12%` | Today's value. Here, a 6.12% credit spread. |
| **State** | `(RED)` | This indicator's traffic-light: GREEN = calm, AMBER = building stress, RED = high stress. |
| **20d Δ** | `+1.80%` | How much the value moved over the last 20 trading days (~1 month). Positive = stress rising. |

The state shown is the one that actually drives the alert. There is no separate "raw" annotation: since
2026-07-26 every indicator confirms **same-day**, so the raw and confirmed states are the same value by
construction (see [How the score works](#-how-the-score-works)).

The header and the last two lines tie it together:

- **`OK -> WATCH`** — the **alert band changed**; that upward step is *why* this push fired. (A
  re-assert of a stuck alert instead reads `still WARNING`.)
- **the indicator block** — every indicator that isn't GREEN, so you see at a glance what moved,
  then the three anchors (`HY OAS` · `10y−3m` · `VIX`) even when they're calm, then a count of the
  rest.
- **`Dial Caution r4 · families 2/7 firing (credit, rates)`** — the **T1 dial** regime
  (Calm / Caution / Stress / Crisis) and its target rung on the 9-leg ladder, plus how many of the
  danger **families** are firing (and which ones).
- **`→ WATCH`** — the **alert band** the dial maps to, after the de-escalation lag and any hard
  escalator floors (see [How the score works](#-how-the-score-works)).

So this message says: *high-yield credit just went RED, the credit and rates families are firing, and the
dial moved to Caution — enough to trip WATCH. Look closer.*

> New to a term like *credit spread*, *OAS*, or *20d Δ*? The [Glossary](docs/glossary.md) explains each
> in plain English.

---

## 📊 Indicators tracked

### How a raw number becomes a traffic light

*(measured against live prod 2026-07-26)*

The live signal set is **`ALL_INDICATORS`** (`src/registry.ts`), split across the scoring families in
**`GLOBAL_FAMILIES`** (`src/families.ts`) — plus pension-drawdown legs and NVDA, which serves no family.
Probe the symbols for the counts; they move, so this page does not print them. The signals arrive from keyless
public feeds (**FRED**, the **US Treasury**, the **Fed**'s EBP and forward-curve files, the **ECB**) plus a
**daily-closes** feed for everything price-based. FRED's credit-spread and volatility-index ids are refused
(`REFUSED_SERIES`) and daily closes have no free source, so those indicators degrade.
A dead feed never blanks the board — the signal freezes at its last value and is flagged stale.

**Each signal has up to six OR'd legs, not one threshold** (`src/domain-legs.ts`): the hand-set
absolute level, the 20-day velocity, measured EVT tail cuts, and regime-relative σ cuts. The worst
leg that fires wins, RED tested before AMBER. Measured legs may only make a signal fire *earlier* —
an absent one leaves convention behaviour byte-identical.

**Where the cut-lines come from** (`CALIB_MAP` in `src/domain-cuts.ts` — the wire `provenance` field
was retired 2026-07-30): the signals carrying a measured leg are exactly the keys of `CALIB_MAP`
(`src/domain-cuts.ts`) — probe that symbol for the set and its size, because a list printed here
rots (it still named F1 and F2 long after 2026-08-06 dropped both from the map with the borrowed
Baa10y proxy-z legs). Everything else is a hand-set convention, and a mapped entry means *some*
leg is measured, not that the level cut is.
Separately, many signals bypass `classify()` entirely and run bespoke scorers with their own
constants (`scorers-price.ts` / `scorers-composite.ts`) — count them off the registry rather than
off this page, which does not publish a number that rots.

**Confirmation is same-day for every family** (`families.ts CONFIRM_TIERS`, all tiers 0 since
2026-07-26). The per-family table is kept so re-buffering one family later is a one-value edit, but
today no indicator waits for a second close.

**Staleness is a flag, not a veto.** A stale reading still scores at its frozen last value — only the
band-level verdict-hold reacts to it. `lagCutFor()` resolves a per-indicator `lagAfterDays` first,
else the cadence tier.

**Roll-up is worst-member-wins** — no averaging, no quorum. One RED member reddens its whole family,
and the family is what the dial reads.

### The founding fast-track subset

The live registry (`ALL_INDICATORS` in `src/registry.ts`, re-exported via `src/indicators.ts`) is the
source of truth for how many indicators are tracked and which — no count is published here, because a
hardcoded one rots. It spans the fast, slow-bubble, pension, and bottom tracks (F3, F6–F13, G1, EBP, R6, R7, CG, VT, EURC, FXH,
GT, GB, DISP, …). The tables below cover only the **founding fast-track subset**, grouped into
channels by the job they do — see `src/registry.ts` for the full set. A trigger fires on the
**level** *or* the **velocity** (20-trading-day change), whichever is worse; a `+0.40/20d` figure means
"rose 0.40 over the last 20 trading days." Most thresholds are in percentage points; VIX is an index, F4 a
price, F5 a ratio.

**Financing (FIN)** — the core channel; a confirmed F1 *or* F2 RED is a hard escalator straight to CRITICAL.

| ID | Name | Measures | AMBER if | RED if |
|---|---|---|---|---|
| **F1** | HY OAS | High-yield credit spread (leads) | > 3.00% (hand-set prior) | > 3.20% (hand-set prior) |
| **F2** | IG OAS | Investment-grade credit spread | > 1.50% or +0.40/20d | > 2.00% or +0.70/20d |
| **F4** | Semis momentum (SMH) | Chip-sector trend, NVDA-confirmed | SMH < MA200 **and** 6-mo return ≤ −15% | 6-mo return ≤ −25% **and** NVDA < its MA200 |

**Leading-rate (RATE)** — interest-rate stress that leads recessions; feeds the rates family, plus a WATCH-floor escalator when the channel base score reaches 2.

| ID | Name | Measures | AMBER if | RED if |
|---|---|---|---|---|
| **R1** | Term spread 10y−3m | Yield-curve slope (inverts before recessions) | < 0.50 (flattening) | < 0.00 (inverted) |
| **R2** | 10y velocity | Long-rate shock | +0.40/20d | +0.70/20d |
| **R3** | 2y velocity | Fed-path shock | +0.35/20d | +0.60/20d |
| **R4** | 10y real-yield velocity | Real-rate shock | +0.18/20d | +0.25/20d |

**Coincident** — confirms rather than leads: VIX feeds the volatility family of the danger dial, moving the band's position rather than front-running it.

| ID | Name | Measures | AMBER if | RED if |
|---|---|---|---|---|
| **R5** | VIX | Equity-market fear gauge | > 20 | > 30 |

**Context** — no channel is notify-neutral anymore: F5 feeds the trend family of the danger dial (amber-only — it never reads RED).

| ID | Name | Measures | AMBER if | RED if |
|---|---|---|---|---|
| **F5** | Breadth (QQQ/QQQE) | Mega-cap concentration in the Nasdaq-100 | ratio at a 12-mo high **and** rising | *(no RED — context only)* |

The rate indicators (R1–R4) come free from the **US Federal Reserve (FRED)**. F1 and F2 (ICE credit
spreads) and R5 (VIX) are FRED ids whose owners bar redistribution, so `REFUSED_SERIES` refuses them before any
request and they degrade. The price ones (F4, F5) and **R6** (MOVE, bond-market volatility; registry + fast
confirmer) read daily closes, which have no free source here, so they degrade too. The **GEO** channel is
**live as a hybrid** — auto G1 oil shock + manual flags (`geoBase` in `src/alert-band.ts`). Only **F7**
(CAPE valuation) remains a reserved seam. Term definitions live in the [Glossary](docs/glossary.md); the
full rationale is in the [design doc](docs/bigtech-crash-dashboard-design-v4.md) §4.

---

## 🧮 How the score works

Five steps turn raw daily data into one alert band and decide whether to ping you.

**1 · Each indicator → a traffic light.** Every indicator scores GREEN / AMBER / RED off its level and/or
its 20-day velocity (thresholds above).

**2 · Confirmation (same-day).** A new state counts immediately — the raw state **is** the state, in both
directions. There used to be a 2-close buffer here to kill one-day blips; it was removed on 2026-07-26
because the free/keyless feeds this project is limited to already arrive late, so the buffer stacked a
self-inflicted delay on an unavoidable one. Expect a chattier alert path as a result.

⚠ Positions are a different story: the leg-level regime fold in `src/danger-engine.ts` keeps its own
2-close confirmation, on top of a re-risk deadband and dwell gates. Only the *indicator* layer went
same-day.

**3 · Confirmed states feed a family panel.** Related indicators group into danger **families**
(credit, rates, volatility, valuation, … — `src/families.ts`); a family **fires** when its members'
confirmed states cross its rule.

**4 · The T1 dial turns family breadth into a regime, and the regime into the alert band.** The dial
(`src/t1dial.ts`) reads how many leading + coincident families are firing and lands on a target **rung
1–9** on the ladder (1 = Semis / most aggressive, 9 = Staples / most defensive). That rung becomes a
`dangerScore = (rung − 1) / 8`, and cuts at **rung 3 / 5 / 7** (`NOTIFY_REGIME_CUTS`) name the regime —
**Calm / Caution / Stress / Crisis** — which maps 1:1 to the band:

| Band | Regime | Roughly means | ntfy priority |
|---|---|---|---|
| **OK** | Calm | Nothing elevated. | — (never pushes) |
| 🟡 **WATCH** | Caution | Stress building — worth a glance. | 2 (near-silent) |
| 🟠 **WARNING** | Stress | Elevated crash probability vs normal. | 4 |
| 🔴 **CRITICAL** | Crisis | Multiple stress signals aligned. | 5 (bypasses Do-Not-Disturb) |

The whole chain is built to **rise fast and fall slow** (`src/alert-band.ts`):

`band = max(deEscalationLag(dialBand, N=2 days), escalatorFloor)`, then `+1` if credit diverges, then a
stale-feed hold — and the binding step is named on the alert row as `bandReason` (`floor:geo`,
`lag-hold`, `regime`, `divergence`, `verdict-hold`).

- **De-escalation lag** — a *higher* read applies instantly; a *lower* one only after it holds **2
  calendar days**.
- **Five hard escalator floors** bypass that lag entirely. Each has a cap — the highest band its own
  expression can ever reach — and the first at the max wins the `bandReason`:

| Floor | Fires when | Cap |
|---|---|---|
| `credit` | F1 **or** F2 confirmed RED. **Two keys** (a coincident family also firing) ⇒ CRITICAL; **one key** ⇒ WARNING | CRITICAL |
| `r4` | the R4 cash breaker reached phase `cash`. Phases are `equity → cash → re-entry`, entered on the **first** qualifying close — no arming delay | CRITICAL |
| `geo` | manual flags + one per distinct auto GEO **factor** (G1/BRENT/OVX all read oil ⇒ one flag between them) + declared crisis stage: ≥ 1 ⇒ WATCH, ≥ 2 ⇒ WARNING | WARNING |
| `rate` | RATE-channel non-confirmer score ≥ 2 | WATCH |
| `ew` | any EARLY-WARN downside break AMBER-or-worse — advisory: *monitor, do not de-risk* | WATCH |

- **Divergence bump (+1)** — one notch up when HY OAS is widening over 30 days **into** a QQQ near-252d
  high. It can't manufacture a crisis from calm: from OK it reaches only WATCH.
- **Stale-feed hold** — while **any** indicator is stale for its cadence, the band cannot step *down*
  below the previous run's. A stale-benign feed is never trusted to have improved things.

> **The floors move the alert LEVEL only — they do not pick which leg you hold.** These are two
> different machines, so here are both lists:
>
> - **What raises the ALERT LEVEL:** the dial's own regime (the base band above — the rest only
>   `max` over it) · the five floors above · the de-escalation lag · the +1 divergence bump · the
>   stale-feed hold. Whichever binds names itself as the `bandReason`. A floor *mechanism* raises the
>   alert only — but the reading behind it may still move the position by another route (the `cr`/`rt`
>   families carry `MEMBER_WEIGHT` rows; only the early-warn nudge `ew` is cleanly notify-only).
> - **What moves the POSITION (which leg you hold):** the dial's rung window `[lo,hi]` — this is
>   where **valuation / CAPE** enters, as the `computeT1Dial` severity multiplier that deepens the
>   rung and so the window's top `hi` (CAPE is a member of no family; `MEMBER_WEIGHT.vb` is `{}`, so
>   the valuation cell is always `na`) · the per-leg danger field inside that window (the family cells
>   and their `MEMBER_WEIGHT` rows) · the **exogenous danger term** (a confirmed oil shock — G1, OVX
>   or Brent — raises *every* leg's danger to **at least** its own `MEMBER_WEIGHT × severity`, more on
>   the oil-sensitive ones; it is a worst-of `max` term, never added on top of the other families,
>   so it re-orders the board rather than lifting it) · the re-risk deadband (`RERISK_DEADBAND`, which
>   makes re-risking *slower*, never faster — the dwell/streak gates that used to sit beside it were
>   retired 2026-08-07, so a re-risk now commits on one close like a de-risk, subject only to this
>   deadband and the trend veto) · `TREND_GATE_FLOOR` ·
>   `CONC_THRESHOLD` · the **cash overlay** (scales non-equity without changing the leg) · the **R4
>   cash breaker** (takes you off the ladder entirely).
>
> `r4` and `geo` are the entries on both lists, for different reasons. For `r4` the causation runs the
> other way: the breaker moves the position, and *that* is why its floor fires. For `geo` a single
> reading has two separate effects — the same confirmed oil shock feeds the geo escalator floor
> *and* `combineLegDanger`'s exogenous term in `src/danger-engine.ts` (band = how loud, position =
> what to hold; the double-count is deliberate). Leg selection is `computeField(…, dial.band, …)`
> in `src/run-core.ts`, which reads the dial's rung window — never the composed alert band.

**5 · When it pings you.** The run is daily, but it stays quiet unless something gets worse. Three
independent triggers are OR'd — any one of them pushes:

- **Notify on upgrade only** — a push fires when the band *rises* vs. the previous run. Same-level
  runs and downgrades are silent (but still logged).
- **Held-sleeve change** — a change of the held ladder leg pushes on its own, in *either* direction
  (even a lateral EM → Value with the band unchanged); the title then reads `hold changed EM -> Value`.
- **Weekly re-assert** — a still-elevated alert (≥ WARNING) re-pings after **7 days** even with no change,
  so a stuck warning doesn't fade from mind. A push that *failed* to deliver re-fires on the next run
  regardless of the interval.
- **Freshness heartbeat** — if the latest data is lagging past the daily cut, a push flags it
  (`[!] feed lag`), and each individually lagging indicator is named (`[!] lagging legs: …`) against its
  own **resolved** cut — a per-feed `lagAfterDays` where the registry declares one, else the cadence
  tier (`LAG_THRESHOLDS` in `src/ladder.ts` is the one source for both; the tiers track the
  publishers' calendars, so don't restate their values here). An optional
  *dead-man ping* (an operator-side schedule, see [scheduled jobs](#scheduled-jobs-and-leg-runs)) catches
  the opposite failure — a run that stops firing entirely.

---

## 🗺️ Status and roadmap

**Live today:** the indicator registry (`src/registry.ts`) → confirmed states → family panel → T1 dial →
alert band with hard escalators → notify-on-upgrade with weekly re-assert and a freshness heartbeat. Runs
persist to Supabase (readings + alert log) and push via ntfy; a read-API (`openapi.yaml`) exposes the
latest state. A live **`/lab` instrument-bench dashboard** (`public/lab.html`) renders the dial, families,
and legs off that read-API (`api/` handlers on Vercel).

**Where it's heading.** The mission is now the **9-leg rotation ladder** — signal-driven guidance on
which risk leg to hold, from aggressive equities down to cash. The fast-track
additions from the earlier redesign (**EBP**, **R6**/MOVE, **VIX term-structure backwardation**) have
shipped. The audit trail of the superseded crash-logic redesign (adjudication memo, improvement plan,
pre-registration, evidence base) is retired; the
[v4 design doc](docs/bigtech-crash-dashboard-design-v4.md) §11 records the build history that got here.
