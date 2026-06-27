# Python Service De-Slop Audit

Scope: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/service` plus first-party service helpers under `scripts/`. Excluded `.venv`, `__pycache__`, model weights, and generated artifacts.

Status: BLOCK
Recommendation: REQUEST_CHANGES

Skill-perspective check: ran `omo:remove-ai-slops` and `omo:programming` perspectives before judging tests/maintainability. The diff violates both perspectives in scoped production code: oversized Python modules, raw `dict[str, Any]` service contracts, broad catches that collapse unexpected failures, and weak coverage on state/remote-boundary behavior. The test files reviewed did not show deletion-only tests or pure tautologies, but they leave the high-risk boundaries unpinned.

## Commands / Evidence

- `git -C .../deslop-campaign-20260626 status --short --branch` -> clean worktree on `codex/deslop-campaign-20260626...origin/main`.
- `git -C .../deslop-campaign-20260626 diff --stat origin/main...HEAD -- service scripts` -> no service/script branch delta.
- `find service scripts ... -name '*.py' ... | awk ...` -> oversized pure LOC: `scripts/macos-ui-automation-gate.py` 1041, `service/server.py` 612, `scripts/verify-hardware/verify.py` 401, `service/training/trainer_job.py` 319, `service/adapters/stable_audio3_cuda.py` 273.
- AST scan (`PYTHONDONTWRITEBYTECODE=1 python3 - <<'PY' ... ast.parse ...`) -> `AST_PARSE PASS 0 failures`; also found broad excepts and raw `dict`/`Any` boundaries.
- `PYTHONDONTWRITEBYTECODE=1 MOSH_ENABLE_SA3=0 python3 service/scripts/fake_adapter_test.py` -> `ALL PASS`.
- `PYTHONDONTWRITEBYTECODE=1 MOSH_ENABLE_SA3=0 python3 service/scripts/resilience_test.py` -> `OK: 0 failure(s)`.
- `git status --short --untracked-files=all` after smoke checks -> no output; no source/worktree changes from verification.

## CRITICAL

None.

## HIGH

1. Malformed HTTP JSON can become a destructive training-registry import.

- Path: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/service/server.py:426`, `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/service/server.py:667`
- Evidence: `_read_json()` returns `{}` for any decode/read failure at lines 426-433. `/training/import-registry` then treats missing `registry` as `{}` and calls `save_registry(...)` at lines 667-673.
- Slop category: over-defensive broad catch; parse-don't-validate violation; raw dict boundary.
- Behavior risk: a malformed request body to `/training/import-registry` can overwrite the rights registry with an empty registry instead of returning 400 and preserving state.
- Existing coverage: `service/scripts/fake_adapter_test.py:103-136` covers `/health`, `/capabilities`, `/submit`, `/status`; `tests/test_training.cpp:67-135` covers the happy fake-training path. No test covers malformed POST JSON or import-registry write refusal.
- PR-sized acceptance criteria: invalid JSON returns HTTP 400 with no write; import-registry validates the parsed object before `save_registry`; add a stdlib in-process Handler test that writes a sentinel registry, posts malformed JSON, and asserts the file is unchanged.

2. Corrupt rights/training state is silently reset to defaults.

- Path: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/service/training/rights.py:15`, `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/service/server.py:176`
- Evidence: `read_json()` catches all exceptions and returns `{}` at `rights.py:19-23`; `_load_training_state()` catches all exceptions and returns default state at `server.py:176-190`.
- Slop category: over-defensive error swallowing; boundary parsing hidden inside production logic.
- Behavior risk: truncated/corrupt JSON looks like an empty valid registry/state. Subsequent saves can normalize and persist that empty state, losing the diagnostic trail and potentially losing user-provided rights metadata.
- Existing coverage: no Python tests for corrupt `rights_registry.json` or `training_state.json`; C++ training test exercises only a fresh happy-path registry.
- PR-sized acceptance criteria: distinguish missing file from invalid JSON/read errors; surface invalid JSON to `/training/sources`, corpus build, and state endpoints without overwriting; add tests for missing file, corrupt JSON, non-object JSON, and valid registry.

3. Oversized service modules concentrate unrelated behavior and make boundary fixes risky.

- Path: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/service/server.py:225`, `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/service/training/trainer_job.py:210`, `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/service/adapters/stable_audio3_cuda.py:256`
- Evidence: pure LOC counts exceed the 250-line ceiling: `server.py` 612, `trainer_job.py` 319, `stable_audio3_cuda.py` 273. `server.py` owns descriptors, subprocess endpoints, HTTP parsing, job queues, training state, and route dispatch; `trainer_job.py` owns fake training, remote HTTP, archive creation, result normalization, artifact writes, and cleanup.
- Slop category: oversized modules; excessive complexity; raw dict contracts.
- Behavior risk: low-locality edits to error handling or typed boundaries can accidentally affect runtime service launch, real model fallback, and training jobs in the same file.
- Existing coverage: fake adapter smoke and cancel resilience pass, but there is no focused unit coverage around route parsing, training-state persistence, remote trainer payload variants, or CUDA adapter parameter parsing.
- PR-sized acceptance criteria: split by responsibility without changing public endpoints/model paths: e.g. `service/routes.py`, `service/jobs.py`, `service/training/state.py`, `service/training/remote_client.py`, `service/adapters/stable_audio3_cuda_params.py`; keep each source file under 250 pure LOC; rerun fake adapter/resilience tests plus at least one training-state regression test.

