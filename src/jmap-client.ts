import type {
  JmapDraftCreateResult,
  JmapEmail,
  JmapEmailAddress,
  JmapIdentity,
  JmapMailbox,
  JmapMoveResult,
  JmapQueryChangesResult,
  JmapSearchParams,
  JmapSearchPage,
  JmapSendResult,
  JmapThreadContext,
  JmapThreadPage,
} from "./types.js";
import {
  buildThreadContextFromEmail,
  compact,
  ensureArray,
  extractTextFromEmail,
  formatReplySubject,
  normalizeIdentityEmails,
  parseTimestampMs,
  pickIdentity,
} from "./jmap-email.js";
import { looksLikeEmailAddress, normalizeEmailAddress } from "./normalize.js";
import {
  DEFAULT_MAX_BODY_BYTES,
  JMAP_CORE,
  JMAP_MAIL,
  JMAP_SUBMISSION,
} from "./types.js";

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
] as const;

type JmapMethodCallArgs = Record<string, unknown>;
type JmapMethodCall = [string, JmapMethodCallArgs, string];
type JmapMethodResponse = [string, Record<string, unknown>, string];

type JmapApiResponse = {
  methodResponses?: JmapMethodResponse[];
  sessionState?: string;
};

type JmapAccountInfo = {
  accountCapabilities?: Record<string, unknown> | null;
};

type JmapSessionResponse = {
  apiUrl?: string;
  downloadUrl?: string;
  uploadUrl?: string;
  eventSourceUrl?: string;
  capabilities?: Record<string, unknown>;
  username?: string;
  primaryAccounts?: Record<string, string>;
  accounts?: Record<string, JmapAccountInfo>;
};

function resolveSessionUrl(value: string | undefined, baseUrl: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const templates: string[] = [];
  const masked = trimmed.replace(/\{[^}]+\}/g, (template) => {
    const marker = `__OPENCLAW_JMAP_TEMPLATE_${templates.length}__`;
    templates.push(template);
    return marker;
  });
  const resolved = new URL(masked, baseUrl).toString();

  return templates.reduce(
    (url, template, index) =>
      url.replace(`__OPENCLAW_JMAP_TEMPLATE_${index}__`, template),
    resolved,
  );
}

function accountCapabilitiesFor(session: JmapSessionResponse, accountId: string): string[] {
  const explicit = Object.keys(
    session.accounts?.[accountId]?.accountCapabilities ?? {},
  );
  const primary = Object.entries(session.primaryAccounts ?? {})
    .filter(
      ([capability, primaryAccountId]) =>
        primaryAccountId === accountId &&
        Boolean((session.capabilities ?? {})[capability]),
    )
    .map(([capability]) => capability);
  return [...new Set([...explicit, ...primary])];
}

function normalizeSubjectForComparison(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").toLocaleLowerCase();
}

function subjectFallbackToken(subject: string): string | undefined {
  const tokens = subject.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens
    .filter((token) => token.length >= 2)
    .sort((left, right) => right.length - left.length)[0]
    ?.slice(0, 64);
}

