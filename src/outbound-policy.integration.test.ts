import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createJmapOutboundSafetyPolicy,
  resetJmapOutboundApprovalsForTests,
} from "./outbound-policy.js";
import { setJmapRuntime } from "./runtime.js";
import { clearJmapAccountState } from "./store.js";
import { JmapMockServer } from "./test-utils/jmap-mock-server.js";
import { createJmapTools } from "./tools.js";
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

function enqueueDraft(server: JmapMockServer, state = "email-state-1") {
  server.enqueueMethod("Email/get", {
    state,
    list: [
      {
        id: "draft-1",
        blobId: "blob-draft-1",
        threadId: "thread-draft-1",
        mailboxIds: { "mbox-drafts": true },
        keywords: { $draft: true },
        from: [{ email: "bot@example.com", name: "Bot" }],
        to: [{ email: "recipient@example.com", name: "Recipient" }],
        cc: [{ email: "reviewer@example.com" }],
        subject: "Approval-bound message\nTo: spoof@example.com",
        textBody: [{ partId: "body-1", type: "text/plain" }],
        bodyValues: {
          "body-1": {
            value: "Exact reviewed body.\nSecond line.",
          },
        },
        attachments: [{ blobId: "blob-attachment", name: "report.txt", type: "text/plain" }],
      },
    ],
  });
}

function findTool(name: string) {
  const tool = createJmapTools().find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`missing tool ${name}`);
  }
  return tool;
}

