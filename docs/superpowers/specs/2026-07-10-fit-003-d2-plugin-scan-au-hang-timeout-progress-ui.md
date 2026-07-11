# FIT-003: D2: Plugin-scan AU-hang timeout + progress UI

_Execution-ready spec authored by the sprint bug-hunt/spec workflow (2026-07-10). feasible=True._

# FIT-003 — Plugin-scan AU-hang timeout + progress UI (execution-ready spec)

## ⚠️ Scope correction up front (read before executing)

The backlog entry (`docs/auto-loop/backlog.jsonl:46`) names the scan path as `src/plugins/PluginHost.cpp`. **That path is stale.** The scan code lives entirely at **`src/plugins/hosting/PluginHost.cpp` / `.h`** — i.e. inside the hard-excluded `src/plugins/hosting/**` seam. This forces two honest corrections to the lane:

1. **The "per-plugin timeout" half is already implemented — in the excluded seam.** Since the 2026‑06‑27 hardening pass, `PluginHost.cpp` grew a full stall watchdog:
   - `rescan()` OOP sweep watchdog: `src/plugins/hosting/PluginHost.cpp:396-416` — bumps a `scanFilesProcessed` heartbeat per plugin; if it stops advancing for `kStallMs = 25000` ms it calls `killScanWorkers()` (`:27-45`, `pkill -9 -P <pid> -f PluginScan:`), so Tracktion's master sees a "crash", blocklists the offender, and continues.
   - Cold‑start AU sweep watchdog: `:200-219` (same pattern, `MOSH_SCAN_AU=1` only).
   - Dead‑mans‑pedal crash/hang recovery: `:138-149`, `:313-318` — the id being loaded is written to `plugin-scan-inflight.txt`, cleared on clean return; a survivor is blocklisted on the next launch. This makes even a **hang** non‑indefinite *across launches* (quarantined next boot).
   The async command path already passes `slowVST3=true` for AU (`MoshOps.cpp:4903`), so `oop=true` and the watchdog runs for in‑session AU rescans.

2. **The residual true gap — an AU that hangs *in the current session* — cannot be fixed without editing the excluded seam.** Per the HONEST CAVEAT at `PluginHost.cpp:274-289`: `AudioUnitPluginFormat` instantiation is marshalled back to the **message thread**, so `killScanWorkers()` (which only kills the OOP child) does nothing for an in‑process AU hang; it freezes the UI until a forced restart. Fixing that means OOP AU hosting inside `scanAUComponents()` — squarely inside `src/plugins/hosting/**` and overlapping **FIT‑008** (plugin‑teardown OOP hosting). **Out of scope here.**

**What this lane CAN ship seam‑free, and where the real value is:** the **progress‑UI half**. Today progress is a coarse two‑event lifecycle (`plugin_scan_progress {done:false}` → `{done:true, count}`), consumed only by the **classic** `PluginBrowser`; the **v2 default shell has no rescan control and no progress UI at all**. The achievable deliverable is: (a) a live *running‑count* progress feed emitted from **MoshOps** (not the seam), (b) that feed surfaced in the v2 dock and enriched in the classic modal, and (c) a Catch2 + `--selftest` + vitest guard so the already‑present timeout is documented/regression‑locked. `feasible=true` for this reduced, honest scope.

---

## 1. Problem & current behavior (code anchors)

**Backend scan (all in the excluded seam — read‑only reference):**
- `PluginHost::rescan(clearFirst, includeVST3, includeAU, slowVST3)` — `src/plugins/hosting/PluginHost.cpp:325-428`. Single‑flight latch `scanInProgress` (`:334-336`), OOP watchdog (`:396-416`), RAII `ScanGuard` teardown (`:354-374`).
- `scanFile()` `:430-472` and `scanAUComponents()` `:290-323` bump the private `scanFilesProcessed` heartbeat (`PluginHost.h:96`). **These counters are `private` with no public getter, and `PluginHost.h` is excluded — so the UI cannot read them directly.**
- Public read surface available to callers: `PluginHost::available()`, and (already used by MoshOps) `engine.getPluginManager().knownPluginList.getNumTypes()` — a JUCE public API that grows as the sweep catalogs plugins.

