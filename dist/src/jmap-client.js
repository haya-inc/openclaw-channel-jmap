import { buildThreadContextFromEmail, compact, ensureArray, extractTextFromEmail, formatReplySubject, normalizeIdentityEmails, parseTimestampMs, pickIdentity, } from "./jmap-email.js";
import { normalizeEmailAddress } from "./normalize.js";
import { JMAP_CORE, JMAP_MAIL, JMAP_SUBMISSION } from "./types.js";
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
        this.initState = {
            apiUrl: session.apiUrl,
            downloadUrl: session.downloadUrl?.trim() || undefined,
            uploadUrl: session.uploadUrl?.trim() || undefined,
            eventSourceUrl: session.eventSourceUrl?.trim() || undefined,
            capabilities,
            mailAccountCapabilities,
            submissionAccountCapabilities,
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
    async getEmails(ids) {
        if (ids.length === 0) {
            return [];
        }
        const state = this.state;
        const result = await this.callMethod("Email/get", {
            accountId: state.mailAccountId,
            ids,
            properties: [
                "id",
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
                "bodyValues",
                "keywords",
                "size",
                "header:Auto-Submitted:asText",
                "header:Precedence:asText",
                "header:List-Id:asText",
            ],
            fetchTextBodyValues: true,
            fetchHTMLBodyValues: false,
        });
        return ensureArray(result.list).filter((item) => item.id);
    }
    async searchEmails(params = {}) {
        const state = this.state;
        const limit = Math.max(1, Math.min(100, Math.trunc(params.limit ?? 20)));
        const filter = compact({
            inMailbox: state.inboxMailboxId,
            text: params.text?.trim() || undefined,
            from: params.from?.trim() || undefined,
            to: params.to?.trim() || undefined,
            subject: params.subject?.trim() || undefined,
            after: params.after?.trim() || undefined,
            before: params.before?.trim() || undefined,
            hasKeyword: params.unread === false ? "$seen" : undefined,
            notKeyword: params.unread === true ? "$seen" : undefined,
        });
        const result = await this.callMethod("Email/query", {
            accountId: state.mailAccountId,
            filter,
            sort: [{ property: "receivedAt", isAscending: false }],
            calculateTotal: false,
            position: 0,
            limit,
        });
        const ids = ensureArray(result.ids)
            .map((id) => id.trim())
            .filter(Boolean);
        const emails = await this.getEmails(ids);
        const byId = new Map(emails.map((email) => [email.id, email]));
        return ids.map((id) => byId.get(id)).filter((email) => Boolean(email));
    }
    async getThreadEmails(threadId) {
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
            return [];
        }
        const emails = await this.getEmails(ensureArray(thread.emailIds));
        return emails.sort((a, b) => parseTimestampMs(a) - parseTimestampMs(b));
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
        await this.callMethod("Email/set", {
            accountId: this.state.mailAccountId,
            update: Object.fromEntries(validIds.map((id) => [id, patch])),
        });
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
                    properties: ["id", "role", "name", "myRights"],
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
                    // Keep this list provider-compatible; some servers reject optional fields like isDefault.
                    properties: ["id", "email", "name", "replyTo", "bcc"],
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
    async ensureSubmissionIdentity() {
        const state = this.state;
        if (!state.submissionAccountId) {
            throw new JmapMethodError("accountNotFound", "JMAP Submission capability is not available for this account");
        }
        if (state.identityId && state.identityEmail) {
            return state;
        }
        const identity = pickIdentity(await this.getIdentities(state.apiUrl, state.submissionAccountId), state.username);
        const identityEmail = normalizeEmailAddress(identity?.email);
        if (!identity?.id || !identityEmail) {
            throw new JmapMethodError("accountNotFound", "JMAP identity not found for sending emails");
        }
        const next = {
            ...state,
            identityId: identity.id,
            identityEmail,
            identityName: identity.name?.trim() || undefined,
            selfEmails: normalizeIdentityEmails(identity, state.username),
        };
        this.initState = next;
        return next;
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