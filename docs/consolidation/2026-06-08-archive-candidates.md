# Archive Candidate Report

Date: 2026-06-08

This report is not approval to delete anything. It records the current consolidation boundary after preservation.

## Preserved Before Archive

The following have already been copied into `_preserved_artifacts/2026-06-08-consolidation/` and hashed in the manifest:

- Mosh SA3 steering share bundle.
- Mosh saved loops, `meowloop.wav`, and Color Rack candidate WAVs.
- Mosh SA3 proof docs and selected MonsterDAWW proof media.
- Selected MonsterDAWW Color Rack UI source references.
- JamPilot logs, docs, and MOSH smoke screenshots.
- `mosh_v1_final_build_pack`, excluding generated `build/`.
- ClaudeMosh `assets/grit_demo/`.

## Safe Archive Candidates After Review

These folders are candidates for archive, not immediate deletion:

- `/Users/emiliosanchez-harris/Documents/Jampilot/mosh_v1_final_build_pack`
- `/Users/emiliosanchez-harris/Documents/Jampilot/mosh_v1_final_complete_build_pack.zip`
- `/Users/emiliosanchez-harris/Documents/Mosh/share/sa3-colors-steering-data-20260608`
- `/Users/emiliosanchez-harris/Documents/Mosh/sa3-editability-spike/data/saved_loops`
- `/Users/emiliosanchez-harris/Documents/Mosh/sa3-editability-spike/data/clips/colorrack`

## Archive-Only / Do Not Ingest

- `/Users/emiliosanchez-harris/Documents/Jampilot/build*`, `build-console`, `build-tests`, and most generated app artifacts.
- `/Users/emiliosanchez-harris/Documents/Jampilot/third_party`.
- JamPilot product UI/backend wholesale.
- `MonsterDAWW/dawui-app/src/core/actions`, old browser stores, old Take reducer wiring, and old native sidecar glue.
- `MonsterDAWW/node_modules`, build outputs, caches, and `.git`.
- Broad SA3 scratch/research folders such as activation dumps, SAE/SAO data, generated axis WAV sweeps, and virtualenv/cache folders unless a later reproducibility pass explicitly asks for them.

## Hold / Review Before Archive

- `/Users/emiliosanchez-harris/Documents/Mosh/sa3-editability-spike` as a whole: this still contains research code and data beyond the compact preserved set.
- `/Users/emiliosanchez-harris/Documents/Mosh/MonsterDAWW`: useful as historical product proof, but do not ingest its old architecture into ClaudeMosh.
- `/Users/emiliosanchez-harris/Documents/Jampilot`: useful verification infrastructure remains there; only archive after ClaudeMosh replacement scripts are accepted.

## Blockers To Deletion

- The manifest needs human review.
- `/tmp` evidence directories were absent during this run, so no ephemeral JamPilot proof bundles were copied.
- Live-audio loopback remains opt-in because it changes CoreAudio state.
- Destructive cleanup requires separate explicit approval.
