import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

function validReport() {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-29T00:00:00.000Z",
    serverProfile: "generic",
    serverLabel: "Other standards-based JMAP server",
    scope: "full",
    accountId: "default",
    authMode: "basic",
    verdict: "compatible",
    advertisedCapabilities: ["urn:ietf:params:jmap:core"],
    checks: [
      {
        id: "configuration",
        status: "pass",
        required: true,
        evidence: "advertised",
        code: "configured",
      },
    ],
    features: {
      receivePolling: "verified",
      search: "verified",
      read: "verified",
      thread: "verified",
      update: "advertised",
      send: "advertised",
      push: "advertised",
      attachmentDownload: "advertised",
      attachmentUpload: "advertised",
    },
    probePolicy: {
      sideEffectsPerformed: false,
      messageBodiesRead: false,
      messageIdentifiersExposed: false,
      outboundDeliveryVerified: false,
    },
    limitations: [],
  };
}

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openclaw-jmap-evidence-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("compatibility evidence", () => {
  it("packages a safe report with target and source provenance", () => {
    const directory = tempDirectory();
    const reportPath = join(directory, "report.json");
    const outputPath = join(directory, "evidence.json");
    const reportBytes = `${JSON.stringify(validReport(), null, 2)}\n`;
    writeFileSync(reportPath, reportBytes);

    execFileSync(process.execPath, [
      new URL("../scripts/compatibility/create-evidence.mjs", import.meta.url).pathname,
      "--report",
      reportPath,
      "--output",
      outputPath,
      "--level",
      "lab",
      "--server-version",
      "1.2.3",
      "--artifact",
      "example/jmap:1.2.3",
      "--source-revision",
      "0123456789abcdef",
    ]);

    const evidence = JSON.parse(readFileSync(outputPath, "utf8"));
    const reportSchema = JSON.parse(
      readFileSync(new URL("../compatibility-report.schema.json", import.meta.url), "utf8"),
    );
    const evidenceSchema = JSON.parse(
      readFileSync(new URL("../compatibility-evidence.schema.json", import.meta.url), "utf8"),
    );
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    ajv.addSchema(reportSchema);
    const validate = ajv.compile(evidenceSchema);

    expect(validate(evidence), JSON.stringify(validate.errors)).toBe(true);
    expect(evidence).toMatchObject({
      verificationLevel: "lab",
      target: {
        serverProfile: "generic",
        serverVersion: "1.2.3",
        artifact: "example/jmap:1.2.3",
      },
      probe: {
        sourceRevision: "0123456789abcdef",
        reportSha256: createHash("sha256").update(reportBytes).digest("hex"),
      },
      report: {
        verdict: "compatible",
      },
    });
  });

  it("refuses reports that claim side effects", () => {
    const directory = tempDirectory();
    const reportPath = join(directory, "unsafe-report.json");
    const outputPath = join(directory, "evidence.json");
    const report = validReport();
    report.probePolicy.sideEffectsPerformed = true;
    writeFileSync(reportPath, JSON.stringify(report));

    expect(() =>
      execFileSync(
        process.execPath,
        [
          new URL("../scripts/compatibility/create-evidence.mjs", import.meta.url).pathname,
          "--report",
          reportPath,
          "--output",
          outputPath,
          "--level",
          "live",
          "--server-version",
          "unknown",
          "--artifact",
          "live-service",
          "--source-revision",
          "0123456",
        ],
        { stdio: "pipe" },
      ),
    ).toThrow();
  });
});