**Command layer (editable — `src/moshops/`):**
- `MoshOps::cmdRescanPlugins()` — `src/moshops/MoshOps.cpp:4841-4917`.
  - VST3‑only / no‑AU path is **synchronous**, returns `{status:"done", count}` (`:4866-4876`); emits only `emitSnapshotInvalidated()`.
  - AU (or `all` + opted‑in) path spawns a detached `std::thread` calling `pluginHost.rescan(...,true,/*slowVST3=*/true)` (`:4896-4911`); returns `{status:"scanning"}`.
  - Emits exactly **two** progress events: start `{format, done:false}` (`:4889-4890`, message thread, pre‑spawn) and, via `MessageManager::callAsync`, done `{format, count, done:true}` (`:4904-4910`). **No events fire during the sweep** — the user sees a static "Scanning…" with no advancing count for a multi‑minute Waves/AU sweep.
- `MoshOps` is a `private juce::Timer` running continuously at **30 Hz** (`class MoshOps : private juce::Timer`, `MoshOps.h:32`; `startTimerHz(30)`, `MoshOps.cpp:434`; body `timerCallback()` `:691`). This is the clean, message‑thread hook for sampling progress with **no new thread**.
- `emit(type, payload)` — `MoshOps.cpp:9000-9008` (message‑thread only; suppressed during recovery replay).

**UI:**
- Store: `scanProgress: { format: string; done: boolean } | null` (`ui/src/store.ts:71`); reducer for `plugin_scan_progress` (`:320-328`) — sets `{format,done:false}` on start, clears + `refreshPluginList()` on done; `rescanPlugins()` action (`:618-628`).
- Classic modal `PluginBrowser` (`ui/src/ui/PluginBrowser.tsx:116-148`) — "Rescan" button + static status line (`:139-143`), **no count**.
- **v2 default shell** `PluginDock` (`ui/src/v2/PluginBrowser.tsx:159-215`) — **zero** references to `rescan`/`scanProgress`; grep confirms no scan UI. This is the primary user surface and the biggest gap.
- Mock bridge: `rescan_plugins` hits the `default: return ok(command)` case (`ui/src/bridge.mock.ts:1649-1650`) → no `status` field → store treats it as immediately done.

**`--selftest` coverage today:** `src/app/SelfTest.cpp:862-866` — synchronous VST3 `rescan_plugins {wait:true}` returns ok with a non‑shrinking `count`. `MOSH_SCAN_AU` is unset in the harness, so the async/progress path is never exercised (correct hermeticity).

---

## 2. Proposed design

**Principle:** all new code is in `src/moshops/**` (event enrichment), `ui/src/**` (UI), and `tests/` — **zero edits under `src/plugins/hosting/**`, `src/engine/**`, `src/state/**`.** The seam is read via public JUCE APIs only.

### 2a. Live running‑count progress from MoshOps (message‑thread sampler)

Piggyback the existing 30 Hz `timerCallback`. When an async sweep is live, sample `knownPluginList.getNumTypes()` (a public, message‑thread read — no race with the OOP master, which mutates the list on the message thread) and emit a decimated `plugin_scan_progress` with a running `count` + `elapsedMs`.

- Add private MoshOps members (touched **only on the message thread** — no atomics needed): `bool scanSampling_ = false;`, `juce::String scanFormat_;`, `double scanStartMs_ = 0;`, `int lastScanCount_ = -1;`, `double lastScanEmitMs_ = 0;`.
- In `cmdRescanPlugins()` async branch, before spawning the thread: `scanSampling_ = true; scanFormat_ = format; scanStartMs_ = Time::getMillisecondCounterHiRes(); lastScanCount_ = -1;` (replaces/augments the existing start emit at `:4889-4890`, which stays).
- In the completion `callAsync` (`:4904-4910`): set `scanSampling_ = false;` **before** the terminal `{done:true, count}` emit (unchanged shape).
- In `timerCallback()` (append near the end, after the existing telemetry): 

