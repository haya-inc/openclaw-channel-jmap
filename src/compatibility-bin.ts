#!/usr/bin/env node

import {
  compatibilityExitCode,
  formatJmapCompatibilityReport,
  isJmapCompatibilityScope,
  isJmapServerProfile,
  runJmapCompatibilityCheck,
  type JmapCompatibilityScope,
  type JmapServerProfile,
} from "./compatibility.js";
import type { CoreConfig, JmapAuthMode } from "./types.js";

type Options = {
  server: JmapServerProfile;
  scope: JmapCompatibilityScope;
  json: boolean;
};

function usage(): string {
  return [
    "Usage: openclaw-jmap-compat [--server <profile>] [--scope <scope>] [--json]",
    "",
    "Credentials and the endpoint are read only from the environment:",
    "  JMAP_SESSION_URL",
    "  JMAP_AUTH_MODE=basic|bearer",
    "  JMAP_USERNAME + JMAP_PASSWORD (Basic)",
    "  JMAP_API_TOKEN (Bearer)",
    "",
    "Profiles: stalwart, fastmail, cyrus, apache-james, generic",
    "Scopes: read, manage, send, full",
    "",
    "The probe never sends mail, changes mailbox state, or reads message bodies.",
  ].join("\n");
}

function readOptions(argv: string[]): Options {
  let server: JmapServerProfile = "generic";
  let scope: JmapCompatibilityScope = "read";
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--server") {
      const value = argv[index + 1] ?? "";
      if (!isJmapServerProfile(value)) {
        throw new Error(`Unknown JMAP server profile: ${value || "(missing)"}`);
      }
      server = value;
      index += 1;
      continue;
    }
    if (arg === "--scope") {
      const value = argv[index + 1] ?? "";
      if (!isJmapCompatibilityScope(value)) {
        throw new Error(`Unknown JMAP compatibility scope: ${value || "(missing)"}`);
      }
      scope = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { server, scope, json };
}

function configFromEnvironment(): CoreConfig {
  const sessionUrl = process.env.JMAP_SESSION_URL?.trim();
  if (!sessionUrl) {
    throw new Error("JMAP_SESSION_URL is required");
  }
  const configuredMode = process.env.JMAP_AUTH_MODE?.trim().toLowerCase();
  if (configuredMode && configuredMode !== "basic" && configuredMode !== "bearer") {
    throw new Error("JMAP_AUTH_MODE must be basic or bearer");
  }
  const authMode: JmapAuthMode =
    configuredMode === "basic" ||
    (!configuredMode && Boolean(process.env.JMAP_USERNAME?.trim()))
      ? "basic"
      : "bearer";

  return {
    channels: {
      jmap: {
        enabled: true,
        sessionUrl,
        authMode,
        username: process.env.JMAP_USERNAME?.trim(),
        password: authMode === "basic" ? process.env.JMAP_PASSWORD?.trim() : undefined,
        apiToken:
          authMode === "bearer"
            ? process.env.JMAP_API_TOKEN?.trim() || process.env.JMAIL_API_TOKEN?.trim()
            : undefined,
      },
    },
  };
}

async function main() {
  try {
    const options = readOptions(process.argv.slice(2));
    const report = await runJmapCompatibilityCheck({
      config: configFromEnvironment(),
      serverProfile: options.server,
      scope: options.scope,
    });
    process.stdout.write(
      options.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : `${formatJmapCompatibilityReport(report)}\n`,
    );
    process.exitCode = compatibilityExitCode(report.verdict);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`openclaw-jmap-compat: ${message}\n`);
    process.exitCode = 64;
  }
}

await main();
