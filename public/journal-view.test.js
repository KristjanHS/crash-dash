// Holdings journal — the pure seam (journal-view.js), plus the two page-level invariants a
// markup test alone cannot reach: every emitted class must be STYLED, and every id the shell
// looks up must EXIST in journal.html, and every class it emits must have a rule in journal.css (a green markup pin over a class with no rule, or over a
// host that was never placed, is the BAND-panel incident — testing-project.md).
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

import {
  buildEntryRow,
  describeGap,
  dialSnapshot,
  entryList,
  normalizeConnection,
  parseAuthHash,
  deleteAccountUrl,
  eraseConfirmed,
  eraseOutcome,
  ERASE_CONFIRM_WORD,
  ERASE_DONE_TEXT,
  rowsUrl,
  sessionExpired,
  magicLinkRedirect,
  JOURNAL_PATH,
  userIdFromJwt,
  legSeriesUrl,
  readingsFromSeries,
  fetchLegReadings,
  drawdownLegIds,
  firstEntryDate,
  drawdownModel,
  drawdownCardHtml,
} from "./journal-view.js";
import { SUPABASE_ORIGIN } from "./supabase-host.js";
// Single-source the 9 LADDER names off the server truth (never a hand-copied mirror) — a `.test.js`
// importer takes the `.ts` specifier, never `.js` (dev-workflow.md §Import convention).
import { LADDER } from "../src/families.ts";
import { legCloseId } from "../src/scoreboard.ts";
import { PENSION_DIP, PENSION_CORRECTION, PENSION_BEAR } from "../src/pension.ts";
// The real read handler + store fake, so the leg-read seam is driven by what /api/series actually serves.
import { handle as seriesHandle, seriesBody } from "../api/series";
import { InMemoryStore } from "../src/store-memory";
import { makeStoredReading } from "../src/test-helpers";

// The rung-ordered LEGP_* id array the server serves on /api/config, built here from the real seam.
const LADDER_IDS = LADDER.map(legCloseId);
const CUTS = { dip: PENSION_DIP, correction: PENSION_CORRECTION, bear: PENSION_BEAR };
const SEMIS = legCloseId("Semis");
/** Readings rows shaped like the readings_latest GET, for one leg over consecutive dates. */
const legReadings = (id, dates, vals) => dates.map((obs_date, i) => ({ indicator_id: id, obs_date, value: vals[i] }));

const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const HTML = read("journal.html");
const CSS = read("journal.css");
const SHELL = read("journal.js");
const SEAM = read("journal-view.js");
// The token storage moved into the shared per-tab seam (J0.2); the H-3 pin scans both.
const SESSION = read("auth-session.js");

/** A /status body shaped like the real one: the persisted notify fields + the dial blob. */
const status = (over = {}) => ({
  asOf: "2026-07-31",
  verdict: {
    date: "2026-07-31",
    level: "WATCH",
    // `dialBand` is an ALERT LEVEL on the wire (`openapi.yaml`: enum OK/WATCH/WARNING/CRITICAL),
    // written as `regimeToBand(dialState.notifyRegime)` — so "WATCH" is the projection of the
    // "Caution" blob below, and typing the regime label here (as this fixture used to) was a shape
    // the API can never serve.
    dialBand: "WATCH",
    dialTargetRung: 4,
    heldSleeve: "World equity",
    // `dial_target_rung` is a write-time PROJECTION of this blob (`src/store.ts`, the
    // `a.dialState != null ? a.dialState.targetRung : …` write), so the two MUST agree on any
    // row the store can emit — the pre-fix pairing (flat 4 beside a blob 4.2) was unemittable,
    // and 4.2 is not even a value `targetRungFor` can return.
    // The two tests that NEED the sources to disagree — the precedence probe and the fallback —
    // each supply the divergence in their own call-site override, which is the only place it can
    // live without pinning an unemittable row.
    dialState: { targetRung: 4, notifyRegime: "Caution", armed: true, fired: false },
    ...over,
  },
});

