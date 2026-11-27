/** Run-cycle pushes: the band + provisional push (before persist), then the track + exposure pushes (after the seed tail). */

import { ntfyTopic, type NtfyMessage } from "./ntfy.js";
import { decideExposureNotify, type ExposurePrior, type ExposureResult } from "./exposure.js";
import type { AlertRecord, BandField, DegradeEvent, SeriesPoint } from "./store.js";
import type { ProvisionalDecision } from "./provisional.js";
import type { ScoredTrack } from "./tracks.js";
import { PUSH_LABEL } from "./notify_format.js";
import type { RunBase } from "./run-cycle-ctx.js";
import { errMsg } from "./err-msg.js";
import type { FredOutage } from "./fred.js";

export function fredOutageMessage(o: FredOutage): NtfyMessage {
  // Clipped + capped: a keyless summary embeds the HTML page's first line, and ntfy turns a body past NTFY_BODY_MAX into an attachment.
  const causes = o.summaries.slice(0, 3).map((s) => (s.length > 160 ? `${s.slice(0, 157)}...` : s));
  return {
    title: `FRED outage - ${o.failed.length}/${o.total} series failed`,
    body: `FRED failed on every path for ${o.failed.length} of ${o.total} series (${causes.join(" | ")}); they were scored off last-stored data. Re-run the prod scoring cron once FRED is back`,
    tags: "warning",
  };
}

/** EOD only: one ntfy notice on a FRED-wide outage so the user re-runs the prod scoring cron; the returned event is for the caller to persist. */
export async function pushFredOutage(ctx: RunBase): Promise<Pick<DegradeEvent, "scope" | "reason"> | null> {
  const outage = ctx.opts.intraday === true ? null : ctx.feeds.fredOutage();
  if (!outage) return null;
  const scope = `[fred] outage - ${outage.failed.length}/${outage.total} series failed`;
  try {
    await ctx.notify.pushNtfy(fredOutageMessage(outage), { env: ctx.env });
    return { scope, reason: `ntfy outage notice ${ctx.notify.ntfyPushEnabled(ctx.env) ? "sent" : "suppressed (blank NTFY_TOPIC)"}` };
  } catch (err) {
    console.error(`[ntfy] FRED outage push failed: ${errMsg(err)}`);
    return { scope, reason: `ntfy outage notice failed: ${errMsg(err)}` };
  }
}

export async function pushBand(
  ctx: RunBase,
  alert: AlertRecord,
  last: AlertRecord | null,
  notification: { push: boolean; message: NtfyMessage },
  provisional: ProvisionalDecision,
): Promise<void> {
  // Push BEFORE the atomic persist so the row records the OUTCOME (rank 1): wrapped so a push failure
  // never aborts recordRun or 500s the cron — loud (console.error + push_error) but non-fatal.
  if (notification.push && ctx.opts.intraday !== true) {
    try {
      await ctx.notify.pushNtfy(notification.message, { env: ctx.env });
      // `pushNtfy` SUPPRESSES the send off-prod (blank NTFY_TOPIC) and returns normally, so clear
      // pushed_at here — else the intent stamp persists as a confirmed send. Unreachable on prod.
      if (ctx.notify.ntfyPushEnabled(ctx.env)) {
        console.log(`Pushed to ntfy topic "${ntfyTopic(ctx.env)}": ${notification.message.title}`);
      } else {
        alert.pushedAt = null;
        console.log(`No push recorded - ntfy suppressed (blank NTFY_TOPIC off-prod): ${notification.message.title}`);
      }
    } catch (err) {
      alert.pushedAt = null;
      alert.pushError = errMsg(err);
      console.error(`[ntfy] band push FAILED - recorded push_error, re-asserts next run: ${alert.pushError}`);
    }
  } else if (ctx.opts.intraday === true) {
    alert.pushedAt = null;
    console.log(`[intraday] provisional run - no push, no alert row (${alert.level}).`);
  } else {
    console.log(`No push (${last?.level ?? "—"} -> ${alert.level}; re-assert not due) - silent.`);
  }

  // PROVISIONAL raw-RED push — its OWN try/catch mirroring the band's OUTCOME semantics: on a throw OR
  // off-prod suppressed send, reset `provisionalPushedAt` to the CARRIED value. NO `pushError` write here
  // (that column is the BAND's re-assert latch), so a provisional failure is logged and skipped.
  if (provisional.push && provisional.message && ctx.opts.intraday !== true) {
    const carried = last?.provisionalPushedAt ?? null;
    try {
      await ctx.notify.pushNtfy(provisional.message, { env: ctx.env });
      if (ctx.notify.ntfyPushEnabled(ctx.env)) {
        console.log(`Pushed to ntfy topic "${ntfyTopic(ctx.env)}": ${provisional.message.title}`);
      } else {
        alert.provisionalPushedAt = carried;
        console.log(`No provisional push recorded - ntfy suppressed (blank NTFY_TOPIC off-prod): ${provisional.message.title}`);
      }
    } catch (err) {
      alert.provisionalPushedAt = carried;
      const reason = errMsg(err);
      console.error(`[ntfy] provisional push FAILED - band notify unaffected: ${reason}`);
    }
  }
}

