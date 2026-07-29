export type Rfc8621PluginStatus = "implemented" | "partial" | "planned";
export type Rfc8621Exposure = "tool" | "internal" | "none";
export type Rfc8621Risk = "read" | "reversible" | "outbound" | "destructive";
export type Rfc8621ServerStatus =
  | "verified"
  | "advertised"
  | "unsupported"
  | "unverified";

export type Rfc8621CoverageEntry = {
  method: string;
  status: Rfc8621PluginStatus;
  exposure: Rfc8621Exposure;
  risk: Rfc8621Risk;
  targetRelease: string;
};

export const RFC8621_PLUGIN_RELEASE = "0.4.1";
export const RFC8621_DEVELOPMENT_TARGET = "0.5.0";

export const RFC8621_COVERAGE: readonly Rfc8621CoverageEntry[] = [
  { method: "Mailbox/get", status: "implemented", exposure: "tool", risk: "read", targetRelease: "0.4.0" },
  { method: "Mailbox/changes", status: "implemented", exposure: "tool", risk: "read", targetRelease: "0.6.0" },
  { method: "Mailbox/query", status: "planned", exposure: "none", risk: "read", targetRelease: "0.6.0" },
  { method: "Mailbox/queryChanges", status: "planned", exposure: "none", risk: "read", targetRelease: "0.6.0" },
  { method: "Mailbox/set", status: "planned", exposure: "none", risk: "destructive", targetRelease: "0.8.0" },
  { method: "Thread/get", status: "implemented", exposure: "tool", risk: "read", targetRelease: "0.1.0" },
  { method: "Thread/changes", status: "implemented", exposure: "tool", risk: "read", targetRelease: "0.6.0" },
  { method: "Email/get", status: "implemented", exposure: "tool", risk: "read", targetRelease: "0.1.0" },
  { method: "Email/changes", status: "implemented", exposure: "tool", risk: "read", targetRelease: "0.6.0" },
  { method: "Email/query", status: "implemented", exposure: "tool", risk: "read", targetRelease: "0.1.0" },
  { method: "Email/queryChanges", status: "partial", exposure: "internal", risk: "read", targetRelease: "0.6.0" },
  { method: "Email/set", status: "partial", exposure: "tool", risk: "reversible", targetRelease: "0.5.0" },
  { method: "Email/copy", status: "implemented", exposure: "tool", risk: "reversible", targetRelease: "0.7.0" },
  { method: "Email/import", status: "implemented", exposure: "tool", risk: "reversible", targetRelease: "0.7.0" },
  { method: "Email/parse", status: "implemented", exposure: "tool", risk: "read", targetRelease: "0.7.0" },
  { method: "SearchSnippet/get", status: "implemented", exposure: "tool", risk: "read", targetRelease: "0.5.0" },
  { method: "Identity/get", status: "implemented", exposure: "tool", risk: "read", targetRelease: "0.1.0" },
  { method: "Identity/changes", status: "implemented", exposure: "tool", risk: "read", targetRelease: "0.6.0" },
  { method: "Identity/set", status: "planned", exposure: "none", risk: "destructive", targetRelease: "0.8.0" },
  { method: "EmailSubmission/get", status: "implemented", exposure: "tool", risk: "read", targetRelease: "0.5.0" },
  { method: "EmailSubmission/changes", status: "implemented", exposure: "tool", risk: "read", targetRelease: "0.6.0" },
  { method: "EmailSubmission/query", status: "implemented", exposure: "tool", risk: "read", targetRelease: "0.5.0" },
  { method: "EmailSubmission/queryChanges", status: "planned", exposure: "none", risk: "read", targetRelease: "0.6.0" },
  { method: "EmailSubmission/set", status: "partial", exposure: "tool", risk: "outbound", targetRelease: "0.5.0" },
  { method: "VacationResponse/get", status: "planned", exposure: "none", risk: "read", targetRelease: "0.8.0" },
  { method: "VacationResponse/set", status: "planned", exposure: "none", risk: "outbound", targetRelease: "0.8.0" },
] as const;

const SUBMISSION_METHOD_PREFIXES = ["Identity/", "EmailSubmission/", "VacationResponse/"];

export function rfc8621CapabilityForMethod(method: string): "mail" | "submission" {
  return SUBMISSION_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix))
    ? "submission"
    : "mail";
}
