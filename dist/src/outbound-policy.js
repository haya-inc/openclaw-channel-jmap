import { createHash } from "node:crypto";
import { resolveJmapAccount } from "./accounts.js";
import { resolveJmapClient } from "./client-resolver.js";
import { getJmapRuntime } from "./runtime.js";
export const DEFAULT_JMAP_OUTBOUND_POLICY = "reviewed";
export const JMAP_OUTBOUND_SAFETY_POLICY_ID = "jmap-outbound-safety";
const DRAFT_SUBMIT_TOOL = "jmap_mail_draft_submit";
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1_000;
const APPROVAL_GRANT_TTL_MS = 5 * 60 * 1_000;
const APPROVAL_DESCRIPTION_MAX_CHARS = 2_600;
const APPROVAL_BODY_PREVIEW_MAX_CHARS = 1_200;
const submitApprovalGrants = new Map();
function optionalString(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed || undefined;
}
function sliceCodePoints(value, maxChars) {
    const chars = Array.from(value);
    if (chars.length <= maxChars) {
        return value;
    }
    return `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}
function sanitizeApprovalText(value) {
    return value
        .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "")
        .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => character === "\n" || character === "\r" ? "\n" : "�")
        .replace(/\r\n?/gu, "\n");
}
function sanitizeApprovalField(value, maxChars = 160) {
    return sliceCodePoints(sanitizeApprovalText(value).replace(/\n+/gu, "↵"), maxChars);
}
function formatAddresses(values) {
    if (values.length === 0) {
        return "(none)";
    }
    const visible = values
        .slice(0, 10)
        .map((value) => {
        const email = sanitizeApprovalField(value.email?.trim() || "(missing address)");
        const name = value.name?.trim()
            ? sanitizeApprovalField(value.name.trim())
            : undefined;
        return name ? `${name} <${email}>` : email;
    })
        .join(", ");
    const remainder = values.length > 10
        ? `, … (+${values.length - 10} more; inspect the full preview)`
        : "";
    return sliceCodePoints(`${visible}${remainder}`, 240);
}
function attachmentSummary(preview) {
    if (preview.attachments.length === 0) {
        return "0";
    }
    const names = preview.attachments
        .slice(0, 10)
        .map((attachment) => sanitizeApprovalField(attachment.name?.trim() || attachment.type || "(unnamed)"))
        .join(", ");
    const remainder = preview.attachments.length > 10 ? ", …" : "";
    return sliceCodePoints(`${preview.attachments.length} (${names}${remainder})`, 240);
}
function buildApprovalDescription(accountId, preview, sendAt) {
    const body = sanitizeApprovalText(preview.text);
    const bodyChars = Array.from(body);
    const bodyTruncated = bodyChars.length > APPROVAL_BODY_PREVIEW_MAX_CHARS;
    const bodyPreview = sliceCodePoints(body, APPROVAL_BODY_PREVIEW_MAX_CHARS);
    const quotedBodyPreview = (bodyPreview || "(empty)")
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    const bodyDigest = createHash("sha256").update(preview.text, "utf8").digest("hex");
    const description = [
        `Account: ${sanitizeApprovalField(accountId)}`,
        `Draft: ${sanitizeApprovalField(preview.emailId)}`,
        `Preview SHA-256: ${preview.previewToken}`,
        `Body SHA-256: ${bodyDigest}`,
        `Identity: ${sanitizeApprovalField(preview.identityEmail)} ` +
            `(${sanitizeApprovalField(preview.identityId)})`,
        `From: ${formatAddresses(preview.from)}`,
        `To: ${formatAddresses(preview.to)}`,
        `Subject: ${sanitizeApprovalField(preview.subject || "(empty)")}`,
        `Send at: ${sanitizeApprovalField(sendAt ?? "now")}`,
        `Cc: ${formatAddresses(preview.cc)}`,
        `Bcc: ${formatAddresses(preview.bcc)}`,
        `Reply-To: ${formatAddresses(preview.replyTo)}`,
        `Attachments: ${attachmentSummary(preview)}`,
        "",
        bodyTruncated
            ? "Body preview (truncated; deny and inspect the full draft if uncertain):"
            : "Body:",
        quotedBodyPreview,
    ]
        .map(sanitizeApprovalText)
        .join("\n");
    return sliceCodePoints(description, APPROVAL_DESCRIPTION_MAX_CHARS);
}
function pruneExpiredApprovalGrants(now = Date.now()) {
    for (const [toolCallId, grant] of submitApprovalGrants) {
        if (grant.expiresAt <= now) {
            submitApprovalGrants.delete(toolCallId);
        }
    }
}
function approvalTitle(preview) {
    const firstRecipient = preview.to[0]?.email?.trim() || "(no To recipient)";
    const remainder = preview.to.length > 1 ? ` and ${preview.to.length - 1} more` : "";
    return sliceCodePoints(sanitizeApprovalField(`Send reviewed email to ${firstRecipient}${remainder}`), 160);
}
export function resolveJmapOutboundPolicy(account) {
    return account.config.outboundPolicy ?? DEFAULT_JMAP_OUTBOUND_POLICY;
}
export function hasAutonomousJmapOutboundConfig(cfg) {
    const jmap = cfg.channels?.jmap;
    if (!jmap) {
        return false;
    }
    if (jmap.outboundPolicy === "autonomous") {
        return true;
    }
    return Object.values(jmap.accounts ?? {}).some((account) => account?.outboundPolicy === "autonomous");
}
export function assertJmapDirectOutboundAllowed(params) {
    const policy = resolveJmapOutboundPolicy(params.account);
    if (policy === "disabled") {
        throw new Error(`JMAP outbound delivery is disabled for account "${params.account.accountId}"`);
    }
    if (params.intent === "system-pairing") {
        return;
    }
    if (policy !== "autonomous") {
        throw new Error(`JMAP direct delivery requires outboundPolicy="autonomous" for account ` +
            `"${params.account.accountId}"; use the reviewed draft workflow instead`);
    }
}
export function isJmapAutoReplyEnabled(account) {
    return (account.config.autoReply === true &&
        resolveJmapOutboundPolicy(account) === "autonomous");
}
export function consumeJmapDraftSubmitAuthorization(params) {
    const policy = resolveJmapOutboundPolicy(params.account);
    if (policy === "disabled") {
        throw new Error(`JMAP outbound delivery is disabled for account "${params.account.accountId}"`);
    }
    if (policy === "autonomous") {
        return;
    }
    pruneExpiredApprovalGrants();
    const grant = submitApprovalGrants.get(params.toolCallId);
    submitApprovalGrants.delete(params.toolCallId);
    if (!grant ||
        grant.accountId !== params.account.accountId ||
        grant.emailId !== params.emailId ||
        grant.identityId !== params.identityId ||
        grant.fromEmail !== params.fromEmail ||
        grant.previewToken !== params.previewToken ||
        grant.sendAt !== params.sendAt) {
        throw new Error("A one-time OpenClaw operator approval is required to submit this reviewed draft");
    }
}
export function createJmapOutboundSafetyPolicy() {
    return {
        id: JMAP_OUTBOUND_SAFETY_POLICY_ID,
        description: "Require a content-bound, one-time operator approval before reviewed JMAP draft submission.",
        evaluate: async (event, ctx) => {
            if (event.toolName !== DRAFT_SUBMIT_TOOL) {
                return;
            }
            const cfg = getJmapRuntime().config.current();
            const account = resolveJmapAccount({
                cfg,
                accountId: optionalString(event.params.accountId),
            });
            const policy = resolveJmapOutboundPolicy(account);
            if (policy === "disabled") {
                return {
                    block: true,
                    blockReason: `JMAP outbound delivery is disabled for account "${account.accountId}"`,
                };
            }
            if (policy === "autonomous") {
                return;
            }
            const toolCallId = ctx.toolCallId ?? event.toolCallId;
            if (!toolCallId) {
                return {
                    block: true,
                    blockReason: "Reviewed JMAP submission requires a host-authoritative tool call id",
                };
            }
            submitApprovalGrants.delete(toolCallId);
            const emailId = optionalString(event.params.emailId);
            const identityId = optionalString(event.params.identityId);
            const fromEmail = optionalString(event.params.fromEmail);
            const previewToken = optionalString(event.params.previewToken);
            const sendAt = optionalString(event.params.sendAt);
            if (!emailId || !identityId || !previewToken) {
                return {
                    block: true,
                    blockReason: "Reviewed JMAP submission requires emailId, identityId, and previewToken",
                };
            }
            try {
                const { client } = await resolveJmapClient({ account });
                const preview = await client.previewDraft({
                    emailId,
                    identityId,
                    fromEmail,
                });
                if (preview.previewToken !== previewToken) {
                    return {
                        block: true,
                        blockReason: "Draft changed or was not previewed; obtain a fresh preview before requesting approval",
                    };
                }
                return {
                    requireApproval: {
                        pluginId: "jmap",
                        title: approvalTitle(preview),
                        description: buildApprovalDescription(account.accountId, preview, sendAt),
                        severity: "critical",
                        timeoutMs: APPROVAL_TIMEOUT_MS,
                        timeoutReason: "The email approval expired without a decision. No email was sent; preview the draft again before retrying.",
                        allowedDecisions: ["allow-once", "deny"],
                        onResolution: (decision) => {
                            if (decision === "allow-once") {
                                submitApprovalGrants.set(toolCallId, {
                                    accountId: account.accountId,
                                    emailId,
                                    identityId,
                                    fromEmail,
                                    previewToken,
                                    sendAt,
                                    expiresAt: Date.now() + APPROVAL_GRANT_TTL_MS,
                                });
                                return;
                            }
                            submitApprovalGrants.delete(toolCallId);
                        },
                    },
                };
            }
            catch (error) {
                return {
                    block: true,
                    blockReason: error instanceof Error
                        ? `Unable to verify the reviewed draft: ${error.message}`
                        : "Unable to verify the reviewed draft",
                };
            }
        },
    };
}
export function resetJmapOutboundApprovalsForTests() {
    submitApprovalGrants.clear();
}
//# sourceMappingURL=outbound-policy.js.map