# Reality Pack — DAW parity checklist (source of truth for conformance)

Cross-DAW knowledge base gathered 2026-06-26, synthesized from Ableton Live, FL Studio,
and Pro Tools manuals plus Mosh scope + browser-audio research. It is the **checklist**
we measure Mosh against to confirm it is a complete DAW vs. traditional DAWs — **not** a
product redesign.

## Files

| file | what it is |
|---|---|
| `mosh_daw_reality_model.md` | Canonical DAW object ontology (P0/P1/P2), cross-DAW behavior matrix, and ~150 numbered **implementation-testable invariants** grouped by area (Transport, Tracks, Clips, Clip-grid/scenes, Recording, Mixer/FX, Automation, Browser, Export, Patterns, Undo, Latency, …). |
| `mosh_daw_eval_suite.csv` | **200-row regression eval suite.** Columns: `id,area,user_action,initial_state,expected_state,expected_audio,expected_ui,expected_log_event,undo_expectation,pass_fail,priority`. |
| `mosh_monster_command_schema.json` | Starter command schema for the Monster agent operator. |
| `mosh_monster_eval_prompts.csv` | 150 natural-language Monster eval prompts. |
| `mosh_daw_reality_pack_README.md` | The pack author's original index. |

## Scope decision for this completion pass (locked with Emilio, 2026-06-26)

**Conventional DAW parity only.** In-scope: record, audio/clip editing, MIDI editing,
mixing, automation, routing, tempo/warp, fades, metering, browser/import, export/bounce,
project mgmt, undo. **Out of scope for this pass** (the pack covers them, but they are
product-direction work, not parity): the Ableton-style clip-launch / Session **scene grid**
(invariants 33–40), the **arena / vote / submission** battle flow, and the **Monster** chat
surface. Those rows are tagged `out-of-scope` by the conformance runner, not failed.

## How the pack becomes an executable gate

`scripts/daw-conformance/` turns this checklist into reproducible checks. Each eval row's
columns map to the harness lane that can prove it:

| eval column | conformance lane |
|---|---|
| `expected_state`, `undo_expectation` | `Mosh --run-script` JSONL + snapshot diff (do → snapshot → `undo` → re-snapshot) |
| `expected_audio` | `scripts/verify-hardware/verify.py` render-to-WAV + numpy assertions |
| `expected_ui` | vitest / Playwright e2e |
| `expected_log_event` | `mosh-log.jsonl` (`{ts,seq,command,args,ok,error?,undoable}`) |

Scenarios that can only be proven with a live audio device are reported `hardware-gated`
(see `docs/VERIFICATION.md` and the Phase 1 runbook), never silently failed.

The fresh, present-tense parity scoreboard generated from a conformance run lives at
`docs/FEATURE_AUDIT.md` (it supersedes the stale 2026-06-09 baseline).
