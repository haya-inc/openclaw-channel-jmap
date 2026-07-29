import { applyAccountNameToChannelSection, buildChannelConfigSchema, DEFAULT_ACCOUNT_ID, deleteAccountFromConfigSection, formatPairingApproveHint, normalizeAccountId, setAccountEnabledInConfigSection, } from "openclaw/plugin-sdk/channel-plugin-common";
import { missingTargetError } from "openclaw/plugin-sdk/channel-feedback";
import { runStoppablePassiveMonitor } from "openclaw/plugin-sdk/extension-shared";
import { listJmapAccountIds, resolveDefaultJmapAccountId, resolveJmapAccount } from "./accounts.js";
import { JmapConfigSchema } from "./config-schema.js";
import { jmapPairing } from "./inbound.js";
import { monitorJmapProvider } from "./monitor.js";
import { looksLikeEmailAddress, normalizeJmapTarget, parseJmapThreadTarget } from "./normalize.js";
import { sendJmapByTarget } from "./send.js";
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
export const jmapPlugin = {
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
    configSchema: buildChannelConfigSchema(JmapConfigSchema),
    config: {
        listAccountIds: (cfg) => listJmapAccountIds(cfg),
        resolveAccount: (cfg, accountId) => resolveJmapAccount({ cfg: cfg, accountId }),
        defaultAccountId: (cfg) => resolveDefaultJmapAccountId(cfg),
        setAccountEnabled: ({ cfg, accountId, enabled }) => setAccountEnabledInConfigSection({
            cfg,
            sectionKey: "jmap",
            accountId,
            enabled,
            allowTopLevel: true,
        }),
        deleteAccount: ({ cfg, accountId }) => deleteAccountFromConfigSection({
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
        resolveAllowFrom: ({ cfg, accountId }) => (resolveJmapAccount({ cfg: cfg, accountId }).config.allowFrom ?? []).map((entry) => String(entry)),
        formatAllowFrom: ({ allowFrom }) => allowFrom.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean),
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
            const account = resolveJmapAccount({ cfg: cfg, accountId });
            const q = query?.trim().toLowerCase() || "";
            return Array.from(new Set((account.config.allowFrom ?? []).map((entry) => String(entry))))
                .map((entry) => entry.trim().toLowerCase())
                .filter((entry) => entry && entry !== "*")
                .filter((entry) => (q ? entry.includes(q) : true))
                .slice(0, limit && limit > 0 ? limit : undefined)
                .map((id) => ({ kind: "user", id }));
        },
        listGroups: async () => [],
    },
    resolver: {
        resolveTargets: async ({ inputs, kind }) => inputs.map((input) => {
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
        applyAccountName: ({ cfg, accountId, name }) => applyAccountNameToChannelSection({
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
                };
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
            };
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
                cfg: cfg,
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
                cfg: cfg,
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
        buildAccountSnapshot: ({ account, runtime }) => ({
            accountId: account.accountId,
            name: account.name,
            enabled: account.enabled,
            configured: account.configured,
            tokenSource: account.tokenSource,
            authMode: account.authMode,
            baseUrl: account.sessionUrl,
            mode: `polling:${account.pollIntervalSec}s`,
            running: runtime?.running ?? false,
            lastStartAt: runtime?.lastStartAt ?? null,
            lastStopAt: runtime?.lastStopAt ?? null,
            lastError: runtime?.lastError ?? null,
            lastInboundAt: runtime?.lastInboundAt ?? null,
            lastOutboundAt: runtime?.lastOutboundAt ?? null,
            dmPolicy: account.config.dmPolicy ?? "allowlist",
            autoReply: account.config.autoReply === true,
            markAsRead: account.config.markAsRead === true,
        }),
    },
    gateway: {
        startAccount: async (ctx) => {
            const account = ctx.account;
            if (!account.configured) {
                throw new Error(`JMAP is not configured for account "${account.accountId}" (missing API token).`);
            }
            ctx.log?.info(`[${account.accountId}] starting JMAP poller (session=${account.sessionUrl}, interval=${account.pollIntervalSec}s)`);
            await runStoppablePassiveMonitor({
                abortSignal: ctx.abortSignal,
                start: async () => monitorJmapProvider({
                    accountId: account.accountId,
                    config: ctx.cfg,
                    abortSignal: ctx.abortSignal,
                    statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
                }),
            });
        },
    },
};
export function resolveJmapThreadIdFromTarget(raw) {
    const normalized = normalizeJmapTarget(raw);
    if (!normalized) {
        return null;
    }
    return parseJmapThreadTarget(normalized);
}
//# sourceMappingURL=channel.js.map