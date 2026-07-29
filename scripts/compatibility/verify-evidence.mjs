#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const LEVELS = { fixture: 0, lab: 1, live: 2 };

function readOptions(argv) {
  const options = {
    allowIncomplete: false,
    json: false,
    sourceRevision: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--allow-incomplete") {
      options.allowIncomplete = true;
    } else if (flag === "--json") {
      options.json = true;
    } else if (flag === "--source-revision") {
      options.sourceRevision = argv[index + 1]?.trim() || null;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  if (options.sourceRevision && options.sourceRevision.length < 7) {
    throw new Error("--source-revision must contain at least 7 characters");
  }
  return options;
}

async function collectJsonFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectJsonFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(path);
    }
  }
  return files.toSorted();
}

function scopeSatisfies(actual, required) {
  if (required === "full") {
    return actual === "full";
  }
  return actual === required || actual === "full";
}

function sourceMatches(actual, required) {
  return !required || actual.startsWith(required) || required.startsWith(actual);
}

function rankEvidence(left, right) {
  const levelDifference =
    LEVELS[right.verificationLevel] - LEVELS[left.verificationLevel];
  if (levelDifference !== 0) {
    return levelDifference;
  }
  return Date.parse(right.generatedAt) - Date.parse(left.generatedAt);
}

function reportMethodSummary(report) {
  const summary = { verified: 0, advertised: 0, unsupported: 0, unverified: 0 };
  for (const method of report.rfc8621?.methods ?? []) {
    summary[method.serverStatus] += 1;
  }
  return summary;
}

function hasCompleteRfc8621Matrix(report) {
  const methods = report.rfc8621?.methods;
  return (
    report.rfc8621?.totalMethods === 26 &&
    Array.isArray(methods) &&
    methods.length === 26 &&
    new Set(methods.map((entry) => entry.method)).size === 26
  );
}

export async function verifyEvidence(options) {
  const root = resolve(new URL("../..", import.meta.url).pathname);
  const policy = JSON.parse(
    await readFile(resolve(root, "compatibility-requirements.json"), "utf8"),
  );
  const reportSchema = JSON.parse(
    await readFile(resolve(root, "compatibility-report.schema.json"), "utf8"),
  );
  const evidenceSchema = JSON.parse(
    await readFile(resolve(root, "compatibility-evidence.schema.json"), "utf8"),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(reportSchema);
  const validateEvidence = ajv.compile(evidenceSchema);

  const evidence = [];
  const invalid = [];
  for (const path of await collectJsonFiles(resolve(root, "compatibility-evidence"))) {
    const document = JSON.parse(await readFile(path, "utf8"));
    if (!validateEvidence(document)) {
      invalid.push({
        path: path.slice(root.length + 1),
        errors: validateEvidence.errors,
      });
      continue;
    }
    evidence.push({
      ...document,
      path: path.slice(root.length + 1),
    });
  }

  const requirements = policy.requirements.map((requirement) => {
    const matches = evidence
      .filter((item) =>
        item.target.serverProfile === requirement.serverProfile &&
        LEVELS[item.verificationLevel] >= LEVELS[requirement.minimumVerificationLevel] &&
        scopeSatisfies(item.report.scope, requirement.scope) &&
        item.report.verdict === "compatible" &&
        (!policy.requireCompleteRfc8621Matrix ||
          hasCompleteRfc8621Matrix(item.report)) &&
        sourceMatches(item.probe.sourceRevision, options.sourceRevision),
      )
      .sort(rankEvidence);
    const selected = matches[0] ?? null;
    return {
      ...requirement,
      status: selected ? "pass" : "missing",
      evidence: selected
        ? {
            path: selected.path,
            verificationLevel: selected.verificationLevel,
            serverVersion: selected.target.serverVersion,
            artifact: selected.target.artifact,
            generatedAt: selected.generatedAt,
            sourceRevision: selected.probe.sourceRevision,
            methodSummary: reportMethodSummary(selected.report),
          }
        : null,
    };
  });

  const complete =
    invalid.length === 0 &&
    requirements.every((requirement) => requirement.status === "pass");
  return {
    schemaVersion: 1,
    claim: policy.claim,
    complete,
    sourceRevision: options.sourceRevision,
    requirements,
    invalidEvidence: invalid,
    limitations: [
      "This claim covers the non-mutating compatibility probe only.",
      "Advertised methods are not treated as state-changing or outbound verification.",
      "A separate disposable contract suite is required for draft mutation, submission, cancellation, import, and copy.",
    ],
  };
}

function printHuman(result) {
  process.stdout.write(
    `${result.complete ? "PASS" : "INCOMPLETE"} ${result.claim}\n`,
  );
  for (const requirement of result.requirements) {
    const detail = requirement.evidence
      ? `${requirement.evidence.verificationLevel} ${requirement.evidence.serverVersion}`
      : `requires ${requirement.minimumVerificationLevel} ${requirement.scope}`;
    process.stdout.write(
      `${requirement.status === "pass" ? "PASS" : "MISS"} ${requirement.serverProfile}: ${detail}\n`,
    );
  }
  for (const invalid of result.invalidEvidence) {
    process.stdout.write(`INVALID ${invalid.path}\n`);
  }
}

async function main() {
  try {
    const options = readOptions(process.argv.slice(2));
    const result = await verifyEvidence(options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      printHuman(result);
    }
    if (result.invalidEvidence.length > 0) {
      process.exitCode = 2;
    } else if (!result.complete && !options.allowIncomplete) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(
      `verify-evidence: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 64;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  await main();
}
