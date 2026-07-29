# Changelog

## 0.3.1

- Fall back from empty server-side subject-filter results to bounded
  metadata-only text search with local literal subject matching.
- Stop fetching message bodies for search results; full bodies remain limited
  to explicit get and thread operations.

## 0.3.0

- Add official, digest-pinned Apache James 3.9.0 and Cyrus 3.13.6
  compatibility labs and a weekly full-scope compatibility workflow.
- Resolve relative Session resource and URI-template URLs returned by Cyrus,
  and tolerate primary-account capability declarations when Cyrus reports a
  null `accountCapabilities` object.
- Fall back from unsupported `Email/queryChanges` to persistent recent-query
  snapshot polling, allowing Apache James to receive new mail safely.
- Add `fixture`, `lab`, and `live` evidence wrappers with server artifact,
  probe source revision, and report SHA-256 provenance.
- Add a Fastmail-ready live workflow with the official Session endpoint and
  bearer authentication defaults.

## 0.2.0

- Add a content-free, non-mutating compatibility checker for Stalwart,
  Fastmail, Cyrus IMAP, Apache James, and other standards-based JMAP servers.
- Add `read`, `manage`, `send`, and `full` compatibility scopes, stable JSON
  reports, a report schema, OpenClaw and standalone CLIs, and a live CI
  workflow.
- Negotiate request capabilities per method and keep Mail-only servers usable
  when JMAP Submission or Identity is unavailable.
- Adopt OpenClaw's channel entry helper and a lightweight setup entry.

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
