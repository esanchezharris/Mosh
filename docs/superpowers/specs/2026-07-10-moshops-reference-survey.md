# MoshOps Reference Survey — query/selection, composite ops, context contract

*Date: 2026-07-10 · Backlog: seeds AL-027 (`add_drum_pattern`) · Author: autonomous build (read-only survey; docs-only PR)*

Mosh already ships a complete command surface — **179 commands** dispatched in `src/moshops/MoshOps.cpp` (`executeImpl`, lines 771–982), the envelope/invariants in [`docs/02_MOSHOPS_CONTRACT.md`](../../02_MOSHOPS_CONTRACT.md), and a snapshot-grounded agent (`ui/src/agent/` + the GEPA optimizer `ui/src/gepa/`). This document is therefore a **delta survey**, not a grammar: five external DAW-agent references were read (read-only, cloned into a session scratchpad, never into the repo) and diffed against what Mosh already has. It ends in three concrete recommendations (a query surface, a composite-op shortlist, an `add_drum_pattern` semantics spec) and an explicit list of things Mosh should **not** copy.

Every claim is traceable: Mosh claims cite `path (lines N–M)` at `f1e5b18c` (this branch's base); reference claims cite the file/section at the surveyed commit/version pinned in §1.

---

## 0. Method + corrections to the brief

- References were cloned/downloaded into the session scratchpad. **LICENSE files were read first** (§1) and the read posture per repo follows from them. MAGDA is GPLv3 and Mosh is not: MAGDA was read for **patterns and semantics only** — this document paraphrases, cites paths/lines for traceability, and reproduces **zero MAGDA code, identifiers, or DSL surface syntax**. MIT/Apache references may be quoted briefly with attribution.
- **URL corrections found (none of the five references 404'd, but two metadata claims were wrong):**
  - `opendaw-mcp`'s own PyPI metadata declares `github.com/AMEOBIUS/opendaw-mcp` as Homepage/Repository — **that repo does not exist (404)**. Survey source is the authoritative **PyPI sdist `opendaw_mcp-1.48.0.tar.gz`** (sha256 `1d7e02ac…f41879e5`), which carries the full server + tests.
  - `reaper-mcp`'s README claims 158 tools; **measured at the surveyed commit: 139** `@mcp.tool()` decorators (README appears to describe a newer version).
- **Corrections to this survey's own brief:** the command surface is 179 commands (not "60+"); the agent-exposed catalog is **81** entries (`ui/src/agent/commands.ts`, measured — the file's own header comment "~63 of the ~147" at line 2 is stale). No `add_drum_pattern` implementation ticket existed anywhere in-repo before this PR (backlog + `gh issue list` both checked); this PR seeds it as **AL-027**.

## 1. License ledger

Licenses verified from the **LICENSE file in the surveyed artifact** (not repo-page sidebars), on retrieval 2026-07-10. Rights classes follow the repo's corpus-provenance convention (`docs/CORPUS_PROVENANCE.md`, pruned in the public-cleanup pass).

| Source | URL | Surveyed artifact | License (verified) | Rights class | Usage in this doc |
|---|---|---|---|---|---|
| MAGDA (magda-core) | github.com/Conceptual-Machines/magda-core | clone @ `8973dc10` | **GPL-3.0** (LICENSE) | copyleft | **Patterns/semantics only** — paraphrased, path-cited, zero code/identifiers/DSL syntax reproduced |
| juce-llm | github.com/Conceptual-Machines/juce-llm | clone @ `961db657` | MIT (LICENSE, © 2026 Conceptual Machines) | open | Described; short attributed quotes permitted |
| DAWZY (paper) | arxiv.org/html/2512.03289 | v1 (2025-12-02) | CC-BY-4.0 (arXiv) | open | Quoted with §-citations |
| reaper-mcp | github.com/TwelveTake-Studios/reaper-mcp | clone @ `f2287454` (v1.5.1) | MIT (LICENSE, © 2024 TwelveTake Studios LLC) | open | Described; short attributed quotes permitted |
| opendaw-mcp | pypi.org/project/opendaw-mcp | sdist 1.48.0, sha256 `1d7e02ac…f41879e5` (declared GitHub repo is a 404 — see §0) | Apache-2.0 (LICENSE in sdist) | open | Described; short attributed quotes permitted |

No reference code was copied into the repo; clones live only in the session scratchpad and die with the session.

## 2. Mosh baseline (measured — the "ours" side of every delta)

| Fact | Value | Source |
|---|---|---|
| Total commands | 179 | `src/moshops/MoshOps.cpp` (771–982), one `if` per command |
| Agent-exposed catalog | 81 | `ui/src/agent/commands.ts` (17 ff.), curated allowlist + client-side validation |
| Mutation shape | atomic, explicit ids (`trackId`/`clipId`/`noteIndex`), one command = one Tracktion transaction = one undo step | `docs/02_MOSHOPS_CONTRACT.md`; `beginTxn` per handler |
| Bulk exceptions | `delete_time_range {start,end,trackIds?}` (3674); `add_midi_clip {notes:[…]}` (5096); agent-only `batch_begin`/`batch_end` = N commands in one undo step (838–839, 3347–3352) | `src/moshops/MoshOps.cpp` |
| Query/selection | **none** — no backend selection register (settled design: selection is UI-local; commands carry explicit targets), no predicate/filter semantics; UI filters client-side over `get_snapshot()` | manifest "API resolutions"; §3 below |
| Read-only commands | ~29 (`get_snapshot`, `get_clip_peaks`, `list_plugins`, `list_colors`, `get_rhymes`, `list_directory`, …) | `src/moshops/MoshOps.cpp` dispatch |
| Drum surface | drum patterns are MIDI clips into a sampler: `set_track_type {type:"drum"}` auto-loads sampler+kit; `load_drum_kit` (4630), `assign_sample {note,file,mode}` (4659), `set_drum_lane {mute,solo}` (8885) — **no step/pattern DSL** | `src/moshops/MoshOps.cpp` |
| Agent note entry | agent-catalog `add_midi_clip` does **not** expose `notes` — the agent writes beats as N separate `add_note` calls (5550) | `ui/src/agent/commands.ts`; `src/moshops/MoshOps.cpp` |
| System prompt (measured, via the pure `brainCore` module) | **9,273 chars empty-session** (~2.3k tokens); catalog block 7,765 chars (~84% of static cost); snapshot ≈ **103 chars/track** at 4 clips/track | `ui/src/agent/brainCore.ts` (55–67), measured with `tsx` against a synthetic 8-track snapshot |
| Reply budget | **800 tokens max**, all three brain mirrors | `ui/vite.config.ts` (43–44), `src/brain/BrainProxy.cpp` (137), `service/brain_client.py` (106–122) |
| Grounding devices already shipped | ids QUOTED in the snapshot so models emit strings not numbers (`brainCore.ts` 17–19); rules: "Use the REAL ids… Never invent ids or commands" (42–51); catalog validation **before** the seam; snapshot re-injected every turn; history capped at 8 (`brain.ts` 35); `refresh()` after every batch (`executor.ts`); best-of-N rewrites history to what actually executed | `ui/src/agent/` |
| Destructive guard | >10 destructive commands per batch → all destructive blocked (`MAX_DESTRUCTIVE_PER_BATCH`, `executor.ts` 33) | `ui/src/agent/executor.ts` |
| Brain routing | deepseek→openai→xai fallback chain, OpenAI-compatible, `json_object`, bundled `brain.env`; **no streaming, no local-model provider** | `ui/vite.config.ts`, `src/brain/BrainProxy.cpp`, `service/brain_client.py` |

## 3. Query/selection recommendation

**The gap.** Mosh commands take explicit ids only. "Mute everything except drums", "delete all clips shorter than a bar", "select every clip in the hook" have no expression: the agent must read ids out of its prompt snapshot and emit one command per target. That works only while the whole session fits in the prompt and the model copies ids perfectly — the two assumptions the DAWZY paper shows failing (§5).

**What MAGDA does** (the strongest reference here — same JUCE + Tracktion stack, working query semantics; all paraphrased, GPLv3):

- The model does not call tools directly; it emits a small program in a purpose-built functional DSL, which a **native interpreter** parses and executes (`magda/agents/command_agent.cpp` 11–63; `magda/agents/dsl_interpreter.cpp`).
- Queries are **predicates evaluated backend-side**: the model emits *field–comparison–literal* conditions; the interpreter iterates the live engine objects and collects matches. Clip predicates cover duration-in-bars, start-in-bars, raw seconds, start-in-beats, numeric ids, plus exact name/type match, with the full comparison-operator set for numeric fields (`dsl_interpreter.cpp` 1341–1490, field handling 1422–1446). Track filtering is thinner (name equality only, 508–593); note predicates cover pitch (numeric or note-name), velocity, start, length (1719–1820). **"Select all clips below 1 bar" is directly expressible** as a one-condition clip query — the brief's example validated.
- Matched sets land in a **backend selection register** and subsequent chained operations fan out over it; each agent turn is wrapped in one compound undo scope; per-item failures are logged and iteration continues (267–329, 921–924).
- Grounding property worth stealing: **the model never sees a listing and never picks ids for bulk ops — it emits intent (a predicate), and the ids are resolved by the engine at execution time.** Stale references fail loudly ("not found"), they don't mis-target.
- Honest limits: no AND/OR predicate composition, no substring/fuzzy match in filters, clip queries are per-track unless run inside a track filter (no direct whole-project clip query), and the selection register is transient UI-side state invisible to undo.

**What the others do:** reaper-mcp has no query semantics at all — 0-based indices, no existence guards, "call `get_project_summary()` first" as a convention (README 460–468; validation only checks non-negativity, `reaper_mcp_server.py` 39–49). opendaw-mcp likewise: explicit indices everywhere, a whole-project state query for grounding, no predicates. DAWZY grounds by enumerating state through an MCP query tool but leaves index selection to the model — and reports open-weboth models "frequently producing invalid indices" (§2.2).

**Recommendation — two pieces, decided by the grounding constraint:**

1. **One new read-only query command, `select_items`** (name illustrative): scope (`clips` | `tracks` | `notes`), an optional list of predicates (field, operator, literal — implicitly ANDed), optional containment narrowing (`trackId`, `sectionId`, or a time range in seconds), returning **real engine ids** plus a compact per-match summary (name, type, start, length). Field vocabulary seeded from MAGDA's proven set, extended where MAGDA is thin: clips by `lengthBars`/`lengthSeconds`/`startBar`/`startSeconds`/`type`/`name`/`muted`; tracks by `name`/`type`/`muted`/`solo`/`hasInstrument`; notes by `pitch`/`velocity`/`startBeat`/`lengthBeats`. Operators: the six comparisons for numerics, equality + case-insensitive `contains` for strings (MAGDA's exact-match-only filters are a repeated friction). Deliberately **no OR/nesting** in v1 — the model can issue two queries; MAGDA ships usefully without composition.
   - *Why backend-evaluated:* ids in the reply come from the engine, not the model's imagination — the same property that makes Mosh's quoted-id snapshot work, extended to sessions too big to enumerate in the prompt. This is the direct answer to DAWZY §2.2, and it is measured-necessary at scale: `snapshot()` at 100 tracks is already 330 ms / 3.7 MiB (hardening-pass D1 measurement), and `compactSnapshot` grows ~103 chars/track — enumerating a large session into a 4B-class prompt is the failure mode, querying it is the fix.
   - *Why read-only:* it slots into the existing ~29 read-only commands: `undoable:false`, no transaction, unguarded in the multiplayer lock manager (like `get_rhymes`), logged in the JSONL like any command.
