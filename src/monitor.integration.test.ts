import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleJmapInboundMock: vi.fn(async () => {}),
  sleepMock: vi.fn(() => new Promise<void>(() => {})),
}));

vi.mock("./inbound.js", () => ({
  handleJmapInbound: mocks.handleJmapInboundMock,
}));

vi.mock("openclaw/plugin-sdk", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk")>("openclaw/plugin-sdk");
  return {
    ...actual,
    sleep: mocks.sleepMock,
  };
});

import type { CoreConfig } from "./types.js";
import { JMAP_MAIL, JMAP_SUBMISSION } from "./types.js";
import { monitorJmapProvider } from "./monitor.js";
import { setJmapRuntime } from "./runtime.js";
import { clearJmapAccountState } from "./store.js";
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
    list: [{ id: "mbox-inbox", role: "inbox" }],
  });
  server.enqueueMethod("Identity/get", {
    list: [{ id: "identity-1", email: "bot@example.com", isDefault: true }],
  });
}

function enqueuePollChain(params: {
  server: JmapMockServer;
  queryState: string;
  startupUnreadIds: string[];
  queryChangesAddedIds: string[];
  queryChangesUnreadIds: string[];
  emails?: Array<Record<string, unknown>>;
  markedSeenEmailIds?: string[];
}) {
  const {
    server,
    queryState,
    startupUnreadIds,
    queryChangesAddedIds,
    queryChangesUnreadIds,
    emails,
    markedSeenEmailIds,
  } = params;

  server.enqueueMethod("Email/query", {
    queryState,
  });
  server.enqueueMethod("Email/query", {
    queryState: `${queryState}-startup-unread`,
    ids: startupUnreadIds,
  });

  if ((emails ?? []).length > 0) {
    server.enqueueMethod("Email/get", {
      list: emails,
    });
  }

  const seenIds = (markedSeenEmailIds ?? []).map((id) => id.trim()).filter(Boolean);
  if (seenIds.length > 0) {
    server.enqueueMethod("Email/set", {
      updated: Object.fromEntries(seenIds.map((id) => [id, null])),
    });
  }

  server.enqueueMethod("Email/queryChanges", {
    oldQueryState: queryState,
    newQueryState: `${queryState}-next`,
    added: queryChangesAddedIds.map((id, index) => ({ id, index })),
    hasMoreChanges: false,
  });

  if (queryChangesAddedIds.length > 0) {
    server.enqueueMethod("Email/query", {
      queryState: `${queryState}-changes-unread`,
      ids: queryChangesUnreadIds,
    });
  }
}

