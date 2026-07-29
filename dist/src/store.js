const clients = new Map();
const threadContextByAccount = new Map();
function normalizeAccountId(accountId) {
    return (accountId ?? "default").trim().toLowerCase() || "default";
}
function normalizeThreadId(threadId) {
    return threadId.trim().toLowerCase();
}
export function setJmapClient(accountId, client) {
    clients.set(normalizeAccountId(accountId), client);
}
export function getJmapClient(accountId) {
    return clients.get(normalizeAccountId(accountId));
}
export function deleteJmapClient(accountId) {
    clients.delete(normalizeAccountId(accountId));
}
export function setThreadContext(context) {
    const accountId = normalizeAccountId(context.accountId);
    const threadId = normalizeThreadId(context.threadId);
    if (!threadId) {
        return;
    }
    const existing = threadContextByAccount.get(accountId) ?? new Map();
    existing.set(threadId, { ...context, accountId, threadId });
    threadContextByAccount.set(accountId, existing);
}
export function getThreadContext(params) {
    const accountId = normalizeAccountId(params.accountId);
    const threadId = normalizeThreadId(params.threadId);
    if (!threadId) {
        return undefined;
    }
    return threadContextByAccount.get(accountId)?.get(threadId);
}
export function clearJmapAccountState(accountId) {
    const normalized = normalizeAccountId(accountId);
    clients.delete(normalized);
    threadContextByAccount.delete(normalized);
}
//# sourceMappingURL=store.js.map