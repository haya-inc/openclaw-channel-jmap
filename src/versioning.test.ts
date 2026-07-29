import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type ReleaseGate = {
  schemaVersion: number;
  currentStable: string;
  next: {
    version: string;
    status: "development" | "prerelease" | "ready";
    theme: string;
    criteria: Array<{
      id: string;
      required: boolean;
      complete: boolean;
      description: string;
    }>;
  };
};

function readJson<T>(relativePath: string): T {
  return JSON.parse(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
  ) as T;
}

function parseVersion(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`invalid stable version: ${version}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

describe("versioning policy", () => {
  it("keeps development on the stable package version until the release gate advances", () => {
    const packageJson = readJson<{ version: string }>("../package.json");
    const gate = readJson<ReleaseGate>("../release-gates.json");
    const changelog = readFileSync(
      new URL("../CHANGELOG.md", import.meta.url),
      "utf8",
    );
    const ids = gate.next.criteria.map((criterion) => criterion.id);
    const [stableMajor, stableMinor] = parseVersion(gate.currentStable);
    const [nextMajor, nextMinor, nextPatch] = parseVersion(gate.next.version);

    expect(gate.schemaVersion).toBe(1);
    expect(gate.next.theme.trim()).not.toBe("");
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    expect(nextMajor).toBe(stableMajor);
    expect(nextMinor).toBe(stableMinor + 1);
    expect(nextPatch).toBe(0);
    expect(changelog).toContain("## Unreleased");

    if (gate.next.status === "development") {
      expect(packageJson.version).toBe(gate.currentStable);
      expect(changelog).not.toMatch(
        new RegExp(`^## ${gate.next.version.replaceAll(".", "\\.")}$`, "m"),
      );
    } else if (gate.next.status === "prerelease") {
      expect(packageJson.version).toMatch(
        new RegExp(
          `^${gate.next.version.replaceAll(".", "\\.")}-(alpha|beta|rc)\\.\\d+$`,
        ),
      );
    } else {
      expect(packageJson.version).toBe(gate.next.version);
      expect(
        gate.next.criteria
          .filter((criterion) => criterion.required)
          .every((criterion) => criterion.complete),
      ).toBe(true);
    }
  });
});
