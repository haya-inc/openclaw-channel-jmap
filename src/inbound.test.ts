import { afterEach, describe, expect, it, vi } from "vitest";
import { handleJmapInbound } from "./inbound.js";
import { setJmapRuntime } from "./runtime.js";
import { getJmapRuntimeStatus, resetJmapRuntimeStatusForTests } from "./status.js";
import type { CoreConfig, JmapResolvedAccount } from "./types.js";

afterEach(() => {
  resetJmapRuntimeStatusForTests();
});

describe("handleJmapInbound passive mode", () => {
  it("records inbound mail without starting an agent turn when dispatchInbound is false", async () => {
    const info = vi.fn();
    setJmapRuntime({
      logging: {
        getChildLogger: () => ({
          info,
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        }),
      },
    } as never);
    const statusSink = vi.fn();
    const account = {
      accountId: "default",
      configured: true,
      enabled: true,
      authMode: "basic",
      username: "agent@example.com",
      token: "test-password",
      tokenSource: "config",
      sessionUrl: "https://mail.example.test/.well-known/jmap",
      pollIntervalSec: 20,
      config: {
        dispatchInbound: false,
        dmPolicy: "open",
        allowFrom: ["*"],
        autoReply: false,
        markAsRead: false,
      },
    } satisfies JmapResolvedAccount;

    await handleJmapInbound({
      account,
      config: {} as CoreConfig,
      statusSink,
      message: {
        messageId: "mail-1",
        threadId: "thread-1",
        senderEmail: "outside@example.com",
        senderName: "Outside Sender",
        subject: "Untrusted subject",
        text: "Untrusted body",
        receivedAt: 1_000,
        automated: false,
        email: {
          id: "mail-1",
          threadId: "thread-1",
        },
      },
    });

    expect(getJmapRuntimeStatus("default")).toMatchObject({
      lastInboundAt: expect.any(Number),
      lastInboundMessageAt: 1_000,
      inboundCount: 1,
      outboundCount: 0,
    });
    expect(statusSink).toHaveBeenCalledWith({
      lastInboundAt: expect.any(Number),
    });
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("inbound dispatch suppressed"),
    );
  });
});
