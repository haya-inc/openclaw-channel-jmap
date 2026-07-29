export const RFC8621_PLUGIN_RELEASE = "0.4.0";
export const RFC8621_COVERAGE = [
    { method: "Mailbox/get", status: "implemented", exposure: "tool", risk: "read", targetRelease: "0.4.0" },
    { method: "Mailbox/changes", status: "planned", exposure: "none", risk: "read", targetRelease: "0.6.0" },
    { method: "Mailbox/query", status: "planned", exposure: "none", risk: "read", targetRelease: "0.6.0" },
    { method: "Mailbox/queryChanges", status: "planned", exposure: "none", risk: "read", targetRelease: "0.6.0" },
    { method: "Mailbox/set", status: "planned", exposure: "none", risk: "destructive", targetRelease: "0.8.0" },
    { method: "Thread/get", status: "implemented", exposure: "tool", risk: "read", targetRelease: "0.1.0" },
    { method: "Thread/changes", status: "planned", exposure: "none", risk: "read", targetRelease: "0.6.0" },
    { method: "Email/get", status: "implemented", exposure: "tool", risk: "read", targetRelease: "0.1.0" },
    { method: "Email/changes", status: "planned", exposure: "none", risk: "read", targetRelease: "0.6.0" },
    { method: "Email/query", status: "implemented", exposure: "tool", risk: "read", targetRelease: "0.1.0" },
    { method: "Email/queryChanges", status: "partial", exposure: "internal", risk: "read", targetRelease: "0.6.0" },
    { method: "Email/set", status: "partial", exposure: "tool", risk: "reversible", targetRelease: "0.5.0" },
    { method: "Email/copy", status: "planned", exposure: "none", risk: "reversible", targetRelease: "0.7.0" },
    { method: "Email/import", status: "planned", exposure: "none", risk: "reversible", targetRelease: "0.7.0" },
    { method: "Email/parse", status: "planned", exposure: "none", risk: "read", targetRelease: "0.7.0" },
    { method: "SearchSnippet/get", status: "planned", exposure: "none", risk: "read", targetRelease: "0.5.0" },
    { method: "Identity/get", status: "implemented", exposure: "internal", risk: "read", targetRelease: "0.1.0" },
    { method: "Identity/changes", status: "planned", exposure: "none", risk: "read", targetRelease: "0.6.0" },
    { method: "Identity/set", status: "planned", exposure: "none", risk: "destructive", targetRelease: "0.8.0" },
    { method: "EmailSubmission/get", status: "planned", exposure: "none", risk: "read", targetRelease: "0.5.0" },
    { method: "EmailSubmission/changes", status: "planned", exposure: "none", risk: "read", targetRelease: "0.6.0" },
    { method: "EmailSubmission/query", status: "planned", exposure: "none", risk: "read", targetRelease: "0.5.0" },
    { method: "EmailSubmission/queryChanges", status: "planned", exposure: "none", risk: "read", targetRelease: "0.6.0" },
    { method: "EmailSubmission/set", status: "partial", exposure: "tool", risk: "outbound", targetRelease: "0.5.0" },
    { method: "VacationResponse/get", status: "planned", exposure: "none", risk: "read", targetRelease: "0.8.0" },
    { method: "VacationResponse/set", status: "planned", exposure: "none", risk: "outbound", targetRelease: "0.8.0" },
];
const SUBMISSION_METHOD_PREFIXES = ["Identity/", "EmailSubmission/", "VacationResponse/"];
export function rfc8621CapabilityForMethod(method) {
    return SUBMISSION_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix))
        ? "submission"
        : "mail";
}
//# sourceMappingURL=rfc8621-coverage.js.map