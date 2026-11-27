/**
 * Hermetic pins for the vintage-drift detector (`probe-vintage-drift.ts`) — Stage 6.
 * Everything drives the pure
 * `runVintageDrift(store, opts, codeRows)` over `InMemoryStore` with synthetic vintage
 * rows; the IO `main()` is behind an `isMain` guard, so this file runs with no creds.
 *
 * What is load-bearing here: the OUTPUT CONTRACT (Stage 7's ship step parses the
 * `DRIFT` / `DRIFT-NORESTATE` / `STAMP-ONLY` / `bash scripts/restate-prod.sh` prefixes and the exit
 * code), the first-deploy rule (empty table ⇒ stamp-only, exit 0, ZERO writes), the
 * ruling-4b partition, `--applied` drift-by-decree, and the `restatableIds()` roster
 * pinned against what `backfillAll` / `backfillDownsideBreaks` ACTUALLY accept (parsed
 * out of their own fail-loud rejection messages — the accepted set, by import, not a
 * hand list).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/store-memory.js";
import type { ScorerVintageRow } from "../src/store.js";
import { backfillAll, backfillDownsideBreaks, restatableIds } from "./backfill.js";
import { stub, STUB_NOW } from "./backfill.test-helpers.js";
import { readFileSync } from "node:fs";
import { DOWNSIDE_DETECTORS, RS_LEGS } from "../src/registry-price.js";
import { migrationRestateIds, runVintageDrift, stampEnvAbort, type VintageStore } from "./probe-vintage-drift.js";

const row = (id: string, hash: string, logic = 1): ScorerVintageRow => ({
  indicator_id: id,
  config_hash: hash,
  logic_version: logic,
  stamped_at: "2026-09-05T00:00:00.000Z",
});

// Premise guards: the ids the scenarios below lean on must sit on the side of the
// partition the scenario claims, or the assertions go vacuous.
const ROSTER = restatableIds();

describe("the prod re-score's restate partition (a DB_/RS_ prefix filter) covers the structural detector roster", () => {
  it("every DOWNSIDE_DETECTORS / RS_LEGS persisted id carries the DB_/RS_ prefix the re-score routes to dbreak", () => {
    const detectorIds = [...DOWNSIDE_DETECTORS.map((d) => d.indicator.id), ...RS_LEGS.map((l) => l.id)];
    expect(detectorIds.length).toBeGreaterThanOrEqual(4);
    for (const id of detectorIds) expect(id, `${id} would route to the indicators job, whose validator rejects it`).toMatch(/^(DB_|RS_)/);
  });
});

describe("restatableIds roster (ruling 4b's partition source)", () => {
  it("contains both restate seams", () => {
    expect(ROSTER).toContain("F9"); // backfillAll seam
    expect(ROSTER).toContain("DB_SMH"); // backfillDownsideBreaks seam
  });

  it("equals the union of the ids the two restate validators actually accept", async () => {
    // Cheapest read of the ACCEPTED sets: both validators fail loud on an unknown id
    // BEFORE any fetch, and their rejection message enumerates `known: <ids>` — parse
    // that, so the pin reads the same set the runtime check enforces.
    const knownOf = (msg: string): string[] => {
      const tail = msg.split("known: ")[1];
      expect(tail, `no 'known:' list in: ${msg}`).toBeDefined();
      return tail!.split(",").map((s) => s.trim());
    };
    const store = new InMemoryStore();
    const errAll = await backfillAll(store, stub, { restate: ["__BOGUS__"], now: STUB_NOW }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(errAll?.message).toContain("restate: unknown indicator id(s) __BOGUS__");
    const errDb = await backfillDownsideBreaks(
      store,
      { fetchPrices: stub.fetchPrices },
      { restate: ["__BOGUS__"], now: STUB_NOW },
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(errDb?.message).toContain("restate: unknown detector id(s) __BOGUS__");
    const union = new Set([...knownOf(errAll!.message), ...knownOf(errDb!.message)]);
    expect(new Set(ROSTER)).toEqual(union);
  });

  it("the scenario ids below sit where the scenarios claim", () => {
    expect(ROSTER).toContain("F11");
    expect(ROSTER).not.toContain("ZZ_NOPE");
  });
});

describe("runVintageDrift — diff + output contract", () => {
  it("drift ⇒ exit 1, DRIFT line, and the restate line names exactly the drifted ids", async () => {
    const store = new InMemoryStore();
    await store.recordScorerVintage([row("F9", "oldhash", 1), row("F11", "samehash", 1)]);
    const code = [row("F9", "newhash", 2), row("F11", "samehash", 1)];
    const res = await runVintageDrift(store, {}, code);
    expect(res.exitCode).toBe(1);
    expect(res.restatable).toEqual(["F9"]);
    expect(res.lines).toContain("DRIFT F9 config oldhash→newhash | logic v1→v2");
    expect(res.lines).toContain("bash scripts/restate-prod.sh F9");
    // exactly ONE restate line, naming only the drifted id
    expect(res.lines.filter((l) => l.startsWith("bash scripts/restate-prod.sh"))).toEqual(["bash scripts/restate-prod.sh F9"]);
  });

  it("clean ⇒ exit 0, no restate line, and the default run WRITES NOTHING", async () => {
    const store = new InMemoryStore();
    await store.recordScorerVintage([row("F9", "h1", 1)]);
    const res = await runVintageDrift(store, {}, [row("F9", "h1", 1)]);
    expect(res.exitCode).toBe(0);
    expect(res.lines.some((l) => l.startsWith("bash scripts/restate-prod.sh"))).toBe(false);
    expect(res.lines.some((l) => l.startsWith("DRIFT"))).toBe(false);
    expect(store.scorerVintage.size).toBe(1); // read-only: the stored row is untouched
  });

  it("empty table ⇒ exit 0 with one STAMP-ONLY line per id and ZERO writes (first-deploy pin)", async () => {
    const store = new InMemoryStore();
    const res = await runVintageDrift(store, {}, [row("F9", "h1"), row("F11", "h2")]);
    expect(res.exitCode).toBe(0);
    expect(res.stampOnly).toEqual(["F9", "F11"]);
    expect(res.lines).toContain("STAMP-ONLY F9");
    expect(res.lines).toContain("STAMP-ONLY F11");
    expect(res.lines.some((l) => l.startsWith("DRIFT"))).toBe(false);
    expect(res.lines.some((l) => l.startsWith("bash scripts/restate-prod.sh"))).toBe(false);
    expect(store.scorerVintage.size).toBe(0); // the default run must not seed the table
  });

  it("NORESTATE drift alone ⇒ exit 1, a DRIFT-NORESTATE line, NO restate line (ruling 4b)", async () => {
    const store = new InMemoryStore();
    await store.recordScorerVintage([row("ZZ_NOPE", "oldhash", 1)]);
    const res = await runVintageDrift(store, {}, [row("ZZ_NOPE", "newhash", 1)]);
    expect(res.exitCode).toBe(1);
    expect(res.noRestate).toEqual(["ZZ_NOPE"]);
    expect(res.restatable).toEqual([]);
    expect(res.lines).toContain("DRIFT-NORESTATE ZZ_NOPE config oldhash→newhash | logic v1→v1");
    expect(res.lines.some((l) => l.startsWith("bash scripts/restate-prod.sh"))).toBe(false);
  });

  it("missing-relation read error ⇒ table absent, all STAMP-ONLY, exit 0 (pre-ship branch)", async () => {
    // The SupabaseStore surfaces the pre-migration read as a thrown Error whose message
    // carries the table name + PostgREST's missing-relation phrasing — distinguishable,
    // so the branch is pinned here on a stub store.
    const absent: VintageStore = {
      getScorerVintages: async () => {
        throw new Error(
          "Supabase read scorer_vintage failed: Could not find the table 'public.scorer_vintage' in the schema cache",
        );
      },
      recordScorerVintage: async () => {
        throw new Error("must not write on a default run");
      },
    };
    const res = await runVintageDrift(absent, {}, [row("F9", "h1")]);
    expect(res.exitCode).toBe(0);
    expect(res.stampOnly).toEqual(["F9"]);
    expect(res.lines.some((l) => l.startsWith("TABLE-ABSENT scorer_vintage"))).toBe(true);
    expect(res.lines).toContain("STAMP-ONLY F9");
  });

  it("an unrelated read error still throws (never swallowed into stamp-only)", async () => {
    const broken: VintageStore = {
      getScorerVintages: async () => {
        throw new Error("Supabase read scorer_vintage failed: JWT expired");
      },
      recordScorerVintage: async () => {},
    };
    await expect(runVintageDrift(broken, {}, [row("F9", "h1")])).rejects.toThrow("JWT expired");
  });
});

describe("--applied drift-by-decree", () => {
  it("a migration header `-- Restate : F9 , F11` adds both ids; a missing file warns, never crashes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vintage-drift-"));
    const mig = join(dir, "20990101000000_purge_something.sql");
    // Deliberately exercises the tolerance: capital R, space before the colon, spaces
    // around the commas, a preceding comment line, all inside the head comment block.
    writeFileSync(
      mig,
      "-- Purge stale F9/F11 vintages (fixture).\n-- Restate : F9 , F11\ncreate table if not exists t (x int);\n-- restate: ZZ_BODY_LINE_MUST_NOT_COUNT\n",
    );
    const manifest = join(dir, "applied.txt");
    writeFileSync(manifest, `${mig}\n${join(dir, "does-not-exist.sql")}\n`);
    const store = new InMemoryStore();
    await store.recordScorerVintage([row("F9", "h1"), row("F11", "h2")]);
    // stored == code ⇒ hash-clean; the drift below is decree-only
    const res = await runVintageDrift(store, { applied: manifest }, [row("F9", "h1"), row("F11", "h2")]);
    expect(res.exitCode).toBe(1);
    expect(res.lines).toContain(`DRIFT F9 by-migration ${basename(mig)}`);
    expect(res.lines).toContain(`DRIFT F11 by-migration ${basename(mig)}`);
    expect(res.lines).toContain("bash scripts/restate-prod.sh F9,F11");
    expect(res.lines.some((l) => l.startsWith("WARN --applied migration not found"))).toBe(true);
    // the body line after the first SQL statement is outside the head comment block
    expect(res.lines.some((l) => l.includes("ZZ_BODY_LINE_MUST_NOT_COUNT"))).toBe(false);

    // ship.sh's re-check leg (post restate + --stamp): a decree is drift "hash-clean or not",
    // so the SAME manifest re-trips it forever — the re-check must run WITHOUT --applied.
    // Pins both halves: with the manifest it stays exit 1; the plain diff is clean.
    await runVintageDrift(store, { stamp: ["F9", "F11"] }, [row("F9", "h1"), row("F11", "h2")]);
    const again = await runVintageDrift(store, { applied: manifest }, [row("F9", "h1"), row("F11", "h2")]);
    expect(again.exitCode).toBe(1);
    const recheck = await runVintageDrift(store, {}, [row("F9", "h1"), row("F11", "h2")]);
    expect(recheck.exitCode).toBe(0);
    expect(recheck.lines.filter((l) => l.startsWith("DRIFT"))).toEqual([]);
  });

  it("--stamp on a read handle (no write seam) throws instead of reporting a stamp", async () => {
    const readOnly: VintageStore = { getScorerVintages: async () => [] };
    await expect(runVintageDrift(readOnly, { stamp: "all" }, [row("F9", "h1")])).rejects.toThrow(/--stamp needs a read-write store/);
  });

  it("ship.sh passes the manifest to the first run only; the re-check is a plain diff", () => {
    const sh = readFileSync(join(import.meta.dirname, "ship.sh"), "utf8");
    expect(sh).toMatch(/run_drift "\$SHIP_APPLIED_MIGRATIONS" \|\| drift_rc=/);
    expect(sh).toMatch(/--stamp="\$restate_ids"[\s\S]*?\n\s*drift_rc=0; run_drift \|\| drift_rc=/);
  });

  it("ship.sh's own id parse, run over this probe's real output, yields the drifted ids it then restates", async () => {
    const sh = readFileSync(join(import.meta.dirname, "ship.sh"), "utf8");
    const parse = sh.match(/^\s*(restate_ids="\$\(grep .*"\$DRIFT_OUT".*\)")$/m)?.[1];
    expect(parse, "ship.sh's restate_ids parse line").toBeDefined();
    expect(sh).toMatch(/capture restate bash scripts\/restate-prod\.sh "\$restate_ids"/);
    const store = new InMemoryStore();
    await store.recordScorerVintage([row("F9", "old"), row("F11", "old")]);
    const res = await runVintageDrift(store, {}, [row("F9", "new"), row("F11", "new")]);
    const out = join(mkdtempSync(join(tmpdir(), "vintage-drift-parse-")), "drift.out");
    writeFileSync(out, `${res.lines.join("\n")}\n`);
    const r = spawnSync("bash", ["-c", `${parse!}; printf '%s' "$restate_ids"`], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", DRIFT_OUT: out } });
    expect(r.stdout).toBe("F9,F11");
  });

  it("--stamp refuses an implicit env; the read-only diff and an explicit env pass", () => {
    expect(stampEnvAbort(["node", "p", "--stamp"])).toMatch(/^ABORT: --stamp/);
    expect(stampEnvAbort(["node", "p", "--stamp=F9"])).toMatch(/^ABORT: --stamp/);
    expect(stampEnvAbort(["node", "p", "--stamp", "--env=local"])).toBeNull();
    expect(stampEnvAbort(["node", "p", "--env=prod", "--stamp=F9"])).toBeNull();
    expect(stampEnvAbort(["node", "p"])).toBeNull();
    expect(stampEnvAbort(["node", "p", "--applied=x"])).toBeNull();
  });

  it("migrationRestateIds reads only the head comment block", () => {
    expect(migrationRestateIds("-- restate: A,B\nselect 1;\n-- restate: C\n")).toEqual(["A", "B"]);
    expect(migrationRestateIds("select 1;\n-- restate: C\n")).toEqual([]);
  });
});

describe("--stamp", () => {
  it("stamps, prints STAMPED <n>, and a following default run is clean at exit 0", async () => {
    const store = new InMemoryStore();
    const code = [row("F9", "h1"), row("F11", "h2", 3)];
    const stamped = await runVintageDrift(store, { stamp: "all" }, code);
    expect(stamped.exitCode).toBe(0);
    expect(stamped.lines).toContain("STAMPED 2");
    expect(store.scorerVintage.size).toBe(2);
    const after = await runVintageDrift(store, {}, code);
    expect(after.exitCode).toBe(0);
    expect(after.lines.some((l) => l.startsWith("DRIFT") || l.startsWith("STAMP-ONLY"))).toBe(false);
  });

  it("a named subset stamps only those ids; an unknown id aborts with nothing written", async () => {
    const store = new InMemoryStore();
    const code = [row("F9", "h1"), row("F11", "h2")];
    const subset = await runVintageDrift(store, { stamp: ["F11"] }, code);
    expect(subset.exitCode).toBe(0);
    expect(subset.lines).toContain("STAMPED 1");
    expect([...store.scorerVintage.keys()]).toEqual(["F11"]);
    const bogus = await runVintageDrift(store, { stamp: ["NOPE"] }, code);
    expect(bogus.exitCode).toBe(1);
    expect(bogus.lines.some((l) => l.startsWith("STAMP ABORT: unknown id(s) NOPE"))).toBe(true);
    expect(store.scorerVintage.size).toBe(1); // unchanged
  });
});
