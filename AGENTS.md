# AGENTS.md

Start here, in order:

1. **`docs/HANDOFF.md`** — the current mission (DAW hardening/verification),
   the build+battery contract, the invariants you must not break, the known
   traps, and the paused-work stub. Read it COMPLETELY before changing code.
2. **`CLAUDE.md`** — the build manifest: every stage, gate, and decision to
   date. Treat its "Prime directives" as law.
3. **`docs/DAW_CAPABILITY_AUDIT.md`** — what the product can actually do.

Hard rules in one breath: macOS arm64 only · every mutation through a
MoshOps command · one undo system · state hash is versioned (v2) and never
gets piecemeal fields · MoshIR frozen at v0.3 · the full battery
(HANDOFF.md "Build + verify") must be green with ZERO JUCE assertions
before any merge · build with `cmake --build build-macos-arm64` (never
`--target Mosh` alone) · no secrets in the repo, ever.

The flywheel/agent-training code is PAUSED but its tests stay green — do
not delete or "clean up" anything under flywheel/, moshir/, service/, or
src/{moshir,collab,generative}.
