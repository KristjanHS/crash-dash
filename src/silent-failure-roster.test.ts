import { existsSync, readFileSync } from "node:fs";
import type TS from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { directImports, reachable, resolveSpec } from "../scripts/import-graph.js";
import { expectClean, handlerBody, has, type Hit, loadTs, misfires, owner, type ReasonCheck, type Row, scan, SCAN_HOOK_TIMEOUT, type ScanReport, scanText, sourceFiles, unwrap, type Visitor } from "./source-scan.test-helpers.js";

// Silent-failure triage: every swallow / literal-default site in src+api is rostered or fixed.
// `?? null|undefined|""` + empty collections (absence-preserving) and `|| "<string>"` (display glyphs, 2/11 TP) are not swept; a catch rethrowing, or
// signalling (`isSignal`) without inventing a value, or stashing its error inside a retry loop, is not a swallow.

let ts: typeof TS; // loaded in `beforeAll`: keeps typescript.js out of collect time

const STAND_INS = "src/danger-engine.stand-ins.test.ts";
const ARMS = ["catch-empty", "catch-default", "promise-swallow", "promise-named", "then-swallow", "default-qq", "default-or"] as const;
type Arm = (typeof ARMS)[number];

/** `code` = the trimmed source line; a catch clause is prefixed `<enclosing fn> › `. */
const ROSTER: readonly Row[] = [
  { file: "api/exposure.ts", code: "Promise.resolve().then(() => store.getLastAlert()).catch((err: unknown) => {", count: 1, reason: "signal:console: `warn` names the read; serves the rung-blind posture (degraded 200)" },
  { file: "api/exposure.ts", code: "getPrintSeries(store, \"F1\", EXPOSURE_F1_LIMIT).catch(() => []), // prints only, as the cron read (E25 carry rows)", count: 1, reason: "signal:elsewhere: an absent F1 serves `arm.degraded: true` + posture null on the wire" },
  { file: "api/exposure.ts", code: "getPrintSeries(store, \"GT\", EXPOSURE_GT_LIMIT).catch(() => []),", count: 1, reason: "signal:elsewhere: an absent GT serves `fire.degraded: true` + posture null on the wire" },
  { file: "api/exposure.ts", code: "verdict?.cashOverlay ?? \"off\",", count: 1, reason: "stand-in: no verdict row ⇒ overlay off, the persisted column default" },
  { file: "api/indicators.ts", code: "const series: CapeObs[] = await store.getSeries(\"F7\", CAPE_PCT_READ).catch((err: unknown) => {", count: 1, reason: "signal:console: `warn` names F7; serves no CAPE bands" },
  { file: "api/indicators.ts", code: "store.getSeriesBulk(ids, { limit: 1, range: { to: STORED_COMPANION_HORIZON } }).catch((err: unknown) => {", count: 1, reason: "signal:console: `warn` names the read; serves no `companionAnchorDate`" },
  { file: "api/indicators.ts", code: "unit: i.unit ?? \"%\",", count: 1, reason: "stand-in: registry `unit` absent ⇒ \"%\", the wire-edge unit convention" },
  { file: "api/lab.ts", code: "? await scenarioStore.getLastAlert().catch((err: unknown) => {", count: 1, reason: "signal:console: `warn` names the read; scenario verdict null (DEGRADED)" },
  { file: "api/lab.ts", code: "? freshnessFrom(sharedStore, now, warn).catch((err: unknown) => {", count: 1, reason: "signal:console: `warn` names the stamp; serves `freshnessMissing: true`" },
  { file: "api/lab.ts", code: "const incumbentConfirm = scenarioVerdict?.reriskConfirmCount ?? 0;", count: 1, reason: "stand-in: no verdict row ⇒ a zero confirm streak (first run), as `run-core`" },
  { file: "api/lab.ts", code: "const incumbentHeldDays = scenarioVerdict?.heldDays ?? 0;", count: 1, reason: "stand-in: no verdict row ⇒ zero held days (first run), as `run-core`" },
  { file: "api/lab.ts", code: "const legResultP = computeLegAttribution(store, readings, verdict.firedAt).catch((err: unknown) => {", count: 1, reason: "signal:console: `warn` names the step; serves `degraded: true`" },
  { file: "api/lab.ts", code: "labBody › } catch (err) {", count: 1, reason: "signal:elsewhere: stashed for the `?s=` branch's loud `warn`; the live path re-calls `storeOf()`, which throws" },
  { file: "api/lab.ts", code: "p.catch(() => {});", count: 1, reason: "signal:elsewhere: unhandled-rejection guard only — the original-site `await` re-throws (docblock above)" },
  { file: "api/lab.ts", code: "points: await getObservedSeries(replayStore, id, limit).catch((err: unknown) => {", count: 1, reason: "signal:console: `warn` names the replay id; replayed as an absent member" },
  { file: "api/lab.ts", code: "walkedVerdict.r4Phase ?? \"equity\",", count: 2, reason: "stand-in: a null (pre-migration) `r4Phase` ⇒ R4's initial equity phase" },
  { file: "api/series.ts", code: "(await store.getLastAlert().catch(() => null))?.firedAt,", count: 1, reason: "stand-in: memo key only — a null verdict bypasses the memo and the loader still reads" },
  { file: "api/series.ts", code: "const aux = await store.getSeries(def.source, visible + pad).catch((err: unknown) => {", count: 1, reason: "signal:console: `warn` names the gate source; the gate key is omitted" },
  { file: "api/series.ts", code: "const calib = await store.getCalibration().catch((err: unknown): CalibrationParam[] => {", count: 1, reason: "signal:console: `warn` names the id; re-scores on convention cuts" },
  { file: "api/series.ts", code: "const direction = indicator.direction ?? \"HIGH\";", count: 1, reason: "stand-in: registry `direction` absent ⇒ HIGH-firing, the registry default" },
  { file: "api/series.ts", code: "const rawStates = padded.map((p, i) => dispersionState(p.value ?? NaN, p.decision ?? NaN, cut, corrP90[i]));", count: 2, reason: "stand-in: a null value/decision ⇒ NaN, which `dispersionState` reads GREEN by its NaN-safe gates" },
  { file: "api/series.ts", code: "const values = dv ? fetched.map((p) => p.value ?? NaN) : [];", count: 1, reason: "stand-in: a null value ⇒ NaN, a non-finite gap in the derived line" },
  { file: "api/series.ts", code: "const w = ind.velocityWindow ?? VELOCITY_WINDOW;", count: 1, reason: "stand-in: optional registry window ⇒ the kernel `VELOCITY_WINDOW`" },
  { file: "api/series.ts", code: "fxHavenSeries › } catch (err) {", count: 1, reason: "signal:console: `warn` names the id; serves the stored series" },
  { file: "api/series.ts", code: "indicator.velocityWindow ?? VELOCITY_WINDOW,", count: 1, reason: "stand-in: optional registry window ⇒ the kernel `VELOCITY_WINDOW`" },
  { file: "api/series.ts", code: "padded.map((p) => (p.value === 0 ? NaN : (p.value ?? NaN))),", count: 1, reason: "stand-in: a null value ⇒ NaN, the non-finite gap `rollingPercentile` skips" },
  { file: "api/series.ts", code: "unit: indicator.unit ?? \"%\",", count: 1, reason: "stand-in: registry `unit` absent ⇒ \"%\", the wire-edge unit convention" },
  { file: "api/series.ts", code: "value: (r.decision ?? 0) * 100,", count: 1, reason: "stand-in: type-only — the downside `decisionOf` sets a number on every emitted reading" },
  { file: "api/status.ts", code: "(opts.freshness ?? freshnessFrom)(store, now).catch((err: unknown) => {", count: 1, reason: "signal:console: `warn` names the stamp; serves run-row ages, no pill" },
  { file: "api/status.ts", code: "const cadence = CADENCE_OF.get(f.id) ?? \"daily\";", count: 1, reason: "stand-in: registry `cadence` absent ⇒ daily, the registry default" },
  { file: "api/status.ts", code: "const capeSeries: (CapeObs & { estimated?: boolean })[] = await store.getSeries(\"F7\", VAL_Z_WINDOW + CAPE_SERIES_PAD).catch((err: unknown) => {", count: 1, reason: "signal:console: `warn` names F7; serves no CAPE card" },
  { file: "api/status.ts", code: "const now = opts.now ?? new Date();", count: 1, reason: "stand-in: no injected clock ⇒ the wall clock" },
  { file: "api/status.ts", code: "label: capeMeta?.label ?? \"F7\",", count: 1, reason: "stand-in: no registry meta ⇒ the id as its label" },
  { file: "api/status.ts", code: "store", count: 1, reason: "signal:console: `console.warn` names the ETF read; return20d absent" },
  { file: "src/api/http.ts", code: "return Response.json(redact(raw), { headers: headers ?? VINTAGE_HEADERS });", count: 1, reason: "stand-in: no handler-passed headers ⇒ `VINTAGE_HEADERS`, the default policy of every redactable read" },
  { file: "src/api/vintage-memo.ts", code: "promise.then(", count: 1, reason: "signal:elsewhere: eviction side-branch only — callers get the original `promise`, which rejects" },
  { file: "src/bottom.ts", code: "ratio: latest?.ratio ?? NaN,", count: 1, reason: "stand-in: warming-up bottom verdict — no latest point ⇒ NaN levels, non-finite, never a number" },
  { file: "src/bottom.ts", code: "vix3m: latest?.vix3m ?? NaN,", count: 1, reason: "stand-in: warming-up bottom verdict — no latest point ⇒ NaN levels, non-finite, never a number" },
  { file: "src/bottom.ts", code: "vix: latest?.vix ?? NaN,", count: 1, reason: "stand-in: warming-up bottom verdict — no latest point ⇒ NaN levels, non-finite, never a number" },
  { file: "src/cash-overlay.ts", code: "const phase: R4Phase = r4Phase ?? \"equity\";", count: 1, reason: "stand-in: a null (pre-migration) `r4_phase` ⇒ R4's initial equity phase, as `api/lab.ts`" },
  { file: "src/chart-rail.ts", code: "const m = (ownMaGate.rule === \"belowMA\" && ownMaGate.maMult) || 1;", count: 1, reason: "stand-in: a `belowMA` gate with no `maMult` ⇒ ×1, the plain MA200 line the scorer tests" },
  { file: "src/chart-rail.ts", code: "const unit = i.unit ?? \"%\"; // mirror the wire-edge unit materialization above", count: 9, reason: "stand-in: registry `unit` absent ⇒ \"%\", the wire-edge unit convention" },
  { file: "src/chart-rail.ts", code: "const velWindow = i.velocityWindow ?? VELOCITY_WINDOW;", count: 1, reason: "stand-in: optional registry window ⇒ the kernel `VELOCITY_WINDOW`" },
  { file: "src/chart-rail.ts", code: "label: `${b.level} ≥${cut.toFixed(1)} (p${Math.round((b.p ?? 0) * 100)} of own history)`,", count: 1, reason: "stand-in: type-only — every `capePct` display band declares its `p` (family-descriptor-rows.ts)" },
  { file: "src/chart-rail.ts", code: "label: `${gatePi?.shortLegSeries ?? \"short leg\"} Δ over ${shortLeg.window} obs`,", count: 1, reason: "stand-in: axis caption — no named feed ⇒ the generic \"short leg\" word" },
  { file: "src/chart-rail.ts", code: "label: velocitySpanWord(i, i.velocityWindow ?? VELOCITY_WINDOW),", count: 1, reason: "stand-in: optional registry window ⇒ the kernel `VELOCITY_WINDOW`" },
  { file: "src/chart-rail.ts", code: "return { ...spec, series: [...spec.series, ...o.series], lead: Math.max(spec.lead ?? 0, o.lead) };", count: 1, reason: "stand-in: no prior `lead` ⇒ 0, the identity inside `Math.max`" },
  { file: "src/chart-rail.ts", code: "return { ...spec, series: [...spec.series, line], lead: Math.max(spec.lead ?? 0, DELTA5_WINDOW) };", count: 1, reason: "stand-in: no prior `lead` ⇒ 0, the identity inside `Math.max`" },
  { file: "src/chart-rail.ts", code: "return { ...spec, series: [...spec.series, line], lead: Math.max(spec.lead ?? 0, RV10_WINDOW) };", count: 1, reason: "stand-in: no prior `lead` ⇒ 0, the identity inside `Math.max`" },
  { file: "src/chart-rail.ts", code: "{ id: \"primary\", side: \"left\", unit: i.unit ?? \"%\", format: \"value\", label: i.label },", count: 1, reason: "stand-in: registry `unit` absent ⇒ \"%\", the wire-edge unit convention" },
  { file: "src/config.ts", code: "return env.LADDER_TZ || DEFAULT_LADDER_TZ;", count: 1, reason: "stand-in: blank/unset LADDER_TZ ⇒ the ladder md's documented render wall clock — display-only, no scored value" },
  { file: "src/confirmers.ts", code: "const lookback = Math.max(VELOCITY_WINDOW, indicator.velocityWindow ?? VELOCITY_WINDOW, indicator.derived?.window ?? 0);", count: 2, reason: "stand-in: optional registry window ⇒ the kernel `VELOCITY_WINDOW`; no derived window ⇒ 0, the identity inside `Math.max`" },
  { file: "src/confirmers.ts", code: "indicator.direction ?? \"HIGH\",", count: 1, reason: "stand-in: registry `direction` absent ⇒ HIGH-firing, the registry default" },
  { file: "src/confirmers.ts", code: "score › } catch (err) {", count: 1, reason: "signal:trace: `recordDegrade` `[vxn-term] … VXNT omitted` — VXNT is display-only (`CHART_ONLY_INDICATORS`), no push caveat" },
  { file: "src/confirmers.ts", code: "scoreVixTermIndicator › } catch (err) {", count: 1, reason: "signal:notify: `onFail` — the VT confirmer warns + `recordDegrade` `[vix-term] volatility term-structure feed unavailable - coincident indicator omitted`; VT omitted, never a false escalation" },
  { file: "src/confirmers.ts", code: "scoreVixTermPersistenceIndicator › } catch (err) {", count: 1, reason: "signal:trace: `recordDegrade` `[vix-term-persist] … confirmer leg omitted` — chart-only VTP, no push caveat" },
  { file: "src/dial-assembly.ts", code: "const bulk = await store", count: 1, reason: "signal:notify: `onReadFail` = the member-history sink — the cron passes `recordDegrade` `[ciss] member-history bulk read failed …`; signal hold off" },
  { file: "src/dial-assembly.ts", code: "p = getObservedSeries(store, id, 2, keepRow).catch((err: unknown): SeriesPoint[] => {", count: 1, reason: "signal:notify: `onReadFail` = the carry sink — the cron passes `recordDegrade` `[dial-carry] <id> …`; member read as dark" },
  { file: "src/domain-fold.ts", code: "const base = at(values, Math.max(0, i - (ind.velocityWindow ?? VELOCITY_WINDOW)));", count: 1, reason: "stand-in: optional registry window ⇒ the kernel `VELOCITY_WINDOW`" },
  { file: "src/domain-fold.ts", code: "const direction = indicator.direction ?? \"HIGH\";", count: 1, reason: "stand-in: registry `direction` absent ⇒ HIGH-firing, the registry default" },
  { file: "src/domain-fold.ts", code: "const floorFactor = cfg.ewmaFloorFactor ?? 0;", count: 1, reason: "stand-in: EWMA floor absent ⇒ 0 = no floor" },
  { file: "src/domain-fold.ts", code: "const w = indicator.velocityWindow ?? VELOCITY_WINDOW;", count: 1, reason: "stand-in: optional registry window ⇒ the kernel `VELOCITY_WINDOW`" },
  { file: "src/domain-fold.ts", code: "return Math.max(cfg.window, 10 * (cfg.ewmaHalfLife ?? 0));", count: 1, reason: "stand-in: EWMA half-life absent ⇒ 0 = no EWMA depth" },
  { file: "src/domain-legs.ts", code: "const direction: Direction = indicator.direction ?? \"HIGH\";", count: 1, reason: "stand-in: registry `direction` absent ⇒ HIGH-firing, the registry default" },
  { file: "src/domain-legs.ts", code: "const high = (indicator.direction ?? \"HIGH\") !== \"LOW\";", count: 1, reason: "stand-in: registry `direction` absent ⇒ HIGH-firing, the registry default" },
  { file: "src/domain-legs.ts", code: "const mode = (severity === \"Amber\" ? policy?.amber : policy?.red) ?? \"or\";", count: 1, reason: "stand-in: no fold policy for the severity ⇒ OR legs, the policy default" },
  { file: "src/estimated.ts", code: "...CHART_ONLY_INDICATORS.filter((i) => (i.obsCadence ?? i.cadence ?? \"daily\") === \"daily\").map((i) => i.id),", count: 1, reason: "stand-in: registry `cadence` absent ⇒ daily, the registry default" },
  { file: "src/estimated.ts", code: "const stored = await store.getSeriesBulk([...new Set(hit.map((r) => r.indicator.id))], { limit: GAP_FILL_DAYS }).catch((err: unknown) => {", count: 1, reason: "signal:notify: `onReadFail` — the cron passes warn + `recordDegrade` `[anchor] stored-row read failed …`; gates on the run's prints alone" },
  { file: "src/exposure.ts", code: "return (resolvedDerivedBands(GT).amber ?? 0) + FIRE_MA_APPROACH_SPREAD;", count: 1, reason: "stand-in: type-only — `GT_AMBER` is a numeric constant and `resolveBands` nulls only a null constant" },
  { file: "src/feed-lag.ts", code: "const cadence = CADENCE_OF.get(id) ?? \"daily\";", count: 2, reason: "stand-in: registry `cadence` absent ⇒ daily, the registry default" },
  { file: "src/feed-lag.ts", code: "const registered = CADENCE_OF.get(id) ?? \"daily\";", count: 1, reason: "stand-in: registry `cadence` absent ⇒ daily, the registry default" },
  { file: "src/feed-lag.ts", code: "explicit: EXPLICIT_OF.get(id) ?? false,", count: 1, reason: "stand-in: a missing explicit entry ⇒ the STRICT arm, which can only over-report DEEP-LAG (comment above)" },
  { file: "src/feed-lag.ts", code: "gridOrAbsent › } catch (err) {", count: 1, reason: "signal:console: injected `warn` `[feed-lag] no publication calendar for <id>` on the read-API stamp; served as `unmeasured: true`" },
  { file: "src/feed-lag.ts", code: "if ((CADENCE_OF.get(id) ?? \"daily\") !== \"daily\") continue;", count: 1, reason: "stand-in: registry `cadence` absent ⇒ daily, the registry default" },
  { file: "src/feed-lag.ts", code: "return new Map([...freshnessScoredIndicators()].map(([id, ind]) => [id, ind.cadence ?? \"daily\"]));", count: 1, reason: "stand-in: registry `cadence` absent ⇒ daily, the registry default" },
  { file: "src/feed-lag.ts", code: "return sorted[idx] ?? 0;", count: 1, reason: "stand-in: type-only — `idx` is clamped into a non-empty `sorted` (the empty case returns above)" },
  { file: "src/fetch-budget.ts", code: "return deadline?.aborted ?? false;", count: 1, reason: "stand-in: no run budget open ⇒ not exhausted (docblock above)" },
  { file: "src/feed-http.ts", code: "const attempts = r?.attempts ?? 1;", count: 1, reason: "stand-in: no `retry` policy ⇒ one attempt, the documented default (docblock above)" },
  { file: "src/feed-http.ts", code: "const backoffMs = r?.backoffMs ?? 0;", count: 1, reason: "stand-in: no `retry` policy ⇒ no backoff — with one attempt it is never slept" },
  { file: "src/feed-http.ts", code: "withRetry › } catch (err) {", count: 1, reason: "signal:elsewhere: the one retry loop — a vetoed error rethrows `err` unwrapped, the last attempt throws `err` or the `giveUp` value; otherwise it sleeps and retries" },
  { file: "src/feed-http.ts", code: "return withRetry(url, (res) => void res.body?.cancel().catch(() => {}), opts);", count: 1, reason: "stand-in: body discard only — the 2xx already resolved `fetchOk`; a failed cancel of an unread body loses nothing" },
  { file: "src/fred.ts", code: "if ((opts.refusedSeries ?? REFUSED_SERIES).has(series)) noFreeSource(series);", count: 1, reason: "stand-in: an uninjected caller ⇒ the policy leaf's set; a refused id throws, nothing is invented" },
  { file: "src/fred.ts", code: "const tradingDays = velocitySigmaDepth(cfg) + (ind.velocityWindow ?? VELOCITY_WINDOW);", count: 1, reason: "stand-in: optional registry window ⇒ the kernel `VELOCITY_WINDOW`" },
  { file: "src/geo.ts", code: "const crisisStage = config.crisisStage ?? 0;", count: 1, reason: "stand-in: `crisisStage` absent ⇒ 0 = no crisis declared (docblock above); a present bad stage throws" },
  { file: "src/geo.ts", code: "return { flagCount: config.flags?.length ?? 0, crisisStage };", count: 1, reason: "stand-in: absent `flags` ⇒ 0 manual flags — a true count" },
  { file: "src/goldens/dispatch.ts", code: "collapse(scoreIndicator(CCC, series(CCC.series), resolveCuts(CCC.id, calib, CCC.direction ?? \"HIGH\"))),", count: 1, reason: "stand-in: registry `direction` absent ⇒ HIGH-firing, the registry default" },
  { file: "src/goldens/dispatch.ts", code: "collapse(scoreIndicator(ECISS, series(\"ECISS\"), resolveCuts(ECISS.id, calib, ECISS.direction ?? \"HIGH\"))),", count: 1, reason: "stand-in: registry `direction` absent ⇒ HIGH-firing, the registry default" },
  { file: "src/goldens/dispatch.ts", code: "collapse(scoreIndicator(HICP, hicpDelta6m(series(HICP_SERIES)), resolveCuts(HICP.id, calib, HICP.direction ?? \"HIGH\"))),", count: 1, reason: "stand-in: registry `direction` absent ⇒ HIGH-firing, the registry default" },
  { file: "src/goldens/dispatch.ts", code: "method: (p[\"method\"] as string | undefined) ?? \"unknown\",", count: 1, reason: "stand-in: offline golden fixture — a vintage row with no `method` keeps the label \"unknown\" (no served/notify path)" },
  { file: "src/growth.ts", code: "num += w * (1 - (c.wsev ?? 0));", count: 1, reason: "stand-in: a live cell with a null severity (fully unobserved) folds at 0, the documented aggregator contract (comment above)" },
  { file: "src/hyoas-vintage.ts", code: "`vintage CSV: first date ${observations[0]?.date ?? \"(none)\"} ≠ ${checks.firstDate}`,", count: 1, reason: "stand-in: error text only — an empty CSV names \"(none)\" in the message it throws" },
  { file: "src/input-series.ts", code: "(storedP ??= readInputSeries(store, [...new Set(idOf.values())], limit, { ...opts, warn, keep: (id, p) => settledClose(inputSeriesSymbolOf(id), p, id) }).catch((err: unknown) => {", count: 1, reason: "signal:notify: warns, then the required `onFail` sink: scoring callers pass `recordDegrade` notify, the SB re-link trace, the post-record leg seed a no-op; the live feed serves as is" },
  { file: "src/input-series.ts", code: "const maxStale = MAX_STALE_DAYS_BY_ID[id] ?? INPUT_MAX_STALE_DAYS;", count: 1, reason: "stand-in: per-id stale bound absent ⇒ the shared `INPUT_MAX_STALE_DAYS`" },
  { file: "src/intraday.ts", code: "return (id === undefined ? undefined : SESSION_CLOSE_UTC_MIN[id]) ?? INTRADAY_CUTOFF_UTC_MIN;", count: 1, reason: "stand-in: an id with no own session close ⇒ the all-markets UTC cutoff, the ruled default (2026-11-06)" },
  { file: "src/intraday.ts", code: "readIntradaySlot › } catch (err) {", count: 1, reason: "signal:console: injected `log` names the read-API surface; serves the EOD verdict" },
  { file: "src/lab-assembly.ts", code: "const w = ind.velocityWindow ?? VELOCITY_WINDOW;", count: 1, reason: "stand-in: optional registry window ⇒ the kernel `VELOCITY_WINDOW`" },
  { file: "src/lab-assembly.ts", code: "notes.push({ id, label: \"LAG\", age: null, p90Gap: null, deepLagBar: null, lagCut: null, registered: CADENCE_OF.get(id) ?? \"daily\" });", count: 1, reason: "stand-in: registry `cadence` absent ⇒ daily, the registry default" },
  { file: "src/lab-attribution.ts", code: "const cuts = resolveCuts(id, synthCalib, indicator.direction ?? \"HIGH\");", count: 1, reason: "stand-in: registry `direction` absent ⇒ HIGH-firing, the registry default" },
  { file: "src/lab-attribution.ts", code: "memoByVintage(\"synth\", firedAt, () => loadSynthHistories(store, (msg, err) => { warn(msg, err); throw err; })).catch(() => {", count: 1, reason: "signal:flag: the loader's `onFail` warns naming the synth ids and rethrows ⇒ `degraded` set, registry priors" },
  { file: "src/lab-attribution.ts", code: "return attributeLeg(store, indicator, calib, synthHistories, dateOf.get(id)!, stateOf.get(id)!).catch(() => {", count: 1, reason: "signal:flag: a per-id store failure sets `degraded` and declines the id `recompute-disagreed`" },
  { file: "src/lab-attribution.ts", code: "store.getCalibration().catch(() => {", count: 1, reason: "signal:flag: a calibration read failure sets `degraded` ⇒ the 200 rides DEGRADED_HEADERS" },
  { file: "src/lab-overlays.ts", code: "? await store", count: 1, reason: "signal:console: `warn` names the ids; /lab leg growth renders warming-up" },
  { file: "src/lab-overlays.ts", code: "? await store.getSeries(id, R5_MIN_OBS + R5_SERIES_PAD).catch((err: unknown): SeriesPoint[] => {", count: 1, reason: "signal:console: `warn` names the id; /lab R5 renders warming-up" },
  { file: "src/lab-overlays.ts", code: "const persisted = await store", count: 1, reason: "signal:console: `warn` names VTP; the /lab overlay is omitted" },
  { file: "src/lab-overlays.ts", code: "const sleeveOf = (rung: number) => (LADDER as readonly string[])[rung - 1] ?? \"-\";", count: 1, reason: "stand-in: display — an off-ladder rung renders the - absence glyph" },
  { file: "src/lab-overlays.ts", code: "headline: r4.cash ? `in cash (${r4.phase ?? \"—\"})` : `phase: ${r4.phase ?? \"—\"}`,", count: 2, reason: "stand-in: display — a null field renders the absence glyph" },
  { file: "src/lab-overlays.ts", code: "value: `pick ${y1.pickSleeve ?? \"—\"} (r${y1.pickRung ?? \"—\"}) over ${(LADDER as readonly string[])[y1.incumbentRung - 1] ?? \"—\"} (r${y1.incumbentRung}) by rel-strength`,", count: 3, reason: "stand-in: display — a null field renders the absence glyph" },
  { file: "src/lab-overlays.ts", code: "{ label: R4_PHASE_FIELD_LABEL, value: r4.phase ?? \"-\" },", count: 1, reason: "stand-in: display — a null field renders the absence glyph" },
  { file: "src/lab-served-field.ts", code: "const points = await store", count: 1, reason: "signal:console: `warn` names the sleeve; sets `readFailed` ⇒ ewPct degrades to warmup" },
  { file: "src/lab-served-field.ts", code: "const stored = await store.getLegPillarLatestGenerator(sleeve, EW_SUPER_GROUP).catch((err: unknown) => {", count: 1, reason: "signal:console: `warn` names the sleeve; ewPct degrades to warmup" },
  { file: "src/ladder-block.ts", code: "const n = (b.staleReviews ?? 0) + 1;", count: 1, reason: "stand-in: counter idiom — no staleReviews entry is a true zero count" },
  { file: "src/ladder-live.ts", code: "const leg = argv.find((a) => a.startsWith(\"--leg=\"))?.slice(6) ?? \"eufin\";", count: 1, reason: "stand-in: CLI argv default leg" },
  { file: "src/ladder-live.ts", code: "const settle = (c: { value: string; verdict: Mark } | null): { value: string; verdict: Mark } => ({ value: c?.value ?? \"—\", verdict: blocked ? \"unmet\" : c && c.verdict !== \"na\" ? c.verdict : signs.length ? \"met\" : \"na\" });", count: 1, reason: "stand-in: md render — a missing cell renders the — absence glyph" },
  { file: "src/ladder-live.ts", code: "export const gatesText = (gates: LadderTranche[\"gates\"]): string => (gates?.length ? ` · gates ${gates.map((g) => MARK[g] ?? \"–\").join(\"\")}` : \"\");", count: 1, reason: "stand-in: md render — an unknown gate mark renders the – absence glyph" },
  { file: "src/ladder-block.ts", code: "export const sourceWindowStart = (s: Pick<LadderSign, \"cadence\">, run: string): string => new Date(Date.parse(run) - Math.max(7, s.cadence ?? 7) * 864e5).toISOString().slice(0, 10);", count: 1, reason: "stand-in: sign cadence absent ⇒ a weekly window, the schema default ([USER] 2026-10-27)" },
  { file: "src/ladder-live.ts", code: "return { s, i, group: leanGroup(s.lean), items, chips, next: chips.find((c) => c.date >= live.run)?.date ?? \"9999\" };", count: 1, reason: "stand-in: sort sentinel — a sign with no upcoming chip sorts last" },
  { file: "src/ladder-run.ts", code: "const failed = (u: string): boolean => (s.fails?.[u] ?? 0) >= 2;", count: 1, reason: "stand-in: counter idiom — no failure entry is a true zero count" },
  { file: "src/ladder-run.ts", code: "const leanBefore = (s: LadderSign, date: string): string => (s.leanLog?.length ? (s.leanLog.filter((x) => x.date < date).at(-1)?.lean ?? \"unknown\") : leanWord(s.lean));", count: 1, reason: "stand-in: no lean logged before the date ⇒ the explicit `unknown` word" },
  { file: "src/ladder-run.ts", code: "const pressDead = live.signs.flatMap((s) => (s.probe ? [] : (s.press ?? [])).filter((u) => (s.fails?.[u] ?? 0) >= 2).map((u) => `${s.sign}: ${u}`));", count: 1, reason: "stand-in: counter idiom — no failure entry is a true zero count" },
  { file: "src/ladder-run.ts", code: "const windowKey = (e: LadderEvent): string => ((h) => (h >= 24 ? `${addDays(e.date, 1)}T00` : `${e.date}T${String(h).padStart(2, \"0\")}`))(OWED_FROM[e.at ?? \"post\"]);", count: 1, reason: "stand-in: `LadderEvent.at` absent ⇒ post-close, the schema default" },
  { file: "src/ladder-run.ts", code: "for (const s of next.signs) if (planned.has(s.sign)) s.due = s.block || isReleased(s, allEvents(next)) || eventWatch(next, s, today, now) ? today : addDays(today, hot.has(s.sign) ? Math.min(HOT_CADENCE_DAYS, s.cadence ?? 7) : (s.cadence ?? 7));", count: 2, reason: "stand-in: sign cadence absent ⇒ a weekly recheck, the schema default" },
  { file: "src/ladder-run.ts", code: "for (const u of p.measuredOnly ? [] : plan.fetch) if (p.failed?.includes(u)) fails[u] = (fails[u] ?? 0) + 1;", count: 1, reason: "stand-in: counter idiom — no failure entry is a true zero count" },
  { file: "src/ladder-run.ts", code: "return !e && (s.quiet ?? 0) >= QUIET_MERGE_AT ? { both: `${head} ${esc} or ${fiz} ${month}` } : { escalation: `${head} ${esc} ${month}`, fizzle: `${head} ${fiz} ${month}` };", count: 1, reason: "stand-in: counter idiom — `LadderSign.quiet` absent is a true zero count" },
  { file: "src/ladder-run.ts", code: "if (/^(UNCHANGED|QUIET)/.test(p.label)) s.quiet = (s.quiet ?? 0) + 1;", count: 1, reason: "stand-in: counter idiom — `LadderSign.quiet` absent is a true zero count" },
  { file: "src/ladder-run.ts", code: "hostOf › } catch {", count: 1, reason: "stand-in: an unparsable URL counts as its own lowercased text (docblock above)" },
  { file: "src/ladder-run.ts", code: "readMeasured › } catch (e) {", count: 1, reason: "signal:flag: the error text rides back as `{ error }` on the plan row" },
  { file: "src/ladder-run.ts", code: "return was === e.status ? [] : [`events   ${e.event} — ${was ?? \"new\"} → ${e.status}`];", count: 1, reason: "stand-in: diff text — no prior status means the event is new" },
  { file: "src/ladder.ts", code: "return AMBITION_THRESHOLDS[ind.cadence ?? \"daily\"];", count: 1, reason: "stand-in: registry `cadence` absent ⇒ daily, the registry default" },
  { file: "src/ladder.ts", code: "return decideUpward((l) => ALERT_RANK[l], last ?? \"OK\", next);", count: 1, reason: "stand-in: no prior alert ⇒ the OK baseline the upward ladder starts from" },
  { file: "src/ladder.ts", code: "return ind.lagAfterDays ?? LAG_THRESHOLDS[ind.cadence ?? \"daily\"];", count: 1, reason: "stand-in: registry `cadence` absent ⇒ daily, the registry default" },
  { file: "src/dates.ts", code: "return now.toLocaleDateString(\"en-CA\", { timeZone: feedTimeZone ?? FEED_CALENDAR_TZ });", count: 1, reason: "stand-in: no per-feed tz ⇒ the shared feed-calendar tz" },
  { file: "src/ladder.ts", code: "return rows.some((r) => (r.cadence ?? \"daily\") === \"daily\" && r.lag === false);", count: 1, reason: "stand-in: registry `cadence` absent ⇒ daily, the registry default" },
  { file: "src/last-print.ts", code: "(i) => (i.obsCadence ?? i.cadence ?? \"daily\") === \"daily\" && !NON_READING_CHANNELS.has(i.channel ?? \"\") && !HELD_ON_CADENCE.has(i.id),", count: 1, reason: "stand-in: registry `cadence` absent ⇒ daily, the registry default" },
  { file: "src/last-print.ts", code: "const cadence = CADENCE_OF.get(id) ?? \"daily\";", count: 1, reason: "stand-in: registry `cadence` absent ⇒ daily, the registry default" },
  { file: "src/notify_format.ts", code: "const reassert = opts.reassertDue ?? false;", count: 1, reason: "stand-in: optional `reassertDue` absent ⇒ no re-assert" },
  { file: "src/notify_format.ts", code: "const span = r.indicator.velocityWindow ?? VELOCITY_WINDOW;", count: 1, reason: "stand-in: optional registry window ⇒ the kernel `VELOCITY_WINDOW`" },
  { file: "src/notify_format.ts", code: "const unit = r.indicator.unit ?? \"%\"; // BRENT/G1 carry unit \"\" — the value renders as the id's own line does", count: 1, reason: "stand-in: registry `unit` absent ⇒ \"%\", the wire-edge unit convention" },
  { file: "src/notify_format.ts", code: "const unit = r.indicator.unit ?? \"%\";", count: 1, reason: "stand-in: registry `unit` absent ⇒ \"%\", the wire-edge unit convention" },
  { file: "src/notify_format.ts", code: "opts.r4 ?? R4_RESTING,", count: 1, reason: "stand-in: no R4 state threaded (sim/test callers) ⇒ resting, the run-core.ts cash-parity mirror (docblock above)" },
  { file: "src/notify_format.ts", code: "return head ? ` · est. ${formatMagnitude(head.value)}${r.indicator.unit ?? \"%\"} (${head.state})` : \"\";", count: 1, reason: "stand-in: registry `unit` absent ⇒ \"%\", the wire-edge unit convention" },
  { file: "src/nowcast-score.ts", code: "closes › } catch (err) {", count: 1, reason: "signal:notify: `onFail` names the symbol (the run passes `warnAndDegrade`, a notify `recordDegrade`); the id's estimate is omitted, never invented" },
  { file: "src/nowcast-score.ts", code: "if (e?.kind !== kind) throw new Error(`[nowcast] ${id} has no \"${kind}\" estimator on its registry row (found ${e?.kind ?? \"none\"})`);", count: 1, reason: "stand-in: error text only — a row with no estimator names \"none\" in the message it throws" },
  { file: "src/pension.ts", code: "`[pension] no holdings segment covers ${obsDate} (earliest is ${series[0]?.from ?? \"<empty>\"})`,", count: 1, reason: "stand-in: error text only — an empty holdings series names \"<empty>\" in the message it throws" },
  { file: "src/pension.ts", code: "baseLevel = (priced === null ? out[i - 1] : out[priced]) ?? 1;", count: 1, reason: "stand-in: day 0 has no prior level ⇒ the track's origin 1 (comment above)" },
  { file: "src/pension.ts", code: "if (held.every(([sleeve]) => (eur[sleeve] ?? 0) > 0)) return j;", count: 1, reason: "stand-in: an unpriced sleeve reads 0 ⇒ fails `> 0`, so the day is not a priced base — nothing invented" },
  { file: "src/prod-writes.ts", code: "requireProdWrites › } catch (e) {", count: 1, reason: "signal:elsewhere: stashed in `locateError`; with no env override the refusal throws `cannot locate the .prod-writes switch` naming it — an env `PROD_WRITES` deliberately bypasses the switch file" },
  { file: "src/r4.ts", code: "const current = prior.reentryRung ?? R4_REENTRY_START;", count: 1, reason: "stand-in: a re-entry state with no stored rung ⇒ `R4_REENTRY_START`, the rung the cash exit sets" },
  { file: "src/registry-fred.ts", code: "const firesHighward = (ind.direction ?? \"HIGH\") !== \"LOW\";", count: 1, reason: "stand-in: registry `direction` absent ⇒ HIGH-firing, the registry default" },
  { file: "src/release-delay.ts", code: "return RELEASE_DELAY_OF.get(id) ?? 0;", count: 1, reason: "stand-in: no measured delay ⇒ 0 = unchanged scoring (docblock above)" },
  { file: "src/rotation-commit.ts", code: "const committedRung = rungOfSleeve(heldSleeve) ?? 0; // 0 = absent (the guard below reads it)", count: 1, reason: "stand-in: no held sleeve ⇒ rung 0 = absent; the guard below reads it" },
  { file: "src/run-core.ts", code: "const candidateRung = rungOfSleeve(candidateSleeve) ?? 0;", count: 1, reason: "stand-in: no candidate sleeve ⇒ rung 0 = none; consumers gate on `> 0`" },
  { file: "src/run-core.ts", code: "const prevCalmStreak = prevDay?.geoCalmStreak ?? DE_ESCALATION_DAYS;", count: 1, reason: "stand-in: no prior row ⇒ a saturated calm streak, so no de-escalation hold is invented" },
  { file: "src/run-core.ts", code: "const prevConfirmCount = prevConfirmLagging ? 0 : (prevDay?.reriskConfirmCount ?? 0);", count: 1, reason: "stand-in: no prior row ⇒ a zero confirm streak (first run)" },
  { file: "src/run-core.ts", code: "const prevRung = rungOfSleeve(prevHeld) ?? 0;", count: 1, reason: "stand-in: no held sleeve ⇒ rung 0 = unheld; consumers gate on `prevRung > 0`" },
  { file: "src/run-core.ts", code: "fallShape: fallShape?.shape ?? \"indeterminate\",", count: 1, reason: "stand-in: no fall-shape read ⇒ the explicit `indeterminate` absence word" },
  { file: "src/run-core.ts", code: "fallShape?.shape ?? \"indeterminate\",", count: 1, reason: "stand-in: no fall-shape read ⇒ the explicit `indeterminate` absence word" },
  { file: "src/run-core.ts", code: "geoFlags: frozen.geoFlags ?? 0,", count: 1, reason: "stand-in: forward-walk replay of a row with no geo flags ⇒ 0, `assembleRun`'s default" },
  { file: "src/run-core.ts", code: "phase: prevDay?.r4Phase ?? \"equity\",", count: 1, reason: "stand-in: no prior row ⇒ R4's initial equity phase" },
  { file: "src/run-core.ts", code: "prevHeldDays: prevDay?.heldDays ?? 0,", count: 1, reason: "stand-in: no prior row ⇒ zero held days (first run)" },
  { file: "src/run-core.ts", code: "trackNotes.find((t) => t.field === field)?.note ?? { push: false, message: null };", count: 1, reason: "stand-in: no track note for the field ⇒ no push, no message" },
  { file: "src/run-cycle-confirmers.ts", code: "fetchSeries(VXNCLS.series, { now: new Date(ctx.runAt), env: ctx.env }).catch((err: unknown): Observation[] => {", count: 1, reason: "signal:trace: `recordDegrade` names VXNCLS — VXNT is display-only (`CHART_ONLY_INDICATORS`), no push caveat" },
  { file: "src/run-cycle-estimates.ts", code: ": await confirmerEstimateRows(FAST_CONFIRMERS.find((c) => c.id === VXNT.id)!, confirmerCtx, vixPts, vxntDates).catch((err: unknown) => {", count: 1, reason: "signal:trace: `recordDegrade` `[nowcast] VXNT EOD estimate row not written` — VXNT is display-only (`CHART_ONLY_INDICATORS`)" },
  { file: "src/run-cycle-feeds.ts", code: "const cuts = resolveCuts(CCC.id, calib, CCC.direction ?? \"HIGH\");", count: 1, reason: "stand-in: registry `direction` absent ⇒ HIGH-firing, the registry default" },
  { file: "src/run-cycle-feeds.ts", code: "const cuts = resolveCuts(ECISS.id, calib, ECISS.direction ?? \"HIGH\");", count: 1, reason: "stand-in: registry `direction` absent ⇒ HIGH-firing, the registry default" },
  { file: "src/run-cycle-feeds.ts", code: "const cuts = resolveCuts(HICP.id, calib, HICP.direction ?? \"HIGH\");", count: 1, reason: "stand-in: registry `direction` absent ⇒ HIGH-firing, the registry default" },
  { file: "src/run-cycle-feeds.ts", code: "const cuts = resolveCuts(T10Y3M_RAW.id, calib, T10Y3M_RAW.direction ?? \"HIGH\");", count: 1, reason: "stand-in: registry `direction` absent ⇒ HIGH-firing, the registry default" },
  { file: "src/run-cycle-feeds.ts", code: "const cuts = resolveCuts(VXNCLS.id, calib, VXNCLS.direction ?? \"HIGH\");", count: 1, reason: "stand-in: registry `direction` absent ⇒ HIGH-firing, the registry default" },
  { file: "src/run-cycle-feeds.ts", code: "const cuts = resolveCuts(VXSMH.id, calib, VXSMH.direction ?? \"HIGH\");", count: 1, reason: "stand-in: registry `direction` absent ⇒ HIGH-firing, the registry default" },
  { file: "src/run-cycle-feeds.ts", code: "p.catch(() => {});", count: 1, reason: "signal:elsewhere: marks the eager ECB fetch handled only; `scoreGlobalFeeds` awaits the same promise inside its `degrade` wrapper" },
  { file: "src/run-cycle-fred.ts", code: ": (await ctx.store.getSeries(indicator.id, FRED_FALLBACK_READ).catch(() => [])).filter(", count: 1, reason: "signal:elsewhere: inside the liveErr catch — an empty stored read lands on its `no stored fallback` recordDegrade" },
  { file: "src/run-cycle-fred.ts", code: "scoreFredBatch › } catch (liveErr) {", count: 1, reason: "signal:notify: every exit from this catch does `recordDegrade` + `console.warn` naming the id" },
  { file: "src/run-cycle-fred.ts", code: "scoreFredBatch › } catch (storeErr) {", count: 1, reason: "signal:notify: `recordDegrade` `[id] non-live - stored fallback failed to score`" },
  { file: "src/run-cycle-graft.ts", code: "p = fetchSovereignQuote(symbol, new Date(base.runAt)).catch((err: unknown) => {", count: 1, reason: "signal:notify: `recordDegrade` `[sovereign-quote] <sym> restQuote unavailable - EOD bars only` — the grafted head is a scored/estimate input; the graft falls back to the bars" },
  { file: "src/run-cycle-push.ts", code: "console.log(`Exposure: ${curr.posture ?? \"insufficient data\"} - ${curr.summary}`);", count: 1, reason: "stand-in: console log text only" },
  { file: "src/run-cycle-push.ts", code: "console.log(`No push (${last?.level ?? \"—\"} -> ${alert.level}; re-assert not due) - silent.`);", count: 1, reason: "stand-in: console log text only" },
  { file: "src/run-cycle.ts", code: "const published = resolvePersistedCashLevel(row?.r4Phase ?? null, row?.cashOverlay ?? \"off\", floored.equityPct);", count: 1, reason: "stand-in: no prior exposure row ⇒ overlay off, the persisted column default" },
  { file: "src/run-dbfirst.ts", code: "? resolveBreadthCloses(sym, runAt, env, ctx, shallowCloses).catch((err: unknown): Observation[] => {", count: 1, reason: "signal:notify: `recordDegrade` names the soft symbol — its `soft` rows score `[]` (absent, never invented), a scored input gone" },
  { file: "src/run-dbfirst.ts", code: "gapFillSeries › } catch (err) {", count: 1, reason: "signal:trace: `recordDegrade` `[gap-fill] <id>: skipped this run` — gap-fill repair only, this run's reading is untouched" },
  { file: "src/run-inputs.ts", code: "crisisStage: opts.crisisStage ?? 0,", count: 1, reason: "stand-in: optional input ⇒ crisis stage 0, `assembleRun`'s own default" },
  { file: "src/run-inputs.ts", code: "geoFlags: opts.geoFlags ?? 0,", count: 1, reason: "stand-in: optional input ⇒ 0 manual geo flags, `assembleRun`'s own default" },
  { file: "src/run-memo.ts", code: "promise.catch(() => {", count: 1, reason: "signal:elsewhere: eviction side-branch only — callers get the original `promise`, which rejects" },
  { file: "src/run-seeds.ts", code: "`[backfill] ${id}: refusing official-gap rewrite — ${gapDates.size} gap date(s) over ${span} row(s) ≥ ${reshadowFloor ?? \"(no floor)\"} (> ${OFFICIAL_GAP_MAX_SHARE * 100}%); the official fetch looks truncated`,", count: 1, reason: "stand-in: console log text only" },
  { file: "src/run-seeds.ts", code: "const days = GAP_FILL_DAYS_OF[id] ?? GAP_FILL_DAYS;", count: 1, reason: "stand-in: an id with no per-id window uses the default `GAP_FILL_DAYS`, the config default" },
  { file: "src/run-seeds.ts", code: "const cadence = ind?.cadence ?? \"daily\";", count: 1, reason: "stand-in: registry `cadence` absent ⇒ daily, the registry default" },
  { file: "src/run-seeds.ts", code: "const eligible = LADDER.filter((s) => (legSeries.get(s)?.length ?? 0) >= Y1_MIN_OBS);", count: 1, reason: "stand-in: an absent leg series has length 0 ⇒ ineligible, nothing invented" },
  { file: "src/run-seeds.ts", code: "gapFillSweep › } catch (err) {", count: 1, reason: "signal:notify: `recordDegrade` `[gap-fill] stored-window probe failed`" },
  { file: "src/run-seeds.ts", code: "seedLegClosesOnCron › } catch (err) {", count: 1, reason: "signal:trace: `[legp] off-ladder <ticker> close feed non-live` — post-drain, persisted by the EOD `updateRunTrace`" },
  { file: "src/scoreboard.ts", code: "chainLegCloseRows › } catch {", count: 1, reason: "stand-in: an uncomputable date (no FX / bad prior close) is skipped and the next chains off the kept anchor — no row invented" },
  { file: "src/scoreboard.ts", code: "eurPoints › } catch {", count: 1, reason: "stand-in: a close with no usable FX is dropped (docblock above) — absence, not a value" },
  { file: "src/scoreboard.ts", code: "spliceProxyCloses › } catch {", count: 1, reason: "stand-in: no proxy € base at the join ⇒ the held € path alone, the docblock's no-join case — no pre-join row invented" },
  { file: "src/scorer-vintage.ts", code: "const name = (proto as { constructor?: { name?: string } }).constructor?.name ?? \"?\";", count: 1, reason: "stand-in: error text only — an unnamed prototype reads \"?\" in the message it throws" },
  { file: "src/scorer-vintage.ts", code: "logic_version: i.logicVersion ?? 1,", count: 1, reason: "stand-in: registry `logicVersion` absent ⇒ 1, the registry default" },
  { file: "src/scorers-composite.ts", code: "const aligned = values[0]?.length ?? 0; // 3-way inner-join length — the real usable days", count: 2, reason: "stand-in: an absent joined series has length 0 — a true count, nothing invented" },
  { file: "src/scorers-composite.ts", code: "const m = c.endpointMean ?? 1;", count: 1, reason: "stand-in: endpoint mean absent ⇒ 1 = the raw value (docblock above)" },
  { file: "src/scorers-composite.ts", code: "const m = desc.cutKind === \"spread\" ? (desc.meanWindow ?? 1) : 1;", count: 1, reason: "stand-in: mean window absent ⇒ 1 = the raw value" },
  { file: "src/scorers-composite.ts", code: "const w = desc.window ?? VELOCITY_WINDOW;", count: 1, reason: "stand-in: optional registry window ⇒ the kernel `VELOCITY_WINDOW`" },
  { file: "src/scorers-composite.ts", code: "return Math.max(desc.window ?? VELOCITY_WINDOW, VELOCITY_WINDOW, desc.levelBand ? levelBandHead(desc.levelBand) : 0);", count: 1, reason: "stand-in: optional registry window ⇒ the kernel `VELOCITY_WINDOW`" },
  { file: "src/scorers-composite.ts", code: "return combineLevelVelocity(desc.combine ?? \"or\", level, velocity);", count: 1, reason: "stand-in: descriptor `combine` absent ⇒ OR, the descriptor default" },
  { file: "src/scorers-core.ts", code: "cadenceById.set(id, r.indicator.cadence ?? \"daily\");", count: 1, reason: "stand-in: registry `cadence` absent ⇒ daily, the registry default" },
  { file: "src/scorers-core.ts", code: "const cadence = indicator.cadence ?? \"daily\";", count: 1, reason: "stand-in: registry `cadence` absent ⇒ daily, the registry default" },
  { file: "src/scorers-core.ts", code: "const minObs = Math.max(window, redWindow ?? 0) + CONFIRM_CLOSES;", count: 1, reason: "stand-in: absent red window ⇒ 0, the identity inside `Math.max`" },
  { file: "src/scorers-core.ts", code: "const padded = [...(new Array<number>(window - 1).fill(means[0] ?? 0)), ...means];", count: 1, reason: "stand-in: unreachable fill — empty `means` ⇒ fewer obs than `window` ⇒ no reading emitted" },
  { file: "src/scorers-core.ts", code: "gridFor › } catch {", count: 1, reason: "stand-in: `containmentGrid` throw ⇒ null = an ABSENCE (not assessed), never a coalesced grid (docblock above)" },
  { file: "src/scorers-core.ts", code: "levelStates: velocityStates.map((_, k) => levelGateState(values, baseOffset + k, levelWindow, proximity ?? 1)),", count: 1, reason: "stand-in: level-gate proximity absent ⇒ 1 = the cut itself" },
  { file: "src/scorers-core.ts", code: "rawLegs && rawStates.length > 0 && (spec.confirm ?? true)", count: 1, reason: "stand-in: spec `confirm` absent ⇒ true, the confirmed-fold default" },
  { file: "src/scorers-core.ts", code: "return dv.kind === \"highDist\" || dv.kind === \"lowRise\" || (isWindowBack(dv.kind) && (dv.amber ?? 0) >= 0);", count: 1, reason: "stand-in: direction inference only — a band with no amber reads highward" },
  { file: "src/scorers-core.ts", code: "spec.confirm ?? true,", count: 1, reason: "stand-in: spec `confirm` absent ⇒ true, the confirmed-fold default" },
  { file: "src/scorers-price.ts", code: "const window = indicator.derived?.window ?? 0;", count: 1, reason: "stand-in: no derived window ⇒ 0 = no extra lookback" },
  { file: "src/series-db-first.ts", code: "export const dbFirstReadCap = (feed: DbFirstFeedSpec): number => Math.max(feed.needRows, feed.minRows ?? 0);", count: 1, reason: "stand-in: no `minRows` ⇒ 0, the identity inside `Math.max`" },
  { file: "src/slow.ts", code: "runLen[i] = closes[i]! > cut ? 0 : (runLen[i - 1] ?? 0) + 1;", count: 1, reason: "stand-in: counter idiom — day 0 has no prior run, a true zero" },
  { file: "src/store-guards.ts", code: "return ids.filter((id) => (bucketed.get(id)?.length ?? 0) < limit);", count: 1, reason: "stand-in: an absent bucket has length 0 — a true count, so the id is re-fetched" },
  { file: "src/store-memory.ts", code: "(cutoff === null || Date.parse(r.runAt) < cutoff) && !(pinned?.has(Date.parse(r.runAt)) ?? false);", count: 1, reason: "stand-in: test fake — no pin set ⇒ unpinned, mirroring `p_pin_alert_runs`" },
  { file: "src/store-memory.ts", code: "const observed = Math.min(count, assumedCap, this.maxRowsCap ?? Number.POSITIVE_INFINITY);", count: 1, reason: "stand-in: test fake — no simulated `max_rows` ⇒ unbounded" },
  { file: "src/store-memory.ts", code: "const retainMs = (retainDays ?? 0) * 86_400_000;", count: 1, reason: "stand-in: null retain ⇒ 0, mirroring the SQL `p_retain_days` null" },
  { file: "src/store-rows.ts", code: "const withDegradeEffect = (e: Omit<DegradeEvent, \"effect\"> & Partial<Pick<DegradeEvent, \"effect\">>): DegradeEvent => ({ ...e, effect: e.effect ?? \"notify\" });", count: 1, reason: "stand-in: a legacy `degraded` event without `effect` reads `notify` — every pre-channel event could fire the push caveat" },
  { file: "src/store.ts", code: "const total = count ?? 0;", count: 1, reason: "stand-in: error thrown above; a null head count reads as an empty table ⇒ no cap probe" },
  { file: "src/store.ts", code: "return (data as number | null) ?? 0;", count: 1, reason: "stand-in: error thrown above; a null RPC result is zero rows pruned" },
  { file: "src/store.ts", code: "return count ?? 0;", count: 1, reason: "stand-in: error thrown above; a null `count` is zero rows deleted" },
  { file: "src/store.ts", code: "return del.count ?? 0;", count: 2, reason: "stand-in: error thrown above; a null `count` is zero rows deleted" },
  { file: "src/store.ts", code: "total += count ?? 0;", count: 1, reason: "stand-in: error thrown above; a null `count` is zero rows deleted" },
  { file: "src/store.ts", code: "total += del.count ?? 0;", count: 1, reason: "stand-in: error thrown above; a null `count` is zero rows deleted" },
  { file: "src/store.ts", code: "return { count: total, observed: data?.length ?? 0 };", count: 1, reason: "stand-in: error thrown above; a null body is 0 rows observed — a true count" },
  { file: "src/synth-cuts.ts", code: ": computeSynthCuts(history, prior, indicator.velocityWindow ?? SYNTH_VEL_WINDOW),", count: 1, reason: "stand-in: optional registry window ⇒ the module `SYNTH_VEL_WINDOW`" },
  { file: "src/synth-cuts.ts", code: "indicator.velocityWindow ?? SYNTH_VEL_WINDOW,", count: 1, reason: "stand-in: optional registry window ⇒ the module `SYNTH_VEL_WINDOW`" },
  { file: "src/synth-cuts.ts", code: "loadSynthHistoriesDated › } catch (err) {", count: 1, reason: "signal:notify: `onFail` names the synth ids — the cron passes warn + `recordDegrade` notify; registry priors this run" },
  { file: "src/tracks.ts", code: "fragileCalm: v ? (v.fragileCalm ?? false) : false,", count: 1, reason: "stand-in: an absent `fragileCalm` ⇒ false = no floor (comment above)" },
  { file: "src/treasury.ts", code: "fetchTreasuryCurveSafe › } catch (err) {", count: 1, reason: "signal:notify: `warn` names the curve; the cron's `runFail` sink (`startTreasuryMemo`) records `recordDegrade` `[treasury] …` notify" },
  { file: "src/vix_term.ts", code: "fetchVixSeries › } catch (err) {", count: 1, reason: "signal:notify: `onFail` — the run passes warn + `recordDegrade` `[vix_term] <series> unavailable from FRED - VT omitted, bottom track null (not CALM) this run`" },
  { file: "src/y1.ts", code: "const eligible = LADDER.filter((s) => (legSeries.get(s)?.length ?? 0) >= Y1_MIN_OBS);", count: 1, reason: "stand-in: an absent leg series has length 0 ⇒ ineligible, nothing invented" },
  { file: "src/y1.ts", code: "const n = zCount.get(sleeve) ?? 0;", count: 1, reason: "stand-in: counter idiom — no entry is a true zero count; gated on `n > 0`" },
  { file: "src/y1.ts", code: "zCount.set(sleeve, (zCount.get(sleeve) ?? 0) + 1);", count: 1, reason: "stand-in: counter idiom — no entry yet is a true zero count" },
  { file: "src/y1.ts", code: "zSum.set(sleeve, (zSum.get(sleeve) ?? 0) + (value - mean) / sd);", count: 1, reason: "stand-in: counter idiom — no entry yet is a true zero sum" },
];