## MEDIUM

1. Remote trainer artifact normalization collapses malformed payloads into generic failures.

- Path: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/service/training/trainer_job.py:70`, `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/service/training/trainer_job.py:257`, `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/service/training/trainer_job.py:279`
- Evidence: `_extract_inline_json()` and `_normalize_result()` catch all parse failures and return `None`/`{}` at lines 70-91; unreadable artifact/manifest paths are caught and converted to `None` at lines 279-304; the caller later emits only "did not return artifact or manifest".
- Slop category: over-defensive broad catch; untyped remote boundary.
- Behavior risk: remote-service contract drift, invalid JSON, bad base64, or unreadable paths lose the actionable cause. Operators see a generic missing-artifact error instead of the real remote incompatibility.
- Existing coverage: `tests/test_training.cpp:23-64` forces fake backend only; no remote HTTP fake covers `artifact_b64`, `artifact_json_str`, bad JSON, bad local path, or status timeout.
- PR-sized acceptance criteria: introduce a typed remote result parser that returns specific errors for bad JSON/base64/path reads; add a stdlib local HTTP fake covering success and malformed result cases; preserve `MOSH_TRAINING_REMOTE_URL` behavior.

2. Hardware/UI verification scripts mix gate logic with artifact mutation.

- Path: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/scripts/verify-hardware/verify.py:27`, `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/scripts/verify-hardware/verify.py:346`, `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/scripts/macos-ui-automation-gate.py:1174`
- Evidence: `verify.py` writes to repo-local `verify-artifacts` at lines 27, 46-50, 435, 470 and deletes/copies project dirs in the portability check at lines 363-401. `macos-ui-automation-gate.py` is 1041 pure LOC and writes evidence under `_preserved_artifacts` at lines 1175-1201.
- Slop category: oversized modules; boundary side effects in verification helpers.
- Behavior risk: repeated verification can mix stale artifacts with fresh assertions, and destructive fixture cleanup is hard to review because it is embedded in long scenario functions.
- Existing coverage: these are themselves gates; no unit coverage for artifact-dir selection, cleanup target safety, or report generation.
- PR-sized acceptance criteria: add explicit `--artifacts-dir`/`MOSH_VERIFY_ARTIFACTS` support defaulting to the current paths; isolate cleanup helpers with path-safety checks; split scenario logic from evidence writing; keep current command defaults working.

3. Adapter request contracts are untyped raw dictionaries.

- Path: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/service/adapters/fake_adapter.py:41`, `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/service/adapters/stable_audio3_adapter.py:49`, `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/service/adapters/stable_audio3_cuda.py:256`, `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/service/adapters/transform_adapter.py:202`
- Evidence: each `render(...)` accepts `params: dict` and manually coerces values; AST scan reported raw `dict`/`Any` escapes across service/training boundaries.
- Slop category: parse-don't-validate violation; raw dict signatures; typed escape hatches.
- Behavior risk: invalid `seed`, `duration`, `colors`, `nl`, or transform target failures surface inconsistently across adapters and can shift from 400-style user errors to job-level 500-style errors.
- Existing coverage: fake adapter happy path and cancel resilience pass; no invalid-parameter matrix across fake, transform, MLX, and CUDA.
- PR-sized acceptance criteria: define a small shared `RenderParams` parser at the HTTP boundary that preserves existing JSON names; adapters receive a typed value or a normalized `TypedDict`; add parameter-edge tests for seed, duration, nl, colors, lab, target, and strength.

## LOW

1. Service test harness is useful but non-standard and partly implementation-coupled.

- Path: `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/service/prompt/concision_test.py:35`, `/Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/deslop-campaign-20260626/service/scripts/adapter_glue_test.py:24`
- Evidence: tests are executable scripts with global `fails` lists rather than pytest cases. `concision_test.py` asserts exact scrubbed phrases and first-seen casing at lines 35-67; `adapter_glue_test.py` requires real SA3/color availability at line 24.
- Slop category: brittle/implementation-mirroring tests; non-standard test shape.
- Behavior risk: valid refactors of prompt wording or optional model availability can break tests without a user-visible regression; these tests also do not compose naturally into focused test selection.
- Existing coverage: the scripts provide real value and are not deletion-only/tautological; the issue is harness shape and missing boundary coverage.
- PR-sized acceptance criteria: keep the scripts runnable for local gates, but wrap core assertions in pytest-compatible functions or `unittest` cases; avoid exact implementation phrase coupling where a contract-level assertion is enough; mark model-required checks with an explicit skip when unavailable.

## Blockers

- Fix malformed JSON handling for `/training/import-registry` so invalid requests cannot clear or rewrite the registry.
- Stop silently treating corrupt rights/training state as valid empty state; preserve diagnostics and prevent overwrite after parse failures.
- Create focused regression coverage for the above two behaviors before broad de-slop refactors.