describe("dialSnapshot - the J-3 flat five plus the provenance blob", () => {
  it("reads the five measurement columns off the PERSISTED fields, keeping the blob", () => {
    // The blob is provenance across dial retunes — it must carry the served dial itself,
    // not a restatement of the flat columns.
    expect(dialSnapshot(status())).toEqual({
      suggested_rung: 4,
      band: "WATCH",
      armed: true,
      fired: false,
      severity: "WATCH",
      dial: {
        asOf: "2026-07-31",
        obsDate: "2026-07-31",
        level: "WATCH",
        dialBand: "WATCH",
        dialTargetRung: 4,
        heldSleeve: "World equity",
        dialState: status().verdict.dialState,
        displayDialState: null,
      },
    });
  });

  it("prefers the PERSISTED flat fields over the blob when the two disagree", () => {
    // THE PRECEDENCE FALSIFIER. `dialSnapshot` reads `verdict.dialTargetRung ?? dial.targetRung`
    // (and `dialBand ?? notifyRegime`) so the snapshot matches WHAT WAS PUSHED rather than a
    // recompute. Nothing else in this file separates the two sources: the base fixture agrees on 4
    // BY CONSTRUCTION (store.ts projects the column FROM the blob, and a disagreeing pair is
    // unemittable), so the
    // divergence has to be supplied HERE, at the call site, where it is visibly a reader-contract
    // probe and not a claim about a row the store can write. Invert either `??` and this reds.
    const s = dialSnapshot(
      status({ dialState: { targetRung: 6, notifyRegime: "Crisis", armed: true, fired: false } }),
    );
    expect(s.suggested_rung).toBe(4);
    expect(s.band).toBe("WATCH");
  });

  it("falls back to the dial blob when the persisted notify fields are absent", () => {
    // The discriminating regime: a row written before the dialTargetRung/dialBand columns
    // existed still has the dial blob. The blob carries a DIFFERENT rung from the base fixture's
    // flat 4, so the fallback cannot pass by luck — and because the flat column is null here, the
    // two are not a contradiction: nothing projected the blob onto a column that did not yet exist.
    const s = dialSnapshot(
      status({
        dialTargetRung: null,
        dialBand: null,
        dialState: { targetRung: 6, notifyRegime: "Caution", armed: true, fired: false },
      }),
    );
    expect(s.suggested_rung).toBe(6);
    expect(s.band).toBe("Caution");
  });

  it("E12: displayDialState rides its own blob key; armed/fired and blob.dialState stay on the notify dial", () => {
    const display = { targetRung: 7, notifyRegime: "Stress", armed: false, fired: true };
    const s = dialSnapshot(status({ displayDialState: display }));
    expect(s.dial.displayDialState).toEqual(display);
    expect(s.dial.dialState).toEqual(status().verdict.dialState);
    expect([s.armed, s.fired]).toEqual([true, false]); // notify dial's, not the display's
    expect(s.suggested_rung).toBe(4);
  });

  it("degrades every flat field to null on a pre-first-cron / degraded read", () => {
    const s = dialSnapshot(status({ dialTargetRung: null, dialBand: null, level: null, dialState: null }));
    expect(s).toMatchObject({ suggested_rung: null, band: null, armed: null, fired: null, severity: null });
    expect(dialSnapshot({}).dial).toBeNull();
  });
});

