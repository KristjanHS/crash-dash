import { describe, expect, test } from "vitest";

import { resolveServedPanels, type ServedMemberInputs } from "./lab-served-members.js";
import { confirmClosesFor, type FamilyKey, type FamilyPanel } from "./families.js";
import { makeStoredReading } from "./test-helpers.js";
import { isProvisional, provisionalBefore } from "./intraday.js";
import type { SeriesPoint, StoredReading } from "./store.js";
import type { State } from "./domain-types.js";

const RUN_AT = "2026-06-25T21:00:00.000Z";
const EOD = { firedAt: RUN_AT, provisional: false };

const row = (id: string, state: State, date: string, over: Partial<StoredReading> = {}): StoredReading =>
  makeStoredReading(id, { date, rawState: state, state, ...over });
const pt = (date: string, state: State, runAt: string, over: Partial<SeriesPoint> = {}): SeriesPoint => ({
  date, value: 1, delta20: 0, rawState: state, state, runAt, ...over,
});
const panel = (key: FamilyKey, members: [string, State][]): FamilyPanel => ({
  key, label: key, state: "GREEN", live: true, firing: false, contribution: 0, absent: 0,
  members: members.map(([id, state]) => ({ id, label: id, state })),
});
const inputs = (runRows: StoredReading[], newest: [string, SeriesPoint[]][], asOf = "2026-06-25"): ServedMemberInputs => ({
  runRows, newestRows: new Map(newest), asOf, verdict: EOD,
});
const memberOf = (panels: FamilyPanel[], id: string) => panels.flatMap((f) => f.members).find((m) => m.id === id);

describe("resolveServedPanels - estimate heads", () => {
  test("an EOD `estimated` G1 row (E3/E8): display chip EST, no band lag despite the mismatch", () => {
    // The EOD run's G1 estimate (`oilEstimateRows`): a later, post-cutoff runAt ⇒ NOT provisional; RED vs the GREEN panel.
    const ctx = inputs([row("G1", "GREEN", "2026-06-24")], [["G1", [pt("2026-06-24", "GREEN", RUN_AT), pt("2026-06-25", "RED", "2026-06-25T21:10:00.000Z", { estimated: true })]]]);
    const served = resolveServedPanels([panel("geopolitics", [["G1", "GREEN"]])], true, ctx);
    const shown = memberOf(served, "G1");
    expect(shown).toMatchObject({ state: "RED", obs: "2026-06-25", estimated: true });
    expect(shown?.provisional).toBeUndefined();
    expect(served.some((f) => f.bandLagIds?.includes("G1"))).toBe(false);
  });

  test("a kept intraday G1 estimate on the EOD verdict's display panel carries `provisional` and `estimated`", () => {
    const ctx = inputs([row("G1", "GREEN", "2026-06-24")], [["G1", [pt("2026-06-24", "GREEN", RUN_AT), pt("2026-06-25", "RED", "2026-06-25T15:00:00.000Z", { estimated: true })]]]);
    expect(memberOf(resolveServedPanels([panel("geopolitics", [["G1", "GREEN"]])], true, ctx), "G1")).toMatchObject({ obs: "2026-06-25", estimated: true, provisional: true });
  });

  // The cron shape: the notify panel folded G1's estimate head (RED) while the run's own G1 row is the print (GREEN).
  test("the DIAL member serves the estimate head the notify panel folded", () => {
    const est = "2026-06-25T21:10:00.000Z";
    const ctx = inputs(
      [row("G1", "GREEN", "2026-06-24")],
      [["G1", [pt("2026-06-24", "GREEN", RUN_AT), pt("2026-06-25", "RED", est, { estimated: true })]]],
    );
    const dial = resolveServedPanels([panel("geopolitics", [["G1", "RED"]])], false, ctx);
    expect(memberOf(dial, "G1")).toMatchObject({ state: "RED", obs: "2026-06-25", estimated: true });
    expect(dial.some((f) => f.bandLagIds?.includes("G1"))).toBe(false);
  });

  // A kept intraday estimate folds into the notify dial from the day after its date; both arms share `asOf`.
  test("the DIAL member serves a provisional estimate dated D on a verdict fired D+1, and the prior print on one fired D", () => {
    const estAt = "2026-06-25T15:00:00.000Z";
    expect(isProvisional({ date: "2026-06-25", runAt: estAt })).toBe(true);
    const base = inputs([row("G1", "GREEN", "2026-06-24")], [["G1", [pt("2026-06-24", "GREEN", RUN_AT), pt("2026-06-25", "RED", estAt, { estimated: true })]]]);
    const dialG1 = (firedAt: string) => {
      const m = memberOf(resolveServedPanels([panel("geopolitics", [["G1", "GREEN"]])], false, { ...base, verdict: { firedAt, provisional: false } }), "G1");
      return [m?.state, m?.obs, m?.estimated];
    };
    expect([dialG1(RUN_AT), dialG1("2026-06-26T21:00:00.000Z")]).toEqual([["GREEN", "2026-06-24", undefined], ["RED", "2026-06-25", true]]);
  });

  // A quote head re-stamped at EOD with no FINAL on its previous session: the push folded the run's own gated row (the last FINAL).
  test("the DIAL member stays on the last FINAL under an unanchored quote head; the display member serves the head", () => {
    const ctx = inputs([row("BUND", "GREEN", "2026-06-23")], [["BUND", [pt("2026-06-23", "GREEN", RUN_AT), pt("2026-06-25", "RED", "2026-06-25T21:10:00.000Z", { estimated: true })]]]);
    const panels = [panel("rates", [["BUND", "GREEN"]])];
    const bund = (intraday: boolean) => memberOf(resolveServedPanels(panels, intraday, ctx), "BUND");
    expect([bund(false), bund(true)].map((m) => [m?.state, m?.obs, m?.estimated])).toEqual([["GREEN", "2026-06-23", undefined], ["RED", "2026-06-25", true]]);
  });

  test("E22: a monthly member carries `lastPrint` off its stored head, aged to `asOf`", () => {
    const ctx = inputs([row("EBP", "AMBER", "2026-06-01")], [["EBP", [pt("2026-06-01", "AMBER", RUN_AT)]]], "2026-06-25");
    const served = resolveServedPanels([panel("credit", [["EBP", "AMBER"]])], true, ctx);
    expect(memberOf(served, "EBP")?.lastPrint).toEqual({ date: "2026-06-01", days: 24, cadence: "monthly", reason: "cadence" });
  });
});

