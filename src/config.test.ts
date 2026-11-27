import { describe, expect, test } from "vitest";
import { dashboardUrl } from "./config.js";

describe("dashboardUrl — PROD_ALIAS → VERCEL_PROJECT_PRODUCTION_URL → undefined, never throws", () => {
  test("PROD_ALIAS wins over the Vercel production url", () => {
    expect(dashboardUrl({ PROD_ALIAS: "https://alias.example", VERCEL_PROJECT_PRODUCTION_URL: "vercel.example" })).toBe("https://alias.example");
  });

  test("a bare-host PROD_ALIAS normalizes to https://<host>, trimmed, no trailing slash", () => {
    expect(dashboardUrl({ PROD_ALIAS: "alias.example" })).toBe("https://alias.example");
    expect(dashboardUrl({ PROD_ALIAS: "  https://alias.example//  " })).toBe("https://alias.example");
  });

  test("blank/unset PROD_ALIAS ⇒ the Vercel production url (a bare domain), normalized", () => {
    expect(dashboardUrl({ VERCEL_PROJECT_PRODUCTION_URL: "vercel.example" })).toBe("https://vercel.example");
    expect(dashboardUrl({ PROD_ALIAS: "  ", VERCEL_PROJECT_PRODUCTION_URL: "vercel.example" })).toBe("https://vercel.example");
  });

  test("neither set ⇒ undefined", () => {
    expect(dashboardUrl({})).toBeUndefined();
    expect(dashboardUrl({ PROD_ALIAS: "", VERCEL_PROJECT_PRODUCTION_URL: " " })).toBeUndefined();
  });

  test("a malformed value ⇒ undefined, no throw — and a malformed PROD_ALIAS does not fall back", () => {
    for (const bad of ["http://alias.example", "ftp://alias.example", "alias.example/path", "alias example", "https://"]) {
      expect(dashboardUrl({ PROD_ALIAS: bad }), bad).toBeUndefined();
      expect(dashboardUrl({ VERCEL_PROJECT_PRODUCTION_URL: bad }), bad).toBeUndefined();
    }
    expect(dashboardUrl({ PROD_ALIAS: "http://alias.example", VERCEL_PROJECT_PRODUCTION_URL: "vercel.example" })).toBeUndefined();
  });
});
