# Optional AI tools — brief, 2026-11-02

## 1. Why

Friends who only want to record themselves should get a Mosh that never touches Python, never
downloads a model, and never shows a button that fails with "Local generative service
unavailable". People who want the generative extras opt in from the setup flow.

## 2. What is true today (measured 2026-11-02 on main `8e739b41`)

- **Nothing generative loads at launch.** The installed app ran for a minute on the Start page
  with no child processes and no listening ports. The generative service spawns only inside a
  command that calls `GenerativeJobManager::ensureServiceRunning()`. The local brain
  (`LocalBrainManager`) is off unless `~/.config/mosh/owner-runtime.json` enables it, and
  `autoStart` defaults false.
- **The app ships no models.** `Mosh.app` is 49 MB. `Contents/Resources/service` is 8 MB of
  Python source. The base service and beat recipes are stdlib-only. Each heavier feature has its
  own venv made by a setup script (`service/<feature>/setup-<feature>.sh`, written to
  `~/Library/Mosh/venvs/<feature>`, 0.3–0.6 GB each). SA3's weights are licensed, and
  `setup-sa3.sh` refuses to download them.
- **The friend problem is visibility, not cost.** On a Mac without the owner's setup, these V3
  surfaces still show:
  - **Re-Imagine:** the inspector's "Open Re-Imagine". Opening it runs `list_colors` and
    `list_loras`, which spawn the service.
  - **LoRA:** the TopBar "LoRA" button, its modal and the LoRA Lab. Opening any of them spawns
    the service.
  - **Beatbox:** "Beatbox → beat" in the Files browser (`sketch_beatbox`). Without the sketch
    venv it fails with `sketch_unavailable (run service/sketch/setup-sketch.sh)`.
  - **Moshi dock:** phrases that hit the deterministic fast paths for beat recipes
    (`generate_beat_recipe`) and section re-imagine (`create_render_layer` + `render_layer`).
- **Spawning the service on a fresh Mac is itself a hazard.** The service runs `python3`. On a
  Mac without the Command Line Tools, `/usr/bin/python3` is the stub that pops macOS's "install
  developer tools" dialog. Today, opening Re-Imagine or the LoRA modal would do that to a friend.
- **The Start page and the Booth use no generative commands.** Neither does the Start page's
  "No beat? Use a drum beat" (`add_drum_pattern`).

## 3. Owner decisions (2026-11-02)

| Question | Decision |
|---|---|
| What "Add AI tools" installs | **Small tools only.** Free open-source packages. Re-Imagine (SA3) and LoRA training stay hidden for friends, because Mosh can't download SA3's licensed weights for them. |
| Moshi chat | **Stays on for everyone.** It's a cloud call with no GPU or disk cost. Only the dock's local-generation actions route to the AI tools setup. |

## 4. Goals, non-goals, anti-goals

**Goals**
- Fresh install: zero Python spawns, zero downloads and zero generative buttons until the friend
  opts in.
- One clear opt-in: "Add AI tools (optional)", with its size stated up front, a progress line,
  cancel, and a working result.
- The owner's Mac keeps everything: an already-installed machine shows the tools as on.

**Non-goals**
- Installing SA3, LoRA training, transform (RAVE), skeleton, whisper or the local brain for
  friends.
- Changing how the generative service itself works.

**Anti-goals**
- The macOS "install developer tools" dialog appearing for a friend, ever.
- Writing into the signed app bundle. The setup scripts currently write `.<feature>.env` next to
  themselves, which in an installed app is inside `Mosh.app`.
- An install that half-finishes and leaves buttons that fail.

## 5. Design

### 5.1 One availability signal: `aiTools`

The native side reports `aiTools` without spawning anything:
- `state`: `off` | `installing` | `on` | `failed`
- `pack`: per-tool status, `{ python, sketch, transcribe }`, each `missing` | `ok`
- `sizeEstimateMb`, `installedMb`, `error`
- `sa3`: `true` only when the owner-style SA3 setup is present

The status comes from checking files on disk only: the managed Python exists, each venv's
python exists, and the env pointers exist. It never runs `python3` and never calls `/health`.
It arrives in the snapshot as a machine field (not a session field, not undoable) and as an
`ai_tools` event while an install runs.

**`state` is `on` when** `python` and `sketch` are `ok`. Transcription only feeds the agent, so
a missing `transcribe` makes the tools partial, not off.

