import { readFileSync } from "node:fs";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
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
  const accounts = cfg.channels?.["jmap"]?.accounts;
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
  const accounts = cfg.channels?.["jmap"]?.accounts;
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
  const { accounts: _ignored, ...base } = (cfg.channels?.["jmap"] ?? {}) as JmapAccountConfig & {
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

function readCredentialFile(filePath?: string): string {
  if (!filePath?.trim()) {
    return "";
  }
  try {
    return readFileSync(filePath.trim(), "utf-8").trim();
  } catch {
    return "";
  }
}

function resolveCredential(
  cfg: CoreConfig,
  accountId: string,
): {
  authMode: JmapResolvedAccount["authMode"];
  username: string;
  token: string;
  source: JmapResolvedAccount["tokenSource"];
} {
  const merged = mergeJmapAccountConfig(cfg, accountId);
  const useEnv = accountId === DEFAULT_ACCOUNT_ID;
  const username = (
    merged.username ??
    (useEnv ? process.env.JMAP_USERNAME : undefined) ??
    ""
  ).trim();
  const passwordFromEnv = useEnv ? process.env.JMAP_PASSWORD?.trim() ?? "" : "";
  const passwordFromFile = readCredentialFile(merged.passwordFile);
  const password = passwordFromEnv || passwordFromFile || merged.password?.trim() || "";
  const inferredMode = username || password ? "basic" : "bearer";
  const authMode = merged.authMode ?? inferredMode;

  if (authMode === "basic") {
    const source = passwordFromEnv
      ? "env"
      : passwordFromFile
        ? "passwordFile"
        : password
          ? "config"
          : "none";
    return { authMode, username, token: password, source };
  }

  const envToken = resolveEnvToken(accountId);
  if (envToken) {
    return { authMode, username: "", token: envToken, source: "env" };
  }

  const fileToken = readCredentialFile(merged.apiTokenFile);
  if (fileToken) {
    return { authMode, username: "", token: fileToken, source: "tokenFile" };
  }

  if (merged.apiToken?.trim()) {
    return { authMode, username: "", token: merged.apiToken.trim(), source: "config" };
  }

  return { authMode, username: "", token: "", source: "none" };
}

function hasTopLevelCredentialConfig(cfg: CoreConfig): boolean {
  const jmap = cfg.channels?.["jmap"];
  if (!jmap) {
    return false;
  }
  return Boolean(
    jmap.apiToken?.trim() ||
      jmap.apiTokenFile?.trim() ||
      jmap.password?.trim() ||
      jmap.passwordFile?.trim() ||
      (process.env.JMAP_USERNAME?.trim() && process.env.JMAP_PASSWORD?.trim()),
  );
}

export function listJmapAccountIds(cfg: CoreConfig): string[] {
  const ids = new Set<string>(listConfiguredAccountIds(cfg));
  if (hasTopLevelCredentialConfig(cfg) || resolveEnvToken(DEFAULT_ACCOUNT_ID)) {
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
  const baseEnabled = params.cfg.channels?.["jmap"]?.enabled !== false;

  const resolve = (accountId: string): JmapResolvedAccount => {
    const merged = mergeJmapAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;
    const credential = resolveCredential(params.cfg, accountId);
    const sessionUrl = normalizeSessionUrl(
      merged.sessionUrl ||
        (accountId === DEFAULT_ACCOUNT_ID ? process.env.JMAP_SESSION_URL : undefined),
    );
    const pollIntervalSec = normalizePollInterval(merged.pollIntervalSec);

    return {
      accountId,
      enabled,
      configured:
        credential.source !== "none" &&
        (credential.authMode === "bearer" || Boolean(credential.username)),
      name: merged.name?.trim() || undefined,
      authMode: credential.authMode,
      username: credential.username,
      token: credential.token,
      tokenSource: credential.source,
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