function normalizeRecipientEmails(values: string[] | undefined, field: string): JmapEmailAddress[] {
  const recipients: JmapEmailAddress[] = [];
  const seen = new Set<string>();
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

function mergeAddresses(...lists: Array<JmapEmailAddress[] | undefined>): JmapEmailAddress[] {
  const addresses: JmapEmailAddress[] = [];
  const seen = new Set<string>();
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
const MAX_DRAFT_SUBJECT_BYTES = 998;
const MAX_DRAFT_TEXT_BYTES = 1_000_000;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export type JmapClientInit = {
  apiUrl: string;
  downloadUrl?: string;
  uploadUrl?: string;
  eventSourceUrl?: string;
  capabilities: string[];
  mailAccountCapabilities: string[];
  submissionAccountCapabilities: string[];
  username?: string;
  mailAccountId: string;
  submissionAccountId?: string;
  inboxMailboxId?: string;
  sentMailboxId?: string;
  draftsMailboxId?: string;
  mailboxes: JmapMailbox[];
  identityId?: string;
  identityEmail?: string;
  identityName?: string;
  identityReplyTo?: JmapEmailAddress[];
  identityBcc?: JmapEmailAddress[];
  selfEmails: Set<string>;
};

export type JmapMetadataProbe = {
  sampleEmailFound: boolean;
  emailGetVerified: boolean;
  threadGetVerified: boolean;
  threadAvailable: boolean;
};

type JmapSubmissionReadyState = JmapClientInit &
  Required<Pick<JmapClientInit, "submissionAccountId" | "identityId" | "identityEmail">>;

export class JmapMethodError extends Error {
  readonly type: string;

  constructor(type: string, message: string) {
    super(message);
    this.type = type;
  }
}

export class JmapClient {
  private readonly sessionUrl: string;
  private readonly token: string;
  private readonly authMode: "bearer" | "basic";
  private readonly username: string;
  private readonly accountIdHint?: string;
  private initState: JmapClientInit | null = null;

  constructor(params: {
    sessionUrl: string;
    token: string;
    authMode?: "bearer" | "basic";
    username?: string;
    accountIdHint?: string;
  }) {
    this.sessionUrl = params.sessionUrl;
    this.token = params.token;
    this.authMode = params.authMode ?? "bearer";
    this.username = params.username?.trim() ?? "";
    this.accountIdHint = params.accountIdHint;
  }

  private get authorizationHeader(): string {
    if (this.authMode === "basic") {
      return `Basic ${Buffer.from(`${this.username}:${this.token}`, "utf8").toString("base64")}`;
    }
    return `Bearer ${this.token}`;
  }

  get isReady(): boolean {
    return this.initState !== null;
  }

  get state(): JmapClientInit {
    if (!this.initState) {
      throw new Error("JMAP client is not initialized");
    }
    return this.initState;
  }

  async init(): Promise<JmapClientInit> {
    if (this.initState) {
      return this.initState;
    }
    const session = await this.fetchSession();
    const mailAccountId = this.resolveMailAccountId(session);
    const submissionAccountId = this.resolveSubmissionAccountId(session);
    const mailboxes = await this.getMailboxes(session.apiUrl, mailAccountId);

    let identity: JmapIdentity | null = null;
    if (submissionAccountId) {
      try {
        identity = pickIdentity(
          await this.getIdentities(session.apiUrl, submissionAccountId),
          session.username,
        );
      } catch {
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
      identityReplyTo: identity?.replyTo,
      identityBcc: identity?.bcc,
      selfEmails: normalizeIdentityEmails(identity, session.username),
    };
    return this.initState;
  }

  async queryInboxState(): Promise<string> {
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

  async queryRecentInboxIds(params?: { limit?: number; position?: number }): Promise<string[]> {
    const state = this.state;
    const limit =
      typeof params?.limit === "number" && Number.isFinite(params.limit) && params.limit > 0
        ? Math.trunc(params.limit)
        : 50;
    const position =
      typeof params?.position === "number" && Number.isFinite(params.position) && params.position >= 0
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

    return ensureArray(result.ids as string[])
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  async queryUnreadInboxIds(params?: { limit?: number; position?: number }): Promise<string[]> {
    const state = this.state;
    const limit =
      typeof params?.limit === "number" && Number.isFinite(params.limit) && params.limit > 0
        ? Math.trunc(params.limit)
        : 50;
    const position =
      typeof params?.position === "number" && Number.isFinite(params.position) && params.position >= 0
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

    return ensureArray(result.ids as string[])
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  async queryInboxChanges(sinceQueryState: string): Promise<JmapQueryChangesResult> {
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
      removed: ensureArray(result.removed as string[]),
      added: ensureArray(result.added as Array<{ id: string; index: number }>),
      hasMoreChanges: Boolean(result.hasMoreChanges),
      upToId: typeof result.upToId === "string" ? result.upToId : undefined,
      total: typeof result.total === "number" ? result.total : undefined,
    };
  }

  listMailboxes(): JmapMailbox[] {
    return this.state.mailboxes
      .map((mailbox) => ({ ...mailbox, myRights: mailbox.myRights ? { ...mailbox.myRights } : undefined }))
      .sort((left, right) => {
        const order = (left.sortOrder ?? 0) - (right.sortOrder ?? 0);
        return order || (left.name ?? "").localeCompare(right.name ?? "");
      });
  }

  resolveMailbox(reference?: string | null): JmapMailbox | undefined {
    const raw = reference?.trim() || "inbox";
    if (raw.toLowerCase() === "all") {
      return undefined;
    }
    const normalized = raw.toLocaleLowerCase();
    const mailbox = this.state.mailboxes.find(
      (candidate) =>
        candidate.id === raw ||
        candidate.role?.toLocaleLowerCase() === normalized ||
        candidate.name?.toLocaleLowerCase() === normalized,
    );
    if (!mailbox) {
      throw new Error(`JMAP mailbox not found by id, role, or name: ${raw}`);
    }
    return mailbox;
  }

  async getEmails(
    ids: string[],
    options?: { maxBodyValueBytes?: number },
  ): Promise<JmapEmail[]> {
    if (ids.length === 0) {
      return [];
    }
    const state = this.state;
    const maxBodyValueBytes = Math.max(
      1_000,
      Math.min(1_000_000, Math.trunc(options?.maxBodyValueBytes ?? DEFAULT_MAX_BODY_BYTES)),
    );
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

    return ensureArray(result.list as JmapEmail[]).filter((item) => item.id);
  }

  async getEmailMetadata(ids: string[]): Promise<JmapEmail[]> {
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
        "attachments",
        "hasAttachment",
        "keywords",
        "size",
        ...SAFETY_HEADER_PROPERTIES,
      ],
      fetchTextBodyValues: false,
      fetchHTMLBodyValues: false,
    });

    return ensureArray(result.list as JmapEmail[]).filter((item) => item.id);
  }

  async searchEmails(params: JmapSearchParams = {}): Promise<JmapEmail[]> {
    return (await this.searchEmailPage(params)).emails;
  }

  async searchEmailPage(params: JmapSearchParams = {}): Promise<JmapSearchPage> {
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
      minSize:
        typeof params.minSize === "number" && Number.isFinite(params.minSize)
          ? Math.max(0, Math.trunc(params.minSize))
          : undefined,
      maxSize:
        typeof params.maxSize === "number" && Number.isFinite(params.maxSize)
          ? Math.max(0, Math.trunc(params.maxSize))
          : undefined,
      hasAttachment:
        typeof params.hasAttachment === "boolean" ? params.hasAttachment : undefined,
      hasKeyword: explicitHasKeyword ?? (params.unread === false ? "$seen" : undefined),
      notKeyword: explicitNotKeyword ?? (params.unread === true ? "$seen" : undefined),
    });

    const queryIds = async (
      queryFilter: Record<string, unknown>,
      queryLimit: number,
      queryPosition: number,
      calculateTotal: boolean,
    ): Promise<{
      ids: string[];
      queryState: string;
      canCalculateChanges: boolean;
      total?: number;
      position: number;
    }> => {
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
        ids: ensureArray(result.ids as string[])
          .map((id) => id.trim())
          .filter(Boolean),
        queryState: String(result.queryState ?? "").trim(),
        canCalculateChanges: result.canCalculateChanges === true,
        total: typeof result.total === "number" ? result.total : undefined,
        position:
          typeof result.position === "number" && Number.isFinite(result.position)
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
        .filter((email): email is JmapEmail => Boolean(email));
      const nextPosition =
        ordered.length === limit && (query.total === undefined || position + ordered.length < query.total)
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
    const fallbackFilters: Array<Record<string, unknown>> = [];
    if (token) {
      fallbackFilters.push({ ...fallbackBase, text: token });
    }
    fallbackFilters.push(fallbackBase);

    const normalizedSubject = normalizeSubjectForComparison(requestedSubject);
    for (const fallbackFilter of fallbackFilters) {
      const fallbackQuery = await queryIds(fallbackFilter, 100, 0, false);
      const candidates = await this.getEmailMetadata(fallbackQuery.ids);
      const matches = candidates
        .filter((email) =>
          normalizeSubjectForComparison(email.subject).includes(normalizedSubject),
        )
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

  async getThreadEmails(threadId: string): Promise<JmapEmail[]> {
    return (await this.getThreadPage(threadId, { limit: 100, offset: 0 })).emails;
  }

  async getThreadPage(
    threadId: string,
    params?: { limit?: number; offset?: number; maxBodyValueBytes?: number },
  ): Promise<JmapThreadPage> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      throw new Error("JMAP thread id is required");
    }
    const result = await this.callMethod("Thread/get", {
      accountId: this.state.mailAccountId,
      ids: [normalizedThreadId],
    });
    const thread = ensureArray(
      result.list as Array<{ id: string; emailIds?: string[] }>,
    ).find((entry) => entry.id === normalizedThreadId);
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
      .filter((email): email is JmapEmail => Boolean(email))
      .sort((left, right) => parseTimestampMs(left) - parseTimestampMs(right));
    return {
      emails: ordered,
      total: emailIds.length,
      offset,
      nextOffset: start > 0 ? offset + selectedIds.length : undefined,
    };
  }

  async probeEmailMetadata(): Promise<JmapMetadataProbe> {
    const state = this.state;
    const query = await this.callMethod("Email/query", {
      accountId: state.mailAccountId,
      ...(state.inboxMailboxId ? { filter: { inMailbox: state.inboxMailboxId } } : {}),
      sort: [{ property: "receivedAt", isAscending: false }],
      calculateTotal: false,
      position: 0,
      limit: 1,
    });
    const emailId = ensureArray(query.ids as string[])
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
    const email = ensureArray(
      emailResult.list as Array<{ id?: string; threadId?: string }>,
    ).find((entry) => entry.id === emailId);
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
    const thread = ensureArray(
      threadResult.list as Array<{ id?: string; emailIds?: string[] }>,
    ).find((entry) => entry.id === threadId);
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

  async markEmailsSeen(ids: string[]): Promise<void> {
    await this.updateEmailKeywords(ids, { seen: true });
  }

  async updateEmailKeywords(
    ids: string[],
    changes: { seen?: boolean; flagged?: boolean },
  ): Promise<void> {
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
    const notUpdated = result.notUpdated as
      | Record<string, { type?: string; description?: string }>
      | undefined;
    const failedId = validIds.find((id) => notUpdated?.[id]);
    if (failedId) {
      const failure = notUpdated?.[failedId];
      throw new JmapMethodError(
        failure?.type?.trim() || "notUpdated",
        failure?.description?.trim() || `JMAP Email/set did not update email ${failedId}`,
      );
    }
  }

  async moveEmails(ids: string[], destinationReference: string): Promise<JmapMoveResult> {
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
        .filter((mailbox): mailbox is JmapMailbox => Boolean(mailbox)),
    }));
    const nonRemovable = previous
      .flatMap((entry) => entry.mailboxes)
      .find((mailbox) => mailbox.myRights?.mayRemoveItems === false);
    if (nonRemovable) {
      throw new Error(
        `JMAP mailbox does not allow removing email: ${nonRemovable.name ?? nonRemovable.id}`,
      );
    }
    const result = await this.callMethod("Email/set", {
      accountId: this.state.mailAccountId,
      update: Object.fromEntries(
        validIds.map((id) => [
          id,
          {
            mailboxIds: {
              [destination.id]: true,
            },
          },
        ]),
      ),
    });
    const notUpdated = result.notUpdated as
      | Record<string, { type?: string; description?: string }>
      | undefined;
    const failedId = validIds.find((id) => notUpdated?.[id]);
    if (failedId) {
      const failure = notUpdated?.[failedId];
      throw new JmapMethodError(
        failure?.type?.trim() || "notUpdated",
        failure?.description?.trim() || `JMAP Email/set did not move email ${failedId}`,
      );
    }
    return { destination, previous };
  }

  async getThreadContext(threadId: string): Promise<JmapThreadContext | null> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      return null;
    }
    const state = this.state;
    const threadResult = await this.callMethod("Thread/get", {
      accountId: state.mailAccountId,
      ids: [normalizedThreadId],
    });
    const threads = ensureArray(
      threadResult.list as Array<{ id: string; emailIds?: string[] }>,
    ).filter((item) => item.id === normalizedThreadId);

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

  toInboundText(email: JmapEmail): string {
    return extractTextFromEmail(email);
  }

  buildThreadContext(email: JmapEmail): JmapThreadContext | null {
    const state = this.state;
    const threadId = (email.threadId ?? "").trim();
    if (!threadId) {
      return null;
    }
    return buildThreadContextFromEmail(state.mailAccountId, email);
  }

  isSelfAddress(email?: string | null): boolean {
    const state = this.state;
    const normalized = normalizeEmailAddress(email);
    return normalized ? state.selfEmails.has(normalized) : false;
  }

  async sendToThread(params: {
    thread: JmapThreadContext;
    text: string;
    mediaUrls?: string[];
  }): Promise<JmapSendResult> {
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

    const selectRecipients = (candidates: JmapEmailAddress[]): JmapEmailAddress[] => {
      const deduped = new Map<string, JmapEmailAddress>();
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
    const recipients =
      replyRecipients.length > 0
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

  async sendToAddress(params: {
    toEmail: string;
    text: string;
    subject?: string;
  }): Promise<JmapSendResult> {
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

  async listIdentities(): Promise<JmapIdentity[]> {
    const state = this.state;
    if (!state.submissionAccountId) {
      return [];
    }
    return await this.getIdentities(state.apiUrl, state.submissionAccountId);
  }

  async createDraft(params: {
    identityId?: string;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    text?: string;
  }): Promise<JmapDraftCreateResult> {
    const state = await this.ensureSubmissionIdentity(params.identityId);
    const draftsMailbox = state.mailboxes.find(
      (mailbox) => mailbox.id === state.draftsMailboxId,
    );
    if (!draftsMailbox) {
      throw new JmapMethodError(
        "notFound",
        "JMAP account does not expose a mailbox with the drafts role",
      );
    }
    if (draftsMailbox.myRights?.mayAddItems === false) {
      throw new JmapMethodError(
        "forbidden",
        "JMAP account does not permit adding emails to the drafts mailbox",
      );
    }

    const to = normalizeRecipientEmails(params.to, "to");
    const cc = normalizeRecipientEmails(params.cc, "cc");
    const explicitBcc = normalizeRecipientEmails(params.bcc, "bcc");
    const bcc = mergeAddresses(state.identityBcc, explicitBcc);
    const replyTo = mergeAddresses(state.identityReplyTo);
    const subject = params.subject?.trim() ?? "";
    const text = params.text ?? "";
    if (to.length + cc.length + explicitBcc.length > MAX_DRAFT_RECIPIENTS) {
      throw new JmapMethodError(
        "invalidArguments",
        `Draft recipients exceed the ${MAX_DRAFT_RECIPIENTS}-address limit`,
      );
    }
    if (utf8ByteLength(subject) > MAX_DRAFT_SUBJECT_BYTES) {
      throw new JmapMethodError(
        "invalidArguments",
        `Draft subject exceeds the ${MAX_DRAFT_SUBJECT_BYTES}-byte limit`,
      );
    }
    if (utf8ByteLength(text) > MAX_DRAFT_TEXT_BYTES) {
      throw new JmapMethodError(
        "invalidArguments",
        `Draft body exceeds the ${MAX_DRAFT_TEXT_BYTES}-byte limit`,
      );
    }
    if (
      to.length === 0 &&
      cc.length === 0 &&
      explicitBcc.length === 0 &&
      !subject &&
      !text.trim()
    ) {
      throw new JmapMethodError(
        "invalidArguments",
        "Refusing to create an entirely empty draft",
      );
    }

    const bodyPartId = "body-1";
    const createEmail = compact({
      mailboxIds: {
        [draftsMailbox.id]: true,
      },
      from: [
        compact({
          email: state.identityEmail,
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
    const created = emailSet.created as
      | Record<string, { id?: string; threadId?: string; size?: number }>
      | undefined;
    const createdDraft = created?.createDraft;
    const notCreated = emailSet.notCreated as
      | Record<string, { type?: string; description?: string }>
      | undefined;
    const failure = notCreated?.createDraft;
    if (failure) {
      throw new JmapMethodError(
        failure.type?.trim() || "notCreated",
        failure.description?.trim() || "JMAP server rejected the draft",
      );
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
      identityEmail: state.identityEmail,
      draftsMailboxId: draftsMailbox.id,
    };
  }

  private async sendEmailInternal(params: {
    to: JmapEmailAddress[];
    cc: JmapEmailAddress[];
    subject: string;
    bodyText: string;
    inReplyTo?: string;
    references: string[];
    threadId?: string;
    accountId: string;
  }): Promise<JmapSendResult> {
    const state = await this.ensureSubmissionIdentity();
    const bodyPartId = "body-1";
    const mailboxIds: Record<string, boolean> = {};
    if (state.draftsMailboxId) {
      mailboxIds[state.draftsMailboxId] = true;
    } else if (state.sentMailboxId) {
      mailboxIds[state.sentMailboxId] = true;
    } else if (state.inboxMailboxId) {
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

    const created = emailSet.created as Record<string, { id?: string; threadId?: string }>;
    const createdEmail = created?.createEmail;
    const emailId = createdEmail?.id?.trim();
    if (!emailId) {
      throw new Error("JMAP Email/set did not return created email id");
    }

    const onSuccessUpdate: Record<string, boolean | null> = {
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

    const submissionCreated = submissionSet.created as Record<string, { id?: string }>;
    const submissionId = submissionCreated?.submitEmail?.id?.trim();
    if (!submissionId) {
      throw new Error("JMAP EmailSubmission/set did not return submission id");
    }

    return {
      messageId: emailId,
      threadId: params.threadId || createdEmail?.threadId,
    };
  }

  private async fetchSession(): Promise<
    Required<Pick<JmapSessionResponse, "apiUrl">> & JmapSessionResponse
  > {
    const response = await fetch(this.sessionUrl, {
      method: "GET",
      headers: {
        Authorization: this.authorizationHeader,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `JMAP session fetch failed (${response.status}): ${body || response.statusText}`,
      );
    }
    const json = (await response.json()) as JmapSessionResponse;
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

  private resolveMailAccountId(session: JmapSessionResponse): string {
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

  private resolveSubmissionAccountId(session: JmapSessionResponse): string | undefined {
    const primary = session.primaryAccounts?.[JMAP_SUBMISSION]?.trim();
    if (primary && accountCapabilitiesFor(session, primary).includes(JMAP_SUBMISSION)) {
      return primary;
    }

    const preferred = this.accountIdHint?.trim();
    if (
      preferred &&
      accountCapabilitiesFor(session, preferred).includes(JMAP_SUBMISSION)
    ) {
      return preferred;
    }

    for (const accountId of Object.keys(session.accounts ?? {})) {
      if (accountCapabilitiesFor(session, accountId).includes(JMAP_SUBMISSION)) {
        return accountId;
      }
    }
    return undefined;
  }

  private async getMailboxes(apiUrl: string, accountId: string): Promise<JmapMailbox[]> {
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
    return ensureArray(payload.list as JmapMailbox[]).filter((box) => box.id);
  }

  private async getIdentities(apiUrl: string, accountId: string): Promise<JmapIdentity[]> {
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
    return ensureArray(payload.list as JmapIdentity[]).filter((identity) => identity.id);
  }

  private async callMethod(
    methodName: string,
    args: JmapMethodCallArgs,
  ): Promise<Record<string, unknown>> {
    const state = this.state;
    const callId = `${methodName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-0`;
    const result = await this.callApi(state.apiUrl, [[methodName, args, callId]]);
    return this.pickMethod(result, methodName, callId);
  }

  private async callApi(apiUrl: string, methodCalls: JmapMethodCall[]): Promise<JmapApiResponse> {
    const using = new Set<string>([JMAP_CORE]);
    for (const [methodName] of methodCalls) {
      if (
        methodName.startsWith("Mailbox/") ||
        methodName.startsWith("Email/") ||
        methodName.startsWith("Thread/") ||
        methodName.startsWith("SearchSnippet/")
      ) {
        using.add(JMAP_MAIL);
      }
      if (
        methodName.startsWith("Identity/") ||
        methodName.startsWith("EmailSubmission/") ||
        methodName.startsWith("VacationResponse/")
      ) {
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
      throw new Error(
        `JMAP API request failed (${response.status}): ${body || response.statusText}`,
      );
    }

    const json = (await response.json()) as JmapApiResponse;
    if (!Array.isArray(json.methodResponses)) {
      throw new Error("JMAP API response missing methodResponses");
    }
    return json;
  }

  private async ensureSubmissionIdentity(identityId?: string): Promise<JmapSubmissionReadyState> {
    const state = this.state;
    if (!state.submissionAccountId) {
      throw new JmapMethodError(
        "accountNotFound",
        "JMAP Submission capability is not available for this account",
      );
    }
    const requestedIdentityId = identityId?.trim();
    if (
      state.identityId &&
      state.identityEmail &&
      (!requestedIdentityId || state.identityId === requestedIdentityId)
    ) {
      return state as JmapSubmissionReadyState;
    }

    const identities = await this.getIdentities(state.apiUrl, state.submissionAccountId);
    const identity = requestedIdentityId
      ? identities.find((candidate) => candidate.id === requestedIdentityId) ?? null
      : pickIdentity(identities, state.username);
    const identityEmail = normalizeEmailAddress(identity?.email);
    if (!identity?.id || !identityEmail) {
      throw new JmapMethodError(
        "accountNotFound",
        requestedIdentityId
          ? `JMAP identity not found: ${requestedIdentityId}`
          : "JMAP identity not found for sending emails",
      );
    }

    const next: JmapClientInit = {
      ...state,
      identityId: identity.id,
      identityEmail,
      identityName: identity.name?.trim() || undefined,
      identityReplyTo: identity.replyTo,
      identityBcc: identity.bcc,
      selfEmails: normalizeIdentityEmails(identity, state.username),
    };
    if (!requestedIdentityId) {
      this.initState = next;
    }
    return next as JmapSubmissionReadyState;
  }

  private pickMethod(
    response: JmapApiResponse,
    expectedMethod: string,
    callId: string,
  ): Record<string, unknown> {
    const matched = ensureArray(response.methodResponses).find((entry) => entry[2] === callId);
    if (!matched) {
      throw new Error(`JMAP response missing method result for ${expectedMethod} (${callId})`);
    }
    const [methodName, payload] = matched;
    if (methodName === "error") {
      const errorType = typeof payload.type === "string" ? payload.type : "unknown";
      const description = typeof payload.description === "string" ? payload.description : "";
      throw new JmapMethodError(
        errorType,
        `JMAP ${expectedMethod} failed: ${description || errorType}`,
      );
    }
    if (methodName !== expectedMethod) {
      throw new Error(
        `Unexpected JMAP method response: expected ${expectedMethod}, got ${methodName}`,
      );
    }
    return payload;
  }
}
export { parseInboundEmail } from "./jmap-email.js";
