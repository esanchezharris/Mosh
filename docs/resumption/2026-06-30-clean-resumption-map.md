# Clean Resumption Map - 2026-06-30

This map is the restart point after the Claude usage cutoff. It records the
source-of-truth decision, preserves current work lanes, and blocks unsafe loop
or training resumption until the listed gates are satisfied.

## Source Of Truth

- Trunk truth is `origin/main` at `27beed5e` (`fix(engine): set_track_volume/pan (+master) undo restores prior value - G14 (#145)`).
- Use `/Users/emiliosanchez-harris/Documents/ClaudeMosh-moshfx` as the clean
  current-main baseline; it is on `main` and even with `origin/main`.
- Treat `/Users/emiliosanchez-harris/Documents/ClaudeMosh` as a stale active
  seat. It is on `codex/phone-controller-latency-gate`, whose upstream is gone;
  PR #133 already landed that commit on `main`.
- Do not delete or overwrite dirty work in the stale active seat.

## Preservation Lanes

| Lane | Source files/artifacts | Action |
| --- | --- | --- |
| Arrange drum routing | `ui/src/ui/Arrange.tsx`, `ui/src/ui/Arrange.test.ts` in `/Users/emiliosanchez-harris/Documents/ClaudeMosh` | Preserve as a small implementation branch from `origin/main`. Scope: double-click drum-track MIDI clips into Drum Sequencer, melodic MIDI into Piano Roll, with focused Vitest coverage. |
| Finish My Song / reward specs | `FINISH_MY_SONG_LYRICS_BUILD_SPEC.md`, `FINISH_MY_SONG_LYRICS_SPEC.md`, `FINISH_MY_SONG_ROADMAP.md`, `mosh-teardown-reward-pipeline-FINAL.md` | Preserve as docs/spec work. First compare against current `docs/` copies because Finish My Song Phase 1/2 docs already landed on `main`. |
| DAW reality evidence | `mosh_daw_reality_pack/`, `mosh_daw_reality_pack.zip` | Preserve as generated evidence. Do not mix into implementation PRs; decide whether to archive externally or commit only selected text/csv assets. |
| Auto-loop ledger hunk | `docs/auto-loop/LEDGER.md` in stale active seat | Preserve as automation evidence. Do not treat it as operational truth until backlog is reconciled against GitHub. |
| Installed app | `/Applications/Mosh.app` | Preserve first. See `docs/resumption/2026-06-30-installed-app-manifest.md`. |

## Open PR Queue

Normal merge/review queue:

1. PR #184 `claude/quirky-dewdney-712154`: narrow non-44.1 kHz re-imagine fix. Merge or skip separately if PR #185 lands because #185 contains the fix.
2. PR #185 `claude/reimagine-inplace-wholeclip`: full re-imagine overhaul. Clean against current `main`; owner-gated by real-SA3 drum/MIDI by-ear proof.
3. PR #183 `claude/intelligent-moser-b6b468`: v2 shell polish. Clean against current `main`; rerun UI gates if landed after #185.
4. PR #181 `claude/great-allen-5a18a9`: prompt compiler and oracle/eval harness. Resolve conflicts with #185 in `scripts/verify-hardware/verify.py` and `ui/src/agent/commands.ts` if both are wanted.

Excluded from normal queue:

- PR #176 `claude/funny-mendel-aeca12`: trainer/policy branch with unpublished local commits and heavy overlap with reward work. Review as source material only until the relationship to #186 is decided.
- PR #186 `claude/production-reward`: restart handoff branch. Do not blanket-merge; extract a clean Phase 0 real-recipes slice onto a fresh branch from `origin/main`.

## Training And Reward Restart

- Current trunk has training scaffolding and fake/remote trainer plumbing, not production training.
- Resume from `claude/production-reward` as source material, but keep RL/reward frozen.
- First clean branch should port only Phase 0 real-recipes substrate: recipe library, retrieval/recombination, compile/render/audition checks, and validity-only verifier behavior.
- Do not resume GRPO or trainer work from `funny-mendel` until the recipe substrate passes fidelity and owner-ear gates.
- The parked `.claude/worktrees/laughing-grothendieck-22549c` worktree is not present locally.

## Auto-Loop Re-Arm Blocker

Do not re-arm the autonomous loop as-is.

Current blocker: backlog state drift. The loop can still pick merged or already
open G-series work because `scripts/auto-loop/discover.sh` suppresses merged
`auto(AL-###)` PRs but not merged/open `auto(G*)` PRs.

Required preflight before any re-arm:

1. Launch only from clean current `main`.
2. Reconcile `docs/auto-loop/backlog.jsonl` with GitHub: mark AL-000..AL-009 and G14 done; mark open G PRs #142-#150 as `in_progress`, `needs-human`, or otherwise non-pickable.
3. Patch `discover.sh` or backlog data so merged/open G items cannot be re-picked.
4. Run `scripts/auto-loop/deps-freshness-selftest.sh`.
5. Run `scripts/auto-loop/gate.sh cheap . origin/main`.
6. Establish a fresh Release native selftest baseline on current `main`.
7. First re-arm only as dry run: `dryRun:true`, `allowNative:false`, `refill:false`, `maxCycles:1`, `maxItems:1`.

## Verification Ladder

Use preset build directories, not legacy `build/` paths.

Docs-only:

```sh
# review links, paths, and stale command references manually
```

UI-only:

```sh
cd ui
npm test
npm run typecheck
npm run test:e2e
npm run build

cd ..
cmake --preset macos-arm64-debug
cmake --build --preset macos-arm64-app
MOSH_NO_AUDIO=1 build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --selftest
```

Native:

```sh
cmake --preset macos-arm64-debug
cmake --build --preset macos-arm64-app
cmake --build --preset macos-arm64-tests
ctest --test-dir build-macos-arm64 --output-on-failure

APP=build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh
MOSH_NO_AUDIO=1 "$APP" --selftest-undo
MOSH_NO_AUDIO=1 "$APP" --selftest
# repeat --selftest 3x for determinism before merge
```

Installed app:

```sh
./run-mosh.sh deploy
/Applications/Mosh.app/Contents/MacOS/Mosh --selftest
```

Only run the installed-app gate after preserving the current installed bundle and
choosing the intended source branch.

Training/reward:

```sh
cd ui
npm run harvest -- --report <mosh-log.jsonl>
npm run verify -- <commands.json> --target <snapshot.json>
npm test
npm run typecheck
```

For recipe restart work, also run the Phase 0 recipe tests and render/audition
checks documented in `claude/production-reward:docs/RESTART_HANDOFF.md` after
the clean slice is ported.

## Next Execution Order

1. Preserve installed-app manifest and current dirty lanes.
2. Move work from the stale active seat into clean branches from `origin/main`.
3. Review/merge PRs #184, #185, #183, #181 in the stated order.
4. Extract clean real-recipes Phase 0 branch from #186 source material.
5. Decide whether any #176 trainer pieces are still useful.
6. Reconcile and dry-run the auto-loop only after the G-series backlog blocker is fixed.
