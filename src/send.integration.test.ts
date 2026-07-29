import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "./types.js";
import { JMAP_MAIL, JMAP_SUBMISSION } from "./types.js";
import { JmapMethodError } from "./jmap-client.js";
import { setJmapRuntime } from "./runtime.js";
import { clearJmapAccountState, getThreadContext } from "./store.js";
import { isRecoverableJmapPollError, sendJmapByTarget } from "./send.js";
import { JmapMockServer } from "./test-utils/jmap-mock-server.js";

function createConfig(server: JmapMockServer): CoreConfig {
  return {
    channels: {
      jmap: {
        enabled: true,
        apiToken: "test-token",
        sessionUrl: server.sessionUrl,
        pollIntervalSec: 20,
      },
    },
  } as CoreConfig;
}

function configureRuntime(config: CoreConfig, activityRecord: ReturnType<typeof vi.fn>) {
  setJmapRuntime({
    config: {
      loadConfig: () => config,
    },
    channel: {
      activity: {
        record: activityRecord,
      },
    },
  } as never);
}

function enqueueInitChain(server: JmapMockServer) {
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
        name: "OpenClaw Bot",
        isDefault: true,
      },
    ],
  });
}

describe("sendJmapByTarget chain", () => {
  let server: JmapMockServer;

  beforeEach(async () => {
    server = await JmapMockServer.start();
  });

  afterEach(async () => {
    clearJmapAccountState("default");
    clearJmapAccountState("acc-mail");
    await server.close();
  });

  it("sends direct mail target using runtime config and records outbound activity", async () => {
    enqueueInitChain(server);
    server.enqueueMethod("Email/set", {
      created: {
        createEmail: {
          id: "mail-out-1",
          threadId: "thread-100",
        },
      },
    });
    server.enqueueMethod("EmailSubmission/set", {
      created: {
        submitEmail: {
          id: "submission-100",
        },
      },
    });
    const config = createConfig(server);
    const activityRecord = vi.fn();
    configureRuntime(config, activityRecord);

    const result = await sendJmapByTarget({
      cfg: config,
      to: "Alice@Example.com",
      text: "hello world",
    });

    expect(result).toEqual({
      messageId: "mail-out-1",
      threadId: "thread-100",
      to: "alice@example.com",
    });
    expect(activityRecord).toHaveBeenCalledWith({
      channel: "jmap",
      accountId: "default",
      direction: "outbound",
    });
  });

  it("replies to thread target by resolving thread context through JMAP", async () => {
    enqueueInitChain(server);
    server.enqueueMethod("Thread/get", {
      list: [{ id: "thread-1", emailIds: ["mail-1", "mail-2"] }],
    });
    server.enqueueMethod("Email/get", {
      list: [
        {
          id: "mail-1",
          threadId: "thread-1",
          subject: "Daily report",
          from: [{ email: "alice@example.com", name: "Alice" }],
          to: [{ email: "bot@example.com", name: "OpenClaw Bot" }],
          messageId: ["m1"],
          references: ["m0"],
          receivedAt: "2026-02-16T04:10:00.000Z",
        },
        {
          id: "mail-2",
          threadId: "thread-1",
          subject: "Daily report",
          from: [{ email: "alice@example.com", name: "Alice" }],
          to: [{ email: "bot@example.com", name: "OpenClaw Bot" }],
          replyTo: [{ email: "reply@example.com", name: "Reply" }],
          messageId: ["m2"],
          references: ["m0", "m1"],
          receivedAt: "2026-02-16T05:10:00.000Z",
        },
      ],
    });
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
          id: "submission-101",
        },
      },
    });
    const config = createConfig(server);
    const activityRecord = vi.fn();
    configureRuntime(config, activityRecord);

    const result = await sendJmapByTarget({
      cfg: config,
      to: "thread:Thread-1",
      text: "Thanks, received",
    });

    expect(result).toEqual({
      messageId: "mail-out-2",
      threadId: "thread-1",
      to: "thread:thread-1",
    });
    expect(server.getCalls("Thread/get")).toHaveLength(1);

    const emailSetCall = server.getCalls("Email/set")[0];
    const create = (emailSetCall?.args.create as Record<string, unknown>) ?? {};
    const createEmail = (create.createEmail as Record<string, unknown>) ?? {};
    expect(createEmail).toMatchObject({
      subject: "Re: Daily report",
      to: [{ email: "reply@example.com", name: "Reply" }],
      inReplyTo: ["m2"],
      references: ["m0", "m1", "m2"],
    });
    const cachedContext = getThreadContext({
      accountId: "acc-mail",
      threadId: "thread-1",
    });
    expect(cachedContext?.latestMessageId).toBe("m2");
  });

  it("flags recoverable polling errors", () => {
    expect(
      isRecoverableJmapPollError(
        new JmapMethodError("cannotCalculateChanges", "query state is too old"),
      ),
    ).toBe(true);
    expect(
      isRecoverableJmapPollError(new JmapMethodError("stateMismatch", "state mismatch")),
    ).toBe(true);
    expect(isRecoverableJmapPollError(new JmapMethodError("serverFail", "boom"))).toBe(false);
    expect(isRecoverableJmapPollError(new Error("boom"))).toBe(false);
  });
});