describe("buildEntryRow - validation and the exact insert row", () => {
  // rung "3" == LADDER[2]; the sleeve must be a current ladder name (J1.2).
  const form = { entryDate: "2026-07-31", sleeve: LADDER[2], rung: "3", cashPct: "12.5", note: " hold " };

  it("emits SNAKE_CASE columns and carries the snapshot through", () => {
    const snap = dialSnapshot(status());
    const built = buildEntryRow(form, snap, "u-1", [...LADDER]);
    expect(built.ok).toBe(true);
    // PostgREST posts this object verbatim: a camelCase key is a 400 from the database.
    expect(built.row).toEqual({
      ...snap,
      user_id: "u-1",
      entry_date: "2026-07-31",
      sleeve: LADDER[2],
      rung: 3,
      cash_pct: 12.5,
      note: "hold",
    });
  });

  it("lets the served snapshot win over a form field of the same name", () => {
    const built = buildEntryRow({ ...form, band: "Crisis" }, dialSnapshot(status()), "u-1", [...LADDER]);
    expect(built.row.band).toBe("WATCH");
  });

  it.each([
    ["a rung off the 1..9 ladder", { rung: "10" }],
    ["a rung that is not whole", { rung: "3.5" }],
    ["cash above 100%", { cashPct: "101" }],
    ["cash below 0%", { cashPct: "-1" }],
    ["a non-ISO date", { entryDate: "31.07.2026" }],
    ["an empty sleeve", { sleeve: "   " }],
    ["a sleeve that is not a ladder name (the J1.2 constraint)", { sleeve: "World equity" }],
  ])("rejects %s", (_label, over) => {
    const built = buildEntryRow({ ...form, ...over }, null, "u-1", [...LADDER]);
    expect(built.ok).toBe(false);
    expect(built.errors.length).toBeGreaterThan(0);
    expect(built.row).toBeUndefined();
  });

  it("rejects a save when no ladder was passed - the sleeve cannot be validated", () => {
    expect(buildEntryRow(form, null, "u-1").ok).toBe(false);
    expect(buildEntryRow(form, null, "u-1", []).ok).toBe(false);
  });

  it("rejects a signed-out write, which the insert policy would reject anyway", () => {
    expect(buildEntryRow(form, null, null, [...LADDER]).ok).toBe(false);
  });

  it("saves an entry written with no dial, with the snapshot columns explicitly null", () => {
    const built = buildEntryRow(form, null, "u-1", [...LADDER]);
    expect(built.ok).toBe(true);
    expect(built.row).toMatchObject({ suggested_rung: null, band: null, dial: null });
  });
});

describe("describeGap - held vs suggested is the point of the page", () => {
  it("marks a row held RISKIER than the dial suggested (lower rung = more aggressive)", () => {
    expect(describeGap({ rung: 2, suggested_rung: 4.5, band: "Caution" })).toEqual({
      tone: "over",
      text: "dial 4.5 (Caution) - riskier by 2.5",
    });
  });

  it("does not mark a row held at or below the suggestion", () => {
    expect(describeGap({ rung: 5, suggested_rung: 4.5 }).tone).toBe("match");
    expect(describeGap({ rung: 4.5, suggested_rung: 4.5 }).tone).toBe("match");
  });

  it("prints 'no dial' rather than 0 when no snapshot was stored", () => {
    expect(describeGap({ rung: 3, suggested_rung: null })).toEqual({ tone: "none", text: "no dial" });
  });
});

describe("list rendering", () => {
  it("renders the rung-derived ladder name, never the stored sleeve string (J1 ruling #2)", () => {
    const html = entryList(
      [{ entry_date: "2026-07-31", rung: 3, sleeve: "<img src=x> legacy free text", cash_pct: 10, suggested_rung: null }],
      [...LADDER],
    );
    // rung 3 → LADDER[2]; the old free-text sleeve relabels to it and reaches the DOM nowhere.
    expect(html).toContain(LADDER[2]);
    expect(html).not.toContain("legacy free text");
    expect(html).not.toContain("<img");
  });

  it("escapes the note, the one remaining user-typed field on a row", () => {
    const html = entryList(
      [{ entry_date: "2026-07-31", rung: 3, cash_pct: 10, suggested_rung: null, note: "<img src=x>" }],
      [...LADDER],
    );
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).not.toContain("<img");
  });

  it("renders the empty state rather than an empty list", () => {
    expect(entryList([])).toContain("jr-empty");
    expect(entryList([])).not.toContain("<ul");
  });
});