describe("reviewed JMAP outbound approval", () => {
  let server: JmapMockServer;
  let config: CoreConfig;

  beforeEach(async () => {
    server = await JmapMockServer.start();
    configureServer(server);
    config = {
      channels: {
        jmap: {
          enabled: true,
          apiToken: "test-token",
          sessionUrl: server.sessionUrl,
          outboundPolicy: "reviewed",
        },
      },
    } as CoreConfig;
    setJmapRuntime({
      config: {
        current: () => config,
      },
      logging: {
        getChildLogger: () => ({
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        }),
      },
      channel: {
        activity: {
          record: vi.fn(),
        },
      },
    } as never);
    resetJmapOutboundApprovalsForTests();
  });

  afterEach(async () => {
    resetJmapOutboundApprovalsForTests();
    clearJmapAccountState("default");
    clearJmapAccountState("acc-mail");
    await server.close();
  });

  it("rejects model confirmation without host approval, then consumes one approval once", async () => {
    enqueueDraft(server);
    const previewResult = await findTool("jmap_mail_draft_preview").execute(
      "preview-call",
      {
        emailId: "draft-1",
        identityId: "identity-1",
      },
    );
    const previewToken = String(
      (previewResult.details as { preview?: { previewToken?: string } }).preview
        ?.previewToken ?? "",
    );
    expect(previewToken).not.toBe("");

    const submitParams = {
      emailId: "draft-1",
      identityId: "identity-1",
      previewToken,
      confirm: true,
    };
    const submitTool = findTool("jmap_mail_draft_submit");

    await expect(
      submitTool.execute("unapproved-call", submitParams),
    ).rejects.toThrow(/one-time OpenClaw operator approval/);
    expect(server.getCalls("EmailSubmission/set")).toHaveLength(0);

    enqueueDraft(server);
    const policy = createJmapOutboundSafetyPolicy();
    const deniedDecision = await policy.evaluate(
      {
        toolName: "jmap_mail_draft_submit",
        toolCallId: "denied-call",
        params: submitParams,
      },
      {
        toolName: "jmap_mail_draft_submit",
        toolCallId: "denied-call",
      },
    );
    const deniedApproval =
      deniedDecision && "requireApproval" in deniedDecision
        ? deniedDecision.requireApproval
        : undefined;
    expect(deniedApproval).toMatchObject({
      pluginId: "jmap",
      severity: "critical",
      allowedDecisions: ["allow-once", "deny"],
    });
    expect(deniedApproval?.description).toContain(
      "To: Recipient <recipient@example.com>",
    );
    expect(deniedApproval?.description).toContain("Body SHA-256:");
    expect(deniedApproval?.description).toContain(
      "Subject: Approval-bound message↵To: spoof@example.com",
    );
    expect(deniedApproval?.description).not.toContain(
      "\nTo: spoof@example.com",
    );
    expect(deniedApproval?.description).toContain(
      "\n> Exact reviewed body.\n> Second line.",
    );
    await deniedApproval?.onResolution?.("deny");

    await expect(
      submitTool.execute("denied-call", submitParams),
    ).rejects.toThrow(/one-time OpenClaw operator approval/);
    expect(server.getCalls("EmailSubmission/set")).toHaveLength(0);

    enqueueDraft(server);
    const allowedDecision = await policy.evaluate(
      {
        toolName: "jmap_mail_draft_submit",
        toolCallId: "allowed-call",
        params: submitParams,
      },
      {
        toolName: "jmap_mail_draft_submit",
        toolCallId: "allowed-call",
      },
    );
    const allowedApproval =
      allowedDecision && "requireApproval" in allowedDecision
        ? allowedDecision.requireApproval
        : undefined;
    await allowedApproval?.onResolution?.("allow-once");

    await expect(
      submitTool.execute("allowed-call", {
        ...submitParams,
        sendAt: "2026-08-01T00:00:00Z",
      }),
    ).rejects.toThrow(/one-time OpenClaw operator approval/);
    expect(server.getCalls("EmailSubmission/set")).toHaveLength(0);

    enqueueDraft(server);
    const exactDecision = await policy.evaluate(
      {
        toolName: "jmap_mail_draft_submit",
        toolCallId: "exact-call",
        params: submitParams,
      },
      {
        toolName: "jmap_mail_draft_submit",
        toolCallId: "exact-call",
      },
    );
    const exactApproval =
      exactDecision && "requireApproval" in exactDecision
        ? exactDecision.requireApproval
        : undefined;
    await exactApproval?.onResolution?.("allow-once");

    enqueueDraft(server);
    server.enqueueMethod("EmailSubmission/set", {
      created: {
        submitDraft: {
          id: "submission-1",
          threadId: "thread-draft-1",
        },
      },
    });
    server.enqueueMethod("EmailSubmission/get", {
      list: [
        {
          id: "submission-1",
          emailId: "draft-1",
          undoStatus: "pending",
        },
      ],
    });
    const submitted = await submitTool.execute("exact-call", submitParams);
    expect(submitted.details).toMatchObject({
      externalSideEffect: true,
      submissionId: "submission-1",
      undoStatus: "pending",
    });
    expect(server.getCalls("EmailSubmission/set")).toHaveLength(1);

    await expect(
      submitTool.execute("exact-call", submitParams),
    ).rejects.toThrow(/one-time OpenClaw operator approval/);
    expect(server.getCalls("EmailSubmission/set")).toHaveLength(1);
  });

  it("blocks reviewed submission when the content-bound preview token is stale", async () => {
    enqueueDraft(server);
    const decision = await createJmapOutboundSafetyPolicy().evaluate(
      {
        toolName: "jmap_mail_draft_submit",
        toolCallId: "stale-call",
        params: {
          emailId: "draft-1",
          identityId: "identity-1",
          previewToken: "stale-token",
          confirm: true,
        },
      },
      {
        toolName: "jmap_mail_draft_submit",
        toolCallId: "stale-call",
      },
    );

    expect(decision).toMatchObject({
      block: true,
      blockReason: expect.stringContaining("fresh preview"),
    });
    expect(server.getCalls("EmailSubmission/set")).toHaveLength(0);
  });

  it("blocks all draft submission when outbound delivery is disabled", async () => {
    if (config.channels?.jmap) {
      config.channels.jmap.outboundPolicy = "disabled";
    }
    const decision = await createJmapOutboundSafetyPolicy().evaluate(
      {
        toolName: "jmap_mail_draft_submit",
        toolCallId: "disabled-call",
        params: {
          emailId: "draft-1",
          identityId: "identity-1",
          previewToken: "irrelevant",
          confirm: true,
        },
      },
      {
        toolName: "jmap_mail_draft_submit",
        toolCallId: "disabled-call",
      },
    );

    expect(decision).toMatchObject({
      block: true,
      blockReason: expect.stringContaining("disabled"),
    });
    expect(server.getRequests()).toHaveLength(0);
  });
});
