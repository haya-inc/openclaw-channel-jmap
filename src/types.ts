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
  parentId?: string | null;
  sortOrder?: number;
  totalEmails?: number;
  unreadEmails?: number;
  totalThreads?: number;
  unreadThreads?: number;
  isSubscribed?: boolean;
  myRights?: {
    mayReadItems?: boolean;
    mayAddItems?: boolean;
    mayRemoveItems?: boolean;
    maySetSeen?: boolean;
    maySetKeywords?: boolean;
    mayCreateChild?: boolean;
    mayRename?: boolean;
    mayDelete?: boolean;
    maySubmit?: boolean;
  };
};

export type JmapEmailAddress = {
  name?: string;
  email?: string;
};

export type JmapBodyPartRef = {
  partId?: string;
  blobId?: string;
  size?: number;
  name?: string | null;
  type?: string;
  charset?: string | null;
  disposition?: string | null;
  cid?: string | null;
  language?: string[] | null;
  location?: string | null;
  subParts?: JmapBodyPartRef[];
};

export type JmapBodyValue = {
  value?: string;
  isTruncated?: boolean;
};

export type JmapEmail = {
  id: string;
  blobId?: string;
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
  attachments?: JmapBodyPartRef[];
  hasAttachment?: boolean;
  keywords?: Record<string, boolean>;
  size?: number;
  "header:Auto-Submitted:asText"?: string;
  "header:Precedence:asText"?: string;
  "header:List-Id:asText"?: string;
  "header:List-Unsubscribe:asText"?: string;
  "header:List-Post:asText"?: string;
  "header:List-Help:asText"?: string;
  "header:Return-Path:asText"?: string;
  "header:X-Auto-Response-Suppress:asText"?: string;
  "header:Content-Type:asText"?: string;
};

export type JmapIdentity = {
  id: string;
  email: string;
  name?: string;
  replyTo?: JmapEmailAddress[];
  bcc?: JmapEmailAddress[];
  textSignature?: string;
  htmlSignature?: string;
  mayDelete?: boolean;
  isDefault?: boolean;
};

export type JmapDraftCreateResult = {
  emailId: string;
  threadId?: string;
  size?: number;
  identityId: string;
  identityEmail: string;
  draftsMailboxId: string;
};

export type JmapDraftAttachmentInput = {
  blobId: string;
  type?: string;
  name?: string | null;
  disposition?: string | null;
  cid?: string | null;
  language?: string[] | null;
  location?: string | null;
};

export type JmapDraftPreview = {
  emailId: string;
  blobId?: string;
  threadId?: string;
  state: string;
  previewToken: string;
  identityId: string;
  identityEmail: string;
  from: JmapEmailAddress[];
  to: JmapEmailAddress[];
  cc: JmapEmailAddress[];
  bcc: JmapEmailAddress[];
  replyTo: JmapEmailAddress[];
  subject: string;
  text: string;
  attachments: JmapBodyPartRef[];
  size?: number;
};

export type JmapDraftReplaceResult = {
  previousEmailId: string;
  emailId: string;
  threadId?: string;
  size?: number;
  identityId: string;
  identityEmail: string;
};

export type JmapSearchSnippet = {
  emailId: string;
  subject?: string | null;
  preview?: string | null;
};

export type JmapDeliveryStatus = {
  smtpReply?: string;
  delivered?: "queued" | "yes" | "no" | "unknown" | string;
  displayed?: "unknown" | "yes" | string;
};

export type JmapSubmission = {
  id: string;
  identityId?: string;
  emailId?: string;
  threadId?: string;
  sendAt?: string;
  undoStatus?: "pending" | "final" | "canceled" | string;
  deliveryStatus?: Record<string, JmapDeliveryStatus> | null;
  dsnBlobIds?: string[];
  mdnBlobIds?: string[];
};

export type JmapSubmissionResult = {
  submissionId: string;
  emailId: string;
  threadId?: string;
  sendAt?: string;
  undoStatus?: string;
  scheduled: boolean;
  maxDelayedSend: number;
  statusObserved: boolean;
};

export type JmapChangesResult = {
  dataType: "Mailbox" | "Thread" | "Email" | "Identity" | "EmailSubmission";
  oldState: string;
  newState: string;
  hasMoreChanges: boolean;
  created: string[];
  updated: string[];
  destroyed: string[];
};

export type JmapParsedEmail = Omit<JmapEmail, "id" | "receivedAt"> & {
  id?: string | null;
  receivedAt?: string | null;
};

export type JmapParseResult = {
  parsed: Record<string, JmapParsedEmail>;
  notParsable: string[];
  notFound: string[];
};

export type JmapBlobUploadResult = {
  accountId: string;
  blobId: string;
  type: string;
  size: number;
};

export type JmapImportResult = {
  created: Record<
    string,
    { id: string; blobId?: string; threadId?: string; size?: number }
  >;
  notCreated: Record<string, { type?: string; description?: string }>;
};

export type JmapCopyResult = {
  fromAccountId: string;
  accountId: string;
  created: Record<
    string,
    { id: string; blobId?: string; threadId?: string; size?: number }
  >;
  notCreated: Record<string, { type?: string; description?: string }>;
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
  /**
   * Mailbox id, role, or exact display name. "all" searches every readable
   * mailbox. Defaults to "inbox".
   */
  mailbox?: string;
  text?: string;
  from?: string;
  to?: string;
  subject?: string;
  after?: string;
  before?: string;
  unread?: boolean;
  hasAttachment?: boolean;
  minSize?: number;
  maxSize?: number;
  hasKeyword?: string;
  notKeyword?: string;
  collapseThreads?: boolean;
  position?: number;
  limit?: number;
};

export type JmapSearchPage = {
  emails: JmapEmail[];
  queryState: string;
  canCalculateChanges: boolean;
  position: number;
  total?: number;
  nextPosition?: number;
};

export type JmapThreadPage = {
  emails: JmapEmail[];
  total: number;
  offset: number;
  nextOffset?: number;
};

export type JmapMoveResult = {
  destination: JmapMailbox;
  previous: Array<{
    emailId: string;
    mailboxes: JmapMailbox[];
  }>;
};

export type JmapAutomationClassification = {
  automated: boolean;
  suppressReply: boolean;
  reasons: string[];
};
