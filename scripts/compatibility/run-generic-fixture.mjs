#!/usr/bin/env node

import { once } from "node:events";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { runJmapCompatibilityCheck } from "../../dist/src/compatibility.js";

const JMAP_CORE = "urn:ietf:params:jmap:core";
const JMAP_MAIL = "urn:ietf:params:jmap:mail";
const JMAP_SUBMISSION = "urn:ietf:params:jmap:submission";

function readRequest(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function respond(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

let origin = "";
let emailQueryCount = 0;
const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (request.method === "GET" && path === "/.well-known/jmap") {
    respond(response, 200, {
      apiUrl: `${origin}/jmap`,
      downloadUrl: `${origin}/download/{accountId}/{blobId}/{name}`,
      uploadUrl: `${origin}/upload/{accountId}`,
      eventSourceUrl: `${origin}/events`,
      capabilities: {
        [JMAP_CORE]: {},
        [JMAP_MAIL]: {},
        [JMAP_SUBMISSION]: {},
      },
      primaryAccounts: {
        [JMAP_MAIL]: "fixture-account",
        [JMAP_SUBMISSION]: "fixture-account",
      },
      accounts: {
        "fixture-account": {
          accountCapabilities: {
            [JMAP_MAIL]: {},
            [JMAP_SUBMISSION]: {},
          },
        },
      },
    });
    return;
  }
  if (request.method !== "POST" || path !== "/jmap") {
    respond(response, 404, { error: "not-found" });
    return;
  }

  const body = JSON.parse(await readRequest(request));
  const methodResponses = body.methodCalls.map(([method, args, callId]) => {
    if (method === "Mailbox/get") {
      return [
        method,
        {
          accountId: "fixture-account",
          state: "mailbox-state",
          list: [{
            id: "fixture-inbox",
            name: "Inbox",
            role: "inbox",
            myRights: {
              mayReadItems: true,
              maySetSeen: true,
              maySetKeywords: true,
              mayAddItems: true,
              mayRemoveItems: true,
            },
          }],
        },
        callId,
      ];
    }
    if (method === "Email/query") {
      emailQueryCount += 1;
      return [
        method,
        {
          accountId: "fixture-account",
          queryState: "email-query-state",
          canCalculateChanges: true,
          ids: emailQueryCount === 1 ? [] : ["fixture-email"],
          position: 0,
          total: 1,
        },
        callId,
      ];
    }
    if (method === "Email/queryChanges") {
      return [
        method,
        {
          accountId: "fixture-account",
          oldQueryState: args.sinceQueryState,
          newQueryState: "email-query-state",
          added: [],
          removed: [],
          hasMoreChanges: false,
        },
        callId,
      ];
    }
    if (method === "Email/get") {
      return [
        method,
        {
          accountId: "fixture-account",
          state: "email-state",
          list: [{ id: "fixture-email", threadId: "fixture-thread" }],
          notFound: [],
        },
        callId,
      ];
    }
    if (method === "Thread/get") {
      return [
        method,
        {
          accountId: "fixture-account",
          state: "thread-state",
          list: [{ id: "fixture-thread", emailIds: ["fixture-email"] }],
          notFound: [],
        },
        callId,
      ];
    }
    if (method === "Identity/get") {
      return [
        method,
        {
          accountId: "fixture-account",
          state: "identity-state",
          list: [{ id: "fixture-identity", email: "fixture@example.test" }],
          notFound: [],
        },
        callId,
      ];
    }
    return [
      "error",
      { type: "unknownMethod", description: `${method} is outside the safe fixture` },
      callId,
    ];
  });
  respond(response, 200, {
    methodResponses,
    sessionState: "fixture-session-state",
  });
});

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server did not bind");
  }
  origin = `http://127.0.0.1:${address.port}`;
  const report = await runJmapCompatibilityCheck({
    config: {
      channels: {
        jmap: {
          enabled: true,
          authMode: "bearer",
          apiToken: "fixture-token",
          sessionUrl: `${origin}/.well-known/jmap`,
        },
      },
    },
    serverProfile: "generic",
    scope: "full",
  });
  const output = process.env.COMPATIBILITY_REPORT ?? "compatibility-report.json";
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  if (report.verdict !== "compatible") {
    process.exitCode = 1;
  }
} finally {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
