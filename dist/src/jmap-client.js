import { createHash } from "node:crypto";
import { buildThreadContextFromEmail, compact, ensureArray, extractTextFromEmail, formatReplySubject, normalizeIdentityEmails, parseTimestampMs, pickIdentity, } from "./jmap-email.js";
import { looksLikeEmailAddress, normalizeEmailAddress } from "./normalize.js";
import { DEFAULT_MAX_BODY_BYTES, JMAP_CORE, JMAP_MAIL, JMAP_SUBMISSION, } from "./types.js";
const SAFETY_HEADER_PROPERTIES = [
    "header:Auto-Submitted:asText",
    "header:Precedence:asText",
    "header:List-Id:asText",
    "header:List-Unsubscribe:asText",
    "header:List-Post:asText",
    "header:List-Help:asText",
    "header:Return-Path:asText",
    "header:X-Auto-Response-Suppress:asText",
    "header:Content-Type:asText",
];
function resolveSessionUrl(value, baseUrl) {
    const trimmed = value?.trim();
    if (!trimmed) {
        return undefined;
    }
    const templates = [];
    const masked = trimmed.replace(/\{[^}]+\}/g, (template) => {
        const marker = `__OPENCLAW_JMAP_TEMPLATE_${templates.length}__`;
        templates.push(template);
        return marker;
    });
    const resolved = new URL(masked, baseUrl).toString();
    return templates.reduce((url, template, index) => url.replace(`__OPENCLAW_JMAP_TEMPLATE_${index}__`, template), resolved);
}
function accountCapabilitiesFor(session, accountId) {
    const explicit = Object.keys(session.accounts?.[accountId]?.accountCapabilities ?? {});
    const primary = Object.entries(session.primaryAccounts ?? {})
        .filter(([capability, primaryAccountId]) => primaryAccountId === accountId &&
        Boolean((session.capabilities ?? {})[capability]))
        .map(([capability]) => capability);
    return [...new Set([...explicit, ...primary])];
}
function accountCapabilityValue(session, accountId, capability) {
    const value = session.accounts?.[accountId]?.accountCapabilities?.[capability];
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
function normalizeSubjectForComparison(value) {
    return (value ?? "").normalize("NFKC").toLocaleLowerCase();
}
function subjectFallbackToken(subject) {
    const tokens = subject.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
    return tokens
        .filter((token) => token.length >= 2)
        .sort((left, right) => right.length - left.length)[0]
        ?.slice(0, 64);
}
function normalizeRecipientEmails(values, field) {
    const recipients = [];
    const seen = new Set();
    for (const rawValue of values ?? []) {
        const email = normalizeEmailAddress(rawValue);
        if (!email || !looksLikeEmailAddress(email)) {
            throw new JmapMethodError("invalidArguments", `${field} contains an invalid email address`);
        }
        if (!seen.has(email)) {
            seen.add(email);
            recipients.push({ email });
        }
    }
    return recipients;
}
function mergeAddresses(...lists) {
    const addresses = [];
    const seen = new Set();
    for (const list of lists) {
        for (const address of list ?? []) {
            const email = normalizeEmailAddress(address.email);
            if (!email || !looksLikeEmailAddress(email) || seen.has(email)) {
                continue;
            }
            seen.add(email);
            addresses.push({
                email,
                ...(address.name?.trim() ? { name: address.name.trim() } : {}),
            });
        }
    }
    return addresses;
}
const MAX_DRAFT_RECIPIENTS = 100;
const MAX_DRAFT_ATTACHMENTS = 50;
const MAX_DRAFT_SUBJECT_BYTES = 998;
const MAX_DRAFT_TEXT_BYTES = 1_000_000;
const DEFAULT_SAFE_UPLOAD_BYTES = 5 * 1024 * 1024;
function utf8ByteLength(value) {
    return new TextEncoder().encode(value).byteLength;
}
function canonicalDraftAddresses(values, field) {
    return (values ?? []).map((address, index) => {
        const email = normalizeEmailAddress(address.email);
        if (!email || !looksLikeEmailAddress(email)) {
            throw new JmapMethodError("invalidEmail", `Draft ${field}[${index}] is not a valid email address`);
        }
        return {
            email,
            ...(address.name?.trim() ? { name: address.name.trim() } : {}),
        };
    });
}
function extractExactDraftText(email) {
    const textParts = ensureArray(email.textBody);
    const htmlParts = ensureArray(email.htmlBody);
    if (textParts.length === 0) {
        if (htmlParts.length > 0) {
            throw new JmapMethodError("unsupported", "Safe draft preview currently supports plain-text-only drafts");
        }
        return "";
    }
    if (textParts.length !== 1 ||
        (textParts[0]?.type && textParts[0].type.toLowerCase() !== "text/plain")) {
        throw new JmapMethodError("unsupported", "Safe draft preview requires exactly one text/plain body part");
    }
    const textPart = textParts[0];
    const htmlBodyMirrorsTextPart = htmlParts.length === 0 ||
        (htmlParts.length === 1 &&
            Boolean(textPart?.partId) &&
            htmlParts[0]?.partId === textPart?.partId &&
            htmlParts[0]?.type?.toLowerCase() === "text/plain");
    if (!htmlBodyMirrorsTextPart) {
        throw new JmapMethodError("unsupported", "Safe draft preview currently supports plain-text-only drafts");
    }
    return textParts
        .map((part) => {
        const value = part.partId ? email.bodyValues?.[part.partId]?.value : undefined;
        if (typeof value !== "string") {
            throw new JmapMethodError("unsupported", "JMAP server did not return an exact plain-text draft body");
        }
        return value;
    })
        .join("\n\n");
}
function normalizeDraftAttachments(values) {
    if (!values) {
        return [];
    }
    if (values.length > MAX_DRAFT_ATTACHMENTS) {
        throw new JmapMethodError("invalidArguments", `Draft attachments exceed the ${MAX_DRAFT_ATTACHMENTS}-attachment limit`);
    }
    return values.map((attachment, index) => {
        const blobId = attachment.blobId?.trim();
        if (!blobId) {
            throw new JmapMethodError("invalidArguments", `attachments[${index}].blobId is required`);
        }
        const name = attachment.name?.trim() || undefined;
        const type = attachment.type?.trim() || "application/octet-stream";
        if (name && utf8ByteLength(name) > MAX_DRAFT_SUBJECT_BYTES) {
            throw new JmapMethodError("invalidArguments", `attachments[${index}].name is too long`);
        }
        return compact({
            blobId,
            type,
            name,
            disposition: attachment.disposition?.trim() || "attachment",
            cid: attachment.cid?.trim() || undefined,
            language: attachment.language?.map((value) => value.trim()).filter(Boolean),
            location: attachment.location?.trim() || undefined,
        });
    });
}
function appendTextSignature(text, signature) {
    const normalizedSignature = signature?.trim();
    if (!normalizedSignature) {
        return text;
    }
    return text.trimEnd() ? `${text.trimEnd()}\n\n${normalizedSignature}` : normalizedSignature;
}
function draftToken(params) {
    const canonical = {
        emailId: params.email.id,
        blobId: params.email.blobId ?? "",
        identityId: params.identityId,
        identityEmail: params.identityEmail,
        from: canonicalDraftAddresses(params.email.from, "from"),
        to: canonicalDraftAddresses(params.email.to, "to"),
        cc: canonicalDraftAddresses(params.email.cc, "cc"),
        bcc: canonicalDraftAddresses(params.email.bcc, "bcc"),
        replyTo: canonicalDraftAddresses(params.email.replyTo, "replyTo"),
        subject: params.email.subject ?? "",
        text: params.text,
        attachments: ensureArray(params.email.attachments).map((attachment) => ({
            blobId: attachment.blobId ?? "",
            name: attachment.name ?? "",
            type: attachment.type ?? "",
            size: attachment.size ?? 0,
            disposition: attachment.disposition ?? "",
            cid: attachment.cid ?? "",
            language: attachment.language ?? [],
            location: attachment.location ?? "",
        })),
    };
    return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}
export class JmapMethodError extends Error {
    type;
    constructor(type, message) {
        super(message);
        this.type = type;
    }
}
export class JmapClient {
    sessionUrl;
    token;
    authMode;
    username;
    accountIdHint;
    initState = null;
    constructor(params) {
        this.sessionUrl = params.sessionUrl;
        this.token = params.token;
        this.authMode = params.authMode ?? "bearer";
        this.username = params.username?.trim() ?? "";
        this.accountIdHint = params.accountIdHint;
    }
    get authorizationHeader() {
        if (this.authMode === "basic") {
            return `Basic ${Buffer.from(`${this.username}:${this.token}`, "utf8").toString("base64")}`;
        }
        return `Bearer ${this.token}`;
    }
    get isReady() {
        return this.initState !== null;
    }
    get state() {
        if (!this.initState) {
            throw new Error("JMAP client is not initialized");
        }
        return this.initState;
    }
    async init() {
        if (this.initState) {
            return this.initState;
        }
        const session = await this.fetchSession();
        const mailAccountId = this.resolveMailAccountId(session);
        const submissionAccountId = this.resolveSubmissionAccountId(session);
        const mailboxes = await this.getMailboxes(session.apiUrl, mailAccountId);
        let identity = null;
        if (submissionAccountId) {
            try {
                identity = pickIdentity(await this.getIdentities(session.apiUrl, submissionAccountId), session.username);
            }
            catch {
                // Mail reading must remain available when Submission support is partial
                // or temporarily unavailable. Sending retries the identity lookup.
                identity = null;
            }
        }
        const identityEmail = normalizeEmailAddress(identity?.email) || undefined;
        const inboxMailboxId = mailboxes.find((box) => box.role === "inbox")?.id;
        const sentMailboxId = mailboxes.find((box) => box.role === "sent")?.id;
        const draftsMailboxId = mailboxes.find((box) => box.role === "drafts")?.id;
        const capabilities = Object.keys(session.capabilities ?? {});
        const mailAccountCapabilities = accountCapabilitiesFor(session, mailAccountId);
        const submissionAccountCapabilities = submissionAccountId
            ? accountCapabilitiesFor(session, submissionAccountId)
            : [];
        const submissionCapability = submissionAccountId
            ? accountCapabilityValue(session, submissionAccountId, JMAP_SUBMISSION)
            : {};
        const coreCapabilityValue = session.capabilities?.[JMAP_CORE];
        const coreCapability = coreCapabilityValue &&
            typeof coreCapabilityValue === "object" &&
            !Array.isArray(coreCapabilityValue)
            ? coreCapabilityValue
            : {};
        const maxSizeUpload = typeof coreCapability.maxSizeUpload === "number" &&
            Number.isFinite(coreCapability.maxSizeUpload)
            ? Math.max(1, Math.trunc(coreCapability.maxSizeUpload))
            : DEFAULT_SAFE_UPLOAD_BYTES;
        const rawSubmissionExtensions = submissionCapability.submissionExtensions;
        const submissionExtensions = rawSubmissionExtensions &&
            typeof rawSubmissionExtensions === "object" &&
            !Array.isArray(rawSubmissionExtensions)
            ? Object.fromEntries(Object.entries(rawSubmissionExtensions)
                .filter((entry) => Array.isArray(entry[1]))
                .map(([name, values]) => [
                name.toUpperCase(),
                values.filter((value) => typeof value === "string"),
            ]))
            : {};
        const maxDelayedSend = typeof submissionCapability.maxDelayedSend === "number" &&
            Number.isFinite(submissionCapability.maxDelayedSend)
            ? Math.max(0, Math.trunc(submissionCapability.maxDelayedSend))
            : 0;
        this.initState = {
            apiUrl: session.apiUrl,
            downloadUrl: session.downloadUrl?.trim() || undefined,
            uploadUrl: session.uploadUrl?.trim() || undefined,
            eventSourceUrl: session.eventSourceUrl?.trim() || undefined,
            capabilities,
            mailAccountCapabilities,
            submissionAccountCapabilities,
            maxSizeUpload,
            maxDelayedSend,
            submissionExtensions,
            username: session.username,
            mailAccountId,
            submissionAccountId,
            inboxMailboxId,
            sentMailboxId,
            draftsMailboxId,
            mailboxes,
            identityId: identity?.id,
            identityEmail,
            identityName: identity?.name?.trim() || undefined,
            identityReplyTo: identity?.replyTo,
            identityBcc: identity?.bcc,
            identityTextSignature: identity?.textSignature,
            identityHtmlSignature: identity?.htmlSignature,
            selfEmails: normalizeIdentityEmails(identity, session.username),
        };
        return this.initState;
    }
    async queryInboxState() {
        const state = this.state;
        const result = await this.callMethod("Email/query", {
            accountId: state.mailAccountId,
            ...(state.inboxMailboxId ? { filter: { inMailbox: state.inboxMailboxId } } : {}),
            sort: [{ property: "receivedAt", isAscending: false }],
            calculateTotal: false,
            position: 0,
            limit: 1,
        });
        const queryState = String(result.queryState ?? "").trim();
        if (!queryState) {
            throw new Error("JMAP Email/query did not return queryState");
        }
        return queryState;
    }
    async queryRecentInboxIds(params) {
        const state = this.state;
        const limit = typeof params?.limit === "number" && Number.isFinite(params.limit) && params.limit > 0
            ? Math.trunc(params.limit)
            : 50;
        const position = typeof params?.position === "number" && Number.isFinite(params.position) && params.position >= 0
            ? Math.trunc(params.position)
            : 0;
        const result = await this.callMethod("Email/query", {
            accountId: state.mailAccountId,
            ...(state.inboxMailboxId ? { filter: { inMailbox: state.inboxMailboxId } } : {}),
            sort: [{ property: "receivedAt", isAscending: false }],
            calculateTotal: false,
            position,
            limit,
        });
        return ensureArray(result.ids)
            .map((entry) => entry.trim())
            .filter(Boolean);
    }
    async queryUnreadInboxIds(params) {
        const state = this.state;
        const limit = typeof params?.limit === "number" && Number.isFinite(params.limit) && params.limit > 0
            ? Math.trunc(params.limit)
            : 50;
        const position = typeof params?.position === "number" && Number.isFinite(params.position) && params.position >= 0
            ? Math.trunc(params.position)
            : 0;
        const filter = compact({
            inMailbox: state.inboxMailboxId,
            notKeyword: "$seen",
        });
        const result = await this.callMethod("Email/query", {
            accountId: state.mailAccountId,
            filter,
            sort: [{ property: "receivedAt", isAscending: true }],
            calculateTotal: false,
            position,
            limit,
        });
        return ensureArray(result.ids)
            .map((entry) => entry.trim())
            .filter(Boolean);
    }
    async queryInboxChanges(sinceQueryState) {
        const state = this.state;
        const result = await this.callMethod("Email/queryChanges", {
            accountId: state.mailAccountId,
            sinceQueryState,
            ...(state.inboxMailboxId ? { filter: { inMailbox: state.inboxMailboxId } } : {}),
            sort: [{ property: "receivedAt", isAscending: false }],
            calculateTotal: false,
        });
        return {
            oldQueryState: String(result.oldQueryState ?? "").trim(),
            newQueryState: String(result.newQueryState ?? "").trim(),
            removed: ensureArray(result.removed),
            added: ensureArray(result.added),
            hasMoreChanges: Boolean(result.hasMoreChanges),
            upToId: typeof result.upToId === "string" ? result.upToId : undefined,
            total: typeof result.total === "number" ? result.total : undefined,
        };
    }
    listMailboxes() {
        return this.state.mailboxes
            .map((mailbox) => ({ ...mailbox, myRights: mailbox.myRights ? { ...mailbox.myRights } : undefined }))
            .sort((left, right) => {
            const order = (left.sortOrder ?? 0) - (right.sortOrder ?? 0);
            return order || (left.name ?? "").localeCompare(right.name ?? "");
        });
    }
    resolveMailbox(reference) {
        const raw = reference?.trim() || "inbox";
        if (raw.toLowerCase() === "all") {
            return undefined;
        }
        const normalized = raw.toLocaleLowerCase();
        const mailbox = this.state.mailboxes.find((candidate) => candidate.id === raw ||
            candidate.role?.toLocaleLowerCase() === normalized ||
            candidate.name?.toLocaleLowerCase() === normalized);
        if (!mailbox) {
            throw new Error(`JMAP mailbox not found by id, role, or name: ${raw}`);
        }
        return mailbox;
    }
    async getEmails(ids, options) {
        if (ids.length === 0) {
            return [];
        }
        const state = this.state;
        const maxBodyValueBytes = Math.max(1_000, Math.min(1_000_000, Math.trunc(options?.maxBodyValueBytes ?? DEFAULT_MAX_BODY_BYTES)));
        const result = await this.callMethod("Email/get", {
            accountId: state.mailAccountId,
            ids,
            properties: [
                "id",
                "blobId",
                "threadId",
                "mailboxIds",
                "from",
                "to",
                "cc",
                "bcc",
                "replyTo",
                "subject",
                "preview",
                "receivedAt",
                "sentAt",
                "messageId",
                "inReplyTo",
                "references",
                "textBody",
                "htmlBody",
                "attachments",
                "hasAttachment",
                "bodyValues",
                "keywords",
                "size",
                ...SAFETY_HEADER_PROPERTIES,
            ],
            fetchTextBodyValues: true,
            fetchHTMLBodyValues: true,
            maxBodyValueBytes,
        });
        return ensureArray(result.list).filter((item) => item.id);
    }
    async getEmailMetadata(ids) {
        if (ids.length === 0) {
            return [];
        }
        const state = this.state;
        const result = await this.callMethod("Email/get", {
            accountId: state.mailAccountId,
            ids,
            properties: [
                "id",
                "blobId",
                "threadId",
                "mailboxIds",
                "from",
                "to",
                "cc",
                "bcc",
                "replyTo",
                "subject",
                "preview",
                "receivedAt",
                "sentAt",
                "messageId",
                "inReplyTo",
                "references",
                "attachments",
                "hasAttachment",
                "keywords",
                "size",
                ...SAFETY_HEADER_PROPERTIES,
            ],
            fetchTextBodyValues: false,
            fetchHTMLBodyValues: false,
        });
        return ensureArray(result.list).filter((item) => item.id);
    }
    async searchEmails(params = {}) {
        return (await this.searchEmailPage(params)).emails;
    }
    async searchEmailPage(params = {}) {
        const state = this.state;
        const limit = Math.max(1, Math.min(100, Math.trunc(params.limit ?? 20)));
        const position = Math.max(0, Math.trunc(params.position ?? 0));
        const requestedSubject = params.subject?.trim() || undefined;
        const mailbox = this.resolveMailbox(params.mailbox);
        const explicitHasKeyword = params.hasKeyword?.trim() || undefined;
        const explicitNotKeyword = params.notKeyword?.trim() || undefined;
        const filter = compact({
            inMailbox: mailbox?.id,
            text: params.text?.trim() || undefined,
            from: params.from?.trim() || undefined,
            to: params.to?.trim() || undefined,
            subject: requestedSubject,
            after: params.after?.trim() || undefined,
            before: params.before?.trim() || undefined,
            minSize: typeof params.minSize === "number" && Number.isFinite(params.minSize)
                ? Math.max(0, Math.trunc(params.minSize))
                : undefined,
            maxSize: typeof params.maxSize === "number" && Number.isFinite(params.maxSize)
                ? Math.max(0, Math.trunc(params.maxSize))
                : undefined,
            hasAttachment: typeof params.hasAttachment === "boolean" ? params.hasAttachment : undefined,
            hasKeyword: explicitHasKeyword ?? (params.unread === false ? "$seen" : undefined),
            notKeyword: explicitNotKeyword ?? (params.unread === true ? "$seen" : undefined),
        });
        const queryIds = async (queryFilter, queryLimit, queryPosition, calculateTotal) => {
            const result = await this.callMethod("Email/query", {
                accountId: state.mailAccountId,
                filter: queryFilter,
                sort: [{ property: "receivedAt", isAscending: false }],
                collapseThreads: params.collapseThreads === true,
                calculateTotal,
                position: queryPosition,
                limit: queryLimit,
            });
            return {
                ids: ensureArray(result.ids)
                    .map((id) => id.trim())
                    .filter(Boolean),
                queryState: String(result.queryState ?? "").trim(),
                canCalculateChanges: result.canCalculateChanges === true,
                total: typeof result.total === "number" ? result.total : undefined,
                position: typeof result.position === "number" && Number.isFinite(result.position)
                    ? Math.max(0, Math.trunc(result.position))
                    : queryPosition,
            };
        };
        const query = await queryIds(filter, limit, position, true);
        const ids = query.ids;
        if (ids.length > 0 || !requestedSubject) {
            const emails = await this.getEmailMetadata(ids);
            const byId = new Map(emails.map((email) => [email.id, email]));
            const ordered = ids
                .map((id) => byId.get(id))
                .filter((email) => Boolean(email));
            const nextPosition = ordered.length === limit && (query.total === undefined || position + ordered.length < query.total)
                ? position + ordered.length
                : undefined;
            return {
                emails: ordered,
                queryState: query.queryState,
                canCalculateChanges: query.canCalculateChanges,
                position: query.position,
                total: query.total,
                nextPosition,
            };
        }
        // A server can return no matches for a standards-compliant subject filter
        // even though general text search finds the message. Retry only after an
        // empty result, then enforce the literal subject condition locally over
        // metadata so provider quirks cannot widen the visible result set. Bodies
        // are never fetched for search.
        const fallbackBase = { ...filter };
        delete fallbackBase.subject;
        const token = params.text?.trim() ? undefined : subjectFallbackToken(requestedSubject);
        const fallbackFilters = [];
        if (token) {
            fallbackFilters.push({ ...fallbackBase, text: token });
        }
        fallbackFilters.push(fallbackBase);
        const normalizedSubject = normalizeSubjectForComparison(requestedSubject);
        for (const fallbackFilter of fallbackFilters) {
            const fallbackQuery = await queryIds(fallbackFilter, 100, 0, false);
            const candidates = await this.getEmailMetadata(fallbackQuery.ids);
            const matches = candidates
                .filter((email) => normalizeSubjectForComparison(email.subject).includes(normalizedSubject))
                .slice(0, limit);
            if (matches.length > 0) {
                return {
                    emails: matches,
                    queryState: query.queryState,
                    canCalculateChanges: query.canCalculateChanges,
                    position: 0,
                    total: matches.length,
                };
            }
        }
        return {
            emails: [],
            queryState: query.queryState,
            canCalculateChanges: query.canCalculateChanges,
            position: query.position,
            total: 0,
        };
    }
    async getThreadEmails(threadId) {
        return (await this.getThreadPage(threadId, { limit: 100, offset: 0 })).emails;
    }
    async getThreadPage(threadId, params) {
        const normalizedThreadId = threadId.trim();
        if (!normalizedThreadId) {
            throw new Error("JMAP thread id is required");
        }
        const result = await this.callMethod("Thread/get", {
            accountId: this.state.mailAccountId,
            ids: [normalizedThreadId],
        });
        const thread = ensureArray(result.list).find((entry) => entry.id === normalizedThreadId);
        if (!thread) {
            return { emails: [], total: 0, offset: 0 };
        }
        const emailIds = ensureArray(thread.emailIds);
        const limit = Math.max(1, Math.min(100, Math.trunc(params?.limit ?? 20)));
        const offset = Math.max(0, Math.trunc(params?.offset ?? 0));
        const end = Math.max(0, emailIds.length - offset);
        const start = Math.max(0, end - limit);
        const selectedIds = emailIds.slice(start, end);
        const emails = await this.getEmails(selectedIds, {
            maxBodyValueBytes: params?.maxBodyValueBytes,
        });
        const byId = new Map(emails.map((email) => [email.id, email]));
        const ordered = selectedIds
            .map((id) => byId.get(id))
            .filter((email) => Boolean(email))
            .sort((left, right) => parseTimestampMs(left) - parseTimestampMs(right));
        return {
            emails: ordered,
            total: emailIds.length,
            offset,
            nextOffset: start > 0 ? offset + selectedIds.length : undefined,
        };
    }
    async probeEmailMetadata() {
        const state = this.state;
        const query = await this.callMethod("Email/query", {
            accountId: state.mailAccountId,
            ...(state.inboxMailboxId ? { filter: { inMailbox: state.inboxMailboxId } } : {}),
            sort: [{ property: "receivedAt", isAscending: false }],
            calculateTotal: false,
            position: 0,
            limit: 1,
        });
        const emailId = ensureArray(query.ids)
            .map((id) => id.trim())
            .find(Boolean);
        if (!emailId) {
            return {
                sampleEmailFound: false,
                emailGetVerified: false,
                threadGetVerified: false,
                threadAvailable: false,
            };
        }
        const emailResult = await this.callMethod("Email/get", {
            accountId: state.mailAccountId,
            ids: [emailId],
            properties: ["id", "threadId"],
            fetchTextBodyValues: false,
            fetchHTMLBodyValues: false,
        });
        const email = ensureArray(emailResult.list).find((entry) => entry.id === emailId);
        if (!email) {
            throw new Error("JMAP Email/get did not return the probed email");
        }
        const threadId = email.threadId?.trim();
        if (!threadId) {
            return {
                sampleEmailFound: true,
                emailGetVerified: true,
                threadGetVerified: false,
                threadAvailable: false,
            };
        }
        const threadResult = await this.callMethod("Thread/get", {
            accountId: state.mailAccountId,
            ids: [threadId],
            properties: ["id", "emailIds"],
        });
        const thread = ensureArray(threadResult.list).find((entry) => entry.id === threadId);
        if (!thread) {
            throw new Error("JMAP Thread/get did not return the probed thread");
        }
        return {
            sampleEmailFound: true,
            emailGetVerified: true,
            threadGetVerified: true,
            threadAvailable: true,
        };
    }
    async markEmailsSeen(ids) {
        await this.updateEmailKeywords(ids, { seen: true });
    }
    async updateEmailKeywords(ids, changes) {
        const validIds = ids.map((id) => id.trim()).filter(Boolean);
        if (validIds.length === 0) {
            throw new Error("At least one JMAP email id is required");
        }
        const patch = compact({
            "keywords/$seen": changes.seen,
            "keywords/$flagged": changes.flagged,
        });
        if (Object.keys(patch).length === 0) {
            throw new Error("No JMAP keyword changes were requested");
        }
        const result = await this.callMethod("Email/set", {
            accountId: this.state.mailAccountId,
            update: Object.fromEntries(validIds.map((id) => [id, patch])),
        });
        const notUpdated = result.notUpdated;
        const failedId = validIds.find((id) => notUpdated?.[id]);
        if (failedId) {
            const failure = notUpdated?.[failedId];
            throw new JmapMethodError(failure?.type?.trim() || "notUpdated", failure?.description?.trim() || `JMAP Email/set did not update email ${failedId}`);
        }
    }
    async moveEmails(ids, destinationReference) {
        const validIds = ids.map((id) => id.trim()).filter(Boolean);
        if (validIds.length === 0) {
            throw new Error("At least one JMAP email id is required");
        }
        const destination = this.resolveMailbox(destinationReference);
        if (!destination) {
            throw new Error("A concrete destination mailbox is required");
        }
        if (destination.myRights?.mayAddItems === false) {
            throw new Error(`JMAP mailbox does not allow adding email: ${destination.name ?? destination.id}`);
        }
        const emailMetadata = await this.getEmailMetadata(validIds);
        const metadataById = new Map(emailMetadata.map((email) => [email.id, email]));
        const missingIds = validIds.filter((id) => !metadataById.has(id));
        if (missingIds.length > 0) {
            throw new Error(`JMAP email not found: ${missingIds.join(", ")}`);
        }
        const mailboxById = new Map(this.state.mailboxes.map((mailbox) => [mailbox.id, mailbox]));
        const previous = validIds.map((emailId) => ({
            emailId,
            mailboxes: Object.entries(metadataById.get(emailId)?.mailboxIds ?? {})
                .filter(([, present]) => present)
                .map(([mailboxId]) => mailboxById.get(mailboxId))
                .filter((mailbox) => Boolean(mailbox)),
        }));
        const nonRemovable = previous
            .flatMap((entry) => entry.mailboxes)
            .find((mailbox) => mailbox.myRights?.mayRemoveItems === false);
        if (nonRemovable) {
            throw new Error(`JMAP mailbox does not allow removing email: ${nonRemovable.name ?? nonRemovable.id}`);
        }
        const result = await this.callMethod("Email/set", {
            accountId: this.state.mailAccountId,
            update: Object.fromEntries(validIds.map((id) => [
                id,
                {
                    mailboxIds: {
                        [destination.id]: true,
                    },
                },
            ])),
        });
        const notUpdated = result.notUpdated;
        const failedId = validIds.find((id) => notUpdated?.[id]);
        if (failedId) {
            const failure = notUpdated?.[failedId];
            throw new JmapMethodError(failure?.type?.trim() || "notUpdated", failure?.description?.trim() || `JMAP Email/set did not move email ${failedId}`);
        }
        return { destination, previous };
    }
    async getThreadContext(threadId) {
        const normalizedThreadId = threadId.trim();
        if (!normalizedThreadId) {
            return null;
        }
        const state = this.state;
        const threadResult = await this.callMethod("Thread/get", {
            accountId: state.mailAccountId,
            ids: [normalizedThreadId],
        });
        const threads = ensureArray(threadResult.list).filter((item) => item.id === normalizedThreadId);
        if (threads.length === 0) {
            return null;
        }
        const emailIds = ensureArray(threads[0].emailIds);
        if (emailIds.length === 0) {
            return null;
        }
        const recentIds = emailIds.slice(-20);
        const emails = await this.getEmails(recentIds);
        const latest = emails.slice().sort((a, b) => parseTimestampMs(b) - parseTimestampMs(a))[0];
        if (!latest) {
            return null;
        }
        return buildThreadContextFromEmail(state.mailAccountId, latest);
    }
    toInboundText(email) {
        return extractTextFromEmail(email);
    }
    buildThreadContext(email) {
        const state = this.state;
        const threadId = (email.threadId ?? "").trim();
        if (!threadId) {
            return null;
        }
        return buildThreadContextFromEmail(state.mailAccountId, email);
    }
    isSelfAddress(email) {
        const state = this.state;
        const normalized = normalizeEmailAddress(email);
        return normalized ? state.selfEmails.has(normalized) : false;
    }
    async sendToThread(params) {
        const state = this.state;
        const text = params.text.trim();
        const mediaBlock = ensureArray(params.mediaUrls)
            .map((url) => url.trim())
            .filter(Boolean)
            .map((url) => `Attachment: ${url}`)
            .join("\n");
        const bodyText = text ? (mediaBlock ? `${text}\n\n${mediaBlock}` : text) : mediaBlock;
        if (!bodyText.trim()) {
            throw new Error("JMAP outbound text is empty");
        }
        const selectRecipients = (candidates) => {
            const deduped = new Map();
            for (const item of candidates) {
                const email = normalizeEmailAddress(item.email);
                if (!email || state.selfEmails.has(email)) {
                    continue;
                }
                deduped.set(email, {
                    email,
                    name: item.name?.trim() || undefined,
                });
            }
            return [...deduped.values()];
        };
        const replyRecipients = selectRecipients(params.thread.replyTo);
        const fromRecipients = selectRecipients(params.thread.from);
        const toRecipients = selectRecipients(params.thread.to);
        const recipients = replyRecipients.length > 0
            ? replyRecipients
            : fromRecipients.length > 0
                ? fromRecipients
                : toRecipients;
        if (recipients.length === 0) {
            throw new Error(`No reply recipient found for thread ${params.thread.threadId}`);
        }
        return await this.sendEmailInternal({
            to: recipients,
            cc: params.thread.cc,
            subject: formatReplySubject(params.thread.subject),
            bodyText,
            inReplyTo: params.thread.latestMessageId,
            references: params.thread.references,
            threadId: params.thread.threadId,
            accountId: state.mailAccountId,
        });
    }
    async sendToAddress(params) {
        const toEmail = normalizeEmailAddress(params.toEmail);
        if (!toEmail) {
            throw new Error("Recipient email is required");
        }
        const text = params.text.trim();
        if (!text) {
            throw new Error("JMAP outbound text is empty");
        }
        return await this.sendEmailInternal({
            to: [{ email: toEmail }],
            cc: [],
            subject: params.subject?.trim() || "OpenClaw",
            bodyText: text,
            references: [],
            accountId: this.state.mailAccountId,
        });
    }
    async listIdentities() {
        const state = this.state;
        if (!state.submissionAccountId) {
            return [];
        }
        return await this.getIdentities(state.apiUrl, state.submissionAccountId);
    }
    async createDraft(params) {
        const { state, fromEmail } = await this.resolveCompositionIdentity(params.identityId, params.fromEmail);
        const draftsMailbox = state.mailboxes.find((mailbox) => mailbox.id === state.draftsMailboxId);
        if (!draftsMailbox) {
            throw new JmapMethodError("notFound", "JMAP account does not expose a mailbox with the drafts role");
        }
        if (draftsMailbox.myRights?.mayAddItems === false) {
            throw new JmapMethodError("forbidden", "JMAP account does not permit adding emails to the drafts mailbox");
        }
        const to = normalizeRecipientEmails(params.to, "to");
        const cc = normalizeRecipientEmails(params.cc, "cc");
        const explicitBcc = normalizeRecipientEmails(params.bcc, "bcc");
        const bcc = mergeAddresses(state.identityBcc, explicitBcc);
        const replyTo = mergeAddresses(state.identityReplyTo);
        const attachments = normalizeDraftAttachments(params.attachments);
        const subject = params.subject?.trim() ?? "";
        const text = params.applyIdentitySignature === true
            ? appendTextSignature(params.text ?? "", state.identityTextSignature)
            : (params.text ?? "");
        if (to.length + cc.length + bcc.length > MAX_DRAFT_RECIPIENTS) {
            throw new JmapMethodError("invalidArguments", `Draft recipients exceed the ${MAX_DRAFT_RECIPIENTS}-address limit`);
        }
        if (utf8ByteLength(subject) > MAX_DRAFT_SUBJECT_BYTES) {
            throw new JmapMethodError("invalidArguments", `Draft subject exceeds the ${MAX_DRAFT_SUBJECT_BYTES}-byte limit`);
        }
        if (utf8ByteLength(text) > MAX_DRAFT_TEXT_BYTES) {
            throw new JmapMethodError("invalidArguments", `Draft body exceeds the ${MAX_DRAFT_TEXT_BYTES}-byte limit`);
        }
        if (to.length === 0 &&
            cc.length === 0 &&
            explicitBcc.length === 0 &&
            !subject &&
            !text.trim()) {
            throw new JmapMethodError("invalidArguments", "Refusing to create an entirely empty draft");
        }
        const bodyPartId = "body-1";
        const createEmail = compact({
            mailboxIds: {
                [draftsMailbox.id]: true,
            },
            from: [
                compact({
                    email: fromEmail,
                    name: state.identityName,
                }),
            ],
            to: to.length > 0 ? to : undefined,
            cc: cc.length > 0 ? cc : undefined,
            bcc: bcc.length > 0 ? bcc : undefined,
            replyTo: replyTo.length > 0 ? replyTo : undefined,
            subject,
            textBody: [{ partId: bodyPartId, type: "text/plain" }],
            bodyValues: {
                [bodyPartId]: {
                    value: text,
                },
            },
            attachments: attachments.length > 0 ? attachments : undefined,
            keywords: {
                $draft: true,
            },
            "header:Auto-Submitted:asText": "auto-generated",
            "header:X-Auto-Response-Suppress:asText": "All",
        });
        const emailSet = await this.callMethod("Email/set", {
            accountId: state.mailAccountId,
            create: {
                createDraft: createEmail,
            },
        });
        const created = emailSet.created;
        const createdDraft = created?.createDraft;
        const notCreated = emailSet.notCreated;
        const failure = notCreated?.createDraft;
        if (failure) {
            throw new JmapMethodError(failure.type?.trim() || "notCreated", failure.description?.trim() || "JMAP server rejected the draft");
        }
        const emailId = createdDraft?.id?.trim();
        if (!emailId) {
            throw new Error("JMAP Email/set did not return created draft id");
        }
        return {
            emailId,
            threadId: createdDraft?.threadId,
            size: createdDraft?.size,
            identityId: state.identityId,
            identityEmail: fromEmail,
            draftsMailboxId: draftsMailbox.id,
        };
    }
    async previewDraft(params) {
        return (await this.inspectDraft(params)).preview;
    }
    async replaceDraft(params) {
        const { preview, state } = await this.inspectDraft(params);
        this.assertPreviewToken(params.previewToken, preview.previewToken);
        const draftsMailbox = state.mailboxes.find((mailbox) => mailbox.id === state.draftsMailboxId);
        if (!draftsMailbox) {
            throw new JmapMethodError("notFound", "JMAP drafts mailbox is not available");
        }
        const to = params.to === undefined
            ? preview.to
            : normalizeRecipientEmails(params.to, "to");
        const cc = params.cc === undefined
            ? preview.cc
            : normalizeRecipientEmails(params.cc, "cc");
        const explicitBcc = params.bcc === undefined
            ? preview.bcc
            : normalizeRecipientEmails(params.bcc, "bcc");
        const bcc = mergeAddresses(state.identityBcc, explicitBcc);
        const replyTo = mergeAddresses(state.identityReplyTo, preview.replyTo);
        const subject = params.subject === undefined ? preview.subject : params.subject.trim();
        const baseText = params.text === undefined ? preview.text : params.text;
        const text = params.text !== undefined && params.applyIdentitySignature === true
            ? appendTextSignature(baseText, state.identityTextSignature)
            : baseText;
        this.validateDraftContent({ to, cc, bcc, subject, text });
        const attachments = params.attachments === undefined
            ? preview.attachments.map((attachment) => {
                if (!attachment.blobId?.trim()) {
                    throw new JmapMethodError("unsupported", "Draft contains an attachment without a reusable blobId");
                }
                return compact({
                    blobId: attachment.blobId,
                    type: attachment.type,
                    name: attachment.name,
                    disposition: attachment.disposition,
                    cid: attachment.cid,
                    language: attachment.language,
                    location: attachment.location,
                });
            })
            : normalizeDraftAttachments(params.attachments);
        const bodyPartId = "body-1";
        const createResult = await this.callMethod("Email/set", {
            accountId: state.mailAccountId,
            ifInState: preview.state,
            create: {
                replaceDraft: compact({
                    mailboxIds: { [draftsMailbox.id]: true },
                    from: [
                        compact({
                            email: preview.identityEmail,
                            name: state.identityName,
                        }),
                    ],
                    to: to.length > 0 ? to : undefined,
                    cc: cc.length > 0 ? cc : undefined,
                    bcc: bcc.length > 0 ? bcc : undefined,
                    replyTo: replyTo.length > 0 ? replyTo : undefined,
                    subject,
                    textBody: [{ partId: bodyPartId, type: "text/plain" }],
                    bodyValues: { [bodyPartId]: { value: text } },
                    attachments: attachments.length > 0 ? attachments : undefined,
                    keywords: { $draft: true },
                    "header:Auto-Submitted:asText": "auto-generated",
                    "header:X-Auto-Response-Suppress:asText": "All",
                }),
            },
        });
        this.throwSetFailure(createResult.notCreated, "replaceDraft", "JMAP server rejected replacement draft");
        const created = createResult.created;
        const replacement = created?.replaceDraft;
        const replacementId = replacement?.id?.trim();
        if (!replacementId) {
            throw new Error("JMAP Email/set did not return replacement draft id");
        }
        const destroyResult = await this.callMethod("Email/set", {
            accountId: state.mailAccountId,
            ifInState: String(createResult.newState ?? "").trim() || undefined,
            destroy: [preview.emailId],
        });
        const destroyed = ensureArray(destroyResult.destroyed);
        if (!destroyed.includes(preview.emailId)) {
            const notDestroyed = destroyResult.notDestroyed;
            const failure = notDestroyed?.[preview.emailId];
            throw new JmapMethodError("draftReplaceIncomplete", `Replacement draft ${replacementId} was created, but original ${preview.emailId} was not removed: ${failure?.description?.trim() || failure?.type?.trim() || "unknown server response"}`);
        }
        return {
            previousEmailId: preview.emailId,
            emailId: replacementId,
            threadId: replacement?.threadId,
            size: replacement?.size,
            identityId: state.identityId,
            identityEmail: preview.identityEmail,
        };
    }
    async discardDraft(params) {
        const { preview, state } = await this.inspectDraft(params);
        this.assertPreviewToken(params.previewToken, preview.previewToken);
        const result = await this.callMethod("Email/set", {
            accountId: state.mailAccountId,
            ifInState: preview.state,
            destroy: [preview.emailId],
        });
        const destroyed = ensureArray(result.destroyed);
        if (!destroyed.includes(preview.emailId)) {
            this.throwSetFailure(result.notDestroyed, preview.emailId, "JMAP server rejected draft discard");
            throw new Error("JMAP Email/set did not confirm draft discard");
        }
        return { emailId: preview.emailId, discarded: true };
    }
    async submitDraft(params) {
        const { preview, state } = await this.inspectDraft(params);
        this.assertPreviewToken(params.previewToken, preview.previewToken);
        const recipients = mergeAddresses(preview.to, preview.cc, preview.bcc);
        if (recipients.length === 0) {
            throw new JmapMethodError("noRecipients", "Draft has no recipients");
        }
        let scheduled = false;
        let envelope;
        const requestedSendAt = params.sendAt?.trim();
        if (requestedSendAt) {
            const target = Date.parse(requestedSendAt);
            if (!Number.isFinite(target)) {
                throw new JmapMethodError("invalidArguments", "sendAt must be an RFC 3339 timestamp");
            }
            const delaySeconds = Math.ceil((target - Date.now()) / 1_000);
            if (delaySeconds <= 0) {
                throw new JmapMethodError("invalidArguments", "sendAt must be in the future");
            }
            if (state.maxDelayedSend <= 0 || delaySeconds > state.maxDelayedSend) {
                throw new JmapMethodError("unsupported", state.maxDelayedSend > 0
                    ? `Server supports at most ${state.maxDelayedSend} seconds of delayed send`
                    : "Server does not advertise delayed send support");
            }
            scheduled = true;
            envelope = {
                mailFrom: {
                    email: preview.identityEmail,
                    parameters: { HOLDFOR: String(delaySeconds) },
                },
                rcptTo: recipients.map((recipient) => ({
                    email: recipient.email,
                    parameters: null,
                })),
            };
        }
        const onSuccessUpdate = {
            "keywords/$draft": null,
        };
        if (state.draftsMailboxId) {
            onSuccessUpdate[`mailboxIds/${state.draftsMailboxId}`] = null;
        }
        if (state.sentMailboxId) {
            onSuccessUpdate[`mailboxIds/${state.sentMailboxId}`] = true;
        }
        const submissionSet = await this.callMethod("EmailSubmission/set", {
            accountId: state.submissionAccountId,
            create: {
                submitDraft: compact({
                    emailId: preview.emailId,
                    identityId: state.identityId,
                    envelope,
                }),
            },
            onSuccessUpdateEmail: {
                "#submitDraft": onSuccessUpdate,
            },
        });
        this.throwSetFailure(submissionSet.notCreated, "submitDraft", "JMAP server rejected draft submission");
        const created = submissionSet.created;
        const submissionId = created?.submitDraft?.id?.trim();
        if (!submissionId) {
            throw new Error("JMAP EmailSubmission/set did not return submission id");
        }
        let submission;
        try {
            submission = (await this.getSubmissions([submissionId]))[0];
        }
        catch {
            // Submission creation is the outbound boundary. A follow-up status
            // lookup must not turn an accepted send into an apparent retry-safe
            // failure.
            submission = undefined;
        }
        return {
            submissionId,
            emailId: preview.emailId,
            threadId: submission?.threadId ?? created?.submitDraft?.threadId ?? preview.threadId,
            sendAt: submission?.sendAt,
            undoStatus: submission?.undoStatus,
            scheduled,
            maxDelayedSend: state.maxDelayedSend,
            statusObserved: Boolean(submission),
        };
    }
    async getSubmissions(ids) {
        const validIds = ids.map((id) => id.trim()).filter(Boolean);
        if (validIds.length === 0) {
            return [];
        }
        const state = await this.ensureSubmissionIdentity();
        const result = await this.callMethod("EmailSubmission/get", {
            accountId: state.submissionAccountId,
            ids: validIds,
            properties: [
                "id",
                "identityId",
                "emailId",
                "threadId",
                "sendAt",
                "undoStatus",
                "deliveryStatus",
                "dsnBlobIds",
                "mdnBlobIds",
            ],
        });
        return ensureArray(result.list).filter((submission) => submission.id);
    }
    async querySubmissions(params) {
        const state = await this.ensureSubmissionIdentity();
        const position = Math.max(0, Math.trunc(params?.position ?? 0));
        const limit = Math.max(1, Math.min(100, Math.trunc(params?.limit ?? 20)));
        const filter = compact({
            identityIds: params?.identityId?.trim() ? [params.identityId.trim()] : undefined,
            emailIds: params?.emailId?.trim() ? [params.emailId.trim()] : undefined,
            threadIds: params?.threadId?.trim() ? [params.threadId.trim()] : undefined,
            undoStatus: params?.undoStatus?.trim() || undefined,
            after: params?.after?.trim() || undefined,
            before: params?.before?.trim() || undefined,
        });
        const query = await this.callMethod("EmailSubmission/query", {
            accountId: state.submissionAccountId,
            filter,
            position,
            limit,
            calculateTotal: true,
        });
        const ids = ensureArray(query.ids).map((id) => id.trim()).filter(Boolean);
        const submissions = await this.getSubmissions(ids);
        const byId = new Map(submissions.map((submission) => [submission.id, submission]));
        const ordered = ids
            .map((id) => byId.get(id))
            .filter((submission) => Boolean(submission));
        const total = typeof query.total === "number" ? query.total : undefined;
        return {
            submissions: ordered,
            queryState: String(query.queryState ?? "").trim(),
            position,
            total,
            nextPosition: ordered.length === limit && (total === undefined || position + ordered.length < total)
                ? position + ordered.length
                : undefined,
        };
    }
    async cancelSubmission(submissionId) {
        const normalizedId = submissionId.trim();
        const current = (await this.getSubmissions([normalizedId]))[0];
        if (!current) {
            throw new JmapMethodError("notFound", `JMAP submission not found: ${normalizedId}`);
        }
        if (current.undoStatus !== "pending") {
            throw new JmapMethodError("cannotUnsend", `Submission cannot be canceled from undoStatus=${current.undoStatus ?? "unknown"}`);
        }
        const state = await this.ensureSubmissionIdentity();
        const result = await this.callMethod("EmailSubmission/set", {
            accountId: state.submissionAccountId,
            update: {
                [normalizedId]: {
                    undoStatus: "canceled",
                },
            },
        });
        this.throwSetFailure(result.notUpdated, normalizedId, "JMAP server rejected submission cancellation");
        const canceled = (await this.getSubmissions([normalizedId]))[0];
        if (!canceled || canceled.undoStatus !== "canceled") {
            throw new JmapMethodError("cannotUnsend", "JMAP server did not confirm submission cancellation");
        }
        return canceled;
    }
    async getSearchSnippets(emailIds, filter) {
        const ids = emailIds.map((id) => id.trim()).filter(Boolean);
        if (ids.length === 0 || ids.length > 100) {
            throw new JmapMethodError("invalidArguments", "SearchSnippet/get requires between 1 and 100 email ids");
        }
        const result = await this.callMethod("SearchSnippet/get", {
            accountId: this.state.mailAccountId,
            filter,
            emailIds: ids,
        });
        return {
            snippets: ensureArray(result.list).filter((snippet) => Boolean(snippet.emailId)),
            notFound: ensureArray(result.notFound),
        };
    }
    async getChanges(dataType, sinceState, maxChanges = 100) {
        const supportedTypes = [
            "Mailbox",
            "Thread",
            "Email",
            "Identity",
            "EmailSubmission",
        ];
        if (!supportedTypes.includes(dataType)) {
            throw new JmapMethodError("invalidArguments", `Unsupported changes type: ${dataType}`);
        }
        const normalizedState = sinceState.trim();
        if (!normalizedState) {
            throw new JmapMethodError("invalidArguments", "sinceState is required");
        }
        const boundedMaxChanges = Math.max(1, Math.min(1_000, Math.trunc(maxChanges)));
        const submissionType = dataType === "Identity" || dataType === "EmailSubmission";
        const accountId = submissionType
            ? this.state.submissionAccountId
            : this.state.mailAccountId;
        if (!accountId) {
            throw new JmapMethodError("accountNotFound", `JMAP Submission capability is required for ${dataType}/changes`);
        }
        const result = await this.callMethod(`${dataType}/changes`, {
            accountId,
            sinceState: normalizedState,
            maxChanges: boundedMaxChanges,
        });
        const oldState = String(result.oldState ?? "").trim();
        const newState = String(result.newState ?? "").trim();
        if (!oldState || !newState) {
            throw new Error(`JMAP ${dataType}/changes did not return state tokens`);
        }
        return {
            dataType,
            oldState,
            newState,
            hasMoreChanges: result.hasMoreChanges === true,
            created: ensureArray(result.created).map(String),
            updated: ensureArray(result.updated).map(String),
            destroyed: ensureArray(result.destroyed).map(String),
        };
    }
    async parseEmails(blobIds, options) {
        const ids = blobIds.map((id) => id.trim()).filter(Boolean);
        if (ids.length === 0 || ids.length > 100) {
            throw new JmapMethodError("invalidArguments", "Email/parse requires between 1 and 100 blob ids");
        }
        const maxBodyValueBytes = Math.max(1, Math.min(MAX_DRAFT_TEXT_BYTES, Math.trunc(options?.maxBodyValueBytes ?? DEFAULT_MAX_BODY_BYTES)));
        const result = await this.callMethod("Email/parse", {
            accountId: this.state.mailAccountId,
            blobIds: ids,
            properties: [
                "id",
                "blobId",
                "threadId",
                "from",
                "to",
                "cc",
                "bcc",
                "replyTo",
                "subject",
                "receivedAt",
                "sentAt",
                "messageId",
                "inReplyTo",
                "references",
                "textBody",
                "htmlBody",
                "bodyValues",
                "attachments",
                "hasAttachment",
                "size",
                ...SAFETY_HEADER_PROPERTIES,
            ],
            fetchTextBodyValues: true,
            fetchHTMLBodyValues: true,
            maxBodyValueBytes,
        });
        const rawParsed = result.parsed && typeof result.parsed === "object" && !Array.isArray(result.parsed)
            ? result.parsed
            : {};
        const parsed = Object.fromEntries(Object.entries(rawParsed)
            .filter((entry) => Boolean(entry[1]) && typeof entry[1] === "object" && !Array.isArray(entry[1]))
            .map(([blobId, email]) => [blobId, email]));
        return {
            parsed,
            notParsable: ensureArray(result.notParsable),
            notFound: ensureArray(result.notFound),
        };
    }
    async uploadBlob(params) {
        const state = this.state;
        if (!state.uploadUrl) {
            throw new JmapMethodError("unsupported", "JMAP Session does not advertise an uploadUrl");
        }
        if (params.data.byteLength === 0) {
            throw new JmapMethodError("invalidArguments", "Upload data must not be empty");
        }
        if (params.data.byteLength > state.maxSizeUpload) {
            throw new JmapMethodError("tooLarge", `Upload exceeds the server's ${state.maxSizeUpload}-byte limit`);
        }
        const type = params.type.trim() || "application/octet-stream";
        const uploadUrl = state.uploadUrl.replaceAll("{accountId}", encodeURIComponent(state.mailAccountId));
        if (/\{[^}]+\}/.test(uploadUrl)) {
            throw new JmapMethodError("unsupported", "JMAP uploadUrl contains an unsupported URI template");
        }
        const response = await fetch(uploadUrl, {
            method: "POST",
            headers: {
                Authorization: this.authorizationHeader,
                "Content-Type": type,
                Accept: "application/json",
            },
            body: Buffer.from(params.data),
        });
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new Error(`JMAP upload failed (${response.status}): ${body || response.statusText}`);
        }
        const result = (await response.json());
        const blobId = result.blobId?.trim();
        if (!blobId) {
            throw new Error("JMAP upload response did not contain blobId");
        }
        return {
            accountId: result.accountId?.trim() || state.mailAccountId,
            blobId,
            type: result.type?.trim() || type,
            size: typeof result.size === "number" && Number.isFinite(result.size)
                ? Math.max(0, Math.trunc(result.size))
                : params.data.byteLength,
        };
    }
    async importEmails(params) {
        const ids = [...new Set(params.blobIds.map((id) => id.trim()).filter(Boolean))];
        if (ids.length === 0 || ids.length > 100) {
            throw new JmapMethodError("invalidArguments", "Email/import requires between 1 and 100 blob ids");
        }
        const destination = this.resolveMailbox(params.destination);
        if (!destination) {
            throw new JmapMethodError("invalidArguments", "Email/import requires one mailbox");
        }
        if (destination.myRights?.mayAddItems === false) {
            throw new JmapMethodError("forbidden", `JMAP account does not permit importing into mailbox ${destination.id}`);
        }
        const keywords = Object.fromEntries([...new Set(params.keywords?.map((keyword) => keyword.trim()).filter(Boolean) ?? [])]
            .map((keyword) => [keyword, true]));
        const emails = Object.fromEntries(ids.map((blobId, index) => [
            `import-${index}`,
            {
                blobId,
                mailboxIds: { [destination.id]: true },
                keywords,
            },
        ]));
        const result = await this.callMethod("Email/import", {
            accountId: this.state.mailAccountId,
            ifInState: params.ifInState?.trim() || undefined,
            emails,
        });
        return {
            created: result.created ?? {},
            notCreated: result.notCreated ?? {},
        };
    }
    async copyEmails(params) {
        const emailIds = [...new Set(params.emailIds.map((id) => id.trim()).filter(Boolean))];
        const destinationMailboxIds = [
            ...new Set(params.destinationMailboxIds.map((id) => id.trim()).filter(Boolean)),
        ];
        const toAccountId = params.toAccountId.trim();
        if (emailIds.length === 0 || emailIds.length > 100) {
            throw new JmapMethodError("invalidArguments", "Email/copy requires between 1 and 100 email ids");
        }
        if (!toAccountId || toAccountId === this.state.mailAccountId) {
            throw new JmapMethodError("invalidArguments", "Email/copy requires a different destination account id");
        }
        if (destinationMailboxIds.length === 0 || destinationMailboxIds.length > 100) {
            throw new JmapMethodError("invalidArguments", "Email/copy requires between 1 and 100 destination mailbox ids");
        }
        const keywords = params.keywords === undefined
            ? undefined
            : Object.fromEntries([...new Set(params.keywords.map((keyword) => keyword.trim()).filter(Boolean))]
                .map((keyword) => [keyword, true]));
        const create = Object.fromEntries(emailIds.map((id, index) => [
            `copy-${index}`,
            compact({
                id,
                mailboxIds: Object.fromEntries(destinationMailboxIds.map((mailboxId) => [mailboxId, true])),
                keywords,
            }),
        ]));
        const result = await this.callMethod("Email/copy", {
            fromAccountId: this.state.mailAccountId,
            accountId: toAccountId,
            ifFromInState: params.ifFromInState?.trim() || undefined,
            ifInState: params.ifInState?.trim() || undefined,
            create,
            onSuccessDestroyOriginal: false,
        });
        return {
            fromAccountId: this.state.mailAccountId,
            accountId: toAccountId,
            created: result.created ?? {},
            notCreated: result.notCreated ?? {},
        };
    }
    async sendEmailInternal(params) {
        const state = await this.ensureSubmissionIdentity();
        const bodyPartId = "body-1";
        const mailboxIds = {};
        if (state.draftsMailboxId) {
            mailboxIds[state.draftsMailboxId] = true;
        }
        else if (state.sentMailboxId) {
            mailboxIds[state.sentMailboxId] = true;
        }
        else if (state.inboxMailboxId) {
            mailboxIds[state.inboxMailboxId] = true;
        }
        const createEmail = compact({
            mailboxIds,
            from: [
                compact({
                    email: state.identityEmail,
                    name: state.identityName,
                }),
            ],
            to: params.to,
            cc: params.cc.length > 0 ? params.cc : undefined,
            subject: params.subject,
            textBody: [{ partId: bodyPartId, type: "text/plain" }],
            bodyValues: {
                [bodyPartId]: {
                    value: params.bodyText,
                },
            },
            keywords: {
                $draft: true,
            },
            "header:Auto-Submitted:asText": "auto-generated",
            "header:X-Auto-Response-Suppress:asText": "All",
            inReplyTo: params.inReplyTo ? [params.inReplyTo] : undefined,
            references: params.references.length > 0 ? params.references : undefined,
        });
        const emailSet = await this.callMethod("Email/set", {
            accountId: params.accountId,
            create: {
                createEmail,
            },
        });
        const created = emailSet.created;
        const createdEmail = created?.createEmail;
        const emailId = createdEmail?.id?.trim();
        if (!emailId) {
            throw new Error("JMAP Email/set did not return created email id");
        }
        const onSuccessUpdate = {
            "keywords/$draft": null,
        };
        if (state.draftsMailboxId) {
            onSuccessUpdate[`mailboxIds/${state.draftsMailboxId}`] = null;
        }
        if (state.sentMailboxId) {
            onSuccessUpdate[`mailboxIds/${state.sentMailboxId}`] = true;
        }
        const submissionSet = await this.callMethod("EmailSubmission/set", {
            accountId: state.submissionAccountId,
            create: {
                submitEmail: {
                    emailId,
                    identityId: state.identityId,
                },
            },
            onSuccessUpdateEmail: {
                "#submitEmail": onSuccessUpdate,
            },
        });
        const submissionCreated = submissionSet.created;
        const submissionId = submissionCreated?.submitEmail?.id?.trim();
        if (!submissionId) {
            throw new Error("JMAP EmailSubmission/set did not return submission id");
        }
        return {
            messageId: emailId,
            threadId: params.threadId || createdEmail?.threadId,
        };
    }
    async fetchSession() {
        const response = await fetch(this.sessionUrl, {
            method: "GET",
            headers: {
                Authorization: this.authorizationHeader,
                Accept: "application/json",
            },
        });
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new Error(`JMAP session fetch failed (${response.status}): ${body || response.statusText}`);
        }
        const json = (await response.json());
        const sessionResponseUrl = response.url || this.sessionUrl;
        const apiUrl = resolveSessionUrl(json.apiUrl, sessionResponseUrl);
        if (!apiUrl) {
            throw new Error("JMAP session response missing apiUrl");
        }
        return {
            ...json,
            apiUrl,
            downloadUrl: resolveSessionUrl(json.downloadUrl, sessionResponseUrl),
            uploadUrl: resolveSessionUrl(json.uploadUrl, sessionResponseUrl),
            eventSourceUrl: resolveSessionUrl(json.eventSourceUrl, sessionResponseUrl),
        };
    }
    resolveMailAccountId(session) {
        const preferred = this.accountIdHint?.trim();
        if (preferred && session.accounts?.[preferred]) {
            return preferred;
        }
        const primary = session.primaryAccounts?.[JMAP_MAIL]?.trim();
        if (primary) {
            return primary;
        }
        const accounts = session.accounts ?? {};
        for (const [accountId, info] of Object.entries(accounts)) {
            if ((info.accountCapabilities ?? {})[JMAP_MAIL]) {
                return accountId;
            }
        }
        const first = Object.keys(accounts)[0]?.trim();
        if (first) {
            return first;
        }
        throw new Error("JMAP session has no mail account");
    }
    resolveSubmissionAccountId(session) {
        const primary = session.primaryAccounts?.[JMAP_SUBMISSION]?.trim();
        if (primary && accountCapabilitiesFor(session, primary).includes(JMAP_SUBMISSION)) {
            return primary;
        }
        const preferred = this.accountIdHint?.trim();
        if (preferred &&
            accountCapabilitiesFor(session, preferred).includes(JMAP_SUBMISSION)) {
            return preferred;
        }
        for (const accountId of Object.keys(session.accounts ?? {})) {
            if (accountCapabilitiesFor(session, accountId).includes(JMAP_SUBMISSION)) {
                return accountId;
            }
        }
        return undefined;
    }
    async getMailboxes(apiUrl, accountId) {
        const result = await this.callApi(apiUrl, [
            [
                "Mailbox/get",
                {
                    accountId,
                    ids: null,
                    properties: [
                        "id",
                        "name",
                        "parentId",
                        "role",
                        "sortOrder",
                        "totalEmails",
                        "unreadEmails",
                        "totalThreads",
                        "unreadThreads",
                        "myRights",
                        "isSubscribed",
                    ],
                },
                "mailbox-get",
            ],
        ]);
        const payload = this.pickMethod(result, "Mailbox/get", "mailbox-get");
        return ensureArray(payload.list).filter((box) => box.id);
    }
    async getIdentities(apiUrl, accountId) {
        const result = await this.callApi(apiUrl, [
            [
                "Identity/get",
                {
                    accountId,
                    ids: null,
                    // Request only RFC 8621 properties. Some servers reject extension
                    // properties such as isDefault even though they otherwise support Identity/get.
                    properties: [
                        "id",
                        "email",
                        "name",
                        "replyTo",
                        "bcc",
                        "textSignature",
                        "htmlSignature",
                        "mayDelete",
                    ],
                },
                "identity-get",
            ],
        ]);
        const payload = this.pickMethod(result, "Identity/get", "identity-get");
        return ensureArray(payload.list).filter((identity) => identity.id);
    }
    async callMethod(methodName, args) {
        const state = this.state;
        const callId = `${methodName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-0`;
        const result = await this.callApi(state.apiUrl, [[methodName, args, callId]]);
        return this.pickMethod(result, methodName, callId);
    }
    async callApi(apiUrl, methodCalls) {
        const using = new Set([JMAP_CORE]);
        for (const [methodName] of methodCalls) {
            if (methodName.startsWith("Mailbox/") ||
                methodName.startsWith("Email/") ||
                methodName.startsWith("Thread/") ||
                methodName.startsWith("SearchSnippet/")) {
                using.add(JMAP_MAIL);
            }
            if (methodName.startsWith("Identity/") ||
                methodName.startsWith("EmailSubmission/") ||
                methodName.startsWith("VacationResponse/")) {
                using.add(JMAP_SUBMISSION);
            }
            if (methodName.startsWith("EmailSubmission/")) {
                using.add(JMAP_MAIL);
            }
        }
        const response = await fetch(apiUrl, {
            method: "POST",
            headers: {
                Authorization: this.authorizationHeader,
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify({
                using: [...using],
                methodCalls,
            }),
        });
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new Error(`JMAP API request failed (${response.status}): ${body || response.statusText}`);
        }
        const json = (await response.json());
        if (!Array.isArray(json.methodResponses)) {
            throw new Error("JMAP API response missing methodResponses");
        }
        return json;
    }
    async ensureSubmissionIdentity(identityId) {
        const state = this.state;
        if (!state.submissionAccountId) {
            throw new JmapMethodError("accountNotFound", "JMAP Submission capability is not available for this account");
        }
        const requestedIdentityId = identityId?.trim();
        if (state.identityId &&
            state.identityEmail &&
            (!requestedIdentityId || state.identityId === requestedIdentityId)) {
            return state;
        }
        const identities = await this.getIdentities(state.apiUrl, state.submissionAccountId);
        const identity = requestedIdentityId
            ? identities.find((candidate) => candidate.id === requestedIdentityId) ?? null
            : pickIdentity(identities, state.username);
        const identityEmail = normalizeEmailAddress(identity?.email);
        if (!identity?.id || !identityEmail) {
            throw new JmapMethodError("accountNotFound", requestedIdentityId
                ? `JMAP identity not found: ${requestedIdentityId}`
                : "JMAP identity not found for sending emails");
        }
        const next = {
            ...state,
            identityId: identity.id,
            identityEmail,
            identityName: identity.name?.trim() || undefined,
            identityReplyTo: identity.replyTo,
            identityBcc: identity.bcc,
            identityTextSignature: identity.textSignature,
            identityHtmlSignature: identity.htmlSignature,
            selfEmails: normalizeIdentityEmails(identity, state.username),
        };
        if (!requestedIdentityId) {
            this.initState = next;
        }
        return next;
    }
    validateDraftContent(params) {
        if (params.to.length + params.cc.length + params.bcc.length > MAX_DRAFT_RECIPIENTS) {
            throw new JmapMethodError("invalidArguments", `Draft recipients exceed the ${MAX_DRAFT_RECIPIENTS}-address limit`);
        }
        if (utf8ByteLength(params.subject) > MAX_DRAFT_SUBJECT_BYTES) {
            throw new JmapMethodError("invalidArguments", `Draft subject exceeds the ${MAX_DRAFT_SUBJECT_BYTES}-byte limit`);
        }
        if (utf8ByteLength(params.text) > MAX_DRAFT_TEXT_BYTES) {
            throw new JmapMethodError("invalidArguments", `Draft body exceeds the ${MAX_DRAFT_TEXT_BYTES}-byte limit`);
        }
        if (params.to.length === 0 &&
            params.cc.length === 0 &&
            params.bcc.length === 0 &&
            !params.subject &&
            !params.text.trim()) {
            throw new JmapMethodError("invalidArguments", "Refusing to create an entirely empty draft");
        }
    }
    async inspectDraft(params) {
        const emailId = params.emailId.trim();
        if (!emailId) {
            throw new JmapMethodError("invalidArguments", "Draft email id is required");
        }
        const { state, fromEmail } = await this.resolveCompositionIdentity(params.identityId, params.fromEmail);
        const result = await this.callMethod("Email/get", {
            accountId: state.mailAccountId,
            ids: [emailId],
            properties: [
                "id",
                "blobId",
                "threadId",
                "mailboxIds",
                "keywords",
                "from",
                "to",
                "cc",
                "bcc",
                "replyTo",
                "subject",
                "textBody",
                "htmlBody",
                "bodyValues",
                "attachments",
                "size",
            ],
            fetchTextBodyValues: true,
            fetchHTMLBodyValues: true,
            maxBodyValueBytes: MAX_DRAFT_TEXT_BYTES,
        });
        const email = ensureArray(result.list).find((item) => item.id === emailId);
        if (!email) {
            throw new JmapMethodError("notFound", `JMAP draft not found: ${emailId}`);
        }
        if (email.keywords?.$draft !== true) {
            throw new JmapMethodError("notADraft", `JMAP email is not marked as a draft: ${emailId}`);
        }
        if (Object.values(email.bodyValues ?? {}).some((bodyValue) => bodyValue.isTruncated === true)) {
            throw new JmapMethodError("tooLarge", "Draft body exceeds the exact-preview limit and cannot be submitted safely");
        }
        const from = canonicalDraftAddresses(email.from, "from");
        if (from.length !== 1 || from[0]?.email !== fromEmail) {
            throw new JmapMethodError("forbiddenFrom", `Draft From address does not match identity ${state.identityId}`);
        }
        const text = extractExactDraftText(email);
        const stateToken = String(result.state ?? "").trim();
        if (!stateToken) {
            throw new Error("JMAP Email/get did not return a state token");
        }
        const preview = {
            emailId,
            blobId: email.blobId,
            threadId: email.threadId,
            state: stateToken,
            previewToken: draftToken({
                email,
                identityId: state.identityId,
                identityEmail: fromEmail,
                text,
            }),
            identityId: state.identityId,
            identityEmail: fromEmail,
            from,
            to: canonicalDraftAddresses(email.to, "to"),
            cc: canonicalDraftAddresses(email.cc, "cc"),
            bcc: canonicalDraftAddresses(email.bcc, "bcc"),
            replyTo: canonicalDraftAddresses(email.replyTo, "replyTo"),
            subject: email.subject ?? "",
            text,
            attachments: ensureArray(email.attachments).map((attachment) => ({ ...attachment })),
            size: email.size,
        };
        return { preview, state };
    }
    assertPreviewToken(provided, expected) {
        if (!provided.trim() || provided.trim() !== expected) {
            throw new JmapMethodError("stalePreview", "Draft changed or was not previewed; obtain a fresh preview before continuing");
        }
    }
    throwSetFailure(rawFailures, id, fallbackMessage) {
        const failures = rawFailures;
        const failure = failures?.[id];
        if (!failure) {
            return;
        }
        throw new JmapMethodError(failure.type?.trim() || "setError", failure.description?.trim() || fallbackMessage);
    }
    async resolveCompositionIdentity(identityId, requestedFromEmail) {
        const state = await this.ensureSubmissionIdentity(identityId);
        const identityEmail = normalizeEmailAddress(state.identityEmail);
        const fromEmail = normalizeEmailAddress(requestedFromEmail);
        if (identityEmail.startsWith("*@")) {
            const domain = identityEmail.slice(2);
            if (!fromEmail ||
                !looksLikeEmailAddress(fromEmail) ||
                fromEmail.startsWith("*@") ||
                !fromEmail.endsWith(`@${domain}`)) {
                throw new JmapMethodError("invalidArguments", `Identity ${state.identityId} requires a concrete From address in @${domain}`);
            }
            return { state, fromEmail };
        }
        if (fromEmail && fromEmail !== identityEmail) {
            throw new JmapMethodError("forbiddenFrom", `Identity ${state.identityId} does not permit From address ${fromEmail}`);
        }
        if (!looksLikeEmailAddress(identityEmail)) {
            throw new JmapMethodError("invalidArguments", `Identity ${state.identityId} does not contain a valid email address`);
        }
        return { state, fromEmail: identityEmail };
    }
    pickMethod(response, expectedMethod, callId) {
        const matched = ensureArray(response.methodResponses).find((entry) => entry[2] === callId);
        if (!matched) {
            throw new Error(`JMAP response missing method result for ${expectedMethod} (${callId})`);
        }
        const [methodName, payload] = matched;
        if (methodName === "error") {
            const errorType = typeof payload.type === "string" ? payload.type : "unknown";
            const description = typeof payload.description === "string" ? payload.description : "";
            throw new JmapMethodError(errorType, `JMAP ${expectedMethod} failed: ${description || errorType}`);
        }
        if (methodName !== expectedMethod) {
            throw new Error(`Unexpected JMAP method response: expected ${expectedMethod}, got ${methodName}`);
        }
        return payload;
    }
}
export { parseInboundEmail } from "./jmap-email.js";
//# sourceMappingURL=jmap-client.js.map