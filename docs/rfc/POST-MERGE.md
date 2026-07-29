# Post-merge follow-ups — the god-file split stack

Items that **cannot** be done before the owner merges the RFC 001/002 stack, because they describe
or reference files that only exist after it lands. Each is small; none is a correctness risk.
Delete a row when it's done, and delete this file when the table is empty.

Merge order for the stack (recorded on each PR):
`#489` → `#501` → `#502` → `#506` (RFC 001) and `#489` → `#507` → `#508` → A-PR6 (RFC 002).
Independent: `#497` → `#500` (mind open `#488`, which edits the same `Arrange.tsx` block), and
`#505` (merge with or after `#489`, so its "four registrations" claim is true on main).

| # | item | why it must wait | source |
|---|---|---|---|
| 1 | `ARCHITECTURE.md` §module-map: describe `src/moshops/` as a core + per-domain TUs, and `src/app/selftest/` as support + chapters | the current row correctly says the split is *queued*, not landed | RFC 001/002 |
| 2 | `src/moshops/DrumPattern.h:5` — the comment points `kDefaultKit` at `MoshOps.cpp`; it lives in `MoshOps.Plugins.cpp` after #506 | the target file does not exist on main yet | #506 hostile review |
| 3 | `src/moshops/MoshOpsInternal.h` — the promotion comment bundles `isSerumPlugin` under the "used by two moved TUs" rule; it is actually promoted as an unavoidable transitive dependency of the inline `findSerumRealtimeRenderReason` | same | #506 hostile review |
| 4 | Dead-include audit of the post-split `MoshOps.cpp` — several includes (e.g. `AutomationMode.h`, `RenderLayer.h`, `Lyrics.h`, `TrackCommit.h`, `LogicalId.h`, `moshfx/MoshFxPlugins.h`) may have left with their users. Deliberately **not** done in the motion PRs: pruning an include is a semantic edit, not motion, and would have muddied the byte-proofs | needs the merged tree + its own build proof | #506 hostile review |
| 5 | Flip RFC 001/002/003 status `accepted` → `implemented` and add the merge SHAs | status is a claim about main | RFC process (`README.md`) |
| 6 | `uiReachability.test.ts` — the "boundary declarations are load-bearing" self-check executes zero assertions while `CLASSIC_ONLY_MODULES` is empty. The per-entry mechanism is RED-proven (#497) and #500 adds the Arrange negative assertion, but consider whether the empty-map state deserves its own explicit note | depends on #497/#500 landing | #497 hostile review |

Not on this list, deliberately: the MIDI/beat lane and undo/redo/batch staying in the MoshOps core.
RFC 001 assigned them no TU, both motion PRs recorded the deviation, and inventing a home for them
after the fact would be a fresh design decision — it wants its own RFC, not a follow-up row.
