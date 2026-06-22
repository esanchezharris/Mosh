# Moshi First Training Rung — Scoping Document

*Scopes the first **real** model-training rung for the Moshi closed-loop pipeline. The data side (ingest FLP/ALS/RPP → MoshIR → MoshOps commands → replay verifier → tuples + live loop) is **done and merged to main**. A fake LoRA training scaffold exists but does no real training. Goal: a local model that emits agent-callable MoshOps commands, served OpenAI-compatible into the BrainProxy slot.*

*Authored 2026-06-21 from a 4-agent research workflow (spec extract · scaffold audit · data-shape · infra) + synthesis.*

## 1. Recommendation

**GEPA-first (Phase 3), not SFT-first (Phase 4).**

Optimize the existing `systemPrompt()` against the Phase-0 verifier as the first real rung. Defer LoRA SFT until GEPA plateaus and the live utterance corpus has volume.

Rationale, grounded in this repo:
- **The SFT signal is thin today.** The only utterance→commands pairs come from harvested live agent turns (`tuples.jsonl`), and that real corpus is near-zero. Bulk available data is ~216 importer-derived project files with **no utterance** (`ImportProgram` has no prompt field, `ui/src/import/emit.ts:37-40`). SFT-first would mean training on a few dozen real pairs or synthesizing prompts for unconditioned arrangements — a weak, expensive first bet.
- **GEPA is "cheap lift, no training GPU" and logically independent of SFT.** The phase numbering (3=GEPA before 4=SFT) is the runnable order; GEPA de-risks the base-model bet before any GPU spend.
- **The verifier metric GEPA needs already exists and is deterministic, audio-free, free.** `ui/src/harvest/verifier.ts` `replay()` returns `cleanValidate` + `cleanApply` + `snapshotDiff` — exactly a GEPA feedback metric, and `commands.contract.test.ts` already parses the catalog. No new evaluation substrate to build.
- **GEPA's empirical profile fits a solo dev:** ~10 examples, 20–100 evals, beats GRPO at ~35× fewer rollouts. Cost is reflection-LM API calls (Emilio already has DeepSeek/OpenAI/xAI keys wired in `BrainProxy`).

## 2. Why this rung first — leverage & de-risking

- **Zero training infra, zero GPU rental, no RunPod decision needed yet.** Removes the biggest cost/coordination blocker.
- **De-risks the base-model bet.** GEPA improves whatever model sits in the `BrainProxy` slot and produces an honest clean-apply baseline number, so the later SFT bet is made against real evidence, not a benchmark blog.
- **Forces the dataset plumbing that SFT also needs.** The held-out eval set + verifier-as-metric harness is a prerequisite of *both* GEPA and SFT/GRPO. Doing GEPA first builds that scaffolding under the cheapest rung.
- **Produces an immediately shippable artifact:** an optimized `systemPrompt()` string + an eval-numbers file, checked in — the Phase-3 definition of done, with no model serving changes.

## 3. Data path — tuples + importer programs → ready-to-optimize dataset

For GEPA you need a held-out utterance→target eval set, not a big training corpus. Two-tier strategy:

**A. Eval set from harvested tuples (the real signal).**
- Source: `~/Library/Mosh/session/tuples.jsonl`, produced by `npm run harvest`. Filter to keep-quality turns: `outcome.appliedClean && outcome.replayClean && !outcome.undone`, with non-empty `utterance`. Prefer turns with positive `taste`.
- Projection: each kept `Tuple` → an example `{ utterance, (optional) snapshotBefore context, gold_commands: commands[] }`. This converter does **not** exist yet — it's the one new piece to write. Put it in **Python** per the spec (orchestration glue is Python), reading the flat JSONL directly (the schema is deliberately parser-free, `tupleSchema.ts:9-10`).
- Reality check: live tuples are scarce now. **Bootstrap them** by replaying `mosh-log.jsonl` and running a batch of real agent sessions. If that yields <~30 usable held-out examples, **synthesize an eval set**: slice importer `ImportProgram`s (281–5575 commands/file, 100% clean-apply) into small command sub-sequences and write a short NL instruction per slice ("create a drum track and add a 4-bar beat").

**B. The GEPA metric reuses the verifier directly.** The feedback function calls the same logic as `verifier.ts replay()`: valid JSON? command in `AGENT_COMMAND_MAP`? args pass `validateCommand`? cleanApply? optional `snapshotDiff` vs the tuple's `snapshotAfter`. Return `score + textual feedback` (the per-command `error` strings and diff paths are the reflection signal that makes GEPA work).

**Split:** small trainset (~10–20) + held-out valset (~20–40). Freeze and check in the held-out set.

**Corpus bundler — do NOT use it for this rung.** `service/training/corpus_bundle.py` bundles *raw project files for LoRA*, gated by a rights registry that currently yields zero eligible sources. GEPA consumes utterance/command JSON, not file bundles. Leave the bundler untouched (it's a Phase-4 concern). Note for later: the C++/Python bundle-hash divergence must be reconciled before it keys a real remote trainer.

## 4. Model + infra

**This rung (GEPA): no fine-tuning, no new base model.**
- **System under optimization:** the existing `systemPrompt(snap)` in `ui/src/agent/brainCore.ts:24`, served through whatever provider `BrainProxy` resolves. For metric runs, point the model-under-test at a cheap provider (DeepSeek via existing keys) or a local server.
- **Reflection LM:** a strong frontier model via Emilio's OpenAI/xAI key. Budget separately and cap it (spec guardrail: don't run metered API in loops).
- **Tooling:** `dspy.GEPA` (or `gepa-ai/gepa`) driven from Python in `service/training/`.

