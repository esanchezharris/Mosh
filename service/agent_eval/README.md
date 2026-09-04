# Mosh coding-agent evaluation adapter

This directory adapts Mosh's existing evaluation conventions to repository coding agents. It does not replace `service/sft`, own private grader assets, or implement Duplicate Time.

## Boundary

The public side owns:

- hash-bound task manifests and public prompts;
- a fresh ordinary Git repository fetched at one exact commit;
- the agent command, declared budget, and explicit environment-name allowlist;
- prompt delivery over stdin;
- transcript, final binary patch, porcelain-v2 status, and artifact hashes;
- application of a preserved patch to a second clean clone for regrading;
- the structured grader-result contract and `infra_error` classification;
- generated JSON Schemas in `schema_v1.json`.

The private harness owns hidden tests, the reference patch, deliberately broken mutants, private rubric logic, and the grader-bundle manifest. Those assets must never enter the Mosh repository, any Git ref or object reachable from it, the candidate clone, or the attempt artifact directory. The candidate process must exit before private grading begins.

## Attempt execution

Create a JSON config:

```json
{
  "task": "/absolute/path/to/task.json",
  "source_repo": "/absolute/path/to/Mosh",
  "candidate_repo": "/new/path/candidate",
  "artifacts_dir": "/new/path/attempt-artifacts",
  "agent_command": ["codex", "exec", "--json", "-"],
  "passed_environment": ["CODEX_HOME"]
}
```

Then run:

```sh
uv run --python 3.12 --with pydantic --with typer python -m service.agent_eval.cli attempt \
  --config /absolute/path/attempt-config.json
```

The task prompt is sent on stdin. The default environment contains only basic process variables plus an isolated `HOME` and `TMPDIR`; additional environment variables are copied only when named explicitly. Values are never written to the attempt record.

The attempt directory contains:

- `attempt.json`
- `patch.diff`
- `status.porcelain-v2`
- `transcript.jsonl`

`completed` means the agent process exited zero. It does not mean the patch passed. `agent_error` means a normal nonzero agent exit, `timeout` means the public wall-time budget fired, and `infra_error` means the configured agent executable could not start.

## External regrade

The private harness writes a config containing the preserved attempt, its private manifest, and its grader command:

```json
{
  "attempt": "/absolute/path/attempt-artifacts/attempt.json",
  "source_repo": "/absolute/path/to/Mosh",
  "grader_repo": "/new/path/grader-clone",
  "artifacts_dir": "/new/path/grade-artifacts",
  "grader_command": ["python3", "/private/path/grader.py"],
  "grader_version": "duplicate-time-private-v1",
  "grader_manifest": "/private/path/private_manifest.json",
  "timeout_seconds": 1800,
  "passed_environment": []
}
```

Run:

```sh
uv run --python 3.12 --with pydantic --with typer python -m service.agent_eval.cli regrade \
  --config /absolute/path/regrade-config.json
```

Before starting the private grader, the adapter verifies every recorded attempt artifact hash, fetches the exact base into another independent Git directory, and applies the preserved binary patch. A nonzero grader exit, malformed result, or grader-version mismatch produces `infra_error` with no candidate score.

The grader must emit one JSON object matching `grade_payload` in `schema_v1.json`. Regrading reuses the original patch and transcript; it never reruns the coding agent.

## Duplicate Time status

`tasks/duplicate_time` is intentionally `draft`. Its prompt records the settled cross-layer invariants and the unresolved product semantics. The runner refuses draft tasks. Mark it `ready` only after every observable behavior is public, reproducible public checks exist, and the external grader has been calibrated against both a reference patch and plausible broken mutants.

## Targeted gate

```sh
python3 -m pytest service/agent_eval -q
python3 -m service.agent_eval.cli schema --output /tmp/agent-eval-schema.json
cmp service/agent_eval/schema_v1.json /tmp/agent-eval-schema.json
```
