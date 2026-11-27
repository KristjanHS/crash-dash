/**
 * Rederive (ruled 2026-10-05): `/api/status` serves the daytime `intraday_verdict` slot when it is NEWER than the
 * last EOD `alert_log` row (`servedVerdict`, src/intraday.ts — the rule `/lab` and `/api/exposure` share), with
 * that run's own readings; an older slot is ignored. The push/notify baselines are not on this path.
 */
import { describe, expect, test } from "vitest";

import { InMemoryStore } from "../src/store-memory.js";
import { makeAlert, makeStoredReading } from "../src/test-helpers.js";
import type { StatusResponse } from "../src/api/types.js";

const { handle, statusBody } = await import("./status.js");

const EOD_AT = "2026-06-25T22:00:00.000Z";
const DAY_AT = "2026-06-26T12:00:00.000Z"; // before 21:05 UTC on 06-26 ⇒ an intraday run
const PANEL = { globalPanel: [], displayPanel: [], cissHistory: [], heldMemberState: {} };

async function seeded(slotAt: string | null): Promise<InMemoryStore> {
  const store = new InMemoryStore();
  await store.recordRun([makeStoredReading("F1", { value: 4 })], EOD_AT, makeAlert({ firedAt: EOD_AT, level: "OK" }));
  if (slotAt !== null) {
    const date = slotAt.slice(0, 10);
    await store.recordReadings(
      [
        makeStoredReading("F1", { date, value: 5, state: "AMBER", rawState: "AMBER" }),
        makeStoredReading("G1", { date, value: 80, estimated: true }),
        makeStoredReading("F2", { date: "2026-06-25", value: 3 }), // the run's own row, but a FINAL prior-day print
      ],
      slotAt,
    );
    await store.putIntradayVerdict(makeAlert({ firedAt: slotAt, date, level: "WATCH", panelState: PANEL }));
  }
  return store;
}
// F1 is redacted on the wire: read the full body (`statusBody`) so the served VALUE is there.
const body = async (store: InMemoryStore) => (await statusBody(() => store, { env: {} }, new WeakSet())) as StatusResponse;

describe("/api/status serves the newer intraday verdict slot", () => {
  test("a newer slot IS the verdict: its level, its run's readings flagged provisional (EST on a stored estimate), no panel on the wire", async () => {
    const b = await body(await seeded(DAY_AT));
    expect([b.verdict.firedAt, b.verdict.level, b.asOf, b.provisional]).toEqual([DAY_AT, "WATCH", "2026-06-26", true]);
    expect("panelState" in b.verdict).toBe(false);
    const f1 = b.readings.find((r) => r.indicatorId === "F1")!;
    expect([f1.date, f1.value, f1.state, f1.provisional, f1.estimated]).toEqual(["2026-06-26", 5, "AMBER", true, undefined]);
    const g1 = b.readings.find((r) => r.indicatorId === "G1")!;
    expect([g1.provisional, g1.estimated]).toEqual([true, true]);
    // isProvisional gates on the row's OWN date: a prior-day print the daytime run re-wrote is final, not INTRADAY.
    expect(b.readings.find((r) => r.indicatorId === "F2")?.provisional).toBeUndefined();
  });

  test("the slot's G1 estimate (carried over oil futures) is redacted on the wire; the full body keeps it", async () => {
    const store = await seeded(DAY_AT);
    const redacted = (await (await handle(() => store, undefined, { env: {} })).json()) as StatusResponse;
    expect(redacted.readings.find((r) => r.indicatorId === "G1")).toMatchObject({ value: null, delta20: null, provisional: true, estimated: true });
    expect((await body(store)).readings.find((r) => r.indicatorId === "G1")?.value).toBe(80);
  });

  test("a failing slot read degrades to the EOD verdict, never a 500", async () => {
    const store = await seeded(DAY_AT);
    store.getIntradayVerdict = () => Promise.reject(new Error("slot down"));
    const res = await handle(() => store, undefined, { env: {} });
    expect(res.status).toBe(200);
    expect(((await res.json()) as StatusResponse).verdict.firedAt).toBe(EOD_AT);
  });
});
