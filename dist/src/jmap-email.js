import { extractHttpLinks, htmlToPlainText } from "./html.js";
import { looksLikeEmailAddress, normalizeEmailAddress } from "./normalize.js";
export function compact(value) {
    const next = {};
    for (const [key, item] of Object.entries(value)) {
        if (item !== undefined && item !== null) {
            next[key] = item;
        }
    }
    return next;
}
export function ensureArray(value) {
    return Array.isArray(value) ? value : [];
}
export function parseTimestampMs(email) {
    const raw = email.receivedAt ?? email.sentAt;
    if (!raw) {
        return Date.now();
    }
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : Date.now();
}
export function extractTextFromEmail(email) {
    const bodyValues = email.bodyValues ?? {};
    const textParts = ensureArray(email.textBody)
        .map((part) => (part.partId ? bodyValues[part.partId]?.value : undefined))
        .filter((value) => typeof value === "string");
    const joined = textParts.join("\n\n").trim();
    if (joined) {
        return joined;
    }
    const htmlParts = ensureArray(email.htmlBody)
        .map((part) => (part.partId ? bodyValues[part.partId]?.value : undefined))
        .filter((value) => typeof value === "string");
    const htmlText = htmlParts.map(htmlToPlainText).filter(Boolean).join("\n\n").trim();
    if (htmlText) {
        return htmlText;
    }
    return (email.preview ?? "").trim();
}
export function extractLinksFromEmail(email) {
    const bodyValues = email.bodyValues ?? {};
    const htmlParts = ensureArray(email.htmlBody)
        .map((part) => (part.partId ? bodyValues[part.partId]?.value : undefined))
        .filter((value) => typeof value === "string");
    return extractHttpLinks(extractTextFromEmail(email), htmlParts);
}
export function formatReplySubject(subject) {
    const trimmed = (subject ?? "").trim();
    if (!trimmed) {
        return "Re: OpenClaw";
    }
    if (/^re\s*:/i.test(trimmed)) {
        return trimmed;
    }
    return `Re: ${trimmed}`;
}
export function firstMessageId(email) {
    return ensureArray(email.messageId)
        .map((value) => value.trim())
        .find(Boolean);
}
export function normalizeAddressList(items) {
    const next = [];
    for (const item of ensureArray(items)) {
        const email = normalizeEmailAddress(item.email);
        if (!email) {
            continue;
        }
        next.push({
            email,
            name: item.name?.trim() || undefined,
        });
    }
    return next;
}
export function normalizeIdentityEmails(identity, username) {
    const emails = new Set();
    const primaryEmail = normalizeEmailAddress(identity?.email);
    if (primaryEmail) {
        emails.add(primaryEmail);
    }
    for (const replyAddress of normalizeAddressList(identity?.replyTo)) {
        if (replyAddress.email) {
            emails.add(replyAddress.email);
        }
    }
    const normalizedUser = normalizeEmailAddress(username);
    if (normalizedUser && looksLikeEmailAddress(normalizedUser)) {
        emails.add(normalizedUser);
    }
    return emails;
}
export function pickIdentity(identities, preferredEmail) {
    if (identities.length === 0) {
        return null;
    }
    const normalizedPreferred = normalizeEmailAddress(preferredEmail);
    if (normalizedPreferred) {
        const preferred = identities.find((identity) => {
            return normalizeEmailAddress(identity.email) === normalizedPreferred;
        });
        if (preferred) {
            return preferred;
        }
    }
    const preferred = identities.find((identity) => identity.isDefault);
    return preferred ?? identities[0];
}
export function buildThreadContextFromEmail(accountId, email) {
    const threadId = (email.threadId ?? "").trim();
    const from = normalizeAddressList(email.from);
    const to = normalizeAddressList(email.to);
    const cc = normalizeAddressList(email.cc);
    const replyTo = normalizeAddressList(email.replyTo);
    const references = ensureArray(email.references)
        .map((entry) => entry.trim())
        .filter(Boolean);
    const latestMessageId = firstMessageId(email);
    if (latestMessageId && !references.includes(latestMessageId)) {
        references.push(latestMessageId);
    }
    return {
        accountId,
        threadId,
        latestEmailId: email.id,
        latestMessageId,
        subject: email.subject?.trim() || undefined,
        from,
        to,
        cc,
        replyTo,
        references,
    };
}
const AUTOMATED_LOCAL_PART = /^(?:no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounce|automated|system|notifications?)(?:[+._-]|$)/i;
const AUTOMATED_SUBJECT = /^(?:auto(?:matic)?[- ]?reply|out of office|undelivered|mail delivery|delivery status notification|returned mail|配信不能|不在|自動返信)/i;
export function classifyEmailAutomation(email) {
    const reasons = [];
    const autoSubmitted = (email["header:Auto-Submitted:asText"] ?? "").trim().toLowerCase();
    if (autoSubmitted && autoSubmitted !== "no") {
        reasons.push("auto-submitted");
    }
    const precedence = (email["header:Precedence:asText"] ?? "").trim().toLowerCase();
    if (["bulk", "junk", "list", "auto_reply"].includes(precedence)) {
        reasons.push(`precedence:${precedence}`);
    }
    if ([
        "header:List-Id:asText",
        "header:List-Unsubscribe:asText",
        "header:List-Post:asText",
        "header:List-Help:asText",
    ].some((name) => Boolean(String(email[name] ?? "").trim()))) {
        reasons.push("mailing-list");
    }
    const suppress = (email["header:X-Auto-Response-Suppress:asText"] ?? "").trim();
    if (suppress && !/^none$/i.test(suppress)) {
        reasons.push("auto-response-suppress");
    }
    const returnPath = (email["header:Return-Path:asText"] ?? "").trim();
    if (returnPath === "<>" || returnPath === "") {
        if (email["header:Return-Path:asText"] !== undefined) {
            reasons.push("empty-return-path");
        }
    }
    const contentType = (email["header:Content-Type:asText"] ?? "").toLowerCase();
    if (/multipart\/report\b/.test(contentType) && /report-type\s*=\s*delivery-status\b/.test(contentType)) {
        reasons.push("delivery-status");
    }
    const sender = normalizeEmailAddress(ensureArray(email.from)[0]?.email);
    const localPart = sender.split("@")[0] ?? "";
    if (AUTOMATED_LOCAL_PART.test(localPart)) {
        reasons.push("automated-sender");
    }
    if (AUTOMATED_SUBJECT.test(email.subject?.trim() ?? "")) {
        reasons.push("automated-subject");
    }
    const uniqueReasons = [...new Set(reasons)];
    return {
        automated: uniqueReasons.length > 0,
        suppressReply: uniqueReasons.length > 0,
        reasons: uniqueReasons,
    };
}
export function isAutomatedEmail(email) {
    return classifyEmailAutomation(email).automated;
}
function truncateUtf8(value, maxBytes) {
    const source = Buffer.from(value, "utf8");
    if (source.byteLength <= maxBytes) {
        return value;
    }
    return `${source.subarray(0, maxBytes).toString("utf8")}\n\n[Email body truncated]`;
}
export function parseInboundEmail(params) {
    const { email } = params;
    const threadId = (email.threadId ?? "").trim();
    if (!threadId) {
        return null;
    }
    const sender = normalizeAddressList(email.from)[0];
    const senderEmail = normalizeEmailAddress(sender?.email);
    if (!senderEmail) {
        return null;
    }
    const maxBodyBytes = Math.max(1_000, Math.min(1_000_000, params.maxBodyBytes ?? 100_000));
    const text = truncateUtf8(extractTextFromEmail(email).trim(), maxBodyBytes);
    if (!text) {
        return null;
    }
    return {
        threadId,
        senderEmail,
        senderName: sender?.name?.trim() || undefined,
        text,
        subject: email.subject?.trim() || undefined,
        timestampMs: parseTimestampMs(email),
        automated: isAutomatedEmail(email),
    };
}
//# sourceMappingURL=jmap-email.js.map