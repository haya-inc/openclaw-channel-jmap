import { afterEach, describe, expect, it } from "vitest";
import { JmapAccountSchema } from "./config-schema.js";
import type { CoreConfig } from "./types.js";
import { resolveJmapAccount } from "./accounts.js";

afterEach(() => {
  delete process.env.JMAP_API_TOKEN;
  delete process.env.JMAIL_API_TOKEN;
  delete process.env.JMAP_USERNAME;
  delete process.env.JMAP_PASSWORD;
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

  it("uses basic auth from the standard JMAP environment variables", () => {
    process.env.JMAP_USERNAME = "miyu@example.com";
    process.env.JMAP_PASSWORD = "app-password";
    const account = resolveJmapAccount({
      cfg: {} as CoreConfig,
      accountId: "default",
    });

    expect(account.configured).toBe(true);
    expect(account.authMode).toBe("basic");
    expect(account.username).toBe("miyu@example.com");
    expect(account.token).toBe("app-password");
    expect(account.tokenSource).toBe("env");
  });

  it("defaults risky mailbox side effects to off", () => {
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

    expect(account.config.autoReply).not.toBe(true);
    expect(account.config.markAsRead).not.toBe(true);
    expect(account.config.processExistingUnread).not.toBe(true);
    expect(account.config.dispatchInbound).not.toBe(false);
  });

  it("defaults outbound delivery to reviewed and requires autonomous auto-reply", () => {
    expect(JmapAccountSchema.parse({}).outboundPolicy).toBe("reviewed");
    expect(() => JmapAccountSchema.parse({ autoReply: true })).toThrow(
      /outboundPolicy=.*autonomous/,
    );
    expect(
      JmapAccountSchema.parse({
        autoReply: true,
        outboundPolicy: "autonomous",
      }),
    ).toMatchObject({
      autoReply: true,
      outboundPolicy: "autonomous",
    });
  });
});
