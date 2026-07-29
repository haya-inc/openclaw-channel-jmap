# openclaw-channel-jmap

A provider-neutral JMAP email channel and mailbox toolset for OpenClaw.

It lets an OpenClaw agent receive email as conversations and deliberately
search, read, inspect, draft, send, reply, mark read/unread, and star/unstar
messages. It can list sending identities, create and safely revise a draft,
preview the exact message before an explicit submit or discard, inspect
submission history, cancel while the server still permits undo, list and select
mailboxes, search Junk or all mail, inspect safe links and attachment metadata,
page through large threads, and move messages.
It only uses the mailbox-facing JMAP protocol; server administration is outside
the plugin's scope.

The project is an MIT-licensed fork of
[kaichen/openclaw-channel-jmap-email](https://github.com/kaichen/openclaw-channel-jmap-email).
The upstream history and attribution are preserved.

## Why JMAP

JMAP exposes structured mail operations over HTTPS and JSON. One authenticated
session provides capability discovery, mailbox lookup, search, message bodies,
threads, state changes, draft creation, and submission. This is a substantially
cleaner agent boundary than coordinating separate IMAP and SMTP connections.

The implementation is not tied to Stalwart. It is intended for standards-based
JMAP servers such as:

- Stalwart
- Fastmail
- Cyrus IMAP
- Apache James

Provider differences and test reports are welcome.

## Compatibility checker

Compatibility is verified from the live JMAP Session and safe method calls,
not inferred from the server name.

```bash
openclaw jmap compatibility \
  --account default \
  --server stalwart \
  --scope full \
  --json
```

The same probe can run independently in CI:

```bash
openclaw-jmap-compat --server generic --scope read --json
```

It supports `stalwart`, `fastmail`, `cyrus`, `apache-james`, and `generic`
profiles with `read`, `manage`, `send`, and `full` requirement scopes. The
standard probe never sends mail, changes mailbox state, reads message bodies,
or exposes mailbox identifiers. See
[JMAP compatibility checks](docs/compatibility.md).

## Features

- OpenClaw `jmap` channel with direct and thread conversations
- Multiple JMAP accounts
- Basic authentication for account/app passwords
- Bearer authentication for JMAP API tokens
- Standard environment-variable and credential-file sources
- Polling through `Email/queryChanges`, with a persistent recent-query
  snapshot fallback for servers that do not implement it
- Persistent inbound deduplication
- Passive inbox mode that detects new mail without starting a model turn
- Plain-text thread-aware sending through `Email/set` and
  `EmailSubmission/set`
- Runtime telemetry for polling, inbound/outbound mail, and agent tool calls
- Sender policy through OpenClaw's `disabled`, `allowlist`, `pairing`, and
  `open` direct-message policies
- Agent tools:
  - `jmap_mail_mailboxes`
  - `jmap_mail_identities`
  - `jmap_mail_search`
  - `jmap_mail_search_snippets`
  - `jmap_mail_changes`
  - `jmap_mail_parse`
  - `jmap_mail_blob_upload`
  - `jmap_mail_import`
  - `jmap_mail_copy`
  - `jmap_mail_get`
  - `jmap_mail_thread`
  - `jmap_mail_draft_create`
  - `jmap_mail_draft_preview`
  - `jmap_mail_draft_update`
  - `jmap_mail_draft_discard`
  - `jmap_mail_draft_submit`
  - `jmap_mail_submissions`
  - `jmap_mail_submission_cancel`
  - `jmap_mail_send`
  - `jmap_mail_update`
  - `jmap_mail_move`

## Safe defaults

Email is an untrusted public input surface. The defaults therefore:

- do not send an automatic model reply (`autoReply: false`);
- do not mark inbound messages read (`markAsRead: false`);
- do not process the existing unread backlog at startup
  (`processExistingUnread: false`);
- use `allowlist` sender policy;
- label automated and bulk/list messages as untrusted and never auto-reply to
  them, while still delivering them for OTP and verification inspection;
- cap the body exposed to the agent at 100 KB;
- convert HTML-only bodies to plain text and expose only HTTP(S) links;
- return attachment metadata but do not download attachment blobs;
- bound thread reads to the latest 20 messages by default;
- do not expose permanent deletion as an agent tool.
- keep draft creation and submission as separate actions: creating or revising
  a draft never sends it;
- require an exact content-bound preview token plus explicit confirmation for
  deliberate submission or discard;
- cap model-driven blob upload at 5 MiB and never destroy originals after
  cross-account copy.

Each behavior can be enabled explicitly per account. See the
[deliberate-composition workflow](docs/deliberate-composition.md) for the safe
create, preview, revise, re-preview, submit-or-discard sequence.

## Install

Install the current stable release from GitHub:

```bash
openclaw plugins install git:github.com/haya-inc/openclaw-channel-jmap@v0.4.1
```

An unpinned install follows unreleased `main` and is intended for development,
not production:

```bash
openclaw plugins install git:github.com/haya-inc/openclaw-channel-jmap
```

Restart the OpenClaw gateway after changing the plugin or channel
configuration.

## Configure

### Stalwart or another Basic-auth JMAP server

Keep credentials out of `openclaw.json`:

```bash
export JMAP_SESSION_URL=https://mail.example.com/.well-known/jmap
export JMAP_USERNAME=agent@example.com
export JMAP_PASSWORD='an-app-password'
```

Then configure the channel:

```json
{
  "channels": {
    "jmap": {
      "enabled": true,
      "dmPolicy": "allowlist",
      "allowFrom": ["owner@example.com"],
      "dispatchInbound": false,
      "autoReply": false,
      "markAsRead": false,
      "processExistingUnread": false
    }
  }
}
```

The same values may be expressed with `sessionUrl`, `username`, `password`, and
`authMode: "basic"` in channel configuration, or with `passwordFile`. Environment
variables or a root-readable credential file are recommended.

### Bearer-token JMAP server

```bash
export JMAP_SESSION_URL=https://api.fastmail.com/jmap/session
export JMAP_API_TOKEN='your-token'
```

```json
{
  "channels": {
    "jmap": {
      "enabled": true,
      "authMode": "bearer",
      "dmPolicy": "allowlist",
      "dispatchInbound": false,
      "allowFrom": ["owner@example.com"]
    }
  }
}
```

`JMAIL_API_TOKEN` remains accepted as a compatibility alias.

### Multiple accounts

Top-level settings are inherited by named accounts:

```json
{
  "channels": {
    "jmap": {
      "sessionUrl": "https://mail.example.com/.well-known/jmap",
      "dmPolicy": "allowlist",
      "dispatchInbound": false,
      "autoReply": false,
      "accounts": {
        "support": {
          "authMode": "basic",
          "username": "support@example.com",
          "passwordFile": "/run/secrets/jmap-support",
          "allowFrom": ["customer@example.net"]
        },
        "ops": {
          "authMode": "basic",
          "username": "ops@example.com",
          "passwordFile": "/run/secrets/jmap-ops",
          "allowFrom": ["oncall@example.com"]
        }
      }
    }
  }
}
```

## Main options

| Option | Default | Meaning |
|---|---:|---|
| `sessionUrl` | Fastmail session URL | JMAP session discovery URL |
| `authMode` | inferred | `basic` or `bearer` |
| `pollIntervalSec` | `20` | Polling interval, 5–300 seconds |
| `dmPolicy` | `allowlist` | Sender access policy |
| `allowFrom` | `[]` | Allowed sender addresses; `open` requires `["*"]` |
| `dispatchInbound` | `true` | Start an agent turn for accepted new mail; set `false` for passive/search-only inboxes |
| `autoReply` | `false` | Send the model response back to the email thread |
| `markAsRead` | `false` | Mark successfully handled inbound mail read |
| `processExistingUnread` | `false` | Process unread mail already present at startup |
| `maxBodyBytes` | `100000` | Maximum body bytes exposed per email |

If `sessionUrl` is omitted, the compatibility default is Fastmail. Non-Fastmail
deployments should always set it explicitly.

## JMAP operations used

The plugin requires the JMAP Core, Mail, and Submission capabilities and uses:

- `Mailbox/get`
- `Mailbox/changes`
- `Identity/get`
- `Identity/changes`
- `Email/query` and, when supported, `Email/queryChanges`
- `Email/get`, `Email/changes`, `Email/set`, `Email/copy`, `Email/import`, and
  `Email/parse`
- `Thread/get` and `Thread/changes`
- `SearchSnippet/get`
- `EmailSubmission/get`, `EmailSubmission/changes`,
  `EmailSubmission/query`, and `EmailSubmission/set`
- the JMAP Core upload endpoint

It does not need a Stalwart management token or server-admin permission.
The project intends to cover all methods in RFC 8621. Current implementation,
OpenClaw exposure, mutation risk, and target release are tracked in the
[RFC 8621 coverage ledger](docs/rfc8621-coverage.md); the source of truth is
[`rfc8621-coverage.json`](rfc8621-coverage.json).

## Versioning and release gates

Versions describe a coherent public contract, not the amount of work completed.
Compatible fixes to a stable contract use patch releases. A minor release is
cut only when its named capability set is complete across the supported safety
and compatibility boundaries. Work may accumulate under `Unreleased` while the
package version remains at the latest stable release.

The current stable version is 0.4.1. The 0.5.0 deliberate-composition milestone
is under development; the new identity and bounded draft tools on `main` are
not a 0.5.0 release and are not a reason to upgrade production installations. See
[Versioning and release philosophy](docs/versioning.md) and the
machine-readable [`release-gates.json`](release-gates.json).

## Official compatibility labs

The repository contains reproducible, local-only labs for the official Apache
James memory image and a JMAP-enabled Cyrus build:

```bash
npm run build
scripts/compatibility/run-apache-james.sh
scripts/compatibility/run-cyrus.sh
```

Both run the non-mutating `full` probe against a disposable server, seed only a
local mailbox, and clean up their containers. The weekly GitHub workflow
publishes versioned, redacted evidence artifacts. Live Fastmail, Stalwart, and
other-server checks use GitHub Environments so credentials never enter the
repository. See [JMAP compatibility checks](docs/compatibility.md).

## Runtime status and evaluation

`openclaw channels status --json` exposes per-account counters and timestamps
without logging message bodies or tool arguments:

- latest successful poll and poll error, with success/error counts;
- latest detected inbound message, processing latency, and inbound count;
- latest outbound message and outbound count;
- latest JMAP agent tool name, duration, success/error timestamps, and
  call/error counts.

Tool logs contain only the tool name, outcome, duration, and error type. They do
not contain search terms, addresses, subjects, message IDs, or message bodies.
The same anonymous tool/outbound events are appended under OpenClaw's state
directory so `openclaw agent --local` tool calls remain visible to the gateway
status process.

With `dispatchInbound: false`, new mail is still detected and deduplicated, but
it does not start an agent turn. The agent can inspect it later with
`jmap_mail_search`, `jmap_mail_get`, and `jmap_mail_thread`.

Search first uses the standard JMAP filters. If a server returns no results for
a valid subject filter, the client performs a bounded metadata-only text
fallback and enforces the literal subject match locally. This keeps subject
search useful across provider indexing differences without fetching message
bodies or widening the returned result set.

## Delivery semantics

Inbound IDs are recorded in an atomic local state file after a turn finishes.
Restarts therefore avoid normal duplicate delivery. A crash after an external
side effect but before the state file is committed can still cause at-least-once
redelivery. Agents should make consequential workflows idempotent.

## Development

Requires Node.js 24 or newer:

```bash
npm install
npm run check
```

The test suite includes mocked full JMAP request chains, authentication,
threaded sending, polling, and restart deduplication.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
