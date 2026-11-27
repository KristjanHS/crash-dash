import { describe, expect, it } from "vitest";
import { HOBBY_CAPS, type Projection } from "./probe-load-budget.js";
import { CAP_ALERT, CAP_WARN, PSI_GOOD, crashMessage, judge, outcomeMessage, psiMetrics, worst, type Psi } from "./probe-outcomes.js";

const goodPsi: Psi = { lcpMs: PSI_GOOD.lcpMs, tbtMs: PSI_GOOD.tbtMs, cls: PSI_GOOD.cls };
const proj = (edgeFrac: number, transferFrac: number, cpuFrac = 0): Projection => ({
  edgeRequests: edgeFrac * HOBBY_CAPS.edgeRequestsPerMonth,
  transferBytes: transferFrac * HOBBY_CAPS.transferBytesPerMonth,
  missInvocations: 50 * HOBBY_CAPS.functionInvocationsPerMonth,
  cpuSeconds: cpuFrac * HOBBY_CAPS.activeCpuSecondsPerMonth,
});
const level = (psi: Psi, p: Projection, metric: string) => judge(psi, p).find((f) => f.metric.includes(metric))!.level;

describe("probe-outcomes — judge", () => {
  it("PSI exactly at Google 'good' is ok; one unit past alerts", () => {
    expect(worst(judge(goodPsi, proj(0, 0)))).toBe("ok");
    expect(level({ ...goodPsi, lcpMs: PSI_GOOD.lcpMs + 1 }, proj(0, 0), "LCP")).toBe("alert");
    expect(level({ ...goodPsi, tbtMs: PSI_GOOD.tbtMs + 1 }, proj(0, 0), "TBT")).toBe("alert");
    expect(level({ ...goodPsi, cls: PSI_GOOD.cls + 0.001 }, proj(0, 0), "CLS")).toBe("alert");
  });

  it("edge + transfer: warn at CAP_WARN, alert at CAP_ALERT", () => {
    expect(level(goodPsi, proj(CAP_WARN - 0.01, 0), "edge")).toBe("ok");
    expect(level(goodPsi, proj(CAP_WARN, 0), "edge")).toBe("warn");
    expect(level(goodPsi, proj(CAP_ALERT, 0), "edge")).toBe("alert");
    expect(level(goodPsi, proj(0, CAP_WARN), "transfer")).toBe("warn");
    expect(level(goodPsi, proj(0, CAP_ALERT), "transfer")).toBe("alert");
    expect(worst(judge(goodPsi, proj(CAP_WARN, 0)))).toBe("warn");
  });

  it("key-expiry CPU alerts at CAP_ALERT; unmeasured (NaN) stays info", () => {
    expect(level(goodPsi, proj(0, 0, CAP_WARN), "CPU")).toBe("warn");
    expect(level(goodPsi, proj(0, 0, CAP_ALERT), "CPU")).toBe("alert");
    expect(level(goodPsi, proj(0, 0, Number.NaN), "CPU")).toBe("info");
  });
});

describe("probe-outcomes — PSI failure", () => {
  it("an unmeasured PSI is one WARN row; the cap rows still judge", () => {
    const f = judge(new Error("The operation was aborted due to timeout"), proj(0, 0));
    expect(f.filter((r) => r.metric.startsWith("PSI"))).toEqual([expect.objectContaining({ level: "warn", value: expect.stringContaining("timeout") })]);
    expect(f.some((r) => r.metric === "edge requests/mo")).toBe(true);
    expect(worst(f)).toBe("warn");
    expect(worst(judge(new Error("x"), proj(CAP_ALERT, 0)))).toBe("alert");
  });
});

describe("probe-outcomes — psiMetrics", () => {
  const audits = { "largest-contentful-paint": { numericValue: 1800 }, "total-blocking-time": { numericValue: 90 }, "cumulative-layout-shift": { numericValue: 0.02 } };
  it("reads the three lab audits", () => {
    expect(psiMetrics({ lighthouseResult: { audits } })).toEqual({ lcpMs: 1800, tbtMs: 90, cls: 0.02 });
  });
  it("throws on a missing audit rather than reading green", () => {
    const { "total-blocking-time": _, ...rest } = audits;
    expect(() => psiMetrics({ lighthouseResult: { audits: rest } })).toThrow(/total-blocking-time/);
    expect(() => psiMetrics({})).toThrow();
  });
});

describe("probe-outcomes — notify (N2/N3/N4)", () => {
  it("green run sends a priority-1 heartbeat naming the largest cap share", () => {
    const m = outcomeMessage(judge(goodPsi, proj(0.3, 0.12)));
    expect(m.priority).toBe(1);
    expect(m.body).toBe("worst: edge requests/mo 30% of cap");
    expect(outcomeMessage(judge(goodPsi, proj(0.05, 0.4))).body).toBe("worst: transfer/mo 40% of cap");
  });
  it("warn/alert keep their priorities and list only the breaches", () => {
    expect(outcomeMessage(judge(goodPsi, proj(CAP_WARN, 0))).priority).toBe(2);
    const a = outcomeMessage(judge(goodPsi, proj(CAP_ALERT, 0)));
    expect(a.priority).toBe(4);
    expect(a.body).toMatch(/^ALERT edge requests\/mo/);
    expect(a.body).not.toMatch(/PSI/);
  });
  it("a crash pushes priority 4 carrying the error message", () => {
    expect(crashMessage(new Error("PSI 429 Too Many Requests"))).toMatchObject({ priority: 4, body: "PSI 429 Too Many Requests" });
    expect(crashMessage("boom").title).toMatch(/CRASHED/);
  });
});
