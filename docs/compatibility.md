# JMAP compatibility checks

`openclaw-channel-jmap` determines compatibility from the live JMAP Session
resource and safe method calls. A server name never bypasses a check.

Supported report profiles:

- `stalwart`
- `fastmail`
- `cyrus`
- `apache-james`
- `generic` for any other standards-based JMAP server

## Safety boundary

The standard compatibility probe:

- does not send email;
- does not create drafts;
- does not mark messages read;
- does not change keywords or mailboxes;
- does not download message bodies or attachments;
- does not print message, thread, mailbox, identity, or account identifiers.

It may query the inbox and, when an email exists, request only its `id` and
`threadId` internally to verify `Email/get` and `Thread/get`. Those identifiers
never appear in the report.

Submission support is checked through advertised capabilities and
`Identity/get`. Delivery remains unverified until a separate, explicitly
side-effecting test is designed and enabled.

`Email/queryChanges` is used when available. If a server returns
`unknownMethod`, the channel and checker verify a persistent recent-query
snapshot strategy instead. The fallback establishes a baseline before
delivering anything and records seen IDs atomically, so a restart does not turn
the current inbox into a new-message backlog.

## Scopes

| Scope | Required checks |
|---|---|
| `read` | Session, Core, Mail, `Mailbox/get`, `Email/query`, a working polling strategy, and metadata-only `Email/get` |
| `manage` | `read` plus reported mailbox mutation rights |
| `send` | `read` plus Submission capability and `Identity/get` |
| `full` | `manage` + `send` plus upload, download, and Event Source URL templates |

The verdict is one of:

- `compatible`: all checks required by the selected scope passed;
- `partial`: reading works, but a required higher-level capability is missing
  or cannot be verified;
- `incompatible`: an essential JMAP Core/Mail or read method failed;
- `unverified`: credentials, authentication, or network access did not allow a
  meaningful test.

## Run through OpenClaw

```bash
openclaw jmap compatibility \
  --account default \
  --server stalwart \
  --scope full \
  --json
```

The command uses the selected account from `channels.jmap`.

## Run standalone or in CI

The standalone command reads credentials only from environment variables, so
secrets do not appear in the process list:

```bash
export JMAP_SESSION_URL=https://mail.example.com/.well-known/jmap
export JMAP_AUTH_MODE=basic
export JMAP_USERNAME=agent@example.com
export JMAP_PASSWORD='an-app-password'

openclaw-jmap-compat --server generic --scope read --json
```

For bearer authentication, set `JMAP_AUTH_MODE=bearer` and
`JMAP_API_TOKEN`.

JSON output conforms to
[`compatibility-report.schema.json`](../compatibility-report.schema.json) and is
designed to be attached to compatibility issues without exposing mailbox
content or identifiers.

## Evidence levels and history

Every retained result can be wrapped in
[`compatibility-evidence.schema.json`](../compatibility-evidence.schema.json).
The wrapper records the exact server version/artifact, probe package version,
source revision, SHA-256 of the redacted report, and one of three levels:

| Level | Meaning |
|---|---|
| `fixture` | Classification and request behavior passed against controlled protocol fixtures |
| `lab` | The probe passed against a disposable real server built from an official image or source release |
| `live` | The probe passed against a separately deployed service using a dedicated account |

These levels are deliberately not called vendor certification. A lab result
proves interoperability with the named artifact and configuration; a live
result additionally covers the deployed service, authentication, and network
path. Neither proves outbound delivery because the standard probe has no side
effects.

GitHub Actions retains the report and evidence wrapper together. Reviewed
snapshots may be promoted into
[`compatibility-evidence/`](../compatibility-evidence/) so the compatibility
history survives workflow artifact expiry.

## Provider status

| Provider | Official position | Project verification |
|---|---|---|
| Stalwart | JMAP Core/Mail, Submission, upload/download, and push are available | Production read/poll/search verified; a versioned live full-scope report remains the release gate |
| Fastmail | JMAP Mail and Submission are supported with bearer tokens or OAuth | Live report pending a dedicated test account |
| Cyrus IMAP | JMAP must be compiled/configured; Basic authentication is documented | Cyrus 3.13.6 official source: `full` lab verified on 2026-07-29 |
| Apache James | JMAP is experimental and only some official server packages enable it | Official `apache/james:memory-3.9.0`: `full` lab verified on 2026-07-29; polling uses the snapshot fallback because `Email/queryChanges` returns `unknownMethod` |
| Other JMAP servers | Must advertise the RFC capabilities required by the selected scope | Use the `generic` profile and attach the redacted JSON report |

Fixture tests validate classification logic; they are not server verification.
The provider table always names the strongest evidence level actually reached.

## Official local labs

After `npm run build`, run either disposable lab:

```bash
scripts/compatibility/run-apache-james.sh
scripts/compatibility/run-cyrus.sh
```

The Apache James lab pins the official memory 3.9.0 image by digest. It creates
one local user and injects one local-only seed through the container's SMTP
listener.

The Cyrus lab pins the 3.13.6 source tag and the official Cyrus build
environment by digest. It configures JMAP, creates one local IMAP mailbox, and
uses a loopback-only SMTP sink so Submission can be advertised without any
external delivery path.

The `JMAP compatibility (official labs)` workflow runs both at `full` scope
weekly and on demand. A change in a server image, source tag, JMAP behavior, or
the channel's compatibility layer therefore becomes a visible failing check.

## Live compatibility workflow

The repository workflow `JMAP compatibility (live)` uses a GitHub Environment
named `compatibility-<profile>`. Store the following as environment secrets:

- `JMAP_SESSION_URL`
- `JMAP_USERNAME` and `JMAP_PASSWORD`, or `JMAP_API_TOKEN`

Optionally set the environment variable `JMAP_AUTH_MODE` to `basic` or
`bearer`. Fastmail defaults to its public Session URL and bearer mode, so its
environment only needs a dedicated API token with Mail and Submission access.
The workflow uploads only the redacted JSON report and its evidence wrapper.