describe("monitorJmapProvider polling chain", () => {
  let server: JmapMockServer;
  let stateDir: string;

  beforeEach(async () => {
    server = await JmapMockServer.start();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-jmap-monitor-"));
    mocks.handleJmapInboundMock.mockClear();
    mocks.sleepMock.mockClear();
  });

  afterEach(async () => {
    clearJmapAccountState("default");
    clearJmapAccountState("acc-mail");
    await server.close();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  function configureRuntime(config: CoreConfig, activityRecord: ReturnType<typeof vi.fn>) {
    setJmapRuntime({
      config: {
        loadConfig: () => config,
      },
      logging: {
        getChildLogger: () => ({
          warn: vi.fn(),
          error: vi.fn(),
          info: vi.fn(),
          debug: vi.fn(),
        }),
      },
      channel: {
        activity: {
          record: activityRecord,
        },
      },
      state: {
        resolveStateDir: () => stateDir,
      },
    } as never);
  }

  it("dispatches inbound handling for new non-self unread email", async () => {
    enqueueInitChain(server);
    enqueuePollChain({
      server,
      queryState: "q-1",
      startupUnreadIds: ["mail-self", "mail-inbound"],
      queryChangesAddedIds: ["mail-self", "mail-inbound"],
      queryChangesUnreadIds: ["mail-self", "mail-inbound"],
      emails: [
        {
          id: "mail-self",
          threadId: "thread-1",
          from: [{ email: "bot@example.com", name: "OpenClaw Bot" }],
          to: [{ email: "alice@example.com", name: "Alice" }],
          preview: "self echo",
          receivedAt: "2026-02-16T05:20:00.000Z",
        },
        {
          id: "mail-inbound",
          threadId: "thread-1",
          from: [{ email: "alice@example.com", name: "Alice" }],
          to: [{ email: "bot@example.com", name: "OpenClaw Bot" }],
          preview: "hello from alice",
          receivedAt: "2026-02-16T05:21:00.000Z",
        },
      ],
      markedSeenEmailIds: ["mail-inbound"],
    });
    const config = createConfig(server);
    const activityRecord = vi.fn();
    const statusSink = vi.fn();
    configureRuntime(config, activityRecord);

    const monitor = await monitorJmapProvider({
      config,
      statusSink,
    });

    await vi.waitFor(() => {
      expect(mocks.handleJmapInboundMock).toHaveBeenCalledTimes(1);
    });

    const [call] = mocks.handleJmapInboundMock.mock.calls[0] as Array<{
      message: {
        messageId: string;
        threadId: string;
        senderEmail: string;
        text: string;
      };
    }>;
    expect(call.message).toMatchObject({
      messageId: "mail-inbound",
      threadId: "thread-1",
      senderEmail: "alice@example.com",
      text: "hello from alice",
    });

    expect(activityRecord).toHaveBeenCalledTimes(1);
    expect(activityRecord).toHaveBeenCalledWith({
      channel: "jmap-email",
      accountId: "default",
      direction: "inbound",
      at: expect.any(Number),
    });
    expect(statusSink).toHaveBeenCalledWith({ lastError: null });
    expect(server.pendingResponses).toBe(0);
    expect(server.getCalls("Email/query")).toHaveLength(3);
    expect(server.getCalls("Email/get")).toHaveLength(1);
    const markSeenCall = server.getCalls("Email/set")[0];
    expect(markSeenCall?.args).toMatchObject({
      update: {
        "mail-inbound": {
          keywords: {
            $seen: true,
          },
        },
      },
    });

    monitor.stop();
  });

  it("dedupes unread email ids across gateway restarts using local state", async () => {
    const config = createConfig(server);
    const activityRecord = vi.fn();
    configureRuntime(config, activityRecord);

    enqueueInitChain(server);
    enqueuePollChain({
      server,
      queryState: "q-first",
      startupUnreadIds: ["mail-inbound"],
      queryChangesAddedIds: ["mail-inbound"],
      queryChangesUnreadIds: ["mail-inbound"],
      emails: [
        {
          id: "mail-inbound",
          threadId: "thread-1",
          from: [{ email: "alice@example.com", name: "Alice" }],
          to: [{ email: "bot@example.com", name: "OpenClaw Bot" }],
          preview: "hello from alice",
          receivedAt: "2026-02-16T05:21:00.000Z",
        },
      ],
      markedSeenEmailIds: ["mail-inbound"],
    });

    const firstMonitor = await monitorJmapProvider({ config });
    await vi.waitFor(() => {
      expect(mocks.handleJmapInboundMock).toHaveBeenCalledTimes(1);
    });
    firstMonitor.stop();

    enqueueInitChain(server);
    enqueuePollChain({
      server,
      queryState: "q-second",
      startupUnreadIds: ["mail-inbound"],
      queryChangesAddedIds: ["mail-inbound"],
      queryChangesUnreadIds: ["mail-inbound"],
    });

    const secondMonitor = await monitorJmapProvider({ config });
    await vi.waitFor(() => {
      expect(server.getCalls("Email/queryChanges")).toHaveLength(2);
      expect(server.getCalls("Email/query")).toHaveLength(6);
    });

    expect(mocks.handleJmapInboundMock).toHaveBeenCalledTimes(1);
    expect(server.getCalls("Email/get")).toHaveLength(1);
    expect(server.getCalls("Email/set")).toHaveLength(1);

    secondMonitor.stop();
  });
});
