# brain_shim — `claude -p` as an OpenAI-compatible endpoint

W1.3 of the produce-lane overnight plan (docs/POSTMORTEM-2026-09.md's approved
direction). Tonight's PRIMARY brain is the Claude Code CLI itself, run via
`claude -p` under the owner's subscription — **dev-time iteration, not a
shipping config**. Mosh's `BrainProxy` already speaks the OpenAI
chat-completions shape to any `openai`-compatible base URL
(`src/brain/BrainProxy.cpp`); `claude_cli_shim.py` is that base URL: it
translates one `POST /v1/chat/completions` into one `claude -p` subprocess
call and translates the reply back.

Stdlib only (`http.server`, `subprocess`, `json`, `re`, `threading`) — no
`pydantic`/`flask`/`requests` — because the repo gate's `py_tests` step
auto-discovers and runs every `service/**/*_test.py` under the *system*
Python (pyenv 3.12 here; must also run cleanly on 3.11), and
`run-mosh.sh bundle_service` only copies named service dirs, so this one never
ships in a built app.

## Run it

```sh
bash service/brain_shim/run-shim.sh &
curl 127.0.0.1:8788/health
```

Point the app at it:

```sh
OPENAI_BASE_URL=http://127.0.0.1:8788/v1 OPENAI_API_KEY=shim OPENAI_MODEL=sonnet ./run-mosh.sh gui
```

`run-shim.sh` writes its own PID to `~/Library/Mosh/brain-shim/shim.pid`
*before* it `exec`s into `claude_cli_shim.py` (exec keeps the PID), so
`kill "$(cat ~/Library/Mosh/brain-shim/shim.pid)"` stops it cleanly. Logs go
to `~/Library/Mosh/logs/brain-shim.log`.

## Endpoints

- `GET /health` → `{"ok": true, "claude_bin": ..., "port": ...}`
- `GET /v1/models` → a minimal OpenAI-shaped model list (`sonnet`/`opus`/`haiku`)
- `POST /v1/chat/completions` → the one real endpoint. `system` messages join
  into `claude -p`'s `--system-prompt`; the rest render as a role-labelled
  transcript passed as the prompt. `response_format: {"type":"json_object"}`
  appends a no-fences instruction to that prompt *and* strips any
  ` ```json … ``` ` fence the model still wraps around its reply (observed:
  Haiku does this even when told not to).

Calls are serialized (one `claude -p` child at a time) — this is single-owner
dev tooling, not a production multi-tenant server.

## Errors

An upstream failure maps to an HTTP status BrainProxy's provider fallback
already understands (429 or 5xx triggers the next provider in
`PRODUCE_CLOUD_PROVIDERS`; anything else is a flat error):

- `claude`'s own `api_error_status`, when it is already 429 or ≥500
- otherwise 429 if the result text smells like a rate limit / capacity issue
  (`rate limit`, `usage limit`, `overloaded`, `529`)
- otherwise 502 (generic upstream error)
- 504 on a local `subprocess` timeout (`MOSH_CLAUDE_SHIM_TIMEOUT_S`, default 170s)

## Env knobs

| Var | Default | Meaning |
|---|---|---|
| `MOSH_CLAUDE_BIN` | `~/.local/bin/claude` (else `claude` on `PATH`) | the CLI binary |
| `MOSH_CLAUDE_SHIM_PORT` | `8788` | HTTP port |
| `MOSH_CLAUDE_SHIM_TIMEOUT_S` | `170` | per-call subprocess timeout |
| `MOSH_CLAUDE_SHIM_EFFORT` | unset | if set, passed through as `--effort <value>` |
| `MOSH_CLAUDE_SHIM_LEDGER` | `~/Library/Mosh/logs/brain-shim.jsonl` | call ledger (sizes/tokens/cost/ms only — never prompt or response text) |
| `MOSH_CLAUDE_SHIM_CWD` | `~/Library/Mosh/brain-shim/cwd` | empty scratch cwd for the `claude` child |

Never `--bare`: that mode forces `ANTHROPIC_API_KEY` auth (bills the API key
instead of the subscription). `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` are
stripped from the child's env so a `claude -p` launched from inside a Claude
Code session behaves like a plain one-shot call, not a nested session.

## Tests

```sh
python3 service/brain_shim/claude_cli_shim_test.py   # exit 0 on pass
python3 -m pytest service/brain_shim/claude_cli_shim_test.py
```

Fully hermetic: a tiny fake `claude` script is written to a temp dir and
pointed at via `MOSH_CLAUDE_BIN` — no network, and the real `claude` binary is
never invoked.
