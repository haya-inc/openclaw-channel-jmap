import {
  compatibilityExitCode,
  formatJmapCompatibilityReport,
  isJmapCompatibilityScope,
  isJmapServerProfile,
  runJmapCompatibilityCheck,
} from "./compatibility.js";
import type { CoreConfig } from "./types.js";

type CommandLike = {
  command(nameAndArgs: string): CommandLike;
  description(text: string): CommandLike;
  option(flags: string, description: string, defaultValue?: string): CommandLike;
  action(handler: (options: Record<string, unknown>) => Promise<void> | void): CommandLike;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function registerJmapCompatibilityCli(params: {
  program: CommandLike;
  config: CoreConfig;
}) {
  const jmap = params.program
    .command("jmap")
    .description("Inspect and validate JMAP compatibility");

  jmap
    .command("compatibility")
    .description("Run a content-free, non-mutating JMAP compatibility probe")
    .option("--account <id>", "Configured JMAP account id")
    .option(
      "--server <profile>",
      "Server profile: stalwart, fastmail, cyrus, apache-james, or generic",
      "generic",
    )
    .option("--scope <scope>", "Required scope: read, manage, send, or full", "read")
    .option("--json", "Print a machine-readable, safely shareable JSON report")
    .action(async (options) => {
      const server = optionalString(options.server) ?? "generic";
      const scope = optionalString(options.scope) ?? "read";
      if (!isJmapServerProfile(server)) {
        throw new Error(`Unknown JMAP server profile: ${server}`);
      }
      if (!isJmapCompatibilityScope(scope)) {
        throw new Error(`Unknown JMAP compatibility scope: ${scope}`);
      }

      const report = await runJmapCompatibilityCheck({
        config: params.config,
        accountId: optionalString(options.account),
        serverProfile: server,
        scope,
      });
      const output =
        options.json === true
          ? `${JSON.stringify(report, null, 2)}\n`
          : `${formatJmapCompatibilityReport(report)}\n`;
      process.stdout.write(output);
      process.exitCode = compatibilityExitCode(report.verdict);
    });
}
