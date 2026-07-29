import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/channel-plugin-common";
import { missingTargetError } from "openclaw/plugin-sdk/channel-feedback";
import { runStoppablePassiveMonitor } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { CoreConfig } from "./types.js";
import type { JmapResolvedAccount } from "./types.js";
import { listJmapAccountIds, resolveDefaultJmapAccountId, resolveJmapAccount } from "./accounts.js";
import { JmapConfigSchema } from "./config-schema.js";
import { jmapPairing } from "./inbound.js";
import { monitorJmapProvider } from "./monitor.js";
import { looksLikeEmailAddress, normalizeJmapTarget, parseJmapThreadTarget } from "./normalize.js";
import { sendJmapByTarget } from "./send.js";
import { getJmapRuntimeStatus, type JmapRuntimeStatus } from "./status.js";

const meta = {
  id: "jmap",
  label: "JMAP Email",
  selectionLabel: "JMAP Email",
  docsPath: "/channels/jmap",
  docsLabel: "jmap",
  blurb: "Email thread conversations over JMAP.",
  aliases: ["jmap", "jmail"],
  order: 85,
  quickstartAllowFrom: true,
};

export const jmapPlugin: ChannelPlugin<JmapResolvedAccount> = {
  id: "jmap",
  meta,
  pairing: jmapPairing,
  capabilities: {
    chatTypes: ["direct", "thread"],
    threads: true,
    media: true,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.jmap"] },
  // OpenClaw ships its own Zod build; the runtime shape is compatible, while
  // the generated declaration identities differ across package boundaries.
  configSchema: buildChannelConfigSchema(JmapConfigSchema as never),
  config: {
    listAccountIds: (cfg) => listJmapAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) => resolveJmapAccount({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultJmapAccountId(cfg as CoreConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "jmap",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "jmap",
        accountId,
        clearBaseFields: [
          "authMode",
          "username",
          "password",
          "passwordFile",
          "apiToken",
          "apiTokenFile",
          "sessionUrl",
          "name",
        ],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      tokenSource: account.tokenSource,
      authMode: account.authMode,
      username: account.username || undefined,
      sessionUrl: account.sessionUrl,
      pollIntervalSec: account.pollIntervalSec,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveJmapAccount({ cfg: cfg as CoreConfig, accountId }).config.allowFrom ?? []).map(
        (entry) => String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.["jmap"]?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.jmap.accounts.${resolvedAccountId}.`
        : "channels.jmap.";
      return {
        policy: account.config.dmPolicy ?? "allowlist",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: `${basePath}allowFrom`,
        approveHint: formatPairingApproveHint("jmap"),
        normalizeEntry: (raw) => raw.trim().toLowerCase(),
      };
    },
  },
  messaging: {
    normalizeTarget: normalizeJmapTarget,
    targetResolver: {
      looksLikeId: (raw, normalized) => {
        const value = normalized ?? raw.trim().toLowerCase();
        return value.startsWith("thread:") || looksLikeEmailAddress(value);
      },
      hint: "<thread:<id>|email@domain>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveJmapAccount({ cfg: cfg as CoreConfig, accountId });
      const q = query?.trim().toLowerCase() || "";
      return Array.from(new Set((account.config.allowFrom ?? []).map((entry) => String(entry))))
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry && entry !== "*")
        .filter((entry) => (q ? entry.includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "user", id }) as const);
    },
    listGroups: async () => [],
  },
  resolver: {
    resolveTargets: async ({ inputs, kind }) =>
      inputs.map((input) => {
        const normalized = normalizeJmapTarget(input);
        if (!normalized) {
          return {
            input,
            resolved: false,
            note: "invalid jmap target",
          };
        }
        const isThread = normalized.startsWith("thread:");
        if (kind === "group" && !isThread) {
          return {
            input,
            resolved: false,
            note: "expected thread target",
          };
        }
        if (kind === "user" && isThread) {
          return {
            input,
            resolved: false,
            note: "expected email target",
          };
        }
        return {
          input,
          resolved: true,
          id: normalized,
          name: normalized,
        };
      }),
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "jmap",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "JMAP_API_TOKEN/JMAIL_API_TOKEN can only be used for the default account.";
      }
      if (!input.useEnv && !input.token && !input.tokenFile) {
        return "JMAP requires --token or --token-file (or --use-env).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "jmap",
        accountId,
        name: input.name,
      });

      const tokenPatch = input.useEnv
        ? {}
        : input.tokenFile
          ? { apiTokenFile: input.tokenFile }
          : input.token
            ? { apiToken: input.token }
            : {};

      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...namedConfig,
          channels: {
            ...namedConfig.channels,
            "jmap": {
              ...namedConfig.channels?.["jmap"],
              enabled: true,
              ...tokenPatch,
            },
          },
        } as OpenClawConfig;
      }

      return {
        ...namedConfig,
        channels: {
          ...namedConfig.channels,
          "jmap": {
            ...namedConfig.channels?.["jmap"],
            enabled: true,
            accounts: {
              ...namedConfig.channels?.["jmap"]?.accounts,
              [accountId]: {
                ...namedConfig.channels?.["jmap"]?.accounts?.[accountId],
                enabled: true,
                ...tokenPatch,
              },
            },
          },
        },
      } as OpenClawConfig;
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    resolveTarget: ({ to }) => {
      const normalized = to?.trim() ? normalizeJmapTarget(to) : undefined;
      if (!normalized) {
        return {
          ok: false,
          error: missingTargetError("JMAP", "<thread:<id>|email@domain>"),
        };
      }
      return {
        ok: true,
        to: normalized,
      };
    },
    sendText: async ({ cfg, to, text, accountId, threadId }) => {
      const result = await sendJmapByTarget({
        cfg: cfg as CoreConfig,
        accountId: accountId ?? undefined,
        to,
        text,
        threadId,
      });
      return {
        channel: "jmap",
        to: result.to,
        messageId: result.messageId,
        threadId: result.threadId,
      };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId, threadId }) => {
      const result = await sendJmapByTarget({
        cfg: cfg as CoreConfig,
        accountId: accountId ?? undefined,
        to,
        text,
        mediaUrl,
        threadId,
      });
      return {
        channel: "jmap",
        to: result.to,
        messageId: result.messageId,
        threadId: result.threadId,
      };
    },
  },
  status: {
    defaultRuntime: {
      ...getJmapRuntimeStatus(DEFAULT_ACCOUNT_ID),
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      sessionUrl: snapshot.baseUrl ?? null,
      mode: snapshot.mode ?? null,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => {
      const activity = runtime as
        | (typeof runtime & Partial<JmapRuntimeStatus>)
        | undefined;
      const observed = getJmapRuntimeStatus(account.accountId);
      const latest = (left: number | null, right?: number | null): number | null =>
        Math.max(left ?? 0, right ?? 0) || null;
      const runtimeToolAt = activity?.lastToolCallAt ?? null;
      const useRuntimeTool =
        runtimeToolAt !== null &&
        (observed.lastToolCallAt === null || runtimeToolAt > observed.lastToolCallAt);
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        tokenSource: account.tokenSource,
        authMode: account.authMode,
        baseUrl: account.sessionUrl,
        mode: `polling:${account.pollIntervalSec}s`,
        running: activity?.running ?? false,
        lastStartAt: activity?.lastStartAt ?? null,
        lastStopAt: activity?.lastStopAt ?? null,
        lastError: activity?.lastError ?? null,
        lastInboundAt: latest(observed.lastInboundAt, activity?.lastInboundAt),
        lastOutboundAt: latest(observed.lastOutboundAt, activity?.lastOutboundAt),
        lastPollAt: latest(observed.lastPollAt, activity?.lastPollAt),
        lastSuccessfulPollAt: latest(
          observed.lastSuccessfulPollAt,
          activity?.lastSuccessfulPollAt,
        ),
        lastPollErrorAt: latest(observed.lastPollErrorAt, activity?.lastPollErrorAt),
        pollCount: Math.max(observed.pollCount, activity?.pollCount ?? 0),
        pollErrorCount: Math.max(observed.pollErrorCount, activity?.pollErrorCount ?? 0),
        lastInboundMessageAt: latest(
          observed.lastInboundMessageAt,
          activity?.lastInboundMessageAt,
        ),
        lastInboundLatencyMs:
          latest(observed.lastInboundAt, activity?.lastInboundAt) === activity?.lastInboundAt
            ? (activity?.lastInboundLatencyMs ?? observed.lastInboundLatencyMs)
            : observed.lastInboundLatencyMs,
        inboundCount: Math.max(observed.inboundCount, activity?.inboundCount ?? 0),
        outboundCount: Math.max(observed.outboundCount, activity?.outboundCount ?? 0),
        lastToolCallAt: latest(observed.lastToolCallAt, runtimeToolAt),
        lastToolSucceededAt: latest(
          observed.lastToolSucceededAt,
          activity?.lastToolSucceededAt,
        ),
        lastToolErrorAt: latest(observed.lastToolErrorAt, activity?.lastToolErrorAt),
        lastToolName: useRuntimeTool
          ? (activity?.lastToolName ?? null)
          : observed.lastToolName,
        lastToolDurationMs: useRuntimeTool
          ? (activity?.lastToolDurationMs ?? null)
          : observed.lastToolDurationMs,
        toolCallCount: Math.max(observed.toolCallCount, activity?.toolCallCount ?? 0),
        toolErrorCount: Math.max(observed.toolErrorCount, activity?.toolErrorCount ?? 0),
        dmPolicy: account.config.dmPolicy ?? "allowlist",
        dispatchInbound: account.config.dispatchInbound !== false,
        autoReply: account.config.autoReply === true,
        markAsRead: account.config.markAsRead === true,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      if (!account.configured) {
        throw new Error(
          `JMAP is not configured for account "${account.accountId}" (missing API token).`,
        );
      }
      ctx.log?.info(
        `[${account.accountId}] starting JMAP poller (session=${account.sessionUrl}, interval=${account.pollIntervalSec}s)`,
      );

      await runStoppablePassiveMonitor({
        abortSignal: ctx.abortSignal,
        start: async () =>
          monitorJmapProvider({
            accountId: account.accountId,
            config: ctx.cfg as CoreConfig,
            abortSignal: ctx.abortSignal,
            statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
          }),
      });
    },
  },
};

export function resolveJmapThreadIdFromTarget(raw: string): string | null {
  const normalized = normalizeJmapTarget(raw);
  if (!normalized) {
    return null;
  }
  return parseJmapThreadTarget(normalized);
}
