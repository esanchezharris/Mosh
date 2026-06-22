# Playtest-prep — STATUS  ✅ COMPLETE (🟢 GO)

**Goal:** de-risk Mosh for a LIVE 2-player playtest tonight (target **22:30 PDT, 2026-06-21**).
**Mode:** DE-RISK ONLY — branch `claude/playtest-prep-0621`, never merged. Artifacts here.
**Verdict:** 🟢 **GO** — see [`READINESS.md`](READINESS.md).

## Task ledger — all done
| # | Task | Status | Evidence |
|---|------|--------|----------|
| 1 | Pre-flight gates | ✅ | vitest **423/424**; `--selftest` **893×3** det.; MP selftest local **912**; **cloud 912** (6.07s net) |
| 2 | MP live smoke (two real processes, cloud) | ✅ **PASS** | guest got both tracks + downloaded stem `fbe0…` over cloud — [`mp-live-smoke.md`](mp-live-smoke.md) |
| 3 | docs/MULTIPLAYER.md | ✅ | written + linked (ARCHITECTURE §6, INDEX) |
| 4 | PLAYTEST_SETUP.md + unquarantine.sh | ✅ | guest setup + helper (exec) |
| 5 | Real SA3 render | ✅ | `verify.py --sa3` **5/5**: stable_audio3 **pq 6.933**, non-silent, differs |
| 6 | agent-setup.md | ✅ | native BrainProxy; key→ui/.env.local + launch via ./run-mosh.sh |
| 7 | scripts/playtest/preflight.sh | ✅ | validated end-to-end → **🟢 GO (4/4)** |
| 8 | Draft fixes / followups | ✅ (documented, none merged) | [`followups.md`](followups.md) |
| — | READINESS.md (go/no-go) | ✅ | 🟢 GO |
| + | Deploy clean main build to /Applications | ✅ | 14:33, SA3 bundled (.sa3.env + sa3/) |

## Gate numbers (harness grew past the manifest's 793)
- vitest: 423 passed / 1 skipped.
- `Mosh --selftest`: **893/893 ×3**, deterministic.
- MP selftest: local **912/912**, cloud **912/912**.
- Render-to-WAV (`verify.py --sa3`): **5/5** incl. real SA3 (pq 6.933).
- `preflight.sh`: 🟢 GO (4/4).

## The one real finding (root-caused; fix attempted, disproven, reverted → C++ pristine)
`export_audio` hangs when the mix contains an **MP-committed AUDIO clip** (consolidated to a
by-hash source) — affects **host and guest**; **MIDI/instruments are fine**. Tried a
`getAudioTracks` fix, a controlled test disproved it, reverted. Workaround: build exportable
songs from MIDI + instruments; treat audio/SA3 clips as auditioning. See [`followups.md`](followups.md) §A.

## Owner's remaining manual steps (only a human can)
1. `bash scripts/playtest/preflight.sh` (expect 🟢).
2. Two-window dry run (open /Applications/Mosh.app twice, Create+Join, eyeball replication).
3. Test real speaker output. 4. (optional) add LLM key for Moshi. 5. Send app to friend + un-quarantine.

## Log
- 14:08 branch+scaffold; SA3 setup. 14:13 clean Release build (cache reused).
- 14:1x gates green. 14:2x docs+links+SA3 verify 5/5. 14:3x two-process MP smoke PASS; preflight 🟢; deployed.
