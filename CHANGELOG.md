# Changelog

## 0.1.5

- Persist anonymous tool and outbound activity in append-only shared OpenClaw
  state so gateway status includes calls made by separate `openclaw agent
  --local` processes.

## 0.1.4

- Add lossless per-account runtime status for polling, inbound/outbound mail,
  latency, and model-visible JMAP tool calls.
- Add anonymous tool outcome logs and full mocked execution coverage for all
  five JMAP tools.
- Add `dispatchInbound: false` passive inbox mode so new mail remains searchable
  without starting a model turn.
- Attribute outbound channel activity to the configured OpenClaw account rather
  than the provider-internal JMAP account id.

## 0.1.3

- Keep the passive JMAP poller alive until OpenClaw explicitly stops the
  channel.

## 0.1.2

- Deliver automated and bulk messages for OTP/verification inspection while
  hard-suppressing pairing and automatic replies to them.

## 0.1.1

- Include verified build output in Git so OpenClaw's script-disabled Git
  installer can load the plugin directly.

## 0.1.0

- Provider-neutral JMAP channel for OpenClaw.
- Basic and bearer authentication with environment and file credential sources.
- Multi-account inbound polling and thread-aware replies.
- Mail search, read, thread, send, and read/star update tools.
- Safe defaults for automatic replies, read state, startup backlog, body size,
  automated-message filtering, and persistent inbound deduplication.
- Tested with the OpenClaw 2026.7.2 plugin SDK.
