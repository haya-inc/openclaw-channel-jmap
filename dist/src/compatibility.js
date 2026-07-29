import { resolveJmapAccount } from "./accounts.js";
import { JmapClient, JmapMethodError } from "./jmap-client.js";
import { JMAP_CORE, JMAP_MAIL, JMAP_SUBMISSION } from "./types.js";
export const JMAP_SERVER_PROFILES = {
    stalwart: {
        label: "Stalwart",
        documentationUrl: "https://stalw.art/docs/http/jmap/",
    },
    fastmail: {
        label: "Fastmail",
        documentationUrl: "https://www.fastmail.com/dev/",
    },
    cyrus: {
        label: "Cyrus IMAP",
        documentationUrl: "https://www.cyrusimap.org/imap/developer/jmap.html",
    },
    "apache-james": {
        label: "Apache James",
        documentationUrl: "https://james.apache.org/",
    },
    generic: {
        label: "Other standards-based JMAP server",
        documentationUrl: "https://www.rfc-editor.org/rfc/rfc8620.html",
    },
};
export const JMAP_COMPATIBILITY_SCOPES = ["read", "manage", "send", "full"];
const READ_REQUIRED = new Set([
    "configuration",
    "session-discovery",
    "core-capability",
    "mail-capability",
    "mailbox-get",
    "email-query",
    "email-query-changes",
    "email-metadata",
]);
const MANAGE_REQUIRED = new Set([...READ_REQUIRED, "mailbox-rights"]);
const SEND_REQUIRED = new Set([
    ...READ_REQUIRED,
    "submission-capability",
    "identity-get",
]);
const FULL_REQUIRED = new Set([
    ...MANAGE_REQUIRED,
    ...SEND_REQUIRED,
    "download-url",
    "upload-url",
    "event-source-url",
]);
function requirementsFor(scope) {
    if (scope === "manage") {
        return MANAGE_REQUIRED;
    }
    if (scope === "send") {
        return SEND_REQUIRED;
    }
    if (scope === "full") {
        return FULL_REQUIRED;
    }
    return READ_REQUIRED;
}
function safeErrorCode(error) {
    if (error instanceof JmapMethodError) {
        return `jmap-${error.type.replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase()}`;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(message)) {
        return "authentication-failed";
    }
    if (/fetch failed|econn|enotfound|network|timed? ?out/i.test(message)) {
        return "network-failed";
    }
    if (/missing apiurl|session response|invalid json/i.test(message)) {
        return "invalid-session";
    }
    return "protocol-failed";
}
function hasCapability(state, capability) {
    if (!state.capabilities.includes(capability)) {
        return false;
    }
    if (capability === JMAP_MAIL) {
        return state.mailAccountCapabilities.includes(capability);
    }
    if (capability === JMAP_SUBMISSION) {
        return state.submissionAccountCapabilities.includes(capability);
    }
    return true;
}
function featureFromCheck(checks, id, success) {
    const check = checks.find((entry) => entry.id === id);
    if (!check || check.status === "skip") {
        return "unverified";
    }
    return check.status === "pass" ? success : "unsupported";
}
function createReportBase(params) {
    return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        serverProfile: params.serverProfile,
        serverLabel: JMAP_SERVER_PROFILES[params.serverProfile].label,
        scope: params.scope,
        accountId: params.accountId,
        authMode: params.authMode,
        verdict: "unverified",
        advertisedCapabilities: [],
        checks: [],
        features: {
            receivePolling: "unverified",
            search: "unverified",
            read: "unverified",
            thread: "unverified",
            update: "unverified",
            send: "unverified",
            push: "unverified",
            attachmentDownload: "unverified",
            attachmentUpload: "unverified",
        },
        probePolicy: {
            sideEffectsPerformed: false,
            messageBodiesRead: false,
            messageIdentifiersExposed: false,
            outboundDeliveryVerified: false,
        },
        limitations: [
            "The safe probe never sends mail or mutates mailbox state.",
            "A passing send check verifies advertised Submission support and an Identity, not delivery.",
        ],
    };
}
export function isJmapServerProfile(value) {
    return Object.hasOwn(JMAP_SERVER_PROFILES, value);
}
export function isJmapCompatibilityScope(value) {
    return JMAP_COMPATIBILITY_SCOPES.includes(value);
}
export async function runJmapCompatibilityCheck(params) {
    const serverProfile = params.serverProfile ?? "generic";
    const scope = params.scope ?? "read";
    const required = requirementsFor(scope);
    const account = resolveJmapAccount({
        cfg: params.config,
        accountId: params.accountId,
    });
    const report = createReportBase({
        serverProfile,
        scope,
        accountId: account.accountId,
        authMode: account.authMode,
    });
    const addCheck = (id, status, evidence, code, durationMs) => {
        report.checks.push({
            id,
            status,
            required: required.has(id),
            evidence,
            code,
            ...(typeof durationMs === "number" ? { durationMs } : {}),
        });
    };
    if (!account.configured || !account.token.trim()) {
        addCheck("configuration", "fail", "not-run", "credentials-missing");
        report.verdict = "unverified";
        return report;
    }
    addCheck("configuration", "pass", "advertised", "configured");
    const client = new JmapClient({
        sessionUrl: account.sessionUrl,
        token: account.token,
        authMode: account.authMode,
        username: account.username,
    });
    let state;
    const connectStartedAt = Date.now();
    try {
        state = await client.init();
        addCheck("session-discovery", "pass", "invoked", "session-and-mailbox-ready", Date.now() - connectStartedAt);
        addCheck("mailbox-get", "pass", "invoked", "method-succeeded");
    }
    catch (error) {
        const code = safeErrorCode(error);
        addCheck("session-discovery", "fail", "invoked", code, Date.now() - connectStartedAt);
        addCheck("mailbox-get", "skip", "not-run", "session-unavailable");
        report.verdict =
            code === "authentication-failed" || code === "network-failed"
                ? "unverified"
                : "incompatible";
        return report;
    }
    report.advertisedCapabilities = [...state.capabilities].toSorted();
    const coreAvailable = hasCapability(state, JMAP_CORE);
    const mailAvailable = hasCapability(state, JMAP_MAIL);
    const submissionAvailable = hasCapability(state, JMAP_SUBMISSION);
    addCheck("core-capability", coreAvailable ? "pass" : "fail", coreAvailable ? "advertised" : "not-advertised", coreAvailable ? "capability-advertised" : "capability-missing");
    addCheck("mail-capability", mailAvailable ? "pass" : "fail", mailAvailable ? "advertised" : "not-advertised", mailAvailable ? "capability-advertised" : "capability-missing");
    const hasManageRights = state.mailboxes.some((mailbox) => {
        const rights = mailbox.myRights;
        return Boolean(rights?.maySetSeen ||
            rights?.maySetKeywords ||
            rights?.mayAddItems ||
            rights?.mayRemoveItems);
    });
    addCheck("mailbox-rights", hasManageRights ? "pass" : "skip", hasManageRights ? "advertised" : "not-run", hasManageRights ? "management-rights-advertised" : "rights-not-reported");
    let queryState = null;
    const queryStartedAt = Date.now();
    try {
        queryState = await client.queryInboxState();
        addCheck("email-query", "pass", "invoked", "method-succeeded", Date.now() - queryStartedAt);
    }
    catch (error) {
        addCheck("email-query", "fail", "invoked", safeErrorCode(error), Date.now() - queryStartedAt);
    }
    if (queryState) {
        const changesStartedAt = Date.now();
        try {
            await client.queryInboxChanges(queryState);
            addCheck("email-query-changes", "pass", "invoked", "method-succeeded", Date.now() - changesStartedAt);
        }
        catch (error) {
            addCheck("email-query-changes", "fail", "invoked", safeErrorCode(error), Date.now() - changesStartedAt);
        }
    }
    else {
        addCheck("email-query-changes", "skip", "not-run", "query-state-unavailable");
    }
    const metadataStartedAt = Date.now();
    try {
        const metadata = await client.probeEmailMetadata();
        addCheck("email-metadata", metadata.sampleEmailFound ? "pass" : "skip", metadata.sampleEmailFound ? "invoked" : "not-run", metadata.sampleEmailFound ? "email-get-succeeded" : "empty-mailbox", Date.now() - metadataStartedAt);
        addCheck("thread-get", metadata.threadAvailable
            ? metadata.threadGetVerified
                ? "pass"
                : "fail"
            : "skip", metadata.threadAvailable ? "invoked" : "not-run", metadata.threadAvailable
            ? metadata.threadGetVerified
                ? "method-succeeded"
                : "method-failed"
            : "thread-sample-unavailable");
    }
    catch (error) {
        addCheck("email-metadata", "fail", "invoked", safeErrorCode(error), Date.now() - metadataStartedAt);
        addCheck("thread-get", "skip", "not-run", "email-metadata-unavailable");
    }
    addCheck("submission-capability", submissionAvailable ? "pass" : "fail", submissionAvailable ? "advertised" : "not-advertised", submissionAvailable ? "capability-advertised" : "capability-missing");
    addCheck("identity-get", state.identityId && state.identityEmail ? "pass" : submissionAvailable ? "fail" : "skip", state.identityId && state.identityEmail ? "invoked" : "not-run", state.identityId && state.identityEmail
        ? "identity-available"
        : submissionAvailable
            ? "identity-unavailable"
            : "submission-unavailable");
    addCheck("download-url", state.downloadUrl ? "pass" : "fail", state.downloadUrl ? "advertised" : "not-advertised", state.downloadUrl ? "template-advertised" : "template-missing");
    addCheck("upload-url", state.uploadUrl ? "pass" : "fail", state.uploadUrl ? "advertised" : "not-advertised", state.uploadUrl ? "template-advertised" : "template-missing");
    addCheck("event-source-url", state.eventSourceUrl ? "pass" : "fail", state.eventSourceUrl ? "advertised" : "not-advertised", state.eventSourceUrl ? "template-advertised" : "template-missing");
    report.features = {
        receivePolling: featureFromCheck(report.checks, "email-query-changes", "verified"),
        search: featureFromCheck(report.checks, "email-query", "verified"),
        read: report.checks.find((entry) => entry.id === "email-metadata")?.code === "empty-mailbox"
            ? mailAvailable
                ? "advertised"
                : "unsupported"
            : featureFromCheck(report.checks, "email-metadata", "verified"),
        thread: featureFromCheck(report.checks, "thread-get", "verified"),
        update: featureFromCheck(report.checks, "mailbox-rights", "advertised"),
        send: submissionAvailable && Boolean(state.identityId && state.identityEmail)
            ? "advertised"
            : "unsupported",
        push: featureFromCheck(report.checks, "event-source-url", "advertised"),
        attachmentDownload: featureFromCheck(report.checks, "download-url", "advertised"),
        attachmentUpload: featureFromCheck(report.checks, "upload-url", "advertised"),
    };
    const requiredChecks = report.checks.filter((entry) => entry.required);
    const essentialFailure = requiredChecks.some((entry) => READ_REQUIRED.has(entry.id) && entry.status === "fail");
    const emptyMailboxOnly = requiredChecks.every((entry) => entry.status === "pass" ||
        (entry.id === "email-metadata" && entry.code === "empty-mailbox") ||
        entry.id === "thread-get");
    const missingRequired = requiredChecks.some((entry) => entry.status === "fail" ||
        (entry.status === "skip" &&
            !(entry.id === "email-metadata" && entry.code === "empty-mailbox")));
    if (essentialFailure) {
        report.verdict = "incompatible";
    }
    else if (missingRequired && !emptyMailboxOnly) {
        report.verdict = "partial";
    }
    else {
        report.verdict = "compatible";
    }
    return report;
}
export function compatibilityExitCode(verdict) {
    if (verdict === "compatible") {
        return 0;
    }
    if (verdict === "partial") {
        return 2;
    }
    if (verdict === "incompatible") {
        return 3;
    }
    return 4;
}
export function formatJmapCompatibilityReport(report) {
    const lines = [
        `JMAP compatibility: ${report.verdict}`,
        `Server profile: ${report.serverLabel} (${report.serverProfile})`,
        `Required scope: ${report.scope}`,
        `Account: ${report.accountId}`,
        `Authentication: ${report.authMode}`,
        "Checks:",
    ];
    for (const check of report.checks) {
        lines.push(`  ${check.status.toUpperCase().padEnd(4)} ${check.id}${check.required ? " [required]" : ""} (${check.code})`);
    }
    lines.push("Safety: no mail sent, no mailbox state changed, no message body read, no message identifier printed.");
    if (report.scope === "send" ||
        report.scope === "full" ||
        report.features.send === "advertised") {
        lines.push("Delivery remains unverified until an explicit side-effecting send test is run.");
    }
    return lines.join("\n");
}
//# sourceMappingURL=compatibility.js.map