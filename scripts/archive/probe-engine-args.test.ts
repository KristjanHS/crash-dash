import { describe, it, expect } from "vitest";
import { parseProbeEngine } from "./probe-engine-args.js";

const argv = (...a: string[]) => ["node", "probe.ts", ...a];

describe("parseProbeEngine — --engine / --kappa / --cuts", () => {
  it("defaults to the legacy engine (no probe arm)", () => {
    expect(parseProbeEngine(argv())).toEqual({ ok: true, engine: undefined });
    expect(parseProbeEngine(argv("--engine=legacy"))).toEqual({ ok: true, engine: undefined });
  });
  it("rejects --kappa or --cuts without --engine=share", () => {
    expect(parseProbeEngine(argv("--kappa=0")).ok).toBe(false);
    expect(parseProbeEngine(argv("--engine=legacy", "--cuts=0.2,0.4")).ok).toBe(false);
  });
  it("requires --kappa under --engine=share and rejects a non-numeric or negative one", () => {
    expect(parseProbeEngine(argv("--engine=share")).ok).toBe(false);
    expect(parseProbeEngine(argv("--engine=share", "--kappa=abc")).ok).toBe(false);
    expect(parseProbeEngine(argv("--engine=share", "--kappa=-0.1")).ok).toBe(false);
  });
  it("builds the share arm, leaving cuts unset when --cuts is omitted", () => {
    expect(parseProbeEngine(argv("--engine=share", "--kappa=0.25"))).toEqual({
      ok: true,
      engine: { kind: "share", kappa: 0.25 },
    });
  });
  it("parses --cuts=<amber>,<red> and rejects a malformed or inverted pair", () => {
    expect(parseProbeEngine(argv("--engine=share", "--kappa=0", "--cuts=0.3,0.5"))).toEqual({
      ok: true,
      engine: { kind: "share", kappa: 0, cuts: { amber: 0.3, red: 0.5 } },
    });
    expect(parseProbeEngine(argv("--engine=share", "--kappa=0", "--cuts=0.5,0.3")).ok).toBe(false);
    expect(parseProbeEngine(argv("--engine=share", "--kappa=0", "--cuts=0.3")).ok).toBe(false);
    expect(parseProbeEngine(argv("--engine=share", "--kappa=0", "--cuts=0.3,0.5,0.7")).ok).toBe(false);
  });
  it("rejects an unknown engine", () => {
    expect(parseProbeEngine(argv("--engine=ciss")).ok).toBe(false);
  });
});