**Owner and migration:** a machine whose venvs already exist under `~/Library/Mosh/venvs` reports
`on` with no action. The owner's Mac therefore keeps every surface.

### 5.2 Gating the UI on `aiTools`

| Surface | `aiTools` off | `aiTools` on |
|---|---|---|
| "Beatbox → beat" (Files) | Hidden | Shown |
| Dock fast path: beat recipe | Moshi replies "That needs AI tools. Add them?" with a button that opens the setup. Nothing runs. | Runs |
| Re-Imagine (inspector), dock section re-imagine, `reimagine_clip` skill | Hidden unless `sa3` | Hidden unless `sa3` |
| TopBar "LoRA", LoRA Lab | Hidden unless `sa3` (training needs the SA3 stack) | Hidden unless `sa3` |
| Agent catalog (free-form Moshi) | The generative commands (`sketch_beatbox`, `generate_beat_recipe`, `transcribe_clip`, `compile_render`, `render_layer`, lyric generation, `build_skeleton_from_clip`) are left out of the catalog the brain sees. | Included, per pack |
| Moshi chat itself | On | On |

Gating covers more than the buttons:
- **No usable Python.** Native refuses inside `ensureServiceRunning()` itself, in
  `GenerativeJobManager` and `TrainingJobManager`, before any process starts. Every service
  command then fails with "AI tools aren't installed on this Mac." An already-healthy service
  (the owner's shared helper) is still adopted.
- **`sketch_beatbox` without the sketch venv.** It refuses before the spawn.
- **The agent path.** `runAgentBatch` refuses a plan that names an unavailable command
  **whole**, before anything runs. Half a re-imagine (a layer with no render) is worse than
  none.

Together these catch stale UI, the agent and scripts.

### 5.3 The install

- **Python without the developer tools.** Bundle `uv` (single static binary, about 35 MB,
  MIT/Apache-2.0) in `Contents/Resources/bin/uv`. Install a uv-managed CPython 3.11 under
  `~/Library/Mosh/python`. The service and the setup scripts use that interpreter. They never
  run a bare `python3` when it is present.
- **Where things go:**
  - venvs in `~/Library/Mosh/venvs/{sketch,transcribe}`, as today;
  - env pointers in `~/Library/Application Support/Mosh/ai-tools/*.env`, never next to the
    scripts.
  - `run.sh` sources that directory as well as the old locations, so the owner's setup keeps
    working.
- **Runner:** a native background job runs the bundled setup scripts in order: Python, then
  sketch, then transcribe. Each script takes `--python <managed python>` and `--env-dir <dir>`.
  - **Progress:** step name, then done or failed, streamed as `ai_tools` events.
  - **Cancel:** kills the running script. A half-made venv is removed, so `venv_ok` stays the
    only proof that a tool installed.
  - **Errors:** shown verbatim under friend copy, e.g. "Couldn't download the beatbox tool. Check
    your internet and try again."
- **Size, stated before the click:** Python plus beatbox plus transcription is about 0.8 GB
  (sketch ≈ 0.3 GB, transcribe ≈ 0.45 GB, Python ≈ 0.05 GB). Measure this on a clean account in
  slice 3 and put the real number in the copy.
- **Remove:** "Remove AI tools" deletes the managed Python, the two venvs and the env dir, then
  flips the state to `off`. It is never automatic. It never touches the owner's other venvs
  (`teardown`, `tunejury` and the rest).
- **Network:** downloads go only to PyPI and uv's Python mirror (python-build-standalone on
  GitHub). The copy says so.

### 5.4 Where the friend meets it

- **Start page.** The Ready step gains a quiet secondary card under "Go to the Booth": "Add AI
  tools (optional): beatbox into a beat, and more. About 0.8 GB." It is never a gate, and the
  Booth path stays one click. Choosing it opens the setup card with size, what it adds, Install
  and Not now. The install runs in the background, so the friend can go record while it
  downloads.
- **Settings.** An "AI tools" row with on/off status, Install / Remove, sizes and the last
  error. This row is visible in V3, unlike `startOnLaunch`.
- **The dock's "That needs AI tools" reply** opens the same card.

## 6. Order of work (each slice a PR; `gh pr list` for overlap first)

