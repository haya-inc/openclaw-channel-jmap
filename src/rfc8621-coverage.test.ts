import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RFC8621_COVERAGE,
  RFC8621_PLUGIN_RELEASE,
} from "./rfc8621-coverage.js";

const RFC_8621_METHODS = [
  "Mailbox/get",
  "Mailbox/changes",
  "Mailbox/query",
  "Mailbox/queryChanges",
  "Mailbox/set",
  "Thread/get",
  "Thread/changes",
  "Email/get",
  "Email/changes",
  "Email/query",
  "Email/queryChanges",
  "Email/set",
  "Email/copy",
  "Email/import",
  "Email/parse",
  "SearchSnippet/get",
  "Identity/get",
  "Identity/changes",
  "Identity/set",
  "EmailSubmission/get",
  "EmailSubmission/changes",
  "EmailSubmission/query",
  "EmailSubmission/queryChanges",
  "EmailSubmission/set",
  "VacationResponse/get",
  "VacationResponse/set",
] as const;

type Coverage = {
  schemaVersion: number;
  standard: string;
  updatedForRelease: string;
  methods: Array<{
    method: string;
    status: string;
    exposure: string;
    risk: string;
    targetRelease: string;
  }>;
};

describe("RFC 8621 coverage ledger", () => {
  it("tracks every standard method exactly once with known classifications", () => {
    const coverage = JSON.parse(
      readFileSync(new URL("../rfc8621-coverage.json", import.meta.url), "utf8"),
    ) as Coverage;
    const names = coverage.methods.map((entry) => entry.method);

    expect(coverage).toMatchObject({
      schemaVersion: 1,
      standard: "RFC 8621",
      updatedForRelease: "0.4.1",
    });
    expect(coverage.updatedForRelease).toBe(RFC8621_PLUGIN_RELEASE);
    expect(coverage.methods).toEqual(RFC8621_COVERAGE);
    expect(names).toHaveLength(26);
    expect(new Set(names).size).toBe(26);
    expect([...names].sort()).toEqual([...RFC_8621_METHODS].sort());
    for (const entry of coverage.methods) {
      expect(["implemented", "partial", "planned"]).toContain(entry.status);
      expect(["tool", "internal", "none"]).toContain(entry.exposure);
      expect(["read", "reversible", "outbound", "destructive"]).toContain(entry.risk);
      expect(entry.targetRelease).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
