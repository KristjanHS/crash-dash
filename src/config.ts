/**
 * Central environment-config seam: `readEnv()` is the ONE `process.env` read of app config in src/api/scripts,
 * and every accessor below takes an `Env` param — entries call `readEnv()` per invocation and pass it down (never
 * a snapshot at import); tests pass env literals. `ENV_KEYS` is the whole set: a key outside it is a compile
 * error, and it must equal the keys `.env.example` lists. The one other read, `childProcessEnv()`, is not
 * config: it hands a child process the inherited environment (PATH, HOME, …) with every `ENV_KEYS` key dropped,
 * so it carries no app config or secret; `src/boundary-guards.test.ts` pins its importers to `src/prod-writes.ts`.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** Every env var the app, its handlers and its scripts read. Mirrors the `KEY=` lines of `.env.example`. */
export const ENV_KEYS = [
  "SUPABASE_URL",
  // NOT a typo — do NOT "fix" to `_ROLE_`: the app reads SUPABASE_SERVICE_KEY (the manual Vercel-prod var).
  // The Supabase↔Vercel integration injects `_ROLE_` variants the app deliberately ignores.
  "SUPABASE_SERVICE_KEY",
  // Public anon key: browser pages (the sign-in session). NOT a store key — getStore("ro")
  // reads on SUPABASE_SERVICE_KEY behind a read-only handle (`ReadStore`, src/store.ts).
  "SUPABASE_ANON_KEY",
  "NTFY_TOPIC",
  "BREVO_API_KEY",
  "EMAIL_FROM",
  "FRED_API_KEY",
  "CRON_SECRET",
  "LADDER_TZ",
  "VERCEL",
  "VERCEL_DEPLOYMENT_ID",
  // Vercel system var: the project's production domain (bare host) — `dashboardUrl`'s fallback.
  "VERCEL_PROJECT_PRODUCTION_URL",
  "NODE_ENV",
  "SUPABASE_PROJECT_REF",
  "SUPABASE_DB_PASSWORD",
  "SUPABASE_DB_HOST",
  "SUPABASE_DB_PORT",
  "SUPABASE_ACCESS_TOKEN",
  "PROD_ALIAS",
  "PSI_API_KEY",
  // The checkout's prod-writes switch override (`src/prod-writes.ts`); blank = the `.prod-writes` file decides.
  "PROD_WRITES",
] as const;

type EnvKey = (typeof ENV_KEYS)[number];
export type Env = Readonly<Partial<Record<EnvKey, string>>>;

/** The live `ENV_KEYS` slice of the process environment, re-read on every call (unset keys absent). */
export function readEnv(): Env {
  return Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]).filter(([, v]) => v !== undefined)) as Env;
}

const ENV_KEY_SET: ReadonlySet<string> = new Set(ENV_KEYS);

/**
 * A child process's env: this process's environment, re-read on every call, minus every `ENV_KEYS` key (app config
 * and secrets never reach the child) and minus the `omit` keys. Child-process plumbing only — never read config off it.
 */
export function childProcessEnv(
  omit: ReadonlySet<string> = new Set(),
  inherited: Readonly<Record<string, string | undefined>> = process.env, // test seam; callers leave it defaulted
): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(inherited).filter(([k]) => !ENV_KEY_SET.has(k) && !omit.has(k)));
}

/**
 * ntfy topic. The topic name IS the auth (anyone who knows it can read every
 * alert and POST spoofed pushes), so prod MUST set NTFY_TOPIC to a private,
 * rotated value. The literal below is a placeholder DEV default only — off-prod
 * pushes need an explicit NTFY_TOPIC (`ntfyPushEnabled`), so nothing is ever sent to it.
 */
const DEV_NTFY_TOPIC = "crash-dash-dev";

/** Prod runtime = Vercel or NODE_ENV=production — shared by the topic guard + push gate. */
function isProdRuntime(env: Pick<Env, "VERCEL" | "NODE_ENV">): boolean {
  return env.VERCEL === "1" || env.NODE_ENV === "production";
}

export function ntfyTopic(env: Env): string {
  // Treat an empty/whitespace NTFY_TOPIC as UNSET, not as a topic: `??` only
  // catches null/undefined, so a `NTFY_TOPIC=` line (empty) would otherwise push to
  // the bare `ntfy.sh/` root → 400. Falling back to the dev default on a blank value
  // applies a truthy check (empty string is falsy) and keeps a misconfigured env from
  // silently breaking every push.
  const topic = env.NTFY_TOPIC?.trim();
  if (topic) return topic;
  // On prod an unset topic must FAIL LOUD at the push site (same posture as getStore()),
  // never fall back to the PUBLIC dev topic below — anyone watching it reads the owner's
  // alerts and can POST a spoofed one (audit rank 2). run-cycle-push.ts's per-push catch persists
  // this as push_error, so the misconfig is visible in the alert row, not a silent leak.
  if (isProdRuntime(env)) {
    throw new Error(
      "NTFY_TOPIC is unset on prod - refusing the public dev-topic fallback. " +
        "Set a private topic: vercel env add NTFY_TOPIC production",
    );
  }
  return DEV_NTFY_TOPIC;
}

