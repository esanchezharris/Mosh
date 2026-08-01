# Moshi agent (brain) — how to turn it on for the playtest

The Moshi agent turns natural language ("make a 4-bar drum loop", "add reverb to the bass")
into validated MoshOps commands. It's **fully wired** but needs a usable **LLM provider**.
Without one, the packaged app reports the setup failure and makes no edit. The deterministic
demo brain is limited to Vite development and browser e2e.

> **Verified 2026-06-21:** the agent command catalog/contract passes
> (`ui/src/agent/commands.contract.test.ts`, part of the green vitest run — 423 passed).
> The brain has a native proxy in the packaged app
> ([src/brain/BrainProxy.cpp](src/brain/BrainProxy.cpp), wired at
> [src/webview/WebBridge.cpp:165](src/webview/WebBridge.cpp:165)) — so Moshi works in the
> *deployed* app, not only the Vite dev server. **But** it reads keys from the **process
> environment**, which a Finder double-click does **not** provide. See "Launch" below.

## 1. Add a key
Copy the template and fill in **one** provider (any of the three is enough):
```bash
cp ui/.env.example ui/.env.local
```
Edit `ui/.env.local` — set `MOSHI_BRAIN_PROVIDER` and the matching `*_API_KEY`:
```
MOSHI_BRAIN_PROVIDER=deepseek        # deepseek | openai | xai
DEEPSEEK_API_KEY=sk-...              # (or OPENAI_API_KEY / XAI_API_KEY)
```
`ui/.env.local` is gitignored; the browser never sees the key (the proxy is server/native side).

## 2. Launch so the key reaches the app
The native brain proxy reads keys from the environment, so **launch via the script**, which
loads `ui/.env.local` and exec's the binary with the env set:
```bash
./run-mosh.sh            # launches the built app with brain keys loaded
```
- A plain double-click of `/Applications/Mosh.app` sees only proxy configuration bundled
  for that build. Direct-provider secrets are never bundled. If no proxy pair is present,
  Moshi fails visibly without editing the project. For
  local playtests, use `./run-mosh.sh` so the configured provider reaches the app.
- Quick check without the GUI: `./run-mosh.sh smoke` prints a native brain round-trip
  (`--brain-smoke`), confirming the provider/key resolve.

## 3. Using it live
Type or speak to Moshi (the composer/voice in the UI). It replies with actions that execute
through the same MoshOps path as clicks, so everything it does is undoable and visible to your
peer through normal sync.

## Playtest notes
- The brain is **per-app / host-side**: each player who wants Moshi needs their own key +
  `./run-mosh.sh` launch. For tonight, simplest is **the host runs Moshi**; the guest can use
  clicks/keyboard.
- An SA3 "re-imagine" Moshi triggers produces a **wave clip** → to reach your peer it rides
  the cloud-relay stem sync (see `docs/MULTIPLAYER.md`).
- No key handy? Skip Moshi — the core DAW (tracks, drums, synth, plugins, arrange, mix,
  export, 2-player sync) is fully usable without it.
