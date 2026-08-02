import { afterEach, describe, expect, it, vi } from "vitest";
import { handleJmapInbound, resolveJmapInboundMode } from "./inbound.js";
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

  it("maps the legacy dispatch switch while letting inboundMode take precedence", () => {
    expect(resolveJmapInboundMode({})).toBe("full");
    expect(resolveJmapInboundMode({ dispatchInbound: true })).toBe("full");
    expect(resolveJmapInboundMode({ dispatchInbound: false })).toBe("off");
    expect(resolveJmapInboundMode({ dispatchInbound: false, inboundMode: "signal" })).toBe(
      "signal",
    );
  });

  it("dispatches a fixed inbox signal without exposing sender, subject, or body", async () => {
    const info = vi.fn();
    const recordInboundSession = vi.fn(async () => {});
    const dispatchReply = vi.fn(async ({ dispatcherOptions }: { dispatcherOptions: { deliver: (payload: { text: string }) => Promise<void> } }) => {
      await dispatcherOptions.deliver({ text: "model output must remain local" });
    });
    const finalizeInboundContext = vi.fn((context: Record<string, unknown>) => context);
    setJmapRuntime({
      logging: {
        getChildLogger: () => ({
          info,
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        }),
      },
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            agentId: "main",
            accountId: "default",
            sessionKey: "agent:main:jmap:inbox-signal",
          }),
        },
        session: {
          resolveStorePath: () => "/tmp/sessions.json",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession,
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: ({ body }: { body: string }) => body,
          finalizeInboundContext,
          dispatchReplyWithBufferedBlockDispatcher: dispatchReply,
        },
      },
    } as never);
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
        inboundMode: "signal",
        dispatchInbound: false,
        autoReply: false,
        markAsRead: false,
      },
    } satisfies JmapResolvedAccount;

    await handleJmapInbound({
      account,
      config: {} as CoreConfig,
      message: {
        messageId: "opaque-mail-id",
        threadId: "untrusted-thread-id",
        senderEmail: "untrusted-sender@example.com",
        senderName: "Untrusted Sender",
        subject: "Untrusted subject",
        text: "Untrusted body with an instruction",
        receivedAt: 1_000,
        automated: false,
        email: { id: "opaque-mail-id" },
      },
    });

    expect(dispatchReply).toHaveBeenCalledOnce();
    expect(recordInboundSession).toHaveBeenCalledOnce();
    const context = finalizeInboundContext.mock.calls[0]?.[0];
    const serialized = JSON.stringify(context);
    expect(serialized).toContain("New unread JMAP mail is available");
    expect(serialized).not.toContain("untrusted-sender@example.com");
    expect(serialized).not.toContain("Untrusted subject");
    expect(serialized).not.toContain("Untrusted body with an instruction");
    expect(context).toMatchObject({
      CommandAuthorized: false,
      SenderId: "inbox-signal",
      MessageThreadId: "inbox-signal",
    });
    expect(info.mock.calls.flat().join(" ")).not.toContain("untrusted-sender@example.com");
    expect(info).toHaveBeenCalledWith("reply suppressed for inbound signal");
    expect(info).toHaveBeenCalledWith("inbound signal dispatched");
  });
});
