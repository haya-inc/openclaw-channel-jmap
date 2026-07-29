# Security

Please report vulnerabilities privately through GitHub Security Advisories for
this repository. Do not include credentials, message bodies, or production
mailbox data in a public issue.

## Security boundary

This plugin operates on mail through a user's JMAP session. It does not use or
expose a mail-server administration API. Give each OpenClaw agent a dedicated
mailbox or app password with only the JMAP permissions it needs.

Inbound email is untrusted input. Keep `autoReply`, `markAsRead`, and
`processExistingUnread` disabled until the mailbox policy has been reviewed.
For mailbox assistants that search mail on demand, also set
`dispatchInbound: false` so arbitrary inbound mail cannot start a model turn.

Outbound delivery defaults to `outboundPolicy: "reviewed"`. Reviewed draft
submission re-verifies the content-bound preview and requires a native
OpenClaw `allow-once` approval that the plugin consumes before JMAP submission.
Missing, denied, expired, changed, or replayed approval sends nothing. Keep the
plugin explicitly enabled so OpenClaw registers its declared trusted-tool
policy.

`outboundPolicy: "autonomous"` enables immediate model-driven delivery and is
also required for automatic replies. Treat it as an explicit grant of
unattended send authority, use a dedicated least-privilege mailbox, and do not
enable it merely to bypass an unavailable approval route.
