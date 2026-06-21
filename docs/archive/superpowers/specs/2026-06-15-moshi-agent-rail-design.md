# Moshi Agent Rail + Execution — Phase 1 design

**Date:** 2026-06-15
**Status:** approved design, pre-implementation
**Scope:** singleplayer / solo. Multiplayer is designed-for, not built.

## Context

Today Moshi is a creature that *reacts* (watches the mix, celebrates renders, has a voice) but can't *act*. The product's whole thesis — and the thing the user most wants next so they can actually make music and start training/verifying the agent — is **Moshi running the session**: you tell him what you want, he does it, you keep or undo.

The architecture was built for exactly this. A founding rule is *"every change is a MoshOps command — UI **or agent** — nobody touches the engine directly."* So the agent is not a bolt-on: the existing ~93-command `execute_command` seam **is** its tool API. This phase wires Moshi's brain (an LLM) to that seam, gives him a real home (the right-side rail), and lands his edits as a reviewable, single-undo "Monster changes" batch.

This is Phase 1 of a 4-phase road (rail → agent does the work → tools-on-tap → the room). Phases 2–4 (deeper autonomy, keyboard/multi-tool parity, light-theme default, section minimap, multiplayer tiles, battle modes) are out of scope here but the rail is structured to grow into them.

## What we're building (and not)

**In scope (Phase 1):**
- The **agent rail** — Moshi's always-present home on the right (both Arrange + Mixer), Lean layout, voice-hero + type composer. Supersedes the dock-panel Moshi.
- The **brain→MoshOps execution bridge** — his brain plans and runs a **curated subset** of real commands via the same `executeCommand` seam the UI uses.
- **Monster changes** — one ask → a batch of edits → **one undo step**, shown on the timeline with Keep / Undo.
- **Voice input** (hold-to-talk → text) + **typed input**, both routing to the brain.
- The **LLM proxy** ported into the product so keys never reach the client.

**Out of scope (deferred):**
- Multiplayer tiles / collaborators / battle modes (Phase 4). The rail is *structured* for it (a participants stack) but only the solo state is built.
- Open-ended autonomous loops (multi-turn self-direction). Phase 1 is **one ask → one batch → review**.
- The full 93-command surface. Destructive/project-IO/device commands are excluded from the toolset.
- Light-theme-as-default, section minimap, keyboard/multi-tool parity (Phase 3).
- Dry-run "preview before apply." Phase 1 applies optimistically then offers Undo (simpler, leverages existing undo).

## Architecture

```
You ──talk/type──▶ Brain (LLM, JSON out) ──▶ Executor ──▶ executeCommand ──▶ MoshOps/Tracktion
                        │                        │              (same seam as UI)
                        ▼                        ▼
                   say + intent            batch_begin … commands … batch_end
                   (voice + pose)          → one undo step → "Monster changes" (Keep/Undo)
```

The agent is just another client of `executeCommand` — sandboxed by construction (no other door to the engine), and trivially reversible (one undo step).

## Components & interfaces

### Frontend (`ui/src/`)

