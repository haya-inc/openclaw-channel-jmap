import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getJmapRuntime } from "./runtime.js";
const JMAP_INBOUND_DEDUPE_VERSION = 1;
const DEFAULT_JMAP_INBOUND_DEDUPE_LIMIT = 2000;
function normalizeAccountId(accountId) {
    const trimmed = accountId?.trim();
    if (!trimmed) {
        return "default";
    }
    return trimmed.replace(/[^a-z0-9._-]+/gi, "_").toLowerCase();
}
function normalizeEmailId(raw) {
    return raw?.trim() ?? "";
}
function resolveJmapInboundDedupePath(accountId) {
    const stateDir = getJmapRuntime().state.resolveStateDir(process.env, os.homedir);
    const normalized = normalizeAccountId(accountId);
    return path.join(stateDir, "jmap", `inbound-dedupe-${normalized}.json`);
}
function parseState(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (parsed?.version !== JMAP_INBOUND_DEDUPE_VERSION) {
            return null;
        }
        const processedEmailIds = Array.isArray(parsed.processedEmailIds)
            ? parsed.processedEmailIds.filter((entry) => typeof entry === "string")
            : [];
        return {
            version: JMAP_INBOUND_DEDUPE_VERSION,
            processedEmailIds,
        };
    }
    catch {
        return null;
    }
}
async function loadProcessedIds(filePath) {
    try {
        const raw = await fs.readFile(filePath, "utf-8");
        return parseState(raw)?.processedEmailIds ?? [];
    }
    catch (error) {
        const code = error.code;
        if (code === "ENOENT") {
            return [];
        }
        return [];
    }
}
async function writeProcessedIds(filePath, ids) {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmpPath = path.join(dir, `${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
    const payload = {
        version: JMAP_INBOUND_DEDUPE_VERSION,
        processedEmailIds: ids,
    };
    await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
    await fs.chmod(tmpPath, 0o600);
    await fs.rename(tmpPath, filePath);
}
function buildTracker(seedIds, limit) {
    const seen = new Set();
    const order = [];
    const add = (emailId) => {
        const normalized = normalizeEmailId(emailId);
        if (!normalized || seen.has(normalized)) {
            return false;
        }
        seen.add(normalized);
        order.push(normalized);
        while (order.length > limit) {
            const oldest = order.shift();
            if (oldest) {
                seen.delete(oldest);
            }
        }
        return true;
    };
    for (const id of seedIds) {
        add(id);
    }
    const has = (emailId) => {
        const normalized = normalizeEmailId(emailId);
        if (!normalized) {
            return false;
        }
        return seen.has(normalized);
    };
    const filterUnprocessed = (ids) => {
        const dedupedInput = new Set();
        const output = [];
        for (const raw of ids) {
            const normalized = normalizeEmailId(raw);
            if (!normalized || seen.has(normalized) || dedupedInput.has(normalized)) {
                continue;
            }
            dedupedInput.add(normalized);
            output.push(normalized);
        }
        return output;
    };
    return {
        has,
        filterUnprocessed,
        add,
        snapshot: () => [...order],
        size: () => seen.size,
    };
}
export async function createJmapInboundDeduper(params) {
    const filePath = resolveJmapInboundDedupePath(params.accountId);
    const limit = typeof params.maxEntries === "number" && Number.isFinite(params.maxEntries)
        ? Math.max(1, Math.trunc(params.maxEntries))
        : DEFAULT_JMAP_INBOUND_DEDUPE_LIMIT;
    const seedIds = await loadProcessedIds(filePath);
    const tracker = buildTracker(seedIds, limit);
    params.logger?.info?.(`inbound dedupe ready entries=${tracker.size()} limit=${limit} path=${filePath}`);
    return {
        filePath,
        size: tracker.size,
        has: tracker.has,
        filterUnprocessed: tracker.filterUnprocessed,
        remember: async (emailId) => {
            const inserted = tracker.add(emailId);
            if (!inserted) {
                return false;
            }
            try {
                await writeProcessedIds(filePath, tracker.snapshot());
            }
            catch (error) {
                params.logger?.warn?.(`inbound dedupe persist failed path=${filePath} error=${String(error)}`);
            }
            return true;
        },
        rememberMany: async (emailIds) => {
            let inserted = 0;
            for (const emailId of emailIds) {
                if (tracker.add(emailId)) {
                    inserted += 1;
                }
            }
            if (inserted === 0) {
                return 0;
            }
            try {
                await writeProcessedIds(filePath, tracker.snapshot());
            }
            catch (error) {
                params.logger?.warn?.(`inbound dedupe persist failed path=${filePath} error=${String(error)}`);
            }
            return inserted;
        },
    };
}
//# sourceMappingURL=inbound-dedupe.js.map