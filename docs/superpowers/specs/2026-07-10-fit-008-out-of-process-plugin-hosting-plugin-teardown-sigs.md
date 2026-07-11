# FIT-008: Out-of-process plugin hosting (plugin-teardown SIGSEGV true fix)

_Execution-ready spec authored by the sprint bug-hunt/spec workflow (2026-07-10). feasible=True._

# FIT-008 — Out-of-process plugin hosting (SIGSEGV class)

> Execution-ready design doc. Status target: **needs-human, spec-only** (the primary seam `src/plugins/hosting/**` is hard-excluded from autonomous edits). Author it into `docs/superpowers/specs/2026-07-10-fit-008-oop-plugin-hosting-design.md` when landing.

## ⚠️ Feasibility & misframing correction (read first)

The lane note says *"JUCE has an AudioPluginInstance OOP option; assess feasibility."* **That option does not exist in stock JUCE 8 / the pinned Tracktion.** I verified against the pinned clone (`tracktion_engine 2877b621`, JUCE `7c89e11f`):

- JUCE ships out-of-process **scanning** only: `ChildProcessCoordinator` / `ChildProcessWorker` (`modules/juce_events/interprocess/juce_ConnectedChildProcess.{h,cpp}`) + `KnownPluginList::CustomScanner` (`juce_KnownPluginList.h:192`). There is **no** OOP `AudioProcessor`/`AudioPluginInstance` *playback* proxy anywhere in `juce_audio_processors`.
- Tracktion mirrors this: `PluginManager::setUsesSeparateProcessForScanning` / `startChildProcessPluginScan` (`plugins/tracktion_PluginManager.{h,cpp}`) are **scan-only**. `te::ExternalPlugin` holds the instance in-process (`std::unique_ptr<LoadedInstance> loadedInstance`, `tracktion_ExternalPlugin.h:145`) and pumps `processPluginBlock(...)` on the RT thread. No remote-plugin seam.

**Verdict: the *goal* is feasible and worth building, but the named *mechanism* is fictional.** True OOP hosting here means **building a custom sandbox host subsystem** (child process + shared-memory audio/MIDI/param bridge + an in-process RT-safe proxy plugin) on top of JUCE's IPC primitives. That is a large, RT-critical, deploy-touching subsystem — realistically **XL**, not the "flip a JUCE flag" the note implies. `feasible=true`, but sized and staged honestly below, and it is **not auto-mergeable**.

There is also a scope subtlety worth stating up front: the `isHarnessHostablePlugin()` allowlist is **harness-only** — the production `load_plugin` command already hosts *any* installed plugin with no allowlist. So the allowlist is not a production gate; it is a concession that the `--selftest` **process** cannot survive a crashy plugin's teardown. Relaxing it therefore genuinely *requires* process isolation — there is no cheaper way to make an arbitrary vendor plugin's SIGSEGV non-fatal to the harness.

---

## 1. Problem & current behavior (code anchors)

**Symptom.** Some installed plugins destabilize the *host* (not just themselves) on **load or teardown**, aborting the whole Mosh process. Documented in `src/app/SelfTest.cpp:442–457`:
- a cracked/badly-behaved VST3 spawns a background thread that outlives its instance and locks a freed `std::mutex` → `EINVAL` → uncaught `std::system_error` (observed: SIR Audio Tools *StandardCLIP* / its `QueueControlThread`);
- a stock Apple AudioUnit leaves a `CAEventReceiver` timer whose `std::function` is cleared on teardown → `bad_function_call` on the next message-loop pump (observed: `AUSampler` / `AUVectorPanner`).

This is **distinct from the TCC speech crash** (that was a missing `NSSpeechRecognitionUsageDescription` Info.plist key — see the CLAUDE.md working note; `block_plugin`/OOP would not have fixed it, and it fires with no plugin loaded).

**Current mitigations (what exists today):**

