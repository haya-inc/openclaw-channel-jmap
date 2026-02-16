import { describe, expect, it } from "vitest";
import { JmapClient } from "./jmap-client.js";

describe("JmapClient account id resolution", () => {
  it("ignores unknown accountIdHint for mail account", () => {
    const client = new JmapClient({
      sessionUrl: "https://example.invalid/session",
      token: "token",
      accountIdHint: "default",
    }) as unknown as {
      resolveMailAccountId: (session: {
        primaryAccounts?: Record<string, string>;
        accounts?: Record<string, unknown>;
      }) => string;
    };

    const accountId = client.resolveMailAccountId({
      primaryAccounts: {
        "urn:ietf:params:jmap:mail": "u123",
      },
      accounts: {
        u123: {},
      },
    });

    expect(accountId).toBe("u123");
  });

  it("uses known accountIdHint", () => {
    const client = new JmapClient({
      sessionUrl: "https://example.invalid/session",
      token: "token",
      accountIdHint: "u999",
    }) as unknown as {
      resolveMailAccountId: (session: {
        primaryAccounts?: Record<string, string>;
        accounts?: Record<string, unknown>;
      }) => string;
    };

    const accountId = client.resolveMailAccountId({
      primaryAccounts: {
        "urn:ietf:params:jmap:mail": "u123",
      },
      accounts: {
        u123: {},
        u999: {},
      },
    });

    expect(accountId).toBe("u999");
  });
});