```cpp
if (scanSampling_)
{
    const auto now = juce::Time::getMillisecondCounterHiRes();
    const int count = eng.engine().getPluginManager().knownPluginList.getNumTypes();
    // Decimate: emit only when the catalog grew OR ~500 ms since last sample,
    // so a fast VST3 tail doesn't spam 30 Hz and a stalled AU still ticks elapsed.
    if (count != lastScanCount_ || (now - lastScanEmitMs_) >= 500.0)
    {
        lastScanCount_ = count;
        lastScanEmitMs_ = now;
        emit ("plugin_scan_progress",
              makeScanProgressPayload (scanFormat_, count, /*done=*/false,
                                       (int) (now - scanStartMs_)));
    }
}
```

- **Pure helper (the Catch2 unit):** a file‑local free function

```cpp
static juce::var makeScanProgressPayload (const juce::String& format, int count,
                                          bool done, int elapsedMs)
{
    auto* o = new juce::DynamicObject();
    o->setProperty ("format",    format);
    o->setProperty ("done",      done);
    o->setProperty ("count",     count);      // running catalog size; total is unknown seam-free
    o->setProperty ("elapsedMs", elapsedMs);
    return juce::var (o);
}
```

Reuse it for the start (`count:0`), sample, and done emits so all three share one shape.

**Determinacy note:** a determinate "X of N" bar is **not** achievable seam‑free (neither the VST3 bundle count nor the AU id count is exposed outside `PluginHost`). Progress is therefore **indeterminate**: a spinner plus "N found · Ts". (Optional, drift‑risky enhancement — a cheap `findChildFiles("*.vst3")` walk in MoshOps to estimate a VST3 total — is documented in §6 but **not** recommended for v1.)

### 2b. Store: enrich the transient scan state

Widen `scanProgress` to carry the optional live fields; the reducer forwards them. Backward‑compatible (existing `{format,done}` still valid; unknown fields ignored by older payloads).

### 2c. v2 dock: rescan control + live progress line (primary deliverable)

Add to `PluginDock`'s intro row a compact **Rescan** button (rescans `"vst3"` — always safe; AU stays opt‑in) disabled while `scanProgress` is set, and a live status line ("Scanning vst3… N found · Ts") when scanning. Wire `rescanPlugins` + `scanProgress` from the store. Matches the classic modal's affordance so the default shell reaches parity.

### 2d. Classic modal: show the count (polish)

Append the running count to the existing status line (`PluginBrowser.tsx:141`).

---

## 3. Exact files to add/modify + shape of each change

| File | Add/Modify | Shape |
|---|---|---|
| `src/moshops/MoshOps.h` | Modify | Add 5 private members (§2a): `bool scanSampling_`, `juce::String scanFormat_`, `double scanStartMs_`, `int lastScanCount_`, `double lastScanEmitMs_`. |
| `src/moshops/MoshOps.cpp` | Modify | (1) file‑local `makeScanProgressPayload()` helper. (2) `cmdRescanPlugins()` async branch (`:4889-4911`): set sampler state pre‑spawn; clear `scanSampling_` in the completion `callAsync`; route the start/done emits through the helper. (3) `timerCallback()` (`:691`): append the gated sampler block. Sync VST3 path (`:4866-4876`) **unchanged**. |
| `ui/src/store.ts` | Modify | Line 71 type → `scanProgress: { format: string; done: boolean; count?: number; elapsedMs?: number } | null`. Reducer (`:320-328`): on `!done` set `{format, done:false, count:p.count, elapsedMs:p.elapsedMs}`. Action (`:619`): init `{format, done:false, count:0}`. |
| `ui/src/v2/PluginBrowser.tsx` | Modify | In `PluginDock` (`:159-215`): subscribe `rescanPlugins`/`scanProgress`; add Rescan button + live status line in the intro row (`:170-177`). New `data-testid="v2-pb-rescan"` / `v2-pb-scan-status`. |
| `ui/src/ui/PluginBrowser.tsx` | Modify | Line 141 status line: append `{typeof scanProgress.count === "number" ? ` — ${scanProgress.count} found` : ""}`. |
| `ui/src/bridge.mock.ts` | Modify | Add an explicit `case "rescan_plugins": return ok(command, { status: "done", count: VST3S.length });` before `default:` so vitest/e2e exercise the real store branch deterministically. |
| `tests/test_plugin_scan_progress.cpp` | **Add** | Catch2 for `makeScanProgressPayload` (see §5). Requires exposing the helper — put it in a tiny header `src/moshops/ScanProgress.h` (new, non‑excluded) as `inline juce::var mosh::makeScanProgressPayload(...)`, included by both `MoshOps.cpp` and the test. |
| `src/moshops/ScanProgress.h` | **Add** | Header‑only pure helper (so both MoshOps.cpp and Catch2 share one definition; no seam, no engine dep). |
| `tests/CMakeLists.txt` | Modify | Add `test_plugin_scan_progress.cpp` to the explicit source list (`:10-19` region). |
| `ui/src/store.record.test.ts` or new `ui/src/store.scanProgress.test.ts` | **Add** | vitest for the reducer (see §5). |
| `ui/src/v2/PluginBrowser.test.tsx` (new) or extend existing v2 test | **Add** | vitest render test for the dock control + status line. |

