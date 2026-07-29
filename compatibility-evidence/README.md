# Reviewed compatibility evidence

This directory is the durable history for reviewed, content-free compatibility
results.

Evidence is organized as:

```text
compatibility-evidence/<server-profile>/<server-version>/<date>-<revision>.json
```

Each file must validate against
[`compatibility-evidence.schema.json`](../compatibility-evidence.schema.json).
It embeds the redacted report, its SHA-256, the exact server artifact, the probe
package version and source revision, and the `fixture`, `lab`, or `live`
verification level.

Workflow artifacts are not copied here automatically. Promotion is an explicit
review step so a transient or incorrectly labelled run cannot silently rewrite
the public compatibility record.

Run `npm run compatibility:evidence` to evaluate the reviewed history against
[`compatibility-requirements.json`](../compatibility-requirements.json). The
command exits non-zero while any required profile is missing. CI uses
`npm run compatibility:evidence:check` to validate every retained document
without pretending that an intentionally incomplete matrix is complete.

The requirement file covers only the content-free safe probe. A `full` result
means that the safe full-scope checks passed and that all 26 RFC 8621 methods
were classified. It does not turn `advertised` methods into `verified` methods
and does not prove drafts, submission, cancellation, import, or copy.
