import { describe, expect, it } from "vitest";
import {
  isJmapThreadTarget,
  looksLikeEmailAddress,
  normalizeJmapTarget,
  parseJmapThreadTarget,
} from "./normalize.js";

describe("normalizeJmapTarget", () => {
  it("normalizes thread targets", () => {
    expect(normalizeJmapTarget("thread:AbC-123")).toBe("thread:abc-123");
    expect(normalizeJmapTarget("jmap:thread:AbC-123")).toBe("thread:abc-123");
  });

  it("normalizes email targets", () => {
    expect(normalizeJmapTarget("Alice@Example.COM")).toBe("alice@example.com");
    expect(normalizeJmapTarget("jmap:email:Bob@Example.COM")).toBe("bob@example.com");
  });

  it("treats bare ids as thread targets", () => {
    expect(normalizeJmapTarget("abc-thread-id")).toBe("thread:abc-thread-id");
  });
});

describe("thread target helpers", () => {
  it("detects + parses thread targets", () => {
    expect(isJmapThreadTarget("thread:abc")).toBe(true);
    expect(parseJmapThreadTarget("thread:AbC")).toBe("abc");
    expect(parseJmapThreadTarget("alice@example.com")).toBeNull();
  });
});

describe("looksLikeEmailAddress", () => {
  it("matches reasonable emails", () => {
    expect(looksLikeEmailAddress("alice@example.com")).toBe(true);
    expect(looksLikeEmailAddress("bad@@example.com")).toBe(false);
    expect(looksLikeEmailAddress("thread:abc")).toBe(false);
  });
});