1. **Slice 1 — status and refusal (native and UI, nothing installs).** *Built on
   `claude/ai-tools-optional`.*
   - `AiToolsStatus` probe, the snapshot field and the event.
   - The pre-spawn refusal in `ensureServiceRunning` callers.
   - UI gating per §5.2 and the dock reply.
   - Tests: a native selftest that asserts the refusal fires before any spawn, with a fake home
     where no venvs exist. vitest for the gating. An e2e with the mock reporting `off` and `on`.
   - Gates: cheap + native.
   - This slice alone fixes the friend hazard; the remaining slices add the opt-in.
2. **Slice 2 — scripts made relocatable.** *Built on `claude/ai-tools-scripts`.*
   `service/server.py` already falls back to `~/Library/Mosh/venvs/<feature>/bin/python`
   when no `.env` pointer exists, so this slice is small:
   - **Setup scripts.** `setup-sketch.sh` and `setup-transcribe.sh` take two flags:
     - `--python <path>` builds the venv from that interpreter and never searches PATH. A
       missing interpreter fails before anything runs.
     - `--env-dir <dir>` writes `<name>.env` there instead of next to the script.
     - Unknown arguments now fail instead of being ignored.
   - **`run.sh`** sources every `*.env` in `~/Library/Application Support/Mosh/ai-tools`
     (`MOSH_AI_TOOLS_ENV_DIR` overrides it), after the in-tree files.
     - Slice 3's runner can write `service.env` there, exporting `MOSH_SERVICE_PYTHON` as
       the managed interpreter.
     - A caller's explicit `MOSH_SERVICE_PYTHON` still wins.
   - **Tests.** `service/scripts/ai_tools_scripts_test.py` makes 27 hermetic checks: 18 fail
     against main's scripts, and the rest are controls.
   - **Owner check.** Both scripts re-run with no flags on the owner's Mac: the venvs
     validated, nothing installed, and the pointers matched the canonical checkout's.
3. **Slice 3 — bundled uv and the install runner.**
   - Bundle `uv` and add the `install_ai_tools` / `cancel_ai_tools` / `remove_ai_tools` bridge
     calls (machine state, `undoable:false`).
   - Measure the real size on a fresh macOS user account.
   - Tests: a fake-network runner test (a script stub that fails at each step proves cleanup).
     A real install on a clean user account is an owner row.
4. **Slice 4 — the Start page card and Settings row.** Tests: StartPage component tests (the
   card never blocks Go to the Booth); e2e with `?mockFault=ai-install-fail`.
5. **Slice 5 — docs.** This brief's status, `docs/VERIFICATION.md` rows, and the tester
   quickstart line.

## 7. Verification

**Automated:** vitest; Playwright `v3-` plus the full suite in slice 4; native `--selftest=all`
×3 and `--selftest-undo`; `gate.sh native` on slices 1 and 3.

**Owner rows in `docs/VERIFICATION.md`:**

| Row | Check |
|---|---|
| AITOOLS-fresh | New macOS user without the Command Line Tools: launch, record, open the Studio, click around. No developer-tools dialog, no python process, no "unavailable" error. |
| AITOOLS-install | Same user: Add AI tools from the Start page. It installs within the stated size, then Beatbox → beat works on a real beatbox take. |
| AITOOLS-remove | Remove AI tools: the disk space comes back and the buttons hide. |
| AITOOLS-owner | Your Mac after the update: Re-Imagine, LoRA Lab and Beatbox all still show and work. |

## 8. Risks and calls I made (veto at review)

- **My call:** whisper, skeleton and transform stay out of the friend pack. Nothing in V3
  reaches them except the agent, and they add 0.6 GB or more each.
- **My call:** the install runs through bridge calls, not MoshOps commands. It is machine state
  like the microphone permission, never a session edit.
- **My call:** "on" means Python + sketch. A missing transcription tool only trims the agent
  catalog.
- **Risk:** uv's managed Python is a download from GitHub. Corporate networks or offline Macs
  fail the install; the error copy must say so.
- **Risk:** gating by `sa3` hides Re-Imagine from anyone without the owner-style setup. That is
  intended for friends, but a future SA3 opt-in needs its own brief (license acceptance per
  user).
- **Risk:** the agent-catalog trim changes what the brain can plan. Check the dock's free-form
  asks still answer sensibly with tools off.
