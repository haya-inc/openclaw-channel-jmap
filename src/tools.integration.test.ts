import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "openclaw/plugin-sdk/core";
import { setJmapRuntime } from "./runtime.js";
import {
  getJmapRuntimeStatus,
  resetJmapRuntimeStatusForTests,
} from "./status.js";
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

function findTool(tools: AnyAgentTool[], name: string): AnyAgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`missing test tool: ${name}`);
  }
  return tool;
}

describe("JMAP agent tools full chain", () => {
  let server: JmapMockServer;
  let config: CoreConfig;
  let info: ReturnType<typeof vi.fn>;

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
    setJmapRuntime({
      config: {
        loadConfig: () => config,
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
          record: vi.fn(),
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

  it("executes all five model-visible tools and records anonymous usage telemetry", async () => {
    const tools = createJmapTools();

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

    server.enqueueMethod("Email/get", {
      list: [
        {
          id: "mail-1",
          threadId: "thread-1",
          from: [{ email: "alice@example.com" }],
          subject: "Status",
          textBody: [{ partId: "body-1", type: "text/plain" }],
          bodyValues: { "body-1": { value: "Full body" } },
        },
      ],
    });
    const get = await findTool(tools, "jmap_mail_get").execute("call-get", {
      emailId: "mail-1",
    });
    expect(get.details).toMatchObject({
      email: { id: "mail-1", body: "Full body", truncated: false },
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

    expect(getJmapRuntimeStatus("default")).toMatchObject({
      lastToolName: "jmap_mail_update",
      toolCallCount: 5,
      toolErrorCount: 0,
      outboundCount: 1,
      lastOutboundAt: expect.any(Number),
      lastToolSucceededAt: expect.any(Number),
    });
    expect(
      info.mock.calls.filter(([line]) =>
        String(line).startsWith("tool invocation succeeded name=jmap_mail_"),
      ),
    ).toHaveLength(5);
    expect(server.pendingResponses).toBe(0);
  });
});
