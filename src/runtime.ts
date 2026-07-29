import type { PluginRuntime } from "openclaw/plugin-sdk/core";

let runtime: PluginRuntime | null = null;

export function setJmapRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getJmapRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("JMAP runtime not initialized");
  }
  return runtime;
}
