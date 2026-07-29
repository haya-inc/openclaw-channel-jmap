# Deliberate composition

The deliberate-composition tools form one reviewable path from an idea to an
outbound message:

1. Call `jmap_mail_identities` and select an exact identity.
2. Optionally upload attachments with `jmap_mail_blob_upload`.
3. Save work with `jmap_mail_draft_create`.
4. Call `jmap_mail_draft_preview` and review the identity, From address,
   recipients, Reply-To, Bcc, subject, exact plain-text body, and attachment
   metadata.
5. To revise, call `jmap_mail_draft_update` with the preview token. JMAP Email
   content is immutable, so this creates a replacement draft before removing
   the old one. The replacement has a new Email id.
6. Preview the replacement. Never reuse a token from an earlier draft or
   revision.
7. Finish with exactly one explicit action:
   `jmap_mail_draft_submit` to authorize delivery, or
   `jmap_mail_draft_discard` to permanently remove the draft. Both require the
   current preview token and `confirm: true`.
8. After submission, inspect `jmap_mail_submissions`. Cancellation is available
   only while the server reports `undoStatus: pending`; use
   `jmap_mail_submission_cancel` with `confirm: true`.

The older `jmap_mail_send` tool remains available for compatibility and sends
immediately. New workflows that need deliberate review should use the draft
path above.

## Preview token

The preview token is a SHA-256 digest over the draft Email id and blob id,
selected identity and concrete From address, recipients, Reply-To, subject,
exact bounded text, and attachment metadata. Before update, discard, or
submission, the client fetches the draft again and recomputes the token. A
changed or unpreviewed draft is rejected as `stalePreview`.

The token is not an authorization credential and does not freeze unrelated
mailbox activity. JMAP state preconditions are also used for the actual draft
mutation. If replacement creation succeeds but removal of the old draft fails,
the replacement id is returned in a `draftReplaceIncomplete` error so no
content is silently lost.

## Identities and signatures

An RFC 8621 identity may be a concrete address or a wildcard such as
`*@example.com`. Wildcards require an explicit concrete `fromEmail` in the same
domain. Identity Reply-To and Bcc values are merged into the draft. Plain-text
signatures are opt-in with `applyIdentitySignature: true`; they are not
silently appended.

## Submission, scheduling, and cancellation

Creating or updating a draft never calls `EmailSubmission/set`.
`jmap_mail_draft_submit` is the only step in this flow that creates a
submission and records outbound activity.

Future delivery is accepted only when the server advertises a positive
`maxDelayedSend` value and the requested time is within that window. The
client expresses the delay with the standard `HOLDFOR` envelope parameter.
Submission creation means that the server accepted the submission object; it
does not prove SMTP delivery. Delivery and DSN/MDN state must be read from the
submission history.

Cancellation is not recall. It updates `undoStatus` only from `pending` to
`canceled` and then verifies the server response. A `final` submission or a
message already delivered cannot be unsent by deleting its Email or submission
record.

## Attachments and message transfer

- Blob upload is capped at 5 MiB per tool call and also respects the server's
  advertised `maxSizeUpload`. Upload alone does not create or send an Email.
- Draft attachment input is a complete list of existing blob ids. On update,
  omit the list to preserve attachments or pass an empty list to remove all.
- `jmap_mail_parse` reads an RFC 5322 blob without importing it. Parsed bodies
  are bounded and untrusted.
- `jmap_mail_import` creates Emails from existing blobs in an explicitly
  selected mailbox and requires confirmation.
- `jmap_mail_copy` copies to another account in the same JMAP Session. It
  requires explicit destination mailbox ids and confirmation, and always sets
  `onSuccessDestroyOriginal: false`.

## Compatibility boundary

The implementation follows RFC 8620 and RFC 8621 rather than provider-specific
APIs. Mock contract tests cover the standard request and response shapes.
Actual support and edge behavior still need compatibility evidence from each
target server. Until the 0.5 cross-server gate is complete, these additions
remain unreleased development work on `main`, and the package version remains
0.4.1.

## Outbound-boundary security review

The reviewed threats and controls are:

| Threat | Control | Residual risk |
|---|---|---|
| Mail content changes after review | Re-fetch and content-bound preview token; JMAP state precondition on mutation | A compromised server can misrepresent its own state or delivery |
| Wrong or forged From address | Exact Identity selection; wildcard addresses restricted to their advertised domain | Server-side aliases and policy remain authoritative |
| Accidental send or discard | Separate tools, current preview token, and literal `confirm: true` | A sufficiently authorized agent can still make a mistaken confirmed choice |
| Draft loss during revision | Create replacement first; destroy original second; surface replacement id on partial failure | A partial failure may leave two drafts and needs cleanup |
| False delivery claim | Return submission and delivery status without treating creation as delivery | Remote SMTP/DSN information can be delayed or incomplete |
| Invalid recall claim | Permit cancellation only from `pending`, then re-read `canceled` | Delivery may race with the cancellation request |
| Prompt injection in mail/snippets | Label output untrusted; bound bodies; strip snippet markup to plain text | The model must continue to follow the host's trust policy |
| Oversized or unintended upload | Strict base64, 5 MiB tool cap, advertised server limit, explicit confirmation | Uploaded unreferenced blobs may remain until server expiry |
| Destructive cross-account move | `Email/copy` always sets `onSuccessDestroyOriginal: false` | Copies still consume quota and expose content to the destination account |

This review covers the model-visible composition and transfer boundary. It does
not audit the JMAP server, authentication storage, OpenClaw host policy, or
provider delivery infrastructure.
