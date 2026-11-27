/**
 * healthView drift-probe tests (6.2 max-rows cap) — the DEEP path,
 * so every hit carries the cron bearer (D3). It hits the store → we hand the view a pre-seeded
 * InMemoryStore through the injected seam (rung 8a). checkSchema is a no-op on the fake, so
 * healthView always reaches the probe branches.
 */
import { beforeEach, describe, expect, test } from "vitest";

import { InMemoryStore } from "../src/store-memory.js";
import { POSTGREST_MAX_ROWS } from "../src/store.js";
import { healthView } from "../src/api/meta-views.js";

const store = new InMemoryStore();
const SECRET = "test-cron-secret";

async function body(): Promise<Record<string, unknown>> {
  const deep = new Request("https://x/api/health", { headers: { authorization: `Bearer ${SECRET}` } });
  return (await (await healthView(() => store, deep, SECRET)).json()) as Record<string, unknown>;
}

beforeEach(() => {
  store.alerts.length = 0;
  store.readings.length = 0;
  store.maxRowsCap = undefined;
});

describe("healthView maxRows cap probe (6.2)", () => {
  test("readings count at/under the cap → not gated (maxRowsObserved null, no mismatch)", async () => {
    // empty readings → count 0 <= cap
    const b = await body();
    expect(b).toMatchObject({ ok: true, maxRows: POSTGREST_MAX_ROWS, maxRowsObserved: null });
    expect(b).not.toHaveProperty("maxRowsMismatch");
  });

  test("count over the cap, wire returns the full cap → observed = cap, no mismatch", async () => {
    store.readings.length = POSTGREST_MAX_ROWS + 1; // count exceeds the assumed cap → probe fires
    const b = await body();
    expect(b).toMatchObject({ maxRowsObserved: POSTGREST_MAX_ROWS });
    expect(b).not.toHaveProperty("maxRowsMismatch");
  });

  test("count over the cap but prod max_rows lowered → observed < cap ⇒ maxRowsMismatch", async () => {
    store.readings.length = POSTGREST_MAX_ROWS + 1;
    store.maxRowsCap = 1000; // simulate prod `[api] max_rows` set below the assumption
    expect(await body()).toMatchObject({ maxRowsObserved: 1000, maxRowsMismatch: true });
  });
});
