import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  runStatefulDraftContract,
  type StatefulDraftContractClient,
} from "./stateful-contract.js";

function successfulClient(): StatefulDraftContractClient {
  return {
    init: async () => ({}),
    listIdentities: async () => [{ id: "identity-1", email: "test@example.test" }],
    createDraft: async () => ({
      emailId: "draft-1",
      identityId: "identity-1",
      identityEmail: "test@example.test",
      draftsMailboxId: "drafts",
    }),
    previewDraft: async ({ emailId }) => {
      if (emailId === "discarded") {
        throw Object.assign(new Error("gone"), { type: "notFound" });
      }
      const revised = emailId === "draft-2";
      return {
        emailId,
        state: revised ? "state-2" : "state-1",
        previewToken: revised ? "token-2" : "token-1",
        identityId: "identity-1",
        identityEmail: "test@example.test",
        from: [{ email: "test@example.test" }],
        to: [],
        cc: [],
        bcc: [],
        replyTo: [],
        subject: revised
          ? "OpenClaw JMAP draft contract revised"
          : "OpenClaw JMAP draft contract",
        text: revised
          ? "stage two: replace and preview again"
          : "stage one: create and preview",
        attachments: [],
      };
    },
    replaceDraft: async () => ({
      previousEmailId: "draft-1",
      emailId: "draft-2",
      identityId: "identity-1",
      identityEmail: "test@example.test",
    }),
    discardDraft: async ({ previewToken }) => {
      if (previewToken === "token-1") {
        throw Object.assign(new Error("stale"), { type: "stalePreview" });
      }
      return { discarded: true };
    },
  };
}

describe("stateful draft contract", () => {
  it("reports the complete recipient-free lifecycle without an outbound action", async () => {
    let discarded = false;
    const client = successfulClient();
    const originalPreview = client.previewDraft;
    client.previewDraft = async (params) => {
      if (discarded && params.emailId === "draft-2") {
        throw Object.assign(new Error("gone"), { type: "notFound" });
      }
      return await originalPreview(params);
    };
    const originalDiscard = client.discardDraft;
    client.discardDraft = async (params) => {
      const result = await originalDiscard(params);
      discarded = true;
      return result;
    };

    const report = await runStatefulDraftContract({
      client,
      serverProfile: "generic",
      forceCleanup: async () => false,
    });

    expect(report.verdict).toBe("compatible");
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
    expect(report.probePolicy).toMatchObject({
      recipientsUsed: false,
      submissionAttempted: false,
      externalDeliveryAttempted: false,
      cleanupConfirmed: true,
    });
    const schema = JSON.parse(
      readFileSync(
        new URL("../stateful-contract-report.schema.json", import.meta.url),
        "utf8",
      ),
    );
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    expect(ajv.compile(schema)(report)).toBe(true);
  });

  it("redacts fixture content and force-cleans a draft after preview failure", async () => {
    const client = successfulClient();
    client.previewDraft = async () => {
      throw Object.assign(new Error("sensitive draft-1 body"), {
        type: "unsupported",
      });
    };
    let cleanupIds: string[] = [];

    const report = await runStatefulDraftContract({
      client,
      serverProfile: "stalwart",
      forceCleanup: async (emailIds) => {
        cleanupIds = emailIds;
        return true;
      },
    });

    expect(report.verdict).toBe("incompatible");
    expect(report.checks.find((check) => check.id === "draft-preview")).toEqual({
      id: "draft-preview",
      status: "fail",
      errorType: "unsupported",
    });
    expect(cleanupIds).toEqual(["draft-1"]);
    expect(JSON.stringify(report)).not.toContain("sensitive");
    expect(JSON.stringify(report)).not.toContain("draft-1");
  });
});
