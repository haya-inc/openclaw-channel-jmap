import { readFileSync } from "node:fs";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type { CoreConfig, JmapAccountConfig, JmapResolvedAccount } from "./types.js";
import { DEFAULT_JMAP_SESSION_URL, DEFAULT_POLL_INTERVAL_SEC } from "./types.js";

function normalizeSessionUrl(raw?: string): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    return DEFAULT_JMAP_SESSION_URL;
  }
  return trimmed;
}

function normalizePollInterval(raw?: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_POLL_INTERVAL_SEC;
  }
  const normalized = Math.trunc(raw);
  if (normalized < 5) {
    return 5;
  }
  if (normalized > 300) {
    return 300;
  }
  return normalized;
}

function listConfiguredAccountIds(cfg: CoreConfig): string[] {
  const accounts = cfg.channels?.["jmap-email"]?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  const ids = new Set<string>();
  for (const key of Object.keys(accounts)) {
    if (key.trim()) {
      ids.add(normalizeAccountId(key));
    }
  }
  return [...ids];
}

function resolveAccountConfig(cfg: CoreConfig, accountId: string): JmapAccountConfig | undefined {
  const accounts = cfg.channels?.["jmap-email"]?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  const direct = accounts[accountId] as JmapAccountConfig | undefined;
  if (direct) {
    return direct;
  }
  const normalized = normalizeAccountId(accountId);
  const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
  return matchKey ? (accounts[matchKey] as JmapAccountConfig | undefined) : undefined;
}

function mergeJmapAccountConfig(cfg: CoreConfig, accountId: string): JmapAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.["jmap-email"] ?? {}) as JmapAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

function resolveEnvToken(accountId: string): string {
  if (accountId !== DEFAULT_ACCOUNT_ID) {
    return "";
  }
  return process.env.JMAP_API_TOKEN?.trim() || process.env.JMAIL_API_TOKEN?.trim() || "";
}

function resolveToken(
  cfg: CoreConfig,
  accountId: string,
): { token: string; source: JmapResolvedAccount["tokenSource"] } {
  const merged = mergeJmapAccountConfig(cfg, accountId);

  const envToken = resolveEnvToken(accountId);
  if (envToken) {
    return { token: envToken, source: "env" };
  }

  if (merged.apiTokenFile?.trim()) {
    try {
      const fileToken = readFileSync(merged.apiTokenFile.trim(), "utf-8").trim();
      if (fileToken) {
        return { token: fileToken, source: "tokenFile" };
      }
    } catch {
      // Ignore unreadable file here; status will show unconfigured.
    }
  }

  if (merged.apiToken?.trim()) {
    return { token: merged.apiToken.trim(), source: "config" };
  }

  return { token: "", source: "none" };
}

function hasTopLevelTokenConfig(cfg: CoreConfig): boolean {
  const jmap = cfg.channels?.["jmap-email"];
  if (!jmap) {
    return false;
  }
  return Boolean(jmap.apiToken?.trim() || jmap.apiTokenFile?.trim());
}

export function listJmapAccountIds(cfg: CoreConfig): string[] {
  const ids = new Set<string>(listConfiguredAccountIds(cfg));
  if (hasTopLevelTokenConfig(cfg) || resolveEnvToken(DEFAULT_ACCOUNT_ID)) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }
  if (ids.size === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return [...ids].toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultJmapAccountId(cfg: CoreConfig): string {
  const ids = listJmapAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveJmapAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): JmapResolvedAccount {
  const hasExplicitAccountId = Boolean(params.accountId?.trim());
  const baseEnabled = params.cfg.channels?.["jmap-email"]?.enabled !== false;

  const resolve = (accountId: string): JmapResolvedAccount => {
    const merged = mergeJmapAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;
    const tokenResolution = resolveToken(params.cfg, accountId);
    const sessionUrl = normalizeSessionUrl(
      merged.sessionUrl ||
        (accountId === DEFAULT_ACCOUNT_ID ? process.env.JMAP_SESSION_URL : undefined),
    );
    const pollIntervalSec = normalizePollInterval(merged.pollIntervalSec);

    return {
      accountId,
      enabled,
      configured: tokenResolution.source !== "none",
      name: merged.name?.trim() || undefined,
      token: tokenResolution.token,
      tokenSource: tokenResolution.source,
      sessionUrl,
      pollIntervalSec,
      config: merged,
    };
  };

  const normalized = normalizeAccountId(params.accountId);
  const primary = resolve(normalized);
  if (hasExplicitAccountId) {
    return primary;
  }
  if (primary.configured) {
    return primary;
  }

  const fallbackId = resolveDefaultJmapAccountId(params.cfg);
  if (fallbackId === primary.accountId) {
    return primary;
  }
  const fallback = resolve(fallbackId);
  if (!fallback.configured) {
    return primary;
  }
  return fallback;
}

export function listEnabledJmapAccounts(cfg: CoreConfig): JmapResolvedAccount[] {
  return listJmapAccountIds(cfg)
    .map((accountId) => resolveJmapAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
