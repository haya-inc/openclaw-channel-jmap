import { describe, expect, it, vi } from "vitest";

const monitorJmapProvider = vi.hoisted(() => vi.fn());

vi.mock("./monitor.js", () => ({ monitorJmapProvider }));

import { jmapPlugin } from "./channel.js";

describe("JMAP gateway lifecycle", () => {
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