2. **Bulk mutation stays explicit-id.** Where profitable, existing mutations gain id-array variants (precedent: `delete_time_range.trackIds`, MoshOps.cpp 3674), and the agent composes `select_items → batch_begin → per-id commands → batch_end`, which the executor already brackets as one undo step (`executor.ts` 2, 78–109).

**Explicitly rejected (see also §8):**
- **No backend selection register** (MAGDA's binding mechanism). Mosh settled this at Stage 1: selection is UI-local, commands carry explicit targets. Two Mosh-specific reasons beyond the settled design: the multiplayer `LockManager` classifies lock scope from explicit args before execution — an implicit "current selection" target can't be lock-scoped; and the JSONL command log stays replayable/auditable only if each mutation names its targets (a predicate replays differently against different state).
- **No predicates inside mutation commands** ("delete all clips where …" as one command). It fuses a query into a write, so the log can't say what was deleted without re-deriving state, partial-failure semantics get murky (reaper-mcp's `create_bus` returns `ok: true` with silently failed sends — `reaper_mcp_server.py` 1285–1291 — precisely this trap), and the validator can no longer statically check targets. Two steps, one undo bracket, same UX.

## 4. Composite-op candidates

Cost side, measured: a new MoshOps command is ~28 lines (declaration + dispatch line + handler with `beginTxn`/emit/log) — plumbing is cheap; semantics are the question. Benefit side: one agent command call costs ~35–40 reply tokens, and the reply budget is **800 tokens** (§2), so composites matter most where N is large or where they delete **model-side arithmetic**. reaper-mcp's composite tier (11 of 139 tools, 8%) decomposes into four reusable patterns — orchestration, multi-entity batching, domain/unit encoding, opinionated preset (`reaper_mcp_server.py` 1054–2802) — used as the taxonomy below.

