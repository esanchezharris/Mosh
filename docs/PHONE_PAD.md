# Moshi phone pad

A no-install Safari controller for the Booth's recording loop. It is a **controller
only** — audio never leaves the Mac. The phone drives `loop_*` MoshOps commands over
the phone's own HTTP API; Tracktion records, plays, and stores everything locally,
exactly as if the producer had pressed the Booth's own buttons.

Scan the pairing QR (V3 → Phone) with the iPhone Camera app on the same Wi-Fi as the
Mac. It opens `/pad#token=<hex>` in Safari — the token rides in the URL **fragment**,
so it never reaches an access log, and the page keeps it only in memory (no
localStorage, cookies, or telemetry). Reloading the page requires scanning a fresh QR.

The pad reuses the DAWN companion visual design (dark, high-contrast, thumb-sized
targets) but is a distinct bundle from the `/web` DAWN Bridge / legacy Mosh-mode
companion — see [IPHONE_COMPANION.md](IPHONE_COMPANION.md).

## Where the pieces live

| Piece | Path |
|---|---|
| Pad UI (TypeScript, single-file Vite bundle) | `ui/src/phonepad/` |
| Wire contract (zod schemas, `/api/state` + `/api/action` shapes, token regex) | `ui/src/phonepad/src/contract.ts` |
| Native HTTP endpoint (engine-free; talks to MoshOps through an injected executor) | `src/remote/PhoneLoopEndpoint.cpp` |
| Native request/authority/receipt protocol | `src/remote/PhoneLoopProtocol.cpp` |
| Native recording-loop commands | `src/moshops/MoshOps.Loop.cpp` |
| Pairing token + `padUrl` construction | `src/remote/RemoteCompanionProtocol.cpp` |
| Server routing (`GET /pad`, `GET /api/state`, `POST /api/action`) | `src/remote/RemoteCompanionServer.cpp` |
| Desktop QR/pairing modal | `ui/src/v3/PhoneLauncher.tsx` |
| Booth (rewritten on the loop) | `ui/src/v3/BoothView.tsx` |

## The loop model

