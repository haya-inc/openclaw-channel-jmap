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

## Scopes

| Scope | Required checks |
|---|---|
| `read` | Session, Core, Mail, `Mailbox/get`, `Email/query`, `Email/queryChanges`, metadata-only `Email/get` |
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

## Provider status

| Provider | Official position | Project verification |
|---|---|---|
| Stalwart | JMAP Core/Mail, Submission, upload/download, and push are available | Production read/poll/search verified; full safe probe is the release gate |
| Fastmail | JMAP Mail and Submission are supported with bearer tokens or OAuth | Live report pending a dedicated test account |
| Cyrus IMAP | JMAP must be compiled/configured; Basic authentication is documented; implementation is still described as in progress | Fixture coverage present; live report pending |
| Apache James | JMAP is experimental and only some official server packages enable it | Fixture coverage present; package-specific live reports pending |
| Other JMAP servers | Must advertise the RFC capabilities required by the selected scope | Use the `generic` profile and attach the redacted JSON report |

Fixture tests validate classification logic; they are not vendor
certification. A provider becomes “verified” only when a live report from a
documented server version passes.

## Live compatibility workflow

The repository workflow `JMAP compatibility (live)` uses a GitHub Environment
named `compatibility-<profile>`. Store the following as environment secrets:

- `JMAP_SESSION_URL`
- `JMAP_USERNAME` and `JMAP_PASSWORD`, or `JMAP_API_TOKEN`

Optionally set the environment variable `JMAP_AUTH_MODE` to `basic` or
`bearer`. The workflow uploads only the redacted JSON report.
