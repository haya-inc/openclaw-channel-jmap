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

function readCreateEmail(call: JmapCapturedCall): Record<string, unknown> {
  const create = call.args.create as Record<string, unknown>;
  return (create?.createEmail as Record<string, unknown>) ?? {};
}

async function bootstrapClient(server: JmapMockServer): Promise<Bootstrapped> {
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
          [JMAP_SUBMISSION]: {},
        },
      },
    },
  });
  server.enqueueMethod("Mailbox/get", {
    list: [
      { id: "mbox-inbox", role: "inbox", name: "Inbox" },
      { id: "mbox-sent", role: "sent", name: "Sent" },
      { id: "mbox-drafts", role: "drafts", name: "Drafts" },
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
    expect(server.getCalls("Identity/get")).toHaveLength(1);
    const identityGet = server.getCalls("Identity/get")[0];
    expect(identityGet?.args).toMatchObject({
      properties: ["id", "email", "name", "replyTo", "bcc"],
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

  it("keeps Mail-only accounts readable and fails sending before creating a draft", async () => {
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
