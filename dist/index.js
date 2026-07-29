import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { jmapPlugin } from "./src/channel.js";
import { setJmapRuntime } from "./src/runtime.js";
import { createJmapTools, JMAP_TOOL_NAMES } from "./src/tools.js";
const plugin = {
    id: "jmap",
    name: "JMAP Email",
    description: "JMAP email channel plugin",
    configSchema: emptyPluginConfigSchema(),
    register(api) {
        setJmapRuntime(api.runtime);
        api.registerChannel({ plugin: jmapPlugin });
        api.registerTool(() => createJmapTools(), {
            names: [...JMAP_TOOL_NAMES],
        });
    },
};
export default plugin;
//# sourceMappingURL=index.js.map