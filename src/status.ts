export type JmapRuntimeStatus = {
  lastPollAt: number | null;
  lastSuccessfulPollAt: number | null;
  lastPollErrorAt: number | null;
  pollCount: number;
  pollErrorCount: number;
  lastInboundAt: number | null;
  lastInboundMessageAt: number | null;
  lastInboundLatencyMs: number | null;
  inboundCount: number;
  lastOutboundAt: number | null;
  outboundCount: number;
  lastToolCallAt: number | null;
  lastToolSucceededAt: number | null;
  lastToolErrorAt: number | null;
  lastToolName: string | null;
  lastToolDurationMs: number | null;
  toolCallCount: number;
  toolErrorCount: number;
  lastError: string | null;
};

type JmapStatusSink = (patch: JmapRuntimeStatus) => void;

const statusByAccount = new Map<string, JmapRuntimeStatus>();
const sinkByAccount = new Map<string, JmapStatusSink>();

function normalizeAccountId(accountId?: string | null): string {
  return (accountId ?? "default").trim().toLowerCase() || "default";
}

function createDefaultStatus(): JmapRuntimeStatus {
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

function readStatus(accountId: string): JmapRuntimeStatus {
  return statusByAccount.get(accountId) ?? createDefaultStatus();
}

function updateStatus(
  accountId: string,
  update: (current: JmapRuntimeStatus) => JmapRuntimeStatus,
): JmapRuntimeStatus {
  const normalized = normalizeAccountId(accountId);
  const next = update(readStatus(normalized));
  statusByAccount.set(normalized, next);
  sinkByAccount.get(normalized)?.({ ...next });
  return next;
}

export function bindJmapStatusSink(accountId: string, sink?: JmapStatusSink): () => void {
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

export function getJmapRuntimeStatus(accountId?: string | null): JmapRuntimeStatus {
  return { ...readStatus(normalizeAccountId(accountId)) };
}

export function recordJmapPollSuccess(accountId: string, at = Date.now()): JmapRuntimeStatus {
  return updateStatus(accountId, (current) => ({
    ...current,
    lastPollAt: at,
    lastSuccessfulPollAt: at,
    pollCount: current.pollCount + 1,
    lastError: null,
  }));
}

export function recordJmapPollError(
  accountId: string,
  error: string,
  at = Date.now(),
): JmapRuntimeStatus {
  return updateStatus(accountId, (current) => ({
    ...current,
    lastPollAt: at,
    lastPollErrorAt: at,
    pollErrorCount: current.pollErrorCount + 1,
    lastError: error,
  }));
}

export function recordJmapInbound(
  accountId: string,
  messageAt: number,
  handledAt = Date.now(),
): JmapRuntimeStatus {
  const normalizedMessageAt = Number.isFinite(messageAt) ? messageAt : handledAt;
  return updateStatus(accountId, (current) => ({
    ...current,
    lastInboundAt: handledAt,
    lastInboundMessageAt: normalizedMessageAt,
    lastInboundLatencyMs: Math.max(0, handledAt - normalizedMessageAt),
    inboundCount: current.inboundCount + 1,
  }));
}

export function recordJmapOutbound(accountId: string, at = Date.now()): JmapRuntimeStatus {
  return updateStatus(accountId, (current) => ({
    ...current,
    lastOutboundAt: at,
    outboundCount: current.outboundCount + 1,
  }));
}

export function recordJmapToolStarted(
  accountId: string,
  toolName: string,
  at = Date.now(),
): JmapRuntimeStatus {
  return updateStatus(accountId, (current) => ({
    ...current,
    lastToolCallAt: at,
    lastToolName: toolName,
    toolCallCount: current.toolCallCount + 1,
  }));
}

export function recordJmapToolSucceeded(
  accountId: string,
  toolName: string,
  startedAt: number,
  at = Date.now(),
): JmapRuntimeStatus {
  return updateStatus(accountId, (current) => ({
    ...current,
    lastToolSucceededAt: at,
    lastToolName: toolName,
    lastToolDurationMs: Math.max(0, at - startedAt),
  }));
}

export function recordJmapToolFailed(
  accountId: string,
  toolName: string,
  startedAt: number,
  at = Date.now(),
): JmapRuntimeStatus {
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
