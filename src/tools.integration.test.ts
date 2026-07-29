import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "openclaw/plugin-sdk/core";
import { setJmapRuntime } from "./runtime.js";
import {
  getJmapRuntimeStatus,
  resetJmapRuntimeStatusForTests,
} from "./status.js";
import { clearJmapAccountState } from "./store.js";
import { JmapMockServer } from "./test-utils/jmap-mock-server.js";
import { createJmapTools, JMAP_TOOL_NAMES } from "./tools.js";
import type { CoreConfig } from "./types.js";
import { JMAP_MAIL, JMAP_SUBMISSION } from "./types.js";

function configureServer(server: JmapMockServer) {
  server.setSession({
    username: "bot@example.com",
    primaryAccounts: {
      [JMAP_MAIL]: "acc-mail",
      [JMAP_SUBMISSION]: "acc-submission",
    },
    accounts: {
      "acc-mail": {
        accountCapabilities: {
          [JMAP_MAIL]: {},
        },
      },
      "acc-submission": {
        accountCapabilities: {
          [JMAP_SUBMISSION]: {},
        },
      },
    },
  });
  server.enqueueMethod("Mailbox/get", {
    list: [
      { id: "mbox-inbox", role: "inbox" },
      { id: "mbox-sent", role: "sent" },
      { id: "mbox-drafts", role: "drafts" },
    ],
  });
  server.enqueueMethod("Identity/get", {
    list: [{ id: "identity-1", email: "bot@example.com", name: "Bot" }],
  });
}

function findTool(tools: AnyAgentTool[], name: string): AnyAgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`missing test tool: ${name}`);
  }
  return tool;
}

function enqueueToolDraft(
  server: JmapMockServer,
  emailId: string,
  state: string,
  overrides: Record<string, unknown> = {},
) {
  server.enqueueMethod("Email/get", {
    state,
    list: [
      {
        id: emailId,
        blobId: `blob-${emailId}`,
        threadId: `thread-${emailId}`,
        mailboxIds: { "mbox-drafts": true },
        keywords: { $draft: true },
        from: [{ email: "bot@example.com", name: "Bot" }],
        to: [{ email: "recipient@example.com" }],
        subject: "Safe draft",
        textBody: [{ partId: "body-1", type: "text/plain" }],
        bodyValues: { "body-1": { value: "Review before sending" } },
        attachments: [],
        ...overrides,
      },
    ],
  });
}

