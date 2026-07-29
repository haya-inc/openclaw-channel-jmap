# RFC 8621 coverage

The project intends to implement every method defined by JMAP Mail
[RFC 8621](https://www.rfc-editor.org/rfc/rfc8621). Coverage is tracked by
method rather than by server brand. The machine-readable source of truth is
[`rfc8621-coverage.json`](../rfc8621-coverage.json).

`implemented` means the relevant standard operation is usable now. `partial`
means only a documented subset is implemented. `planned` means the method is
not yet implemented. Exposure records whether OpenClaw can invoke it directly
as a tool, whether it is used only inside the channel, or whether it is absent.

## Release gates

| Release | Gate |
|---|---|
| 0.4 | Daily triage: mailbox discovery, all/Junk search, safe HTML/link and attachment inspection, bounded threads, reversible moves |
| 0.5 | Deliberate composition: draft lifecycle, search snippets, identities, explicit submission and status, scheduling and undo where advertised |
| 0.6 | Complete synchronization: `changes` and `queryChanges` families with durable state and recovery |
| 0.7 | Message transfer: copy, import, parse, blob upload/download, and attachment handling |
| 0.8 | Protected account controls: mailbox/identity/vacation mutations behind explicit policy gates |
| 1.0 | Every RFC 8621 method implemented, compatibility-tested, documented, and assigned a safe OpenClaw exposure |

These are capability gates, not a release calendar. A completed slice on
`main` remains unreleased until every required item for that minor version is
ready. The authoritative 0.5 checklist is in
[`release-gates.json`](../release-gates.json); the versioning rules are in
[`versioning.md`](versioning.md).

`main` currently contains the 0.5 composition implementation plus early 0.6
and 0.7 slices: one-page `/changes` access, blob upload, attachment-backed
drafts, copy, import, and parse. Complete 0.6 still requires durable per-type
state orchestration, automatic continuation, stale-state recovery, and the
remaining `queryChanges` methods. Complete 0.7 still requires the download
tooling and cross-server transfer evidence. These early slices do not advance
the stable package version.

## Safety model

- Read operations may be directly exposed when their output is bounded.
- Reversible mutations require an explicit tool call and return affected ids.
- Outbound operations must never be used as a compatibility probe. The default
  reviewed mode requires a content-bound native operator approval; unattended
  delivery requires explicit autonomous policy.
- Destructive or account-wide mutations are not exposed until policy,
  confirmation, dry-run, and audit behavior are specified.
- “Implemented” and “supported by a server” are independent claims. The
  compatibility checker records live server capabilities and safe verification;
  the coverage ledger records plugin implementation.

The ledger is validated in CI for the exact 26 RFC 8621 methods, unique names,
known statuses, exposure classes, and risk classes. Adding an implementation
therefore requires updating both code and its public coverage claim.