export async function pushTail(
  ctx: RunBase,
  scored: readonly ScoredTrack[],
  slowNotification: { push: boolean; message: NtfyMessage | null },
  bottomNotification: { push: boolean; message: NtfyMessage | null },
  exposureSeries: { f1: SeriesPoint[]; gt: SeriesPoint[] } | null,
  exposurePush: { curr: ExposureResult; prev: ExposurePrior | null } | null,
): Promise<void> {
  // Off-ladder tier pushes: each on its OWN tier, independent, only on an upward band change (never an
  // all-clear). Degraded/no-change → silent. Push order = TRACKS order (fast → slow → bottom → pension).
  const trackPushes: Record<BandField, { push: boolean; message: NtfyMessage | null }> = {
    slowBand: slowNotification,
    bottomState: bottomNotification,
  };
  for (const s of scored) {
    const n = trackPushes[s.baselineField];
    if (n.push && n.message) {
      // Isolated: a failure logs but never aborts a sibling push or the run (no pushed_at column — console only).
      try {
        await ctx.notify.pushNtfy(n.message, { env: ctx.env });
        // Log-only, but a suppressed send returns normally — guard the claim (see the band-push site).
        if (ctx.notify.ntfyPushEnabled(ctx.env)) {
          console.log(`Pushed ${PUSH_LABEL[s.baselineField]} alert to ntfy topic "${ntfyTopic(ctx.env)}": ${n.message.title}`);
        }
      } catch (err) {
        console.error(`[ntfy] ${PUSH_LABEL[s.baselineField]} push failed: ${errMsg(err)}`);
      }
    }
  }

  // Exposure dial — the SEND only: REUSES the values `runScoringCycle`'s fetch/compute/comparator produced, never
  // re-fetches/re-decides (a second read could see a different vintage than the band push carried, and the
  // persisted state must be the one compared). LAST in push order; a degraded exposure is silent (already logged).
  if (exposureSeries && exposurePush) {
    // Both sides are the BOUNDED posture (or both raw, when either run was rung-blind). The pair was
    // assembled above `recordRun` so `state` could ride that write; this block only decides and sends.
    const { curr, prev } = exposurePush;
    const n = decideExposureNotify(curr, prev);
    console.log(`Exposure: ${curr.posture ?? "insufficient data"} - ${curr.summary}`);
    if (n.push && n.message) {
      // Isolated: an uncaught pushNtfy throw would abort the tail. Catch + log as a DELIVERY failure (never a feed outage).
      try {
        await ctx.notify.pushNtfy(n.message, { env: ctx.env });
        // Log-only, same truthfulness guard as the band/track push sites.
        if (ctx.notify.ntfyPushEnabled(ctx.env)) {
          console.log(`Pushed exposure alert to ntfy topic "${ntfyTopic(ctx.env)}": ${n.message.title}`);
        }
      } catch (err) {
        console.error(`[ntfy] exposure push failed: ${errMsg(err)}`);
      }
    }
  }
}
