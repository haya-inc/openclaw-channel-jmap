# Changelog

## Unreleased

- Accept the RFC 8621 representation used by Stalwart where the same
  `text/plain` body part appears in both `textBody` and `htmlBody`, while
  continuing to reject drafts with an actual HTML alternative.
- Add an explicitly authorized, recipient-free stateful draft contract probe
  and split the 0.5 cross-server release gate into safe, draft, and outbound
  evidence layers.
- Add a machine-checked five-profile safe compatibility evidence policy,
  deterministic generic RFC fixture, and current full-scope evidence for
  Stalwart 0.16.12, Cyrus 3.13.6, and Apache James 3.9.0.
- Begin the deliberate-composition milestone without changing the stable
  package version.
- Expose sending identities and allow an agent to save a plain-text draft with
  an explicitly selected identity without submitting or sending it.
- Add a content-bound safe composition flow for exact draft preview,
  replacement-before-removal revision, re-preview, explicit submit or discard,
  submission history, pending-only cancellation, and advertised delayed send.
- Support RFC wildcard identities, Reply-To/Bcc defaults, opt-in plain-text
  signatures, and bounded server-generated search snippets.
- Add standard `/changes` pages, bounded `Email/parse`, confirmed blob upload
  and `Email/import`, non-destructive cross-account `Email/copy`, and draft
  attachments backed by existing blob ids.
- Add a machine-checked release gate so 0.5.0 is not cut until its complete
  public contract is ready.
- Add fail-closed outbound policies. Reviewed draft submission now requires a
  content-bound, host-tool-call-bound OpenClaw `allow-once` approval; immediate
  send and automatic replies require explicit autonomous mode.
- Migration: existing `autoReply: true` or immediate-send deployments must set
  `outboundPolicy: "autonomous"`; all unspecified accounts default to reviewed.

## 0.4.1

- Use OpenClaw's current runtime configuration snapshot instead of the
  deprecated on-demand config loader.

## 0.4.0

- Add mailbox listing and mailbox selection by id, standard role, or exact name,
  including safe all-mail and Junk searches.
- Add attachment, size, keyword, thread-collapse, and result-position filters
  with explicit query pagination metadata.
- Read HTML-only mail as plain text, expose only HTTP(S) links, return attachment
  metadata without downloading blobs, and strengthen automated-mail detection.
- Bound thread reads to the latest 20 messages by default with pagination toward
  older messages.
- Add a reversible mailbox-move tool and publish a machine-readable RFC 8621
  method coverage ledger.

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
