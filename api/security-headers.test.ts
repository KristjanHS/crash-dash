import { readdirSync, readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { GET as metaGET } from "./meta.js";
import { PLACEHOLDER } from "../scripts/stamp-deploy-config.js";

type Rule = { source: string; headers: { key: string; value: string }[] };

const cfg = JSON.parse(
  readFileSync(new URL("../vercel.json", import.meta.url), "utf8"),
) as { headers?: Rule[] };

const rules = cfg.headers ?? [];

/**
 * The one host the browser may talk to besides this origin (S-2). The repo copy is the deploy
 * stamp's placeholder (`scripts/stamp-deploy-config.ts`), which rewrites every site this suite pins
 * to the same real host in the uploaded tree — so they must all spell the placeholder here.
 */
const SUPABASE_ORIGIN = `https://${PLACEHOLDER.host}`;

/** Header lookup is case-insensitive per RFC 9110; vercel.json spells them mixed-case. */
const valueOf = (rule: Rule, key: string): string | undefined =>
  rule.headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;

/**
 * Approximate Vercel's path-to-regexp `source` matching, well enough to answer the
 * one question this file asks: could this rule land on an /api/* route? `(.*)` is the
 * only wildcard the config uses; alternation groups are already valid regex.
 */
const matches = (source: string, path: string): boolean =>
  new RegExp(`^${source.replace(/\(\.\*\)/g, ".*")}$`).test(path);

/** Routes whose Cache-Control is owned by the handler, never by vercel.json. */
const API_ROUTES = ["/api/lab", "/api/meta", "/api/replay", "/api/exposure"];

describe("vercel.json security + cache headers", () => {
  it("serves the security headers on every route", () => {
    const catchAll = rules.filter((r) => matches(r.source, "/lab"));
    const csp = catchAll.map((r) => valueOf(r, "Content-Security-Policy")).filter(Boolean);
    expect(csp).toHaveLength(1);
    // Enforced, never Report-Only: no report collector can exist under the 8-handler
    // pin (api/deploy-budget.test.ts), so report-only would emit to the console alone.
    expect(catchAll.some((r) => valueOf(r, "Content-Security-Policy-Report-Only"))).toBe(false);
    expect(csp[0]).toContain("default-src 'self'");
    expect(csp[0]).toContain("script-src 'self'");
    // The whole point of the policy: an escaping slip must not become script execution.
    expect(csp[0]).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    // Same for styles (rung 5): every page-scoped block moved to its own public/<page>.css and
    // the six static `style=` attributes became classes, so 'unsafe-inline' has no remaining
    // consumer here. It matters because an injected <style> reads the DOM through selectors —
    // attribute-value exfiltration, and `position:fixed` overlays over an authenticated action.
    expect(csp[0]).toContain("style-src 'self'");
    expect(csp[0]).not.toMatch(/style-src[^;]*'unsafe-inline'/);
    // Clickjacking on journal.html, the one page with an authenticated action.
    expect(csp[0]).toContain("frame-ancestors 'none'");
    // Three gadgets with no legitimate use here, each a documented CSP bypass: `<base>` rewrites
    // every relative script URL, a form posts wherever it likes, and `<object>` runs plugin content
    // that script-src does not govern. public/ has zero <form>, <base>, <object> and <embed>, so
    // 'none' is free — and these assertions are what keeps a later one from being added silently.
    expect(csp[0]).toContain("base-uri 'none'");
    expect(csp[0]).toContain("form-action 'none'");
    expect(csp[0]).toContain("object-src 'none'");
    expect(catchAll.map((r) => valueOf(r, "X-Content-Type-Options"))).toContain("nosniff");
    expect(catchAll.map((r) => valueOf(r, "Referrer-Policy"))).toContain(
      "strict-origin-when-cross-origin",
    );
  });

  it("pins the defence-in-depth headers (F5) - each one, by value", () => {
    const catchAll = rules.filter((r) => matches(r.source, "/lab"));
    const only = (key: string): string | undefined => {
      const found = catchAll.map((r) => valueOf(r, key)).filter(Boolean);
      expect(found, `${key} must be set exactly once on the catch-all rule`).toHaveLength(1);
      return found[0];
    };

    // Deny every powerful feature the app has no use for, so a future injected script
    // (or an embedded third party, if one is ever added) cannot prompt for them. This is
    // the standardised registry set only: an UNRECOGNISED feature name makes Chrome log
    // an "Unrecognized feature" console error, which is exactly the noise that trains a
    // reader to ignore the console. `interest-cohort` is
    // deliberately NOT here: FLoC was withdrawn, so the token is now unrecognised.
    const pp = only("Permissions-Policy")!;
    for (const feature of [
      "camera",
      "microphone",
      "geolocation",
      "payment",
      "usb",
      "serial",
      "bluetooth",
      "midi",
      "display-capture",
      "idle-detection",
      "accelerometer",
      "gyroscope",
      "magnetometer",
      "screen-wake-lock",
      "xr-spatial-tracking",
      "autoplay",
      "encrypted-media",
    ]) {
      expect(pp, `Permissions-Policy must deny ${feature}`).toContain(`${feature}=()`);
    }
    // An allowlisted feature would read `feature=(self)` / `feature=("https://…")`. Nothing
    // here is allowed to anyone, so every entry must be the empty list.
    expect(pp).not.toMatch(/=\((?!\))/);
    // Not denied on purpose: journal.html holds the one authenticated action, and denying
    // publickey-credentials-get would break WebAuthn if that auth path is ever taken.
    expect(pp).not.toContain("publickey-credentials-get");

    // Cross-origin isolation of the browsing context: a window this page opens (or that
    // opened it) lands in a different agent cluster, so it cannot reach back through
    // window.opener. Free here — nothing in public/ calls window.open on a third party.
    expect(only("Cross-Origin-Opener-Policy")).toBe("same-origin");
    // The static assets are served with `access-control-allow-origin: *`; CORP is what
    // stops another site embedding them as a subresource (and, with COOP, what keeps a
    // Spectre-style cross-origin read out of this origin's process).
    expect(only("Cross-Origin-Resource-Policy")).toBe("same-origin");
    // Redundant with `frame-ancestors 'none'` on every browser that ships CSP L2 — kept
    // because it is one line and it covers the ones that do not.
    expect(only("X-Frame-Options")).toBe("DENY");
    // Legacy Flash/Acrobat crossdomain.xml policy surface. No such file exists here; the
    // header states that absence rather than leaving it to a default.
    expect(only("X-Permitted-Cross-Domain-Policies")).toBe("none");
  });

  it("lets journal.js reach Supabase - connect-src covers every cross-origin fetch in public/", () => {
    // The H-2 inventory covered STATIC html resources and found them clean, which is why the
    // policy first shipped without connect-src. It missed the axis connect-src actually governs:
    // RUNTIME fetch targets. public/journal.js posts to `${conn.url}/auth/v1/otp` and reads/writes
    // `${conn.url}/rest/v1/holdings_journal` on the user's own Supabase project — cross-origin, so
    // `default-src 'self'` darks journal login, read AND append. Caught in review before deploy.
    const csp = rules
      .map((r) => valueOf(r, "Content-Security-Policy"))
      .find(Boolean)!;
    const connectSrc = /connect-src ([^;]+)/.exec(csp)?.[1];
    expect(connectSrc, "no connect-src directive; it would fall back to default-src").toBeDefined();
    expect(connectSrc).toContain("'self'"); // every /api/* call in app.js, lab.js, exposure.js
    // Pinned to the exact project host, never `https://*.supabase.co`: anyone can register a free
    // project under that wildcard, which made it an attacker-reachable exfiltration destination for
    // the journal access token this origin holds in sessionStorage (public/journal.js:115).
    expect(connectSrc).toContain(SUPABASE_ORIGIN); // journal-view.js otp/rest URLs
    expect(connectSrc).not.toMatch(/\*\.supabase\.co/);
  });

  it("pins the CSP host and the browser copy to the deploy stamp's placeholder", () => {
    // The pin is only worth having if it cannot drift. Two repo sites spell this host: the browser
    // copy (public/supabase-host.js — a `scripts/` module is unimportable from public/) and the
    // vercel.json literal (the config cannot interpolate env). Both hold the stamp's placeholder, so
    // the deploy rewrites them to one real host together; a hand-edited real host goes red here.
    //
    // The browser copy is read as TEXT, not imported: tsconfig.json sets no `allowJs`, so a TS
    // import of an untyped public/*.js would not typecheck. Same idiom as apply-waf-rules.sh below.
    const hostSrc = readFileSync(new URL("../public/supabase-host.js", import.meta.url), "utf8");
    const declared = /export const SUPABASE_HOST = "([^"]+)"/.exec(hostSrc)?.[1];
    expect(declared, "public/supabase-host.js no longer declares SUPABASE_HOST").toBeDefined();
    expect(declared).toBe(PLACEHOLDER.host);

    const csp = rules.map((r) => valueOf(r, "Content-Security-Policy")).find(Boolean)!;
    const tokens = (/connect-src ([^;]+)/.exec(csp)?.[1] ?? "").trim().split(/\s+/);
    // Equality, not containment: a token that merely CONTAINS the host (a path suffix, a stray
    // wildcard prefix) is a different policy and must not pass as a pin.
    expect(tokens).toContain(`https://${declared}`);
    expect(tokens.filter((t) => t.includes("supabase"))).toEqual([SUPABASE_ORIGIN]);
  });

  it("the repo copy of the browser anon key is the stamp's placeholder, never a real key", () => {
    // `public/supabase-host.js` carries the PUBLIC anon key for the zero-function subscribe page
    //. The deploy stamp writes the real key (and refuses
    // one that is not key-shaped); the repo copy must stay the placeholder token, or the stamp's
    // declared-file check refuses the deploy and a real key would be committed.
    const hostSrc = readFileSync(new URL("../public/supabase-host.js", import.meta.url), "utf8");
    const key = /export const SUPABASE_ANON_KEY = "([^"]*)"/.exec(hostSrc)?.[1];
    expect(key, "public/supabase-host.js no longer declares SUPABASE_ANON_KEY").toBe(PLACEHOLDER.anonKey);
  });

  it("covers every RUNTIME fetch origin in public/, not just the static resources", () => {
    // The defect class this closes: the H-2 inventory enumerated STATIC html resources and
    // shipped a policy with no connect-src at all, which darked journal on first deploy. A
    // keyword pin on "supabase" would not have caught it and would not catch the NEXT new
    // origin either — so this derives the origin set from the code and asserts coverage.
    const dir = new URL("../public/", import.meta.url);
    const scripts = new Map(
      readdirSync(dir)
        .filter((n) => n.endsWith(".js") && !n.includes(".test."))
        .map((n) => [n, readFileSync(new URL(n, dir), "utf8")] as const),
    );

    /** The `nth` argument (0-based) of a `fetch(` call, paren/quote-aware — it spans lines and holds commas. */
    const argAt = (src: string, open: number, nth = 0): string => {
      let depth = 0;
      let at = open + 1;
      let seen = 0;
      let quote = "";
      for (let i = open; i < src.length; i += 1) {
        const c = src[i]!;
        if (quote) {
          if (c === "\\") i += 1;
          else if (c === quote) quote = "";
          continue;
        }
        if (c === '"' || c === "'" || c === "`") quote = c;
        else if ("([{".includes(c)) depth += 1;
        else if (")]}".includes(c)) {
          depth -= 1;
          if (depth === 0) return seen === nth ? src.slice(at, i) : "";
        } else if (c === "," && depth === 1) {
          if (seen === nth) return src.slice(at, i);
          seen += 1;
          at = i + 1;
        }
      }
      return src.slice(at);
    };

    /** Every string/template literal's opening text inside a slice — enough to read its origin. */
    const literalPrefixes = (code: string): string[] =>
      [...code.matchAll(/[`"']([^`"'\n]{0,80})/g)].map((m) => m[1] ?? "");

    /**
     * One literal's origin requirement. `'self'` for a same-origin path; a concrete origin for an
     * absolute URL; `SUPABASE_ORIGIN` for the one target that is not statically knowable from the
     * source — the user-entered Supabase project URL (`conn.url`, `journal-view.js
     * normalizeConnection`). Until S-3 (rung 6) tightens that regex, the CSP is what constrains
     * `conn.url` to the pinned origin, so the pinned origin IS the only reachable value here; a
     * journal user on a Supabase custom domain stays blocked, as ruled.
     */
    const originOf = (lit: string): string | null => {
      // `//host/x` is PROTOCOL-RELATIVE and cross-origin, and it starts with "/" — so it must be
      // read as an origin BEFORE the same-origin-path branch, or it slips through as 'self'.
      const protocolRelative = /^\/\/([^/`"'${\s]+)/.exec(lit);
      if (protocolRelative) return `https://${protocolRelative[1]!}`;
      if (lit.startsWith("/")) return "'self'";
      const absolute = /^(https?:\/\/[^/`"'${\s]+)/.exec(lit);
      if (absolute) return absolute[1]!;
      if (/^\$\{[A-Za-z_$][\w$]*\.url\}/.test(lit)) return SUPABASE_ORIGIN;
      const constPrefix = /^\$\{([A-Za-z_$][\w$]*)\}\//.exec(lit);
      if (constPrefix) {
        for (const src of scripts.values()) {
          const def = new RegExp(`const ${constPrefix[1]} = "([^"]*)"`).exec(src);
          if (def) return def[1]!.startsWith("/") ? "'self'" : originOf(def[1]!);
        }
      }
      return null;
    };

    /** A URL helper's own literals — one hop, wherever in public/ it is defined. */
    const viaHelper = (name: string): (string | null)[] | null => {
      for (const src of scripts.values()) {
        const at = src.search(new RegExp(`(export )?(function ${name}\\s*\\(|const ${name} = )`));
        if (at >= 0) {
          const origins = literalPrefixes(src.slice(at, at + 600)).map(originOf).filter((o) => o);
          return origins.length ? origins : null;
        }
      }
      return null;
    };

    /** `fetch(helper(...))` and `` fetch(`${helper(...)}?q=…`) `` both resolve through the helper. */
    const resolve = (expr: string): (string | null)[] => {
      const trimmed = expr.trim();
      const lit = /^[`"']([^`"'\n]{0,80})/.exec(trimmed);
      if (lit) {
        const interpolated = /^\$\{([A-Za-z_$][\w$]*)\(/.exec(lit[1]!);
        if (interpolated) return viaHelper(interpolated[1]!) ?? [null];
        return [originOf(lit[1]!)];
      }
      const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(trimmed);
      if (call) return viaHelper(call[1]!) ?? [null];
      // `TABLE[key].field` — every `field: "…"` literal of `const TABLE = {…}`, wherever in public/ it is defined.
      const tableField = /^([A-Za-z_$][\w$]*)\[[^\]]+\]\.([A-Za-z_$][\w$]*)$/.exec(trimmed);
      if (tableField) {
        for (const src of scripts.values()) {
          const at = src.indexOf(`const ${tableField[1]!} = {`);
          if (at < 0) continue;
          const body = src.slice(at, src.indexOf("\n};", at));
          const vals = [...body.matchAll(new RegExp(`\\b${tableField[2]!}: ["'\`]([^"'\`\n]*)`, "g"))].map((m) => originOf(m[1]!));
          if (vals.length) return vals;
        }
      }
      return [null];
    };

    // The scan key assumes `fetch(` with no space — true under the repo's prettier config, and a
    // `fetch (url)` would be skipped SILENTLY, which is the one thing this lint must not do.
    const required: { origin: string | null; where: string; expr: string }[] = [];
    // A fetch whose URL is its function's own parameter: skipped at that site, and the parameter's
    // argument is scanned at every caller instead (each forwarder must find ≥ 1 caller).
    const FORWARDERS: readonly { where: string; expr: RegExp; callee: { name: string; arg: number } | null }[] = [
      // gate-prefetch.js's prefetch forwards prefetchThenGate's URLs — the fetchOnce sites that take them are scanned.
      { where: "gate-prefetch.js", expr: /^url$/, callee: null },
    ];
    for (const [name, src] of scripts) {
      // http.js (the one `fetch` caller) forwards its caller's URL: its callers' first args are scanned instead.
      if (name === "http.js") continue;
      // `fetchOnce(` (gate-prefetch.js) is fetch with a prefetch take, `apiFetch(` (R7, app.js/lab.js) fetch
      // through the auth-session.js read seam — their literal URLs are scanned too.
      for (const m of src.matchAll(/(?<!function )\b(fetch|fetchOnce|apiFetch|getJson|send|request)\(/g)) {
        const expr = argAt(src, m.index + m[1]!.length);
        if (FORWARDERS.some((f) => f.where === name && f.expr.test(expr.trim()))) continue;
        for (const origin of resolve(expr))
          required.push({ origin, where: name, expr: expr.trim().slice(0, 60) });
      }
    }
    for (const { where, callee } of FORWARDERS) {
      if (!callee) continue;
      let callers = 0;
      for (const [name, src] of scripts) {
        for (const m of src.matchAll(new RegExp(`(?<!function )\\b${callee.name}\\(`, "g"))) {
          const expr = argAt(src, m.index + callee.name.length, callee.arg);
          callers += 1;
          for (const origin of resolve(expr))
            required.push({ origin, where: `${name} → ${where}`, expr: expr.trim().slice(0, 60) });
        }
      }
      expect(callers, `${where}: no ${callee.name}( caller found - its forwarded URL would go unscanned`).toBeGreaterThan(0);
    }

    // Establish the scan is not vacuous — and that BOTH classes it must distinguish were seen.
    expect(required.length, "no request call sites found in public/ - the lint would be vacuous").toBeGreaterThan(15);
    expect(required.some((r) => r.origin === "'self'")).toBe(true);
    expect(required.some((r) => r.origin === SUPABASE_ORIGIN)).toBe(true);

    const csp = rules.map((r) => valueOf(r, "Content-Security-Policy")).find(Boolean)!;
    const tokens = (/connect-src ([^;]+)/.exec(csp)?.[1] ?? "").trim().split(/\s+/);
    const covered = (origin: string): boolean =>
      tokens.some(
        (t) =>
          t === origin ||
          (t.startsWith("https://*.") &&
            origin.startsWith("https://") &&
            origin.endsWith(t.slice("https://*".length))),
      );

    for (const { origin, where, expr } of required) {
      // An unreadable fetch shape fails LOUDLY: a lint that shrugs at what it cannot classify
      // is the same silent pass that let connect-src ship missing.
      expect(origin, `${where}: fetch(${expr}) - origin not derivable; teach the lint this shape`).not.toBeNull();
      expect(covered(origin!), `${where}: fetch(${expr}) needs ${origin} in connect-src`).toBe(true);
    }
  });

  it("keeps public/ free of the inline styles style-src 'self' forbids", () => {
    // The CSP assertion above is only half the pin: it proves the POLICY is strict, not that the
    // pages still render under it. A re-added `<style>` block or `style=` attribute is silently
    // DROPPED by the browser, so the page ships mis-laid-out with nothing but a console warning.
    // Read live from disk, never a pinned file list, so a NEW page is covered the day it lands.
    const dir = new URL("../public/", import.meta.url);
    const pages = readdirSync(dir).filter((n) => n.endsWith(".html"));
    expect(pages.length, "no public/*.html found - this lint would be vacuous").toBeGreaterThan(3);
    for (const page of pages) {
      // Comments are stripped first: prose ABOUT `style=` (this rung left some behind) is not markup,
      // and an indictment of a docblock is a false red.
      const html = readFileSync(new URL(page, dir), "utf8").replace(/<!--[\s\S]*?-->/g, "");
      expect(html, `${page} re-added a <style> block; move it to public/<page>.css`).not.toMatch(
        /<style[\s>]/i,
      );
      expect(html, `${page} re-added a style= attribute; make it a class`).not.toMatch(
        /\sstyle\s*=\s*["']/i,
      );
    }

    // The half that was MISSING, and is why three /lab sections shipped unstyled: a script-inserted
    // <style> is governed by style-src exactly like a parser-inserted one, so `createElement("style")`
    // + head.appendChild is refused under 'self'. The rung-5 audit inventoried only CSSOM property
    // writes (`el.style.x = …`), which style-src does NOT govern, and concluded "non-issue".
    const scripts = readdirSync(dir).filter((n) => n.endsWith(".js") && !n.includes(".test."));
    expect(scripts.length, "no public/ non-test .js found - this half would be vacuous").toBeGreaterThan(20);
    // Whole-line comments only: a trailing `// …` cannot be stripped without also eating `https://`,
    // and prose about `createElement("style")` (this file's own class of note) must not self-indict.
    const decomment = (js: string): string =>
      js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*(\/\/|\*).*$/gm, "");
    // The four vectors style-src DOES govern from script. `insertRule`/`replaceSync`/
    // `adoptedStyleSheets` are deliberately ABSENT: constructable sheets and CSSOM rule insertion are
    // not style-src checked (they carry no source text the policy could match), so flagging them
    // would red working code. The five legitimate `el.style.<prop> = …` writes are ungoverned too —
    // the assertion below establishes the scan sees one and leaves it alone.
    const VECTORS: [RegExp, string][] = [
      [/createElement\(\s*["'`]style["'`]/i, 'createElement("style") - move the rules to public/<page>.css'],
      [/insertAdjacentHTML\([^)]*<style[\s>]/i, "insertAdjacentHTML of a <style> block"],
      [/\.cssText\s*=/i, ".cssText = - writes a style attribute the policy refuses"],
      [/setAttribute\(\s*["'`]style["'`]/i, 'setAttribute("style", …) - make it a class'],
    ];
    const offenders: string[] = [];
    let sawCssomWrite = false;
    for (const name of scripts) {
      const js = decomment(readFileSync(new URL(name, dir), "utf8"));
      if (/\.style\.[a-zA-Z]+\s*=[^=]/.test(js) || /style\.setProperty\(/.test(js)) sawCssomWrite = true;
      for (const [re, why] of VECTORS) if (re.test(js)) offenders.push(`${name}: ${why}`);
    }
    // Establishes the scan reaches real code AND that it distinguishes the two classes: the
    // ungoverned CSSOM writes are present in public/ and are not offenders.
    expect(sawCssomWrite, "no `el.style.x =` write found - the decomment/scan is reading nothing").toBe(true);
    expect(offenders, `style-src 'self' refuses these; ${offenders.join(" | ")}`).toEqual([]);
  });

  it("never sets Cache-Control on an /api/* route from the config", () => {
    // Handlers set their own cache headers (rung 8 tunes them per data cadence); a
    // vercel.json rule broad enough to match an API path would silently override them.
    for (const rule of rules) {
      if (!valueOf(rule, "Cache-Control")) continue;
      for (const route of API_ROUTES) {
        expect(
          matches(rule.source, route),
          `headers rule "${rule.source}" sets Cache-Control on ${route}`,
        ).toBe(false);
      }
    }
  });

  it("lets a repeat visitor reuse cached JS instead of revalidating 37 modules", () => {
    // perf P4. Bounded at an hour, not `immutable`: public/ filenames are not content-hashed —
    // rung 8's ship-time minify is minify-ONLY and deliberately leaves filenames alone — so a
    // deploy can be invisible for the whole max-age + swr total below. Content hashing is the
    // thing that would unlock `immutable`, and it is out of scope.
    const jsRule = rules.find((r) => matches(r.source, "/app.js") && valueOf(r, "Cache-Control"));
    const cc = jsRule && valueOf(jsRule, "Cache-Control");
    expect(cc).toBeDefined();
    const maxAge = Number(/max-age=(\d+)/.exec(cc!)?.[1]);
    expect(maxAge).toBeGreaterThan(0);
    // The ruled bound is "a deploy is invisible for at most an hour". `stale-while-revalidate`
    // EXTENDS that window — a module stays servable for max-age + swr — so the total, not max-age
    // alone, is what must stay <= 3600. The split BETWEEN the two is free within that total and is
    // deliberately swr-heavy (ruled 2026-08-18): past max-age a repeat visitor paints from cache and
    // revalidates behind, instead of blocking on 37 conditional requests. This assertion is what
    // caught an earlier 24x-understated swr, so it bounds the total and never max-age alone.
    const swr = Number(/stale-while-revalidate=(\d+)/.exec(cc!)?.[1] ?? 0);
    expect(maxAge + swr).toBeLessThanOrEqual(3600);
  });

  it("keeps the HTML entry points short-lived so a deploy is picked up", () => {
    // cleanUrls:true serves these extensionless; /lab is the canonical spelling.
    for (const page of ["/", "/lab", "/exposure", "/journal"]) {
      const cc = rules
        .filter((r) => matches(r.source, page))
        .map((r) => valueOf(r, "Cache-Control"))
        .filter(Boolean);
      expect(cc, `no Cache-Control rule matches ${page}`).toContain("no-cache");
    }
  });
});

describe("/api/* carries the redistribution notice (legal audit 2026-08-20 §4.3)", () => {
  // The read API serves indicator values derived from third-party feeds whose terms restrict
  // redistribution (FRED third-party copyright, ECB citation + "state that you modified it").
  // Nothing here makes the endpoints private — a static front-end cannot hold a secret — but the
  // service is no longer OFFERED for reuse: it is out of every index, and every response states
  // the restriction and the sources. Declarative in vercel.json so it covers 400s and 500s too,
  // which a per-handler header would miss.
  const apiRules = (path: string) => rules.filter((r) => matches(r.source, path));
  const ALL_API = ["/api/series", "/api/lab", "/api/replay", "/api/status", "/api/indicators", "/api/meta", "/api/exposure"];

  it("keeps every read endpoint out of search + AI-crawler indexes", () => {
    for (const route of ALL_API) {
      const tags = apiRules(route).map((r) => valueOf(r, "X-Robots-Tag")).filter(Boolean);
      expect(tags, `no X-Robots-Tag rule matches ${route}`).toHaveLength(1);
      expect(tags[0]).toContain("noindex");
    }
  });

  it("states the no-redistribution terms and cites the sources on every read endpoint", () => {
    for (const route of ALL_API) {
      const terms = apiRules(route).map((r) => valueOf(r, "X-Data-Terms")).filter(Boolean);
      expect(terms, `no X-Data-Terms rule matches ${route}`).toHaveLength(1);
      const value = terms[0]!;
      expect(value).toMatch(/no redistribution/i);
      // ECB's reuse condition is TWO limbs — cite the source AND state that the values were
      // modified. A notice that drops either limb does not satisfy it.
      expect(value).toMatch(/derived and transformed/i);
      expect(value).toMatch(/FRED|Federal Reserve Bank of St. Louis/);
      expect(value).toMatch(/ECB/);
    }
  });

  it("does not leak the notice onto the HTML pages (it describes the API payload, not the site)", () => {
    // Falsifier for the two tests above: they would also pass if the rule were the catch-all.
    for (const page of ["/", "/lab", "/exposure", "/journal"]) {
      expect(apiRules(page).map((r) => valueOf(r, "X-Data-Terms")).filter(Boolean)).toEqual([]);
    }
  });
});

describe("S-1 - an unknown query param is refused before any work (cache-key canonicalisation)", () => {
  it("400s with Cache-Control: no-store, so ?cb= cannot mint a fresh edge key with work behind it", async () => {
    // Prod-shaped: a real edge-cache-buster attempt on a live public route. Rejection lands
    // BEFORE dispatch, so no store read / upstream fetch runs — the abuse costs a 400, not a MISS.
    const res = await metaGET(new Request("https://x/api/meta?view=health&cb=1"));
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
