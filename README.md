# openclaw-channel-jmap-email

![cover](./cover-image.png)

JMAP email channel plugin for [OpenClaw](https://github.com/openclaw/openclaw). Enables email thread conversations over the [JMAP](https://jmap.io/) protocol.

## Features

- JMAP email send/receive
- Email thread session management
- Inbound message deduplication
- Mailbox monitoring with configurable poll interval

## Prerequisites

This plugin defaults to [Fastmail](https://www.fastmail.com/) as the JMAP provider. You need a Fastmail API token to get started.

### Obtaining a Fastmail API Token

1. Log in to your Fastmail account
2. Go to **Settings → Privacy & Security → Integrations → API tokens** (or visit [API tokens page](https://app.fastmail.com/settings/security/tokens) directly)
3. Click **New API token**
4. Grant at minimum the **Mail** scope (`urn:ietf:params:jmap:mail`)
5. Copy the generated token

> Using a different JMAP provider? Set `sessionUrl` in the config to point to your provider's JMAP session endpoint.

## Install

Via Git repository:

```bash
openclaw plugins install https://github.com/kaichen/openclaw-channel-jmap-email.git
```

Or from local source:

```bash
git clone https://github.com/kaichen/openclaw-channel-jmap-email.git
cd openclaw-channel-jmap-email && npm install
openclaw plugins install -l .
```

## Configuration

Register as an OpenClaw channel plugin — see [OpenClaw channel docs](/channels/jmap-email) for setup details.

### API Token

Provide your JMAP API token via one of the following methods (in priority order):

| Method | Description |
|--------|-------------|
| Environment variable | Set `JMAP_API_TOKEN` (or `JMAIL_API_TOKEN`) |
| Token file | Set `apiTokenFile` in config to a file path containing the token |
| Config field | Set `apiToken` directly in the channel config |

### Options

**Connection**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable/disable this channel or account |
| `name` | `string` | — | Display name for the account |
| `apiToken` | `string` | — | JMAP API token |
| `apiTokenFile` | `string` | — | Path to a file containing the API token |
| `sessionUrl` | `string` | `"https://api.fastmail.com/jmap/session"` | JMAP session endpoint URL |
| `pollIntervalSec` | `number` | `20` | Mailbox poll interval in seconds (5–300) |

**Access Control**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dmPolicy` | `string` | `"pairing"` | DM policy: `"pairing"`, `"allowlist"`, `"open"`, or `"disabled"` |
| `allowFrom` | `string[]` | — | Allowed sender emails. Must include `"*"` when dmPolicy is `"open"` |
| `groupPolicy` | `string` | `"allowlist"` | Group conversation policy: `"allowlist"`, `"open"`, or `"disabled"` |
| `groupAllowFrom` | `string[]` | — | Allowed group sender addresses |

**Message Handling**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `historyLimit` | `number` | — | Max conversation history messages to load |
| `dmHistoryLimit` | `number` | — | Max DM history messages to load |
| `dms` | `object` | — | Per-DM overrides keyed by email, e.g. `{ "alice@x.com": { "historyLimit": 5 } }` |
| `responsePrefix` | `string` | — | Prefix prepended to every outgoing reply |
| `blockStreaming` | `boolean` | `true` | Buffer response into blocks before sending (vs character-level streaming) |
| `textChunkLimit` | `number` | `4000` | Max characters per outgoing message chunk |
| `chunkMode` | `string` | — | Chunk splitting strategy: `"length"` or `"newline"` |

### Example Config

```json
{
  "channels": {
    "jmap-email": {
      "apiToken": "fmu1-...",
      "pollIntervalSec": 30,
      "dmPolicy": "pairing",
      "allowFrom": ["alice@example.com", "bob@example.com"]
    }
  }
}
```

### Multi-Account

```json
{
  "channels": {
    "jmap-email": {
      "dmPolicy": "pairing",
      "accounts": {
        "work": {
          "apiToken": "fmu1-...",
          "sessionUrl": "https://api.fastmail.com/jmap/session",
          "allowFrom": ["*"],
          "dmPolicy": "open"
        },
        "personal": {
          "apiToken": "fmu1-...",
          "allowFrom": ["alice@example.com"]
        }
      }
    }
  }
}
```

## Development

```bash
pnpm install
pnpm test
```

## License

MIT