| Concern | Mechanism | Anchor |
|---|---|---|
| Crashy plugin during **scan** | OOP scanning + per-plugin **dead-mans-pedal** + stall watchdog; a scan crash/hang → blocklist on next launch | `PluginHost::rescan` / `scanFile` / `recoverFromDeadMansPedal` (`src/plugins/hosting/PluginHost.cpp:325,430,138`); Main relaunch hook `src/Main.cpp:86` |
| Crashy plugin during **load/teardown** | **Nothing structural.** `load_plugin` calls `eng.saveIfDirty()` first so a crash is *near-lossless*, but the process still dies | `MoshOps::cmdLoadPlugin` (`src/moshops/MoshOps.cpp:4727–4761`); `cmdRemovePlugin` (`:4763`) |
| Harness robustness | **Positive allowlist**: the `--selftest` harness only auto-hosts VST3s from 3 vetted vendors | `isHarnessHostablePlugin()` (`src/app/SelfTest.cpp:458–466`), gated at `:762` and `:1847` |
| Manual quarantine | `block_plugin` / `get_plugin_blocklist` / `clear_plugin_blocklist` | `MoshOps.cpp:4841–4997`; `PluginHost::blockPlugin` (`PluginHost.cpp:493`) |

The allowlist body (`SelfTest.cpp:463–465`) whitelists exactly `Xfer Records`, `Vital Audio`, `Valhalla DSP, LLC`. The comment at `:453` names the design intent: "*Rather than blocklist each crasher (whack-a-mole), POSITIVELY allow only VST3s… Extend the allowlist as more vendors are verified.*"

**Load path (the crash site).** `cmdLoadPlugin` → `eng.edit().getPluginCache().createNewPlugin(te::ExternalPlugin::xmlTypeName, desc)` (`MoshOps.cpp:4745`) instantiates the real `AudioPluginInstance` **in-process** on the message thread; `applyToBuffer` later runs its `processBlock` **in-process** on the RT thread. Both are where a bad vendor plugin takes down Mosh.

**The one existing precedent for the design we need:** `RaveInsertPlugin` (`src/plugins/transform/RaveInsertPlugin.h`) is a Mosh-owned `te::Plugin` that already runs heavy code **off the RT thread** via a background worker + **RT-safe ring buffers**, isolates the heavy dependency behind an interface (`RaveEngine.cpp`), reports exact latency for PDC, and is **build-gated** (`MOSH_HAVE_ANIRA`) so the default build is byte-unaffected. The OOP host is structurally the same shape with an IPC boundary substituted for the anira thread.

---

## 2. Proposed design

Build a **sandbox host**: the real plugin instance lives in a **child process**; the RT graph sees a thin, crash-immune in-process proxy.

### 2.1 Reuse the same signed binary (no second deploy artifact)

`src/Main.cpp:86` already relaunches **the same Mosh executable** as a scan child (`startChildProcessPluginScan` early-returns before any GUI/engine boot). Mirror that idiom: the host launches `argv[0]` with `--plug-host:<pipeId>` and handles it at the **very top of `initialise()`** (right after the scan hook), returning before MoshOps/engine construction. **Consequence: no new binary to bundle, sign, or notarize** — the child is the already-signed `Mosh.app` binary. (Deploy still needs a sanity check that the arg is honored in the shipped bundle — see §6.)

### 2.2 Three parts

