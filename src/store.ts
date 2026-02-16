import type { JmapClient } from "./jmap-client.js";
import type { JmapThreadContext } from "./types.js";

const clients = new Map<string, JmapClient>();
const threadContextByAccount = new Map<string, Map<string, JmapThreadContext>>();

function normalizeAccountId(accountId?: string | null): string {
  return (accountId ?? "default").trim().toLowerCase() || "default";
}

function normalizeThreadId(threadId: string): string {
  return threadId.trim().toLowerCase();
}

export function setJmapClient(accountId: string, client: JmapClient) {
  clients.set(normalizeAccountId(accountId), client);
}

export function getJmapClient(accountId?: string | null): JmapClient | undefined {
  return clients.get(normalizeAccountId(accountId));
}

export function deleteJmapClient(accountId: string) {
  clients.delete(normalizeAccountId(accountId));
}

export function setThreadContext(context: JmapThreadContext) {
  const accountId = normalizeAccountId(context.accountId);
  const threadId = normalizeThreadId(context.threadId);
  if (!threadId) {
    return;
  }
  const existing = threadContextByAccount.get(accountId) ?? new Map<string, JmapThreadContext>();
  existing.set(threadId, { ...context, accountId, threadId });
  threadContextByAccount.set(accountId, existing);
}

export function getThreadContext(params: {
  accountId?: string | null;
  threadId: string;
}): JmapThreadContext | undefined {
  const accountId = normalizeAccountId(params.accountId);
  const threadId = normalizeThreadId(params.threadId);
  if (!threadId) {
    return undefined;
  }
  return threadContextByAccount.get(accountId)?.get(threadId);
}

export function clearJmapAccountState(accountId: string) {
  const normalized = normalizeAccountId(accountId);
  clients.delete(normalized);
  threadContextByAccount.delete(normalized);
}
