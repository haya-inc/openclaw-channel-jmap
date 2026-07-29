#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const LEVELS = { fixture: 0, lab: 1, live: 2 };

function readOptions(argv) {
  const options = { allowIncomplete: false, json: false, sourceRevision: null };
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
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error) => {
      if (error?.code === "ENOENT") {
        return [];
      }
      throw error;
    },
  );
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJsonFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(path);
    }
  }
  return files.toSorted();
}

function sourceMatches(actual, required) {
  return !required || actual.startsWith(required) || required.startsWith(actual);
}

function reportHash(report) {
  return createHash("sha256").update(JSON.stringify(report)).digest("hex");
}

function rankEvidence(left, right) {
  return (
    LEVELS[right.verificationLevel] - LEVELS[left.verificationLevel] ||
    Date.parse(right.generatedAt) - Date.parse(left.generatedAt)
  );
}

export async function verifyContractEvidence(options) {
  const root = resolve(new URL("../..", import.meta.url).pathname);
  const policy = JSON.parse(
    await readFile(resolve(root, "composition-requirements.json"), "utf8"),
  );
  const draftSchema = JSON.parse(
    await readFile(resolve(root, "stateful-contract-report.schema.json"), "utf8"),
  );
  const outboundSchema = JSON.parse(
    await readFile(resolve(root, "outbound-contract-report.schema.json"), "utf8"),
  );
  const evidenceSchema = JSON.parse(
    await readFile(resolve(root, "composition-evidence.schema.json"), "utf8"),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(draftSchema);
  ajv.addSchema(outboundSchema);
  const validateEvidence = ajv.compile(evidenceSchema);

  const evidence = [];
  const invalidEvidence = [];
  for (const path of await collectJsonFiles(resolve(root, "composition-evidence"))) {
    const document = JSON.parse(await readFile(path, "utf8"));
    const validSchema = validateEvidence(document);
    const validHash =
      validSchema && reportHash(document.report) === document.probe.reportSha256;
    if (!validSchema || !validHash) {
      invalidEvidence.push({
        path: path.slice(root.length + 1),
        errors: validSchema
          ? [{ keyword: "reportSha256", message: "does not match report" }]
          : validateEvidence.errors,
      });
      continue;
    }
    evidence.push({ ...document, path: path.slice(root.length + 1) });
  }

  const requirements = policy.requirements.map((requirement) => {
    const selected =
      evidence
        .filter(
          (item) =>
            item.report.contract === requirement.contract &&
            item.target.serverProfile === requirement.serverProfile &&
            item.report.verdict === "compatible" &&
            LEVELS[item.verificationLevel] >=
              LEVELS[requirement.minimumVerificationLevel] &&
            sourceMatches(item.probe.sourceRevision, options.sourceRevision),
        )
        .sort(rankEvidence)[0] ?? null;
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
          }
        : null,
    };
  });
  return {
    schemaVersion: 1,
    claim: policy.claim,
    complete:
      invalidEvidence.length === 0 &&
      requirements.every((requirement) => requirement.status === "pass"),
    sourceRevision: options.sourceRevision,
    requirements,
    invalidEvidence,
    limitations: [
      "Outbound evidence proves self-addressed submission acceptance, not final delivery.",
      "Unavailable status, history, delayed-send, or cancellation features must be reported explicitly and fail closed.",
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
      : `requires ${requirement.minimumVerificationLevel}`;
    process.stdout.write(
      `${requirement.status === "pass" ? "PASS" : "MISS"} ${
        requirement.contract
      } ${requirement.serverProfile}: ${detail}\n`,
    );
  }
  for (const invalid of result.invalidEvidence) {
    process.stdout.write(`INVALID ${invalid.path}\n`);
  }
}

async function main() {
  try {
    const options = readOptions(process.argv.slice(2));
    const result = await verifyContractEvidence(options);
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
      `verify-contract-evidence: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 64;
  }
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href
) {
  await main();
}
