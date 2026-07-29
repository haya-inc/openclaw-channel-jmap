import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { jmapPlugin } from "./src/channel.js";
import { setJmapRuntime } from "./src/runtime.js";
import { createJmapTools, JMAP_TOOL_NAMES } from "./src/tools.js";
const plugin = defineChannelPluginEntry({
    id: "jmap",
    name: "JMAP Email",
    description: "JMAP email channel plugin",
    plugin: jmapPlugin,
    setRuntime: setJmapRuntime,
    registerCliMetadata(api) {
        api.registerCli(async ({ program, config }) => {
            const { registerJmapCompatibilityCli } = await import("./src/compatibility-cli.js");
            registerJmapCompatibilityCli({
                program,
                config: config,
            });
        }, {
            descriptors: [
                {
                    name: "jmap",
                    description: "Inspect and validate JMAP compatibility",
                    hasSubcommands: true,
                },
            ],
        });
    },
    registerFull(api) {
        // tool-discovery intentionally skips setRuntime, but JMAP tools still need
        // the injected runtime when OpenClaw executes them in that mode.
        setJmapRuntime(api.runtime);
        api.registerTool(() => createJmapTools(), {
            names: [...JMAP_TOOL_NAMES],
        });
    },
});
export default plugin;
//# sourceMappingURL=index.js.map