---

## 4. Commands / contracts affected (additive?)

**Fully additive — no new commands, no breaking change.**
- `rescan_plugins` command surface, args, and result envelopes are **unchanged** (`{status,count}` / `{status:"scanning"}`).
- The `plugin_scan_progress` **event already exists**; this only **adds** optional `count` + `elapsedMs` fields to its payload and increases emit *frequency* during async sweeps. Existing consumers read `format`/`done` and ignore unknown fields → backward‑compatible.
- No snapshot/state schema change (`kSnapshotSchemaVersion` / `moshFormatVersion` untouched) — scan progress is transient events, matching the `transcribe_status` / `build_lyrics_status` precedent (`store.ts:329-341`).
- **Multiplayer:** `rescan_plugins` is already classified in `LockManager.cpp:28` (Unguarded/catalog op). No new command ⇒ no lock‑scope change. Progress events are host‑local UI feed, not broadcast.

---

## 5. Test plan (concrete assertions)

**Catch2 — `tests/test_plugin_scan_progress.cpp` (deterministic, no engine):**
- `makeScanProgressPayload("vst3", 0, false, 0)` → `payload["format"]=="vst3"`, `payload["done"]==false`, `(int)payload["count"]==0`, `(int)payload["elapsedMs"]==0`.
- `makeScanProgressPayload("au", 42, true, 1500)` → `count==42`, `done==true`, `elapsedMs==1500`.
- All four keys present and of the expected type (guards the additive contract the store relies on).

**`--selftest` (x3 deterministic, no baseline regression):**
- Keep the existing rescan assertions (`SelfTest.cpp:862-866`) — must still pass.
- **Baseline expectation:** the async sampler does **not** run in `--selftest` (no `MOSH_SCAN_AU`, VST3‑only inline path), so the selftest **check count is unchanged** unless you add the optional assertion below. "No baseline regression" = the existing count is preserved and stays deterministic across 3 runs.
- *Optional hardening assertion* (recommended, deterministic): in the INS‑002/005 section, install a capturing `EventSink` (via `ops.setEventSink`), run the sync VST3 `rescan_plugins {wait:true}`, and assert **no** malformed `plugin_scan_progress` event is emitted on the sync path (i.e. the sync envelope contract is unchanged). If added, bump the documented selftest count by exactly the number of new `check()` calls and record it in the PR.

**vitest:**
- Store reducer: dispatch `{type:"plugin_scan_progress", payload:{format:"au", done:false, count:7, elapsedMs:900}}` → `useStore.getState().scanProgress` deep‑equals `{format:"au", done:false, count:7, elapsedMs:900}`. Then `{done:true, count:12}` → `scanProgress===null` and `refreshPluginList` invoked (spy).
- v2 dock: render `PluginDock` with `scanProgress=null` → Rescan button present + enabled (`v2-pb-rescan`); with `scanProgress={format:"vst3",done:false,count:5,elapsedMs:1200}` → button disabled, status line contains "5" (`v2-pb-scan-status`).

**Playwright e2e (optional, additive):** open the v2 plugins dock, click `v2-pb-rescan`; mock returns `{status:"done"}` → status line does not persist (clears). One spec; run against the isolated config (`ui/playwright.isolated.config.ts`) per the repo's e2e GOTCHA.

**verify.py / py goldens:** **N/A** — no audio render path and no Python service change. Do not add.

---

## 6. Risks & seam concerns

