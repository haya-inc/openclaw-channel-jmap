# Versioning and release philosophy

The version is a promise to users, not a progress counter.

`openclaw-channel-jmap` uses semantic versioning while it is below 1.0 with the
following practical rules:

- A patch release fixes or hardens an existing public contract without adding
  a new capability theme.
- A minor release delivers one coherent capability theme whose required
  safety, documentation, migration, and cross-server checks are complete.
- A major release may break a documented public contract and must include a
  migration path.
- Alpha, beta, and release-candidate versions exist to gather evidence for a
  minor release. A prerelease is not a substitute for satisfying its gate.

The `main` branch may contain compatible work for the next milestone under the
`Unreleased` changelog section. During ordinary development, `package.json`
continues to report the latest stable version. It changes only when an
intentional prerelease or stable-release candidate is cut. Production users
should pin a stable tag or exact commit rather than follow `main`.

## 0.5.0: deliberate composition

0.5.0 is not “the next collection of features.” It is the point at which an
agent can prepare, inspect, revise, and deliberately submit mail with truthful
status and a clear boundary between reversible preparation and external
delivery.

The stable release requires all items marked `required` in
[`release-gates.json`](../release-gates.json). In particular:

- identity discovery and per-draft identity selection, including RFC wildcard
  identities and signature behavior;
- safe draft creation, reading, revision, and discard behavior;
- a bounded preview of exactly what will be submitted;
- a distinct, explicit submission action;
- one-time native operator approval in the default reviewed mode, with
  immediate and automatic delivery restricted to explicit autonomous mode;
- submission lookup and status reporting;
- scheduling and undo only when the server advertises and correctly implements
  them, with an explicit unsupported result otherwise;
- content-free, recipient-free draft, and isolated outbound contract evidence
  for Stalwart, Fastmail, Cyrus, Apache James, and a generic
  standards-compliant profile;
- completed public documentation and a security review of outbound boundaries.

The composition implementation may exist on `main` while the package remains
0.4.1. Passing mocked contract tests or one provider's live draft contract
makes progress toward the public contract; it does not redefine the stable
contract by itself. All three cross-server evidence layers and the remaining
release review are still required before 0.5.0.

## Promotion

1. Development stays under `Unreleased` at the current stable package version.
2. An alpha may be cut after the end-to-end composition path is usable.
3. A beta requires the safety contract and supported-server behavior to be
   settled.
4. A release candidate requires all mandatory gates to pass and no known
   migration blocker.
5. The stable minor is released only after the candidate has cross-server
   evidence and no unresolved release-blocking defect.

The test suite validates the relationship between `package.json`, the
changelog, and `release-gates.json`, so an accidental early version bump fails
CI.