- **`agent/brain.ts`** — port of `design-lab/playground/brain.js` into the product. Manages the LLM conversation; builds the system prompt (persona + curated command catalog + a compact snapshot summary); calls `brainChat(messages)`; parses the JSON reply.
  - Reply contract (extends the lab's): `{ say?: string, intent?: string, mood?/energy?/heat?: number, commands?: { command: string, args: object }[] }`. The `commands` array is the new field — the lab already forces `response_format: json_object`, so this is a contract extension, not a new mechanism.
  - API: `brain.send(text) → Promise<BrainReply>`; events `busy`, `error`. Provider switch (DeepSeek/OpenAI/xAI) preserved.
- **`agent/commands.ts`** — the **curated tool catalog**: the allowed command subset, each with a one-line description + arg schema. Two consumers: (a) rendered into the system prompt so the LLM knows what it can do; (b) client-side validation (reject any command not in the catalog or with malformed args **before** it reaches the seam).
- **`agent/executor.ts`** — takes `BrainReply.commands`, runs the batch:
  1. `store.exec("batch_begin", { name })`
  2. for each command: validate via `commands.ts` → `store.exec(command, args)`; collect a human-readable summary + ok/err
  3. `store.exec("batch_end", {})`
  4. returns a `ChangeSet` (the summaries) for Monster changes. On any validation failure, the offending command is skipped (not sent) and noted.
- **`agent/voiceInput.ts`** — Web Speech API (`SpeechRecognition`) hold-to-talk → transcript → `brain.send`. Guarded: if unavailable, the composer falls back to type-only. Text is the reliable baseline; voice rides on top.
- **`bridge.ts`** — add `brainChat(messages)` with the same native/dev/mock split as `executeCommand`: dev → Vite proxy `/api/brain/chat`; native → a JUCE native function; mock → a canned reply for the dev harness.
- **`ui/vite.config.ts`** — port the lab's `moshiBrain` Vite plugin (server-side `/api/brain/chat` proxy; keys from `.env.local`, never bundled).
- **`ui/src/ui/AgentRail.tsx`** (new) — the rail: the existing crisp creature + state up top, a "now" line when working, the composer (hold-to-talk mic hero + quiet type field) pinned at the bottom. Wires composer submit → `brain.send` → `executor.run` → Monster changes. Built as a participants container (solo = one big Mosh) so tiles can slot in later. Replaces the `Moshi` dock panel in Arrange + Mixer.
- **`ui/src/ui/MonsterChanges.tsx`** (new) — a timeline-anchored popover listing the change summaries with **Keep** (dismiss) / **Undo** (`store.exec("undo")`, reverts the one batch).
- **`store.ts`** — agent UI-local state: `agentBusy`, `lastChangeSet`, `monsterOpen`, conversation history (capped), voice on/off (already exists).
- **`ui/src/ui/Moshi.tsx`** — refactor: keep the creature/voice/reactivity engine; the rail chrome moves to `AgentRail.tsx` which mounts the creature. (Most of Moshi.tsx's logic is reused; the dock-panel JSX is replaced.)

### Backend (`src/moshops/`)

- **`batch_begin` / `batch_end`** (new commands) + an `inBatch` flag. `batch_begin` opens one named transaction; every undoable handler **skips its own `beginNewTransaction` when `inBatch` is true**; `batch_end` closes it. Result: N commands = one undo step. Both meta-commands log as non-undoable JSONL lines. This is the **only** C++ change required.
- **Native `brain_chat`** function (for the packaged app, where there is no Vite): a thin `juce::URL` proxy to the provider, keys from env (mirrors the SA3 env-var pattern). Dev can ship on the Vite proxy first; the native function is needed before the packaged app works end-to-end.

## Curated first toolset

Chosen for high value + low blast radius. The brain receives the current snapshot as context, so it has real track/clip IDs.

- **Tracks:** `create_track`, `rename_track`, `remove_track`
- **Clips:** `add_test_tone_clip`, `add_midi_clip`, `move_clip`, `trim_clip`, `split_clip`, `duplicate_clip`, `remove_clip`, `set_clip_gain`, `set_clip_mute`
- **MIDI:** `add_note`, `remove_note`, `set_note`, `quantize_notes`
- **Transport / timing:** `set_tempo`, `set_time_signature`, `set_metronome`, `set_transport`
- **Mixer:** `set_track_volume`, `set_track_pan`, `set_track_mute`, `set_track_solo`, `set_master_volume`
- **Plugins:** `list_builtins` (read), `load_builtin`, `set_plugin_param`, `bypass_plugin`, `remove_plugin`
- **Neural (Tier-A):** `add_neural_insert`, `set_neural_param`
- **Generative (Tier-B):** `create_render_layer`, `set_render_param`, `render_layer`, `accept_render`, `reject_render`

**Excluded for now:** project IO (`save`/`open_project`/`new_project`/`save_as`), device/audio settings, routing/buses, automation points, export, plugin scan/blocklist, VST3 `load_plugin` (needs a scanned id; revisit). Easy to widen the catalog later — it's one data file.

## Turn lifecycle (data flow)

1. User holds-to-talk (or types) → text.
2. `brain.send(text)`: messages = [system prompt (persona + `commands.ts` catalog + compact snapshot) , …history , user] → `brainChat` → JSON `{ say, intent, commands? }`.
3. `say` → Moshi utters (voice + bubble); `intent` → pose/state (existing `utter` funnel).
4. If `commands`: `executor.run` brackets them in `batch_begin`/`batch_end`, validating each against the catalog; snapshot refreshes via the normal event path.
5. **Monster changes** opens with the plain-English summaries + Keep / Undo.
6. Keep → dismiss. Undo → one `undo` reverts the whole batch.

## Safety & error handling

- **Sandboxed:** the agent can only emit commands in `commands.ts`; anything else is rejected client-side before the seam. The seam also validates args backend-side. No destructive project-IO in the toolset.
- **Reversible:** every agent turn is one undo step.
- **Malformed LLM output:** JSON parse / schema failure → no commands executed; Moshi utters a brief "didn't catch that" and the user retries.
- **Partial failure:** if a mid-batch command errors, the batch still closes; the change set marks which succeeded; the user can Undo the whole thing.
- **Keys:** never in the client bundle (Vite proxy in dev, native proxy in prod, env-sourced).

## Morph-ready (collab later)

The rail is a vertical participants container. Phase 1 renders exactly one participant (Mosh, large). Phase 4 makes additional participants render as tiles and shrinks Mosh — no relayout, the structure already supports it. Not built now.

## Verification

- **Backend:** `Mosh --selftest` gains a `batch_begin`/`batch_end` section — a 3-command batch undoes as **one** step (track count returns to start after a single `undo`), and per-command behavior outside a batch is unchanged. Selftest stays green (currently 650/650, run with `MOSH_ENABLE_SA3=0`).
- **Frontend:** dev preview (Vite + mock + the brain proxy). Type "make a drums track and set it to -6 dB" → two commands batch → Monster changes shows both → Undo returns to start. `tsc` clean; bundle builds; swappable-seam invariant holds for the C++ binary (only the new `batch_*` commands change it).
- **Voice:** hold-to-talk transcribes and routes to the same pipe (browser-dependent; type path is the guaranteed one).
- **End-to-end:** in the packaged app, the native `brain_chat` proxy resolves a real provider call with env keys.

## Build sequence (high level)

1. Backend `batch_begin`/`batch_end` + `inBatch` guard + selftest. (Unblocks one-undo batches.)
2. Port brain + Vite proxy into the product; `brainChat` bridge abstraction (dev path first).
3. `commands.ts` curated catalog + `executor.ts` (batch + validate + change set).
4. `AgentRail.tsx` (rail + composer) replacing the dock Moshi; `MonsterChanges.tsx`.
5. `voiceInput.ts` (hold-to-talk STT).
6. Native `brain_chat` proxy for the packaged app.
7. Verify end-to-end; widen the toolset as confidence grows.
