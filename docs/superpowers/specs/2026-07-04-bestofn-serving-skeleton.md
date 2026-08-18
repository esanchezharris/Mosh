# Best-of-n serving skeleton (WP-11) — spec v2 (post-panel)

> **Historical:** this experimental single-shot orchestration is not reachable from
> the shipped Ask Moshi surface. Its UI setting was removed when bounded studio
> skills replaced raw command planning; keep this document only as design history.

**Program**: `docs/plans/MOSHI_TRAINING_PROGRAM_2026-07.md` §5 Stage-2 items 3–4.
**Posture**: flag-gated, OFF by default, zero new MoshOps commands, minimal C++ (one
bridge relay on the `brain_chat` precedent). Builds while r3 trains — candidates come
from the CLOUD `brain_client`; no local mlx serving.

v1 of this spec was reviewed by a three-lens design panel (contract / failure-modes /
simplification; all three: *sound-with-changes*, 3 blockers). v2 incorporates every
blocker + should-fix. Panel record: session workflow `bestofn-spec-panel` 2026-07-04.

## Architecture (v2 — inverted hook, escalate-only route)

### UI side (flag `bestOfNServing`, default OFF, help text discloses archiving)

1. **Single-shot stays exactly as shipped**: `brain.send()` → `brainChat` (native
   BrainProxy) → `parseReply`. No service hop on the common path. Command-less replies
   (HUH/GREET/say-only) bypass everything below — no validation pressure to invent edits.
2. **Classify the parsed reply's commands UI-side** (`ui/src/agent/policy.ts`, exact
   name-set lookup):
   - `taste` — populate-class note batches, `create_render_layer`/`set_render_param`/
     `render_layer`, arrangement (`move_clip`/`duplicate_clip`/`trim_clip`/`split_clip`,
     section ops) → **escalate** via the bridge (below). On any error / timeout /
     `degraded:true` → execute the single-shot reply already in hand (**zero extra cloud
     calls on failure** — kills the v1 double-spend blocker).
   - `corrective` (everything else) — **one validator-retry UI-side**: if
     `validateCommand` fails, re-prompt `brainChat` once carrying the exact failure
     string (L2 lyric-loop pattern); the (failed, corrected) pair is fire-and-forgotten
     to `/archive_pair` — corrective turns produce DPO fuel too (program item 4's
     "costs nothing extra").
3. **Escalation call carries the UI-rendered truth** — the exact `messages` array
   (system prompt + sliced history + user turn) the single-shot used, the serialized
   catalog subset (names + arg specs + id/path-valued arg map from `AGENT_COMMANDS` —
   **no committed catalog copy, no export script**: source of truth by construction),
   a compact **id-manifest** (live track/clip/section/annotation ids + lyric line
   counts), and the already-parsed single-shot reply as candidate #0. This kills the
   v1 blockers: multi-turn history is preserved verbatim, and there is no Python copy
   of PREAMBLE/DEFAULT_RULES/compactSnapshot to drift.

### Native bridge (the transport that v1 got wrong)

The WebView cannot reach the service (port known only to native, no CORS, spawn owned
by native) — and direct UI→service HTTP would sidestep the swappable-seam directive.
The `brain_chat` bridge function is the shipped precedent for UI-domain LLM traffic
outside MoshOps. Add **one async bridge relay** `escalate_candidates(payloadJson)`:
native forwards the payload to the service (`GenerativeJobManager` HTTP plumbing,
`ensureServiceRunning` — the user opted in via the flag), returns the service JSON or
`{degraded:true, reason}`. Not an engine mutation ⇒ not a MoshOps command.

### Service side

- `POST /escalate_candidates` — draws **n−1 = 3 additional candidates** (hard cap 8
  total) via `chat_json` **in parallel threads** with a per-draw timeout (20 s) and a
  route budget (≤45 s, below the UI's 60 s wait so the abandon-race is rare; route
  latency recorded per row). `chat_json` gains an additive `temperature` override for
  the exploratory draws (recorded per candidate; reasoning-path providers that ignore
  sampling params are recorded as such — near-duplicate draws dedupe and the response
  says `degraded` honestly rather than faking diversity).
- **Scoring** (`service/bestofn/core.py`, pure, hermetic-golden-tested):
  `score_candidate(manifest, catalog, commands)` →
  - *shape*: parses to non-empty `{command, args}` list (candidates here always came
    from a commands-bearing turn);
  - *catalog*: names ∈ posted catalog;
  - *grounding*: id-bearing args must be in the manifest — **except** ids plausibly
    created earlier in the same candidate (an earlier create-command of the matching
    entity type ⇒ scored `neutral`, not zero — no anti-create bias);
  - *files*: **input** paths (import/assign/sketch sources) must exist; **output**
    paths (export/save targets) only need an existing parent dir — no
    overwrite-steering retry pressure;
  - score = weighted pass fraction; rank desc; tie → fewer commands → stable order;
    every row records `scoreMargin` + `tieBreak:true` so zero-margin "preferences"
    are self-identifying and the DPO harvest can filter them (verifiable-only v1
    scorer ties are expected — the ranker seam is where taste separation arrives).
