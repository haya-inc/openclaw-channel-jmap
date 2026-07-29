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
