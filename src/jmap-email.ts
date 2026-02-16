import type { JmapEmail, JmapEmailAddress, JmapIdentity, JmapThreadContext } from "./types.js";
import { looksLikeEmailAddress, normalizeEmailAddress } from "./normalize.js";

export function compact<T extends Record<string, unknown>>(value: T): T {
  const next = {} as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined && item !== null) {
      next[key] = item;
    }
  }
  return next as T;
}

export function ensureArray<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}

export function parseTimestampMs(email: JmapEmail): number {
  const raw = email.receivedAt ?? email.sentAt;
  if (!raw) {
    return Date.now();
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function extractTextFromEmail(email: JmapEmail): string {
  const bodyValues = email.bodyValues ?? {};
  const textParts = ensureArray(email.textBody)
    .map((part) => (part.partId ? bodyValues[part.partId]?.value : undefined))
    .filter((value): value is string => typeof value === "string");

  const joined = textParts.join("\n\n").trim();
  if (joined) {
    return joined;
  }
  return (email.preview ?? "").trim();
}

export function formatReplySubject(subject?: string): string {
  const trimmed = (subject ?? "").trim();
  if (!trimmed) {
    return "Re: OpenClaw";
  }
  if (/^re\s*:/i.test(trimmed)) {
    return trimmed;
  }
  return `Re: ${trimmed}`;
}

export function firstMessageId(email: JmapEmail): string | undefined {
  return ensureArray(email.messageId)
    .map((value) => value.trim())
    .find(Boolean);
}

export function normalizeAddressList(items: JmapEmailAddress[] | undefined): JmapEmailAddress[] {
  const next: JmapEmailAddress[] = [];
  for (const item of ensureArray(items)) {
    const email = normalizeEmailAddress(item.email);
    if (!email) {
      continue;
    }
    next.push({
      email,
      name: item.name?.trim() || undefined,
    });
  }
  return next;
}

export function normalizeIdentityEmails(
  identity: JmapIdentity | null,
  username?: string,
): Set<string> {
  const emails = new Set<string>();
  const primaryEmail = normalizeEmailAddress(identity?.email);
  if (primaryEmail) {
    emails.add(primaryEmail);
  }
  for (const replyAddress of normalizeAddressList(identity?.replyTo)) {
    if (replyAddress.email) {
      emails.add(replyAddress.email);
    }
  }
  const normalizedUser = normalizeEmailAddress(username);
  if (normalizedUser && looksLikeEmailAddress(normalizedUser)) {
    emails.add(normalizedUser);
  }
  return emails;
}

export function pickIdentity(
  identities: JmapIdentity[],
  preferredEmail?: string,
): JmapIdentity | null {
  if (identities.length === 0) {
    return null;
  }
  const normalizedPreferred = normalizeEmailAddress(preferredEmail);
  if (normalizedPreferred) {
    const preferred = identities.find((identity) => {
      return normalizeEmailAddress(identity.email) === normalizedPreferred;
    });
    if (preferred) {
      return preferred;
    }
  }
  const preferred = identities.find((identity) => identity.isDefault);
  return preferred ?? identities[0];
}

export function buildThreadContextFromEmail(
  accountId: string,
  email: JmapEmail,
): JmapThreadContext {
  const threadId = (email.threadId ?? "").trim();
  const from = normalizeAddressList(email.from);
  const to = normalizeAddressList(email.to);
  const cc = normalizeAddressList(email.cc);
  const replyTo = normalizeAddressList(email.replyTo);
  const references = ensureArray(email.references)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const latestMessageId = firstMessageId(email);
  if (latestMessageId && !references.includes(latestMessageId)) {
    references.push(latestMessageId);
  }

  return {
    accountId,
    threadId,
    latestEmailId: email.id,
    latestMessageId,
    subject: email.subject?.trim() || undefined,
    from,
    to,
    cc,
    replyTo,
    references,
  };
}

export function parseInboundEmail(params: { email: JmapEmail }): {
  threadId: string;
  senderEmail: string;
  senderName?: string;
  text: string;
  subject?: string;
  timestampMs: number;
} | null {
  const { email } = params;
  const threadId = (email.threadId ?? "").trim();
  if (!threadId) {
    return null;
  }
  const sender = normalizeAddressList(email.from)[0];
  const senderEmail = normalizeEmailAddress(sender?.email);
  if (!senderEmail) {
    return null;
  }

  const text = extractTextFromEmail(email).trim();
  if (!text) {
    return null;
  }

  return {
    threadId,
    senderEmail,
    senderName: sender?.name?.trim() || undefined,
    text,
    subject: email.subject?.trim() || undefined,
    timestampMs: parseTimestampMs(email),
  };
}
