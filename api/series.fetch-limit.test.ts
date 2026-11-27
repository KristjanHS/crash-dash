/**
 * P4 hardening guard (api/series.ts `fetchLimit`): a `to=<past>` query on a latest-N BESPOKE
 * branch (DB_SMH downside) must still reach deep — the branch cannot push the range into the
 * store, so bounding its read at a small `limit` there would drop the window. The `to`-less
 * case is bound at `limit`; this pins that the `to=` case is NOT (else the probe returns empty).
 */
import { beforeEach, describe, expect, test } from "vitest";
import { InMemoryStore } from "../src/store-memory.js";
import { makeStoredReading } from "../src/test-helpers.js";

import { handle } from "./series.js";

const store = new InMemoryStore();
const GET = (req: Request): Promise<Response> => handle(() => store, req, { now: new Date() });

const SEED_N = 1500; // ~2010-01-01 .. ~2014-02; deep enough that a past `to` is far behind the newest row
beforeEach(() => {
  store.readings.length = 0;
});

describe("GET /api/series - P4 fetchLimit keeps a to=<past> bespoke probe reaching deep", () => {
  test("DB_SMH with to=2010-06-01&limit=1 returns the deep row (a limit-bound read would drop it)", async () => {
    await store.recordReadings(
      Array.from({ length: SEED_N }, (_, i) =>
        makeStoredReading("DB_SMH", {
          date: new Date(Date.UTC(2010, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
          value: 100 + i * 0.1, // gently rising closes; the downside branch re-derives drawdown off these
        }),
      ),
      "2026-09-07T00:00:00Z",
    );
    const res = await GET(new Request("https://x/api/series?id=DB_SMH&to=2010-06-01&limit=1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { points: { date: string }[] };
    expect(body.points.length).toBe(1); // the deep read reached the past window
    expect(body.points[0]!.date <= "2010-06-01").toBe(true);
  });
});
