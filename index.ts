import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { jmapPlugin } from "./src/channel.js";
import {
  createJmapOutboundSafetyPolicy,
  hasAutonomousJmapOutboundConfig,
} from "./src/outbound-policy.js";
import { setJmapRuntime } from "./src/runtime.js";
import { createJmapTools, JMAP_TOOL_NAMES } from "./src/tools.js";
import type { CoreConfig } from "./src/types.js";

const plugin = defineChannelPluginEntry({
  id: "jmap",
  name: "JMAP Email",
  description: "JMAP email channel plugin",
  plugin: jmapPlugin,
  setRuntime: setJmapRuntime,
  registerCliMetadata(api) {
    api.registerCli(
      async ({ program, config }) => {
        const { registerJmapCompatibilityCli } = await import(
          "./src/compatibility-cli.js"
        );
        registerJmapCompatibilityCli({
          program,
          config: config as CoreConfig,
        });
      },
      {
        descriptors: [
          {
            name: "jmap",
            description: "Inspect and validate JMAP compatibility",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
  registerFull(api) {
    // tool-discovery intentionally skips setRuntime, but JMAP tools still need
    // the injected runtime when OpenClaw executes them in that mode.
    setJmapRuntime(api.runtime);
    api.registerTrustedToolPolicy(createJmapOutboundSafetyPolicy());
    api.registerTool((ctx) => {
      const cfg = (ctx.getRuntimeConfig?.() ??
        ctx.runtimeConfig ??
        ctx.config ??
        api.config) as CoreConfig;
      return createJmapTools({
        includeImmediateSend: hasAutonomousJmapOutboundConfig(cfg),
      });
    }, {
      names: [...JMAP_TOOL_NAMES],
    });
    api.registerToolMetadata({
      toolName: "jmap_mail_draft_submit",
      displayName: "Send reviewed JMAP email",
      description:
        "External email delivery. Reviewed mode requires one-time operator approval.",
      risk: "high",
      tags: ["email", "outbound", "approval-required"],
    });
    api.registerToolMetadata({
      toolName: "jmap_mail_send",
      displayName: "Send JMAP email immediately",
      description:
        "Autonomous-only compatibility path that sends without the draft review flow.",
      risk: "high",
      tags: ["email", "outbound", "autonomous-only"],
    });
  },
});

export default plugin;
