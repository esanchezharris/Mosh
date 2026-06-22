# Playtest-prep — follow-ups (root-caused; NOT fixed; de-risk-only pass)

Logged on `claude/playtest-prep-0621`, 2026-06-21. The export bug below was investigated
deeply (stack samples + controlled before/after tests). A candidate fix was tried and
**disproven, then reverted** — the C++ is pristine (`git diff src/` is empty). The right
fix is engine-level and not safe to rush before the playtest; the workaround is clean.

## A. Export hangs on a multiplayer-consolidated AUDIO clip  ⚠️ playtest-relevant

**Symptom:** `export_audio` spins forever (CPU-bound, never returns) when the edit contains
a **wave/audio clip that has been through `mp_commit_track`** (which content-addresses the
clip's source to `audio/by-hash/<sha>.wav` with a *relative* reference).

**Precisely scoped (all measured with stack samples + controlled runs):**
| Scenario | export |
|---|---|
| Live-built audio clip, **not** committed, export | ✅ completes |
| Non-MP project: save → `open_project` → export | ✅ completes |
| **Host** commits a track with an **audio** clip, then exports | ❌ **hangs** |
| **Guest** (received the committed audio clip), exports | ❌ **hangs** |
| `open_project` of an MP-saved project (audio clip) → export | ❌ **hangs** |
| Commit a **MIDI/drum** clip (host *or* guest), then export | ✅ completes (1.06 MB WAV) |

So the trigger is **the MP-consolidated wave clip**, not multiplayer per se and not the
track set. MIDI + instrument (sampler/4OSC) content is completely unaffected.

**Root cause (located, not fully traced into Tracktion):** rendering the consolidated clip
makes the render node-graph traversal recurse without terminating —
`MoshOps::cmdExportAudio → tracktion::engine::Renderer::RenderTask::runJob →
tracktion::graph::getNodes → VisitNodesWithRecord::visit (deep recursion) →
ArrangerLauncherSwitchingNode::getDirectInputNodes`. Identical stack for the live-guest and
the open_project cases. The by-hash *relative* source reference (vs. a normal absolute path)
is the differentiator; a non-MP clip with an absolute source renders fine.

**Fix attempt — DISPROVEN + REVERTED:** hypothesis was that including the Arranger track in
`params.tracksToDo` (it uses `getAllTracks`) pulled the cycling `ArrangerLauncherSwitchingNode`
into the render; tried `getAudioTracks`. A controlled test (open the *MP-committed* edit with
the rebuilt binary) **still hung** → the arranger node is per-audio-track, present regardless
→ no-op. Reverted (it only changed render semantics for zero benefit). The real fix must
address how a consolidated/relative-ref clip's source resolves in the render graph
(engine-level) — out of scope for a pre-playtest de-risk pass.

**Workaround for tonight (clean + aligns with the architecture):**
> In a multiplayer session, build anything you intend to **export** from **MIDI + built-in
> instruments** (drums kit, 4OSC, hosted synths). These sync instantly, need no audio
> transfer, and **export fine**. Use wave/recorded/**SA3** audio clips for auditioning/sound-
> design, but know that committing one into the shared project breaks export of the mix.

**Still to verify in the GUI dry run:** does *playback* (not just export) of a committed
audio clip also spin? The render-graph path is shared, so a guest may be unable to *hear* a
synced audio clip even though the stem downloaded. MIDI/instrument playback is fine.

## B. Pre-existing known limits (from docs/MULTIPLAYER.md) — candidates, not done
- **Bootstrap audio not wired:** a guest joining mid-session sees pre-existing audio clips as
  `sourceMissing` until the host re-commits that track (MIDI appears immediately). Commits
  made *after* the guest is present DO deliver audio (proven).
- **Stem up/download on the message thread:** large audio briefly freezes the UI.
- **Stale lock badge (~250 ms)** after a peer disconnects; cosmetic.
- **Buses/groups don't replicate** (only tracks). Out of scope for a 2-player jam.
- **Bundled `.sa3.env` COLORRACK_DATA** points at this worktree's path; if the worktree is
  removed, re-run `service/setup-sa3.sh` from a stable checkout + redeploy. (Tonight: fine.)

## Verified NOT broken
- Gates: vitest 423, `--selftest` 893×3, MP selftest local + cloud 912.
- Real audio correct: drums (peak 0.91), neural A/B (diff-RMS 0.485), full producer loop,
  real **SA3 pq 6.933** — all via render-to-WAV.
- Two-process cloud sync (structure + audio-stem blob round-trip): PASS.
- MIDI/instrument commit + export (host & guest): PASS.
