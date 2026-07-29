#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LEVELS = new Set(["fixture", "lab", "live"]);
const CONTRACTS = new Set([
  "draft-lifecycle-v1",
  "self-addressed-submission-v1",
]);

function readOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1]?.trim();
    if (!flag?.startsWith("--") || !value) {
      throw new Error("Contract evidence arguments must be --name value pairs");
    }
    options[flag.slice(2)] = value;
  }
  for (const name of [
    "report",
    "output",
    "level",
    "server-version",
    "artifact",
    "source-revision",
  ]) {
    if (!options[name]) {
      throw new Error(`--${name} is required`);
    }
  }
  if (!LEVELS.has(options.level)) {
    throw new Error("--level must be fixture, lab, or live");
  }
  if (options["source-revision"].length < 7) {
    throw new Error("--source-revision must contain at least 7 characters");
  }
  return options;
}

function assertContractReport(report) {
  if (
    !report ||
    typeof report !== "object" ||
    Array.isArray(report) ||
    !CONTRACTS.has(report.contract) ||
    report.verdict !== "compatible"
  ) {
    throw new Error("A compatible known contract report is required");
  }
  const policy = report.probePolicy;
  if (report.contract === "draft-lifecycle-v1") {
    if (
      policy?.sideEffectsPerformed !== true ||
      policy.recipientsUsed !== false ||
      policy.submissionAttempted !== false ||
      policy.externalDeliveryAttempted !== false ||
      policy.cleanupConfirmed !== true
    ) {
      throw new Error("Draft report violates the recipient-free safety policy");
    }
    return;
  }
  if (
    policy?.sideEffectsPerformed !== true ||
    policy.selfAddressedOnly !== true ||
    policy.externalRecipientsUsed !== false ||
    policy.submissionAttempted !== true ||
    policy.finalDeliveryClaimed !== false ||
    policy.cleanupConfirmed !== true ||
    report.observations?.acceptanceObserved !== true
  ) {
    throw new Error("Outbound report violates the self-addressed safety policy");
  }
}

function canonicalReport(report) {
  return JSON.stringify(report);
}

export async function createContractEvidence(options) {
  const report = JSON.parse(await readFile(options.report, "utf8"));
  assertContractReport(report);
  const packagePath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../package.json",
  );
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    verificationLevel: options.level,
    target: {
      serverProfile: report.serverProfile,
      serverVersion: options["server-version"],
      artifact: options.artifact,
    },
    probe: {
      packageVersion: packageJson.version,
      sourceRevision: options["source-revision"],
      reportSha256: createHash("sha256")
        .update(canonicalReport(report))
        .digest("hex"),
    },
    report,
  };
  await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o644,
  });
  return evidence;
}

async function main() {
  try {
    await createContractEvidence(readOptions(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(
      `create-contract-evidence: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 64;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
