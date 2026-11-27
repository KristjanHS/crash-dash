/** A caught value's message — `Error.message` + ` [<cause.code>]` when the cause carries one (undici's
 *  `fetch failed` hides ECONNREFUSED/UND_ERR_* there), else its string form. */
export const errMsg = (err: unknown): string => {
  if (!(err instanceof Error)) return String(err);
  const code: unknown = (err.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && !err.message.includes(code) ? `${err.message} [${code}]` : err.message;
};