| # | Candidate | Pattern | Today (commands per use) | Justification | Verdict |
|---|---|---|---|---|---|
| 1 | **`add_drum_pattern`** — pattern-string DSL → one MIDI clip + notes (§7) | batching + DSL | `add_midi_clip` + N×`add_note`; at ~35–40 tokens/call the 800-token reply cap fits **~20 notes** — a 2-bar 3-lane groove (24–48 notes) **cannot fit in one agent turn today** | order-of-magnitude token cut (~60 tokens total); one txn = one undo (vs N); deterministic, goldenable parser | **Build — seeded as AL-027** |
| 2 | **`reimagine_section`** — section ref → resolve wave clip under it, create + render a region-scoped layer | orchestration + unit encoding | 2–3 commands *plus model-side beats→seconds arithmetic*: `DEFAULT_RULES` literally teaches "regionStart/regionEnd in SECONDS (beats × 60 ÷ tempo)" (`brainCore.ts` 47) | arithmetic in the model is a known small-model failure (DAWZY's only guardrail tool exists to convert units "to prevent scaling errors", §2.2); backend owns tempo truth; frees a rules line for GEPA | **Build (next after AL-027)** |
| 3 | **`create_send_bus`** — create bus + route N source tracks + set level | batching | `create_bus` + N×`add_send` + N×`set_send_level` | direct reaper-mcp precedent (`create_bus`, 1264–1299) **with its flaw fixed**: validate all sources upfront, then one txn — all-or-nothing instead of silent partial success | **Build (small)** |
| 4 | **`duplicate_time_range`** — copy clips in a time window (optionally to another position/track set) | batching | per-clip `duplicate_clip` + `move_clip` = 2N commands, plus model-side boundary math | the arrangement verbs are asymmetric today (`delete_time_range` exists, its copy twin doesn't); "double the hook" is a one-liner in producer speech | **Build (medium — clip-split-at-boundary semantics need care)** |
| 5 | ~~`add_mixdown_chain`-style FX presets~~ (reaper-mcp's `add_mastering_chain`, 1194–1220) | opinionated preset | n/a | rejected: hardcoded FX chains are reaper-mcp's own documented bloat (their compressor is unswappably hardcoded, 1223–1261); taste belongs in agent-side recipes/GEPA rules and kit content, not frozen into the command contract | **Reject** |

Design rules all four builds inherit (contract invariants + reference lessons): one `beginTxn` per composite (reaper-mcp composites need up to **6 undo presses** to reverse because nothing is bracketed — measured on `add_parallel_compression`); validate everything before mutating (no orphaned partial state); result envelope reports per-item outcomes explicitly when N>1; every composite stays expressible as the atomic sequence it wraps (composites are ergonomics, not new capability).

## 5. Context-contract delta + size budget

**DAWZY's finding, precisely:** "Off-the-shelf LLM approaches often hallucinate commands, mis-index tracks/parameters, or ignore live state" (§2.2). Their fix is an MCP state-query tool that "enumerates tracks, items, FX, and routing to ground edits in live session state" plus "refreshing state before mutation" (§2.2–2.3). Even so, open-weight baselines — QWEN-480B, GPT-OSS-120B, GPT-OSS-20B — hit only **25–50% success**, "frequently producing invalid indices when the full context (track/parameter mappings) was not considered" (§3.1); reliability came from choosing GPT-5, not from contract engineering. No schema validation, sandboxing, or token-budget figures appear in the paper.

| Contract dimension | DAWZY (paper) | Mosh (shipped) |
|---|---|---|
| Grounding | MCP state-query enumerates session; timing vs mutation not fully specified | full snapshot re-injected as system context **every turn**; `refresh()` after every batch (`executor.ts`) |
| Id discipline | index-based; invalid indices observed in all open baselines | engine-assigned ids, **quoted in the snapshot** so they round-trip as strings (`brainCore.ts` 17–19); "never invent ids" rule |
| Validation | none pre-execution (model-quality-dependent) | every command validated against the 81-entry catalog **client-side before the seam**, then arg-validated again in the handler |
| Mutation vehicle | LLM-generated **Lua code** executed in REAPER | structured `{command,args}` JSON only — the model never emits executable code |
| Reversibility | "atomic scripts and undo" (mechanism not detailed) | one command = one Tracktion transaction; agent turns bracketed by `batch_begin/end` = one undo step |
| Unit safety | dedicated unit-conversion MCP tool ("prevent scaling errors") | mostly backend-side already; the one model-side arithmetic (beats→seconds in rules) is what §4-candidate-2 removes |
| Reply contract | free-form code | one JSON object, `json_object`-forced, 800-token cap |

Mosh's contract is already the hardened version of what DAWZY sketches. The deltas worth taking are (a) the *query* half (§3) — DAWZY grounds reads through queries rather than one big enumeration, which is the scalable half of their design — and (b) treating their §3.1 numbers as a warning for local models:

**Size budget for a 4B-class local brain (measured Mosh numbers):**
- Static prompt: 9,273 chars ≈ **2.3k tokens** (preamble 593 + catalog 7,765 + rules ~880). Catalog is 84% of the static cost — **catalog size, not the snapshot, is the first thing to prune** for a small model (e.g., a two-tier catalog: always-on core verbs + task-gated families like lyrics/training).
- Snapshot: ~103 chars/track (4 clips each) ⇒ a 100-track session ≈ 19.6k chars ≈ **4.9k tokens** — fits a 32k-context 4B model trivially, but capacity is not the binding constraint: **id-copy precision is.** DAWZY saw 120B–480B models mis-index with full context provided (§3.1); a 4B model will be worse. Conclusion: for local models, don't enumerate — query (§3), keeping per-turn context near the empty-session floor.
- Reply side: 800-token cap ⇒ composites (§4) are what keep multi-step intents inside one turn for a slow local decoder.
- The missing mitigation neither Mosh nor DAWZY ships: **grammar-constrained decoding.** Both Conceptual-Machines references ship it — juce-llm passes GBNF grammars to llama-server (README 84–90; config field at `juce_llm/llm/LLMTypes.h` 23–40) and MAGDA carries a CFG of its DSL for constrained providers (`magda/agents/dsl_grammar.hpp` 14–101, pattern noted, not reproduced). Mosh's reply contract (one JSON object, known command names, typed args) is exactly the shape a GBNF grammar can enforce — this converts "hope the 4B model emits valid JSON" into "it cannot emit anything else", and is the single highest-leverage prerequisite for a local brain. Spec-level recommendation only; no ticket seeded.

## 6. Model-routing delta (juce-llm)

juce-llm (MIT, ~1,630 LOC, 18 files, `juce_core`-only — zero-external-deps claim verified in the module header and CMake) is a **single-provider client library**: a provider-tagged config (base URL, key, model, plus per-provider extras) feeds a factory; four first-class backends (OpenAI-compatible chat — which covers llama-server/Ollama/LM Studio local endpoints, README 12 & 84–90; OpenAI Responses; native Anthropic; native Gemini); full SSE streaming with per-provider chunk parsers; JSON-schema structured output mapped per provider; prompt-caching hooks (Anthropic `cache_control`, OpenAI cache keys). **It has no fallback chain** — provider choice is the caller's (`LLMClientFactory.cpp` 3–20), which is the exact thing Mosh's three mirrors exist to do (deepseek→openai→xai with `brain.env` fallback).

Verdict: **do not adopt the module** (§8) — it would replace only the C++ mirror, breaking the three-runtime symmetry (`vite.config.ts` / `BrainProxy.cpp` / `brain_client.py`) that is Mosh's actual routing asset, while still requiring Mosh to write the chain logic it exists for. Adopt three of its ideas at spec level:
1. **A `local` provider entry** in all three mirrors: llama-server/LM Studio/Ollama all speak the OpenAI-compatible shape Mosh already emits, so a fourth provider `{id:"local", url:"http://127.0.0.1:<port>/v1", key:"-", model:<env>}` resolved *first* when configured is a ~dozen-line change per mirror — the entire cloud-vs-local "routing abstraction" Mosh needs, with the existing chain as automatic cloud fallback.
2. **GBNF grammar** on that local provider (§5) — juce-llm shows llama-server accepts it through the same request.
3. **Prompt caching** headers/keys for the cloud providers — Mosh re-sends a ~9.3k-char-plus system prompt every turn; cache hints are free money on Anthropic/OpenAI-shaped APIs (not currently in Mosh's chain).

Streaming stays out of scope: Moshi's replies are ≤800-token JSON parsed whole; nothing in the UX consumes partial tokens.

## 7. `add_drum_pattern` — semantics spec (implementation = AL-027, not this PR)

Source semantics: opendaw-mcp's `create_drum_pattern` (`server.py` 12048–12162; grammar table in its docstring and velocity map at 12108, 12137–48). Their grammar, verified from code and tests: pattern = JSON object of lane→step-string; chars `x` (hit, velocity 0.9), `o` (soft, 0.5), `X` (accent, 1.0), `.`/space (rest); fixed 16 steps/bar; five hardcoded lanes → GM pitches (kick 36, snare 38, hihat 42, clap 39, perc 47); note gate 0.8×step; region length = longest lane. Tests pin golden patterns (amen, funky_drummer) by exact note counts, velocities, pitches (`test_orchestration.py` 860–993). Two documented **permissiveness flaws to reject**: unrecognized step characters silently become 0.8-velocity hits (12138), and the JS lane lookup silently falls back to kick (12133) even though the Python layer validates lane names.

**Mosh semantics** (composes exactly onto the existing surface — clip-per-pattern like `add_midi_clip` 5096, notes like `add_note` 5550, pads from `load_drum_kit` 4630 / `assign_sample` 4659):

- **Command:** `add_drum_pattern { trackId, pattern: { <lane>: "<steps>" , … }, start?, stepsPerBar?, name? }` → `{ clipId, trackId, noteCount, lanes: {<lane>: count} }`. One `beginTxn` — clip + all notes are **one undo step**.
- **Steps:** `X` accent → velocity 127; `x` hit → 110; `o` ghost → 60; `.` or space → rest (velocities on Mosh's 1–127 scale, ratios matching openDAW's 1.0/0.9/0.5). Note length = 0.8 × step duration. `stepsPerBar` defaults 16 (16th grid); 8 and 32 accepted. Lanes may have different lengths; clip length = ceil(longest lane / stepsPerBar) bars, converted to seconds **backend-side from the edit's tempo** (no model arithmetic).
- **Lane→pad resolution, in order:** (1) the track's sampler pad map (pads named by `assign_sample`/kit metadata); (2) for the five conventional lane names, the GM pitches above as fallback so a fresh `create_track {type:"drum"}` kit works with zero setup; (3) otherwise **error listing the track's actual pads** — never invent a pad, never default to kick.
- **Fail-closed validation (the openDAW divergence):** unknown step character → error naming the character and position; track without a sampler/kit → error suggesting `load_drum_kit`; empty pattern object → error. No silent coercions anywhere — a typo'd pattern must not become audio.
- **Out of scope for v1** (exists or belongs elsewhere): swing/humanize (post-apply via existing note edits; openDAW also keeps these as separate tools), melody/bassline degree DSLs (openDAW ships them; a future candidate **only after** the drum DSL proves agent uptake), looping semantics (Mosh clips handle that).
- **Acceptance sketch for AL-027:** goldens pinning an amen-style pattern to exact note count/velocities/pitches (openDAW's test idea, Mosh's numbers); `--selftest` checks incl. undo-restores-empty-track; agent-catalog entry + contract test; GEPA eval rows swapping an N×`add_note` gold for one `add_drum_pattern`.

## 8. Explicit divergences — where Mosh should NOT follow the references

1. **No backend selection register** (MAGDA): selection stays UI-local; agent bulk = query→ids→batch (§3 — lock scoping + JSONL replayability).
2. **No predicates in mutation commands** (novel to none of the references, but the tempting fusion of MAGDA's queries with reaper-mcp's batching): reads query, writes name their targets.
3. **No LLM-emitted executable code** (DAWZY generates Lua that runs in the DAW): Mosh's model emits data validated against a catalog; this is a security/robustness line, not a style choice.
4. **No tool-surface sprawl** (reaper-mcp 139→"163", opendaw-mcp 298): the curated 81-command catalog with client-side validation *is* Mosh's reliability mechanism; §4 adds ≤4 composites, pruning pressure stays (§5 two-tier catalog note).
5. **No un-bracketed composites** (reaper-mcp: zero undo blocks; 6 undo presses per composite; silent partial success): every Mosh composite is one transaction, all-or-nothing.
6. **No permissive DSL parsing** (opendaw-mcp: unknown chars→hits, unknown lanes→kick): fail-closed (§7).
7. **No opinionated FX-chain preset commands** (reaper-mcp `add_mastering_chain`): taste lives in agent recipes/GEPA rules and content packs, not the contract.
8. **No juce-llm dependency**: keep the three zero-dep mirrors; adopt the local-provider entry, GBNF, and cache-hint *ideas* (§6).
9. **No streaming** (juce-llm has it): nothing consumes partial tokens in Moshi's ≤800-token JSON replies.
10. **No DSL-program interface for the agent at large** (MAGDA's model emits interpreted programs): Mosh's `{command,args}` JSON + validator already delivers the grounding benefit; a program interpreter is a second language surface to secure and teach. The *predicate* sub-idea is taken (§3); the program-emission idea is not.

## 9. Traceability appendix

**Mosh (this repo @ `f1e5b18c`):** `src/moshops/MoshOps.cpp` — `executeImpl` 771–982, `batch_begin` 838/3347–3352, `delete_time_range` 3674, `load_drum_kit` 4630, `assign_sample` 4659, `add_midi_clip` 5096, `add_note` 5550, `set_drum_lane` 8885 · `ui/src/agent/brainCore.ts` — `compactSnapshot` 14–28 (quoted-id rationale 17–19), preamble 31–37, rules 42–51, assembly 55–67 · `ui/src/agent/commands.ts` — 81 entries (measured), stale count comment at 2 · `ui/src/agent/executor.ts` — batch/undo bracket comment 2, `MAX_DESTRUCTIVE_PER_BATCH` 33 · `ui/src/agent/brain.ts` — history cap 35 · brain mirrors: `ui/vite.config.ts` 43–44, `src/brain/BrainProxy.cpp` 69–74/137, `service/brain_client.py` 106–122 · prompt sizes measured by executing `brainCore.systemPrompt()` via `tsx` (empty 9,273 chars; catalog 7,765; +103/track at 4 clips) · snapshot-scaling figure from the hardening-pass D1 measurement (CLAUDE.md working notes, `__bench_snapshot`).

**MAGDA @ `8973dc10` (GPLv3 — paths only, all content above paraphrased):** `magda/agents/command_agent.cpp` 11–63 · `magda/agents/dsl_grammar.hpp` 14–101 (CFG), 104–236 (operation vocabulary) · `magda/agents/dsl_interpreter.cpp` — track filter 508–593, fan-out 921–924, clip queries 1341–1490 (fields 1422–1446), snapshot builder 1572–1646, note queries 1719–1820, instruction loop/partial failure 267–329 · `magda/daw/api/selection_api.hpp` 28–62 · `tests/test_dsl_track_workflow.cpp` 60–74, 127–150.

**juce-llm @ `961db657` (MIT):** `juce_llm/llm/LLMTypes.h` 23–40, 111–150 · `LLMClient.h` 48–69; `LLMClient.cpp` 27–41, 74–157 · `LLMClientFactory.cpp` 3–20 · `AnthropicClient.cpp` 37–39, 60–104 · `OpenAIChatClient.cpp` 35–38, 52–63, 78–83 · `OpenAIResponsesClient.cpp` 36–40, 52–74, 141–147 · `GeminiClient.cpp` 49–61, 120–131 · `Schema.h` 17–85 · README 8–15, 84–90 · CMakeLists.txt 39.

**DAWZY (arXiv 2512.03289v1, CC-BY-4.0):** abstract; §2.1 (modalities), §2.2 (processing layer, state-query tool, hallucination finding, unit-conversion tool, model choice), §2.3 (execution layer, refresh-before-mutation), §3.1 (4 tasks × 3 trials × 4 LLMs; open baselines 25–50%; invalid-indices quote), §3.2 (vs Ableton-MCP 4/9 vs 0/9; training-data note), §4 (limitations).

**reaper-mcp @ `f2287454`, v1.5.1 (MIT):** `reaper_mcp_server.py` (3,003 lines) — validation 39–49, `setup_sidechain_compression` 1054–1108, `add_mastering_chain` 1194–1220, `add_parallel_compression` 1223–1261, `create_bus` 1264–1299 (silent partial success 1285–1291), EQ domain encoding 2724–2802 · README 15 (rationale quote), 460–468 (indexing) · measured: 139 `@mcp.tool()` decorators; 128 single-call (92%), 11 composite.

**opendaw-mcp sdist 1.48.0 (Apache-2.0):** `server.py` — `create_drum_pattern` 12048–12162 (validation 12070–77, velocity map 12108, lane pitches 12109/12133, region length 12116, char handling 12137–48), melody 12293, bassline 12404, arpeggio 12563, swing 14773, ostinato 14633 · `music_theory.py` 31–49 (scales/pitch maps), 50–148 (genre presets), `parse_melody_pattern` 203–281 · tests: `test_orchestration.py` 860–993, `test_music_theory.py` 198–279 · 298 tools (package docstring, verified by count).
