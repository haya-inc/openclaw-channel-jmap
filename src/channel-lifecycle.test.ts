import { describe, expect, it, vi } from "vitest";

const monitorJmapProvider = vi.hoisted(() => vi.fn());

vi.mock("./monitor.js", () => ({ monitorJmapProvider }));

import { jmapPlugin } from "./channel.js";

describe("JMAP gateway lifecycle", () => {
  it("exposes poll, mail, and tool telemetry in the account snapshot", () => {
    const buildAccountSnapshot = jmapPlugin.status?.buildAccountSnapshot;
    expect(buildAccountSnapshot).toBeTypeOf("function");

    const snapshot = buildAccountSnapshot!({
      account: {
        accountId: "default",
        configured: true,
        enabled: true,
        authMode: "basic",
        username: "agent@example.com",
        tokenSource: "env",
        sessionUrl: "https://mail.example.test/.well-known/jmap",
        pollIntervalSec: 20,
        config: {
          dispatchInbound: false,
        },
      },
      runtime: {
        accountId: "default",
        running: true,
        lastStartAt: 1_000,
        lastStopAt: null,
        lastError: null,
        lastPollAt: 2_000,
        lastSuccessfulPollAt: 2_000,
        lastPollErrorAt: null,
        pollCount: 5,
        pollErrorCount: 0,
        lastInboundAt: 1_500,
        lastInboundMessageAt: 1_450,
        lastInboundLatencyMs: 50,
        inboundCount: 1,
        lastOutboundAt: 1_700,
        outboundCount: 1,
        lastToolCallAt: 1_800,
        lastToolSucceededAt: 1_810,
        lastToolErrorAt: null,
        lastToolName: "jmap_mail_search",
        lastToolDurationMs: 10,
        toolCallCount: 1,
        toolErrorCount: 0,
      },
      cfg: {},
    } as never);

    expect(snapshot).toMatchObject({
      running: true,
      dispatchInbound: false,
      inboundMode: "off",
      lastSuccessfulPollAt: 2_000,
      pollCount: 5,
      lastInboundAt: 1_500,
      inboundCount: 1,
      lastOutboundAt: 1_700,
      outboundCount: 1,
      lastToolName: "jmap_mail_search",
      toolCallCount: 1,
      toolErrorCount: 0,
    });
  });

  it("keeps the channel alive until OpenClaw aborts it, then stops the monitor", async () => {
    const stop = vi.fn();
    monitorJmapProvider.mockResolvedValueOnce({ stop });
    const controller = new AbortController();
    const startAccount = jmapPlugin.gateway?.startAccount;
    expect(startAccount).toBeTypeOf("function");

    let settled = false;
    const running = startAccount!({
      accountId: "default",
      account: {
        accountId: "default",
        configured: true,
        sessionUrl: "https://mail.example.test/.well-known/jmap",
        pollIntervalSec: 20,
      },
      cfg: { channels: { jmap: { enabled: true } } },
      abortSignal: controller.signal,
      setStatus: vi.fn(),
      log: { info: vi.fn() },
    } as never).then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(monitorJmapProvider).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(settled).toBe(false);

    controller.abort();
    await running;

    expect(stop).toHaveBeenCalledOnce();
    expect(settled).toBe(true);
  });
});
