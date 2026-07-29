import type {
  JmapDraftCreateResult,
  JmapDraftPreview,
  JmapIdentity,
  JmapSubmission,
  JmapSubmissionResult,
} from "./types.js";

export const OUTBOUND_CONTRACT = "self-addressed-submission-v1";

export const OUTBOUND_CONTRACT_CHECK_IDS = [
  "session",
  "identity-safety",
  "self-draft-create",
  "exact-preview",
  "explicit-submit",
  "submission-get",
  "submission-query",
  "delayed-send-policy",
  "cancellation-boundary",
] as const;

type CheckId = (typeof OUTBOUND_CONTRACT_CHECK_IDS)[number];
type CheckStatus = "pass" | "fail" | "not-run";

export type OutboundContractClient = {
  init(): Promise<{ maxDelayedSend: number }>;
  listIdentities(): Promise<JmapIdentity[]>;
  createDraft(params: {
    identityId: string;
    to: string[];
    subject: string;
    text: string;
  }): Promise<JmapDraftCreateResult>;
  previewDraft(params: {
    emailId: string;
    identityId: string;
  }): Promise<JmapDraftPreview>;
  submitDraft(params: {
    emailId: string;
    previewToken: string;
    identityId: string;
    sendAt?: string;
  }): Promise<JmapSubmissionResult>;
  getSubmissions(ids: string[]): Promise<JmapSubmission[]>;
  querySubmissions(params: {
    emailId: string;
    limit: number;
  }): Promise<{ submissions: JmapSubmission[] }>;
  cancelSubmission(submissionId: string): Promise<JmapSubmission>;
  discardDraft(params: {
    emailId: string;
    previewToken: string;
    identityId: string;
  }): Promise<{ discarded: true }>;
};

export type OutboundContractReport = {
  schemaVersion: 1;
  generatedAt: string;
  serverProfile: string;
  contract: typeof OUTBOUND_CONTRACT;
  verdict: "compatible" | "incompatible";
  checks: Array<{
    id: CheckId;
    status: CheckStatus;
    errorType?: string;
  }>;
  observations: {
    acceptanceObserved: boolean;
    submissionStatusObserved: boolean;
    deliveryStatusObserved: boolean;
    submissionGet: "observed" | "unsupported" | "unavailable";
    submissionQuery: "observed" | "unsupported" | "unavailable";
    immediateUndoStatus: "pending" | "final" | "canceled" | "other" | "unknown";
    scheduling: "canceled" | "uncancelable" | "unsupported" | "not-run";
  };
  probePolicy: {
    sideEffectsPerformed: true;
    selfAddressedOnly: true;
    externalRecipientsUsed: false;
    submissionAttempted: boolean;
    finalDeliveryClaimed: false;
    cleanupConfirmed: boolean;
  };
};

type ForceDraftCleanup = (emailIds: string[]) => Promise<boolean>;

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

function normalizedEmail(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function isConcreteEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s]+$/.test(value) && !value.startsWith("*@");
}

function assertExactSelfPreview(
  preview: JmapDraftPreview,
  expected: { identityId: string; email: string; subject: string; text: string },
): void {
  const recipients = [...preview.to, ...preview.cc, ...preview.bcc].map((entry) =>
    normalizedEmail(entry.email),
  );
  if (
    preview.identityId !== expected.identityId ||
    normalizedEmail(preview.identityEmail) !== expected.email ||
    preview.from.length !== 1 ||
    normalizedEmail(preview.from[0]?.email) !== expected.email ||
    recipients.length !== 1 ||
    recipients[0] !== expected.email ||
    preview.subject !== expected.subject ||
    preview.text.trim() !== expected.text ||
    !preview.previewToken.trim()
  ) {
    throw Object.assign(new Error("Outbound preview is not exactly self-addressed"), {
      type: "previewMismatch",
    });
  }
}

function undoStatus(value: string | undefined): OutboundContractReport["observations"]["immediateUndoStatus"] {
  if (value === "pending" || value === "final" || value === "canceled") {
    return value;
  }
  return value ? "other" : "unknown";
}