/** `FILES` of the stand-ins roster, read off its AST — importing the test module would re-register its tests here. */
function standInFiles(): string[] {
  const sf = ts.createSourceFile(STAND_INS, readFileSync(STAND_INS, "utf8"), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: TS.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === "FILES" && n.initializer) {
      const arr = unwrap(n.initializer);
      if (ts.isArrayLiteralExpression(arr)) for (const el of arr.elements) if (ts.isStringLiteral(el)) out.push(`src/${el.text}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** A numeric literal, `NaN` or `Infinity`, optionally negated. */
function isNumber(e: TS.Expression): boolean {
  const u = ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken ? e.operand : e;
  return ts.isNumericLiteral(u) || (ts.isIdentifier(u) && (u.text === "NaN" || u.text === "Infinity"));
}
const isLiteral = (e: TS.Expression): boolean => isNumber(e) || ts.isStringLiteralLike(e);
/** A SCREAMING_CASE identifier or property (`EMPTY_BULK`, `Number.POSITIVE_INFINITY`) — a module-constant fallback. */
function isConstant(e: TS.Expression): boolean {
  const u = unwrap(e);
  const name = ts.isIdentifier(u) ? u.text : ts.isPropertyAccessExpression(u) ? u.name.text : "";
  return /^[A-Z][A-Z0-9_]{2,}$/.test(name);
}
/** An invented value: literal, constant, `null`/`undefined`/`void x`, `true|false`, zero-arg `new X()`, or an array/object literal of only these. */
function isDefault(e: TS.Expression): boolean {
  const u = unwrap(e);
  if (isLiteral(u) || isConstant(u) || ts.isVoidExpression(u) || (ts.isIdentifier(u) && u.text === "undefined")) return true;
  if ([ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(u.kind)) return true;
  if (ts.isNewExpression(u)) return (u.arguments?.length ?? 0) === 0;
  if (ts.isArrayLiteralExpression(u)) return u.elements.every(isDefault);
  return ts.isObjectLiteralExpression(u) && u.properties.every((p) => ts.isPropertyAssignment(p) && isDefault(p.initializer));
}
const EMPTY_COLLECTION = /^(Map|Set|WeakMap|WeakSet|Array)$/;
/** `?? null|undefined|void x|""` or an empty `[]`/`{}`/`new Map()`-style collection keeps the absence visible — no value invented. */
function preservesAbsence(e: TS.Expression): boolean {
  const u = unwrap(e);
  if (ts.isNewExpression(u)) return ts.isIdentifier(u.expression) && EMPTY_COLLECTION.test(u.expression.text) && (u.arguments?.length ?? 0) === 0;
  return u.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(u) || (ts.isIdentifier(u) && u.text === "undefined") ||
    (ts.isStringLiteralLike(u) && u.text === "") || (ts.isArrayLiteralExpression(u) && u.elements.length === 0) ||
    (ts.isObjectLiteralExpression(u) && u.properties.length === 0);
}
const SIGNAL_NAME = /^(warn|log|degrade)$|Fail|Error|Degrade/;
/** `console.*`, a callee named like a reporter (`SIGNAL_NAME`), or a statement-level call handed the caught error — never a predicate over it. */
function isSignal(c: TS.CallExpression, err: string | undefined): boolean {
  const f = c.expression;
  if (ts.isPropertyAccessExpression(f) && ts.isIdentifier(f.expression) && f.expression.text === "console") return true;
  if (SIGNAL_NAME.test(ts.isIdentifier(f) ? f.text : ts.isPropertyAccessExpression(f) ? f.name.text : "")) return true;
  let p = c.parent;
  while (ts.isAwaitExpression(p) || ts.isVoidExpression(p) || ts.isParenthesizedExpression(p)) p = p.parent;
  const statementLevel = ts.isExpressionStatement(p) || ts.isReturnStatement(p) || ts.isArrowFunction(p);
  return statementLevel && err !== undefined && c.arguments.some((a) => has(a, (x) => ts.isIdentifier(x) && x.text === err));
}
/** `Promise.reject(…)`, also as a comma sequence's last operand — a rethrow in value position. */
function rejects(e: TS.Expression): boolean {
  let u = unwrap(e);
  while (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.CommaToken) u = unwrap(u.right);
  return ts.isCallExpression(u) && u.expression.getText() === "Promise.reject";
}
/** One rule for both catch forms: no unconditional top-level rethrow, and it returns an invented value or makes no signal call. */
function swallows(body: TS.ConciseBody, err: string | undefined): boolean {
  if (ts.isBlock(body)) {
    if (body.statements.some((s) => ts.isThrowStatement(s) || (ts.isReturnStatement(s) && s.expression !== undefined && rejects(s.expression)))) return false;
    if (has(body, (x) => ts.isReturnStatement(x) && x.expression !== undefined && isDefault(x.expression))) return true;
  } else if (rejects(body)) return false;
  else if (isDefault(body)) return true;
  return !has(body, (x) => ts.isCallExpression(x) && isSignal(x, err));
}
const bindingName = (b: TS.BindingName | undefined): string | undefined => (b && ts.isIdentifier(b) ? b.text : undefined);
/** Inside a loop, every statement is `<ident> = <catch binding>` — a retry loop stashing its error for the post-loop rethrow. */
function stashesOnly(c: TS.CatchClause): boolean {
  const v = bindingName(c.variableDeclaration?.name);
  let inLoop = false;
  for (let p: TS.Node = c.parent; p && !ts.isFunctionLike(p) && !inLoop; p = p.parent) inLoop = ts.isIterationStatement(p, false);
  return inLoop && v !== undefined && c.block.statements.every((s) =>
    ts.isExpressionStatement(s) && ts.isBinaryExpression(s.expression) && s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(s.expression.right) && s.expression.right.text === v);
}
function armOf(n: TS.Node): Arm | null {
  if (ts.isCatchClause(n)) {
    if (n.block.statements.length === 0) return "catch-empty";
    return !stashesOnly(n) && swallows(n.block, bindingName(n.variableDeclaration?.name)) ? "catch-default" : null;
  }
  if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && (n.expression.name.text === "catch" || n.expression.name.text === "then")) {
    const isCatch = n.expression.name.text === "catch";
    const fn = n.arguments[isCatch ? 0 : 1];
    if (!fn) return null;
    if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return "promise-named";
    return swallows(fn.body, bindingName(fn.parameters[0]?.name)) ? (isCatch ? "promise-swallow" : "then-swallow") : null;
  }
  if (!ts.isBinaryExpression(n)) return null;
  const op = n.operatorToken.kind;
  const r = unwrap(n.right);
  if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.QuestionQuestionEqualsToken) {
    return isDefault(r) && !preservesAbsence(r) ? "default-qq" : null;
  }
  if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.BarBarEqualsToken) {
    const l = unwrap(n.left);
    const numberCall = ts.isCallExpression(l) && ts.isIdentifier(l.expression) && l.expression.text === "Number";
    return isNumber(r) || isConstant(r) || numberCall ? "default-or" : null;
  }
  return null;
}
const VISITOR: Visitor = { visit: armOf, label: (n, src) => (ts.isCatchClause(n) ? `${owner(n)} › ${src}` : src) };

/** The handler a `.catch(x)` / `.then(ok, x)` names instead of inlining — it counts as a callee of the handler. */
function namedHandler(n: TS.Node): TS.Expression | undefined {
  if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return undefined;
  const fn = n.expression.name.text === "catch" ? n.arguments[0] : n.expression.name.text === "then" ? n.arguments[1] : undefined;
  return fn && !ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn) ? fn : undefined;
}
/** Every callee the handler invokes, never crossing into a nested function. */
function callees(h: Hit): TS.Expression[] {
  const out: TS.Expression[] = [];
  has(handlerBody(h.node), (x) => (ts.isCallExpression(x) && out.push(unwrap(x.expression)), false));
  const named = namedHandler(h.node);
  return named ? [...out, unwrap(named)] : out;
}
const EFFECT_ARG: Readonly<Record<string, number>> = { recordDegrade: 2, degrade: 1 };
/** The effect each `recordDegrade(…, "<e>")` / `degrade(…, "<e>", …)` call in the handler passes; a non-literal reads `?`. */
function channelEffects(h: Hit): string[] {
  const out: string[] = [];
  has(handlerBody(h.node), (x) => {
    const at = ts.isCallExpression(x) && ts.isIdentifier(x.expression) ? EFFECT_ARG[x.expression.text] : undefined;
    if (at !== undefined) { const e = (x as TS.CallExpression).arguments[at]; out.push(e && ts.isStringLiteral(e) ? e.text : "?"); }
    return false;
  });
  return out;
}
const WARN_NAME = /^(warn|log|error)$/;
/** `console.*`, or a callee named `warn`/`log`/`error` (an injected logger), also as either side of `a ?? b`. */
function isWarnCallee(f: TS.Expression): boolean {
  if (ts.isBinaryExpression(f) && f.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) return isWarnCallee(unwrap(f.left)) || isWarnCallee(unwrap(f.right));
  if (ts.isIdentifier(f)) return WARN_NAME.test(f.text);
  return ts.isPropertyAccessExpression(f) && (f.expression.getText() === "console" || WARN_NAME.test(f.name.text));
}
const rootName = (f: TS.Expression): string | undefined => {
  let u = f;
  while (ts.isPropertyAccessExpression(u)) u = unwrap(u.expression);
  return ts.isIdentifier(u) ? u.text : undefined;
};
function bindingNames(b: TS.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(b)) out.add(b.text);
  else for (const el of b.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
}
/** Names injected into the handler's scope: an enclosing function's parameters (destructured too) or a module-level `let` latch. */
function injectedNames(n: TS.Node): Set<string> {
  const out = new Set<string>();
  for (let p = n.parent; p; p = p.parent) if (ts.isFunctionLike(p)) for (const prm of p.parameters) bindingNames(prm.name, out);
  for (const st of n.getSourceFile().statements) {
    if (ts.isVariableStatement(st) && st.declarationList.flags & ts.NodeFlags.Let) for (const d of st.declarationList.declarations) bindingNames(d.name, out);
  }
  return out;
}
/** A channel-shaped sink name (`onFail`, `warnAndDegrade`); a logger (`warn`) or a seam (`store`, `opts`) never is. */
const isSinkName = (n: string): boolean => /Fail|Degrade/.test(n) && !WARN_NAME.test(n);
/** `signal:notify` / `signal:trace`: the matching channel literal, or a call to an injected channel-shaped sink the reason names in backticks. */
const onChannel = (effect: "notify" | "trace"): ReasonCheck => (h, reason) => {
  const effects = channelEffects(h);
  if (effects.includes(effect)) return null;
  const injected = injectedNames(h.node);
  if (callees(h).some((f) => { const n = rootName(f); return n !== undefined && isSinkName(n) && injected.has(n) && reason.includes(`\`${n}\``); })) return null;
  return effects.length > 0
    ? `records "${effects.join("/")}" on the channel, not "${effect}"`
    : `no recordDegrade(…, "${effect}") / degrade(…, "${effect}", …) call, nor a call to an injected /Fail|Degrade/ sink the reason names in backticks`;
};

