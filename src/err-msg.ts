/** A caught value's message — `Error.message`, else its string form. Shared so the catch
 *  sites don't each carry an inline ternary whose non-Error arm never runs under test. */
export const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
