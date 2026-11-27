/**
 * `stamp-deploy-config.ts`: fixture trees in a tmp dir, never the real checkout.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  assertNotCheckout,
  baseUrlFromAlias,
  PLACEHOLDER,
  resolveStampValues,
  STAMP_SET,
  StampRefusal,
  stampTree,
} from "./stamp-deploy-config.js";

const FAKE_HOST = "fakefakefakefakefake1.supabase.co";
const ENV = {
  SUPABASE_URL: `https://${FAKE_HOST}`,
  PROD_ALIAS: "fake.example",
  SUPABASE_ANON_KEY: "sb_publishable_fake",
};
const VALUES = { host: FAKE_HOST, baseUrl: "https://fake.example", anonKey: "sb_publishable_fake" };
const FAKE_REF = FAKE_HOST.split(".")[0];

/** An unsigned JWT-shaped key carrying `claims` (the stamp decodes the payload; it never verifies a signature). */
const fakeJwt = (claims: Record<string, unknown>): string =>
  [{ alg: "HS256", typ: "JWT" }, claims].map((o) => Buffer.from(JSON.stringify(o)).toString("base64url")).join(".") + ".sig";

const trees: string[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) rmSync(t, { recursive: true, force: true });
});

/** A tree holding every declared file with exactly the placeholders it must carry (+ an extra bundle). */
function fixtureTree(): string {
  const t = mkdtempSync(join(tmpdir(), "stamp-deploy-"));
  trees.push(t);
  const body: Record<string, string> = {
    host: `https://${PLACEHOLDER.host}`,
    baseUrl: `${PLACEHOLDER.baseUrl}/api`,
    anonKey: `"${PLACEHOLDER.anonKey}"`,
  };
  for (const { file, tokens } of STAMP_SET) {
    mkdirSync(dirname(join(t, file)), { recursive: true });
    writeFileSync(join(t, file), tokens.map((k) => body[k]).join("\n") + "\n");
  }
  writeFileSync(join(t, "public/lab.bundle.js"), `var r="${PLACEHOLDER.host}",t="${PLACEHOLDER.anonKey}";`);
  writeFileSync(join(t, "public/logo.png"), "\x89PNG untouched");
  return t;
}

const read = (t: string, f: string) => readFileSync(join(t, f), "utf8");

describe("stampTree", () => {
  test("replaces every placeholder across declared and undeclared files; none left", () => {
    const t = fixtureTree();
    const report = stampTree(t, VALUES);
    expect(read(t, "public/supabase-host.js")).toBe(`https://${FAKE_HOST}\n"sb_publishable_fake"\n`);
    expect(read(t, "openapi.yaml")).toBe("https://fake.example/api\n");
    expect(read(t, "public/lab.bundle.js")).toBe(`var r="${FAKE_HOST}",t="sb_publishable_fake";`);
    expect(report.get("public/supabase-host.js")).toBe(2);
    expect(report.has("public/logo.png")).toBe(false);
    for (const f of [...STAMP_SET.map((s) => s.file), "public/lab.bundle.js"]) {
      expect(read(t, f)).not.toContain(PLACEHOLDER.ref);
      expect(read(t, f)).not.toContain("prod-alias.invalid");
      expect(read(t, f)).not.toContain(PLACEHOLDER.anonKey);
    }
  });

  test("a declared file that lost its placeholder refuses, and nothing is written", () => {
    const t = fixtureTree();
    writeFileSync(join(t, "public/exposure.html"), "https://real-host-literal.supabase.co\n");
    const before = read(t, "public/supabase-host.js");
    expect(() => stampTree(t, VALUES)).toThrow(/public\/exposure\.html took zero host/);
    expect(read(t, "public/supabase-host.js")).toBe(before);
  });

  test("a declared file missing one of its two tokens refuses", () => {
    const t = fixtureTree();
    writeFileSync(join(t, "public/supabase-host.js"), `https://${PLACEHOLDER.host}\n""\n`);
    expect(() => stampTree(t, VALUES)).toThrow(/supabase-host\.js took zero anonKey/);
  });

  test("a declared file absent from the tree refuses", () => {
    const t = fixtureTree();
    rmSync(join(t, "vercel.json"));
    expect(() => stampTree(t, VALUES)).toThrow(/declared file missing from the tree: vercel\.json/);
  });

  test("a placeholder spelling no token covers (bare ref) is left over → refuses", () => {
    const t = fixtureTree();
    mkdirSync(join(t, "api"));
    writeFileSync(join(t, "api/x.ts"), `const ref = "${PLACEHOLDER.ref}";`);
    expect(() => stampTree(t, VALUES)).toThrow(/placeholder left in api\/x\.ts: configrefplaceholder/);
    // public/ is visited BEFORE api/, so only check-all-then-write leaves this one unstamped.
    expect(read(t, "public/supabase-host.js")).toContain(PLACEHOLDER.host);
  });
});

