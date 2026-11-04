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
It arrives in the snapshot as a machine field (not a session field, not undoable).

*As built (slice 3):* the snapshot carries only what is on disk (`on`/`off`, the pack, `sa3`,
`pythonSource`). What the installer is doing (`installing`, `failed`, `cancelled` and so on,
per-step status, error, log tail, size) is the installer's own status: it is returned by
the `ai_tools_*` bridge calls and pushed as the `ai_tools` event. When a job ends, the UI
re-reads the snapshot.

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
- **Size, stated before the click:** about **850 MB**. Measured 2026-11-03 with uv 0.13.1 into an
  empty home on the owner's Mac: Python 76 MB, beatbox 308 MB, transcription 466 MB, after the
  cache is deleted. The install peaks around 1.3 GB, because uv's cache adds 436 MB until the
  end, so the installer refuses to start below 1.5 GB free. It took about 80 seconds on the
  owner's connection.
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
     - Slice 3's installer writes `service.env` there, exporting `MOSH_MANAGED_PYTHON`. That
       is run.sh's last fallback, after an explicit interpreter and the SA3 venv.
     - A caller's explicit `MOSH_SERVICE_PYTHON` still wins.
   - **Tests.** `service/scripts/ai_tools_scripts_test.py` makes 27 hermetic checks: 18 fail
     against main's scripts, and the rest are controls.
   - **Owner check.** Both scripts re-run with no flags on the owner's Mac: the venvs
     validated, nothing installed, and the pointers matched the canonical checkout's.
3. **Slice 3 — bundled uv and the install runner.** *Built on `claude/ai-tools-install`.*
   - **uv:** `scripts/fetch-uv.sh` stages uv **0.13.1** (sha256 pinned per arch) into
     `resources/uv/`. CMake copies it to `Contents/Helpers/uv` when present, and
     `run-mosh.sh build_app` runs the fetch. BOM row and `docs/licenses/uv.txt` (MIT).
     A build without it reports "This build of Mosh can't add AI tools."
   - **Installer** (`src/generative/AiToolsInstaller`):
     - Steps: `uv python install 3.11 --install-dir ~/Library/Mosh/python --no-bin`, then
       both setup scripts with `--python` and `--env-dir`.
     - Each step runs in its own process group, with only the uv folder and the base system
       on PATH. Cancel signals the whole group.
     - A failed or cancelled step deletes the folder it created. `installed.json` lists what
       the installer created, and remove deletes only those folders, and only at their
       expected paths.
     - The uv cache is deleted when a job ends.
     - The installer refuses to start below 1.5 GB free.
   - **Probe and run.sh:** `pythonSource: "managed"` when `installed.json`'s interpreter
     exists. `run.sh` uses `MOSH_MANAGED_PYTHON` after an explicit interpreter and the SA3
     venv.
   - **Bridge:** `ai_tools_status`, `ai_tools_install`, `ai_tools_cancel` and
     `ai_tools_remove`, plus the `ai_tools` event. In `ui/src/bridge.ts`, a mock installer
     walks the same steps and supports `?mockFault=ai-install-fail`.
   - **Tests:**
     - `tests/test_ai_tools_installer.cpp` drives the real setup scripts against a fake uv:
       - success;
       - failure at each step;
       - retry without a second download;
       - cancel in two steps, killing a grandchild;
       - remove keeps an owner's venv and ignores a tampered manifest;
       - the free-space refusal.
     - The process-group kill and the remove guard were each broken on purpose and caught.
     - A hidden `[.ai-tools-real]` case ran the real uv once (72 s, then removed).
     - `ui/src/aiTools.install.test.ts` covers parsing, the mock installer and the store
       refresh.
   - **Not covered:** a fresh macOS user without the Command Line Tools. That is the
     `AITOOLS-fresh` and `AITOOLS-install` owner rows.
4. **Slice 4 — the Start page card and Settings row.** *Built on `claude/ai-tools-card`.*
   - **One card** (`ui/src/v3/AiToolsCard.tsx`), met three ways:
     - the Start page's Ready step: a quiet line under Go to the Booth ("Add AI tools
       (optional): beatbox into a beat, and more. About 0.8 GB.") that opens the card in place;
     - the dock's "That needs AI tools" reply: an **Add AI tools** button that opens the card
       as a dialog;
     - Settings → **AI tools**: status, size, Install / Cancel / Remove and the last error.
   - **What the card offers** comes from `ui/src/v3/aiToolsSetup.ts`, which reads the snapshot
     (what is on disk) and the installer status (what it is doing) together:
     - tools set up outside Mosh (the owner's venvs, `pythonSource` not `managed`) show "On (set
       up outside Mosh)" with no Install or Remove;
     - a build that can't add them offers nothing: no Start page line, no dock button;
     - a snapshot without `aiTools` (an older backend) reads as present.
   - **Tests:** `aiToolsSetup.test.ts` (the view), `AiToolsCard.test.ts` (Settings install,
     cancel and remove; the dock dialog; the failure copy and Try again), StartPage tests (the
     offer never disables Go to the Booth and sends no session command), the dock test (the
     reply carries the button), and `e2e/v3-ai-tools.spec.ts` (`?mockFault=ai-install-fail`
     from the Start page, and dock → install → Beatbox shown → Settings → Remove → hidden).
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
