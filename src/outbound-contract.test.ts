import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  runOutboundContract,
  type OutboundContractClient,
} from "./outbound-contract.js";
import type { JmapSubmission } from "./types.js";

function contractClient(maxDelayedSend: number): {
  client: OutboundContractClient;
  submittedRecipients: string[][];
} {
  let nextDraft = 1;
  let nextSubmission = 1;
  const drafts = new Map<
    string,
    { identityId: string; to: string[]; subject: string; text: string }
  >();
  const submissions = new Map<string, JmapSubmission>();
  const submittedRecipients: string[][] = [];

  const client: OutboundContractClient = {
    init: async () => ({ maxDelayedSend }),
    listIdentities: async () => [
      { id: "identity-1", email: "self@example.test" },
    ],
    createDraft: async (params) => {
      const emailId = `draft-${nextDraft}`;
      nextDraft += 1;
      drafts.set(emailId, params);
      return {
        emailId,
        identityId: params.identityId,
        identityEmail: "self@example.test",
        draftsMailboxId: "drafts",
      };
    },
    previewDraft: async ({ emailId, identityId }) => {
      const draft = drafts.get(emailId);
      if (!draft) {
        throw Object.assign(new Error("gone"), { type: "notFound" });
      }
      return {
        emailId,
        state: `state-${emailId}`,
        previewToken: `token-${emailId}`,
        identityId,
        identityEmail: "self@example.test",
        from: [{ email: "self@example.test" }],
        to: draft.to.map((email) => ({ email })),
        cc: [],
        bcc: [],
        replyTo: [],
        subject: draft.subject,
        text: draft.text,
        attachments: [],
      };
    },
    submitDraft: async ({ emailId, sendAt }) => {
      const draft = drafts.get(emailId);
      if (!draft) {
        throw Object.assign(new Error("gone"), { type: "notFound" });
      }
      if (sendAt && maxDelayedSend === 0) {
        throw Object.assign(new Error("unsupported"), { type: "unsupported" });
      }
      submittedRecipients.push([...draft.to]);
      const submissionId = `submission-${nextSubmission}`;
      nextSubmission += 1;
      const submission: JmapSubmission = {
        id: submissionId,
        emailId,
        undoStatus: sendAt ? "pending" : "final",
        deliveryStatus: sendAt
          ? null
          : { "self@example.test": { delivered: "queued" } },
      };
      submissions.set(submissionId, submission);
      drafts.delete(emailId);
      return {
        submissionId,
        emailId,
        scheduled: Boolean(sendAt),
        maxDelayedSend,
        statusObserved: true,
        undoStatus: submission.undoStatus,
      };
    },
    getSubmissions: async (ids) =>
      ids.flatMap((id) => {
        const submission = submissions.get(id);
        return submission ? [submission] : [];
      }),
    querySubmissions: async ({ emailId }) => ({
      submissions: [...submissions.values()].filter(
        (submission) => submission.emailId === emailId,
      ),
    }),
    cancelSubmission: async (submissionId) => {
      const submission = submissions.get(submissionId);
      if (!submission) {
        throw Object.assign(new Error("gone"), { type: "notFound" });
      }
      if (submission.undoStatus !== "pending") {
        throw Object.assign(new Error("final"), { type: "cannotUnsend" });
      }
      const canceled = { ...submission, undoStatus: "canceled" };
      submissions.set(submissionId, canceled);
      return canceled;
    },
    discardDraft: async ({ emailId }) => {
      drafts.delete(emailId);
      return { discarded: true };
    },
  };
  return { client, submittedRecipients };
}