export async function runOutboundContract(params: {
  client: OutboundContractClient;
  serverProfile: string;
  forceDraftCleanup: ForceDraftCleanup;
  now?: () => number;
}): Promise<OutboundContractReport> {
  const checks = OUTBOUND_CONTRACT_CHECK_IDS.map((id) => ({
    id,
    status: "not-run" as CheckStatus,
  }));
  const activeDraftIds = new Set<string>();
  let currentCheck: CheckId = "session";
  let cleanupConfirmed = true;
  let submissionAttempted = false;
  let acceptanceObserved = false;
  let submissionStatusObserved = false;
  let deliveryStatusObserved = false;
  let submissionGet: OutboundContractReport["observations"]["submissionGet"] =
    "unavailable";
  let submissionQuery: OutboundContractReport["observations"]["submissionQuery"] =
    "unavailable";
  let immediateUndoStatus: OutboundContractReport["observations"]["immediateUndoStatus"] =
    "unknown";
  let scheduling: OutboundContractReport["observations"]["scheduling"] = "not-run";
  const now = params.now ?? Date.now;

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
    const session = await params.client.init();
    pass(currentCheck);

    currentCheck = "identity-safety";
    const identities = await params.client.listIdentities();
    const identity = identities.find((candidate) =>
      isConcreteEmail(normalizedEmail(candidate.email)),
    );
    const identityId = identity?.id?.trim() ?? "";
    const selfEmail = normalizedEmail(identity?.email);
    const defaultBcc = identity?.bcc ?? [];
    if (
      !identityId ||
      !selfEmail ||
      defaultBcc.some((entry) => normalizedEmail(entry.email) !== selfEmail)
    ) {
      throw Object.assign(
        new Error("No concrete identity without an external default Bcc is available"),
        { type: "unsafeIdentity" },
      );
    }
    pass(currentCheck);

    const immediateFixture = {
      subject: "OpenClaw JMAP self-addressed outbound contract",
      text: "explicit self-addressed submission",
    };
    currentCheck = "self-draft-create";
    const immediateDraft = await params.client.createDraft({
      identityId,
      to: [selfEmail],
      ...immediateFixture,
    });
    activeDraftIds.add(immediateDraft.emailId);
    pass(currentCheck);

    currentCheck = "exact-preview";
    const immediatePreview = await params.client.previewDraft({
      emailId: immediateDraft.emailId,
      identityId,
    });
    assertExactSelfPreview(immediatePreview, {
      identityId,
      email: selfEmail,
      ...immediateFixture,
    });
    pass(currentCheck);

    currentCheck = "explicit-submit";
    submissionAttempted = true;
    // Once EmailSubmission/set starts, network failure is ambiguous. Never
    // destroy the Email as though the outbound boundary had not been crossed.
    activeDraftIds.delete(immediateDraft.emailId);
    let submitted: JmapSubmissionResult;
    try {
      submitted = await params.client.submitDraft({
        emailId: immediateDraft.emailId,
        previewToken: immediatePreview.previewToken,
        identityId,
      });
    } catch (error) {
      cleanupConfirmed = false;
      throw error;
    }
    acceptanceObserved = true;
    pass(currentCheck);

    currentCheck = "submission-get";
    let immediateSubmission: JmapSubmission | undefined;
    try {
      immediateSubmission = (
        await params.client.getSubmissions([submitted.submissionId])
      )[0];
      if (immediateSubmission) {
        if (
          immediateSubmission.id !== submitted.submissionId ||
          immediateSubmission.emailId !== immediateDraft.emailId
        ) {
          throw Object.assign(new Error("Submission status identified another object"), {
            type: "statusMismatch",
          });
        }
        submissionGet = "observed";
        submissionStatusObserved = true;
        deliveryStatusObserved =
          immediateSubmission.deliveryStatus !== undefined &&
          immediateSubmission.deliveryStatus !== null;
        immediateUndoStatus = undoStatus(immediateSubmission.undoStatus);
      }
    } catch (error) {
      if (errorType(error) !== "unknownMethod") {
        throw error;
      }
      submissionGet = "unsupported";
    }
    if (!immediateSubmission) {
      immediateUndoStatus = undoStatus(submitted.undoStatus);
    }
    pass(currentCheck);

    currentCheck = "submission-query";
    try {
      const history = await params.client.querySubmissions({
        emailId: immediateDraft.emailId,
        limit: 20,
      });
      submissionQuery = history.submissions.some(
        (entry) => entry.id === submitted.submissionId,
      )
        ? "observed"
        : "unavailable";
    } catch (error) {
      if (errorType(error) !== "unknownMethod") {
        throw error;
      }
      submissionQuery = "unsupported";
    }
    pass(currentCheck);

    currentCheck = "delayed-send-policy";
    if (session.maxDelayedSend > 0) {
      if (session.maxDelayedSend < 30) {
        throw Object.assign(
          new Error("Advertised delayed-send window is too short for a safe cancellation test"),
          { type: "unsafeScheduleWindow" },
        );
      }
      const scheduledFixture = {
        subject: "OpenClaw JMAP scheduled cancellation contract",
        text: "this self-addressed submission must be canceled while pending",
      };
      const scheduledDraft = await params.client.createDraft({
        identityId,
        to: [selfEmail],
        ...scheduledFixture,
      });
      activeDraftIds.add(scheduledDraft.emailId);
      const scheduledPreview = await params.client.previewDraft({
        emailId: scheduledDraft.emailId,
        identityId,
      });
      assertExactSelfPreview(scheduledPreview, {
        identityId,
        email: selfEmail,
        ...scheduledFixture,
      });
      const delaySeconds = Math.min(300, session.maxDelayedSend - 5);
      activeDraftIds.delete(scheduledDraft.emailId);
      submissionAttempted = true;
      let scheduledSubmission: JmapSubmissionResult;
      try {
        scheduledSubmission = await params.client.submitDraft({
          emailId: scheduledDraft.emailId,
          previewToken: scheduledPreview.previewToken,
          identityId,
          sendAt: new Date(now() + delaySeconds * 1_000).toISOString(),
        });
      } catch (error) {
        cleanupConfirmed = false;
        throw error;
      }
      if (!scheduledSubmission.scheduled) {
        throw Object.assign(new Error("Delayed submission was not reported as scheduled"), {
          type: "scheduleNotConfirmed",
        });
      }
      pass(currentCheck);

      currentCheck = "cancellation-boundary";
      const pending = (
        await params.client.getSubmissions([scheduledSubmission.submissionId])
      )[0];
      if (pending?.undoStatus !== "pending") {
        throw Object.assign(new Error("Scheduled submission was not pending"), {
          type: "notPending",
        });
      }
      try {
        const canceled = await params.client.cancelSubmission(
          scheduledSubmission.submissionId,
        );
        if (canceled.undoStatus !== "canceled") {
          throw Object.assign(new Error("Cancellation was not confirmed"), {
            type: "cancelNotConfirmed",
          });
        }
        scheduling = "canceled";
      } catch (error) {
        if (errorType(error) !== "cannotUnsend") {
          throw error;
        }
        scheduling = "uncancelable";
      }
      pass(currentCheck);
    } else {
      const unsupportedFixture = {
        subject: "OpenClaw JMAP unsupported scheduling contract",
        text: "this self-addressed draft must never cross the outbound boundary",
      };
      const unsupportedDraft = await params.client.createDraft({
        identityId,
        to: [selfEmail],
        ...unsupportedFixture,
      });
      activeDraftIds.add(unsupportedDraft.emailId);
      const unsupportedPreview = await params.client.previewDraft({
        emailId: unsupportedDraft.emailId,
        identityId,
      });
      try {
        await params.client.submitDraft({
          emailId: unsupportedDraft.emailId,
          previewToken: unsupportedPreview.previewToken,
          identityId,
          sendAt: new Date(now() + 60_000).toISOString(),
        });
        activeDraftIds.delete(unsupportedDraft.emailId);
        throw Object.assign(new Error("Unadvertised delayed send was accepted"), {
          type: "unsafeScheduleAccepted",
        });
      } catch (error) {
        if (errorType(error) !== "unsupported") {
          throw error;
        }
      }
      await params.client.discardDraft({
        emailId: unsupportedDraft.emailId,
        previewToken: unsupportedPreview.previewToken,
        identityId,
      });
      activeDraftIds.delete(unsupportedDraft.emailId);
      scheduling = "unsupported";
      pass(currentCheck);

      currentCheck = "cancellation-boundary";
      if (immediateSubmission?.undoStatus === "pending") {
        const canceled = await params.client.cancelSubmission(submitted.submissionId);
        if (canceled.undoStatus !== "canceled") {
          throw Object.assign(new Error("Pending cancellation was not confirmed"), {
            type: "cancelNotConfirmed",
          });
        }
      } else if (immediateSubmission) {
        try {
          await params.client.cancelSubmission(submitted.submissionId);
          throw Object.assign(new Error("Non-pending submission was canceled"), {
            type: "nonPendingCancelAccepted",
          });
        } catch (error) {
          if (errorType(error) !== "cannotUnsend") {
            throw error;
          }
        }
      } else {
        try {
          await params.client.cancelSubmission(submitted.submissionId);
          throw Object.assign(
            new Error("Cancellation was attempted without observable pending state"),
            { type: "unobservedCancelAccepted" },
          );
        } catch (error) {
          if (!["unknownMethod", "notFound"].includes(errorType(error))) {
            throw error;
          }
        }
      }
      pass(currentCheck);
    }
  } catch (error) {
    fail(currentCheck, error);
  } finally {
    if (activeDraftIds.size > 0) {
      try {
        cleanupConfirmed = await params.forceDraftCleanup([...activeDraftIds]);
      } catch {
        cleanupConfirmed = false;
      }
    }
  }

  const complete =
    cleanupConfirmed && checks.every((check) => check.status === "pass");
  return {
    schemaVersion: 1,
    generatedAt: new Date(now()).toISOString(),
    serverProfile: params.serverProfile,
    contract: OUTBOUND_CONTRACT,
    verdict: complete ? "compatible" : "incompatible",
    checks,
    observations: {
      acceptanceObserved,
      submissionStatusObserved,
      deliveryStatusObserved,
      submissionGet,
      submissionQuery,
      immediateUndoStatus,
      scheduling,
    },
    probePolicy: {
      sideEffectsPerformed: true,
      selfAddressedOnly: true,
      externalRecipientsUsed: false,
      submissionAttempted,
      finalDeliveryClaimed: false,
      cleanupConfirmed,
    },
  };
}
