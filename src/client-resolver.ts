import { resolveJmapAccount } from "./accounts.js";
import { JmapClient } from "./jmap-client.js";
import { getJmapRuntime } from "./runtime.js";
import { getJmapClient, setJmapClient } from "./store.js";
import type { CoreConfig, JmapResolvedAccount } from "./types.js";

export function resolveConfiguredJmapAccount(params: {
  accountId?: string | null;
  cfg?: CoreConfig;
}): JmapResolvedAccount {
  const cfg =
    params.cfg ??
    (getJmapRuntime().config.current() as unknown as CoreConfig);
  const account = resolveJmapAccount({ cfg, accountId: params.accountId });
  if (!account.configured || !account.token.trim()) {
    throw new Error(
      `JMAP is not configured for account "${account.accountId}" ` +
        "(set channels.jmap.apiToken/apiTokenFile or JMAP_API_TOKEN/JMAIL_API_TOKEN).",
    );
  }
  return account;
}

export async function resolveJmapClient(params: {
  accountId?: string | null;
  cfg?: CoreConfig;
  account?: JmapResolvedAccount;
}): Promise<{
  account: JmapResolvedAccount;
  client: JmapClient;
}> {
  const account =
    params.account ??
    resolveConfiguredJmapAccount({
      accountId: params.accountId,
      cfg: params.cfg,
    });
  const cached = getJmapClient(account.accountId);
  if (cached) {
    if (!cached.isReady) {
      await cached.init();
    }
    return { account, client: cached };
  }

  const client = new JmapClient({
    sessionUrl: account.sessionUrl,
    token: account.token,
    authMode: account.authMode,
    username: account.username,
  });
  await client.init();
  setJmapClient(account.accountId, client);
  return { account, client };
}