describe("magic-link fragment", () => {
  it("extracts the access token", () => {
    expect(parseAuthHash("#access_token=abc&refresh_token=r&expires_in=3600")).toMatchObject({
      accessToken: "abc",
      refreshToken: "r",
    });
  });

  it("surfaces an auth error instead of silently reading as signed-out", () => {
    expect(parseAuthHash("#error=otp_expired&error_description=Link+expired")).toEqual({ error: "Link expired" });
  });

  it("is null on a normal page load", () => {
    expect(parseAuthHash("")).toBeNull();
    expect(parseAuthHash("#s=F1")).toBeNull();
  });

  it("refuses a token whose expiry has passed, and accepts one still live (H-3)", () => {
    const now = 1_800_000_000_000;
    expect(sessionExpired(now - 1, now), "a past expiry must read as expired").toBe(true);
    expect(sessionExpired(now, now), "expiry is inclusive - at the instant it lapses it is gone").toBe(true);
    expect(sessionExpired(now + 60_000, now), "a future expiry must still be usable").toBe(false);
  });

  it("treats a missing or unparseable expiry as expired, never as unbounded", () => {
    const now = 1_800_000_000_000;
    for (const bad of [null, undefined, "", "later", NaN]) {
      expect(sessionExpired(bad, now), `${String(bad)} must not buy an unbounded session`).toBe(true);
    }
  });

  it("carries the expiry the shell persists - parseAuthHash is where it is computed", () => {
    const parsed = parseAuthHash("#access_token=abc&expires_in=3600");
    expect(sessionExpired(parsed.expiresAt)).toBe(false);
  });

  it("reads the sub claim - the id the insert policy checks against auth.uid()", () => {
    const jwt = `x.${btoa(JSON.stringify({ sub: "user-42" }))}.y`;
    expect(userIdFromJwt(jwt)).toBe("user-42");
    expect(userIdFromJwt("not-a-jwt")).toBeNull();
  });
});

describe("connection + endpoints", () => {
  it("normalizes a pasted project URL and refuses an unusable one", () => {
    expect(normalizeConnection(`${SUPABASE_ORIGIN}/`, " key ")).toEqual({
      url: SUPABASE_ORIGIN,
      anonKey: "key",
    });
    expect(normalizeConnection(SUPABASE_ORIGIN.replace("https://", "http://"), "key")).toBeNull();
    expect(normalizeConnection(SUPABASE_ORIGIN, "")).toBeNull();
  });

  it("accepts the PINNED host only - an https host is no longer enough (S-3)", () => {
    // Before S-3 every one of these passed and only the CSP stopped the request. A Supabase
    // CUSTOM DOMAIN is blocked too; that edge is ruled accepted, with no escape hatch.
    for (const host of [
      "https://attacker.example",
      "https://abc.supabase.co",
      `${SUPABASE_ORIGIN}.attacker.example`,
      `${SUPABASE_ORIGIN}@attacker.example`,
      "https://journal.my-custom-domain.test",
    ]) {
      expect(normalizeConnection(host, "key"), `${host} must not pass the host pin`).toBeNull();
    }
  });

  it("builds the magic-link return target from a CONSTANT path, not the current URL (S-3)", () => {
    expect(magicLinkRedirect("https://crash-dash.example")).toBe(`https://crash-dash.example${JOURNAL_PATH}`);
    // A trailing slash on the origin must not double up into `//journal`.
    expect(magicLinkRedirect("https://crash-dash.example/")).toBe(`https://crash-dash.example${JOURNAL_PATH}`);
    // The path is absolute and carries no query or fragment an attacker could have supplied.
    expect(JOURNAL_PATH).toMatch(/^\/[\w/-]+$/);
  });

  it("lists newest-first with a limit", () => {
    const url = rowsUrl({ url: "https://a.b" }, 5);
    expect(url).toContain("/rest/v1/holdings_journal");
    expect(url).toContain("order=entry_date.desc,created_at.desc");
    expect(url).toContain("limit=5");
  });
});

