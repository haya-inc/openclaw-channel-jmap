import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { jmapPlugin } from "./src/channel.js";
import { setJmapRuntime } from "./src/runtime.js";

const plugin = {
  id: "jmap",
  name: "JMAP",
  description: "JMAP email channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setJmapRuntime(api.runtime);
    api.registerChannel({ plugin: jmapPlugin });
  },
};

export default plugin;
