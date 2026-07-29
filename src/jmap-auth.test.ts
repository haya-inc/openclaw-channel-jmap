import { afterEach, describe, expect, it, vi } from "vitest";
import { JmapClient } from "./jmap-client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("JmapClient authentication and mutations", () => {
  it("uses Basic authentication for both discovery and API calls", async () => {
    const authorizations: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        authorizations.push(new Headers(init?.headers).get("Authorization") ?? "");
        if (init?.method === "GET") {
          return jsonResponse({
            apiUrl: "https://mail.example.com/jmap",
            username: "miyu@example.com",
            capabilities: {
              "urn:ietf:params:jmap:core": {},
              "urn:ietf:params:jmap:mail": {},
              "urn:ietf:params:jmap:submission": {},
            },
            primaryAccounts: {
              "urn:ietf:params:jmap:mail": "mail",
              "urn:ietf:params:jmap:submission": "mail",
            },
            accounts: {
              mail: {
                accountCapabilities: {
                  "urn:ietf:params:jmap:mail": {},
                  "urn:ietf:params:jmap:submission": {},
                },
              },
            },
          });
        }
        const body = JSON.parse(String(init?.body)) as {
          methodCalls: Array<[string, Record<string, unknown>, string]>;
        };
        const [method, _args, callId] = body.methodCalls[0];
        if (method === "Mailbox/get") {
          return jsonResponse({
            methodResponses: [["Mailbox/get", { list: [{ id: "inbox", role: "inbox" }] }, callId]],
          });
        }
        return jsonResponse({
          methodResponses: [
            [
              "Identity/get",
              { list: [{ id: "identity", email: "miyu@example.com" }] },
              callId,
            ],
          ],
        });
      }),
    );

    const client = new JmapClient({
      sessionUrl: "https://mail.example.com/.well-known/jmap",
      authMode: "basic",
      username: "miyu@example.com",
      token: "app-password",
    });
    await client.init();

    const expected = `Basic ${Buffer.from("miyu@example.com:app-password").toString("base64")}`;
    expect(authorizations).toHaveLength(3);
    expect(authorizations.every((value) => value === expected)).toBe(true);
  });

  it("uses JMAP patch paths so changing read state preserves other keywords", async () => {
    const requests: Array<Array<[string, Record<string, unknown>, string]>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          methodCalls: Array<[string, Record<string, unknown>, string]>;
        };
        requests.push(body.methodCalls);
        const [method, _args, callId] = body.methodCalls[0];
        return jsonResponse({ methodResponses: [[method, {}, callId]] });
      }),
    );

    const client = new JmapClient({
      sessionUrl: "https://mail.example.com/.well-known/jmap",
      token: "token",
    }) as unknown as JmapClient & {
      initState: {
        apiUrl: string;
        mailAccountId: string;
        submissionAccountId: string;
        identityId: string;
        identityEmail: string;
        selfEmails: Set<string>;
      };
    };
    client.initState = {
      apiUrl: "https://mail.example.com/jmap",
      mailAccountId: "mail",
      submissionAccountId: "mail",
      identityId: "identity",
      identityEmail: "miyu@example.com",
      selfEmails: new Set(["miyu@example.com"]),
    };

    await client.updateEmailKeywords(["email-1"], { seen: true, flagged: false });

    expect(requests[0][0][1]).toEqual({
      accountId: "mail",
      update: {
        "email-1": {
          "keywords/$seen": true,
          "keywords/$flagged": false,
        },
      },
    });
  });
});
