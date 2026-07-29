import { sleep } from "openclaw/plugin-sdk/runtime-env";
import { resolveJmapAccount } from "./accounts.js";
import { handleJmapInbound } from "./inbound.js";
import { createJmapInboundDeduper } from "./inbound-dedupe.js";
import { JmapClient, parseInboundEmail } from "./jmap-client.js";
import { getJmapRuntime } from "./runtime.js";
import { isRecoverableJmapPollError } from "./send.js";
import { bindJmapStatusSink, recordJmapPollError, recordJmapPollSuccess, } from "./status.js";
import { clearJmapAccountState, setJmapClient, setThreadContext } from "./store.js";
const UNREAD_SWEEP_LIMIT = 50;
const UNREAD_SWEEP_MAX_ROUNDS = 20;
const RECENT_INBOUND_CACHE_LIMIT = 2000;
function formatError(error) {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === "string") {
        return error;
    }
    try {
        return JSON.stringify(error);
    }
    catch {
        return String(error);
    }
}
async function pollLoop(params) {
    const { client, account, config, abortSignal } = params;
    const runtimeCore = getJmapRuntime();
    const runtime = getJmapRuntime().logging.getChildLogger({
        channel: "jmap",
        accountId: account.accountId,
    });
    const deduper = await createJmapInboundDeduper({
        accountId: account.accountId,
        maxEntries: RECENT_INBOUND_CACHE_LIMIT,
        logger: runtime,
    });
    const processEmailIds = async (ids, source) => {
        const unseenIds = deduper.filterUnprocessed(ids);
        if (unseenIds.length === 0) {
            return;
        }
        runtime.info(`processing inbound candidates source=${source} total=${ids.length} unseen=${unseenIds.length}`);
        const emails = await client.getEmails(unseenIds);
        const sorted = emails.slice().sort((a, b) => {
            const at = Date.parse(a.receivedAt ?? a.sentAt ?? "") || 0;
            const bt = Date.parse(b.receivedAt ?? b.sentAt ?? "") || 0;
            return at - bt;
        });
        for (const email of sorted) {
            if (abortSignal.aborted) {
                break;
            }
            const emailId = email.id.trim();
            if (!emailId || deduper.has(emailId)) {
                continue;
            }
            const inbound = parseInboundEmail({
                email,
                maxBodyBytes: account.config.maxBodyBytes,
            });
            if (!inbound) {
                runtime.info(`skip inbound email=${email.id} reason=invalid-content`);
                await deduper.remember(emailId);
                continue;
            }
            if (client.isSelfAddress(inbound.senderEmail)) {
                runtime.info(`skip inbound email=${email.id} reason=self-sender sender=${inbound.senderEmail}`);
                await deduper.remember(emailId);
                continue;
            }
            const threadContext = client.buildThreadContext(email);
            if (threadContext) {
                setThreadContext(threadContext);
            }
            await handleJmapInbound({
                message: {
                    messageId: email.id,
                    threadId: inbound.threadId,
                    senderEmail: inbound.senderEmail,
                    senderName: inbound.senderName,
                    subject: inbound.subject,
                    text: inbound.text,
                    receivedAt: inbound.timestampMs,
                    automated: inbound.automated,
                    email,
                },
                account,
                config,
            });
            runtimeCore.channel.activity.record({
                channel: "jmap",
                accountId: account.accountId,
                direction: "inbound",
                at: inbound.timestampMs,
            });
            if (account.config.markAsRead === true) {
                try {
                    await client.markEmailsSeen([email.id]);
                }
                catch (error) {
                    runtime.warn(`failed to mark email seen email=${email.id} error=${formatError(error)}`);
                }
            }
            await deduper.remember(emailId);
            runtime.info(`handled inbound email=${email.id} thread=${inbound.threadId} sender=${inbound.senderEmail}`);
        }
    };
    const runUnreadSweep = async (reason) => {
        let position = 0;
        for (let round = 0; round < UNREAD_SWEEP_MAX_ROUNDS; round += 1) {
            if (abortSignal.aborted) {
                break;
            }
            const unreadIds = await client.queryUnreadInboxIds({
                limit: UNREAD_SWEEP_LIMIT,
                position,
            });
            const unseenUnreadIds = deduper.filterUnprocessed(unreadIds);
            runtime.info(`unread sweep reason=${reason} round=${round + 1} position=${position} total=${unreadIds.length} unseen=${unseenUnreadIds.length}`);
            if (unreadIds.length === 0) {
                break;
            }
            if (unseenUnreadIds.length > 0) {
                await processEmailIds(unseenUnreadIds, "unread-sweep");
                // Unread set changed after processing; restart paging from the beginning.
                position = 0;
            }
            else {
                position += unreadIds.length;
            }
            if (unreadIds.length < UNREAD_SWEEP_LIMIT) {
                break;
            }
        }
    };
    let queryState = await client.queryInboxState();
    runtime.info(`poll loop ready queryState=${queryState}`);
    if (account.config.processExistingUnread === true) {
        await runUnreadSweep("startup");
    }
    while (!abortSignal.aborted) {
        try {
            const changes = await client.queryInboxChanges(queryState);
            queryState = changes.newQueryState || queryState;
            const addedIds = (changes.added ?? [])
                .map((entry) => entry.id)
                .filter((entry) => Boolean(entry?.trim()));
            if (addedIds.length > 0) {
                await processEmailIds(addedIds, "query-changes");
            }
            recordJmapPollSuccess(account.accountId);
            if (changes.hasMoreChanges) {
                continue;
            }
            await sleep(Math.max(1, account.pollIntervalSec) * 1000);
        }
        catch (error) {
            const message = formatError(error);
            recordJmapPollError(account.accountId, message);
            if (isRecoverableJmapPollError(error)) {
                runtime.warn(`recoverable poll error: ${message}; resetting query state`);
                queryState = await client.queryInboxState();
                continue;
            }
            runtime.error(`poll error: ${message}`);
            await sleep(3000);
        }
    }
}
export async function monitorJmapProvider(opts) {
    const core = getJmapRuntime();
    const config = opts.config ?? core.config.loadConfig();
    const account = resolveJmapAccount({
        cfg: config,
        accountId: opts.accountId,
    });
    if (!account.configured || !account.token.trim()) {
        throw new Error(`JMAP is not configured for account "${account.accountId}" (missing API token).`);
    }
    const client = new JmapClient({
        sessionUrl: account.sessionUrl,
        token: account.token,
        authMode: account.authMode,
        username: account.username,
    });
    const init = await client.init();
    core.logging
        .getChildLogger({
        channel: "jmap",
        accountId: account.accountId,
    })
        .info(`initialized jmap client apiUrl=${init.apiUrl} mailAccountId=${init.mailAccountId} submissionAccountId=${init.submissionAccountId} identity=${init.identityEmail}`);
    setJmapClient(account.accountId, client);
    const unbindStatus = bindJmapStatusSink(account.accountId, opts.statusSink);
    const controller = new AbortController();
    const externalSignal = opts.abortSignal;
    const onAbort = () => controller.abort();
    if (externalSignal) {
        if (externalSignal.aborted) {
            controller.abort();
        }
        else {
            externalSignal.addEventListener("abort", onAbort, { once: true });
        }
    }
    void pollLoop({
        client,
        account,
        config,
        abortSignal: controller.signal,
    }).catch((error) => {
        const logger = core.logging.getChildLogger({
            channel: "jmap",
            accountId: account.accountId,
        });
        logger.error(`monitor loop exited: ${formatError(error)}`);
        recordJmapPollError(account.accountId, formatError(error));
    });
    return {
        stop: () => {
            controller.abort();
            if (externalSignal) {
                externalSignal.removeEventListener("abort", onAbort);
            }
            unbindStatus();
            clearJmapAccountState(account.accountId);
        },
    };
}
//# sourceMappingURL=monitor.js.map