- **No usable candidate ⇒ `degraded:true`** (explicit, not a 200 full of garbage);
  the UI executes its single-shot reply.
- **Ranker seam**: `rank_candidates(scored, ranker=None)` — optional callable; v1
  ships verifiable-only + a documented adapter stub for
  `scripts/verify-hardware/taste_ranker.score_candidate` (audio embeddings exist only
  post-render; wiring is a labeled follow-up, per the honest-gating posture).
- `POST /archive_pair` — best-effort appender shared with the route: O_APPEND single
  `write()` rows to `MOSH_DPO_PAIRS_DIR` (default `~/Library/Mosh/dpo-pairs/`), never
  route-fatal (failure surfaces as `archived:false` in the response). Row:
  `{ts, utteranceSha, snapshotSha, messagesBytes, policy, candidates:[{commands, say,
  score, reasons, sampling}], chosenIndex, scoreMargin, tieBreak, latencyMs, source:
  "escalate"|"corrective-retry", executedUnknown?}`.
- `MOSH_ENABLE_BESTOFN=0` pins the deterministic **fake candidate backend** (mirrors
  `MOSH_ENABLE_TRANSFORM`/`MOSH_ENABLE_SOULX`) so goldens + smokes run hermetically.

## Cut from v1 (panel simplification, program contract intact)

- Catalog export script + committed JSON + drift golden → catalog rides the request.
- All service-side prompt rendering (PREAMBLE/RULES/compactSnapshot copies) → UI
  renders, service consumes verbatim.
- Service-side single-shot + corrective routing → UI-side; route is escalate-only.
- Full-snapshot POST → id-manifest.
- n configurability → fixed 4, hard cap 8.

## Out of scope (labeled)

Audio-ranker wiring (post-render timescale) · owner blind A/B falsifier (archive rows
are its raw material; classification outcomes logged per flag-ON turn so the
never-escalated miss rate is measurable) · local-model candidates (needs a PASSED
checkpoint + the ONE-mlx rule) · latency work beyond the recorded ~25 s cloud budget.

## Verification

- Goldens (hermetic, 3× deterministic): `service/bestofn/bestofn_core_test.py`
  (scoring: grounded pass / stale-id zero / created-id neutral / input-file zero /
  output-path parent rule / unknown command; dedupe; rank + tie flags; archive row
  shape) and `bestofn_runtime_test.py` (mocked chat_json: escalate flow, per-draw
  failure tolerance, degraded floor, fake backend, archiver best-effort on unwritable
  dir).
- vitest: policy table classification; brain hook (escalate happy path, degraded →
  single-shot fallback, flag-off no-op, command-less bypass); corrective retry carries
  the exact validation failure; settings entry.
- C++: bridge relay compiles into the existing WebBridge; selftest count unchanged
  (relay is isHealthy/ensure-gated and never runs headless).
- HTTP smoke: route with `MOSH_ENABLE_BESTOFN=0` (fake) and with keys (owner-gated).
- Full native gate per plan (selftest ×3, Catch2, vitest, e2e, tsc) before PR.

## Review outcome (2026-07-05)

Native gate: selftest **1171/1171 ×3** deterministic, Catch2 **344/64**, vitest
**749**, e2e **116/116**, tsc clean, HTTP smoke (fake backend + archive). The
adversarial review workflow was cut short by a subagent spend-limit; the review
was completed inline. Two real defects found + fixed, one dismissed:

- **(fixed, blocker) mock-poisoning** — a best-of-n internal error (manifest/
  catalog build, before the hook's own try) fell through `brain.send`'s outer
  catch and returned the demo mock, discarding a valid single-shot reply. The
  augmentation is now wrapped so any error keeps the single-shot reply; the mock
  is only ever reached when `brainChat` itself fails.
- **(fixed, major) archive stored a hashed prompt** — the escalate row wrote
  `utteranceSha`, but the archive is the program's DPO fuel (item 4) and a hash
  is inert. Now stores the raw `utterance` (the DPO prompt; disclosed by the
  setting help, local-only); the snapshot stays hashed (bulk).
- **(dismissed) C++ teardown `[this]` capture** — the WebBridge relay's detached-
  thread `this` capture is the SAME accepted idiom as the shipped async service
  commands (`generateLyrics`/`transcribe`/`analyzeLyrics` at MoshOps.cpp:1240/
  1401/1530: `std::thread([this,…]{ jobManager.X(); callAsync(…) })`), not a new
  exposure.
- Also verified: flag-OFF is a strict no-op (no bridge call, byte-identical
  default path — `maybeEscalate`/`maybeValidatorRetry` short-circuit on
  `enabled()`); the created-id-neutral scoring chain; O_APPEND single-write
  atomicity for concurrent escalations; taste-class commands carry no file
  paths / lyric text into the escalate archive.