Recording lands on a **LEAD** track. Every pass ("contribution") the phone or the
Booth records goes to a paired **"`<Lead>` · Takes"** track (`loop_setup` creates and
arms it; the Booth never creates a track on its own — it prompts "Use \<track\> as
Lead" first). At any moment:

- **LEAD** holds whole, playable contributions: the current keeper plus older ones
  still marked as kept and audible.
- **Takes** holds the collapsed history — rejected passes and older unkept passes,
  muted so they never sound in a normal playback, but never deleted.
- The **listening start** (`listening.qn` / `listening.bar`) is where the next
  `Play All` or count-in begins; **entry** (`listening.entryQn`) is where the most
  recent pass's own recording began; **lead-in** (`listening.leadQn`) is how many
  quarter notes of run-up the *next* pass gets before its own entry point — setting
  it is a preference, not a move, and it does not touch the listening start or jog
  the playhead.

Keeping a pass moves it to LEAD, advances the listening start to
`max(previous listening start, that pass's end − lead-in)`, and restarts capture with
no count-in. Rejecting a pass ("Again") mutes it, moves it to Takes, and rewinds to
that pass's own entry point before restarting. Both are one undoable Tracktion
transaction; navigation and lead-in are non-undoable preferences (Tracktion's
`UndoManager` never sees them, matching the `set_count_in` posture elsewhere in
MoshOps).

**Undo after a landed pass is two steps, natively.** Tracktion inserts a recorded clip
through the Edit's own `UndoManager`, so `loopFinalizeCapture()` opens its own
`beginTxn ("loop_capture")` before stopping — otherwise the landing would join whatever
transaction the previous command left at the head of the stack and one ⌘Z would take
both. The consequence is deliberate: after a Stop or a Keep that landed a real take, the
first ⌘Z removes that pass and the second reverses the edit before it. When nothing
lands (a Stop during the count-in) the transaction is empty, and JUCE never pushes an
empty transaction, so the history is exactly as it was — this is the G14 empty-transaction
class, avoided deliberately. `--selftest-undo` covers the ordering. Note that
`ui/e2e/v3-record.spec.ts` asserts a ONE-step undo: that spec drives the dev mock, whose
undo is a whole-snapshot stack and whose `loop_stop` pushes no step. It is right about
the backend it runs against and is not a claim about the engine.

### The eleven `loop_*` commands and their undo posture

| Command | Posture | What it does |
|---|---|---|
| `loop_state` | read-only, never logged | Returns the full loop state (see `loopStateVar()` in `MoshOps.Loop.cpp`); also embedded as `snapshot().loop`. |
| `loop_setup {trackId?}` | one undoable txn for the track insert; the arm/disarm calls each log their own non-undoable line | Resolves or creates the LEAD/Takes pair, arms Takes, disarms LEAD, and — since the review-round fix — disarms a previously-paired Takes track it is re-pointing away from, so two lanes never capture the same input twice. |
| `loop_record` | lifecycle, no txn | Auto-runs `loop_setup` if needed, then starts capture from the listening start. |
| `loop_keep {targetId}` | one undoable txn (skipped on RESUME) | Promotes a pass to LEAD, marks it keeper, advances the listening start, restarts capture with no count-in. |
| `loop_again {targetId}` | one undoable txn (skipped when idempotent) | Marks a pass rejected, mutes it, moves it to Takes, rewinds to its entry point, restarts capture with no count-in. |
| `loop_hear {targetId}` | lifecycle, no txn | Finalizes an in-flight capture if needed, then plays from the target pass's entry point ("Review"). |
| `loop_play_all` | lifecycle, no txn | Finalizes if needed, then plays from the listening start — backing, keepers, and the latest stopped unkept pass. |
| `loop_stop` | lifecycle, stop-subset authority, never errors | Finalizes (preserving) if recording, else stops transport in place. |
| `loop_navigate {bar}` | non-undoable preference | Moves the listening start to a bar (1..1,000,000); stopped-only. |
| `loop_home` | non-undoable preference | Moves the listening start to the project beginning; stopped-only. |
| `loop_lead_in {leadQn}` | non-undoable preference | Sets the run-up (0..256 quarter notes) for the *next* pass; leaves the listening start untouched. |

`loop_keep` / `loop_again` report `applied:true` once the clip edit itself has
committed, with a separate `data.restarted` bool and a `detail` that says plainly
when the clip landed but the transport could not roll into the next take (headless,
or no audio device) — a committed keep is never reported as rejected.

Every one of these eleven commands is registered UI-only (a performance gesture, not
an agent move), unguarded in the multiplayer lock manager, and classified in
`TransactionSafe.h` per the table above.

**A command needs eight registrations, not one.** The count has crept up as the surface
grew — three, then five (`docs/V3-PARITY-BRIEF-2026-09-17.md:16,127`), then seven — so
here is the list itself, which is what a future session should check against rather than
a number:

| # | Where | What a miss looks like |
|---|---|---|
| 1 | dispatch in `src/moshops/MoshOps*.cpp` | the command does not exist |
| 2 | `UI_ONLY_COMMANDS` in `ui/src/agent/commandClassification.ts` | unclassified |
| 3 | absent from `AGENT_COMMAND_MAP` (`ui/src/agent/commands.ts`) | a model can fire a performance gesture |
| 4 | a `TransactionSafe.h` classification | fails closed inside an agent transaction |
| 5 | `LockManager.cpp`'s `unguarded` set | inherits `SessionGlobal` by omission and contends in multiplayer |
| 6 | the lock-scope golden ledger, `tests/test_multiplayer_lock_manager.cpp` | the scope decision is unpinned |
| 7 | a case in `ui/src/bridge.mock.ts` | dev and e2e drive nothing |
| 8 | `readsDuringTxn` + `MOCK_TXN_READS`, for a read that must survive an open transaction | the pad freezes on stale state for the length of a skill run |

Only `loop_state` needs #8; the other ten stop at #7. All eight are pinned together by
`ui/src/agent/txnSafeRegistry.test.ts` ("Moshi loop commands are registered everywhere"),
except #6, which is asserted natively in its own Catch2 file.

## Build

```sh
cd ui
npm run build:phonepad
```

This runs `tsc -p src/phonepad/tsconfig.json` then a Vite single-file build
(`vite.phonepad.config.ts`) into `ui/phonepad-dist/index.html` — one self-contained
HTML file, no external script/link tags, no CDN or package fetches at runtime.
`cmake/BuildCompanion.cmake` stages that file into the app bundle as
`Contents/Resources/companion/pad.html` (after the existing `/web` companion
staging, so the `rm -rf` there cannot delete it), and `RemoteCompanionServer` serves
it as `text/html` at the public `GET /pad`. An unstaged build serves a deliberately
inert fallback page — no script, no token.

**Freshness check.** Because the pad is a separate bundle from both the main UI and
the `/web` companion, a stale `pad.html` staged into a build is a silent trap (the
same class of bug as `cmake --build` exiting 0 while Vite failed — see the
`cmake-build-returns-zero-when-vite-fails` project note). Before trusting a build,
confirm the staged file is newer than its source and actually contains the pad:

```sh
find Contents/Resources/companion/pad.html -newer ui/src/phonepad/src/view.ts
grep -c 'MOSHI · LOCAL' Contents/Resources/companion/pad.html   # expect 1
```

## Tests and their boundaries

- **`npm test`** (`vitest run`, from `ui/`) — the pad's pure logic lives in
  `ui/src/phonepad/tests/policy.test.ts` and is picked up automatically by the root
  `vitest.config.ts`'s `include: ["src/**/*.test.ts"]`; no separate invocation is
  needed to include it in a normal `npm test` run.
- **`npm run test:e2e`** (`playwright test`, from `ui/`) runs every configured
  project, including two the pad owns specifically: `chromium` (the React WebView
  app, unaffected by this work) and `phonepad` — a `375×812` viewport project that
  depends on a `phonepad-build` setup project (`build.setup.ts` runs
  `npm run build:phonepad` once), then serves the built bundle from its own
  ephemeral loopback server and stubs `/api/*` with `page.route`; it never touches
  the React app's dev server. Run just the pad's specs with
  `npm run test:phonepad` (`playwright test --project phonepad`).
- **MoshTests `[remote]` `[phoneloop]`** (Catch2 tags; note the OR-vs-AND trap —
  `"[remote],[phoneloop]"` is the OR form Catch2 wants, two separate tag arguments
  is an AND that matches nothing):
  ```sh
  ./build/tests/MoshTests_artefacts/Debug/MoshTests "[remote],[phoneloop]"
  ```
  Covers the pairing token and `padUrl` shape, server routing/auth for `/pad` and
  `/api/*`, the request/authority/receipt protocol, and the endpoint's translation
  of MoshOps results into phone-facing JSON — all against a fake executor, headless.
- **`--selftest=all`**, section `"MOSHI-LOOP: phone loop model (headless)"` — the
  loop commands exercised end to end against a real (headless) Tracktion edit: setup
  idempotency, navigation, refusals with zero mutation, adoption of hand-placed
  clips, keep/again state transitions and JSONL undo posture, stale-authority
  refusal, and save/reload round-tripping the pairing and every contribution byte
  for byte.
- **`--selftest-undo`** — the loop's one genuinely undoable path end to end: setup →
  a pass on Takes → `loop_keep` moves it to LEAD → one undo puts it back → redo
  returns it.
- **Manual fixture**: `npm run phonepad:fixture` (from `ui/`) starts an isolated
  loopback server that acknowledges actions and echoes the selected target without
  touching Mosh, an audio device, or any paid endpoint — useful for eyeballing the
  pad's UI without a running Mac session. Open its reported `/pad` URL with
  `#token=` plus 64 lowercase `a` characters (a synthetic test token).

## Owner acceptance boundary

Everything above is automated and headless. It proves the pairing UI, the URL
shape, the wire protocol, the headless loop model (state transitions, undo, save/
reload), and recovery paths in isolation. It proves none of the following, which
remain owner acceptance:

- **Nothing has been proven with real audio yet.** Every transport path in the
  native tests is exercised with `applied:false` headless (no audio device); count-in
  bypass, take landing, the "only the newest unkept pass is audible" mute pass, and
  audible playback all need an owner run with a real microphone and interface before
  anyone can claim the loop works end to end.
- **Physical iPhone scan, same-Wi-Fi reachability, audibility of Play All / Review,
  and take placement by ear are owner acceptance.** No gate, screenshot, or headless
  test can close these — see `docs/VERIFICATION.md` rows `PHONE-pair`, `PHONE-loop`,
  and `PHONE-recover`.
- **Phone presence is now the engine's verdict** (fix wave, landed). `loopStateVar()`
  emits `phoneConnected`, and `ui/src/v3/phoneStatus.ts` reads it rather than comparing
  `phoneSeenMs` to `Date.now()` — a comparison that could never be true, because
  `phoneSeenMs` is `Time::getMillisecondCounterHiRes()` (ms since the Mac booted) and not
  wall-clock epoch ms. The stamp remains in the payload as a diagnostic only; nothing may
  decide on it. `--selftest` asserts the field is false cold, true after a
  `loop_state {phonePoll:true}`, and true through `snapshot().loop` inside the same
  3-second window. **Still owner-gated:** that a real iPhone's polling lights the line in
  the packaged app remains a physical check — no headless test reaches a phone.
