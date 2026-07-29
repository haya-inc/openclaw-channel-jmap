import type {
  JmapDraftCreateResult,
  JmapDraftPreview,
  JmapDraftReplaceResult,
  JmapIdentity,
} from "./types.js";

export const STATEFUL_DRAFT_CONTRACT = "draft-lifecycle-v1";

export const STATEFUL_DRAFT_CHECK_IDS = [
  "session",
  "identity-list",
  "draft-create",
  "draft-preview",
  "draft-replace",
  "replacement-preview",
  "stale-preview-rejection",
  "draft-discard",
  "discard-confirmation",
] as const;

type CheckId = (typeof STATEFUL_DRAFT_CHECK_IDS)[number];
type CheckStatus = "pass" | "fail" | "not-run";

export type StatefulDraftContractClient = {
  init(): Promise<unknown>;
  listIdentities(): Promise<JmapIdentity[]>;
  createDraft(params: {
    identityId: string;
    subject: string;
    text: string;
  }): Promise<JmapDraftCreateResult>;
  previewDraft(params: {
    emailId: string;
    identityId: string;
  }): Promise<JmapDraftPreview>;
  replaceDraft(params: {
    emailId: string;
    previewToken: string;
    identityId: string;
    subject: string;
    text: string;
  }): Promise<JmapDraftReplaceResult>;
  discardDraft(params: {
    emailId: string;
    previewToken: string;
    identityId: string;
  }): Promise<{ discarded: true }>;
};

export type StatefulDraftContractReport = {
  schemaVersion: 1;
  generatedAt: string;
  serverProfile: string;
  contract: typeof STATEFUL_DRAFT_CONTRACT;
  verdict: "compatible" | "incompatible";
  checks: Array<{
    id: CheckId;
    status: CheckStatus;
    errorType?: string;
  }>;
  probePolicy: {
    sideEffectsPerformed: true;
    permittedSideEffects: ["draft-create", "draft-replace", "draft-destroy"];
    recipientsUsed: false;
    submissionAttempted: false;
    externalDeliveryAttempted: false;
    onlyTestDraftBodiesRead: true;
    cleanupConfirmed: boolean;
  };
};

type ForceCleanup = (emailIds: string[]) => Promise<boolean>;

function errorType(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "type" in error &&
    typeof error.type === "string" &&
    error.type.trim()
  ) {
    return error.type.trim();
  }
  return error instanceof Error && error.name ? error.name : "unknown";
}

function assertExactPreview(
  preview: JmapDraftPreview,
  expected: { subject: string; text: string },
): void {
  if (
    preview.subject !== expected.subject ||
    preview.text.trim() !== expected.text ||
    preview.to.length + preview.cc.length + preview.bcc.length !== 0 ||
    !preview.previewToken.trim()
  ) {
    throw Object.assign(new Error("Draft preview did not match the contract fixture"), {
      type: "previewMismatch",
    });
  }
}

