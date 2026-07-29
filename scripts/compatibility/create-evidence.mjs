#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LEVELS = new Set(["fixture", "lab", "live"]);

function usage() {
  return [
    "Usage: create-evidence.mjs \\",
    "  --report <report.json> --output <evidence.json> \\",
    "  --level <fixture|lab|live> --server-version <version> \\",
    "  --artifact <server artifact> --source-revision <git revision>",
  ].join("\n");
}

function readOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1]?.trim();
    if (!flag?.startsWith("--") || !value) {
      throw new Error(`Invalid arguments.\n${usage()}`);
    }
    options[flag.slice(2)] = value;
  }

  const required = [
    "report",
    "output",
    "level",
    "server-version",
    "artifact",
    "source-revision",
  ];
  for (const name of required) {
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

function assertSafeReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("Compatibility report must be a JSON object");
  }
  if (
    typeof report.serverProfile !== "string" ||
    typeof report.scope !== "string" ||
    typeof report.verdict !== "string"
  ) {
    throw new Error("Compatibility report is missing classification fields");
  }
  const policy = report.probePolicy;
  if (
    !policy ||
    policy.sideEffectsPerformed !== false ||
    policy.messageBodiesRead !== false ||
    policy.messageIdentifiersExposed !== false ||
    policy.outboundDeliveryVerified !== false
  ) {
    throw new Error("Refusing to package a report outside the safe probe policy");
  }
}

export async function createEvidence(options) {
  const reportBytes = await readFile(options.report);
  const report = JSON.parse(reportBytes.toString("utf8"));
  assertSafeReport(report);

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
      reportSha256: createHash("sha256").update(reportBytes).digest("hex"),
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
    await createEvidence(readOptions(process.argv.slice(2)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`create-evidence: ${message}\n`);
    process.exitCode = 64;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
