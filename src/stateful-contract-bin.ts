#!/usr/bin/env node

import {
  isJmapServerProfile,
  type JmapServerProfile,
} from "./compatibility.js";
import { JmapClient } from "./jmap-client.js";
import { runStatefulDraftContract } from "./stateful-contract.js";

type Options = {
  server: JmapServerProfile;
  json: boolean;
};

function usage(): string {
  return [
    "Usage: openclaw-jmap-draft-contract [--server <profile>] [--json]",
    "",
    "This probe creates, previews, replaces, and destroys recipient-free drafts.",
    "It never invokes EmailSubmission/set or attempts external delivery.",
    "",
    "Required safety acknowledgement:",
    "  JMAP_STATEFUL_TEST_ALLOW_MUTATION=draft-only",
    "  JMAP_TEST_ACCOUNT_CLASS=disposable|dedicated-test",
    "",
    "Credentials use the same JMAP_* variables as openclaw-jmap-compat.",
  ].join("\n");
}

function readOptions(argv: string[]): Options {
  let server: JmapServerProfile = "generic";
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
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { server, json };
}

function clientFromEnvironment(): JmapClient {
  if (process.env.JMAP_STATEFUL_TEST_ALLOW_MUTATION !== "draft-only") {
    throw new Error(
      "Refusing mutation without JMAP_STATEFUL_TEST_ALLOW_MUTATION=draft-only",
    );
  }
  const accountClass = process.env.JMAP_TEST_ACCOUNT_CLASS?.trim();
  if (accountClass !== "disposable" && accountClass !== "dedicated-test") {
    throw new Error(
      "JMAP_TEST_ACCOUNT_CLASS must be disposable or dedicated-test",
    );
  }
  const sessionUrl = process.env.JMAP_SESSION_URL?.trim();
  if (!sessionUrl) {
    throw new Error("JMAP_SESSION_URL is required");
  }
  const configuredMode = process.env.JMAP_AUTH_MODE?.trim().toLowerCase();
  if (configuredMode && configuredMode !== "basic" && configuredMode !== "bearer") {
    throw new Error("JMAP_AUTH_MODE must be basic or bearer");
  }
  const authMode =
    configuredMode === "basic" ||
    (!configuredMode && Boolean(process.env.JMAP_USERNAME?.trim()))
      ? "basic"
      : "bearer";
  const token =
    authMode === "basic"
      ? process.env.JMAP_PASSWORD?.trim()
      : process.env.JMAP_API_TOKEN?.trim() || process.env.JMAIL_API_TOKEN?.trim();
  if (!token) {
    throw new Error(
      authMode === "basic" ? "JMAP_PASSWORD is required" : "JMAP_API_TOKEN is required",
    );
  }
  const username = process.env.JMAP_USERNAME?.trim();
  if (authMode === "basic" && !username) {
    throw new Error("JMAP_USERNAME is required for Basic authentication");
  }
  return new JmapClient({
    sessionUrl,
    authMode,
    username,
    token,
  });
}

async function main() {
  try {
    const options = readOptions(process.argv.slice(2));
    const client = clientFromEnvironment();
    const report = await runStatefulDraftContract({
      client,
      serverProfile: options.server,
      forceCleanup: async (emailIds) => {
        const internal = client as unknown as {
          callMethod(
            method: string,
            args: Record<string, unknown>,
          ): Promise<Record<string, unknown>>;
        };
        const result = await internal.callMethod("Email/set", {
          accountId: client.state.mailAccountId,
          destroy: emailIds,
        });
        const destroyed = Array.isArray(result.destroyed) ? result.destroyed : [];
        return emailIds.every((emailId) => destroyed.includes(emailId));
      },
    });
    process.stdout.write(
      options.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : `${report.verdict.toUpperCase()} ${report.serverProfile} ${report.contract}\n`,
    );
    process.exitCode = report.verdict === "compatible" ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`openclaw-jmap-draft-contract: ${message}\n`);
    process.exitCode = 64;
  }
}

await main();
