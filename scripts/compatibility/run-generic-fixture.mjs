#!/usr/bin/env node

import { once } from "node:events";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { runJmapCompatibilityCheck } from "../../dist/src/compatibility.js";
import { JmapClient } from "../../dist/src/jmap-client.js";
import { runOutboundContract } from "../../dist/src/outbound-contract.js";
import { runStatefulDraftContract } from "../../dist/src/stateful-contract.js";

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
let emailStateVersion = 1;
let nextDraftId = 1;
let nextSubmissionId = 1;
const drafts = new Map();
const submissions = new Map();

function emailState() {
  return `email-state-${emailStateVersion}`;
}

function fixtureDraft(id, value) {
  return {
    id,
    blobId: `blob-${id}`,
    threadId: `thread-${id}`,
    mailboxIds: value.mailboxIds ?? {},
    keywords: value.keywords ?? {},
    from: value.from ?? [],
    to: value.to ?? [],
    cc: value.cc ?? [],
    bcc: value.bcc ?? [],
    replyTo: value.replyTo ?? [],
    subject: value.subject ?? "",
    textBody: value.textBody ?? [],
    htmlBody: [],
    bodyValues: value.bodyValues ?? {},
    attachments: value.attachments ?? [],
    size: Buffer.byteLength(JSON.stringify(value)),
  };
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (request.method === "GET" && path === "/.well-known/jmap") {
    respond(response, 200, {
      apiUrl: `${origin}/jmap`,
      downloadUrl: `${origin}/download/{accountId}/{blobId}/{name}`,
      uploadUrl: `${origin}/upload/{accountId}`,
      eventSourceUrl: `${origin}/events`,
      username: "fixture@example.test",
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
            [JMAP_SUBMISSION]: {
              maxDelayedSend: 3_600,
              submissionExtensions: {
                FUTURERELEASE: ["HOLDFOR"],
              },
            },
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
          list: [
            {
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
            },
            {
              id: "fixture-drafts",
              name: "Drafts",
              role: "drafts",
              myRights: {
                mayReadItems: true,
                maySetSeen: true,
                maySetKeywords: true,
                mayAddItems: true,
                mayRemoveItems: true,
              },
            },
          ],
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
      const ids = Array.isArray(args.ids) ? args.ids : [];
      const list = ids.flatMap((id) => {
        if (id === "fixture-email") {
          return [{ id: "fixture-email", threadId: "fixture-thread" }];
        }
        const draft = drafts.get(id);
        return draft ? [draft] : [];
      });
      return [
        method,
        {
          accountId: "fixture-account",
          state: emailState(),
          list,
          notFound: ids.filter(
            (id) => id !== "fixture-email" && !drafts.has(id),
          ),
        },
        callId,
      ];
    }
    if (method === "Email/set") {
      if (args.ifInState && args.ifInState !== emailState()) {
        return [
          "error",
          { type: "stateMismatch", description: "fixture state changed" },
          callId,
        ];
      }
      const oldState = emailState();
      const created = {};
      const destroyed = [];
      for (const [creationId, value] of Object.entries(args.create ?? {})) {
        const id = `fixture-draft-${nextDraftId}`;
        nextDraftId += 1;
        const draft = fixtureDraft(id, value);
        drafts.set(id, draft);
        created[creationId] = {
          id,
          threadId: draft.threadId,
          size: draft.size,
        };
      }
      for (const id of args.destroy ?? []) {
        if (drafts.delete(id)) {
          destroyed.push(id);
        }
      }
      if (Object.keys(created).length > 0 || destroyed.length > 0) {
        emailStateVersion += 1;
      }
      return [
        method,
        {
          accountId: "fixture-account",
          oldState,
          newState: emailState(),
          created,
          destroyed,
          notCreated: {},
          notDestroyed: {},
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
          list: [
            {
              id: "fixture-identity",
              email: "fixture@example.test",
              name: "Fixture Identity",
              replyTo: null,
              bcc: null,
              textSignature: "",
              htmlSignature: "",
              mayDelete: false,
            },
          ],
          notFound: [],
        },
        callId,
      ];
    }
    if (method === "EmailSubmission/set") {
      const created = {};
      const updated = {};
      const notUpdated = {};
      for (const [creationId, value] of Object.entries(args.create ?? {})) {
        const email = drafts.get(value.emailId);
        if (!email) {
          continue;
        }
        const id = `fixture-submission-${nextSubmissionId}`;
        nextSubmissionId += 1;
        const holdFor = Number(
          value.envelope?.mailFrom?.parameters?.HOLDFOR ?? 0,
        );
        const submission = {
          id,
          identityId: value.identityId,
          emailId: value.emailId,
          threadId: email.threadId,
          sendAt:
            holdFor > 0
              ? new Date(Date.now() + holdFor * 1_000).toISOString()
              : new Date().toISOString(),
          undoStatus: holdFor > 0 ? "pending" : "final",
          deliveryStatus:
            holdFor > 0
              ? null
              : {
                  "fixture@example.test": {
                    delivered: "queued",
                    smtpReply: "250 fixture accepted",
                  },
                },
          dsnBlobIds: [],
          mdnBlobIds: [],
        };
        submissions.set(id, submission);
        drafts.delete(value.emailId);
        created[creationId] = { id, threadId: submission.threadId };
      }
      for (const [id, patch] of Object.entries(args.update ?? {})) {
        const submission = submissions.get(id);
        if (!submission || submission.undoStatus !== "pending") {
          notUpdated[id] = { type: "cannotUnsend" };
          continue;
        }
        if (patch.undoStatus === "canceled") {
          submissions.set(id, { ...submission, undoStatus: "canceled" });
          updated[id] = null;
        }
      }
      return [
        method,
        {
          accountId: "fixture-account",
          oldState: "submission-state-1",
          newState: "submission-state-2",
          created,
          updated,
          notCreated: {},
          notUpdated,
        },
        callId,
      ];
    }
    if (method === "EmailSubmission/get") {
      const ids = Array.isArray(args.ids) ? args.ids : [];
      return [
        method,
        {
          accountId: "fixture-account",
          state: "submission-state-2",
          list: ids.flatMap((id) => {
            const submission = submissions.get(id);
            return submission ? [submission] : [];
          }),
          notFound: ids.filter((id) => !submissions.has(id)),
        },
        callId,
      ];
    }
    if (method === "EmailSubmission/query") {
      const requestedEmailIds = Array.isArray(args.filter?.emailIds)
        ? new Set(args.filter.emailIds)
        : null;
      const ids = [...submissions.values()]
        .filter(
          (submission) =>
            !requestedEmailIds || requestedEmailIds.has(submission.emailId),
        )
        .map((submission) => submission.id);
      return [
        method,
        {
          accountId: "fixture-account",
          queryState: "submission-query-state",
          canCalculateChanges: true,
          position: 0,
          ids,
          total: ids.length,
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

  const statefulOutput = process.env.STATEFUL_CONTRACT_REPORT?.trim();
  if (statefulOutput) {
    const client = new JmapClient({
      sessionUrl: `${origin}/.well-known/jmap`,
      authMode: "bearer",
      token: "fixture-token",
    });
    const statefulReport = await runStatefulDraftContract({
      client,
      serverProfile: "generic",
      forceCleanup: async (emailIds) => {
        const result = await client.callMethod("Email/set", {
          accountId: client.state.mailAccountId,
          destroy: emailIds,
        });
        const destroyed = Array.isArray(result.destroyed) ? result.destroyed : [];
        return emailIds.every((emailId) => destroyed.includes(emailId));
      },
    });
    await writeFile(
      statefulOutput,
      `${JSON.stringify(statefulReport, null, 2)}\n`,
      { mode: 0o600 },
    );
    if (statefulReport.verdict !== "compatible") {
      process.exitCode = 1;
    }
  }

  const outboundOutput = process.env.OUTBOUND_CONTRACT_REPORT?.trim();
  if (outboundOutput) {
    const client = new JmapClient({
      sessionUrl: `${origin}/.well-known/jmap`,
      authMode: "bearer",
      token: "fixture-token",
    });
    const outboundReport = await runOutboundContract({
      client,
      serverProfile: "generic",
      forceDraftCleanup: async (emailIds) => {
        const result = await client.callMethod("Email/set", {
          accountId: client.state.mailAccountId,
          destroy: emailIds,
        });
        const destroyed = Array.isArray(result.destroyed) ? result.destroyed : [];
        return emailIds.every((emailId) => destroyed.includes(emailId));
      },
    });
    await writeFile(
      outboundOutput,
      `${JSON.stringify(outboundReport, null, 2)}\n`,
      { mode: 0o600 },
    );
    if (outboundReport.verdict !== "compatible") {
      process.exitCode = 1;
    }
  }
} finally {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
