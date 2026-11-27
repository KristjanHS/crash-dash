import { describe, expect, test } from "vitest";
import { DISPOSABLE_MARKER_TABLE, assertDisposableStack, supabaseMarkerProbe } from "./disposable-guard.js";

// DB-free by construction: the marker probe is a seam, so the barrier's decision is
// unit-testable without ever pointing at a live stack (which is the point — proving this
// guard must not require the very truncation it exists to prevent).

/** A fake supabase-js client whose marker read succeeds or errors like PostgREST's. */
const fakeClient = (opts: { hasMarker: boolean }) => {
  const reads: string[] = [];
  return {
    reads,
    from: (table: string) => ({
      select: () => ({
        limit: async () => {
          reads.push(table);
          return opts.hasMarker
            ? { error: null }
            : { error: { code: "PGRST205", message: `Could not find the table 'public.${table}'` } };
        },
      }),
    }),
  };
};

describe("assertDisposableStack - an unmarked DB must never reach a delete", () => {
  test("throws, naming the DB, when the marker is absent", async () => {
    // The dev-DB regime: local creds, DB_TESTS=1 forged in .env.local — but no marker.
    await expect(assertDisposableStack("http://127.0.0.1:54321", async () => false)).rejects.toThrow(
      /refusing to truncate http:\/\/127\.0\.0\.1:54321.*_disposable_stack/s,
    );
  });

  test("resolves silently when the marker is present (CI's ephemeral stack)", async () => {
    await expect(assertDisposableStack("http://127.0.0.1:54321", async () => true)).resolves.toBeUndefined();
  });
});

describe("supabaseMarkerProbe - reads the marker table through PostgREST", () => {
  test("a PostgREST 'table not found' error ⇒ not disposable (absent, not a throw)", async () => {
    const client = fakeClient({ hasMarker: false });
    expect(await supabaseMarkerProbe(client)()).toBe(false);
    expect(client.reads).toEqual([DISPOSABLE_MARKER_TABLE]); // it read the marker, not some other table
  });

  test("a clean zero-row projection ⇒ disposable", async () => {
    expect(await supabaseMarkerProbe(fakeClient({ hasMarker: true }))()).toBe(true);
  });

  test("a non-PGRST205 error (transport / 503) THROWS naming itself - never reads as 'unmarked'", async () => {
    const client = {
      from: () => ({
        select: () => ({
          limit: async () => ({ error: { code: "", message: "TypeError: fetch failed" } }),
        }),
      }),
    };
    await expect(supabaseMarkerProbe(client)()).rejects.toThrow(/fetch failed/);
    await expect(supabaseMarkerProbe(client)()).rejects.not.toThrow(/not a disposable CI stack/);
  });
});
