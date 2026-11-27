import { describe, expect, test } from "vitest";
import { errMsg } from "./err-msg.js";

const withCode = (msg: string, code: unknown) => new TypeError(msg, { cause: Object.assign(new Error("inner"), { code }) });

describe("errMsg", () => {
  test("appends a string cause code: undici's fetch failed names ECONNREFUSED / UND_ERR_CONNECT_TIMEOUT", () => {
    expect(errMsg(withCode("fetch failed", "ECONNREFUSED"))).toBe("fetch failed [ECONNREFUSED]");
    expect(errMsg(withCode("fetch failed", "UND_ERR_CONNECT_TIMEOUT"))).toBe("fetch failed [UND_ERR_CONNECT_TIMEOUT]");
  });

  test("a cause-less, code-less or non-string-code error is its bare message; a non-Error its string form", () => {
    expect(errMsg(new TypeError("fetch failed"))).toBe("fetch failed");
    expect(errMsg(new Error("boom", { cause: new Error("x") }))).toBe("boom");
    expect(errMsg(withCode("boom", 503))).toBe("boom");
    expect(errMsg("plain")).toBe("plain");
  });

  test("a message already naming the code is not suffixed twice", () => {
    expect(errMsg(withCode("connect ECONNREFUSED 1.2.3.4:443", "ECONNREFUSED"))).toBe("connect ECONNREFUSED 1.2.3.4:443");
  });
});
