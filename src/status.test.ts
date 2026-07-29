import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindJmapStatusSink,
  getJmapRuntimeStatus,
  recordJmapInbound,
  recordJmapOutbound,
  recordJmapPollError,
  recordJmapPollSuccess,
  recordJmapToolFailed,
  recordJmapToolStarted,
  recordJmapToolSucceeded,
  resetJmapRuntimeStatusForTests,
} from "./status.js";

afterEach(() => {
  resetJmapRuntimeStatusForTests();
});

describe("JMAP runtime status", () => {
  it("merges activity without losing earlier timestamps or counters", () => {
    const sink = vi.fn();
    bindJmapStatusSink("default", sink);

    recordJmapPollSuccess("default", 1_000);
    recordJmapInbound("default", 900, 1_100);
    recordJmapOutbound("default", 1_200);
    recordJmapToolStarted("default", "jmap_mail_search", 1_300);
    recordJmapToolSucceeded("default", "jmap_mail_search", 1_300, 1_350);
    recordJmapPollError("default", "temporary failure", 1_400);
    recordJmapPollSuccess("default", 1_500);

    expect(getJmapRuntimeStatus("default")).toMatchObject({
      lastPollAt: 1_500,
      lastSuccessfulPollAt: 1_500,
      lastPollErrorAt: 1_400,
      pollCount: 2,
      pollErrorCount: 1,
      lastInboundAt: 1_100,
      lastInboundMessageAt: 900,
      lastInboundLatencyMs: 200,
      inboundCount: 1,
      lastOutboundAt: 1_200,
      outboundCount: 1,
      lastToolCallAt: 1_300,
      lastToolSucceededAt: 1_350,
      lastToolName: "jmap_mail_search",
      lastToolDurationMs: 50,
      toolCallCount: 1,
      toolErrorCount: 0,
      lastError: null,
    });
    expect(sink).toHaveBeenLastCalledWith(
      expect.objectContaining({
        lastInboundAt: 1_100,
        lastOutboundAt: 1_200,
        pollCount: 2,
      }),
    );
  });

  it("counts failed tool executions without recording success", () => {
    recordJmapToolStarted("support", "jmap_mail_get", 2_000);
    recordJmapToolFailed("support", "jmap_mail_get", 2_000, 2_025);

    expect(getJmapRuntimeStatus("support")).toMatchObject({
      lastToolCallAt: 2_000,
      lastToolSucceededAt: null,
      lastToolErrorAt: 2_025,
      lastToolName: "jmap_mail_get",
      lastToolDurationMs: 25,
      toolCallCount: 1,
      toolErrorCount: 1,
    });
  });
});
