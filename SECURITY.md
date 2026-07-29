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