describe("the page-level invariants a markup pin cannot reach", () => {
  it("places every element the shell looks up", () => {
    const ids = [...SHELL.matchAll(/\$\("([\w-]+)"\)/g)].map((m) => m[1]);
    expect(ids.length, "the id scan must find lookups, or this test is vacuous").toBeGreaterThan(5);
    for (const id of new Set(ids)) {
      expect(HTML, `journal.js reads #${id}, which journal.html never renders`).toContain(`id="${id}"`);
    }
  });

  it("keeps every token key in the one durable store the seam owns (J0.4 reversed)", () => {
    // Establish first: the scan DOES see the shell's storage calls, or the pin is vacuous.
    const storageCalls = [...`${SHELL}\n${SESSION}`.matchAll(/(local|session)Storage\.(get|set|remove)Item\(\s*([A-Z_]+)/g)];
    expect(storageCalls.length, "no storage calls found - this pin would be vacuous").toBeGreaterThan(3);
    // Durable by ruling, and in ONE store: a split across sessionStorage would resurrect the
    // per-tab timeout for whichever half landed there.
    for (const [, kind, , key] of storageCalls) {
      expect(kind, `${key} must live in localStorage, not ${kind}Storage`).toBe("local");
    }
    expect(storageCalls.some(([, , , k]) => k.startsWith("TOKEN"))).toBe(true);
    expect(storageCalls.some(([, , , k]) => k === "REFRESH_KEY"), "the refresh token must be stored").toBe(true);
    expect(storageCalls.some(([, , , k]) => k === "CONN_KEY")).toBe(true);
  });

  it("never derives the magic-link redirect from the current URL (S-3)", () => {
    // Establish first: the scan DOES see the OTP request, or the absence check below is vacuous.
    expect(SHELL, "no redirect_to found - this pin would be vacuous").toContain("redirect_to=");
    const code = SHELL.split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    expect(code, "redirect_to must not be built from location.href/search/hash").not.toMatch(
      /redirect_to=[^\n]*location\.(href|search|hash)/,
    );
    expect(code).toContain("magicLinkRedirect(location.origin)");
  });

  it("purges a stored connection the seam no longer accepts (S-3)", () => {
    const body = SHELL.slice(SHELL.indexOf("function loadConn("));
    const fn = body.slice(0, body.indexOf("\n}\n"));
    expect(fn, "loadConn must validate through the seam").toContain("normalizeConnection(");
    expect(fn, "a rejected stored connection must be removed, not just ignored").toContain(
      "localStorage.removeItem(CONN_KEY)",
    );
  });

  it("gates every authenticated fetch on the expiry check", () => {
    // The two PostgREST calls (insert + list) must both sit behind sessionLive().
    expect(SHELL).toMatch(/function sessionLive\(\)/);
    for (const fn of ["save", "loadList"]) {
      const body = SHELL.slice(SHELL.indexOf(`function ${fn}(`));
      expect(body.slice(0, body.indexOf("\n}\n")), `${fn}() must refuse an expired token locally`).toContain(
        "sessionLive()",
      );
    }
  });

  it("keeps auth on the journal page ALONE (§E-4)", () => {
    // Establish first: the pattern DOES match the page that is supposed to have auth.
    const AUTH = /access_token|auth\/v1|Bearer |apikey/i;
    expect(AUTH.test(SHELL) || AUTH.test(SEAM)).toBe(true);
    for (const name of ["index.html", "lab.html", "exposure.html", "app.js", "lab.js", "exposure.js"]) {
      // R7: app.js/lab.js read /api/* only via auth-session.js `apiFetch` — no auth code here.
      expect(AUTH.test(read(name)), `${name} must hold no auth mechanics of its own`).toBe(false);
    }
  });

  describe("account erasure (J0.5.2)", () => {
    it("posts to the definer RPC with no identity in the URL", () => {
      const url = deleteAccountUrl({ url: SUPABASE_ORIGIN, anonKey: "k" });
      expect(url).toBe(`${SUPABASE_ORIGIN}/rest/v1/rpc/delete_my_account`);
      // The bearer IS the scope (auth.uid()) — a uid in the URL would be a tamperable parameter.
      expect(url).not.toMatch(/uid|user_id|[0-9a-f]{8}-[0-9a-f]{4}/);
    });

    it("accepts only the exact confirmation word", () => {
      expect(eraseConfirmed(ERASE_CONFIRM_WORD)).toBe(true);
      expect(eraseConfirmed(`  ${ERASE_CONFIRM_WORD}  `)).toBe(true);
      for (const near of ["delete", "Delete", "DELET", "DELETE ME", "", null, undefined]) {
        expect(eraseConfirmed(near), `${String(near)} must not confirm an irreversible erase`).toBe(false);
      }
    });

    it("treats ONLY a 2xx as an erasure", () => {
      for (const ok of [200, 204, 299]) {
        expect(eraseOutcome(ok)).toEqual({ kind: "erased", clear: true, tone: "good", message: ERASE_DONE_TEXT });
      }
      for (const bad of [400, 401, 403, 404, 409, 500, 503]) {
        expect(eraseOutcome(bad).kind, `HTTP ${bad} must never read as deleted`).not.toBe("erased");
        expect(eraseOutcome(bad).message).not.toBe(ERASE_DONE_TEXT);
      }
    });

    it("splits 404 out of the 401/403 bucket ([USER] 2026-09-07)", () => {
      // A dead token: say so and drop the stored session.
      for (const dead of [401, 403]) {
        expect(eraseOutcome(dead)).toMatchObject({ kind: "expired", clear: true });
        expect(eraseOutcome(dead).message).toMatch(/session expired/i);
      }
      // PostgREST answers 404 for a function that does not EXIST — prod's state until the
      // migration is applied. Signing that visitor out sends them into a magic-link loop.
      const missing = eraseOutcome(404);
      expect(missing).toMatchObject({ kind: "unavailable", clear: false });
      expect(missing.message).not.toMatch(/session expired/i);
      expect(missing.message).toMatch(/imprint/i);
    });

    it("wires the control as a terminal takeover, not a return to sign-in", () => {
      expect(HTML).toContain('id="danger-card"');
      expect(HTML).toContain('id="erased-card"');
      // Every card the shell can show must be closed by the erased latch, sign-in included.
      const render = SHELL.slice(SHELL.indexOf("function render()"));
      const body = render.slice(0, render.indexOf("\n}\n"));
      expect(body, "the sign-in card must not come back after an erasure").toMatch(/auth-card"\)\.hidden = erased/);
      expect(body).toMatch(/erased-card"\)\.hidden = !erased/);
      expect(body, "the danger card is signed-in-only").toMatch(/danger-card"\)\.hidden = !signedIn/);
    });

    it("gates the RPC call on the typed word AND a live session", () => {
      const fn = SHELL.slice(SHELL.indexOf("async function eraseAccount("));
      const body = fn.slice(0, fn.indexOf("\n}\n"));
      expect(body).toContain("eraseConfirmed(");
      expect(body).toContain("sessionLive()");
      // The latch is set from the classifier's verdict, never from a bare `res.ok` or a catch.
      expect(body).toMatch(/outcome\.kind === "erased"/);
    });

    it("routes both unsub copies and /privacy at the control", () => {
      const SUB = read("subscribe-view.js");
      expect(SUB).not.toMatch(/erase everything[^"]*\/privacy/);
      expect([...SUB.matchAll(/erase everything[^"]*\/journal/g)]).toHaveLength(3);
      const PRIVACY = read("privacy.html");
      expect(PRIVACY, "/privacy must name the shipped control, not mail alone").toMatch(/Delete my account/);
      expect(PRIVACY, "the cannot-sign-in fallback stays").toMatch(/\/imprint/);
    });
  });
});

describe("drawdown leg reads - one /api/series GET per held leg (J1.4)", () => {
  it("legSeriesUrl: a same-origin /api/series URL, `from` floored to the handler's month-start grid; a non-ISO date is rejected", () => {
    expect(legSeriesUrl(SEMIS, "2026-03-17")).toBe(`/api/series?id=${SEMIS}&from=2026-03-01`);
    for (const bad of ["31.07.2026", "2026-1-1", "", "2026-01-01T00:00:00Z", "not-a-date", null, undefined]) {
      expect(() => legSeriesUrl(SEMIS, bad), `${String(bad)} must be rejected`).toThrow(/YYYY-MM-DD/);
    }
  });

  const SPX = legCloseId("S&P 500");
  const body = (id, pts) => ({ indicatorId: id, label: id, points: pts.map(([date, value]) => ({ date, value, state: "GREEN" })) });

  it("reassembles N bodies into the drawdownModel row shape, ordered by obs_date then id", () => {
    const rows = readingsFromSeries([
      body(SPX, [["2026-01-01", 50], ["2026-01-02", 51]]),
      body(SEMIS, [["2026-01-01", 100], ["2026-01-03", 90]]),
    ]);
    expect(rows).toEqual([
      { indicator_id: SEMIS, obs_date: "2026-01-01", value: 100 },
      { indicator_id: SPX, obs_date: "2026-01-01", value: 50 },
      { indicator_id: SPX, obs_date: "2026-01-02", value: 51 },
      { indicator_id: SEMIS, obs_date: "2026-01-03", value: 90 },
    ]);
  });

  it("a non-redacted body's null point (warm-up gap) yields no row for that date", () => {
    const rows = readingsFromSeries([body(SEMIS, [["2026-01-01", null], ["2026-01-02", 100]])]);
    expect(rows).toEqual([{ indicator_id: SEMIS, obs_date: "2026-01-02", value: 100 }]);
  });

  it("ANY redacted body → null → the card says unavailable, never a drawdown on nulls", () => {
    const redacted = { ...body(SPX, [["2026-01-01", null], ["2026-01-02", null]]), redacted: true };
    expect(readingsFromSeries([body(SEMIS, [["2026-01-01", 100]]), redacted])).toBeNull();
    const rows = [{ entry_date: "2026-01-01", rung: 1, cash_pct: 0, created_at: "2026-01-01T09:00:00Z" }];
    const model = drawdownModel({ rows, legIds: LADDER_IDS, names: [...LADDER], readings: null, cuts: CUTS, confirmCloses: 2 });
    expect(model.kind).toBe("unavailable");
    expect(drawdownCardHtml(model)).toContain("Drawdown unavailable");
  });

  describe("driven through the real handler", () => {
    // 500 daily rows from 2024-01-01: a from-only window spans > the handler's default 365-row limit.
    const store = new InMemoryStore();
    const days = Array.from({ length: 500 }, (_, i) => new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString().slice(0, 10));
    const VALUE = legCloseId("Value"); // the chained-only (non-registry) leg id
    beforeAll(async () => {
      for (const id of [SEMIS, VALUE]) {
        await store.recordReadings(days.map((date, i) => makeStoredReading(id, { date, value: 100 + i })), "2026-01-01T00:00:00Z");
      }
    });
    const NOW = new Date("2026-01-01T00:00:00Z");
    // `full`: the handler's unredacted body (`seriesBody`), served as-is; `served`: the real response rule.
    const full = async (url) => {
      const body = await seriesBody(() => store, new Request(`https://x${url}`), { now: NOW });
      return body instanceof Response ? body : Response.json(body);
    };
    const served = (url) => seriesHandle(() => store, new Request(`https://x${url}`), { now: NOW });
    // A mid-month first entry: the read starts at its month start (index 31 = 2024-02-01).
    const FROM = "2024-02-15";
    const START = days.indexOf("2024-02-01");

    it("an unredacted body yields every in-window row of every leg, raw", async () => {
      const rows = await fetchLegReadings(full, [SEMIS, VALUE], FROM);
      expect(rows).toHaveLength(2 * (days.length - START));
      expect(rows[0]).toEqual({ indicator_id: SEMIS, obs_date: "2024-02-01", value: 100 + START });
      expect(rows[1]).toEqual({ indicator_id: VALUE, obs_date: "2024-02-01", value: 100 + START });
      expect(rows.at(-1)).toEqual({ indicator_id: VALUE, obs_date: days.at(-1), value: 100 + days.length - 1 });
    });

    it("the served read is redacted → null", async () => {
      expect(await fetchLegReadings(served, [SEMIS, VALUE], FROM)).toBeNull();
    });

    it("a non-ok answer throws rather than returning a partial book", async () => {
      await expect(fetchLegReadings(served, [SEMIS, "LEGP_NOPE"], FROM)).rejects.toThrow(/LEGP_NOPE: HTTP 400/);
    });
  });

  // The no-browser-REST-on-data-tables scan lives in scripts/anon-read-coverage.test.ts.
  it("the shell reads legs through the auth-session.js apiFetch seam", () => {
    expect(SHELL).toMatch(/^import \{[^}]*\bapiFetch\b[^}]*\} from "\.\/auth-session\.js";$/m);
    const fn = SHELL.slice(SHELL.indexOf("async function loadDrawdown("));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toContain("fetchLegReadings(apiFetch, ids, first");
  });
});

describe("drawdownLegIds / firstEntryDate - the rung-derived id set (J1.4)", () => {
  const rows = [
    { entry_date: "2026-01-02", rung: 1, cash_pct: 0, sleeve: "junk <script>" },
    { entry_date: "2026-01-01", rung: 1, cash_pct: 0 },
    { entry_date: "2026-01-03", rung: 5, cash_pct: 0 },
    { entry_date: "2026-01-04", rung: 99, cash_pct: 0 },
  ];

  it("derives DISTINCT ids from the rung only, dropping an off-ladder rung", () => {
    expect(drawdownLegIds(rows, LADDER_IDS)).toEqual([legCloseId("Semis"), legCloseId(LADDER[4])]);
    // The stored sleeve text reaches no id — the security invariant, made red-able.
    expect(JSON.stringify(drawdownLegIds(rows, LADDER_IDS))).not.toContain("junk");
  });

  it("returns the earliest ISO entry_date as the window start", () => {
    expect(firstEntryDate(rows)).toBe("2026-01-01");
    expect(firstEntryDate([])).toBeNull();
  });
});

describe("drawdownModel / drawdownCardHtml - the panel (J1.5)", () => {
  const single = [{ entry_date: "2026-01-01", rung: 1, cash_pct: 0, created_at: "2026-01-01T09:00:00Z", sleeve: "x" }];
  const base = { rows: single, legIds: LADDER_IDS, names: [...LADDER], cuts: CUTS };

  it("empty state when no priceable entries", () => {
    expect(drawdownModel({ ...base, rows: [], readings: [], confirmCloses: 2 }).kind).toBe("empty");
    expect(drawdownCardHtml({ kind: "empty" })).toContain("record a holding to see its drawdown");
  });

  it("nodata state when the series read returned nothing yet", () => {
    expect(drawdownModel({ ...base, readings: [], confirmCloses: 2 }).kind).toBe("nodata");
  });

  it("shows the CONFIRMED band (ruling #1): a one-day cross is held back by confirmCloses", () => {
    // dd hits -0.20 (CORRECTION cut) on the LAST day only.
    const readings = legReadings(SEMIS, ["2026-01-01", "2026-01-02", "2026-01-03"], [100, 110, 88]);
    const held = drawdownModel({ ...base, readings, confirmCloses: 2 });
    expect(held.kind).toBe("ok");
    expect(held.ddPct).toBeCloseTo(-0.2, 10);
    expect(held.peakDate).toBe("2026-01-02");
    expect(held.since).toBe("2026-01-01");
    expect(held.clamped).toBe(false);
    // The confirm fold keeps the headline at CALM though the raw band is CORRECTION.
    expect(held.band).toBe("CALM");
    // The DISCRIMINATOR: identical inputs, confirmCloses=1 → the raw CORRECTION is adopted.
    expect(drawdownModel({ ...base, readings, confirmCloses: 1 }).band).toBe("CORRECTION");
    // Per-entry segment line: leg NAME (rung-derived), cash %, that segment's deepest dd.
    expect(held.segments).toHaveLength(1);
    expect(held.segments[0]).toMatchObject({ name: "Semis", cashPct: 0 });
    expect(held.segments[0].dd).toBeCloseTo(-0.2, 10);
    const html = drawdownCardHtml(held);
    expect(html).toContain("dd-head");
    expect(html).toContain("Semis");
    expect(html).toContain("-20.0%");
  });

  it("paints a BEAR band with its journal-LOCAL colour class (ruling #3)", () => {
    const readings = legReadings(SEMIS, ["2026-01-01", "2026-01-02", "2026-01-03"], [100, 60, 60]);
    const bear = drawdownModel({ ...base, readings, confirmCloses: 2 });
    expect(bear.band).toBe("BEAR");
    expect(bear.bandClass).toBe("dd-bear");
    expect(drawdownCardHtml(bear)).toContain("dd-bear");
    // The class must be STYLED in journal.css, not borrowed from styles.css's compound .pension-*.
    expect(CSS, ".dd-bear must be a standalone rule in journal.css").toMatch(/\.dd-bear(?![a-zA-Z0-9_-])/);
    expect(CSS).toMatch(/\.dd-dip(?![a-zA-Z0-9_-])/);
    expect(CSS).toMatch(/\.dd-correction(?![a-zA-Z0-9_-])/);
  });

  it("clamps an entry older than the series start and says so", () => {
    const readings = legReadings(SEMIS, ["2026-03-02", "2026-03-03"], [100, 90]);
    const model = drawdownModel({ ...base, readings, confirmCloses: 2 });
    expect(model.clamped).toBe(true);
    expect(model.seriesStart).toBe("2026-03-02");
    expect(model.since).toBe("2026-01-01");
    expect(drawdownCardHtml(model)).toContain("series starts 2026-03-02");
  });
});
