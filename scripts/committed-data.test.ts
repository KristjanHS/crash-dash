/**
 * Scans the committed data-file shapes — tabular files (`csv`/`tsv`/`parquet`/`xlsx`) anywhere, JSON under
 * `scripts/backtest/data/`, and every `SYNTH_FIXTURES` path — and requires each to be a seeded synthetic
 * fixture or on a public-domain / own-config allowlist. Other file shapes are out of its scope. Each
 * `SYNTH_FIXTURES` blob must also equal the generator's output byte for byte, so a hand-appended row, a spec
 * edited without regenerating, or a non-deterministic generator all fail here.
 *
 * Reads ONE snapshot — the HEAD tree (`git ls-tree -r HEAD` for the list, `git cat-file --batch` for the
 * bodies), not the working tree: the claim is about what the repository distributes, and a working-tree
 * file a local run regenerates from a live feed is not distributed until it is committed — CI checks the
 * commit under test.
 */
import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { SYNTH_FIXTURES, SYNTH_MARKER, SYNTH_SEED, parseWatchEvents, renderSynthFixtures } from "./backtest/synth-fixtures.js";

const git = (...args: string[]): string => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** `HEAD:<path>` bodies in one `git cat-file --batch` call (header `<oid> <type> <size>\n`, body, `\n`). */
function headBlobs(paths: readonly string[]): Map<string, string> {
  const raw = execFileSync("git", ["cat-file", "--batch"], { input: paths.map((p) => `HEAD:${p}\n`).join(""), maxBuffer: 256 * 1024 * 1024 });
  const out = new Map<string, string>();
  let at = 0;
  for (const p of paths) {
    const eol = raw.indexOf(0x0a, at);
    const [, type, size] = raw.subarray(at, eol).toString("utf8").split(" ");
    if (type !== "blob") throw new Error(`[committed-data] HEAD:${p} is not a blob`);
    const end = eol + 1 + Number(size);
    out.set(p, raw.subarray(eol + 1, end).toString("utf8"));
    at = end + 1;
  }
  return out;
}

/** Data-file shapes: tabular files anywhere, plus any JSON under the backtest data dir. */
const DATA_FILE = /\.(csv|tsv|parquet|xlsx)$|^scripts\/backtest\/data\/.*\.json$/;

/** Not synthetic, and allowed: US-government / Federal Reserve public-domain series, or our own config. */
const ALLOWED_REAL: ReadonlySet<string> = new Set([
  // FRED — Federal Reserve H.10 / H.15, US Treasury, EIA (public domain).
  "scripts/backtest/data/broad_usd.csv",
  "scripts/backtest/data/dexjpus.csv",
  "scripts/backtest/data/dexszus.csv",
  "scripts/backtest/data/dexuseu.csv",
  "scripts/backtest/data/dfii10.csv",
  "scripts/backtest/data/dgs10.csv",
  "scripts/backtest/data/dgs2.csv",
  "scripts/backtest/data/t10y2y.csv",
  "scripts/backtest/data/t10y3m.csv",
  "scripts/backtest/data/wti.csv",
  // Federal Reserve Board excess bond premium (public; cite the Board).
  "scripts/backtest/data/ebp.csv",
  // Own configuration, no market values.
  "scripts/backtest/data/pension_holdings.json",
  "scripts/backtest/data/scoring_constants.json",
]);

function isSynthetic(path: string, body: string): boolean {
  if (path.endsWith(".json")) {
    try {
      return (JSON.parse(body) as { synthetic?: unknown }).synthetic === SYNTH_MARKER;
    } catch {
      return false;
    }
  }
  return body.slice(0, body.indexOf("\n")) === SYNTH_MARKER;
}

/** False in a tree built without git metadata — the claim is about the repository's commits, so it needs them. */
const inGitRepo = ((): boolean => {
  try {
    return git("rev-parse", "--is-inside-work-tree").trim() === "true";
  } catch {
    return false;
  }
})();

describe.runIf(inGitRepo)("committed tabular + backtest-data JSON + synthetic fixtures (HEAD tree)", () => {
  let tracked: string[] = [];
  let dataFiles: string[] = [];
  let blobs = new Map<string, string>();
  beforeAll(() => {
    tracked = git("ls-tree", "-r", "--name-only", "HEAD").split("\n").filter(Boolean);
    dataFiles = [...new Set([...tracked.filter((p) => DATA_FILE.test(p)), ...SYNTH_FIXTURES.filter((p) => tracked.includes(p))])];
    blobs = headBlobs(dataFiles);
  });
  const blob = (p: string): string => blobs.get(p) ?? "";

  it("finds the data files (the scan is not vacuous)", () => {
    expect(dataFiles.length).toBeGreaterThan(SYNTH_FIXTURES.length);
  });

  it("every scanned file is synthetic or allowlisted", () => {
    const offenders = dataFiles.filter((p) => !ALLOWED_REAL.has(p) && !isSynthetic(p, blob(p)));
    expect(offenders).toEqual([]);
  });

  it("every generated fixture is committed and carries the marker", () => {
    const bad = SYNTH_FIXTURES.filter((p) => !tracked.includes(p) || !isSynthetic(p, blob(p)));
    expect(bad).toEqual([]);
  });

  describe("every generated fixture's committed bytes equal the generator's output", () => {
    // The watch `events` are carried over, not generated — feed in the committed ones.
    let rendered = new Map<string, string>();
    beforeAll(() => {
      const watch = SYNTH_FIXTURES.find((p) => p.endsWith(".watch.json")) ?? "";
      rendered = renderSynthFixtures(SYNTH_SEED, parseWatchEvents(blob(watch)));
    });

    it("HEAD blob === renderSynthFixtures(SYNTH_SEED) for every path (`npm run synth:fixtures` + commit to fix)", () => {
      const drifted = SYNTH_FIXTURES.filter((p) => blob(p) !== rendered.get(p));
      expect(drifted, "regenerate with `npm run synth:fixtures` and commit").toEqual([]);
    });
  });

  it("the allowlist names only committed files (no stale rows)", () => {
    expect([...ALLOWED_REAL].filter((p) => !tracked.includes(p))).toEqual([]);
  });
});
