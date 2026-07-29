import type {
  BlockStreamingCoalesceConfig,
  DmConfig,
  DmPolicy,
  GroupPolicy,
} from "openclaw/plugin-sdk/config-contracts";

export type { DmPolicy, GroupPolicy };

export const JMAP_CORE = "urn:ietf:params:jmap:core" as const;
export const JMAP_MAIL = "urn:ietf:params:jmap:mail" as const;
export const JMAP_SUBMISSION = "urn:ietf:params:jmap:submission" as const;

export const DEFAULT_JMAP_SESSION_URL = "https://api.fastmail.com/jmap/session";
export const DEFAULT_POLL_INTERVAL_SEC = 20;
export const DEFAULT_MAX_BODY_BYTES = 100_000;

export type JmapAuthMode = "bearer" | "basic";

export type JmapAccountConfig = {
  name?: string;
  enabled?: boolean;
  authMode?: JmapAuthMode;
  username?: string;
  password?: string;
  passwordFile?: string;
  apiToken?: string;
  apiTokenFile?: string;
  sessionUrl?: string;
  pollIntervalSec?: number;
  dispatchInbound?: boolean;
  autoReply?: boolean;
  markAsRead?: boolean;
  processExistingUnread?: boolean;
  maxBodyBytes?: number;
  dmPolicy?: DmPolicy;
  allowFrom?: string[];
  groupPolicy?: GroupPolicy;
  groupAllowFrom?: string[];
  historyLimit?: number;
  dmHistoryLimit?: number;
  dms?: Record<string, DmConfig>;
  textChunkLimit?: number;
  chunkMode?: "length" | "newline";
  blockStreaming?: boolean;
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  responsePrefix?: string;
};

export type JmapConfig = {
  accounts?: Record<string, JmapAccountConfig>;
} & JmapAccountConfig;

export type CoreConfig = {
  channels?: {
    "jmap"?: JmapConfig;
  };
  commands?: {
    useAccessGroups?: boolean;
  };
  session?: {
    store?: string;
  };
  [key: string]: unknown;
};

export type JmapResolvedAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  authMode: JmapAuthMode;
  username: string;
  token: string;
  tokenSource: "env" | "passwordFile" | "tokenFile" | "config" | "none";
  sessionUrl: string;
  pollIntervalSec: number;
  config: JmapAccountConfig;
};

export type JmapMailboxRole = "inbox" | "sent" | "drafts" | (string & {});

export type JmapMailbox = {
  id: string;
  role?: JmapMailboxRole;
  name?: string;
};

export type JmapEmailAddress = {
  name?: string;
  email?: string;
};

export type JmapBodyPartRef = {
  partId?: string;
  type?: string;
};

export type JmapBodyValue = {
  value?: string;
  isTruncated?: boolean;
};

export type JmapEmail = {
  id: string;
  threadId?: string;
  mailboxIds?: Record<string, boolean>;
  from?: JmapEmailAddress[];
  to?: JmapEmailAddress[];
  cc?: JmapEmailAddress[];
  bcc?: JmapEmailAddress[];
  replyTo?: JmapEmailAddress[];
  subject?: string;
  preview?: string;
  receivedAt?: string;
  sentAt?: string;
  messageId?: string[];
  inReplyTo?: string[];
  references?: string[];
  bodyValues?: Record<string, JmapBodyValue>;
  textBody?: JmapBodyPartRef[];
  htmlBody?: JmapBodyPartRef[];
  keywords?: Record<string, boolean>;
  size?: number;
  "header:Auto-Submitted:asText"?: string;
  "header:Precedence:asText"?: string;
  "header:List-Id:asText"?: string;
};

export type JmapIdentity = {
  id: string;
  email: string;
  name?: string;
  replyTo?: JmapEmailAddress[];
  bcc?: JmapEmailAddress[];
  isDefault?: boolean;
};

export type JmapThreadContext = {
  accountId: string;
  threadId: string;
  latestEmailId: string;
  latestMessageId?: string;
  subject?: string;
  from: JmapEmailAddress[];
  to: JmapEmailAddress[];
  cc: JmapEmailAddress[];
  replyTo: JmapEmailAddress[];
  references: string[];
};

export type JmapInboundMessage = {
  messageId: string;
  threadId: string;
  senderEmail: string;
  senderName?: string;
  subject?: string;
  text: string;
  receivedAt: number;
  automated: boolean;
  email: JmapEmail;
};

export type JmapQueryChangesResult = {
  oldQueryState: string;
  newQueryState: string;
  removed?: string[];
  added?: Array<{
    id: string;
    index: number;
  }>;
  hasMoreChanges?: boolean;
  upToId?: string;
  total?: number;
};

export type JmapSendResult = {
  messageId: string;
  threadId?: string;
};

export type JmapSearchParams = {
  text?: string;
  from?: string;
  to?: string;
  subject?: string;
  after?: string;
  before?: string;
  unread?: boolean;
  limit?: number;
};
