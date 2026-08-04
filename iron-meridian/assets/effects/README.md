# Effect assets — Iron Meridian presentation layer (IMF-07)

Every presentation asset is **procedurally generated at load time** by
`src/presentation/sprites.ts` and composed into pooled effects by
`src/presentation`; there are no third-party binary files, no copied franchise
content, and no generated raster media (so the fal.ai workflow was not
required). `manifest.json` is the machine-readable ledger required by the
product spec: it lists the `source`, `license`, `use`, `generator`, and
generation `parameters` of every sprite texture and effect composition.

The manifest is validated in `tests/unit/presentation/manifest.test.ts`
against the authoritative asset-id set in `src/presentation/manifest.ts`, so
an effect asset added without a ledger entry (or an orphaned ledger entry)
fails the build. The repository-level `ASSET_LEDGER.md` aggregates this
manifest together with the IMF-02 environment manifest.

`license` values use SPDX identifiers. `CC0-1.0` marks the generated assets as
public-domain-equivalent and unencumbered.
