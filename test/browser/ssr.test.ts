// @vitest-environment node
//
// On the server (Next.js renders the same module there) every call is a no-op
// that never throws.

import { describe, expect, it } from "vitest";

import { captureError, close, flush, getSessionId, init, setUser } from "../../src/browser/index";

describe("without a window", () => {
  it("does nothing and never throws", async () => {
    expect(typeof window).toBe("undefined");
    expect(() => init({ key: "pk_1" })).not.toThrow();
    expect(() => setUser({ id: "1", email: "a@b.c" })).not.toThrow();
    expect(() => captureError(new Error("x"))).not.toThrow();
    await expect(flush()).resolves.toBeUndefined();
    expect(() => close()).not.toThrow();
    expect(getSessionId()).toBeNull();
  });
});
