# Execution brief — the V3 parity gate, and what has to be true before V3 is the default shell

Owner ask (chat, 2026-09-17): "can we make v3 our default? are there reasons not to? how can we make
those reasons go away?" This brief answers the third question as work. It follows the owner's
stated direction of the same day — presets people can use, easy drop-in / generated beats and
vocal recording, multiplayer that is fun and smooth, and a native plugin suite so the app is
viable without third-party plugins — and the rule recorded when V3 was first wired in
(2026-07-13): *flip the default at the parity gate; do not ship an incomplete default.*

| Field | Value |
|---|---|
| Baseline | `origin/main` @ `4345bbe7c1815a82c803b6013887f1b283ab777d` (PR #702 merged: direct SA3 + V3 workspace repair) |
| Kind | Gate definition plus a sequenced task list. Task 1 is bounded and can start now; the flip is the **last** task and is gated on §5 |
| Default today | `ui/src/settings/schema.ts` → `uiShell` default `"protools"` (since 2026-08-09). V3 is selectable as "Mosh (v3)"; an existing explicit choice is always preserved |
| Allowed writes | `ui/src/v3/**`, new `ui/e2e/v3-*.spec.ts`, the five v2-named gate sites in §2, `docs/` |
| **Forbidden** | redesigning V3's look (DESIGN.md §1 stands), touching other shells' behaviour, any new engine command without the eight registrations (enumerated in docs/PHONE_PAD.md), any claim of audibility or feel from a gate |
| Owner input needed | §5 acceptance pass on a real session; nothing before that |

**Why V3 is not the default today (evidence, not opinion).**

- **Coverage.** V3 has 8 browser tests in 3 specs; the Pro Tools shell has 46 across ~20 and the
  conformance/replay lanes drive classic and Pro Tools. `docs/V3-WORKSPACE-SCOPE-2026-09-17.md`
  calls itself "a workspace reachability repair, not a full DAW completion claim."
- **Named gaps** (PR #702's own limits): simplified timeline scaling/gestures, listing-only
  MIDI-file browser import, narrow plugin catalog, advanced routing, physical input recording,
  some fixed-lime accents that ignore the colorway.
- **Direction gaps** (this brief's census, `git grep` over `ui/src`): V3 mounts **no multiplayer
  UI** (v2 has `MultiplayerLauncher` + the shared `MultiplayerPanel`), **no beat drop-in or
  generation surface** (the shared `DrumSequencer` / `DrumPads` / `Rack` live under `ui/src/ui`
  and are mounted by classic and Live), and **no preset picker**. Those three are the owner's
  stated core loop.
- **Code that gates on v2 by name.** Five sites check `"v2"` literally; anything behind them may
  not engage on V3 (§2).

---

## 1. The gate — one row per capability, with the evidence that closes it

A row is closed only by the listed surface. A screenshot, a green gate, or a reviewer's reading
closes nothing on its own. "Port from" names the existing spec or component to mirror, so no row
is built from scratch.

| # | Capability (new-direction core loop) | V3 today | Closes with | Port from |
|---|---|---|---|---|
| 1 | Empty session explains the starting actions; add audio/MIDI track; import audio | done (#702) | `v3-workspace.spec` | — |
| 2 | **Drop in a beat**: load a drum kit, place a pattern, audition pads | absent | new `v3-beat.spec` (kit loads, pattern lands on a track, undo removes it) | `ui/src/ui/DrumPads.tsx`, `DrumSequencer.tsx`; `live/` mounts them |
| 3 | **Generate a beat** from the Moshi dock (typed ask → clips on tracks → undo as one unit) | dock exists; not exercised | `v3-beat.spec` second half, through the mock loop | `agent-loop.spec` |
| 4 | **Record a vocal**: arm, count-in, Booth, take navigation, keep | done — the Booth is now the recording loop itself (Put Me In / Keep / Again / Review / Play All / Stop, a contributions list, go-to-bar, lead-in) plus phone pairing (`docs/PHONE_PAD.md`) | `v3-record.spec` (loop story), `v3-phone.spec`, `PhoneLauncher.test`, `loopPolicy.test`, and the native `--selftest` `MOSHI-LOOP` section; audibility stays owner-only | `protools-shell` "pre-roll and Punch" + Booth rows in `live-shell.spec` |
| 5 | MIDI edit in the shared PianoRoll, note undo | done (#702) | `v3-workspace.spec` + one added note-edit assertion | `protools-midi-editor.spec` |
| 6 | **Mix**: level, pan, mute/solo, undo; sends to a return bus | Mixer done; sends = "advanced routing" gap | `v3-mix.spec`: strip edits + one send to an aux with readback | `protools-mix-window.spec`, "Sends route a track…" |
| 7 | **Plugins and presets**: browse the native suite, insert, open editor, pick a preset | `PluginDock` (narrow catalog); no presets | `v3-plugins.spec`: insert a builtin, open editor, apply a preset, undo. Native-suite viability is a separate engine question (the builtin compressor does not compress — see `docs/pivot-2026-09`) | `ui/src/ui/Rack.tsx` presets; `v2/PluginBrowser` |
| 8 | Undo/redo/history flyout | done | `v3-shell.spec` | — |
| 9 | Save, reopen, export mixdown | done (#702, native Release) | `v3-reimagine.spec` File row + native selftest | — |
| 10 | **Multiplayer**: create a room, join by code, see a peer's edit, locks respected | absent | `v3-multiplayer.spec` against the mock peer (`mp_*` mock cases exist) + the owner two-Mac row in `docs/VERIFICATION.md` | `v2/MultiplayerLauncher.tsx`, shared `ui/MultiplayerPanel.tsx` |
| 11 | Timeline zoom and drag gestures (move/trim/split by pointer) | simplified | `v3-timeline.spec`: zoom keeps focus; pointer trim/split go through the seam | `protools-shell` "Zoom controls…", `ClipView.tsx` math |
| 12 | MIDI-file import lands a clip (not a listing) | listing only | one row in `v3-workspace.spec` | classic browser import |
| 13 | Colorways: no fixed-lime accents | partial | `v3-shell.spec` colorway row extended to the accents #702 names | — |
| 14 | Recording-safe dock, Escape/focus, keyboard Settings | done (#702) | existing | — |

Rows 2, 3, 4, 7 and 10 are the owner's direction; they come first (§3).

## 2. Task 1 — the v2-named gate audit (bounded; start now)

Each site below is a literal `"v2"` check. For each, decide **keep v2-only** (write the reason
in the code) or **broaden to "modern shell" = v2 | v3**, and pin the decision with a unit test
that boots V3 and asserts the behaviour. `settings/effects.ts:33` already includes v3 and is the
template.

| Site | What it gates | Likely decision |
|---|---|---|
| `ui/src/store/events.ts:233` (`isV2Active()` OR `redesignShell`) | event routing for the modern composer / drawer | broaden — V3 has its own dock, verify it receives the same events |
| `ui/src/ui/Moshi.tsx:300` (`useIsV2()`) | Moshi creature composer ownership | broaden or confirm V3 never mounts this component |
| `ui/src/settings/SettingsPanel.tsx:347` (`isV2Active()`) | settings panel layout | check against `SettingsModal.tsx` — V3 may not use this panel at all |
| `ui/src/settings/shellVisibility.ts:24` (`shell === "v2"`) | hidden setting categories | decide the V3 hidden set explicitly (`shellVisibility.test.ts` already has a v3 row) |
| `ui/src/bridge.ts:206` (`preferredShell` whitelist `v2`/`classic`) | a persisted `preferredShell` value | add `"v3"` (and `"protools"`, `"live"` if missing) or document why the whitelist is narrower |

Deliverable: one commit, five decisions, five tests. No behaviour change without a test.

## 3. Tasks 2–6 — close the direction rows, in this order

1. **Multiplayer in V3** (row 10): mount the shared `MultiplayerPanel` behind a V3 launcher that
   matches v2's create/join flow; `v3-multiplayer.spec` against the mock peer. The owner's
   two-Mac row stays manual.
2. **Beat drop-in and generation** (rows 2–3): a V3 surface for kits/pads/patterns reusing the
   shared components, plus the dock ask; `v3-beat.spec`.
3. **Presets and the native plugin suite** (row 7): a preset picker in the V3 inspector via the
   existing `Rack.tsx` preset plumbing; `v3-plugins.spec`. The suite's *audio* viability (does
   each builtin do what its name says) is engine work outside this brief and must be scheduled
   on its own; do not let a V3 UI row claim it.
4. **Recording** (row 4): `v3-record.spec` over what #702 wired.
5. **Timeline gestures, MIDI-file import, sends** (rows 6, 11, 12).
6. **Colorway accents** (row 13).

Each task lands as its own PR with its spec, and every spec carries an anti-vacuity assertion
(a count or a readback that would differ if the feature were absent), per `vacuous-tests-pattern`.

## 4. Task 7 — port the Pro Tools core-loop matrix

After §3, mirror the remaining Pro Tools shell rows that describe generic DAW behaviour (clip
navigation opens the shared editor; Tab/nudge through the seam; Classic theme; compact-width
reachability) into `v3-*.spec.ts`. Skip Pro-Tools-specific idioms (Smart Tool, Playlists, Spot
mode). Target: V3 spec count within reach of the Pro Tools shell's, not a number for its own
sake — the matrix is the checklist, the count is a symptom.

## 5. Owner acceptance — the rows no gate can close

One real session on the built Release, V3 selected, on the owner's Mac: drop in a beat, record
a vocal with count-in, mix it, save, reopen, export, and run one multiplayer session with a
second Mac. Feel, audibility and latency are the owner's call. Record it as a dated evidence
directory like the ones under `~/Library/Mosh/task-evidence/`. This row is the gate's last row
and cannot be delegated to automation.

## 6. The flip (last, three lines)

1. `ui/src/settings/schema.ts`: `uiShell` default `"protools"` → `"v3"`, and rewrite the
   comment and help text that name Pro Tools as the fresh-install default.
2. `ui/src/settings/schema.test.ts:50`: the default pin.
3. `CLAUDE.md` ("Fresh settings select the Pro Tools shell") and `docs/CURRENT_STATUS.md:67`.

Existing explicit preferences stay as they are — the flip changes fresh installs only. Pro Tools,
Live, v2 and classic remain selectable. Run the cheap gate plus the full e2e suite: many specs
set their shell explicitly, but any that relied on the default will surface here.

## 7. What this brief does not authorise

No new visual direction for V3 (its DESIGN.md is the contract); no engine changes beyond what a
row strictly needs, and any new command carries all eight registrations, enumerated in
docs/PHONE_PAD.md (the #702 repair is the worked example); no claim that the native
plugin suite is musically viable — that is its own brief; no move of the default before
§5 is on record.
