let runtime = null;
export function setJmapRuntime(next) {
    runtime = next;
}
export function getJmapRuntime() {
    if (!runtime) {
        throw new Error("JMAP runtime not initialized");
    }
    return runtime;
}
//# sourceMappingURL=runtime.js.map