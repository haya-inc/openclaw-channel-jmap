export function resolveThreadSession(params: { baseSessionKey: string; threadId: string }): {
  sessionKey: string;
  parentSessionKey: string;
} {
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
