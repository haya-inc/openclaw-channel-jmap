import { describe, expect, it } from "vitest";
import { resolveThreadSession } from "./thread-session.js";

describe("resolveThreadSession", () => {
  it("appends thread suffix", () => {
    const result = resolveThreadSession({
      baseSessionKey: "agent:main:main",
      threadId: "Thread-123",
    });

    expect(result.sessionKey).toBe("agent:main:main:thread:thread-123");
    expect(result.parentSessionKey).toBe("agent:main:main");
  });
});
