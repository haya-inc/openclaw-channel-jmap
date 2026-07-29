import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  runJmapCompatibilityCheck,
  type JmapCompatibilityScope,
  type JmapServerProfile,
} from "./compatibility.js";
import { JmapMockServer } from "./test-utils/jmap-mock-server.js";
import type { CoreConfig } from "./types.js";
import { JMAP_CORE, JMAP_MAIL, JMAP_SUBMISSION } from "./types.js";

function configFor(server: JmapMockServer): CoreConfig {
  return {
    channels: {
      jmap: {
        enabled: true,
        authMode: "bearer",
        apiToken: "test-token",
        sessionUrl: server.sessionUrl,
      },
    },
  };
}

function enqueueProbe(params: {
  server: JmapMockServer;
  submission?: boolean;
  manageRights?: boolean;
  sampleEmail?: boolean;
}) {
  const { server } = params;
  server.enqueueMethod("Mailbox/get", {
    accountId: "acc-1",
    list: [
      {
        id: "inbox-1",
        role: "inbox",
        name: "Inbox",
        ...(params.manageRights
          ? {
              myRights: {
                mayReadItems: true,
                maySetSeen: true,
                maySetKeywords: true,
                mayAddItems: true,
                mayRemoveItems: true,
              },
            }
          : {}),
      },
    ],
  });
  if (params.submission) {
    server.enqueueMethod("Identity/get", {
      accountId: "acc-1",
      list: [{ id: "identity-1", email: "bot@example.com" }],
    });
  }
  server.enqueueMethod("Email/query", {
    accountId: "acc-1",
    queryState: "query-1",
    ids: [],
  });
  server.enqueueMethod("Email/queryChanges", {
    accountId: "acc-1",
    oldQueryState: "query-1",
    newQueryState: "query-1",
    added: [],
    removed: [],
    hasMoreChanges: false,
  });
  server.enqueueMethod("Email/query", {
    accountId: "acc-1",
    queryState: "query-1",
    ids: params.sampleEmail ? ["email-1"] : [],
  });
  if (params.sampleEmail) {
    server.enqueueMethod("Email/get", {
      accountId: "acc-1",
      list: [{ id: "email-1", threadId: "thread-1" }],
    });
    server.enqueueMethod("Thread/get", {
      accountId: "acc-1",
      list: [{ id: "thread-1", emailIds: ["email-1"] }],
    });
  }
}

async function runProfile(params: {
  server: JmapMockServer;
  profile: JmapServerProfile;
  scope: JmapCompatibilityScope;
}) {
  return await runJmapCompatibilityCheck({
    config: configFor(params.server),
    serverProfile: params.profile,
    scope: params.scope,
  });
}

describe("JMAP compatibility profiles", () => {
  let server: JmapMockServer;

  beforeEach(async () => {
    server = await JmapMockServer.start();
  });

  afterEach(async () => {
    await server.close();
  });

  it("classifies a Stalwart-like full capability session as full compatible", async () => {
    enqueueProbe({
      server,
      submission: true,
      manageRights: true,
      sampleEmail: true,
    });

    const report = await runProfile({
      server,
      profile: "stalwart",
      scope: "full",
    });

    expect(report.verdict).toBe("compatible");
    expect(report.features).toMatchObject({
      receivePolling: "verified",
      search: "verified",
      read: "verified",
      thread: "verified",
      update: "advertised",
      send: "advertised",
      push: "advertised",
      attachmentDownload: "advertised",
      attachmentUpload: "advertised",
    });
    expect(report.probePolicy).toEqual({
      sideEffectsPerformed: false,
      messageBodiesRead: false,
      messageIdentifiersExposed: false,
      outboundDeliveryVerified: false,
    });
    const schema = JSON.parse(
      readFileSync(new URL("../compatibility-report.schema.json", import.meta.url), "utf8"),
    ) as object;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    expect(ajv.validate(schema, report), ajv.errorsText()).toBe(true);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("email-1");
    expect(serialized).not.toContain("thread-1");
    expect(serialized).not.toContain("test-token");
    expect(serialized).not.toContain(server.apiUrl);
  });

  it("classifies a Fastmail-like Submission session as send compatible", async () => {
    enqueueProbe({
      server,
      submission: true,
      sampleEmail: false,
    });

    const report = await runProfile({
      server,
      profile: "fastmail",
      scope: "send",
    });

    expect(report.verdict).toBe("compatible");
    expect(report.features.send).toBe("advertised");
    expect(report.checks.find((check) => check.id === "email-metadata")).toMatchObject({
      status: "skip",
      code: "empty-mailbox",
    });
  });

  it("keeps a Cyrus-like Mail-only session compatible for read scope", async () => {
    server.setSession({
      capabilities: {
        [JMAP_CORE]: {},
        [JMAP_MAIL]: {},
      },
      primaryAccounts: {
        [JMAP_MAIL]: "acc-1",
      },
      accounts: {
        "acc-1": {
          accountCapabilities: {
            [JMAP_MAIL]: {},
          },
        },
      },
    });
    enqueueProbe({ server, sampleEmail: false });

    const report = await runProfile({
      server,
      profile: "cyrus",
      scope: "read",
    });

    expect(report.verdict).toBe("compatible");
    expect(report.features.send).toBe("unsupported");
    expect(server.getCalls("Identity/get")).toHaveLength(0);
    for (const request of server.getRequests()) {
      const parsed = JSON.parse(request.bodyText) as { using?: string[] };
      expect(parsed.using).not.toContain(JMAP_SUBMISSION);
    }
  });

  it("reports an Apache James-like Mail-only session as partial for send scope", async () => {
    server.setSession({
      capabilities: {
        [JMAP_CORE]: {},
        [JMAP_MAIL]: {},
      },
      primaryAccounts: {
        [JMAP_MAIL]: "acc-1",
      },
      accounts: {
        "acc-1": {
          accountCapabilities: {
            [JMAP_MAIL]: {},
          },
        },
      },
    });
    enqueueProbe({ server, sampleEmail: true });

    const report = await runProfile({
      server,
      profile: "apache-james",
      scope: "send",
    });

    expect(report.verdict).toBe("partial");
    expect(report.checks.find((check) => check.id === "submission-capability")).toMatchObject({
      status: "fail",
      required: true,
      code: "capability-missing",
    });
  });

  it("rejects a generic session that does not advertise JMAP Core", async () => {
    server.setSession({
      capabilities: {
        [JMAP_MAIL]: {},
      },
    });
    enqueueProbe({
      server,
      submission: true,
      sampleEmail: false,
    });

    const report = await runProfile({
      server,
      profile: "generic",
      scope: "read",
    });

    expect(report.verdict).toBe("incompatible");
    expect(report.checks.find((check) => check.id === "core-capability")).toMatchObject({
      status: "fail",
      required: true,
    });
  });

  it("returns an unverified report without contacting a server when credentials are absent", async () => {
    const report = await runJmapCompatibilityCheck({
      config: {
        channels: {
          jmap: {
            sessionUrl: server.sessionUrl,
          },
        },
      },
      serverProfile: "generic",
      scope: "read",
    });

    expect(report.verdict).toBe("unverified");
    expect(report.checks).toEqual([
      {
        id: "configuration",
        status: "fail",
        required: true,
        evidence: "not-run",
        code: "credentials-missing",
      },
    ]);
    expect(server.getRequests()).toHaveLength(0);
  });
});