describe("resolveStampValues", () => {
  test("derives host, base URL and key from the config", () => {
    expect(resolveStampValues(ENV)).toEqual(VALUES);
  });

  test.each([
    ["SUPABASE_URL", { SUPABASE_URL: "" }, /SUPABASE_URL is not set/],
    ["PROD_ALIAS", { PROD_ALIAS: undefined }, /PROD_ALIAS is not set/],
    ["SUPABASE_ANON_KEY", { SUPABASE_ANON_KEY: "  " }, /SUPABASE_ANON_KEY is not set/],
    ["non-https SUPABASE_URL", { SUPABASE_URL: `http://${FAKE_HOST}` }, /must be https/],
    ["garbage SUPABASE_URL", { SUPABASE_URL: "not a url" }, /not a URL/],
    ["placeholder anon key", { SUPABASE_ANON_KEY: PLACEHOLDER.anonKey }, /not key-shaped/],
    ["path alias", { PROD_ALIAS: "https://fake.example/x" }, /host, not a path/],
    ["a service-role JWT", { SUPABASE_ANON_KEY: fakeJwt({ role: "service_role", ref: FAKE_REF }) }, /role "service_role", not "anon"/],
    ["another project's anon JWT", { SUPABASE_ANON_KEY: fakeJwt({ role: "anon", ref: "otherprojectref00000" }) }, /for project "otherprojectref00000", not SUPABASE_URL's/],
    ["an undecodable eyJ key", { SUPABASE_ANON_KEY: "eyJhbGciOi.x.y" }, /not a decodable JWT/],
    ["the service key's value (JWT)", { SUPABASE_ANON_KEY: fakeJwt({ role: "anon", ref: FAKE_REF }), SUPABASE_SERVICE_KEY: fakeJwt({ role: "anon", ref: FAKE_REF }) }, /equals SUPABASE_SERVICE_KEY/],
    ["the service key's value (any shape)", { SUPABASE_SERVICE_KEY: ` ${ENV.SUPABASE_ANON_KEY} ` }, /equals SUPABASE_SERVICE_KEY/],
  ])("refuses: %s", (_name, patch, msg) => {
    expect(() => resolveStampValues({ ...ENV, ...patch })).toThrow(msg);
  });

  test("accepts this project's anon JWT beside a different service key", () => {
    const anon = fakeJwt({ role: "anon", ref: FAKE_REF });
    const env = { ...ENV, SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_KEY: fakeJwt({ role: "service_role", ref: FAKE_REF }) };
    expect(resolveStampValues(env).anonKey).toBe(anon);
  });
});

describe("baseUrlFromAlias", () => {
  test.each([
    ["fake.example", "https://fake.example"],
    ["https://fake.example", "https://fake.example"],
    ["https://fake.example/", "https://fake.example"],
    [" fake.example ", "https://fake.example"],
  ])("%s → %s", (alias, want) => expect(baseUrlFromAlias(alias)).toBe(want));

  test("refuses a non-https scheme", () => {
    expect(() => baseUrlFromAlias("http://fake.example")).toThrow(StampRefusal);
  });
});

describe("assertNotCheckout", () => {
  test("refuses the checkout root, accepts any other tree", () => {
    const t = fixtureTree();
    expect(() => assertNotCheckout(t, [t])).toThrow(/refusing to stamp the checkout itself/);
    expect(() => assertNotCheckout(t, ["/somewhere/else"])).not.toThrow();
  });
});

describe("CLI entry", () => {
  const ROOT = join(import.meta.dirname, "..");
  // The local tsx bin, never `npx tsx`: npx is npm, and npm's update notifier writes `npm notice New major
  // version…` to stderr whenever the runner's npm lags the registry — that broke the exact-'' stderr assertion
  // below on CI (run 45056481413). The env here is replaced wholesale, so a workflow-level opt-out never reaches it.
  const TSX = join(ROOT, "node_modules", ".bin", "tsx");
  const cli = (tree: string, env: Record<string, string>, script = "scripts/stamp-deploy-config.ts") =>
    spawnSync(TSX, [script, tree], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
      encoding: "utf8",
      timeout: 30_000,
    });

  test("stamps a tree: exit 0, every placeholder replaced", () => {
    const t = fixtureTree();
    const r = cli(t, ENV);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/stamped deploy config: \d+ substitution\(s\)/);
    expect(read(t, "public/supabase-host.js")).toBe(`https://${FAKE_HOST}\n"sb_publishable_fake"\n`);
  });

  test("a refusal: exit 1, one ::error:: line, nothing written", () => {
    const t = fixtureTree();
    const r = cli(t, { ...ENV, SUPABASE_ANON_KEY: "" });
    expect(r.status).toBe(1);
    expect(r.stderr.trim()).toBe("::error:: stamp-deploy-config: SUPABASE_ANON_KEY is not set — no target configured");
    expect(read(t, "public/supabase-host.js")).toContain(PLACEHOLDER.host);
  });

  // A copy of the script in a scratch checkout: with no `.git` its own root is still the checkout; a `.git` git cannot
  // resolve refuses rather than guessing.
  test.each<[string, string | null, RegExp]>([
    ["a checkout with no git metadata refuses its own root", null, /refusing to stamp the checkout itself/],
    ["a `.git` git cannot resolve refuses", "gitdir: /nonexistent-gitdir\n", /\.git exists but git cannot resolve it/],
  ])("%s", (_, dotGit, msg) => {
    const checkout = fixtureTree();
    mkdirSync(join(checkout, "scripts"));
    copyFileSync(join(ROOT, "scripts", "stamp-deploy-config.ts"), join(checkout, "scripts", "stamp-deploy-config.ts"));
    symlinkSync(join(ROOT, "node_modules"), join(checkout, "node_modules"), "dir");
    if (dotGit !== null) writeFileSync(join(checkout, ".git"), dotGit);
    const r = cli(checkout, { ...ENV, GIT_CEILING_DIRECTORIES: dirname(checkout) }, join(checkout, "scripts", "stamp-deploy-config.ts"));
    expect(r.stderr).toMatch(msg);
    expect(r.status).toBe(1);
    expect(read(checkout, "public/supabase-host.js")).toContain(PLACEHOLDER.host);
  });
});
