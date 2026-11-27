import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";

type WafRule = {
  name: string;
  paths: string[];
  requests: number;
  windowSeconds: number;
  keys: string[];
  rateLimitAction: string;
};

const waf = JSON.parse(
  readFileSync(new URL("../scripts/waf-rules.json", import.meta.url), "utf8"),
) as WafRule;

const applyScript = readFileSync(
  new URL("../scripts/apply-waf-rules.sh", import.meta.url),
  "utf8",
);

describe("scripts/waf-rules.json - WAF rate-limit rule (Stage 1)", () => {
  it("lists EXACTLY the paths the WAF can actually cover", () => {
    // Hobby allows exactly 1 rate-limit rule, so every covered path shares it.
    //
    // ⛔ Set equality, not containment, and the set is DELIBERATELY smaller than the legal audit
    // §4.3 wanted. The bulk time-series download was added 2026-08-20 and removed the same day:
    // `vercel firewall rules add` returns 401 "Rate limiting is not available for this plan", and
    // the live rule survives from an earlier entitlement and cannot be widened, so that path could
    // never be published. This file records what the WAF COVERS, not what it should.
    //
    // Re-adding a path here reds this test ON PURPOSE: a bare re-add would restore the drift that
    // blocks `make ship` (apply-waf-rules.sh --check exits 3). Re-add only with a verified
    // entitlement, and update this expectation in the same commit. Gap: docs/backlog.md §OWED[USER].
    expect([...waf.paths].sort()).toEqual(["/api/lab", "/api/replay"]);
  });

  it("keys the limit on the client IP", () => {
    expect(waf.keys).toContain("ip");
  });

  it("trips to a retryable 429, never a lockout or a challenge", () => {
    // `rate_limit` is Vercel's 429 exceeded-action: a shared-NAT bystander waits the window out.
    expect(waf.rateLimitAction).toBe("rate_limit");
  });

  it("states window + requests inside the CLI's documented ranges (read, not duplicated)", () => {
    // 10–3600s and 1–10_000_000 are the `vercel firewall rules add` documented bounds — not a
    // restatement of the threshold, which lives ONLY in the JSON and is derived from it here.
    expect(waf.windowSeconds).toBeGreaterThanOrEqual(10);
    expect(waf.windowSeconds).toBeLessThanOrEqual(3600);
    expect(waf.requests).toBeGreaterThanOrEqual(1);
    expect(waf.requests).toBeLessThanOrEqual(10_000_000);
  });

  // Spawns bash (~0.65 s): runs only in `make ship`, which exports SHIP_LANE.
  it.runIf(process.env.SHIP_LANE === "1")("--check EXITS 3 on a drifted live path set and 0 on a matching one", () => {
    // 2026-08-20: the live rule had drifted to 2 of the 3 paths while `--check` asserted only that
    // a rule of that NAME existed, so `make ship`'s gate returned 0 with the bulk-download endpoint
    // uncapped — a check structurally incapable of failing on the drift it exists to catch.
    //
    // This drives the REAL script end to end with a stubbed `npx` on PATH, so it pins the
    // comparison's WIRING, not the presence of source fragments. An earlier grep-based version of
    // this test stayed green when the compare was inverted (`!=` -> `=`); this one reds on that.
    // 3, not 1: the two codes have opposite remedies (drift is NOT publish-fixable on Hobby) and
    // scripts/ship.sh maps them to different `die` messages.
    const stubDir = mkdtempSync(join(tmpdir(), "waf-check-"));
    const payload = (paths: string[]) =>
      JSON.stringify([
        {
          name: waf.name,
          conditionGroup: paths.map((p) => ({
            conditions: [{ type: "path", op: "pre", value: p }],
          })),
        },
      ]);
    // A stub prod config: the script takes the Vercel link from it, never the cwd (the checkout has no `.vercel/`).
    const cfgDir = join(stubDir, "cfg");
    mkdirSync(join(cfgDir, ".vercel"), { recursive: true });
    writeFileSync(join(cfgDir, ".env.prod"), "");
    const { VERCEL_ORG_ID: _org, VERCEL_PROJECT_ID: _proj, ...baseEnv } = process.env;
    const runCheck = (paths: string[]) => {
      writeFileSync(
        join(stubDir, "npx"),
        // Like the real CLI, the stub fails unlinked — so the passing half proves the config's ids reach it.
        `#!/usr/bin/env bash\n[ "\${VERCEL_PROJECT_ID:-}" = prj_stub ] || { echo "not linked" >&2; exit 1; }\nfor a in "$@"; do\n  if [ "$a" = "diff" ]; then echo "No pending changes."; exit 0; fi\ndone\ncat <<'JSON'\n${payload(paths)}\nJSON\n`,
        { mode: 0o755 },
      );
      const r = spawnSync("bash", [fileURLToPath(new URL("../scripts/apply-waf-rules.sh", import.meta.url)), "--check"], {
        env: { ...baseEnv, PROD_CONFIG_DIR: cfgDir, PATH: `${stubDir}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      });
      return r;
    };

    // No Vercel link in the config -> "could NOT tell" (2), never "absent" (1) and never a stub-fed pass (0):
    // 2026-11-19 every unattended `make ship` died here once the checkout lost its `.vercel/`.
    const unlinked = runCheck(waf.paths);
    expect(unlinked.status, `expected unlinked exit 2, got ${unlinked.status}\n${unlinked.stderr}`).toBe(2);
    writeFileSync(join(cfgDir, ".vercel", "project.json"), JSON.stringify({ orgId: "team_stub", projectId: "prj_stub" }));

    // Drop one path -> DRIFT. Uses the real JSON's set, so adding a path keeps this honest.
    const drifted = runCheck(waf.paths.slice(0, -1));
    expect(drifted.status, `expected drift exit 3, got ${drifted.status}\n${drifted.stderr}`).toBe(3);
    expect(drifted.stderr).toContain("DRIFTED");

    // Exact set, deliberately out of order -> the compare sorts, so this must PASS. This half is
    // what reds if the comparison is inverted, and it is why the test is not one-sided.
    const matching = runCheck([...waf.paths].reverse());
    expect(matching.status, `expected match exit 0, got ${matching.status}\n${matching.stderr}`).toBe(0);

    rmSync(stubDir, { recursive: true, force: true });
    // Scope, ruled 2026-08-20: paths only. requests/window/keys/action are deliberately NOT
    // compared, so this does not assert them — see the script header for why that gap is accepted.
  });

  it("does not hardcode the paths - the apply script reads them from the JSON", () => {
    // The single touch-point for the path set is the JSON; the shell maps it via jq. A literal
    // /api/... in the script would be a second, driftable source — this reds if one is added.
    expect(applyScript).toContain("waf-rules.json");
    for (const p of waf.paths) expect(applyScript).not.toContain(p);
  });
});

type WafCustomRule = {
  name: string;
  description: string;
  action: string;
  paths: string[];
  published: boolean;
  publishCommand: string;
  publishStep: string;
};

const wafCustom = JSON.parse(
  readFileSync(new URL("../scripts/waf-custom-rules.json", import.meta.url), "utf8"),
) as WafCustomRule;

const shipScript = readFileSync(
  new URL("../scripts/ship.sh", import.meta.url),
  "utf8",
);

describe("scripts/waf-custom-rules.json - the /api/series challenge rule (REFUTED 2026-08-30)", () => {
  it("keeps the challenge path OUT of the rate-limit rule, which would wedge `make ship`", () => {
    // ⛔ The load-bearing pin. waf-rules.json drives ONE `rate_limit` rule whose live path set is
    // compared for EQUALITY by apply-waf-rules.sh --check on every `make ship` (exit 3 = DRIFT).
    // That live rule survives from an earlier entitlement and CANNOT be widened — `firewall rules
    // add --action rate_limit` returns 401 on Hobby. So a path added to waf-rules.json to get it
    // challenged would fail --check forever with no remedy. The challenge rule is a separate
    // CUSTOM rule (entitled; Hobby allows 3) and must stay in its own file.
    for (const path of wafCustom.paths) expect(waf.paths).not.toContain(path);
    expect(wafCustom.action).toBe("challenge");
    expect(waf.rateLimitAction).not.toBe("challenge");
  });

  it("stays UNPUBLISHED - the rule was tried in prod and refuted, not merely deferred", () => {
    // `published: false` is a claim about prod, and it is true again: the rule WAS published on
    // 2026-08-30 and removed the same day. A Vercel `challenge` on /api/series returns 429 +
    // checkpoint HTML to the dashboard's own background fetch (`public/app.js`), which cannot solve
    // it — every detail chart and sparkline went blank. So this pin is no longer "publish is owed";
    // it is "publishing is known-broken". The description carries the mechanism, and this asserts it
    // survives, so a future flip of `published` has to read why it was reverted first.
    expect(wafCustom.published).toBe(false);
    expect(wafCustom.description).toContain("DO NOT REPUBLISH");
    // ⚠ Scope of what these two assertions PROVE: only that neither script names this file by that
    // exact literal. A glob (`scripts/waf-*.json`) would apply it and leave them green. That is an
    // accepted proxy under the repo's single-touch-point discipline, not a proof of no automation.
    expect(applyScript).not.toContain("waf-custom-rules.json");
    expect(shipScript).not.toContain("waf-custom-rules.json");
  });

  it("records a publish command that actually matches the rule it describes", () => {
    // A recorded command that drifts from the rule is worse than none — the operator would publish
    // something other than what this file documents.
    expect(wafCustom.publishCommand).toContain(wafCustom.name);
    expect(wafCustom.publishCommand).toContain("--action challenge");
    for (const path of wafCustom.paths) expect(wafCustom.publishCommand).toContain(path);
    // `firewall overview` 404s on this plan (IP Bypass unavailable) — the confirmation is `diff`.
    expect(wafCustom.publishCommand).toContain("firewall diff");
    expect(wafCustom.publishCommand).not.toContain("firewall overview");
    // ⛔ The publish must NOT be chained onto the stage+diff command: `firewall diff` gates only on
    // exit code, so `add && diff && publish` would take a client-breaking challenge rule live with
    // nobody having read the diff. It is a separate recorded step by design.
    expect(wafCustom.publishCommand).not.toContain("firewall publish");
    expect(wafCustom.publishStep).toContain("firewall publish");
    // The staged condition MUST be the object form. The shorthand `path/pre=/api/series` is
    // rejected outright: `Invalid condition JSON ... Expected a JSON object like
    // {"type":"path","op":"pre","value":"/api"}` (vercel CLI 59.10.0, measured 2026-08-30 while
    // staging this very rule). A doc line and a code review had both recorded the shorthand as the
    // proven syntax; it never was. This pin reds if the shorthand is reintroduced.
    expect(wafCustom.publishCommand).toContain('{"type":"path","op":"pre","value":"/api/series"}');
    expect(wafCustom.publishCommand).not.toContain("path/pre=");
  });
});
