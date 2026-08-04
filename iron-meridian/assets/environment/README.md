# Environment assets — Iron Meridian arena (IMF-02)

Every environment asset in the arena is **procedurally generated at load time**
and owned by the project; there are no third-party binary files to attribute.
`manifest.json` is the machine-readable ledger required by the product spec: it
lists the `source`, `license`, and `use` of every material, texture, and sky
asset the arena consumes, plus a `generator` pointer to the code that produces
it.

The manifest is validated in `tests/unit/world/manifest.test.ts` against the
authoritative asset-id set in `src/world/manifest.ts`, so any asset added to the
scene without a ledger entry (or any orphaned ledger entry) fails the build.

`license` values use SPDX identifiers. `CC0-1.0` marks the generated assets as
public-domain-equivalent and unencumbered.
