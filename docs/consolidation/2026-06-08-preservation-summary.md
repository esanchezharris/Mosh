# MOSH Consolidation Preservation Summary

Date: 2026-06-08

This pass treats `/Users/emiliosanchez-harris/Documents/ClaudeMosh` as the master MOSH repo and preserves selected legacy artifacts before any archive/delete work. No old project folder was deleted or archived.

## Preserved Artifact Root

Artifacts were copied to:

`/Users/emiliosanchez-harris/Documents/ClaudeMosh/_preserved_artifacts/2026-06-08-consolidation/`

That folder is intentionally gitignored. The tracked manifest is:

`docs/consolidation/2026-06-08-preservation-manifest.tsv`

## Counts

- Total preserved files: 337
- Total preserved bytes: 150,735,272
- Preserved on disk: about 145 MB
- Mosh legacy artifacts: 254 files, about 134 MB
- JamPilot artifacts: 72 files, about 4.1 MB
- ClaudeMosh grit demo artifacts: 10 files, about 6.2 MB
- `/tmp` evidence scan: no matching `/tmp/jampilot-*` or `/tmp/mosh-*` directories were present during this run.

## Preserved Sets

- Compact SA3 steering share bundle from `/Users/emiliosanchez-harris/Documents/Mosh/share/sa3-colors-steering-data-20260608`.
- Durable saved loops, `meowloop.wav`, and Color Rack render candidates from `/Users/emiliosanchez-harris/Documents/Mosh/sa3-editability-spike`.
- SA3 planning/proof docs from the editability spike.
- Selected MonsterDAWW proof media from `final-ui`, `solo`, and `redesign` screenshot/video folders.
- Selected MonsterDAWW Color Rack UI source references for comparison only.
- JamPilot truth docs, logs, MOSH screenshots, and docs.
- `mosh_v1_final_build_pack`, excluding its generated `build/` folder.
- ClaudeMosh `assets/grit_demo/` copied into the preservation area and ignored in git.

## Verification

Run:

```bash
scripts/verify-preservation-manifest.sh
```

The verifier recomputes size and SHA256 for each preserved file listed in the manifest.

## Boundaries

- Preserved artifacts are not runtime imports.
- Old browser-Mosh/JamPilot code remains reference-only unless a later change explicitly ports a behavior through MoshOps.
- Destructive cleanup remains blocked until the archive/delete candidate report is reviewed.