/** The cron entry: a module in its static import graph is cron path, read-API handlers' shared modules included. */
const CRON_ENTRY = "src/run-cycle.ts";
let cronMods: Set<string> | undefined;
const cronModules = (): Set<string> => (cronMods ??= new Set(reachable(CRON_ENTRY).keys()));
const cronImportMemo = new Map<string, Set<string> | "all">();
/** The names cron-path modules import or re-export from `file` (`"all"`: the entry, a namespace import, `export *`). */
function cronImports(file: string): Set<string> | "all" {
  if (file === CRON_ENTRY) return "all";
  const memo = cronImportMemo.get(file);
  if (memo) return memo;
  const names = new Set<string>();
  let all = false;
  for (const imp of cronModules()) {
    if (imp === file || !directImports(imp).includes(file)) continue;
    for (const st of ts.createSourceFile(imp, readFileSync(imp, "utf8"), ts.ScriptTarget.Latest, true).statements) {
      if (!(ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) || !st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier)) continue;
      if (resolveSpec(imp, st.moduleSpecifier.text) !== file) continue;
      const clause = ts.isImportDeclaration(st) ? st.importClause : undefined;
      if (clause?.isTypeOnly || (ts.isExportDeclaration(st) && st.isTypeOnly)) continue;
      if (clause?.name) names.add("default");
      const list = ts.isImportDeclaration(st) ? clause?.namedBindings : st.exportClause;
      if (ts.isExportDeclaration(st) && !list) all = true;
      else if (list && (ts.isNamespaceImport(list) || ts.isNamespaceExport(list))) all = true;
      else if (list) for (const el of list.elements) if (!el.isTypeOnly) names.add((el.propertyName ?? el.name).text);
    }
  }
  const out = all ? "all" : names;
  cronImportMemo.set(file, out);
  return out;
}
/** Names a top-level statement declares; `[]` for one that runs at load. */
function declared(st: TS.Statement): string[] {
  if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) return [st.name?.text ?? "default"];
  if (ts.isEnumDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) return [st.name.text];
  if (!ts.isVariableStatement(st)) return [];
  const out = new Set<string>();
  for (const d of st.declarationList.declarations) bindingNames(d.name, out);
  return [...out];
}
const cronLiveMemo = new WeakMap<TS.SourceFile, Set<TS.Statement>>();
/** Top-level statements the cron can run: what cron modules import, load-time code, and every same-file declaration those reference. */
function cronLive(file: string, sf: TS.SourceFile): Set<TS.Statement> {
  const memo = cronLiveMemo.get(sf);
  if (memo) return memo;
  const imported = cronImports(file);
  const byName = new Map(sf.statements.flatMap((st) => declared(st).map((n) => [n, st] as const)));
  const live = new Set<TS.Statement>();
  const queue: TS.Statement[] = [];
  const mark = (st: TS.Statement): void => void (live.has(st) || (live.add(st), queue.push(st)));
  for (const st of sf.statements) {
    const names = declared(st);
    const atLoad = names.length === 0 || (ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => d.initializer && !ts.isFunctionLike(unwrap(d.initializer))));
    if (imported === "all" || atLoad || names.some((n) => imported.has(n))) mark(st);
  }
  const refs = (x: TS.Node): void => {
    const d = ts.isIdentifier(x) ? byName.get(x.text) : undefined;
    if (d) mark(d);
    ts.forEachChild(x, refs);
  };
  while (queue.length > 0) refs(queue.pop()!);
  cronLiveMemo.set(sf, live);
  return live;
}
/** Cron path: the hit's module is reached from `CRON_ENTRY` and its top-level declaration is one the cron can run. */
function onCronPath(h: Hit): boolean {
  if (!cronModules().has(h.file)) return false;
  let top: TS.Node = h.node;
  while (top.parent && !ts.isSourceFile(top.parent)) top = top.parent;
  return cronLive(h.file, h.node.getSourceFile()).has(top as TS.Statement);
}
/** Identifier and string/template text outside the handler — comments excluded by construction. */
function textOutside(h: Hit): string[] {
  const out: string[] = [];
  const go = (x: TS.Node): void => {
    if (x === h.node) return;
    if (ts.isIdentifier(x) || ts.isStringLiteralLike(x) || ts.isTemplateHead(x) || ts.isTemplateMiddle(x) || ts.isTemplateTail(x)) out.push(x.text);
    ts.forEachChild(x, go);
  };
  go(h.node.getSourceFile());
  return out;
}
/** A backticked span of the reason (`…` splits it) whose every fragment occurs in one code text of the file, outside the handler. */
function namesItsElsewhere(h: Hit, reason: string): boolean {
  const texts = textOutside(h);
  return [...reason.matchAll(/`([^`]+)`/g)].some(([, span]) => {
    const frags = span!.split("…").map((f) => f.trim()).filter(Boolean);
    return frags.length > 0 && texts.some((t) => frags.every((f) => t.includes(f)));
  });
}
const signalsElsewhere: ReasonCheck = (h, reason) => {
  if (!yieldsNothing(h)) return "the handler yields a value - signal it here instead";
  const calls = callees(h);
  if (calls.length > 0 && calls.every(isWarnCallee)) return "its only effect is a warn - that is `signal:console`";
  if (onCronPath(h) && !namesItsElsewhere(h, reason)) return `a cron-path swallow (reached from ${CRON_ENTRY}) - name, in backticks, the code outside the handler that signals it`;
  return null;
};
/** A value-free handler: every return and assignment yields an absence (or the caught error itself). */
function yieldsNothing(h: Hit): boolean {
  const body = handlerBody(h.node);
  const err = ts.isCatchClause(h.node) ? h.node.variableDeclaration?.name.getText() : undefined;
  if (!ts.isBlock(body)) return ts.isExpression(body) && (preservesAbsence(body) || rejects(body));
  return !has(body, (x) =>
    (ts.isReturnStatement(x) && x.expression !== undefined && !preservesAbsence(x.expression)) ||
    (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.EqualsToken && !preservesAbsence(x.right) && x.right.getText() !== err));
}
const FLAG = /degraded|failed/i;
/** Sets `<…degraded|failed…> = true`, or builds an object with `degraded: true` / a non-absent `error` key, for the caller to serve. */
const setsFlag = (h: Hit): boolean =>
  has(handlerBody(h.node), (x) =>
    (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.EqualsToken && FLAG.test(x.left.getText()) && x.right.kind === ts.SyntaxKind.TrueKeyword) ||
    ts.isShorthandPropertyAssignment(x) && x.name.text === "error" ||
    (ts.isPropertyAssignment(x) && ((x.name.getText() === "error" && !preservesAbsence(x.initializer)) || (x.name.getText() === "degraded" && x.initializer.kind === ts.SyntaxKind.TrueKeyword))));
const warns = (h: Hit): boolean => callees(h).some(isWarnCallee);
const REASONS: Readonly<Record<string, ReasonCheck | null>> = {
  "stand-in": null,
  "signal:notify": onChannel("notify"),
  "signal:trace": onChannel("trace"),
  "signal:post-record": (h) => (!warns(h) ? "no console/`warn` call" : channelEffects(h).length > 0 ? "records on the channel after `recordRun` - the event is lost" : null),
  "signal:console": (h) => (onCronPath(h) ? `cron path (reached from ${CRON_ENTRY}) - record on the channel` : warns(h) ? null : "no console/`warn` call naming the id"),
  "signal:elsewhere": signalsElsewhere,
  "signal:flag": (h) => (setsFlag(h) ? null : "no `degraded`/`failed` flag set and no `error` key returned"),
};
/** Each `withStoredLegs` caller's `onFail` channel, per file in call order; `no-op` only after `recordRun` (the seeds). */
const STORED_LEGS_ON_FAIL: Readonly<Record<string, readonly string[]>> = {
  "src/run-cycle-confirmers.ts": ["notify"],
  "src/run-cycle-graft.ts": ["notify"],
  "src/run-cycle-persist.ts": ["trace"],
  "src/run-dbfirst.ts": ["notify"],
  "src/run-seeds.ts": ["no-op", "no-op"],
};
const NO_OP_FILE = "src/run-seeds.ts";
/** `onFail:` as `(…) => recordDegrade(…, "<effect>")` ⇒ the effect; an empty / absence-only fn (a same-file const too) ⇒ `no-op`; else `?`. */
function onFailEffect(call: TS.CallExpression): string {
  const opts = call.arguments[4] && unwrap(call.arguments[4]);
  const prop = opts && ts.isObjectLiteralExpression(opts) ? opts.properties.find((p) => p.name?.getText() === "onFail") : undefined;
  let fn: TS.Expression | undefined = prop && ts.isPropertyAssignment(prop) ? unwrap(prop.initializer) : undefined;
  if (fn && ts.isIdentifier(fn)) {
    const name = fn.text;
    let init: TS.Expression | undefined;
    const find = (x: TS.Node): void => void (ts.isVariableDeclaration(x) && ts.isIdentifier(x.name) && x.name.text === name && x.initializer ? (init = unwrap(x.initializer)) : ts.forEachChild(x, find));
    find(call.getSourceFile());
    fn = init;
  }
  if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return "?";
  const stmts = ts.isBlock(fn.body) ? fn.body.statements : undefined;
  const expr = stmts === undefined ? (fn.body as TS.Expression) : stmts.length === 1 && ts.isExpressionStatement(stmts[0]!) ? stmts[0].expression : undefined;
  if (stmts?.length === 0 || (expr && preservesAbsence(expr))) return "no-op";
  const c = expr && unwrap(expr);
  const effect = c && ts.isCallExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === "recordDegrade" ? c.arguments[2] : undefined;
  return effect && ts.isStringLiteral(effect) ? effect.text : "?";
}
/** The stand-ins roster owns its FILES' `??`/`||` defaults; the catch/promise arms scan them here too. */
const ownedByStandIns = (h: Hit, standIns: readonly string[]): boolean => standIns.includes(h.file) && h.kind.startsWith("default-");

describe("silent-failure roster - swallow / literal-default sites in src+api", () => {
  let excluded: string[];
  let files: string[];
  let report: ScanReport;
  beforeAll(async () => {
    ts = await loadTs();
    excluded = standInFiles();
    files = sourceFiles("src/", "api/");
    report = scan({ ...VISITOR, files, keep: (h) => !ownedByStandIns(h, excluded), roster: ROSTER, reasons: REASONS });
  }, SCAN_HOOK_TIMEOUT);

  it("reads the stand-ins roster's FILES off its AST, every one exists, and only its default arms are ceded", () => {
    expect(excluded).toContain("src/danger-engine.ts");
    expect(excluded.filter((f) => !existsSync(f))).toEqual([]);
    expect(files).toEqual(expect.arrayContaining(excluded));
    const own = scanText(excluded[0]!, "const q = x ?? 0;\np.catch(() => []);", VISITOR).filter((h) => !ownedByStandIns(h, excluded));
    expect(own.map((h) => h.kind)).toEqual(["promise-swallow"]);
  });

  it("the scan sees src+api (vacuity anchor on a named stable roster member)", () => {
    expect(report.hits.some((h) => h.file === "src/notify_format.ts" && h.code === "const span = r.indicator.velocityWindow ?? VELOCITY_WINDOW;")).toBe(true);
  });

  it("every hit is rostered, no row is stale or off-count, and each reason names a declared kind", () => {
    expectClean(report, {
      what: "a catch or default that invents a value",
      why: "a silent fallback scores a dead feed as calm",
      move: `signal the failure on its seam channel, or roster it with a reason of kind ${Object.keys(REASONS).map((k) => `\`${k}:\``).join(" / ")}`,
      never: "widen a predicate here to make the site pass",
    });
  });

  it("each `withStoredLegs` caller wires the `onFail` channel its table row names; a no-op only in the post-`recordRun` seeds", () => {
    const visit = (n: TS.Node): string | null => (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "withStoredLegs" ? onFailEffect(n) : null);
    const got: Record<string, string[]> = {};
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      if (text.includes("withStoredLegs(")) for (const h of scanText(f, text, { visit })) (got[f] ??= []).push(h.kind);
    }
    const strayNoOp = Object.entries(got).filter(([f, e]) => f !== NO_OP_FILE && e.includes("no-op")).map(([f]) => f);
    expect({ got, strayNoOp }).toEqual({ got: STORED_LEGS_ON_FAIL, strayNoOp: [] });
  });

  it("each signal kind's check passes the site that honours it and fails the one that only warns or invents", () => {
    const W = "try { a(); } catch (e) { console.warn(\"[x] down\", e); return []; }";
    const rec = (effect: string): string => `try { a(); } catch (e) { recordDegrade("[x] down", String(e), "${effect}"); return []; }`;
    const sink = "function f(onFail: (m: string) => void) { try { a(); } catch (e) { onFail(\"[x] down\"); return []; } }";
    const CRON = "src/run-cycle-feeds.ts"; // a module the cron entry reaches
    const readOnly = "function readOnly() { try { a(); } catch (e) { console.warn(e); return null; } }";
    const cases: [file: string, text: string, reason: string, ok: boolean][] = [
      ["src/x.ts", rec("trace"), "signal:trace: t", true],
      ["src/x.ts", W, "signal:trace: t", false],
      ["src/x.ts", rec("notify"), "signal:trace: t", false],
      ["src/x.ts", rec("notify"), "signal:notify: t", true],
      ["src/x.ts", W, "signal:notify: t", false],
      ["src/x.ts", "p.catch((e) => { void degrade(\"[x]\", \"notify\", [], g); return []; });", "signal:notify: t", true],
      ["src/x.ts", sink, "signal:notify: `onFail` sink", true],
      ["src/x.ts", sink, "signal:notify: onFail sink", false],
      ["src/x.ts", sink.replace("function f(onFail: (m: string) => void)", "import { onFail } from \"./y.js\"; function f()"), "signal:notify: `onFail` sink", false],
      ["src/x.ts", sink.replace(/onFail/g, "warn"), "signal:notify: `warn` sink", false],
      ["src/x.ts", sink.replace(/onFail\(/g, "store.put(").replace("onFail:", "store:"), "signal:notify: `store` sink", false],
      ["src/x.ts", sink.replace(/onFail/g, "warnAndDegrade"), "signal:notify: `warnAndDegrade` sink", true],
      ["src/run-x.ts", W, "signal:post-record: t", true],
      ["src/run-x.ts", rec("trace").replace("recordDegrade", "console.warn(e); recordDegrade"), "signal:post-record: t", false],
      ["api/x.ts", W, "signal:console: t", true],
      [CRON, W, "signal:console: t", false],
      ["src/intraday.ts", readOnly, "signal:console: t", true],
      ["src/intraday.ts", readOnly.replace("function readOnly", "export function isProvisional"), "signal:console: t", false],
      ["src/intraday.ts", `${readOnly} export function isProvisional() { return readOnly(); }`, "signal:console: t", false],
      ["api/x.ts", rec("trace"), "signal:console: t", false],
      ["src/x.ts", "p.catch(() => undefined);", "signal:elsewhere: t", true],
      ["src/x.ts", "try { a(); } catch { x = 5; }", "signal:elsewhere: t", false],
      ["src/x.ts", W, "signal:elsewhere: t", false],
      ["src/x.ts", "p.catch((e) => { warn(e); return undefined; });", "signal:elsewhere: t", false],
      [CRON, "p.catch(() => []);", "signal:elsewhere: t", false],
      [CRON, "p.catch(() => []); // `gbP` records it", "signal:elsewhere: `gbP` records it", false],
      [CRON, "const gbP = once(f); p.catch(() => []);", "signal:elsewhere: `gbP` records it", true],
      [CRON, "rec(\"[UK] feed unavailable\"); p.catch(() => []);", "signal:elsewhere: `[UK] … unavailable` records it", true],
      ["src/x.ts", "p.catch(() => { degraded = true; return []; });", "signal:flag: t", true],
      ["src/x.ts", "p.catch(() => { return []; });", "signal:flag: t", false],
      ["src/x.ts", "p.catch((e) => ({ error: String(e) }));", "signal:flag: t", true],
      ["src/x.ts", "p.catch(() => ({ error: null }));", "signal:flag: t", false],
    ];
    const verdict = ([file, text, reason]: (typeof cases)[number]): string[] => {
      const hits = scanText(file, text, VISITOR);
      const r = scan({ ...VISITOR, files: [{ file, text }], roster: hits.map((h) => ({ file, code: h.code, count: 1, reason })), reasons: REASONS });
      return hits.length === 1 ? [...r.unrostered, ...r.stale, ...r.badReason] : [`${hits.length} hits`];
    };
    expect(cases.filter((c) => (verdict(c).length === 0) !== c[3]).map((c) => `${c[2]} ⇐ ${c[1]}: ${verdict(c).join("; ") || "clean"}`)).toEqual([]);
  });

  it("every arm fires on its fixture, and the decoys do not", () => {
    const fire: [string, Arm][] = [
      ["try { a(); } catch { /* only a comment */ }", "catch-empty"],
      ["try { a(); } catch (e) { return 0; }", "catch-default"],
      ["try { a(); } catch (e) { if (e instanceof AbortError) throw e; return []; }", "catch-default"],
      ["try { return a(); } catch { metrics.inc(); return EMPTY_BULK; }", "catch-default"],
      ["try { return a(); } catch { return fallback(); }", "catch-default"],
      ["try { a(); } catch (e) { warn(e); return EMPTY_BULK; }", "catch-default"],
      ["try { a(); } catch (e) { warn(e); return { rows: [], degraded: true }; }", "catch-default"],
      ["try { a(); } catch (e) { if (isAbort(e)) return; }", "catch-default"],
      ["try { a(); } catch (err) { lastErr = err; }", "catch-default"],
      ["p.catch(() => []);", "promise-swallow"],
      ["p.catch(() => EMPTY_BULK);", "promise-swallow"],
      ["p.catch(() => { return EMPTY_BULK; });", "promise-swallow"],
      ["p.catch(() => { flag = true; return x; });", "promise-swallow"],
      ["p.catch(() => { cache.delete(k); return x; });", "promise-swallow"],
      ["p.catch((e) => { log(e); return new Map(); });", "promise-swallow"],
      ["p.catch(() => fallback);", "promise-swallow"],
      ["p.catch(() => void 0);", "promise-swallow"],
      ["p.catch((e) => { log(e); return void 0; });", "promise-swallow"],
      ["p.catch(onErr);", "promise-named"],
      ["p.catch(console.warn);", "promise-named"],
      ["p.then(ok, deps.onErr);", "promise-named"],
      ["p.then((v) => v, () => []);", "then-swallow"],
      ["p.then(ok, () => { return EMPTY_BULK; });", "then-swallow"],
      ["p.then(ok, (e) => { log(e); return new Map(); });", "then-swallow"],
      ["p.then(ok, function () { return 0; });", "then-swallow"],
      ["const q = x ?? 0;", "default-qq"],
      ["const s = x ?? FALLBACK_VALUE;", "default-qq"],
      ["const t = x ?? true;", "default-qq"],
      ["const u = x ?? NaN;", "default-qq"],
      ["const v = x ?? new Date();", "default-qq"],
      ["x ??= 0;", "default-qq"],
      ["const o = Number(y) || z;", "default-or"],
      ["const n = x || 1;", "default-or"],
      ["const r = x || DEFAULT_RATE;", "default-or"],
      ["y ||= 0;", "default-or"],
    ];
    const decoys = [
      "const d1 = x ?? null; const d2 = x ?? undefined; const d3 = x ?? []; const d4 = x ?? \"\"; const d5 = x || \"—\";",
      "const d6 = x ?? {}; const d7 = x ?? new Map(); const d8 = x ?? void 0; x ??= [];",
      "for (;;) { try { a(); } catch (err) { lastErr = err; } }",
      "try { a(); } catch (e) { log(e); throw e; }",
      "try { a(); } catch (e) { report(e); return retry(); }",
      "try { a(); } catch { console.error(\"lost\"); }",
      "p.catch(() => { throw ERR; }); p.catch((e) => onFail(e)); p.catch((e) => (m.delete(k), Promise.reject(e)));",
      "p.then(ok); p.then(ok, (e) => { throw e; }); p.then(ok, (e) => onFail(e)); p.then(ok, (e) => Promise.reject(e)); p.catch();",
    ];
    expect(misfires(VISITOR, ARMS, fire, decoys)).toEqual([]);
  });
});
