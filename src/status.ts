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

type PersistedActivity =
  | {
      v: 1;
      kind: "outbound";
      at: number;
    }
  | {
      v: 1;
      kind: "tool-start";
      at: number;
      toolName: string;
    }
  | {
      v: 1;
      kind: "tool-success" | "tool-error";
      at: number;
      toolName: string;
      durationMs: number;
    };

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

function auditPath(accountId: string): string | null {
  try {
    const stateDir = getJmapRuntime().state.resolveStateDir();
    const directory = path.join(stateDir, "jmap", "activity");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const accountHash = createHash("sha256").update(accountId).digest("hex");
    return path.join(directory, `${accountHash}.jsonl`);
  } catch {
    return null;
  }
}

function appendPersistedActivity(accountId: string, activity: PersistedActivity) {
  const target = auditPath(accountId);
  if (!target) {
    return;
  }
  try {
    appendFileSync(target, `${JSON.stringify(activity)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(target, 0o600);
  } catch {
    // Telemetry must never break mailbox operations.
  }
}

function readPersistedActivityStatus(accountId: string): Partial<JmapRuntimeStatus> {
  const target = auditPath(accountId);
  if (!target) {
    return {};
  }
  let source: string;
  try {
    source = readFileSync(target, "utf8");
  } catch {
    return {};
  }

  const result: Partial<JmapRuntimeStatus> = {
    outboundCount: 0,
    toolCallCount: 0,
    toolErrorCount: 0,
  };
  for (const line of source.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let event: PersistedActivity;
    try {
      event = JSON.parse(line) as PersistedActivity;
    } catch {
      continue;
    }
    if (event.v !== 1 || !Number.isFinite(event.at)) {
      continue;
    }
    if (event.kind === "outbound") {
      result.outboundCount = (result.outboundCount ?? 0) + 1;
      result.lastOutboundAt = event.at;
      continue;
    }
    if (event.kind === "tool-start") {
      result.toolCallCount = (result.toolCallCount ?? 0) + 1;
      result.lastToolCallAt = event.at;
      result.lastToolName = event.toolName;
      continue;
    }
    if (event.kind === "tool-success") {
      result.lastToolSucceededAt = event.at;
      result.lastToolName = event.toolName;
      result.lastToolDurationMs = event.durationMs;
      continue;
    }
    if (event.kind === "tool-error") {
      result.toolErrorCount = (result.toolErrorCount ?? 0) + 1;
      result.lastToolErrorAt = event.at;
      result.lastToolName = event.toolName;
      result.lastToolDurationMs = event.durationMs;
    }
  }
  return result;
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
  const normalized = normalizeAccountId(accountId);
  const current = readStatus(normalized);
  const persisted = readPersistedActivityStatus(normalized);
  const persistedToolAt = persisted.lastToolCallAt ?? null;
  const currentToolAt = current.lastToolCallAt;
  const usePersistedTool =
    persistedToolAt !== null && (currentToolAt === null || persistedToolAt >= currentToolAt);
  return {
    ...current,
    lastOutboundAt:
      Math.max(current.lastOutboundAt ?? 0, persisted.lastOutboundAt ?? 0) || null,
    outboundCount: Math.max(current.outboundCount, persisted.outboundCount ?? 0),
    lastToolCallAt:
      Math.max(current.lastToolCallAt ?? 0, persisted.lastToolCallAt ?? 0) || null,
    lastToolSucceededAt:
      Math.max(current.lastToolSucceededAt ?? 0, persisted.lastToolSucceededAt ?? 0) || null,
    lastToolErrorAt:
      Math.max(current.lastToolErrorAt ?? 0, persisted.lastToolErrorAt ?? 0) || null,
    lastToolName: usePersistedTool ? (persisted.lastToolName ?? null) : current.lastToolName,
    lastToolDurationMs: usePersistedTool
      ? (persisted.lastToolDurationMs ?? null)
      : current.lastToolDurationMs,
    toolCallCount: Math.max(current.toolCallCount, persisted.toolCallCount ?? 0),
    toolErrorCount: Math.max(current.toolErrorCount, persisted.toolErrorCount ?? 0),
  };
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
  appendPersistedActivity(normalizeAccountId(accountId), {
    v: 1,
    kind: "outbound",
    at,
  });
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
  appendPersistedActivity(normalizeAccountId(accountId), {
    v: 1,
    kind: "tool-start",
    at,
    toolName,
  });
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
  appendPersistedActivity(normalizeAccountId(accountId), {
    v: 1,
    kind: "tool-success",
    at,
    toolName,
    durationMs: Math.max(0, at - startedAt),
  });
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
  appendPersistedActivity(normalizeAccountId(accountId), {
    v: 1,
    kind: "tool-error",
    at,
    toolName,
    durationMs: Math.max(0, at - startedAt),
  });
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
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { getJmapRuntime } from "./runtime.js";
