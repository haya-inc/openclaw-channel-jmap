import { afterEach, describe, expect, it } from "vitest";
import type { CoreConfig } from "./types.js";
import { resolveJmapAccount } from "./accounts.js";

afterEach(() => {
  delete process.env.JMAP_API_TOKEN;
  delete process.env.JMAIL_API_TOKEN;
  delete process.env.JMAP_SESSION_URL;
});

describe("resolveJmapAccount", () => {
  it("uses env token for default account", () => {
    process.env.JMAIL_API_TOKEN = "test-token";
    const account = resolveJmapAccount({
      cfg: {} as CoreConfig,
      accountId: "default",
    });

    expect(account.configured).toBe(true);
    expect(account.tokenSource).toBe("env");
    expect(account.token).toBe("test-token");
  });

  it("prefers config token over empty env", () => {
    const account = resolveJmapAccount({
      cfg: {
        channels: {
          jmap: {
            apiToken: "config-token",
          },
        },
      } as CoreConfig,
      accountId: "default",
    });

    expect(account.configured).toBe(true);
    expect(account.tokenSource).toBe("config");
    expect(account.token).toBe("config-token");
  });
});