**Next rung (SFT, when GEPA plateaus):**
- **Base:** Qwen3-4B-Instruct-2507 (spec's named target + best fine-tune ROI). Llama-3.2-1B/3B as a tiny-footprint fallback for a fixed-vocab JSON emitter.
- **Where it runs:** Mac via **mlx-lm LoRA** first (64GB M-series, ~1 hr); RunPod (4090/A100 via Unsloth, sub-$5 job) only for repro/scale.
- **Serving — already solved, zero C++ change.** `BrainProxy::providers()` (`src/brain/BrainProxy.cpp:32`) reads `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`OPENAI_MODEL` and builds an OpenAI-compatible chat payload. Run `mlx_lm.server` (Mac) or Ollama, set `OPENAI_BASE_URL=http://localhost:<port>/v1` + `OPENAI_MODEL=<local>` + `MOSHI_BRAIN_PROVIDER=openai`, and the fine-tuned model drops into the slot by env var. **For a fixed command vocabulary, prefer constrained/grammar decoding** (llama.cpp GBNF / JSON-schema) over trusting raw JSON.

## 5. Concrete first-PR task list (smallest shippable slice)

Target: **Phase 3 GEPA, prompt-only, no model serving changes.** All new code is Python under `service/training/` + one TS helper; reuses `verifier.ts` and `commands.ts`. **Zero C++; scaffold untouched.**

1. **Eval-set builder** — `service/training/gepa/build_evalset.py` (new). Read `tuples.jsonl`, filter `appliedClean && replayClean && !undone && utterance != ""`, project to `{utterance, gold_commands, snapshotAfter}`. Write `evalset.{train,val}.jsonl`. *Verify:* prints counts; falls through to the synthesizer if too few real tuples.
2. **Importer-slice synthesizer (fallback)** — extend `ui/src/import/cli.ts` with a `--slices` mode emitting `{commands, suggested_utterance}` chunks, or slice in Python over the existing JSON output. *Verify:* slices replay cleanly through `verifier.ts`.
3. **Verifier-as-metric bridge** — `service/training/gepa/metric.py` (new). A GEPA feedback metric returning `score + feedback`. Reuse the verifier verdict via the existing `npm run verify` CLI (`ui/src/harvest/cli.ts` takes `commands.json` + `--target snapshot.json`, exits 0/1 with per-command detail), or port its checks. *Verify:* known-good list scores 1.0; bad-arg list scores <1 with the `validateCommand` error in `feedback`.
4. **GEPA driver** — `service/training/gepa/run_gepa.py` (new). Wire `dspy.GEPA`, seed program = current `systemPrompt()` text, reflection LM = OpenAI/xAI key, budget = `auto="light"` (cap metric calls). Output: `optimized_prompt.txt` + `eval_results.json`. *Verify:* runs end-to-end; reports baseline-vs-optimized clean-apply.
5. **Honest baseline + check-in** — record baseline `systemPrompt()` clean-apply on the frozen valset, then optimized. Check in `optimized_prompt.txt` + `eval_results.json`. *Verify:* the Phase-3 DoD — measurable lift reported even if small.
6. **(Optional, same PR) Adopt the prompt** — replace the string in `brainCore.ts:systemPrompt()` only if the lift is real and `commands.contract.test.ts` + `harvester.test.ts` stay green. *Verify:* `cd ui && npm test` green; e2e unchanged.

## 6. Risks / open questions (Emilio's calls in **bold**)

- **Compute budget for the reflection LM.** GEPA's cost is metered reflection-LM API calls, not GPU. **Decide: which provider/key for reflection (OpenAI vs xAI) and a $ ceiling per GEPA run.**
- **Held-out eval set is thin.** Real utterance tuples are near-zero today. **Decide: spend a session generating real agent turns first, or proceed on a synthetic (importer-slice) eval set + backfill later.**
- **Data-rights (defers to the SFT rung, not GEPA).** GEPA on commands/utterances doesn't touch raw third-party audio. But the eventual SFT corpus bundler's rights gate is trust-based and the arrangement-as-derivative-work question is unresolved. **Escalation trigger — Emilio's call before any LoRA training on scraped FLP/ALS.**
- **Base-model license (SFT rung).** Confirm the exact HF model id + license for Qwen3-4B / Llama-3.2 before download and before serving a fine-tuned derivative.
- **Spec order ambiguity.** The spec's "Decisions" line reads SFT→GEPA; the phase numbers read GEPA→SFT. This doc picks GEPA-first on the data evidence. **Confirm that's the intended order.**
- **Scaffold debt to clean before the SFT rung (not now):** C++/Python bundle-hash divergence, two divergent submit/status protocols, and `training_state.json` storing dead absolute temp paths. Flag, don't fix, in the GEPA PR.

---

*Key files: `ui/src/harvest/verifier.ts`, `ui/src/harvest/cli.ts`, `ui/src/harvest/tupleSchema.ts`, `ui/src/agent/commands.ts`, `ui/src/agent/brainCore.ts` (`systemPrompt`), `ui/src/import/emit.ts`, `src/brain/BrainProxy.cpp`, `service/training/` (scaffold — leave intact).*
