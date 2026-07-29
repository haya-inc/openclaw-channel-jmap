import { resolveConfiguredJmapAccount, resolveJmapClient, } from "./client-resolver.js";
import { JmapMethodError } from "./jmap-client.js";
import { isJmapThreadTarget, normalizeJmapTarget, parseJmapThreadTarget } from "./normalize.js";
import { assertJmapDirectOutboundAllowed, } from "./outbound-policy.js";
import { getJmapRuntime } from "./runtime.js";
import { recordJmapOutbound } from "./status.js";
import { getThreadContext, setThreadContext } from "./store.js";
function logJmapOutbound(accountId, message) {
    const logger = getJmapRuntime().logging?.getChildLogger?.({
        channel: "jmap",
        accountId,
    });
    logger?.info?.(message);
}
async function resolveClient(params) {
    const cfg = params.cfg ??
        getJmapRuntime().config.current();
    const account = resolveConfiguredJmapAccount({
        accountId: params.accountId,
        cfg,
    });
    assertJmapDirectOutboundAllowed({ account, intent: params.intent });
    const { client } = await resolveJmapClient({ account });
    return { accountId: account.accountId, client };
}
export async function sendJmapReplyToThread(params) {
    const threadId = params.threadId.trim().toLowerCase();
    if (!threadId) {
        throw new Error("JMAP thread id is required");
    }
    const text = params.text.trim();
    const mediaUrls = (params.mediaUrls ?? []).map((url) => url.trim()).filter(Boolean);
    if (!text && mediaUrls.length === 0) {
        throw new Error("JMAP outbound message is empty");
    }
    const { accountId, client } = await resolveClient({
        accountId: params.accountId,
        cfg: params.cfg,
        intent: params.intent,
    });
    const state = client.state;
    let context = getThreadContext({
        accountId: state.mailAccountId,
        threadId,
    });
    if (!context) {
        const fetched = await client.getThreadContext(threadId);
        if (fetched) {
            setThreadContext(fetched);
            context = fetched;
        }
    }
    if (!context) {
        throw new Error(`JMAP thread not found: ${threadId}`);
    }
    const result = await client.sendToThread({
        thread: context,
        text,
        mediaUrls,
    });
    logJmapOutbound(accountId, `outbound thread reply sent thread=${threadId} messageId=${result.messageId} target=${context.replyTo.map((x) => x.email).join(",") || context.from.map((x) => x.email).join(",") || context.to.map((x) => x.email).join(",")}`);
    getJmapRuntime().channel.activity.record({
        channel: "jmap",
        accountId,
        direction: "outbound",
    });
    recordJmapOutbound(accountId);
    return result;
}
export async function sendJmapMessageToAddress(params) {
    const { accountId, client } = await resolveClient({
        accountId: params.accountId,
        cfg: params.cfg,
        intent: params.intent,
    });
    const result = await client.sendToAddress({
        toEmail: params.toEmail,
        text: params.text,
        subject: params.subject,
    });
    logJmapOutbound(accountId, `outbound direct sent to=${params.toEmail} messageId=${result.messageId}`);
    getJmapRuntime().channel.activity.record({
        channel: "jmap",
        accountId,
        direction: "outbound",
    });
    recordJmapOutbound(accountId);
    return result;
}
export async function sendJmapByTarget(params) {
    const normalized = normalizeJmapTarget(params.to);
    if (!normalized) {
        throw new Error("invalid JMAP target");
    }
    const mediaUrls = params.mediaUrl?.trim() ? [params.mediaUrl.trim()] : undefined;
    const threadHint = params.threadId !== null && params.threadId !== undefined
        ? String(params.threadId).trim().toLowerCase()
        : "";
    if (threadHint) {
        const result = await sendJmapReplyToThread({
            accountId: params.accountId,
            threadId: threadHint,
            text: params.text,
            mediaUrls,
            cfg: params.cfg,
            intent: params.intent,
        });
        return {
            ...result,
            to: `thread:${threadHint}`,
        };
    }
    if (isJmapThreadTarget(normalized)) {
        const threadId = parseJmapThreadTarget(normalized);
        if (!threadId) {
            throw new Error("invalid JMAP thread target");
        }
        const result = await sendJmapReplyToThread({
            accountId: params.accountId,
            threadId,
            text: params.text,
            mediaUrls,
            cfg: params.cfg,
            intent: params.intent,
        });
        return {
            ...result,
            to: normalized,
        };
    }
    const withMedia = mediaUrls?.length
        ? `${params.text}\n\nAttachment: ${mediaUrls[0]}`
        : params.text;
    const result = await sendJmapMessageToAddress({
        accountId: params.accountId,
        toEmail: normalized,
        text: withMedia,
        subject: "OpenClaw",
        cfg: params.cfg,
        intent: params.intent,
    });
    return {
        ...result,
        to: normalized,
    };
}
export function isRecoverableJmapPollError(error) {
    if (error instanceof JmapMethodError) {
        return error.type === "cannotCalculateChanges" || error.type === "stateMismatch";
    }
    return false;
}
//# sourceMappingURL=send.js.map