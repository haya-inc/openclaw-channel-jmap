# openclaw-channel-jmap

A provider-neutral JMAP email channel and mailbox toolset for OpenClaw.

It lets an OpenClaw agent receive email as conversations and deliberately
search, read, inspect, send, reply, mark read/unread, and star/unstar messages.
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

## Features

- OpenClaw `jmap` channel with direct and thread conversations
- Multiple JMAP accounts
- Basic authentication for account/app passwords
- Bearer authentication for JMAP API tokens
- Standard environment-variable and credential-file sources
- Polling through `Email/queryChanges`
- Persistent inbound deduplication
- Passive inbox mode that detects new mail without starting a model turn
- Plain-text thread-aware sending through `Email/set` and
  `EmailSubmission/set`
- Runtime telemetry for polling, inbound/outbound mail, and agent tool calls
- Sender policy through OpenClaw's `disabled`, `allowlist`, `pairing`, and
  `open` direct-message policies
- Agent tools:
  - `jmap_mail_search`
  - `jmap_mail_get`
  - `jmap_mail_thread`
  - `jmap_mail_send`
  - `jmap_mail_update`

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
- do not fetch attachments.

Each behavior can be enabled explicitly per account.

## Install

Install from GitHub:

```bash
openclaw plugins install git:github.com/haya-inc/openclaw-channel-jmap
```

For a reproducible deployment, pin a release tag or commit:

```bash
openclaw plugins install git:github.com/haya-inc/openclaw-channel-jmap@v0.1.4
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
- `Identity/get`
- `Email/query` and `Email/queryChanges`
- `Email/get` and `Email/set`
- `Thread/get`
- `EmailSubmission/set`

It does not need a Stalwart management token or server-admin permission.

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

With `dispatchInbound: false`, new mail is still detected and deduplicated, but
it does not start an agent turn. The agent can inspect it later with
`jmap_mail_search`, `jmap_mail_get`, and `jmap_mail_thread`.

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
