# Mosh · Designer Arena

A **dev-only taste bench**. It floods you with rendered **design candidates** for the Mosh UI —
whole-shell looks, components, micro-interactions, and the liquid waveform — so you can judge
them head-to-head with your own eye. Winners get ported into the real v2 shell.

> The Arena auditions **ideas**, not models. AI mass-produces options; it has no taste. You do.
> Multiple models (Claude, GPT, Gemini, Grok) each generate candidates in **two passes**
> — *elevate* the MOSH identity, and *bolder* — and Claude (Opus, in-session) seeds the wall directly.

## Why it's safe

- **Never ships in Mosh.app.** This is a separate Vite app; the shipped UI (`ui/`) never imports it,
  so it can't leak into the single-file bundle or `--selftest`.
- **Keys never touch the client.** The browser talks to same-origin `/api/arena/*`; the local proxy
  injects keys from `arena/.env.local` (gitignored) server-side. You add keys yourself — Claude never sees them.
- **Untrusted candidate code is sandboxed.** HTML candidates render in a `sandbox="allow-scripts"`
  iframe with a strict, no-network CSP; GLSL candidates are loop-linted, compiled in isolation, and
  watchdog-timed. A runaway candidate can be killed without reloading the app.
- **Spend is capped.** Every model call is metered and a hard per-session USD cap stops generation dead.

## Run it

```bash
cd arena
npm install
cp .env.local.example .env.local   # optional — add model keys to enable API "designers"
npm run dev                         # → http://localhost:5273
```

The wall is full of hand-authored seed candidates immediately, with **no keys required**. Add keys to
`.env.local` to let the four model designers generate more.

## Concepts

- **Candidate** — a self-contained rendered look: either an HTML document (component / whole shell) or a
  GLSL fragment shader (the waveform material) over Mosh's uniform contract. Built from the shared
  **design kit** (`src/kit/`) so every candidate is true-to-brand and every winner ports with no translation.
- **Judging** — a *Grid* (wall, promote/cull) for wide fields and *A-vs-B* (side by side, pick a winner)
  for final calls. All candidates share one transport clock so animation compares fairly.
- **Library** — winners saved to `library/*.json` with provenance + thumbnail, git-committable. This is
  the deliverable that flows into `ui/src/v2/`.

## Staging

- **Stage 0** (this) — harness + sandbox + spend-capped proxy (Claude) + a full seed wall.
- **Stage 1** — all four designers + more component targets + fixture variety.
- **Stage 2** — port winners into `ui/src/v2/shell.css` + the every-clip live waveform.
- **Stage 3** (optional) — vision pre-cull + a "which model predicts your taste" leaderboard.

See the build plan for the gates each stage must clear.
