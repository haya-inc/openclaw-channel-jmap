import {
  createReplyPrefixOptions,
  formatPairingApproveHint,
  logInboundDrop,
  PAIRING_APPROVED_MESSAGE,
  resolveControlCommandGate,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import type { CoreConfig, JmapInboundMessage, JmapResolvedAccount } from "./types.js";
import { getJmapRuntime } from "./runtime.js";
import { sendJmapReplyToThread } from "./send.js";
import { resolveThreadSession } from "./thread-session.js";

const CHANNEL_ID = "jmap-email" as const;

function normalizeAllowFrom(entries?: string[]): string[] {
  return (entries ?? []).map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

function senderAllowed(senderEmail: string, allowFrom: string[]): boolean {
  if (allowFrom.includes("*")) {
    return true;
  }
  const normalized = senderEmail.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return allowFrom.includes(normalized);
}

export async function handleJmapInbound(params: {
  message: JmapInboundMessage;
  account: JmapResolvedAccount;
  config: CoreConfig;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { message, account, config, statusSink } = params;
  const core = getJmapRuntime();
  const runtime = core.logging.getChildLogger({
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  const rawBody = message.text.trim();
  if (!rawBody) {
    return;
  }

  statusSink?.({ lastInboundAt: message.receivedAt });

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const configAllowFrom = normalizeAllowFrom(account.config.allowFrom);
  const shouldComputeCommandAuth = core.channel.commands.shouldComputeCommandAuthorized(
    rawBody,
    config as OpenClawConfig,
  );
  const storeAllowFrom =
    dmPolicy !== "open" || shouldComputeCommandAuth
      ? await core.channel.pairing.readAllowFromStore(CHANNEL_ID).catch(() => [])
      : [];
  const effectiveAllowFrom = normalizeAllowFrom([
    ...configAllowFrom,
    ...storeAllowFrom.map((entry) => String(entry)),
  ]);

  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config as OpenClawConfig,
    surface: CHANNEL_ID,
  });
  const senderAllowedForCommands = senderAllowed(message.senderEmail, effectiveAllowFrom);
  const hasControlCommand = core.channel.text.hasControlCommand(rawBody, config as OpenClawConfig);
  const commandGate = resolveControlCommandGate({
    useAccessGroups: config.commands?.useAccessGroups !== false,
    authorizers: [
      {
        configured: effectiveAllowFrom.length > 0,
        allowed: senderAllowedForCommands,
      },
    ],
    allowTextCommands,
    hasControlCommand,
  });
  const commandAuthorized = commandGate.commandAuthorized;

  if (dmPolicy === "disabled") {
    runtime.debug?.(`drop sender=${message.senderEmail} (dmPolicy=disabled)`);
    return;
  }

  if (dmPolicy !== "open" && !senderAllowedForCommands) {
    if (dmPolicy === "pairing") {
      const { code, created } = await core.channel.pairing.upsertPairingRequest({
        channel: CHANNEL_ID,
        id: message.senderEmail,
        meta: {
          name: message.senderName,
          subject: message.subject,
        },
      });
      if (created) {
        try {
          await sendJmapReplyToThread({
            accountId: account.accountId,
            threadId: message.threadId,
            text: core.channel.pairing.buildPairingReply({
              channel: CHANNEL_ID,
              idLine: `Your email id: ${message.senderEmail}`,
              code,
            }),
          });
          statusSink?.({ lastOutboundAt: Date.now() });
        } catch (err) {
          runtime.error(`pairing reply failed for ${message.senderEmail}: ${String(err)}`);
        }
      }
    }
    runtime.debug?.(`drop sender=${message.senderEmail} (dmPolicy=${dmPolicy})`);
    return;
  }

  if (commandGate.shouldBlock) {
    logInboundDrop({
      log: (line) => runtime.info(line),
      channel: CHANNEL_ID,
      reason: "control command (unauthorized)",
      target: message.senderEmail,
    });
    return;
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: "direct",
      id: message.senderEmail,
    },
  });

  const threadRoute = resolveThreadSession({
    baseSessionKey: route.sessionKey,
    threadId: message.threadId,
  });

  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config as OpenClawConfig);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: threadRoute.sessionKey,
  });

  const fromLabel = message.senderName
    ? `${message.senderName} <${message.senderEmail}>`
    : message.senderEmail;
  const subjectLabel = message.subject?.trim() || "(no subject)";
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "JMAP Email",
    from: `${fromLabel} · ${subjectLabel}`,
    timestamp: message.receivedAt,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `jmap:${message.senderEmail}`,
    To: `jmap:thread:${message.threadId}`,
    SessionKey: threadRoute.sessionKey,
    ParentSessionKey: threadRoute.parentSessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: `Email thread: ${subjectLabel}`,
    SenderName: message.senderName,
    SenderId: message.senderEmail,
    SenderUsername: message.senderEmail,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: message.messageId,
    MessageSidFull: message.messageId,
    MessageThreadId: message.threadId,
    ThreadLabel: subjectLabel,
    Timestamp: message.receivedAt,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `jmap:thread:${message.threadId}`,
    CommandAuthorized: commandAuthorized,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? threadRoute.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error(`failed updating session meta: ${String(err)}`);
    },
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config as OpenClawConfig,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config as OpenClawConfig,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (payload) => {
        await sendJmapReplyToThread({
          accountId: account.accountId,
          threadId: message.threadId,
          text: payload.text ?? "",
          mediaUrls: payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : undefined),
        });
        statusSink?.({ lastOutboundAt: Date.now() });
      },
      onError: (err, info) => {
        runtime.error(`${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      onModelSelected,
      disableBlockStreaming:
        typeof account.config.blockStreaming === "boolean"
          ? !account.config.blockStreaming
          : undefined,
    },
  });
}

export const jmapPairing = {
  idLabel: "email",
  normalizeAllowEntry: (entry: string) => entry.trim().toLowerCase(),
  notifyApproval: async ({ id }: { id: string }) => {
    const targetEmail = id.trim().toLowerCase();
    if (!targetEmail) {
      throw new Error("invalid email for pairing approval");
    }
    const hint = formatPairingApproveHint(CHANNEL_ID);
    await sendJmapReplyToAddress({
      toEmail: targetEmail,
      text: `${PAIRING_APPROVED_MESSAGE}\n\n${hint}`,
      subject: "OpenClaw pairing approved",
    });
  },
};

async function sendJmapReplyToAddress(params: { toEmail: string; text: string; subject?: string }) {
  const { sendJmapMessageToAddress } = await import("./send.js");
  await sendJmapMessageToAddress(params);
}
