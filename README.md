# Mosh

A native **Apple-Silicon DAW** with neural processing woven into the same signal model as a
first-class, non-destructive layer — not a bolted-on "AI mode." Import/record, arrange, host
VST3/AU plugins, mix, and export, plus two neural tiers: real-time neural inserts and an offline
generative "re-imagine" render layer with semantic controls. A voice character (**Moshi**) and
2-player multiplayer ride on the same command spine.

> **macOS / Apple Silicon (arm64) only.** v0 has no Windows/Linux/CUDA paths — the unified-memory
> MLX generative service is the load-bearing reason.

## What it's made of

Three pieces behind one seam (the `execute_command` + snapshot/events contract):

- **Native engine** (`src/`, C++/JUCE 8 + Tracktion Engine) — the audio engine, the **MoshOps**
  command spine (the single mutation path), real-time neural inserts, and plugin hosting.
- **WebView UI** (`ui/`, React + Vite) — the arrangement/mixer/drawers, a pure client of MoshOps.
- **Generative service** (`service/`, Python + MLX) — the offline Tier-B "re-imagine" model
  (Stable Audio 3), reached as a job over HTTP; falls back to a deterministic FakeAdapter when the
  model isn't installed.

## Start here

| If you want to… | Read |
| --- | --- |
| Understand the codebase in 2 minutes | **[ARCHITECTURE.md](ARCHITECTURE.md)** — the verified module map + the two contracts |
| Understand *why* it's built this way | [ARCHITECTURE_REVIEW.md](ARCHITECTURE_REVIEW.md) — decisions, rationale, rejected alternatives |
| See what's done / what's next | [CLAUDE.md](CLAUDE.md) — the build manifest + per-stage gate ledger |
| Navigate every doc | [docs/INDEX.md](docs/INDEX.md) |

## Build & run

```bash
./run-mosh.sh build     # build (debug) and launch the GUI
./run-mosh.sh deploy    # build (release) and install one canonical /Applications/Mosh.app
./run-mosh.sh           # launch the already-built app
./run-mosh.sh smoke     # non-interactive native brain round-trip
```

Brain LLM keys (optional — voice falls back to an offline mock without them) go in `ui/.env.local`
(see [`ui/.env.example`](ui/.env.example)). The generative model is wired with
[`service/setup-sa3.sh`](service/setup-sa3.sh).

## Verify

```bash
/Applications/Mosh.app/Contents/MacOS/Mosh --selftest   # the packaged-app smoke path (deterministic command-surface checks)
cd ui && npm test && npm run test:e2e                   # UI units (vitest) + e2e (Playwright)
```

The hardware-verification runbook (does it make sound, mic/voice, two-peer multiplayer) lives in
[docs/VERIFICATION.md](docs/VERIFICATION.md).
