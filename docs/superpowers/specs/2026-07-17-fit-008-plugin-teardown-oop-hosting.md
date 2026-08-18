# FIT-008: Plugin-teardown SIGSEGV true fix (out-of-process hosting)

_Scoped follow-up authored by the C++ core ship-blocker audit (2026-07-17, branch
`claude/burn-cpp-audit`). This is a SCOPE doc, not an implementation — see verdict below._

## Verdict: confirmed real, confirmed LARGE (OOP hosting), NOT built this pass

The audit's brief was: verify whether plugin **removal/unload** is hardened the same way
**scan** is, close any small guard gap, and scope (don't build) anything requiring
out-of-process hosting. Finding: scan-time is thoroughly hardened; **runtime teardown of an
already-loaded plugin has zero isolation**, and — a finding not previously written down —
**the one cheap mitigation that looks tempting (a "teardown dead-man's-pedal" mirroring the
scan one) does not actually work**, for an architectural reason confirmed against the pinned
`tracktion_engine` source (§3). FIT-008 (size `L`,
`needs-human`, `src/plugins/hosting/**` hard-excluded from automated review) already carries
the correct disposition; this doc gives it the code-anchored detail that line lacked, and
records the mitigation-that-doesn't-work so nobody rediscovers it by half-building it.

**One small, real gap in the pre-save belt-and-suspenders WAS found and fixed in this same
pass** (not part of FIT-008's scope, since it doesn't touch `src/plugins/hosting/`): see §5.

---

> **Tracking note (2026-08-18).** This doc was authored on the `claude/burn-cpp-audit`
> branch, whose work sat uncommitted in a worktree and was re-authored onto
> `claude/cpp-audit-salvage`. Two things have changed under it since: `docs/auto-loop/backlog.jsonl`
> (which carried the FIT-008 row) no longer exists, so **FIT-008 is currently untracked in any
> backlog**; and `MoshOps.cpp` has been split, moving `cmdRemoveTrack` to `MoshOps.Tracks.cpp`.
> §1–§4's findings about plugin hosting were re-checked and still hold.


## 1. What's actually hardened today (scan-time — confirmed thorough)

`src/plugins/hosting/PluginHost.{h,cpp}` is entirely about **discovery**, not runtime hosting:

- **Dead-man's-pedal crash/hang recovery** (`recoverFromDeadMansPedal`, `PluginHost.cpp:173-181`):
  a pedal file names the plugin about to be scanned; survives a crash; next launch
  blocklists it (`blockPluginWithReason(..., "crash_or_hang")`).
- **Out-of-process scan child** for the module-loading (slow VST3 / AU) sweep
  (`rescan()`, `PluginHost.cpp:368-471`): `setUsesSeparateProcessForScanning(true)` routes
  through Tracktion's `CustomScanner` → a child Mosh process; a crash/assert on load kills
  only the child, te relaunches it, blocklists the offender, continues.
- **Per-plugin hang watchdog** (`PluginHost.cpp:434-459`): a child stalled loading one
  plugin (e.g. blocked on a license/cloud socket) is killed after 25s of no heartbeat
  advance, turning an unrecoverable hang into a skip.
- **Blocklist is a REAL load-time gate, not just a browse-time filter** — verified this
  pass by black-box round-trip (was previously only proven as "vanishes from
  `list_plugins`"; the audit added the missing half): `cmdLoadPlugin`
  (`MoshOps.cpp:5183-5217`) resolves `pluginId` via `PluginHost::findDescription`, which is
  defined entirely in terms of `available()` (`PluginHost.cpp:517-529`), which filters
  `getBlacklistedFiles()`. `block_plugin` on a live catalog entry therefore makes a
  **subsequent `load_plugin` call on that id genuinely fail** with `"unknown plugin: ..."`
  — not merely hide it from a browser. New selftest coverage:
  `src/app/SelfTest.cpp`, INS-002/INS-005 section, the `block_plugin/load:` checks.

None of this touches what happens when a plugin **already hosted on a track** is torn down.

## 2. What's NOT hardened: runtime teardown (remove/unload)

Two MoshOps paths destroy a live third-party `AudioPluginInstance` in-process, synchronously,
on the message thread, with **zero isolation**:

- `cmdRemovePlugin` (`MoshOps.cpp:5219-5232`): `plugin->deleteFromParent()`.
- `cmdRemoveTrack` (`MoshOps.cpp:1103-1118` pre-audit / now +A2 guard, see §5):
  `eng.edit().deleteTrack(track)`, which cascades to destroy every plugin on that track.

`src/app/SelfTest.cpp:463-487` (`isHarnessHostablePlugin`) documents the **already
root-caused** crash class from a real incident (2026-06-18): a plugin's own background
thread or CoreAudio callback can outlive the plugin instance and fire into freed memory
during/after teardown —

- a cracked VST3 (`SIR Audio Tools "StandardCLIP"`) whose `QueueControlThread` locks an
  already-freed `std::mutex` → `EINVAL` → uncaught `std::system_error`;
- a stock AudioUnit (`AUSampler` / `AUVectorPanner`) whose `CAEventReceiver` timer's
  `std::function` is cleared on teardown → `bad_function_call` when the timer next fires
  during a message-loop pump.

Both abort the **host process**, not just the plugin. This is why the harness only ever
hosts a small vendor allowlist (Xfer / Vital Audio / Valhalla) instead of "the first
installed effect" — the crash isn't plugin-quality-dependent in the usual sense, it's a
teardown-ordering race the host cannot see or prevent from outside the plugin's own code,
short of not sharing an address space with it.

**A `try`/`catch` cannot fix this.** A SIGSEGV/SIGBUS from a dangling-pointer write is not a
C++ exception; there is nothing in-process to catch. The only isolation boundary that
actually contains this class of crash is a **process boundary** — hence "out-of-process
hosting" is not a phrase of convenience, it is the specific mechanism required.

## 3. Why the cheap mitigation (a "teardown dead-man's-pedal") doesn't work

The obvious cheap idea: mirror the scan dead-man's-pedal — before `deleteFromParent()` /
`deleteTrack()`, write the plugin's `fileOrIdentifier` to a pedal file; delete it after a
clean return; on the next launch, a surviving pedal blocklists the culprit exactly like a
scan crash does. **This was seriously considered this pass and rejected before writing any
code**, because it doesn't compose with how Tracktion reloads a saved Edit:

`PluginCache::getOrCreatePluginFor(ValueTree)` (pinned `tracktion_engine`,
`modules/tracktion_engine/plugins/tracktion_PluginManager.cpp:556-575`) → on a cache miss,
calls `PluginManager::createExistingPlugin(edit, v)` (`:300-309`) → `createPlugin(ed, v,
false)` (`:435-463`) → for `type == ExternalPlugin::xmlTypeName`, unconditionally
`new ExternalPlugin(info)` (`:447-448`). **This path never touches `KnownPluginList` or its
blacklist.** It reconstructs the plugin directly from the `PluginDescription` embedded in
the persisted `PLUGIN` ValueTree node — the same node that's still sitting on the track in
the `.tracktionedit` on disk (A2's pre-save persisted it there deliberately, moments before
the crash).

So: block-listing the crashed plugin's id would stop it from being **freshly loaded** via
`load_plugin` (§1), but the **already-on-the-track instance is not a fresh load** — it is
reconstructed straight from saved state the next time the edit opens, via a code path the
Mosh-side blocklist has no visibility into. The user would relaunch, the hostile plugin
would silently reload onto the track exactly as before, they'd try to remove it again
(nothing in the UI would tell them not to — the blocklist gate doesn't fire, since removal
isn't a `load_plugin` call), and it would crash again. A pedal-based mitigation gives false
confidence — worth writing down so nobody spends a cycle re-discovering this by half-building
it, and worth handing to whoever builds the real fix: it means **OOP hosting has to isolate
the *reload-from-saved-state* path too, not just explicit `load_plugin` calls** — the crash
surface at Edit-open time (an edit with a hostile plugin already on a track) is at least as
important as the crash surface at explicit `load_plugin`/`remove_plugin` time.

## 4. What a real fix looks like (for whoever picks this up — not scoped further here)

Sketch only, since `src/plugins/hosting/**` requires human review per repo policy and this
is genuinely a multi-week architectural rebuild, not a follow-up PR:

- Host `ExternalPlugin`'s underlying `AudioPluginInstance` in a **child process** (JUCE has
  no first-party "OOP plugin hosting for live audio" primitive the way it does for
  scanning — this likely means a custom IPC audio bridge: shared-memory ring buffer for
  audio + a control channel for parameters/state, with the child's crash/hang detected by
  the parent same as the scan watchdog already does).
  Candidates worth surveying before designing from scratch: JUCE's own
  `AudioProcessor`-over-IPC patterns in newer JUCE versions, VST3's native architecture
  (already separates GUI/processing more cleanly than VST2), or an existing OSS "plugin
  sandboxing" project if one is licensing-compatible.
- **Both** entry points need the isolation: explicit `load_plugin` AND Edit-load-time
  reconstruction of a persisted plugin (§3) — a host-crash during `te::loadEditFromFile`
  itself (not just during an explicit command) is squarely in scope, since that's exactly
  the repeat-crash-loop scenario.
  On a child crash at EITHER point, the host should mark that specific plugin instance
  "failed to load" (a `pluginLoadError` field on the track's plugin entry, surfaced in the
  UI as a "missing plugin" placeholder — matching how the reality-pack DAW-parity work
  already frames how other DAWs handle a plugin that won't load) rather than taking the
  whole app down, and should NOT auto-blocklist on a single failure (that's a scan-time
  policy; a runtime crash might be session/state-dependent, not universal).
- `isHarnessHostablePlugin`'s allowlist (`SelfTest.cpp:479-487`) can be relaxed/removed once
  this ships — it exists purely because today's in-process hosting isn't crash-safe for
  arbitrary vendors.
- Extend the same isolation to `cmdReorderPlugin`'s `removeFromParent()`+reinsert
  (`MoshOps.cpp:5234-5251`) and `cmdBypassPlugin` if bypass ever triggers a real
  teardown/rebuild internally (currently believed not to — bypass just gates processing —
  but verify against the OOP design, don't assume).

**Not recommending a specific IPC design here** — that decision needs a real spike/prototype
against JUCE 8's actual capabilities, which is exactly the kind of research a dedicated
FIT-008 session should do, not something to half-guess in a scope doc.

## 5. What WAS fixed this pass (small, NOT part of FIT-008's L-scope)

`cmdRemoveTrack` was missing the `eng.saveIfDirty()` pre-risky-op guard that
`cmdRemovePlugin`/`cmdLoadPlugin` already carry (the A2 hardening-pass pattern —
`CLAUDE.md`'s working notes list `load_plugin`/`load_builtin`/`remove_plugin`/
`accept_render`/`bounce_layer_to_clip`/`freeze_layer` as guarded; `remove_track` was
conspicuously absent despite being exactly as risky — deleting a track cascades to destroy
every plugin on it via the same in-process `deleteFromParent`-class teardown). This does
**not** contain a crash (nothing short of OOP hosting does, per §2-3) — it only bounds data
loss: a crash during `deleteTrack()` now recovers (via A2/A3) to the state immediately
before the removal, instead of potentially losing unrelated unsaved work made earlier in the
session. Fixed in `src/moshops/MoshOps.Tracks.cpp::cmdRemoveTrack`; proven via the A3 recovery
journal (a successful pre-save truncates it) in `src/app/SelfTest.cpp`, section "A2:
remove_track auto-saves before teardown". This is a `src/moshops/` change (not
`src/plugins/hosting/`), so it doesn't inherit FIT-008's hard-exclusion, but per the
MoshOps-seam review convention it still wants human review.

## 6. Rough size & mergeability

- **This doc + the §5 guard**: XS-S (docs + a 1-line guard + its SelfTest proof) — the
  content of the PR this doc lands in.
- **The real fix (§4)**: **L**, multi-week, needs a design spike before it's even
  plan-shaped, human review mandatory (`src/plugins/hosting/**` hard-excluded from
  automated/auto-merge review per repo policy). Not started; not scoped further than §4's
  sketch on purpose.