// `fold` is `{ raw, of } | null`, non-null iff the SERVED point is mid stand-down.
describe("resolveServedPanels - member.fold, the served-point stand-down badge", () => {
  test("fold is null where rawState === state and {raw, of: confirmClosesFor(id)} where they differ", () => {
    const f1 = row("F1", "RED", "2026-06-25", { rawState: "GREEN" }); // raw GREEN, confirmed RED — mid stand-down
    const f2 = row("F2", "GREEN", "2026-06-25");
    const ctx = inputs([f1, f2], [["F1", [pt("2026-06-25", "RED", RUN_AT, { rawState: "GREEN" })]], ["F2", [pt("2026-06-25", "GREEN", RUN_AT)]]]);
    const panels = [panel("credit", [["F1", "RED"], ["F2", "GREEN"]])];
    for (const intraday of [true, false]) {
      const served = resolveServedPanels(panels, intraday, ctx);
      expect(memberOf(served, "F2")?.fold).toBeNull();
      expect(memberOf(served, "F1")?.fold).toEqual({ raw: "GREEN", of: confirmClosesFor("F1") });
    }
  });

  test("fold is derived from the fresher SERVED vintage, not the run row", () => {
    // Run row: F1 raw==state GREEN ⇒ the run row ALONE yields fold null; the LATER close is mid stand-down.
    const ctx = inputs([row("F1", "GREEN", "2026-06-25")], [["F1", [pt("2026-06-25", "GREEN", RUN_AT), pt("2026-06-26", "RED", "2026-06-26T21:00:00.000Z", { rawState: "GREEN" })]]]);
    const f1 = memberOf(resolveServedPanels([panel("credit", [["F1", "GREEN"]])], true, ctx), "F1");
    expect(f1?.obs).toBe("2026-06-26"); // served the fresher vintage
    expect(f1?.fold).toEqual({ raw: "GREEN", of: confirmClosesFor("F1") });
  });
});

describe("resolveServedPanels - bandLagIds", () => {
  // THE PROD SHAPE (2026-08-20): the monotonicity guard committed FXH RED @08-19 beside a panel assembled PRE-guard (AMBER).
  // Red demo: gate the mark date-vs-date (`served !== own &&`) ⇒ no FXH mark.
  test("panel_state assembled PRE-guard beside a guard-carried reading serves the reading's state", () => {
    const ctx = inputs([row("FXH", "RED", "2026-08-19")], [["FXH", [pt("2026-08-19", "RED", "2026-08-20T11:59:53.054Z")]]], "2026-08-19");
    const [xa] = resolveServedPanels([panel("cross-asset", [["FXH", "AMBER"]])], true, { ...ctx, verdict: { firedAt: "2026-08-20T11:59:53.054Z", provisional: false } });
    const fxh = memberOf([xa!], "FXH")!;
    expect(fxh.state).toBe("RED"); // the run's OWN committed reading, not the pre-guard panel fold
    expect(fxh.obs).toBe("2026-08-19");
    expect(xa!.bandLagIds).toContain("FXH");
  });

  // Control: an EOD-final served row that disagrees with the panel DOES mark the family.
  test("control: the same row written after the EOD cutoff is final and DOES mark bandLagIds", () => {
    const eodRun = "2026-08-19T22:51:00.000Z";
    const ctx = inputs(
      [row("FXH", "GREEN", "2026-08-19"), row("F1", "GREEN", "2026-08-19")],
      [["FXH", [pt("2026-08-19", "GREEN", eodRun), pt("2026-08-20", "RED", provisionalBefore("2026-08-20", "FXH"))]], ["F1", [pt("2026-08-19", "GREEN", eodRun)]]],
      "2026-08-19",
    );
    const [xa] = resolveServedPanels([panel("cross-asset", [["FXH", "GREEN"]])], true, { ...ctx, verdict: { firedAt: eodRun, provisional: false } });
    const fxh = memberOf([xa!], "FXH")!;
    expect(fxh.state).toBe("RED");
    expect(fxh.provisional).toBeUndefined();
    expect(xa!.bandLagIds).toContain("FXH");
  });
});
