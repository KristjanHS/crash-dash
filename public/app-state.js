/*
 * app-state.js — the single mutable-state container behind public/app.js (D12).
 *
 * Pure and DOM-free (vitest-importable, like format.js / ladder-chart.js):
 * a mutation funnel plus stale-continuation guard helpers. NO scheduling, NO
 * subscribers — render calls stay explicit at app.js's existing call sites
 * (rAF-batched scheduleRender is a recorded deferred follow-up, by design).
 */

/**
 * Create the state container.
 *
 * @param {object} initial — the initial state shape; top-level keys are either
 *   plain values (e.g. `lastView`, `seriesCache`) or object slices
 *   (e.g. `zoneD`) that `setState("slice", patch)` merges into.
 * @returns {{ state: object, setState: Function }}
 *
 * `setState` has two coherent forms (the slice form is the primary one — it
 * keeps per-slice guard snapshots cheap for the Stage-3 guards):
 *   - `setState("slice", patch)` — shallow-merge `patch` into the existing
 *     object slice `state[slice]`. Throws if `state[slice]` is not a plain
 *     mergeable object (misuse guard: a typo'd slice name must not silently
 *     create state).
 *   - `setState(patch)` — shallow-merge `patch` into the top level of `state`
 *     (used for top-level values like `familyOrder`, `ladderConfig`,
 *     `lastView`, where replacing the whole value is the intent).
 * Both forms assign values as-is (no cloning): object identity of assigned
 * values is preserved, which the `lastView` identity guard relies on.
 */
export function createState(initial) {
  const state = { ...initial };

  function setState(sliceOrPatch, patch) {
    if (typeof sliceOrPatch === "string") {
      const slice = state[sliceOrPatch];
      if (slice === null || typeof slice !== "object") {
        throw new TypeError(`setState: "${sliceOrPatch}" is not an object slice`);
      }
      Object.assign(slice, patch);
    } else {
      Object.assign(state, sliceOrPatch);
    }
    return state;
  }

  return { state, setState };
}

/**
 * Capture a stale-continuation guard token: a snapshot of the named state
 * fields, taken BEFORE an await, to be re-checked with `isCurrent` at the
 * exact post-await point the hand-rolled guard sat at.
 *
 * @param {object} state — the container's `state`.
 * @param {string[]} keys — field paths, each either a top-level key
 *   (`"lastView"`) or one slice level deep (`"zoneD.tab"`,
 *   `"zoneD.ladderLimit"`). One dot max — the state is intentionally shallow.
 * @returns {ReadonlyArray<{path: string, value: *}>} the token.
 */
export function guardToken(state, keys) {
  return Object.freeze(keys.map((path) => ({ path, value: readPath(state, path) })));
}

/**
 * `true` iff EVERY field captured in `token` still strict-equals (`===`) its
 * live value in `state`. Strict equality means object identity for object
 * values (the `lastView !== view` guard) — never deep-equal. Note this
 * intentionally preserves today's field-equality semantics: mutate away and
 * back (e.g. tab away and back to the same tab) and the token is current
 * again — the late continuation revalidates, exactly like the hand-rolled
 * guards it replaces.
 *
 * @param {object} state — the container's `state`.
 * @param {ReadonlyArray<{path: string, value: *}>} token — from `guardToken`.
 * @returns {boolean}
 */
export function isCurrent(state, token) {
  return token.every(({ path, value }) => readPath(state, path) === value);
}

/** Read a one-dot-max path off state ("k" or "slice.k"). */
function readPath(state, path) {
  const dot = path.indexOf(".");
  if (dot === -1) return state[path];
  return state[path.slice(0, dot)]?.[path.slice(dot + 1)];
}
