import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterEach, describe, expect, it } from "vitest";
import { OUTBOUND_CONTRACT_CHECK_IDS } from "./outbound-contract.js";

const temporaryDirectories: string[] = [];

function validOutboundReport() {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-30T00:00:00.000Z",
    serverProfile: "generic",
    contract: "self-addressed-submission-v1",
    verdict: "compatible",
    checks: OUTBOUND_CONTRACT_CHECK_IDS.map((id) => ({ id, status: "pass" })),
    observations: {
      acceptanceObserved: true,
      submissionStatusObserved: true,
      deliveryStatusObserved: true,
      submissionGet: "observed",
      submissionQuery: "observed",
      immediateUndoStatus: "final",
      scheduling: "canceled",
    },
    probePolicy: {
      sideEffectsPerformed: true,
      selfAddressedOnly: true,
      externalRecipientsUsed: false,
      submissionAttempted: true,
      finalDeliveryClaimed: false,
      cleanupConfirmed: true,
    },
  };
}

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openclaw-jmap-composition-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("composition contract evidence", () => {
  it("packages a redacted self-addressed report with canonical provenance", () => {
    const directory = tempDirectory();
    const reportPath = join(directory, "report.json");
    const outputPath = join(directory, "evidence.json");
    const report = validOutboundReport();
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

    execFileSync(process.execPath, [
      new URL(
        "../scripts/compatibility/create-contract-evidence.mjs",
        import.meta.url,
      ).pathname,
      "--report",
      reportPath,
      "--output",
      outputPath,
      "--level",
      "fixture",
      "--server-version",
      "fixture-v1",
      "--artifact",
      "generic-fixture",
      "--source-revision",
      "0123456789abcdef",
    ]);

    const evidence = JSON.parse(readFileSync(outputPath, "utf8"));
    const draftSchema = JSON.parse(
      readFileSync(
        new URL("../stateful-contract-report.schema.json", import.meta.url),
        "utf8",
      ),
    );
    const outboundSchema = JSON.parse(
      readFileSync(
        new URL("../outbound-contract-report.schema.json", import.meta.url),
        "utf8",
      ),
    );
    const evidenceSchema = JSON.parse(
      readFileSync(
        new URL("../composition-evidence.schema.json", import.meta.url),
        "utf8",
      ),
    );
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    ajv.addSchema(draftSchema);
    ajv.addSchema(outboundSchema);
    const validate = ajv.compile(evidenceSchema);

    expect(validate(evidence), JSON.stringify(validate.errors)).toBe(true);
    expect(evidence.probe.reportSha256).toBe(
      createHash("sha256").update(JSON.stringify(report)).digest("hex"),
    );
  });

  it("refuses outbound evidence that is not provably self-addressed", () => {
    const directory = tempDirectory();
    const reportPath = join(directory, "report.json");
    const outputPath = join(directory, "evidence.json");
    const report = validOutboundReport();
    report.probePolicy.externalRecipientsUsed = true;
    writeFileSync(reportPath, JSON.stringify(report));

    expect(() =>
      execFileSync(
        process.execPath,
        [
          new URL(
            "../scripts/compatibility/create-contract-evidence.mjs",
            import.meta.url,
          ).pathname,
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