- **HARD‑EXCLUDED `src/plugins/hosting/**`:** the design touches it **zero times**. Progress is derived from the public `knownPluginList.getNumTypes()` and MoshOps‑owned timing state. Reviewer check: `git diff --stat` must show no `src/plugins/hosting/` paths.
- **`src/engine/**` (MoshEngine), `src/state/**`:** untouched. `eng.engine().getPluginManager()` is an existing public accessor already used throughout `MoshOps.cpp` — no MoshEngine edit.
- **deploy / CI:** untouched.
- **Threading:** the sampler runs on the **message thread** (`timerCallback`), reads the list on the message thread, and emits on the message thread — same thread the OOP master mutates the list on. No new thread, no lock, no race. The existing detached scan thread + `callAsync` completion pattern is reused verbatim (its `this`‑capture lifetime exposure is pre‑existing; MoshOps lives for process lifetime, so it's the established safe assumption — do **not** widen it).
- **Event spam:** decimation (emit on count‑change or ≥500 ms) caps frequency well under 30 Hz; the store `set` is cheap.
- **Determinism trap (do NOT do in v1):** a MoshOps‑side directory walk to compute a determinate total would duplicate `PluginHost`'s enumeration logic and drift from it (vendor‑subfolder handling, blocklist, moduleinfo fast‑path). Keep progress indeterminate.
- **Misframing risk (the big one):** if a reviewer reads the backlog acceptance ("enforces a per‑plugin timeout so a hanging AU/VST3 cannot wedge the scan") literally, they may reject the PR for not *adding* a timeout. Mitigation: the PR description must state that the VST3/OOP timeout is **already enforced** (`PluginHost.cpp:396-416`, cite it), that this PR **regression‑locks + documents** it and delivers the progress‑UI half, and that the residual in‑session AU‑hang timeout requires the excluded seam and is tracked to **FIT‑008**. Get explicit sign‑off on the reduced scope before merge.

---

## 7. Acceptance criteria

1. **v2 default shell** exposes a working Rescan control and a live indeterminate progress line ("Scanning vst3… N found · Ts") — vitest + screenshot.
2. `plugin_scan_progress` payload carries optional `count` + `elapsedMs`; the async sweep emits **periodic** running‑count events (decimated), not just start/done. Verified by Catch2 (payload shape) + vitest (reducer) + owner‑gated real‑AU by‑ear (`MOSH_SCAN_AU=1` on a box with `.component` files — documented like the SA3 real‑model posture; not in CI).
3. Classic `PluginBrowser` status line shows the count.
4. **Catch2 green** including the new `test_plugin_scan_progress.cpp`; **`--selftest` deterministic across 3 runs** with the pre‑existing rescan checks passing and **no baseline count regression** (count unchanged, or +K exactly for K intentionally‑added optional assertions, recorded in the PR).
5. `tsc` clean; existing vitest + e2e suites still green (additive only).
6. **Zero edits under `src/plugins/hosting/**`, `src/engine/**`, `src/state/**`, deploy, CI.** No snapshot/format schema bump.
7. PR description documents: (a) the already‑present VST3/OOP 25 s watchdog with file:line, (b) that the in‑session AU‑hang timeout is out of scope under the seam exclusion and routed to FIT‑008.

---

## 8. Rough size & mergeability

- **Size: M.** Modest new code but spans C++ (MoshOps event enrichment + a pure helper + header), two UI shells, the store, the mock, and four test surfaces (Catch2 / --selftest / vitest / optional e2e).
- **Mergeability: NEEDS‑HUMAN gate on scope, then auto‑mergeable execution.** The lane as literally worded ("add a per‑plugin timeout") is **misframed** — that work is either already done (VST3/OOP) or blocked by the seam exclusion (AU). A human must ratify the reduced scope (progress UI + richer events + timeout regression‑lock) before this is handed to the auto‑loop. Once scope is agreed, the implementation is fully fail‑closed‑gateable (deterministic Catch2/selftest/vitest, no service, no seam). **Recommendation:** re‑title the backlog item to "plugin‑scan **progress UI** + timeout regression‑lock (AU in‑process hang → FIT‑008)", flip it to needs‑human for the one‑time scope call, then auto‑merge the reduced‑scope PR.