/**
 * Whether a real ntfy push may fire. The DEV default topic is PUBLIC (published
 * in this repo), so a blank/unset NTFY_TOPIC must NOT silently POST to it from a
 * local `npm start` or an e2e run — that would spam (and let anyone spoof) a live
 * topic. Push only when the topic is EXPLICITLY set (a dev opts in with their own
 * topic), or we're on the prod runtime (Vercel / NODE_ENV=production) — where the
 * send path must proceed so a missing topic hits `ntfyTopic`'s fail-loud throw
 * instead of being silently suppressed. Off-prod + blank ⇒ no send.
 */
export function ntfyPushEnabled(env: Env): boolean {
  const explicit = !!env.NTFY_TOPIC?.trim();
  return explicit || isProdRuntime(env);
}

/**
 * FRED API key — OPTIONAL: unset keeps the current keyless FRED CSV feed exactly (see
 * fred.ts). Set (the key is FREE from stlouisfed.org) promotes the official keyed FRED
 * API to the PRIMARY access path, with the keyless CSV endpoint kept as the fallback —
 * FRED is tightening keyless access (audit rank 3), so a second path hardens the feed.
 */
export function fredApiKey(env: Env): string | undefined {
  return env.FRED_API_KEY;
}

/** Cron bearer secret — required at the /api/cron/run boundary (asserted there); also unlocks /api/health's deep probe. */
export function cronSecret(env: Env): string | undefined {
  return env.CRON_SECRET;
}

// Constant-time bearer compare: hash both sides to a fixed 32-byte digest so
// timingSafeEqual never length-throws and the compare can't short-circuit on a byte.
const sha256 = (s: string): Buffer => createHash("sha256").update(s).digest();

/** True iff `req` carries `Authorization: Bearer <secret>`. A blank/unset secret never matches. */
export function cronBearerOk(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  return timingSafeEqual(sha256(req.headers.get("authorization") ?? ""), sha256(`Bearer ${secret}`));
}

/**
 * Email fan-out (Brevo transactional API, `src/email.ts`). Both values come from the `env` param.
 * Blank/unset ⇒ `emailSendEnabled()` is false and `sendBandEmail`
 * warns + skips — on prod too: the code ships
 * BEFORE the owner sets the env, so a `ntfyTopic`-style fail-loud throw would
 * error every cron until then. Whitespace-only counts as blank (`??` would not catch it).
 */
export function brevoApiKey(env: Env): string | undefined {
  const key = env.BREVO_API_KEY?.trim();
  return key || undefined;
}

/** The Brevo-verified sender address; also the mail's `to` (recipients ride in `bcc`). */
export function emailFrom(env: Env): string | undefined {
  const from = env.EMAIL_FROM?.trim();
  return from || undefined;
}

export function emailSendEnabled(env: Env): boolean {
  return brevoApiKey(env) !== undefined && emailFrom(env) !== undefined;
}

/** A host-or-https-URL value → `https://<host>` (no trailing slash), or undefined when blank or malformed. */
function httpsOrigin(raw: string | undefined): string | undefined {
  let a = (raw ?? "").trim().replace(/\/+$/, "");
  if (a === "") return undefined;
  if (!a.startsWith("https://")) {
    if (a.includes("://")) return undefined;
    a = `https://${a}`;
  }
  return /^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?$/.test(a) ? a : undefined;
}

/**
 * The dashboard's public origin — the push's `Click` target and the mail footer's links. `PROD_ALIAS` (bare host
 * or https URL) wins; blank ⇒ Vercel's `VERCEL_PROJECT_PRODUCTION_URL`; neither ⇒ undefined. A malformed set
 * `PROD_ALIAS` is undefined too (no fallback past a value someone set), so `/api/status` `alertLinks` reads false.
 * Never throws: an alert is still sent without its link.
 */
export function dashboardUrl(env: Env): string | undefined {
  if (env.PROD_ALIAS?.trim()) return httpsOrigin(env.PROD_ALIAS);
  return httpsOrigin(env.VERCEL_PROJECT_PRODUCTION_URL);
}

/** The ladder md's `run HH:MM EEST` wall-clock zone — `renderLadderMd`'s default, so a UTC shell's render/apply
 *  commits the same md. */
export const DEFAULT_LADDER_TZ = "Europe/Tallinn";

/** `LADDER_TZ` overrides `DEFAULT_LADDER_TZ`; blank/unset ⇒ the default. */
export function ladderTz(env: Env): string {
  return env.LADDER_TZ || DEFAULT_LADDER_TZ;
}