export async function runStatefulDraftContract(params: {
  client: StatefulDraftContractClient;
  serverProfile: string;
  forceCleanup: ForceCleanup;
}): Promise<StatefulDraftContractReport> {
  const checks = STATEFUL_DRAFT_CHECK_IDS.map((id) => ({
    id,
    status: "not-run" as CheckStatus,
  }));
  const activeDraftIds = new Set<string>();
  let currentCheck: CheckId = "session";
  let cleanupConfirmed = true;

  const pass = (id: CheckId) => {
    const check = checks.find((entry) => entry.id === id);
    if (check) {
      check.status = "pass";
    }
  };
  const fail = (id: CheckId, error: unknown) => {
    const check = checks.find((entry) => entry.id === id);
    if (check) {
      check.status = "fail";
      Object.assign(check, { errorType: errorType(error) });
    }
  };

  try {
    currentCheck = "session";
    await params.client.init();
    pass(currentCheck);

    currentCheck = "identity-list";
    const identities = await params.client.listIdentities();
    const identityId = identities[0]?.id?.trim();
    if (!identityId) {
      throw Object.assign(new Error("No JMAP Identity is available"), {
        type: "identityUnavailable",
      });
    }
    pass(currentCheck);

    const firstFixture = {
      subject: "OpenClaw JMAP draft contract",
      text: "stage one: create and preview",
    };
    currentCheck = "draft-create";
    const created = await params.client.createDraft({
      identityId,
      ...firstFixture,
    });
    activeDraftIds.add(created.emailId);
    pass(currentCheck);

    currentCheck = "draft-preview";
    const firstPreview = await params.client.previewDraft({
      emailId: created.emailId,
      identityId,
    });
    assertExactPreview(firstPreview, firstFixture);
    pass(currentCheck);

    const replacementFixture = {
      subject: "OpenClaw JMAP draft contract revised",
      text: "stage two: replace and preview again",
    };
    currentCheck = "draft-replace";
    let replacement: JmapDraftReplaceResult;
    try {
      replacement = await params.client.replaceDraft({
        emailId: created.emailId,
        previewToken: firstPreview.previewToken,
        identityId,
        ...replacementFixture,
      });
    } catch (error) {
      const replacementId =
        /Replacement draft (\S+) was created/.exec(
          error instanceof Error ? error.message : "",
        )?.[1];
      if (replacementId) {
        activeDraftIds.add(replacementId);
      }
      throw error;
    }
    activeDraftIds.delete(created.emailId);
    activeDraftIds.add(replacement.emailId);
    pass(currentCheck);

    currentCheck = "replacement-preview";
    const replacementPreview = await params.client.previewDraft({
      emailId: replacement.emailId,
      identityId,
    });
    assertExactPreview(replacementPreview, replacementFixture);
    if (replacementPreview.previewToken === firstPreview.previewToken) {
      throw Object.assign(new Error("Replacement retained the old preview token"), {
        type: "previewTokenReused",
      });
    }
    pass(currentCheck);

    currentCheck = "stale-preview-rejection";
    try {
      await params.client.discardDraft({
        emailId: replacement.emailId,
        previewToken: firstPreview.previewToken,
        identityId,
      });
      throw Object.assign(new Error("A stale preview token was accepted"), {
        type: "stalePreviewAccepted",
      });
    } catch (error) {
      if (errorType(error) !== "stalePreview") {
        throw error;
      }
    }
    pass(currentCheck);

    currentCheck = "draft-discard";
    await params.client.discardDraft({
      emailId: replacement.emailId,
      previewToken: replacementPreview.previewToken,
      identityId,
    });
    activeDraftIds.delete(replacement.emailId);
    pass(currentCheck);

    currentCheck = "discard-confirmation";
    try {
      await params.client.previewDraft({
        emailId: replacement.emailId,
        identityId,
      });
      throw Object.assign(new Error("Discarded draft remained readable"), {
        type: "discardNotConfirmed",
      });
    } catch (error) {
      if (errorType(error) !== "notFound") {
        throw error;
      }
    }
    pass(currentCheck);
  } catch (error) {
    fail(currentCheck, error);
  } finally {
    if (activeDraftIds.size > 0) {
      try {
        cleanupConfirmed = await params.forceCleanup([...activeDraftIds]);
      } catch {
        cleanupConfirmed = false;
      }
    }
  }

  const complete =
    cleanupConfirmed && checks.every((check) => check.status === "pass");
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    serverProfile: params.serverProfile,
    contract: STATEFUL_DRAFT_CONTRACT,
    verdict: complete ? "compatible" : "incompatible",
    checks,
    probePolicy: {
      sideEffectsPerformed: true,
      permittedSideEffects: ["draft-create", "draft-replace", "draft-destroy"],
      recipientsUsed: false,
      submissionAttempted: false,
      externalDeliveryAttempted: false,
      onlyTestDraftBodiesRead: true,
      cleanupConfirmed,
    },
  };
}
