const statusByAccount = new Map();
const sinkByAccount = new Map();
function normalizeAccountId(accountId) {
    return (accountId ?? "default").trim().toLowerCase() || "default";
}
function createDefaultStatus() {
    return {
        lastPollAt: null,
        lastSuccessfulPollAt: null,
        lastPollErrorAt: null,
        pollCount: 0,
        pollErrorCount: 0,
        lastInboundAt: null,
        lastInboundMessageAt: null,
        lastInboundLatencyMs: null,
        inboundCount: 0,
        lastOutboundAt: null,
        outboundCount: 0,
        lastToolCallAt: null,
        lastToolSucceededAt: null,
        lastToolErrorAt: null,
        lastToolName: null,
        lastToolDurationMs: null,
        toolCallCount: 0,
        toolErrorCount: 0,
        lastError: null,
    };
}
function readStatus(accountId) {
    return statusByAccount.get(accountId) ?? createDefaultStatus();
}
function updateStatus(accountId, update) {
    const normalized = normalizeAccountId(accountId);
    const next = update(readStatus(normalized));
    statusByAccount.set(normalized, next);
    sinkByAccount.get(normalized)?.({ ...next });
    return next;
}
export function bindJmapStatusSink(accountId, sink) {
    if (!sink) {
        return () => undefined;
    }
    const normalized = normalizeAccountId(accountId);
    sinkByAccount.set(normalized, sink);
    sink({ ...readStatus(normalized) });
    return () => {
        if (sinkByAccount.get(normalized) === sink) {
            sinkByAccount.delete(normalized);
        }
    };
}
export function getJmapRuntimeStatus(accountId) {
    return { ...readStatus(normalizeAccountId(accountId)) };
}
export function recordJmapPollSuccess(accountId, at = Date.now()) {
    return updateStatus(accountId, (current) => ({
        ...current,
        lastPollAt: at,
        lastSuccessfulPollAt: at,
        pollCount: current.pollCount + 1,
        lastError: null,
    }));
}
export function recordJmapPollError(accountId, error, at = Date.now()) {
    return updateStatus(accountId, (current) => ({
        ...current,
        lastPollAt: at,
        lastPollErrorAt: at,
        pollErrorCount: current.pollErrorCount + 1,
        lastError: error,
    }));
}
export function recordJmapInbound(accountId, messageAt, handledAt = Date.now()) {
    const normalizedMessageAt = Number.isFinite(messageAt) ? messageAt : handledAt;
    return updateStatus(accountId, (current) => ({
        ...current,
        lastInboundAt: handledAt,
        lastInboundMessageAt: normalizedMessageAt,
        lastInboundLatencyMs: Math.max(0, handledAt - normalizedMessageAt),
        inboundCount: current.inboundCount + 1,
    }));
}
export function recordJmapOutbound(accountId, at = Date.now()) {
    return updateStatus(accountId, (current) => ({
        ...current,
        lastOutboundAt: at,
        outboundCount: current.outboundCount + 1,
    }));
}
export function recordJmapToolStarted(accountId, toolName, at = Date.now()) {
    return updateStatus(accountId, (current) => ({
        ...current,
        lastToolCallAt: at,
        lastToolName: toolName,
        toolCallCount: current.toolCallCount + 1,
    }));
}
export function recordJmapToolSucceeded(accountId, toolName, startedAt, at = Date.now()) {
    return updateStatus(accountId, (current) => ({
        ...current,
        lastToolSucceededAt: at,
        lastToolName: toolName,
        lastToolDurationMs: Math.max(0, at - startedAt),
    }));
}
export function recordJmapToolFailed(accountId, toolName, startedAt, at = Date.now()) {
    return updateStatus(accountId, (current) => ({
        ...current,
        lastToolErrorAt: at,
        lastToolName: toolName,
        lastToolDurationMs: Math.max(0, at - startedAt),
        toolErrorCount: current.toolErrorCount + 1,
    }));
}
export function resetJmapRuntimeStatusForTests() {
    statusByAccount.clear();
    sinkByAccount.clear();
}
//# sourceMappingURL=status.js.map