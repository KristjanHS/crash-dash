/**
 * probe-dbauth.ts — the ONLY valid falsifier for `SUPABASE_DB_PASSWORD`.
 *
 * Why this exists (D3): every `supabase` CLI
 * call is USELESS as a credential check. `supabase migration list --linked --password <garbage>`
 * returns **exit 0** — the CLI uses credentials cached at `link` time and ignores the flag. So a
 * green `make ship` does NOT prove the `.env.prod` password is correct; it proves only that a
 * `link` succeeded at some point in the past. That is a cached-credential illusion, and it hides
 * a rotated/wrong password until the moment a real connection is needed.
 *
 * This probe opens a DIRECT `pg` connection instead, so the password is actually authenticated:
 *   - correct password        → `AUTH OK`, exit 0
 *   - wrong password          → `28P01 invalid_password`, exit 1
 *   - wrong pooler host       → `XX000 tenant or user not found`, exit 1
 *
 * ⚠ Host gotcha, learned the hard way 2026-07-19: this project lives on the **`aws-1`** pooler
 * (host in `SUPABASE_DB_HOST`). `aws-0-…` is a DIFFERENT pooler and returns
 * `XX000 tenant not found` even with a perfectly correct password — a failure that reads exactly
 * like a bad credential. The real host comes from the env, or from the checkout's prod config
 * (`scripts/lib/prod-config.ts`); an exported `SUPABASE_DB_HOST` wins over the file.
 *
 * Read-only: connects, runs `select 1`, disconnects. Touches no table.
 *
 * Usage:  npm run probe:dbauth          (expects SUPABASE_PROJECT_REF + SUPABASE_DB_PASSWORD + SUPABASE_DB_HOST)
 * Prod creds live in the checkout's prod config:  bash scripts/with-prod-config.sh npm run probe:dbauth
 */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { readEnv } from "../src/config.js";
import { loadProdConfig } from "./lib/prod-config.js";

// Only the host, and only when the env lacks it: no config → the MISSING line below, not a throw.
if (!process.env.SUPABASE_DB_HOST) loadProdConfig(process.env, { only: ["SUPABASE_DB_HOST"], optional: true });
const env = readEnv();
const ref = env.SUPABASE_PROJECT_REF;
const password = env.SUPABASE_DB_PASSWORD;
const host = env.SUPABASE_DB_HOST;

if (!ref || !password || !host) {
  console.error(
    "probe:dbauth — missing creds.\n" +
      "  SUPABASE_PROJECT_REF   " +
      (ref ? "set" : "MISSING") +
      "\n  SUPABASE_DB_PASSWORD   " +
      (password ? "set" : "MISSING") +
      "\n  SUPABASE_DB_HOST       " +
      (host ? "set" : "MISSING (env, or the prod config's .env.prod)") +
      "\nProd values live in the checkout's prod config:  bash scripts/with-prod-config.sh npm run probe:dbauth",
  );
  process.exit(2);
}

const port = Number(env.SUPABASE_DB_PORT || 5432);
const user = `postgres.${ref}`;

// TLS-chain verification is ON (M-5, 2026-08-18 security audit). This connection carries the DB
// password, so a silent-accept-any-cert MITM must not be possible. The pooler chain terminates on
// Supabase's OWN private root (`Supabase Root 2021 CA`) — NOT a public CA in Node's bundle — so the
// root is pinned in-repo (`certs/supabase-pooler.pem`, Supabase's published `prod-ca-2021.crt`,
// fingerprint verified against the live handshake) and handed to `ca`.
// The pin's expiry is WATCHED — `scripts/probe-dbauth.test.ts` reads the PEM's `notAfter` and goes
// red while there is still lead time, so a rotation surfaces in CI instead of as an opaque TLS
// handshake failure here. On that red: re-fetch Supabase's current published root and replace the
// PEM (the test carries the threshold; do not restate it). This is a probe, never deployed.
const ca = readFileSync(new URL("../certs/supabase-pooler.pem", import.meta.url), "utf8");
const client = new Client({
  host,
  port,
  user,
  password,
  database: "postgres",
  ssl: { ca, rejectUnauthorized: true },
  connectionTimeoutMillis: 15_000,
});

console.log(`probe:dbauth → ${user}@${host}:${port}/postgres`);

try {
  await client.connect();
  await client.query("select 1");
  console.log("AUTH OK — SUPABASE_DB_PASSWORD authenticates against prod.");
  process.exitCode = 0;
} catch (err) {
  const code = (err as { code?: string }).code;
  const message = err instanceof Error ? err.message : String(err);
  const hint =
    code === "28P01"
      ? "SUPABASE_DB_PASSWORD is WRONG (or was rotated). Supabase → Project Settings → Database."
      : code === "XX000"
        ? `Pooler rejected the tenant. Is ${host} the right host for project ${ref}? ` +
          "aws-0-… vs aws-1-… is the usual cause, and it is NOT a password problem."
        : "Connection failed before authentication could be judged — treat the password as UNVERIFIED.";
  console.error(`AUTH FAILED — ${code ?? "no code"}: ${message}\n  ${hint}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