describe("self-addressed outbound contract", () => {
  it("verifies explicit submission and fail-closed scheduling", async () => {
    const { client, submittedRecipients } = contractClient(0);
    const report = await runOutboundContract({
      client,
      serverProfile: "generic",
      forceDraftCleanup: async () => true,
      now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    });

    expect(report.verdict).toBe("compatible");
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
    expect(report.observations).toMatchObject({
      acceptanceObserved: true,
      submissionStatusObserved: true,
      deliveryStatusObserved: true,
      immediateUndoStatus: "final",
      scheduling: "unsupported",
    });
    expect(report.probePolicy.finalDeliveryClaimed).toBe(false);
    expect(submittedRecipients).toEqual([["self@example.test"]]);

    const schema = JSON.parse(
      readFileSync(
        new URL("../outbound-contract-report.schema.json", import.meta.url),
        "utf8",
      ),
    );
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    expect(ajv.compile(schema)(report)).toBe(true);
  });

  it("schedules only within the advertised window and cancels while pending", async () => {
    const { client, submittedRecipients } = contractClient(3_600);
    const report = await runOutboundContract({
      client,
      serverProfile: "stalwart",
      forceDraftCleanup: async () => true,
      now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    });

    expect(report.verdict).toBe("compatible");
    expect(report.observations.scheduling).toBe("canceled");
    expect(submittedRecipients).toEqual([
      ["self@example.test"],
      ["self@example.test"],
    ]);
  });

  it("reports a server that advertises pending delivery but rejects cancellation", async () => {
    const { client } = contractClient(3_600);
    client.cancelSubmission = async () => {
      throw Object.assign(new Error("server refused cancellation"), {
        type: "cannotUnsend",
      });
    };

    const report = await runOutboundContract({
      client,
      serverProfile: "cyrus",
      forceDraftCleanup: async () => true,
    });

    expect(report.verdict).toBe("compatible");
    expect(report.observations.scheduling).toBe("uncancelable");
    expect(report.probePolicy.finalDeliveryClaimed).toBe(false);
  });

  it.each([
    {
      name: "unsupported submission lookup methods",
      errorType: "unknownMethod",
      get: "unsupported",
      query: "unsupported",
    },
    {
      name: "immediately expired submission records",
      errorType: "notFound",
      get: "unavailable",
      query: "unavailable",
    },
  ])("reports $name without claiming final delivery", async (scenario) => {
    const { client } = contractClient(0);
    if (scenario.errorType === "unknownMethod") {
      client.getSubmissions = async () => {
        throw Object.assign(new Error("unsupported"), {
          type: "unknownMethod",
        });
      };
      client.querySubmissions = async () => {
        throw Object.assign(new Error("unsupported"), {
          type: "unknownMethod",
        });
      };
    } else {
      client.getSubmissions = async () => [];
      client.querySubmissions = async () => ({ submissions: [] });
    }
    client.cancelSubmission = async () => {
      throw Object.assign(new Error("not observable"), {
        type: scenario.errorType,
      });
    };

    const report = await runOutboundContract({
      client,
      serverProfile: "apache-james",
      forceDraftCleanup: async () => true,
    });

    expect(report.verdict).toBe("compatible");
    expect(report.observations).toMatchObject({
      submissionGet: scenario.get,
      submissionQuery: scenario.query,
      submissionStatusObserved: false,
      deliveryStatusObserved: false,
    });
    expect(report.probePolicy.finalDeliveryClaimed).toBe(false);
  });

  it("refuses an identity that would silently Bcc an external recipient", async () => {
    const { client } = contractClient(0);
    client.listIdentities = async () => [
      {
        id: "identity-1",
        email: "self@example.test",
        bcc: [{ email: "audit@outside.test" }],
      },
    ];
    let createAttempted = false;
    client.createDraft = async () => {
      createAttempted = true;
      throw new Error("must not run");
    };

    const report = await runOutboundContract({
      client,
      serverProfile: "fastmail",
      forceDraftCleanup: async () => true,
    });

    expect(report.verdict).toBe("incompatible");
    expect(report.checks.find((check) => check.id === "identity-safety")).toEqual({
      id: "identity-safety",
      status: "fail",
      errorType: "unsafeIdentity",
    });
    expect(createAttempted).toBe(false);
    expect(report.probePolicy.submissionAttempted).toBe(false);
  });

  it("does not claim cleanup after an ambiguous submission failure", async () => {
    const { client } = contractClient(0);
    client.submitDraft = async () => {
      throw Object.assign(new Error("connection lost"), {
        type: "networkFailure",
      });
    };
    let cleanupAttempted = false;

    const report = await runOutboundContract({
      client,
      serverProfile: "stalwart",
      forceDraftCleanup: async () => {
        cleanupAttempted = true;
        return true;
      },
    });

    expect(report.verdict).toBe("incompatible");
    expect(report.probePolicy).toMatchObject({
      submissionAttempted: true,
      cleanupConfirmed: false,
      finalDeliveryClaimed: false,
    });
    expect(cleanupAttempted).toBe(false);
  });
});
