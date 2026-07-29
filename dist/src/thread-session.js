export function resolveThreadSession(params) {
    const normalizedThreadId = params.threadId.trim().toLowerCase();
    if (!normalizedThreadId) {
        return {
            sessionKey: params.baseSessionKey,
            parentSessionKey: params.baseSessionKey,
        };
    }
    return {
        sessionKey: `${params.baseSessionKey}:thread:${normalizedThreadId}`,
        parentSessionKey: params.baseSessionKey,
    };
}
//# sourceMappingURL=thread-session.js.map