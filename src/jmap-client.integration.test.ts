import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JmapThreadContext } from "./types.js";
import { JMAP_MAIL, JMAP_SUBMISSION } from "./types.js";
import { JmapClient, JmapMethodError } from "./jmap-client.js";
import { JmapMockServer, type JmapCapturedCall } from "./test-utils/jmap-mock-server.js";

type Bootstrapped = {
  client: JmapClient;
  mailAccountId: string;
  submissionAccountId: string;
};

function readCreateEmail(
  call: JmapCapturedCall,
  creationId = "createEmail",
): Record<string, unknown> {
  const create = call.args.create as Record<string, unknown>;
  return (create?.[creationId] as Record<string, unknown>) ?? {};
}

function enqueueDraft(
  server: JmapMockServer,
  overrides: Record<string, unknown> = {},
  state = "email-state-1",
) {
  server.enqueueMethod("Email/get", {
    state,
    list: [
      {
        id: "draft-1",
        blobId: "blob-draft-1",
        threadId: "thread-draft-1",
        mailboxIds: { "mbox-drafts": true },
        keywords: { $draft: true },
        from: [{ email: "bot@example.com", name: "OpenClaw Bot" }],
        to: [{ email: "recipient@example.com" }],
        cc: [],
        bcc: [],
        replyTo: [],
        subject: "Review me",
        textBody: [{ partId: "body-1", type: "text/plain" }],
        bodyValues: { "body-1": { value: "Exact draft body" } },
        attachments: [],
        size: 128,
        ...overrides,
      },
    ],
  });
}

async function bootstrapClient(
  server: JmapMockServer,
  options?: { maxDelayedSend?: number },
): Promise<Bootstrapped> {
  const mailAccountId = "acc-mail";
  const submissionAccountId = "acc-submission";
  server.setSession({
    username: "bot@example.com",
    primaryAccounts: {
      [JMAP_MAIL]: mailAccountId,
      [JMAP_SUBMISSION]: submissionAccountId,
    },
    accounts: {
      [mailAccountId]: {
        accountCapabilities: {
          [JMAP_MAIL]: {},
        },
      },
      [submissionAccountId]: {
        accountCapabilities: {
          [JMAP_SUBMISSION]: {
            ...(options?.maxDelayedSend !== undefined
              ? { maxDelayedSend: options.maxDelayedSend }
              : {}),
          },
        },
      },
    },
  });
  server.enqueueMethod("Mailbox/get", {
    list: [
      {
        id: "mbox-inbox",
        role: "inbox",
        name: "Inbox",
        sortOrder: 10,
        totalEmails: 12,
        unreadEmails: 3,
        myRights: { mayReadItems: true, mayAddItems: true },
      },
      {
        id: "mbox-sent",
        role: "sent",
        name: "Sent",
        sortOrder: 30,
        myRights: { mayReadItems: true, mayAddItems: true },
      },
      {
        id: "mbox-drafts",
        role: "drafts",
        name: "Drafts",
        sortOrder: 20,
        myRights: { mayReadItems: true, mayAddItems: true },
      },
      {
        id: "mbox-junk",
        role: "junk",
        name: "Junk Mail",
        sortOrder: 40,
        totalEmails: 4,
        unreadEmails: 1,
        myRights: { mayReadItems: true, mayAddItems: true },
      },
    ],
  });
  server.enqueueMethod("Identity/get", {
    list: [
      {
        id: "identity-1",
        email: "bot@example.com",
        name: "OpenClaw Bot",
        isDefault: true,
      },
    ],
  });
  const client = new JmapClient({
    sessionUrl: server.sessionUrl,
    token: "test-token",
  });
  await client.init();
  return {
    client,
    mailAccountId,
    submissionAccountId,
  };
}

