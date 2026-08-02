import { BlockStreamingCoalesceSchema, DmConfigSchema, DmPolicySchema, GroupPolicySchema, requireOpenAllowFrom, } from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";
export const JmapAccountSchemaBase = z
    .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    authMode: z.enum(["bearer", "basic"]).optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    passwordFile: z.string().optional(),
    apiToken: z.string().optional(),
    apiTokenFile: z.string().optional(),
    sessionUrl: z.string().url().optional(),
    pollIntervalSec: z.number().int().min(5).max(300).optional(),
    outboundPolicy: z
        .enum(["disabled", "reviewed", "autonomous"])
        .optional()
        .default("reviewed"),
    inboundMode: z.enum(["full", "signal", "off"]).optional(),
    dispatchInbound: z.boolean().optional().default(true),
    autoReply: z.boolean().optional().default(false),
    markAsRead: z.boolean().optional().default(false),
    processExistingUnread: z.boolean().optional().default(false),
    maxBodyBytes: z.number().int().min(1_000).max(1_000_000).optional(),
    dmPolicy: DmPolicySchema.optional().default("allowlist"),
    allowFrom: z.array(z.string()).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    groupAllowFrom: z.array(z.string()).optional(),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    responsePrefix: z.string().optional(),
})
    .strict();
function requireAutonomousAutoReply(value, ctx) {
    if (value.autoReply === true && value.outboundPolicy !== "autonomous") {
        ctx.addIssue({
            code: "custom",
            path: ["autoReply"],
            message: 'channels.jmap.autoReply=true requires outboundPolicy="autonomous"',
        });
    }
}
export const JmapAccountSchema = JmapAccountSchemaBase.superRefine((value, ctx) => {
    requireAutonomousAutoReply(value, ctx);
    requireOpenAllowFrom({
        policy: value.dmPolicy,
        allowFrom: value.allowFrom,
        ctx,
        path: ["allowFrom"],
        message: 'channels.jmap.dmPolicy="open" requires channels.jmap.allowFrom to include "*"',
    });
});
export const JmapConfigSchema = JmapAccountSchemaBase.extend({
    accounts: z.record(z.string(), JmapAccountSchema.optional()).optional(),
}).superRefine((value, ctx) => {
    requireAutonomousAutoReply(value, ctx);
    requireOpenAllowFrom({
        policy: value.dmPolicy,
        allowFrom: value.allowFrom,
        ctx,
        path: ["allowFrom"],
        message: 'channels.jmap.dmPolicy="open" requires channels.jmap.allowFrom to include "*"',
    });
});
//# sourceMappingURL=config-schema.js.map