```
┌─────────────────────────── Mosh (host process) ────────────────────────────┐
│  te graph ── SandboxedExternalPlugin (te::Plugin, RT-safe proxy)            │
│                 │  applyToBuffer(): lock-free write in / read out on a       │
│                 │  MemoryMappedFile audio ring; never blocks; on a missing   │
│                 │  block → passthrough+glitch-count (like anira's dropped    │
│                 │  inference). Control channel = InterprocessConnection.     │
│                 ▼                                                            │
│           SandboxHostClient  ── ChildProcess(argv0, "--plug-host:<id>")      │
└──────────────────────────────────┼──────────────────────────────────────────┘
                                    │  IPC: control (JSON/InterprocessConnection)
                                    │       audio  (MemoryMappedFile ring, lock-free)
┌──────────────────────────────────▼──────────────────────────────────────────┐
│  Mosh --plug-host:<id> (CHILD)                                               │
│    SandboxHostWorker: instantiate AudioPluginInstance from PluginDescription │
│    on a worker thread; run processBlock against the shared ring; forward     │
│    params / MIDI / getStateInformation over the control channel. If the      │
│    plugin SIGSEGVs on load or teardown → ONLY this child dies.               │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Audio bridge:** a `juce::MemoryMappedFile`-backed SPSC ring per direction (in / out), single writer / single reader, `std::atomic` head/tail indices — the same RT discipline `RaveInsertPlugin` already uses for its dry-ring (`RaveInsertPlugin.h`), just across a process boundary. Block size + channel count fixed at `initialise()`; renegotiated on prepare. **No allocation, no lock, no syscall on the RT read/write** (an `mmap`'d region is just memory).
- **Control bridge:** `juce::InterprocessConnection` (`juce_events/interprocess`) or `ChildProcessCoordinator`/`ChildProcessWorker` for lifecycle + params + MIDI + state. Not RT — runs on the message thread.
- **Failure detection:** child death → `ChildProcess::isRunning()==false` and `InterprocessConnection::connectionLost()`. The proxy flips to **passthrough** (audio keeps flowing, silent-or-dry) and marks itself `failed`; MoshOps surfaces it and can auto-`blockPlugin` after N crashes (dead-mans-pedal semantics, reused for the *load* path).

### 2.3 Editor (the genuinely hard part)

Cross-process native editor embedding (reparenting the child's `NSView`/HWND into a host window) is a large, platform-specific effort. **v1 scope: no native editor across the boundary.** Sandboxed plugins get a **generic parameter editor** in-process (`GenericAudioProcessorEditor` driven by the mirrored parameter list), exactly the fallback `openEditor` already uses (`PluginHost.cpp:545`). Native cross-process editor embedding is an explicit **v2 rung**.

### 2.4 Opt-in, gated, default-off

- Whole subsystem behind **`MOSH_ENABLE_PLUGHOST`** (CMake) → `MOSH_HAVE_PLUGHOST`, mirroring `MOSH_ENABLE_ANIRA`/`MOSH_HAVE_ANIRA`. **Default build byte-unaffected** (no new command surface, no proxy registration, `--selftest` count unchanged).
- Runtime policy env **`MOSH_SANDBOX_PLUGINS`** = `off` (default, current in-process behavior) | `unknown` (sandbox anything not on a trusted-vendor list) | `all`. Lets the harness/owner dial isolation without a rebuild.

### 2.5 Staging (do NOT try to land this as one PR)

- **Phase 0 — de-risking, landable now, does NOT satisfy acceptance (S).** Extend the dead-mans-pedal to the *load* path: `cmdLoadPlugin` arms `deadMansPedal()` with the plugin id **before** `createNewPlugin` and disarms on success; `recoverFromDeadMansPedal()` (already called at startup, `PluginHost.cpp:177`) then blocklists a load-crasher on the next launch. A load crash still happens once, but becomes self-healing. Also add `MOSH_HARNESS_HOST_ALL=1` to let a developer exercise arbitrary plugins locally. **This is a useful, low-risk pre-req; it is not the OOP fix and leaves the allowlist in place.**
- **Phase 1 — the OOP sandbox (audio + params + MIDI + state, generic editor).** The real deliverable. Relaxes the allowlist for sandboxed plugins. **L–XL, needs-human.**
- **Phase 2 — native cross-process editor embedding.** Separate lane.

---

## 3. Exact files to add / modify + shape of each change

### New (Phase 1) — all under `src/plugins/hosting/**` (⚠ hard-excluded seam → human authored)

**`src/plugins/hosting/SandboxHostProtocol.h`** — shared message contract (host ⇄ child): ring header layout, message tags (`Prepare`, `ProcessAck`, `SetParam`, `Midi`, `GetState`, `SetState`, `EditorParamList`), version constant. Pure header, no JUCE-module dependency beyond `juce_core`.

**`src/plugins/hosting/SandboxHostClient.{h,cpp}`** — host-side driver. Owns the `juce::ChildProcess` (launch `File::getSpecialLocation(currentExecutableFile)` + `--plug-host:<id>`), the two `MemoryMappedFile` rings, and an `InterprocessConnection` control link. RT-safe `pushAudio()/pullAudio()`; message-thread `setParam/sendMidi/getState/setState`; `bool isAlive()`. Mirrors `RaveEngine`'s "heavy thing behind a clean interface" split.

**`src/plugins/hosting/SandboxHostWorker.{h,cpp}`** — child-side. `static int run(const juce::String& pipeId)` called from `Main.cpp`. Instantiates the `AudioPluginInstance` via `AudioPluginFormatManager::createPluginInstance(desc, sr, block, err)`, runs `processBlock` against the ring on a worker thread, services the control channel. Arms a **child-local** dead-mans-pedal around instantiate + first `processBlock` (so a load-SIGSEGV is attributable).

**`src/plugins/hosting/SandboxedExternalPlugin.{h,cpp}`** — a Mosh-owned `te::Plugin` (xmlTypeName `"moshSandboxHost"`), modeled directly on `RaveInsertPlugin`:
```cpp
class SandboxedExternalPlugin : public te::Plugin {
  static const char* xmlTypeName;                 // "moshSandboxHost"
  void initialise (const te::PluginInitialisationInfo&) override;   // prepare ring, spawn child
  void deinitialise() override;                                     // tear down child
  void applyToBuffer (const te::PluginRenderContext&) override;     // RT: ring in/out, passthrough on miss
  int  getNumOutputChannelsGivenInputs (int n) override { return n; }
  double getLatencySeconds() override;             // report the fixed ring latency for PDC
  void restorePluginStateFromValueTree (const juce::ValueTree&) override;  // desc + child state blob
  juce::var describe() const;                      // manufacturer/name/failed/glitchCount → snapshot
private:
  juce::CachedValue<juce::String> pluginIdentifier, childState;    // persisted (see §6 src/state note)
  SandboxHostClient client;
  std::atomic<bool> failed { false };
  std::atomic<int>  glitchBlocks { 0 };
};
```
Persistence: store the `PluginDescription` identifier + the child's opaque `getStateInformation` blob in the plugin's own `ValueTree` so save/reload restores it exactly like `ExternalPlugin`.

### Modified

**`src/plugins/hosting/PluginHost.cpp`** (⚠ hard-excluded)
- `initialise()` (`:151`): `#if MOSH_HAVE_PLUGHOST` register the proxy: `engine.getPluginManager().createBuiltInType<SandboxedExternalPlugin>();` (beside the existing `createBuiltInType<...>` block at `:166–173`).
- Phase 0: add a `loadDeadMansPedal()` helper (arm/disarm around a *load*, distinct file from the scan pedal) if the load-path recovery lands here rather than in MoshOps.

**`src/Main.cpp`** — after the scan hook (`:86`), add:
```cpp
#if MOSH_HAVE_PLUGHOST
    if (commandLine.startsWith ("--plug-host:") || commandLine.contains (" --plug-host:"))
    { setApplicationReturnValue (mosh::SandboxHostWorker::run (parsePipeId (commandLine))); quit(); return; }
#endif
```
Must early-return **before** MoshOps/GenerativeJobManager construction (same tier-wall reasoning as the scan guard comment at `:77–85`; also force `MOSH_ENABLE_SA3=0` in the child env).

**`src/moshops/MoshOps.cpp`** — `cmdLoadPlugin` (`:4727`): when policy says sandbox this plugin (`shouldSandbox(desc)` from `MOSH_SANDBOX_PLUGINS`), create `SandboxedExternalPlugin` instead of `te::ExternalPlugin` (still via `getPluginCache().createNewPlugin(...)`, preserving the "must be the cache's instance" rule noted at `:4742–4744`). `addExternalPluginMetadata` (`:341`) gains `sandboxed`/`failed`/`glitchBlocks` fields. Phase 0: arm the load dead-mans-pedal here around `createNewPlugin`.

**`src/app/SelfTest.cpp`** — `isHarnessHostablePlugin` (`:458`): when `MOSH_HAVE_PLUGHOST` **and** `MOSH_SANDBOX_PLUGINS != off`, return `true` for any VST3 (sandbox makes teardown non-fatal). Keep the current allowlist as the fallback when the sandbox is off. Add a new `[sandbox]` harness section (see §5).

**`cmake/` (`Dependencies.cmake` / target defs)** — add `MOSH_ENABLE_PLUGHOST` option → `MOSH_HAVE_PLUGHOST` compile def; compile the 4 new TUs only when on. No new external dependency (JUCE `juce_events`/`juce_core` already linked).

---

## 4. Commands / contracts affected (additive?)

**Fully additive — zero breaking changes.**

- **No new MoshOps commands required.** Sandboxing is a *routing* decision inside the existing `load_plugin` (exactly the "zero new commands" posture Route-B/transform used). `remove_plugin`, `reorder_plugin`, `set_plugin_param`, `bypass_plugin`, `open_plugin_editor`, `list_plugins` work unchanged against the proxy because it is a `te::Plugin`.
- **Snapshot additions (additive optional fields):** the per-plugin object gains `sandboxed: bool`, `failed: bool`, `glitchBlocks: int` via `addExternalPluginMetadata` (`MoshOps.cpp:341–351`). UI ignores unknown fields today, so this is safe; a small badge ("sandboxed" / "crashed — click to reload") is an optional UI follow-up, **not** required for acceptance.
- **`open_plugin_editor`** on a sandboxed plugin opens the generic parameter editor (v1) — same command, same envelope, degraded editor. Documented, not a contract break.
- **`snapshotSchemaVersion` / `moshFormatVersion` unchanged** — the persisted proxy state is an additive optional node under the plugin's own `ValueTree` (same "additive optional ⇒ no format bump" rule invoked for the lyric sheet, `state/Migrations.h`).
- **Default build:** with `MOSH_ENABLE_PLUGHOST=OFF`, none of the above compiles → the command/snapshot contract is **byte-identical** to today.

---

## 5. Test plan (concrete assertions)

Everything below is gated so the **default** gate is unchanged; the sandbox assertions run only in an `MOSH_ENABLE_PLUGHOST=ON` build.

**Catch2 (`tests/`, host-side, no real vendor plugin needed):**
- `test_sandbox_ring.cpp` — SPSC `MemoryMappedFile` ring round-trips a known buffer host→child→host bit-exact; wrap-around at ring boundary preserves ordering; a reader that runs ahead of the writer yields a "no block" sentinel (never garbage). Assert: `pulled == pushed` for 10k random blocks; `glitchBlocks` increments exactly on starvation.
- `test_sandbox_proxy_state.cpp` — `SandboxedExternalPlugin` serializes `pluginIdentifier` + `childState` to a `ValueTree` and restores identically (`restorePluginStateFromValueTree`); a proxy with no live child reports `failed==true` and `applyToBuffer` passes input through unchanged (dry RMS in == out RMS).

**`--selftest` (new `[sandbox]` section, `MOSH_HAVE_PLUGHOST` only):**
- `sandbox proxy registered` — `createBuiltInType<SandboxedExternalPlugin>` present in the format manager.
- `load_plugin sandboxed round-trip` — with `MOSH_SANDBOX_PLUGINS=all`, `load_plugin` on a vetted VST3 (e.g. Valhalla, still available) yields a plugin whose snapshot has `sandboxed==true`, `failed==false`; `set_plugin_param`, `bypass_plugin`, `save`+`reload`, `remove_plugin` all `ok`.
- `child-death is non-fatal` — a **fault-injection** hook: `MOSH_SANDBOX_CRASH_ON_LOAD=1` makes `SandboxHostWorker` `abort()` right after instantiate. Assert `load_plugin` returns `ok` (proxy created), the snapshot shows `failed==true`, **the harness process is still alive**, and a subsequent `export_audio` produces non-silent passthrough audio. This is the assertion that proves the SIGSEGV class is contained.
- `allowlist relaxed under sandbox` — with the sandbox on, `isHarnessHostablePlugin` returns `true` for a non-allowlisted VST3 vendor; deterministic given a synthetic `PluginDescription`.
- **Determinism:** the section must be hermetic (fixed block size, fault-injection env pinned) and pass `×3`, matching the repo's `--selftest ×3` discipline. Note the expected new check count in the PR (it grows).

**`verify.py` (offline render, host-side):**
- `--sandbox-passthrough` — render a tone through a *deliberately crashed* sandboxed proxy; assert output is non-silent and equals the input within the fixed ring latency (PCM-checksum stable ×2), proving passthrough-on-failure. Wire behind the existing `--gate` only when the anira-style opt-in build is present, else skip cleanly (like `--rave`).

**vitest / TS:** additive only — `commands.contract.test.ts` gains no new command; a mock-backend test asserts the UI tolerates the new `sandboxed`/`failed` snapshot fields (renders, no crash). If a "crashed plugin" badge lands, add a component test; otherwise none.

**No Python goldens** — this lane has no service/Python surface.

**Real-plugin by-ear (owner-gated, not in CI):** load the actual `StandardCLIP` / `AUSampler` crashers named in `SelfTest.cpp:447–450` with `MOSH_SANDBOX_PLUGINS=all`; confirm load + teardown + app-quit with **zero** SIGSEGV across 10 load/remove cycles. This is the true acceptance evidence and must be done on the owner's machine.

---

## 6. Risks & seam concerns

**Hard-excluded seams this lane touches (⇒ needs-human, not auto-mergeable):**
- **`src/plugins/hosting/**`** — explicitly hard-excluded (backlog `files` + acceptance note). The proxy, client, worker, and protocol all live here or beside it. This alone forces human authorship.
- **RT graph / `MoshEngine`** — `applyToBuffer` on the audio thread now depends on an IPC ring; a subtle blocking call (a `mmap` fault-in, a lock, a syscall) would cause dropouts. Must be validated with the existing `MOSH_RT_GUARD` alloc tripwire (`src/audio/RealtimeAudioGuard`), which already wraps `RaveInsertPlugin::applyToBuffer` — extend the `MOSH_RT_SCOPE()` to the proxy.
- **`src/state` / persistence** — the proxy stores a plugin-description id + opaque child-state blob. Additive-optional node only (no `moshFormatVersion` bump), but it is state-surface and needs review.
- **deploy** — `run-mosh.sh deploy`: the child is the same signed binary, so **no new artifact**, but (a) the deployed bundle must actually honor `--plug-host:` (same class of bug as the "POST_BUILD-only plist inject" and "deploy shipped a TCC-crashing app" notes), and (b) macOS **hardened-runtime entitlements / sandbox** must permit a child process + shared memory (`MemoryMappedFile` in a temp dir the sandbox allows). If the app is ever sandboxed/notarized strictly, child-spawn + shared-mem needs an entitlement. `gate.sh` should assert the shipped bundle's child hook works.
- **CI** — the sandbox path only exists in an `MOSH_ENABLE_PLUGHOST=ON` build; CI must add that build variant to exercise the `[sandbox]` section, or the fix ships untested. Coordinate with FIT-009 (mac-only CI).

**Technical risks:**
- **Latency / PDC.** Crossing a process adds fixed buffering latency. Report it exactly via `getLatencySeconds()` (the `RaveInsertPlugin` precedent) so Tracktion's PDC compensates; a wrong value desyncs every sandboxed track.
- **MIDI + timing jitter** to instruments across IPC — sample-accurate MIDI is harder than audio; instruments (synths from MIDI clips) are the higher-risk case vs. effects. Consider effects-only in v1 if jitter is audible.
- **Editor.** Native cross-process editor embedding is deferred (v2); v1's generic editor is a real UX regression for sandboxed plugins — call it out to the owner.
- **Child lifecycle storms.** A plugin that crashes *every* load must not spin-relaunch. Reuse dead-mans-pedal N-strikes → auto-blocklist.
- **Windows parity.** `killScanWorkers()` is already a documented Windows no-op (`PluginHost.cpp:29–37`); the child lifecycle/kill path needs a Toolhelp32 equivalent. Keep behind the same `if(WIN32)` guards; macOS is canonical.

**Non-risk (scope correction):** this does **not** address the TCC speech-crash class (already fixed via the Info.plist key) — do not conflate them.

---

## 7. Acceptance criteria

1. **Isolation proven (the core).** With `MOSH_ENABLE_PLUGHOST=ON` + `MOSH_SANDBOX_PLUGINS=all`, a plugin that SIGSEGVs on **load** and one that faults on **teardown** are both contained: the Mosh host process survives, the offending track continues (passthrough), and the snapshot marks the plugin `failed`. Proven by the fault-injection `--selftest` check and the owner's real-plugin by-ear pass on the `StandardCLIP`/`AUSampler` crashers.
2. **Allowlist relaxed.** `isHarnessHostablePlugin()` returns `true` for arbitrary VST3 vendors when the sandbox is on; the harness hosts a non-allowlisted plugin and passes. The `Xfer/Vital/Valhalla` positive list survives only as the sandbox-off fallback.
3. **Full plugin lifecycle over the proxy.** `load_plugin` / `set_plugin_param` / `bypass_plugin` / `reorder_plugin` / `open_plugin_editor` (generic editor) / `remove_plugin` / `save`+`reload` all `ok` against a sandboxed plugin; rendered audio is correct (not silent, param changes audible).
4. **RT-clean.** The sandboxed `applyToBuffer` allocates nothing and never blocks under `MOSH_RT_GUARD` (Debug tripwire green).
5. **Default build untouched.** With `MOSH_ENABLE_PLUGHOST=OFF`: default `--selftest` count, Catch2, vitest, e2e, and the C++ command/snapshot contract are **byte-identical** to pre-lane `main`.
6. **Deterministic gate.** The new `[sandbox]` section passes `×3`; `verify.py --sandbox-passthrough` PCM-checksum stable `×2`.

---

## 8. Rough size & merge posture

- **Size: L–XL.** Phase 0 (load-path dead-mans-pedal + `MOSH_HARNESS_HOST_ALL`) is **S** and independently landable. Phase 1 (audio + params + MIDI + state + generic editor OOP sandbox) is **L–XL** — a new RT-critical IPC subsystem with a fault-injection test harness. Phase 2 (native cross-process editor) is a separate **L** lane.
- **Auto-mergeable? No — needs-human.** Three independent blockers: (1) the primary seam `src/plugins/hosting/**` is hard-excluded; (2) it edits the RT graph and deploy/entitlements; (3) the true acceptance evidence is an owner-run, real-crasher, by-ear pass that cannot be automated in CI. The autonomous loop can at most prepare **Phase 0** and the pure host-side ring/protocol unit tests; the sandbox itself must be human-authored and human-verified.
- **Recommended landing order:** Phase 0 (auto-loop-eligible, de-risks the load path today) → Phase 1 behind `MOSH_ENABLE_PLUGHOST` with the fault-injection `--selftest` as the gate → owner by-ear sign-off → flip `MOSH_SANDBOX_PLUGINS` default and relax the allowlist. Do not relax the allowlist before Phase 1's isolation is proven.