describe("JmapClient full chain", () => {
  let server: JmapMockServer;

  beforeEach(async () => {
    server = await JmapMockServer.start();
  });

  afterEach(async () => {
    await server.close();
  });

  it("initializes from session/mailbox/identity chain", async () => {
    const { client, mailAccountId, submissionAccountId } = await bootstrapClient(server);

    expect(client.state).toMatchObject({
      apiUrl: server.apiUrl,
      mailAccountId,
      submissionAccountId,
      inboxMailboxId: "mbox-inbox",
      sentMailboxId: "mbox-sent",
      draftsMailboxId: "mbox-drafts",
      identityId: "identity-1",
      identityEmail: "bot@example.com",
      identityName: "OpenClaw Bot",
    });
    expect(client.state.selfEmails.has("bot@example.com")).toBe(true);
    expect(server.getCalls("Mailbox/get")).toHaveLength(1);
    expect(server.getCalls("Mailbox/get")[0]?.args).toMatchObject({
      properties: expect.arrayContaining([
        "parentId",
        "sortOrder",
        "totalEmails",
        "unreadEmails",
        "myRights",
      ]),
    });
    expect(server.getCalls("Identity/get")).toHaveLength(1);
    const identityGet = server.getCalls("Identity/get")[0];
    expect(identityGet?.args).toMatchObject({
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
    });
    expect(server.pendingResponses).toBe(0);
  });

  it("resolves relative Session resource and URI-template URLs", async () => {
    server.setSession({
      apiUrl: "/jmap",
      downloadUrl: "/jmap/download/{accountId}/{blobId}/{name}?accept={type}",
      uploadUrl: "/jmap/upload/{accountId}/",
      eventSourceUrl: "/jmap/eventsource/?types={types}&ping={ping}",
      primaryAccounts: {
        [JMAP_MAIL]: "acc-mail",
        [JMAP_SUBMISSION]: "acc-mail",
      },
      accounts: {
        "acc-mail": {
          accountCapabilities: null,
        },
      },
    });
    server.enqueueMethod("Mailbox/get", {
      list: [{ id: "mbox-inbox", role: "inbox", name: "Inbox" }],
    });
    server.enqueueMethod("Identity/get", {
      list: [
        {
          id: "identity-relative",
          email: "bot@example.com",
          name: "Relative Session",
          isDefault: true,
        },
      ],
    });
    const client = new JmapClient({
      sessionUrl: server.sessionUrl,
      token: "test-token",
    });

    await client.init();

    expect(client.state).toMatchObject({
      apiUrl: `${server.origin}/jmap`,
      downloadUrl: `${server.origin}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
      uploadUrl: `${server.origin}/jmap/upload/{accountId}/`,
      eventSourceUrl: `${server.origin}/jmap/eventsource/?types={types}&ping={ping}`,
      submissionAccountId: "acc-mail",
      identityId: "identity-relative",
    });
    expect(client.state.mailAccountCapabilities).toContain(JMAP_MAIL);
    expect(client.state.submissionAccountCapabilities).toContain(JMAP_SUBMISSION);
  });

  it("keeps Mail-only accounts readable and refuses submission-dependent actions", async () => {
    server.setSession({
      capabilities: {
        "urn:ietf:params:jmap:core": {},
        [JMAP_MAIL]: {},
      },
      primaryAccounts: {
        [JMAP_MAIL]: "acc-mail",
      },
      accounts: {
        "acc-mail": {
          accountCapabilities: {
            [JMAP_MAIL]: {},
          },
        },
      },
    });
    server.enqueueMethod("Mailbox/get", {
      list: [{ id: "mbox-inbox", role: "inbox", name: "Inbox" }],
    });
    const client = new JmapClient({
      sessionUrl: server.sessionUrl,
      token: "test-token",
    });

    await client.init();

    expect(client.state.submissionAccountId).toBeUndefined();
    expect(server.getCalls("Identity/get")).toHaveLength(0);
    await expect(client.listIdentities()).resolves.toEqual([]);
    await expect(
      client.createDraft({
        subject: "Cannot select a sending identity",
      }),
    ).rejects.toMatchObject({
      name: "Error",
      type: "accountNotFound",
    });
    await expect(
      client.sendToAddress({
        toEmail: "owner@example.com",
        subject: "Should not send",
        text: "This message must never be created.",
      }),
    ).rejects.toMatchObject({
      name: "Error",
      type: "accountNotFound",
    });
    expect(server.getCalls("Email/set")).toHaveLength(0);
  });

  it("queries inbox state, queryChanges, and fetches emails", async () => {
    const { client, mailAccountId } = await bootstrapClient(server);
    server.enqueueMethod("Email/query", {
      accountId: mailAccountId,
      queryState: "q-1",
      ids: ["mail-1"],
    });
    server.enqueueMethod("Email/queryChanges", {
      oldQueryState: "q-1",
      newQueryState: "q-2",
      added: [{ id: "mail-1", index: 0 }],
      removed: [],
      hasMoreChanges: false,
    });
    server.enqueueMethod("Email/get", {
      list: [
        {
          id: "mail-1",
          threadId: "thread-1",
          from: [{ email: "alice@example.com", name: "Alice" }],
          to: [{ email: "bot@example.com", name: "OpenClaw Bot" }],
          subject: "Hello",
          preview: "Inbound body",
          receivedAt: "2026-02-16T05:00:00.000Z",
        },
      ],
    });

    const queryState = await client.queryInboxState();
    const changes = await client.queryInboxChanges(queryState);
    const emails = await client.getEmails(changes.added?.map((item) => item.id) ?? []);

    expect(queryState).toBe("q-1");
    expect(changes).toMatchObject({
      oldQueryState: "q-1",
      newQueryState: "q-2",
      added: [{ id: "mail-1", index: 0 }],
      hasMoreChanges: false,
    });
    expect(emails).toHaveLength(1);
    expect(emails[0]?.id).toBe("mail-1");

    const queryCall = server.getCalls("Email/query")[0];
    expect(queryCall?.args).toMatchObject({
      accountId: mailAccountId,
      filter: { inMailbox: "mbox-inbox" },
    });
  });

  it("queries unread inbox ids with notKeyword filter", async () => {
    const { client, mailAccountId } = await bootstrapClient(server);
    server.enqueueMethod("Email/query", {
      queryState: "q-unread",
      ids: ["mail-1", "mail-2"],
    });

    const ids = await client.queryUnreadInboxIds({ limit: 10 });

    expect(ids).toEqual(["mail-1", "mail-2"]);
    const unreadQueryCall = server.getCalls("Email/query")[0];
    expect(unreadQueryCall?.args).toMatchObject({
      accountId: mailAccountId,
      filter: {
        inMailbox: "mbox-inbox",
        notKeyword: "$seen",
      },
      sort: [{ property: "receivedAt", isAscending: true }],
      limit: 10,
    });
  });

  it("queries recent inbox ids for polling fallback", async () => {
    const { client, mailAccountId } = await bootstrapClient(server);
    server.enqueueMethod("Email/query", {
      queryState: "q-recent",
      ids: ["mail-new", "mail-old"],
    });

    const ids = await client.queryRecentInboxIds({ limit: 10 });

    expect(ids).toEqual(["mail-new", "mail-old"]);
    const recentQueryCall = server.getCalls("Email/query")[0];
    expect(recentQueryCall?.args).toMatchObject({
      accountId: mailAccountId,
      filter: {
        inMailbox: "mbox-inbox",
      },
      sort: [{ property: "receivedAt", isAscending: false }],
      position: 0,
      limit: 10,
    });
  });

  it("falls back from broken subject filters and matches literal subjects without reading bodies", async () => {
    const { client, mailAccountId } = await bootstrapClient(server);
    server.enqueueMethod("Email/query", {
      queryState: "q-subject-empty",
      ids: [],
    });
    server.enqueueMethod("Email/query", {
      queryState: "q-text-fallback",
      ids: ["mail-match", "mail-other"],
    });
    server.enqueueMethod("Email/get", {
      list: [
        {
          id: "mail-match",
          subject: "[JMAP v0.3.0 acceptance] 20260729-2115-JST",
          preview: "Expected",
        },
        {
          id: "mail-other",
          subject: "A different acceptance message",
          preview: "Other",
        },
      ],
    });

    const emails = await client.searchEmails({
      subject: "[JMAP v0.3.0 acceptance] 20260729-2115-JST",
      limit: 10,
    });

    expect(emails).toEqual([
      expect.objectContaining({
        id: "mail-match",
        subject: "[JMAP v0.3.0 acceptance] 20260729-2115-JST",
      }),
    ]);
    const queryCalls = server.getCalls("Email/query");
    expect(queryCalls).toHaveLength(2);
    expect(queryCalls[0]?.args).toMatchObject({
      accountId: mailAccountId,
      filter: {
        inMailbox: "mbox-inbox",
        subject: "[JMAP v0.3.0 acceptance] 20260729-2115-JST",
      },
      limit: 10,
    });
    expect(queryCalls[1]?.args).toMatchObject({
      accountId: mailAccountId,
      filter: {
        inMailbox: "mbox-inbox",
        text: "acceptance",
      },
      limit: 100,
    });
    expect(server.getCalls("Email/get")[0]?.args).toMatchObject({
      ids: ["mail-match", "mail-other"],
      fetchTextBodyValues: false,
      fetchHTMLBodyValues: false,
    });
  });

  it("lists and resolves mailboxes, then searches all mail with advanced filters and pagination", async () => {
    const { client, mailAccountId } = await bootstrapClient(server);

    expect(client.listMailboxes().map((mailbox) => mailbox.role)).toEqual([
      "inbox",
      "drafts",
      "sent",
      "junk",
    ]);
    expect(client.resolveMailbox("JUNK")?.id).toBe("mbox-junk");
    expect(client.resolveMailbox("Junk Mail")?.id).toBe("mbox-junk");
    expect(client.resolveMailbox("all")).toBeUndefined();
    expect(() => client.resolveMailbox("missing")).toThrow("JMAP mailbox not found");

    server.enqueueMethod("Email/query", {
      queryState: "q-all",
      canCalculateChanges: true,
      position: 5,
      total: 10,
      ids: ["mail-6", "mail-7"],
    });
    server.enqueueMethod("Email/get", {
      list: [
        { id: "mail-7", subject: "Second", mailboxIds: { "mbox-junk": true } },
        { id: "mail-6", subject: "First", mailboxIds: { "mbox-sent": true } },
      ],
    });

    const page = await client.searchEmailPage({
      mailbox: "all",
      unread: true,
      hasAttachment: true,
      minSize: 100,
      maxSize: 10_000,
      hasKeyword: "$answered",
      collapseThreads: true,
      position: 5,
      limit: 2,
    });

    expect(page).toMatchObject({
      queryState: "q-all",
      canCalculateChanges: true,
      position: 5,
      total: 10,
      nextPosition: 7,
      emails: [{ id: "mail-6" }, { id: "mail-7" }],
    });
    expect(server.getCalls("Email/query")[0]?.args).toEqual({
      accountId: mailAccountId,
      filter: {
        minSize: 100,
        maxSize: 10_000,
        hasAttachment: true,
        hasKeyword: "$answered",
        notKeyword: "$seen",
      },
      sort: [{ property: "receivedAt", isAscending: false }],
      collapseThreads: true,
      calculateTotal: true,
      position: 5,
      limit: 2,
    });
  });

  it("reads bounded HTML bodies and attachment metadata", async () => {
    const { client, mailAccountId } = await bootstrapClient(server);
    server.enqueueMethod("Email/get", {
      list: [
        {
          id: "mail-html",
          htmlBody: [{ partId: "html-1", type: "text/html" }],
          bodyValues: {
            "html-1": {
              value: '<p>Open <a href="https://example.com/">portal</a></p>',
            },
          },
          attachments: [
            {
              partId: "part-2",
              blobId: "blob-1",
              name: "report.pdf",
              type: "application/pdf",
              size: 1234,
            },
          ],
          hasAttachment: true,
        },
      ],
    });

    const emails = await client.getEmails(["mail-html"], { maxBodyValueBytes: 2048 });

    expect(emails[0]).toMatchObject({
      id: "mail-html",
      attachments: [{ blobId: "blob-1", name: "report.pdf", size: 1234 }],
    });
    expect(client.toInboundText(emails[0]!)).toBe("Open portal");
    expect(server.getCalls("Email/get")[0]?.args).toMatchObject({
      accountId: mailAccountId,
      ids: ["mail-html"],
      fetchTextBodyValues: true,
      fetchHTMLBodyValues: true,
      maxBodyValueBytes: 2048,
      properties: expect.arrayContaining([
        "htmlBody",
        "attachments",
        "hasAttachment",
        "header:List-Unsubscribe:asText",
      ]),
    });
  });

  it("pages large threads from newest to oldest and preserves chronological order within a page", async () => {
    const { client } = await bootstrapClient(server);
    server.enqueueMethod("Thread/get", {
      list: [
        {
          id: "thread-large",
          emailIds: ["mail-1", "mail-2", "mail-3", "mail-4", "mail-5"],
        },
      ],
    });
    server.enqueueMethod("Email/get", {
      list: [
        { id: "mail-5", receivedAt: "2026-07-29T05:00:00Z" },
        { id: "mail-3", receivedAt: "2026-07-29T03:00:00Z" },
        { id: "mail-4", receivedAt: "2026-07-29T04:00:00Z" },
      ],
    });

    const page = await client.getThreadPage("thread-large", { limit: 3 });

    expect(page).toMatchObject({
      total: 5,
      offset: 0,
      nextOffset: 3,
      emails: [{ id: "mail-3" }, { id: "mail-4" }, { id: "mail-5" }],
    });
    expect(server.getCalls("Email/get")[0]?.args).toMatchObject({
      ids: ["mail-3", "mail-4", "mail-5"],
    });
  });

  it("moves email exclusively to a named destination mailbox", async () => {
    const { client, mailAccountId } = await bootstrapClient(server);
    server.enqueueMethod("Email/get", {
      list: [
        { id: "mail-1", mailboxIds: { "mbox-inbox": true } },
        { id: "mail-2", mailboxIds: { "mbox-inbox": true } },
      ],
    });
    server.enqueueMethod("Email/set", {
      updated: {
        "mail-1": null,
        "mail-2": null,
      },
    });

    const result = await client.moveEmails(["mail-1", "mail-2"], "Junk Mail");

    expect(result).toMatchObject({
      destination: { id: "mbox-junk" },
      previous: [
        { emailId: "mail-1", mailboxes: [{ id: "mbox-inbox" }] },
        { emailId: "mail-2", mailboxes: [{ id: "mbox-inbox" }] },
      ],
    });
    expect(server.getCalls("Email/set")[0]?.args).toEqual({
      accountId: mailAccountId,
      update: {
        "mail-1": { mailboxIds: { "mbox-junk": true } },
        "mail-2": { mailboxIds: { "mbox-junk": true } },
      },
    });
  });

  it("reports per-email move failures instead of claiming success", async () => {
    const { client } = await bootstrapClient(server);
    server.enqueueMethod("Email/get", {
      list: [{ id: "mail-1", mailboxIds: { "mbox-inbox": true } }],
    });
    server.enqueueMethod("Email/set", {
      notUpdated: {
        "mail-1": {
          type: "forbidden",
          description: "Mailbox policy rejected the move",
        },
      },
    });

    await expect(client.moveEmails(["mail-1"], "junk")).rejects.toMatchObject({
      name: "Error",
      type: "forbidden",
      message: "Mailbox policy rejected the move",
    });
  });

  it("marks processed emails as seen with Email/set", async () => {
    const { client, mailAccountId } = await bootstrapClient(server);
    server.enqueueMethod("Email/set", {
      updated: {
        "mail-1": null,
      },
    });

    await client.markEmailsSeen(["mail-1"]);

    const emailSetCall = server.getCalls("Email/set")[0];
    expect(emailSetCall?.args).toMatchObject({
      accountId: mailAccountId,
      update: {
        "mail-1": {
          "keywords/$seen": true,
        },
      },
    });
  });

  it("reports keyword update failures instead of claiming success", async () => {
    const { client } = await bootstrapClient(server);
    server.enqueueMethod("Email/set", {
      notUpdated: {
        "mail-1": {
          type: "forbidden",
          description: "Read state is locked",
        },
      },
    });

    await expect(
      client.updateEmailKeywords(["mail-1"], { seen: true }),
    ).rejects.toMatchObject({
      type: "forbidden",
      message: "Read state is locked",
    });
  });

  it("builds thread context from Thread/get + Email/get chain", async () => {
    const { client, mailAccountId } = await bootstrapClient(server);
    server.enqueueMethod("Thread/get", {
      list: [{ id: "thread-1", emailIds: ["mail-1", "mail-2"] }],
    });
    server.enqueueMethod("Email/get", {
      list: [
        {
          id: "mail-1",
          threadId: "thread-1",
          subject: "First",
          to: [{ email: "bot@example.com", name: "OpenClaw Bot" }],
          from: [{ email: "alice@example.com", name: "Alice" }],
          messageId: ["m-first"],
          references: ["m-root"],
          receivedAt: "2026-02-16T04:00:00.000Z",
        },
        {
          id: "mail-2",
          threadId: "thread-1",
          subject: "Latest",
          to: [{ email: "bot@example.com", name: "OpenClaw Bot" }],
          from: [{ email: "alice@example.com", name: "Alice" }],
          replyTo: [{ email: "reply@example.com", name: "Reply" }],
          cc: [{ email: "cc@example.com", name: "CC" }],
          messageId: ["m-latest"],
          references: ["m-root", "m-first"],
          receivedAt: "2026-02-16T05:00:00.000Z",
        },
      ],
    });

    const context = await client.getThreadContext("thread-1");

    expect(context).toMatchObject({
      accountId: mailAccountId,
      threadId: "thread-1",
      latestEmailId: "mail-2",
      latestMessageId: "m-latest",
      subject: "Latest",
      replyTo: [{ email: "reply@example.com", name: "Reply" }],
      cc: [{ email: "cc@example.com", name: "CC" }],
    });
    expect(context?.references).toEqual(["m-root", "m-first", "m-latest"]);
  });

  it("lists identities and saves a draft without submitting or changing the default identity", async () => {
    const { client, mailAccountId } = await bootstrapClient(server);
    const identities = [
      {
        id: "identity-1",
        email: "bot@example.com",
        name: "OpenClaw Bot",
        replyTo: [{ email: "reply@example.com", name: "Replies" }],
        bcc: [{ email: "archive@example.com", name: "Archive" }],
      },
      {
        id: "identity-2",
        email: "alias@example.com",
        name: "OpenClaw Alias",
        replyTo: [{ email: "alias-replies@example.com" }],
        bcc: [{ email: "alias-archive@example.com" }],
      },
    ];
    server.enqueueMethod("Identity/get", { list: identities });

    await expect(client.listIdentities()).resolves.toEqual(identities);

    server.enqueueMethod("Identity/get", { list: identities });
    server.enqueueMethod("Email/set", {
      created: {
        createDraft: {
          id: "draft-1",
          threadId: "thread-draft-1",
          size: 321,
        },
      },
    });

    const result = await client.createDraft({
      identityId: "identity-2",
      to: ["ALICE@example.com", "alice@example.com"],
      cc: ["reviewer@example.com"],
      bcc: ["audit@example.com", "AUDIT@example.com"],
      subject: "  Draft subject  ",
      text: "Draft body",
      attachments: [
        {
          blobId: "blob-report",
          type: "application/pdf",
          name: "report.pdf",
        },
      ],
    });

    expect(result).toEqual({
      emailId: "draft-1",
      threadId: "thread-draft-1",
      size: 321,
      identityId: "identity-2",
      identityEmail: "alias@example.com",
      draftsMailboxId: "mbox-drafts",
    });
    expect(client.state.identityId).toBe("identity-1");

    const emailSetCall = server.getCalls("Email/set")[0];
    expect(emailSetCall?.args).toMatchObject({
      accountId: mailAccountId,
    });
    const draft = emailSetCall ? readCreateEmail(emailSetCall, "createDraft") : {};
    expect(draft).toMatchObject({
      mailboxIds: { "mbox-drafts": true },
      from: [{ email: "alias@example.com", name: "OpenClaw Alias" }],
      to: [{ email: "alice@example.com" }],
      cc: [{ email: "reviewer@example.com" }],
      bcc: [
        { email: "alias-archive@example.com" },
        { email: "audit@example.com" },
      ],
      replyTo: [{ email: "alias-replies@example.com" }],
      subject: "Draft subject",
      keywords: { $draft: true },
      attachments: [
        {
          blobId: "blob-report",
          type: "application/pdf",
          name: "report.pdf",
          disposition: "attachment",
        },
      ],
      "header:Auto-Submitted:asText": "auto-generated",
      "header:X-Auto-Response-Suppress:asText": "All",
    });
    const bodyValues = draft.bodyValues as Record<string, { value?: string }>;
    expect(bodyValues?.["body-1"]?.value).toBe("Draft body");
    expect(server.getCalls("EmailSubmission/set")).toHaveLength(0);
    expect(server.pendingResponses).toBe(0);
  });

  it("rejects empty and malformed drafts before making a mutation", async () => {
    const { client } = await bootstrapClient(server);

    await expect(client.createDraft({})).rejects.toMatchObject({
      type: "invalidArguments",
      message: "Refusing to create an entirely empty draft",
    });
    await expect(
      client.createDraft({
        to: ["not-an-email"],
        subject: "Invalid recipient",
      }),
    ).rejects.toMatchObject({
      type: "invalidArguments",
      message: "to contains an invalid email address",
    });
    await expect(
      client.createDraft({
        to: ["recipient@example.com"],
        text: "x".repeat(1_000_001),
      }),
    ).rejects.toMatchObject({
      type: "invalidArguments",
      message: "Draft body exceeds the 1000000-byte limit",
    });
    expect(server.getCalls("Email/set")).toHaveLength(0);
    expect(server.getCalls("EmailSubmission/set")).toHaveLength(0);
  });

  it("uses wildcard identities, reply routing, archive Bcc, and an explicit signature", async () => {
    const { client } = await bootstrapClient(server);
    server.enqueueMethod("Identity/get", {
      list: [
        {
          id: "identity-wildcard",
          email: "*@example.net",
          name: "Example Team",
          replyTo: [{ email: "replies@example.net" }],
          bcc: [{ email: "archive@example.net" }],
          textSignature: "-- \nExample Team",
          htmlSignature: "<p>Example Team</p>",
          mayDelete: false,
        },
      ],
    });
    server.enqueueMethod("Email/set", {
      created: {
        createDraft: {
          id: "draft-wildcard",
        },
      },
    });

    const result = await client.createDraft({
      identityId: "identity-wildcard",
      fromEmail: "support@example.net",
      to: ["customer@example.com"],
      text: "Hello",
      applyIdentitySignature: true,
    });

    expect(result).toMatchObject({
      emailId: "draft-wildcard",
      identityId: "identity-wildcard",
      identityEmail: "support@example.net",
    });
    const draft = readCreateEmail(server.getCalls("Email/set")[0]!, "createDraft");
    expect(draft).toMatchObject({
      from: [{ email: "support@example.net", name: "Example Team" }],
      replyTo: [{ email: "replies@example.net" }],
      bcc: [{ email: "archive@example.net" }],
    });
    expect(
      (draft.bodyValues as Record<string, { value: string }>)["body-1"]?.value,
    ).toBe("Hello\n\n-- \nExample Team");
  });

  it("surfaces a rejected draft as a typed JMAP error without submitting it", async () => {
    const { client } = await bootstrapClient(server);
    server.enqueueMethod("Email/set", {
      notCreated: {
        createDraft: {
          type: "invalidProperties",
          description: "From address is not allowed",
        },
      },
    });

    await expect(
      client.createDraft({
        to: ["recipient@example.com"],
        subject: "Rejected",
      }),
    ).rejects.toMatchObject({
      type: "invalidProperties",
      message: "From address is not allowed",
    });
    expect(server.getCalls("EmailSubmission/set")).toHaveLength(0);
  });

  it("previews exact draft content and rejects a stale token without mutating mail", async () => {
    const { client } = await bootstrapClient(server);
    enqueueDraft(server, {
      bodyValues: { "body-1": { value: "  Exact draft body \n" } },
    });

    const preview = await client.previewDraft({
      emailId: "draft-1",
      identityId: "identity-1",
    });

    expect(preview).toMatchObject({
      emailId: "draft-1",
      blobId: "blob-draft-1",
      state: "email-state-1",
      identityId: "identity-1",
      identityEmail: "bot@example.com",
      to: [{ email: "recipient@example.com" }],
      subject: "Review me",
      text: "  Exact draft body \n",
      previewToken: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });

    enqueueDraft(
      server,
      {
        subject: "Changed after preview",
        bodyValues: { "body-1": { value: "  Exact draft body \n" } },
      },
      "email-state-2",
    );
    await expect(
      client.discardDraft({
        emailId: "draft-1",
        identityId: "identity-1",
        previewToken: preview.previewToken,
      }),
    ).rejects.toMatchObject({
      type: "stalePreview",
    });
    expect(server.getCalls("Email/set")).toHaveLength(0);
    expect(server.getCalls("EmailSubmission/set")).toHaveLength(0);
  });

  it("replaces a previewed immutable draft before removing the original", async () => {
    const { client, mailAccountId } = await bootstrapClient(server);
    const attachment = {
      blobId: "blob-attachment-1",
      name: "report.pdf",
      type: "application/pdf",
      disposition: "attachment",
      size: 321,
    };
    enqueueDraft(server, { attachments: [attachment] });
    const preview = await client.previewDraft({
      emailId: "draft-1",
      identityId: "identity-1",
    });
    enqueueDraft(server, { attachments: [attachment] });
    server.enqueueMethod("Email/set", {
      newState: "email-state-2",
      created: {
        replaceDraft: {
          id: "draft-2",
          threadId: "thread-draft-2",
          size: 222,
        },
      },
    });
    server.enqueueMethod("Email/set", {
      newState: "email-state-3",
      destroyed: ["draft-1"],
    });

    const result = await client.replaceDraft({
      emailId: "draft-1",
      identityId: "identity-1",
      previewToken: preview.previewToken,
      subject: "Reviewed subject",
      text: "Reviewed body",
    });

    expect(result).toMatchObject({
      previousEmailId: "draft-1",
      emailId: "draft-2",
      identityId: "identity-1",
    });
    const setCalls = server.getCalls("Email/set");
    expect(setCalls).toHaveLength(2);
    expect(setCalls[0]?.args).toMatchObject({
      accountId: mailAccountId,
      ifInState: "email-state-1",
      create: {
        replaceDraft: {
          subject: "Reviewed subject",
          attachments: [
            {
              blobId: "blob-attachment-1",
              name: "report.pdf",
              type: "application/pdf",
              disposition: "attachment",
            },
          ],
        },
      },
    });
    expect(setCalls[1]?.args).toEqual({
      accountId: mailAccountId,
      ifInState: "email-state-2",
      destroy: ["draft-1"],
    });
  });

  it("submits only a freshly previewed draft, exposes history, and cancels only pending work", async () => {
    const { client, submissionAccountId } = await bootstrapClient(server);
    enqueueDraft(server);
    const preview = await client.previewDraft({
      emailId: "draft-1",
      identityId: "identity-1",
    });
    enqueueDraft(server);
    server.enqueueMethod("EmailSubmission/set", {
      created: {
        submitDraft: {
          id: "submission-draft-1",
          threadId: "thread-draft-1",
        },
      },
    });
    server.enqueueMethod("EmailSubmission/get", {
      list: [
        {
          id: "submission-draft-1",
          identityId: "identity-1",
          emailId: "draft-1",
          threadId: "thread-draft-1",
          undoStatus: "pending",
          deliveryStatus: { "recipient@example.com": { delivered: "queued" } },
        },
      ],
    });

    const submitted = await client.submitDraft({
      emailId: "draft-1",
      identityId: "identity-1",
      previewToken: preview.previewToken,
    });

    expect(submitted).toMatchObject({
      submissionId: "submission-draft-1",
      emailId: "draft-1",
      undoStatus: "pending",
      scheduled: false,
      statusObserved: true,
    });
    expect(server.getCalls("EmailSubmission/set")[0]?.args).toMatchObject({
      accountId: submissionAccountId,
      create: {
        submitDraft: {
          emailId: "draft-1",
          identityId: "identity-1",
        },
      },
      onSuccessUpdateEmail: {
        "#submitDraft": {
          "keywords/$draft": null,
          "mailboxIds/mbox-drafts": null,
          "mailboxIds/mbox-sent": true,
        },
      },
    });

    server.enqueueMethod("EmailSubmission/query", {
      ids: ["submission-draft-1"],
      queryState: "submission-query-1",
      total: 1,
    });
    server.enqueueMethod("EmailSubmission/get", {
      list: [
        {
          id: "submission-draft-1",
          emailId: "draft-1",
          undoStatus: "pending",
        },
      ],
    });
    const history = await client.querySubmissions({ undoStatus: "pending" });
    expect(history).toMatchObject({
      queryState: "submission-query-1",
      total: 1,
      submissions: [{ id: "submission-draft-1", undoStatus: "pending" }],
    });

    server.enqueueMethod("EmailSubmission/get", {
      list: [{ id: "submission-draft-1", undoStatus: "pending" }],
    });
    server.enqueueMethod("EmailSubmission/set", {
      updated: { "submission-draft-1": null },
    });
    server.enqueueMethod("EmailSubmission/get", {
      list: [{ id: "submission-draft-1", undoStatus: "canceled" }],
    });
    await expect(client.cancelSubmission("submission-draft-1")).resolves.toMatchObject({
      id: "submission-draft-1",
      undoStatus: "canceled",
    });
  });

  it("does not make an accepted submission look retry-safe when status lookup fails", async () => {
    const { client } = await bootstrapClient(server);
    enqueueDraft(server);
    const preview = await client.previewDraft({
      emailId: "draft-1",
      identityId: "identity-1",
    });
    enqueueDraft(server);
    server.enqueueMethod("EmailSubmission/set", {
      created: {
        submitDraft: {
          id: "submission-status-unknown",
        },
      },
    });
    server.enqueueError("EmailSubmission/get", {
      type: "serverFail",
      description: "Temporary status lookup failure",
    });

    await expect(
      client.submitDraft({
        emailId: "draft-1",
        identityId: "identity-1",
        previewToken: preview.previewToken,
      }),
    ).resolves.toMatchObject({
      submissionId: "submission-status-unknown",
      statusObserved: false,
    });
    expect(server.getCalls("EmailSubmission/set")).toHaveLength(1);
  });

  it("schedules only within the server-advertised delayed-send window", async () => {
    const { client } = await bootstrapClient(server, { maxDelayedSend: 7_200 });
    enqueueDraft(server);
    const preview = await client.previewDraft({
      emailId: "draft-1",
      identityId: "identity-1",
    });
    enqueueDraft(server);
    server.enqueueMethod("EmailSubmission/set", {
      created: {
        submitDraft: {
          id: "submission-scheduled",
        },
      },
    });
    server.enqueueMethod("EmailSubmission/get", {
      list: [
        {
          id: "submission-scheduled",
          emailId: "draft-1",
          sendAt: new Date(Date.now() + 3_600_000).toISOString(),
          undoStatus: "pending",
        },
      ],
    });
    const requestedSendAt = new Date(Date.now() + 3_600_000).toISOString();

    const result = await client.submitDraft({
      emailId: "draft-1",
      identityId: "identity-1",
      previewToken: preview.previewToken,
      sendAt: requestedSendAt,
    });

    expect(result).toMatchObject({
      submissionId: "submission-scheduled",
      scheduled: true,
      maxDelayedSend: 7_200,
    });
    const submission = (
      server.getCalls("EmailSubmission/set")[0]?.args.create as Record<
        string,
        { envelope?: { mailFrom?: { parameters?: { HOLDFOR?: string } } } }
      >
    ).submitDraft;
    const holdFor = Number(submission?.envelope?.mailFrom?.parameters?.HOLDFOR);
    expect(holdFor).toBeGreaterThanOrEqual(3_598);
    expect(holdFor).toBeLessThanOrEqual(3_600);
  });

  it("returns bounded server search snippets and not-found ids", async () => {
    const { client, mailAccountId } = await bootstrapClient(server);
    server.enqueueMethod("SearchSnippet/get", {
      list: [
        {
          emailId: "mail-1",
          subject: "Quarterly <mark>report</mark>",
          preview: "The <mark>report</mark> is ready.",
        },
      ],
      notFound: ["mail-missing"],
    });

    const result = await client.getSearchSnippets(
      ["mail-1", "mail-missing"],
      { text: "report" },
    );

    expect(result).toEqual({
      snippets: [
        {
          emailId: "mail-1",
          subject: "Quarterly <mark>report</mark>",
          preview: "The <mark>report</mark> is ready.",
        },
      ],
      notFound: ["mail-missing"],
    });
    expect(server.getCalls("SearchSnippet/get")[0]?.args).toEqual({
      accountId: mailAccountId,
      filter: { text: "report" },
      emailIds: ["mail-1", "mail-missing"],
    });
  });

  it("reads standard changes pages for mail and submission data types", async () => {
    const { client, mailAccountId, submissionAccountId } = await bootstrapClient(server);
    server.enqueueMethod("Email/changes", {
      oldState: "email-state-1",
      newState: "email-state-2",
      hasMoreChanges: true,
      created: ["mail-created"],
      updated: ["mail-updated"],
      destroyed: ["mail-destroyed"],
    });
    server.enqueueMethod("Identity/changes", {
      oldState: "identity-state-1",
      newState: "identity-state-2",
      hasMoreChanges: false,
      created: [],
      updated: ["identity-1"],
      destroyed: [],
    });

    await expect(client.getChanges("Email", "email-state-1", 25)).resolves.toEqual({
      dataType: "Email",
      oldState: "email-state-1",
      newState: "email-state-2",
      hasMoreChanges: true,
      created: ["mail-created"],
      updated: ["mail-updated"],
      destroyed: ["mail-destroyed"],
    });
    await expect(client.getChanges("Identity", "identity-state-1")).resolves.toEqual({
      dataType: "Identity",
      oldState: "identity-state-1",
      newState: "identity-state-2",
      hasMoreChanges: false,
      created: [],
      updated: ["identity-1"],
      destroyed: [],
    });
    expect(server.getCalls("Email/changes")[0]?.args).toEqual({
      accountId: mailAccountId,
      sinceState: "email-state-1",
      maxChanges: 25,
    });
    expect(server.getCalls("Identity/changes")[0]?.args).toEqual({
      accountId: submissionAccountId,
      sinceState: "identity-state-1",
      maxChanges: 100,
    });
  });

  it("parses RFC 5322 blobs without importing them", async () => {
    const { client, mailAccountId } = await bootstrapClient(server);
    server.enqueueMethod("Email/parse", {
      parsed: {
        "blob-message-1": {
          id: null,
          blobId: "blob-message-1",
          from: [{ email: "alice@example.com" }],
          to: [{ email: "bot@example.com" }],
          subject: "Attached message",
          textBody: [{ partId: "body-1", type: "text/plain" }],
          bodyValues: { "body-1": { value: "Parsed body" } },
        },
      },
      notParsable: ["blob-invalid"],
      notFound: ["blob-missing"],
    });

    const result = await client.parseEmails(
      ["blob-message-1", "blob-invalid", "blob-missing"],
      { maxBodyValueBytes: 2_048 },
    );

    expect(result).toMatchObject({
      parsed: {
        "blob-message-1": {
          id: null,
          subject: "Attached message",
        },
      },
      notParsable: ["blob-invalid"],
      notFound: ["blob-missing"],
    });
    expect(server.getCalls("Email/parse")[0]?.args).toMatchObject({
      accountId: mailAccountId,
      blobIds: ["blob-message-1", "blob-invalid", "blob-missing"],
      fetchTextBodyValues: true,
      fetchHTMLBodyValues: true,
      maxBodyValueBytes: 2_048,
      properties: expect.arrayContaining([
        "blobId",
        "textBody",
        "bodyValues",
        "attachments",
        "header:List-Unsubscribe:asText",
      ]),
    });
    expect(server.getCalls("Email/import")).toHaveLength(0);
  });

  it("uploads blobs, imports messages, and copies without destroying originals", async () => {
    const { client, mailAccountId } = await bootstrapClient(server);
    server.enqueueUpload({
      accountId: mailAccountId,
      blobId: "blob-uploaded",
      type: "message/rfc822",
      size: 18,
    });

    const uploaded = await client.uploadBlob({
      data: Buffer.from("Subject: Imported\r\n"),
      type: "message/rfc822",
    });

    expect(uploaded).toEqual({
      accountId: mailAccountId,
      blobId: "blob-uploaded",
      type: "message/rfc822",
      size: 18,
    });
    expect(server.getUploads()).toEqual([
      {
        path: `/upload/${mailAccountId}`,
        contentType: "message/rfc822",
        body: Buffer.from("Subject: Imported\r\n"),
      },
    ]);

    server.enqueueMethod("Email/import", {
      created: {
        "import-0": {
          id: "mail-imported",
          blobId: "blob-imported",
          threadId: "thread-imported",
          size: 18,
        },
      },
    });
    const imported = await client.importEmails({
      blobIds: ["blob-uploaded"],
      destination: "inbox",
      keywords: ["$seen"],
      ifInState: "email-state-before-import",
    });
    expect(imported).toMatchObject({
      created: {
        "import-0": {
          id: "mail-imported",
        },
      },
      notCreated: {},
    });
    expect(server.getCalls("Email/import")[0]?.args).toEqual({
      accountId: mailAccountId,
      ifInState: "email-state-before-import",
      emails: {
        "import-0": {
          blobId: "blob-uploaded",
          mailboxIds: { "mbox-inbox": true },
          keywords: { $seen: true },
        },
      },
    });

    server.enqueueMethod("Email/copy", {
      fromAccountId: mailAccountId,
      accountId: "acc-destination",
      created: {
        "copy-0": {
          id: "mail-copy",
          blobId: "blob-copy",
          threadId: "thread-copy",
          size: 18,
        },
      },
    });
    const copied = await client.copyEmails({
      emailIds: ["mail-imported"],
      toAccountId: "acc-destination",
      destinationMailboxIds: ["dest-inbox"],
      keywords: ["$seen"],
    });
    expect(copied).toMatchObject({
      fromAccountId: mailAccountId,
      accountId: "acc-destination",
      created: { "copy-0": { id: "mail-copy" } },
      notCreated: {},
    });
    expect(server.getCalls("Email/copy")[0]?.args).toEqual({
      fromAccountId: mailAccountId,
      accountId: "acc-destination",
      create: {
        "copy-0": {
          id: "mail-imported",
          mailboxIds: { "dest-inbox": true },
          keywords: { $seen: true },
        },
      },
      onSuccessDestroyOriginal: false,
    });
  });

  it("sends to direct address through Email/set + EmailSubmission/set", async () => {
    const { client, mailAccountId, submissionAccountId } = await bootstrapClient(server);
    server.enqueueMethod("Email/set", {
      created: {
        createEmail: {
          id: "mail-out-1",
          threadId: "thread-out-1",
        },
      },
    });
    server.enqueueMethod("EmailSubmission/set", {
      created: {
        submitEmail: {
          id: "submission-1",
        },
      },
    });

    const result = await client.sendToAddress({
      toEmail: "Alice@Example.com",
      text: "Hello from OpenClaw",
    });

    expect(result).toEqual({
      messageId: "mail-out-1",
      threadId: "thread-out-1",
    });

    const emailSetCall = server.getCalls("Email/set")[0];
    const createEmail = emailSetCall ? readCreateEmail(emailSetCall) : {};
    expect(emailSetCall?.args).toMatchObject({
      accountId: mailAccountId,
    });
    expect(createEmail).toMatchObject({
      subject: "OpenClaw",
      to: [{ email: "alice@example.com" }],
      from: [{ email: "bot@example.com", name: "OpenClaw Bot" }],
      mailboxIds: { "mbox-drafts": true },
      keywords: { $draft: true },
      "header:Auto-Submitted:asText": "auto-generated",
      "header:X-Auto-Response-Suppress:asText": "All",
    });
    const bodyValues = createEmail.bodyValues as Record<string, { value?: string }>;
    expect(bodyValues?.["body-1"]?.value).toBe("Hello from OpenClaw");

    const submissionCall = server.getCalls("EmailSubmission/set")[0];
    expect(submissionCall?.args).toMatchObject({
      accountId: submissionAccountId,
      create: {
        submitEmail: {
          emailId: "mail-out-1",
          identityId: "identity-1",
        },
      },
      onSuccessUpdateEmail: {
        "#submitEmail": {
          "mailboxIds/mbox-drafts": null,
          "mailboxIds/mbox-sent": true,
          "keywords/$draft": null,
        },
      },
    });
  });

  it("sends to thread with reply headers and media attachment block", async () => {
    const { client } = await bootstrapClient(server);
    server.enqueueMethod("Email/set", {
      created: {
        createEmail: {
          id: "mail-out-2",
          threadId: "thread-1",
        },
      },
    });
    server.enqueueMethod("EmailSubmission/set", {
      created: {
        submitEmail: {
          id: "submission-2",
        },
      },
    });
    const thread: JmapThreadContext = {
      accountId: client.state.mailAccountId,
      threadId: "thread-1",
      latestEmailId: "mail-2",
      latestMessageId: "m-latest",
      subject: "Build status",
      from: [{ email: "alice@example.com", name: "Alice" }],
      to: [{ email: "to@example.com", name: "To" }],
      cc: [{ email: "cc@example.com", name: "CC" }],
      replyTo: [{ email: "reply@example.com", name: "Reply" }],
      references: ["m-root", "m-first"],
    };

    const result = await client.sendToThread({
      thread,
      text: "Reply body",
      mediaUrls: ["https://example.com/screenshot.png"],
    });

    expect(result).toEqual({
      messageId: "mail-out-2",
      threadId: "thread-1",
    });

    const emailSetCall = server.getCalls("Email/set")[0];
    const createEmail = emailSetCall ? readCreateEmail(emailSetCall) : {};
    expect(createEmail).toMatchObject({
      to: [{ email: "reply@example.com", name: "Reply" }],
      cc: [{ email: "cc@example.com", name: "CC" }],
      subject: "Re: Build status",
      inReplyTo: ["m-latest"],
      references: ["m-root", "m-first"],
    });
    const bodyValues = createEmail.bodyValues as Record<string, { value?: string }>;
    expect(bodyValues?.["body-1"]?.value).toContain("Reply body");
    expect(bodyValues?.["body-1"]?.value).toContain(
      "Attachment: https://example.com/screenshot.png",
    );
  });

  it("replies to sender address when replyTo is empty and thread.to is self", async () => {
    const { client } = await bootstrapClient(server);
    server.enqueueMethod("Email/set", {
      created: {
        createEmail: {
          id: "mail-out-3",
          threadId: "thread-2",
        },
      },
    });
    server.enqueueMethod("EmailSubmission/set", {
      created: {
        submitEmail: {
          id: "submission-3",
        },
      },
    });
    const thread: JmapThreadContext = {
      accountId: client.state.mailAccountId,
      threadId: "thread-2",
      latestEmailId: "mail-10",
      latestMessageId: "m-10",
      subject: "Question",
      from: [{ email: "chenk85@gmail.com", name: "Kai Chen" }],
      to: [{ email: "bot@example.com", name: "OpenClaw Bot" }],
      cc: [],
      replyTo: [],
      references: ["m-9"],
    };

    await client.sendToThread({
      thread,
      text: "收到，稍后处理",
    });

    const emailSetCall = server.getCalls("Email/set")[0];
    const createEmail = emailSetCall ? readCreateEmail(emailSetCall) : {};
    expect(createEmail).toMatchObject({
      to: [{ email: "chenk85@gmail.com", name: "Kai Chen" }],
      subject: "Re: Question",
    });
  });

  it("raises method errors for JMAP error responses", async () => {
    const { client } = await bootstrapClient(server);
    server.enqueueError("Email/queryChanges", {
      type: "cannotCalculateChanges",
      description: "query state is too old",
    });

    const promise = client.queryInboxChanges("q-old");

    await expect(promise).rejects.toMatchObject({
      type: "cannotCalculateChanges",
    });
  });
});
