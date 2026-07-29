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

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    sleep: mocks.sleepMock,
  };
});

import type { CoreConfig } from "./types.js";
import { JMAP_MAIL, JMAP_SUBMISSION } from "./types.js";
import { monitorJmapProvider } from "./monitor.js";
import { setJmapRuntime } from "./runtime.js";
import { getJmapRuntimeStatus, resetJmapRuntimeStatusForTests } from "./status.js";
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
        markAsRead: true,
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
  queryChangesAddedIds: string[];
  emails?: Array<Record<string, unknown>>;
  markedSeenEmailIds?: string[];
}) {
  const {
    server,
    queryState,
    queryChangesAddedIds,
    emails,
    markedSeenEmailIds,
  } = params;

  server.enqueueMethod("Email/query", {
    queryState,
  });
  server.enqueueMethod("Email/queryChanges", {
    oldQueryState: queryState,
    newQueryState: `${queryState}-next`,
    added: queryChangesAddedIds.map((id, index) => ({ id, index })),
    hasMoreChanges: false,
  });

  if (queryChangesAddedIds.length > 0) {
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
    resetJmapRuntimeStatusForTests();
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
        current: () => config,
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
      queryChangesAddedIds: ["mail-self", "mail-inbound"],
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
      channel: "jmap",
      accountId: "default",
      direction: "inbound",
      at: expect.any(Number),
    });
    expect(statusSink).toHaveBeenCalledWith(
      expect.objectContaining({
        lastSuccessfulPollAt: expect.any(Number),
        pollCount: 1,
        lastError: null,
      }),
    );
    expect(getJmapRuntimeStatus("default")).toMatchObject({
      lastSuccessfulPollAt: expect.any(Number),
      pollCount: 1,
      pollErrorCount: 0,
    });
    expect(server.pendingResponses).toBe(0);
    expect(server.getCalls("Email/query")).toHaveLength(1);
    expect(server.getCalls("Email/get")).toHaveLength(1);
    const markSeenCall = server.getCalls("Email/set")[0];
    expect(markSeenCall?.args).toMatchObject({
      update: {
        "mail-inbound": {
          "keywords/$seen": true,
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
      queryChangesAddedIds: ["mail-inbound"],
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
      queryChangesAddedIds: ["mail-inbound"],
    });

    const secondMonitor = await monitorJmapProvider({ config });
    await vi.waitFor(() => {
      expect(server.getCalls("Email/queryChanges")).toHaveLength(2);
      expect(server.getCalls("Email/query")).toHaveLength(2);
    });

    expect(mocks.handleJmapInboundMock).toHaveBeenCalledTimes(1);
    expect(server.getCalls("Email/get")).toHaveLength(1);
    expect(server.getCalls("Email/set")).toHaveLength(1);

    secondMonitor.stop();
  });

  it("falls back to recent-query polling when Email/queryChanges is unavailable", async () => {
    enqueueInitChain(server);
    server.enqueueMethod("Email/query", {
      queryState: "q-initial",
      ids: [],
    });
    server.enqueueError("Email/queryChanges", {
      type: "unknownMethod",
      description: "Email/queryChanges is not implemented",
    });
    server.enqueueMethod("Email/query", {
      queryState: "q-baseline",
      ids: ["mail-existing"],
    });
    server.enqueueMethod("Email/query", {
      queryState: "q-next",
      ids: ["mail-new", "mail-existing"],
    });
    server.enqueueMethod("Email/get", {
      list: [
        {
          id: "mail-new",
          threadId: "thread-new",
          from: [{ email: "alice@example.com", name: "Alice" }],
          to: [{ email: "bot@example.com", name: "OpenClaw Bot" }],
          preview: "new through polling fallback",
          receivedAt: "2026-02-16T05:21:00.000Z",
        },
      ],
    });
    server.enqueueMethod("Email/set", {
      updated: {
        "mail-new": null,
      },
    });
    mocks.sleepMock.mockResolvedValueOnce(undefined);

    const config = createConfig(server);
    const activityRecord = vi.fn();
    configureRuntime(config, activityRecord);

    const monitor = await monitorJmapProvider({ config });

    await vi.waitFor(() => {
      expect(mocks.handleJmapInboundMock).toHaveBeenCalledTimes(1);
    });
    expect(mocks.handleJmapInboundMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          messageId: "mail-new",
        }),
      }),
    );
    expect(server.getCalls("Email/queryChanges")).toHaveLength(1);
    expect(server.getCalls("Email/query")).toHaveLength(3);
    expect(server.getCalls("Email/get")).toHaveLength(1);
    expect(server.pendingResponses).toBe(0);

    monitor.stop();
  });

  it("paginates snapshot polling until it reaches a persisted boundary", async () => {
    enqueueInitChain(server);
    const newIds = Array.from({ length: 50 }, (_, index) => `mail-new-${index}`);
    server.enqueueMethod("Email/query", {
      queryState: "q-initial",
      ids: [],
    });
    server.enqueueError("Email/queryChanges", {
      type: "unknownMethod",
    });
    server.enqueueMethod("Email/query", {
      queryState: "q-baseline",
      ids: ["mail-existing"],
    });
    server.enqueueMethod("Email/query", {
      queryState: "q-page-1",
      ids: newIds,
    });
    server.enqueueMethod("Email/query", {
      queryState: "q-page-2",
      ids: ["mail-existing"],
    });
    server.enqueueMethod("Email/get", {
      list: newIds.map((id, index) => ({
        id,
        threadId: `thread-${index}`,
        from: [{ email: "alice@example.com", name: "Alice" }],
        to: [{ email: "bot@example.com", name: "OpenClaw Bot" }],
        preview: `snapshot message ${index}`,
        receivedAt: `2026-02-16T05:21:${String(index).padStart(2, "0")}.000Z`,
      })),
    });
    mocks.sleepMock.mockResolvedValueOnce(undefined);

    const config = createConfig(server);
    config.channels!.jmap!.markAsRead = false;
    const activityRecord = vi.fn();
    configureRuntime(config, activityRecord);

    const monitor = await monitorJmapProvider({ config });

    await vi.waitFor(() => {
      expect(mocks.handleJmapInboundMock).toHaveBeenCalledTimes(50);
    });
    expect(server.getCalls("Email/queryChanges")).toHaveLength(1);
    expect(server.getCalls("Email/query")).toHaveLength(4);
    expect(server.getCalls("Email/get")).toHaveLength(1);
    expect(server.pendingResponses).toBe(0);

    monitor.stop();
  });
});