describe("JMAP agent tools full chain", () => {
  let server: JmapMockServer;
  let config: CoreConfig;
  let info: ReturnType<typeof vi.fn>;
  let activityRecord: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    server = await JmapMockServer.start();
    configureServer(server);
    config = {
      channels: {
        jmap: {
          enabled: true,
          apiToken: "test-token",
          sessionUrl: server.sessionUrl,
        },
      },
    } as CoreConfig;
    info = vi.fn();
    activityRecord = vi.fn();
    setJmapRuntime({
      config: {
        current: () => config,
      },
      logging: {
        getChildLogger: () => ({
          info,
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        }),
      },
      channel: {
        activity: {
          record: activityRecord,
        },
      },
    } as never);
    resetJmapRuntimeStatusForTests();
  });

  afterEach(async () => {
    clearJmapAccountState("default");
    clearJmapAccountState("acc-mail");
    resetJmapRuntimeStatusForTests();
    await server.close();
  });

  it("keeps implementation, registration, and manifest tool contracts aligned", () => {
    const implementationNames = createJmapTools().map((tool) => tool.name);
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { contracts?: { tools?: string[] } };

    expect(implementationNames).toHaveLength(21);
    expect(implementationNames).toEqual([...JMAP_TOOL_NAMES]);
    expect(manifest.contracts?.tools).toEqual(implementationNames);
  });

  it("executes the original nine model-visible tools and records anonymous usage telemetry", async () => {
    const tools = createJmapTools();

    const mailboxes = await findTool(tools, "jmap_mail_mailboxes").execute(
      "call-mailboxes",
      {},
    );
    expect(mailboxes.details).toMatchObject({
      accountId: "default",
      mailboxes: [
        { id: "mbox-inbox", role: "inbox" },
        { id: "mbox-sent", role: "sent" },
        { id: "mbox-drafts", role: "drafts" },
      ],
    });

    server.enqueueMethod("Identity/get", {
      list: [
        {
          id: "identity-1",
          email: "bot@example.com",
          name: "Bot",
          replyTo: [{ email: "reply@example.com" }],
          bcc: [{ email: "archive@example.com" }],
        },
      ],
    });
    const identities = await findTool(tools, "jmap_mail_identities").execute(
      "call-identities",
      {},
    );
    expect(identities.details).toMatchObject({
      accountId: "default",
      submissionAvailable: true,
      identities: [
        {
          id: "identity-1",
          email: "bot@example.com",
          name: "Bot",
          replyTo: [{ email: "reply@example.com" }],
          bcc: [{ email: "archive@example.com" }],
          selected: true,
        },
      ],
    });

    server.enqueueMethod("Email/query", {
      ids: ["mail-1"],
      queryState: "q-search",
    });
    server.enqueueMethod("Email/get", {
      list: [
        {
          id: "mail-1",
          threadId: "thread-1",
          from: [{ email: "alice@example.com", name: "Alice" }],
          to: [{ email: "bot@example.com", name: "Bot" }],
          subject: "Status",
          preview: "Search preview",
          receivedAt: "2026-07-29T08:00:00.000Z",
        },
      ],
    });
    const search = await findTool(tools, "jmap_mail_search").execute("call-search", {
      subject: "Status",
      limit: 5,
    });
    expect(search.details).toMatchObject({
      accountId: "default",
      emails: [{ id: "mail-1", subject: "Status" }],
    });
    expect(server.getCalls("Email/get")[0]?.args).toMatchObject({
      ids: ["mail-1"],
      fetchTextBodyValues: false,
      fetchHTMLBodyValues: false,
    });

    server.enqueueMethod("Email/get", {
      list: [
        {
          id: "mail-1",
          threadId: "thread-1",
          from: [{ email: "alice@example.com" }],
          subject: "Status",
          htmlBody: [{ partId: "body-1", type: "text/html" }],
          bodyValues: {
            "body-1": {
              value:
                '<p>Full body <a href="https://example.com/verify">verify</a></p>',
            },
          },
          attachments: [
            {
              blobId: "blob-1",
              name: "details.pdf",
              type: "application/pdf",
              size: 512,
            },
          ],
          hasAttachment: true,
        },
      ],
    });
    const get = await findTool(tools, "jmap_mail_get").execute("call-get", {
      emailId: "mail-1",
    });
    expect(get.details).toMatchObject({
      email: {
        id: "mail-1",
        body: "Full body verify",
        truncated: false,
        links: ["https://example.com/verify"],
        hasAttachment: true,
        attachments: [
          {
            blobId: "blob-1",
            name: "details.pdf",
            type: "application/pdf",
            size: 512,
          },
        ],
      },
    });

    server.enqueueMethod("Thread/get", {
      list: [{ id: "thread-1", emailIds: ["mail-1", "mail-2"] }],
    });
    server.enqueueMethod("Email/get", {
      list: [
        {
          id: "mail-1",
          threadId: "thread-1",
          receivedAt: "2026-07-29T08:00:00.000Z",
          preview: "First",
        },
        {
          id: "mail-2",
          threadId: "thread-1",
          receivedAt: "2026-07-29T08:01:00.000Z",
          preview: "Second",
        },
      ],
    });
    const thread = await findTool(tools, "jmap_mail_thread").execute("call-thread", {
      threadId: "thread-1",
    });
    expect(thread.details).toMatchObject({
      threadId: "thread-1",
      emails: [{ id: "mail-1" }, { id: "mail-2" }],
    });

    server.enqueueMethod("Email/set", {
      created: {
        createDraft: {
          id: "draft-1",
          threadId: "thread-draft-1",
          size: 128,
        },
      },
    });
    const draft = await findTool(tools, "jmap_mail_draft_create").execute(
      "call-draft-create",
      {
        to: ["recipient@example.com"],
        subject: "Draft",
        text: "Save this without sending",
      },
    );
    expect(draft.details).toMatchObject({
      accountId: "default",
      submitted: false,
      sent: false,
      draft: {
        emailId: "draft-1",
        identityId: "identity-1",
        draftsMailboxId: "mbox-drafts",
      },
    });
    expect(server.getCalls("EmailSubmission/set")).toHaveLength(0);

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
    const send = await findTool(tools, "jmap_mail_send").execute("call-send", {
      to: "recipient@example.com",
      subject: "Test",
      text: "Tool contract test",
    });
    expect(send.details).toMatchObject({
      accountId: "default",
      to: "recipient@example.com",
      messageId: "mail-out-1",
    });

    server.enqueueMethod("Email/set", {
      updated: {
        "mail-1": null,
      },
    });
    const update = await findTool(tools, "jmap_mail_update").execute("call-update", {
      emailIds: ["mail-1"],
      read: true,
      starred: true,
    });
    expect(update.details).toEqual({
      accountId: "default",
      updated: ["mail-1"],
    });

    server.enqueueMethod("Email/get", {
      list: [{ id: "mail-1", mailboxIds: { "mbox-inbox": true } }],
    });
    server.enqueueMethod("Email/set", {
      updated: {
        "mail-1": null,
      },
    });
    const move = await findTool(tools, "jmap_mail_move").execute("call-move", {
      emailIds: ["mail-1"],
      destination: "sent",
    });
    expect(move.details).toEqual({
      accountId: "default",
      moved: ["mail-1"],
      destination: {
        id: "mbox-sent",
        name: "",
        role: "sent",
      },
      previous: [
        {
          emailId: "mail-1",
          mailboxes: [
            {
              id: "mbox-inbox",
              name: "",
              role: "inbox",
            },
          ],
        },
      ],
    });

    expect(getJmapRuntimeStatus("default")).toMatchObject({
      lastToolName: "jmap_mail_move",
      toolCallCount: 9,
      toolErrorCount: 0,
      outboundCount: 1,
      lastOutboundAt: expect.any(Number),
      lastToolSucceededAt: expect.any(Number),
    });
    expect(
      info.mock.calls.filter(([line]) =>
        String(line).startsWith("tool invocation succeeded name=jmap_mail_"),
      ),
    ).toHaveLength(9);
    expect(server.pendingResponses).toBe(0);
  });

  it("runs preview, replacement, re-preview, explicit submit, history, cancel, and discard safely", async () => {
    const tools = createJmapTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "jmap_mail_search_snippets",
        "jmap_mail_changes",
        "jmap_mail_parse",
        "jmap_mail_blob_upload",
        "jmap_mail_import",
        "jmap_mail_copy",
        "jmap_mail_draft_preview",
        "jmap_mail_draft_update",
        "jmap_mail_draft_discard",
        "jmap_mail_draft_submit",
        "jmap_mail_submissions",
        "jmap_mail_submission_cancel",
      ]),
    );

    server.enqueueMethod("SearchSnippet/get", {
      list: [
        {
          emailId: "mail-1",
          subject: "<mark>Safe</mark> subject",
          preview: "A <mark>safe</mark> snippet",
        },
      ],
      notFound: [],
    });
    const snippets = await findTool(tools, "jmap_mail_search_snippets").execute(
      "call-snippets",
      { emailIds: ["mail-1"], text: "safe" },
    );
    expect(snippets.details).toMatchObject({
      snippets: [
        {
          emailId: "mail-1",
          subject: "Safe subject",
          preview: "A safe snippet",
        },
      ],
    });

    server.enqueueMethod("Email/changes", {
      oldState: "email-state-0",
      newState: "email-state-1",
      hasMoreChanges: false,
      created: ["mail-1"],
      updated: [],
      destroyed: [],
    });
    const changes = await findTool(tools, "jmap_mail_changes").execute(
      "call-changes",
      {
        dataType: "Email",
        sinceState: "email-state-0",
      },
    );
    expect(changes.details).toMatchObject({
      dataType: "Email",
      newState: "email-state-1",
      created: ["mail-1"],
    });

    server.enqueueMethod("Email/parse", {
      parsed: {
        "blob-message-1": {
          id: null,
          blobId: "blob-message-1",
          from: [{ email: "alice@example.com" }],
          subject: "Attached message",
          textBody: [{ partId: "body-1", type: "text/plain" }],
          bodyValues: { "body-1": { value: "Parsed body" } },
        },
      },
      notParsable: [],
      notFound: [],
    });
    const parsed = await findTool(tools, "jmap_mail_parse").execute("call-parse", {
      blobIds: ["blob-message-1"],
    });
    expect(parsed.details).toMatchObject({
      parsed: [
        {
          id: null,
          sourceBlobId: "blob-message-1",
          subject: "Attached message",
          body: "Parsed body",
          truncated: false,
        },
      ],
    });

    server.enqueueUpload({
      accountId: "acc-mail",
      blobId: "blob-uploaded",
      type: "application/pdf",
      size: 10,
    });
    const upload = await findTool(tools, "jmap_mail_blob_upload").execute(
      "call-upload",
      {
        dataBase64: Buffer.from("attachment").toString("base64"),
        mediaType: "application/pdf",
        confirm: true,
      },
    );
    expect(upload.details).toMatchObject({
      externalSideEffect: true,
      uploaded: { blobId: "blob-uploaded", type: "application/pdf" },
    });

    server.enqueueMethod("Email/import", {
      created: { "import-0": { id: "mail-imported" } },
    });
    const imported = await findTool(tools, "jmap_mail_import").execute(
      "call-import",
      {
        blobIds: ["blob-uploaded"],
        destination: "inbox",
        confirm: true,
      },
    );
    expect(imported.details).toMatchObject({
      sent: false,
      created: { "import-0": { id: "mail-imported" } },
    });

    server.enqueueMethod("Email/copy", {
      created: { "copy-0": { id: "mail-copied" } },
    });
    const copied = await findTool(tools, "jmap_mail_copy").execute(
      "call-copy",
      {
        emailIds: ["mail-imported"],
        toAccountId: "acc-destination",
        destinationMailboxIds: ["dest-inbox"],
        confirm: true,
      },
    );
    expect(copied.details).toMatchObject({
      configuredAccountId: "default",
      fromAccountId: "acc-mail",
      accountId: "acc-destination",
      destructive: false,
      created: { "copy-0": { id: "mail-copied" } },
    });

    enqueueToolDraft(server, "draft-1", "email-state-1");
    const firstPreview = await findTool(tools, "jmap_mail_draft_preview").execute(
      "call-preview-1",
      { emailId: "draft-1", identityId: "identity-1" },
    );
    const firstToken = String(
      (firstPreview.details as { preview?: { previewToken?: string } }).preview
        ?.previewToken ?? "",
    );
    expect(firstToken).toMatch(/^sha256:[a-f0-9]{64}$/);

    enqueueToolDraft(server, "draft-1", "email-state-1");
    server.enqueueMethod("Email/set", {
      newState: "email-state-2",
      created: {
        replaceDraft: {
          id: "draft-2",
          threadId: "thread-draft-2",
        },
      },
    });
    server.enqueueMethod("Email/set", {
      newState: "email-state-3",
      destroyed: ["draft-1"],
    });
    const update = await findTool(tools, "jmap_mail_draft_update").execute(
      "call-update-draft",
      {
        emailId: "draft-1",
        identityId: "identity-1",
        previewToken: firstToken,
        subject: "Reviewed draft",
        attachments: [
          {
            blobId: "blob-uploaded",
            type: "application/pdf",
            name: "attachment.pdf",
          },
        ],
      },
    );
    expect(update.details).toMatchObject({
      sent: false,
      replacement: {
        previousEmailId: "draft-1",
        emailId: "draft-2",
      },
    });

    enqueueToolDraft(server, "draft-2", "email-state-3", {
      subject: "Reviewed draft",
      attachments: [
        {
          blobId: "blob-uploaded",
          type: "application/pdf",
          name: "attachment.pdf",
          disposition: "attachment",
        },
      ],
    });
    const secondPreview = await findTool(tools, "jmap_mail_draft_preview").execute(
      "call-preview-2",
      { emailId: "draft-2", identityId: "identity-1" },
    );
    const secondToken = String(
      (secondPreview.details as { preview?: { previewToken?: string } }).preview
        ?.previewToken ?? "",
    );
    expect(secondToken).not.toBe(firstToken);

    enqueueToolDraft(server, "draft-2", "email-state-3", {
      subject: "Reviewed draft",
      attachments: [
        {
          blobId: "blob-uploaded",
          type: "application/pdf",
          name: "attachment.pdf",
          disposition: "attachment",
        },
      ],
    });
    server.enqueueMethod("EmailSubmission/set", {
      created: {
        submitDraft: {
          id: "submission-1",
          threadId: "thread-draft-2",
        },
      },
    });
    server.enqueueMethod("EmailSubmission/get", {
      list: [
        {
          id: "submission-1",
          emailId: "draft-2",
          undoStatus: "pending",
        },
      ],
    });
    const submit = await findTool(tools, "jmap_mail_draft_submit").execute(
      "call-submit-draft",
      {
        emailId: "draft-2",
        identityId: "identity-1",
        previewToken: secondToken,
        confirm: true,
      },
    );
    expect(submit.details).toMatchObject({
      externalSideEffect: true,
      submissionId: "submission-1",
      undoStatus: "pending",
      statusObserved: true,
    });
    expect(activityRecord).toHaveBeenCalledWith({
      channel: "jmap",
      accountId: "default",
      direction: "outbound",
    });

    server.enqueueMethod("EmailSubmission/query", {
      ids: ["submission-1"],
      queryState: "submission-state-1",
      total: 1,
    });
    server.enqueueMethod("EmailSubmission/get", {
      list: [{ id: "submission-1", emailId: "draft-2", undoStatus: "pending" }],
    });
    const history = await findTool(tools, "jmap_mail_submissions").execute(
      "call-submission-history",
      { undoStatus: "pending" },
    );
    expect(history.details).toMatchObject({
      total: 1,
      submissions: [{ id: "submission-1", undoStatus: "pending" }],
    });

    server.enqueueMethod("EmailSubmission/get", {
      list: [{ id: "submission-1", undoStatus: "pending" }],
    });
    server.enqueueMethod("EmailSubmission/set", {
      updated: { "submission-1": null },
    });
    server.enqueueMethod("EmailSubmission/get", {
      list: [{ id: "submission-1", undoStatus: "canceled" }],
    });
    const canceled = await findTool(tools, "jmap_mail_submission_cancel").execute(
      "call-cancel-submission",
      { submissionId: "submission-1", confirm: true },
    );
    expect(canceled.details).toMatchObject({
      canceled: true,
      submission: { id: "submission-1", undoStatus: "canceled" },
    });

    enqueueToolDraft(server, "draft-3", "email-state-4");
    const discardPreview = await findTool(tools, "jmap_mail_draft_preview").execute(
      "call-preview-discard",
      { emailId: "draft-3", identityId: "identity-1" },
    );
    const discardToken = String(
      (discardPreview.details as { preview?: { previewToken?: string } }).preview
        ?.previewToken ?? "",
    );
    enqueueToolDraft(server, "draft-3", "email-state-4");
    server.enqueueMethod("Email/set", {
      newState: "email-state-5",
      destroyed: ["draft-3"],
    });
    const discarded = await findTool(tools, "jmap_mail_draft_discard").execute(
      "call-discard-draft",
      {
        emailId: "draft-3",
        identityId: "identity-1",
        previewToken: discardToken,
        confirm: true,
      },
    );
    expect(discarded.details).toMatchObject({
      discarded: true,
      emailId: "draft-3",
      sent: false,
    });
    expect(server.pendingResponses).toBe(0);
  });
});
