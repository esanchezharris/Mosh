# Pro Tools Send Automation and Metering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Subagent execution is prohibited by the active serial-memory constraint.

**Goal:** Make Pro Tools Aux-send Level, Pan, and Mute genuine automation targets and show the final delivered stereo send level in Edit and Mix send rows.

**Architecture:** Extend the pinned Tracktion AuxSend plug-in with automatable pan/mute parameters and a final-branch `LevelMeasurer`, then expose stable automation addresses and optional send readings through the existing MoshOps snapshot/30 Hz telemetry seams. Resolve targets in shell-local Pro Tools state and reuse the existing generic automation lane and imperative meter ballistics, so all edits remain MoshOps commands and hot telemetry never re-renders the shell tree.

**Tech Stack:** C++20, JUCE 8, pinned Tracktion Engine patch series, MoshOps, Catch2/self-test, TypeScript 5, React 19, Zustand, Vitest, Playwright Chromium.

## Global Constraints

- Work serially; do not spawn subagents or run parallel commands.
- Immediately before every build, typecheck, Vitest, Playwright, Catch2, self-test, or test script run: `MOSH_MAX_SWAP_USED_MIB=0 scripts/auto-loop/memory-preflight.sh`.
- Stop on guard failure, less than 25% free memory, nonzero swap/compressor growth, or rising process fan-out.
- Do not launch Mosh, Ableton, Pro Tools, or another native GUI; do not create RAM disks.
- Use one mutation path: every automation edit remains a generic MoshOps command via `store.exec`.
- Snapshot and event changes are additive; no existing consumer may require the new fields.
- No `any`, empty catch, broad prose/hash assertions, secrets, generated build products, or new frontend dependencies.
- Browser/mock evidence does not prove native audio or physical-device behavior.

---

## File Map

- `patches/0008-tracktion-aux-send-automation-meter.patch`: Tracktion AuxSend parameters, current-value graph reads, and final-branch meter wiring.
- `cmake/Dependencies.cmake`: appends patch 0008 to the pinned patch manifest.
- `src/moshops/MoshOps.h`: send meter client ownership and reconciliation declarations.
- `src/moshops/MoshOps.Mixer.cpp`: send meter client lifecycle and payload construction helpers.
- `src/moshops/MoshOps.cpp`: optional `sends` field on the existing 30 Hz `levels` event; additive send automation addresses in track snapshots.
- `src/app/SelfTest.cpp`: native snapshot, automation, undo, save/reload, and telemetry lifecycle regression evidence.
- `ui/src/types.ts`: additive `SendAutomationAddress` and `Send.automation` types.
- `ui/src/store/telemetry.ts`, `ui/src/store/events.ts`: separate ephemeral `sendLevels` map parsed from optional payload data.
- `ui/src/bridge.mock.ts`: native-shaped send plug-in parameters, addresses, automation resolution, and deterministic stereo readings.
- `ui/src/protools/sendAutomationTargets.ts`: stable target ids, ordered options, exact address resolution, and fallback.
- `ui/src/protools/proToolsViewState.ts`, `ui/src/protools/proToolsState.ts`: project-scoped per-track target selection and epoch reset.
- `ui/src/protools/ProToolsTrackHeaders.tsx`, `ui/src/protools/ProToolsTimeline.tsx`, `ui/src/protools/ProToolsAutomationLane.tsx`: accessible target selector and resolved target lane.
- `ui/src/ui/Meter.tsx`: reusable imperative bars plus accessible `SendMeter`.
- `ui/src/protools/ProToolsSends.tsx`, `ui/src/protools/ProToolsMixSends.tsx`: Edit/Mix compact meter placement.
- `ui/src/protools/*.css`: target-selector and compact stereo meter layout using existing Pro Tools tokens.
- `ui/src/**/*.test.ts(x)`, `ui/e2e/protools-shell.spec.ts`: focused unit/component/browser evidence.
- `docs/protools-clone/TUTORIAL_PARITY_AUDIT_2026-08-10.md`, `ui/src/protools/DESIGN.md`: close the researched gap while retaining the physical-audio caveat.

---

### Task 1: Make AuxSend Pan and Mute Automatable and Meterable

**Files:**
- Create: `patches/0008-tracktion-aux-send-automation-meter.patch`
- Modify: `cmake/Dependencies.cmake`
- Modify locally for the guarded build only: configured `tracktion_engine-src` files named by patch 0008
- Test: `src/app/SelfTest.cpp`

**Interfaces:**
- Produces: `AuxSendPlugin::pan`, `AuxSendPlugin::mute`, `AuxSendPlugin::measurer`, `getPanParameter()`, `getMuteParameter()`, and a SendNode measurer pointer.
- Consumes: existing `AuxSendPlugin::gain`, `AuxSendNode::updateParameterStreams`, `StereoBalanceNode`, `GainNode`, `LevelMeasuringNode`.

- [ ] **Step 1: Write the failing native parameter expectations**

Extend the existing Wave 8 send section to find the live `AuxSendPlugin` on the
new source track and require exactly the three documented automatable parameters:

```cpp
te::AuxSendPlugin* rawSend = nullptr;
for (auto* track : te::getAudioTracks (eng.edit()))
    if (track != nullptr && track->itemID.toString() == gt)
        rawSend = track->getAuxSendPlugin (bus0);
const auto parameters = rawSend != nullptr
    ? rawSend->getAutomatableParameters() : juce::Array<te::AutomatableParameter*> {};
check (parameters.size() == 3, "send owns level, pan, and mute automation parameters");
check (parameters.size() > 1 && parameters[1]->getParameterName() == "Send pan",
       "send pan is addressable");
check (parameters.size() > 2 && parameters[2]->getParameterName() == "Send mute",
       "send mute is addressable");
```

- [ ] **Step 2: Compile and run one guarded self-test to capture RED**

Run these serially, with a fresh preflight before each command:

```bash
MOSH_MAX_SWAP_USED_MIB=0 scripts/auto-loop/memory-preflight.sh && \
cmake --build build-macos-arm64 --target Mosh -j1
```

```bash
MOSH_MAX_SWAP_USED_MIB=0 scripts/auto-loop/memory-preflight.sh && \
MOSH_NO_AUDIO=1 build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --selftest
```

Expected: the build passes and the Wave 8 parameter assertion fails. The harness
has no section filter, so this single bounded full self-test is the smallest real
engine RED proof; do not run it in parallel or repeat unrelated suites.

- [ ] **Step 3: Implement patch 0008 and register it**

Add continuous Pan and discrete Mute parameters, make the static setters write those parameters, read current values from their parameter streams, add a `LevelMeasurer`, pass it through `SendNode`, and wrap the final balanced/gained send branch with `LevelMeasuringNode`. Append patch 0008 after patch 0007 in `MOSH_TRACKTION_PATCHES`.

The public contract must be:

```cpp
AutomatableParameter::Ptr gain;
AutomatableParameter::Ptr pan;
AutomatableParameter::Ptr mute;
LevelMeasurer measurer;

AutomatableParameter* getPanParameter() const noexcept;
AutomatableParameter* getMuteParameter() const noexcept;
```

- [ ] **Step 4: Verify patch applicability and parameter GREEN**

Run the memory preflight, apply-check patch 0008 against a clean pinned source
already carrying 0001-0007, then run the same single-job `Mosh` build and one
headless self-test, each behind its own fresh preflight. Expected: patch check,
compile, and the new Wave 8 parameter assertions PASS.

- [ ] **Step 5: Commit the engine patch independently**

```bash
git add patches/0008-tracktion-aux-send-automation-meter.patch cmake/Dependencies.cmake
git commit -m "feat(engine): automate and meter aux sends"
```

---

### Task 2: Expose Native Send Addresses and Telemetry

**Files:**
- Modify: `src/moshops/MoshOps.h`
- Modify: `src/moshops/MoshOps.Mixer.cpp`
- Modify: `src/moshops/MoshOps.cpp`
- Modify: `src/app/SelfTest.cpp`

**Interfaces:**
- Consumes: Task 1 AuxSend parameters and measurer.
- Produces: optional snapshot `send.automation` and optional `levels.payload.sends` entries shaped `{trackId,bus,l,r}`.

- [ ] **Step 1: Add failing snapshot/command/lifecycle assertions**

In Wave 8, resolve the address from the snapshot, write points through `add_automation_point`, confirm parameter points serialize, exercise static setter convergence, undo, save/reload, remove-send/undo, and confirm the restored address resolves again. Capture a timer payload and assert each `(trackId,bus)` appears at most once and disappears after remove.

- [ ] **Step 2: Run the guarded focused self-test to verify RED**

```bash
MOSH_MAX_SWAP_USED_MIB=0 scripts/auto-loop/memory-preflight.sh && \
MOSH_NO_AUDIO=1 build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --selftest
```

Expected: RED on missing snapshot address/telemetry assertions. This second
bounded full run is justified because the native command/snapshot/timer seam has
no focused runner; it replaces, rather than supplements, an unrelated full suite.

- [ ] **Step 3: Implement client ownership and additive serialization**

Add:

```cpp
struct SendMeterKey { juce::String trackId; int bus = -1; };
struct SendMeterTap {
    te::AuxSendPlugin* plugin = nullptr;
    te::LevelMeasurer::Client client;
};
std::map<std::pair<juce::String, int>, std::unique_ptr<SendMeterTap>> sendMeterClients;
```

Reconcile against live AuxSend instances before each meter read. Detach only from still-live measurers during teardown; drop stale slots without dereferencing destroyed plug-ins. Serialize `automation` from the real plugin-list index and the three real parameter indices. Add the optional send readings to the existing payload.

- [ ] **Step 4: Run guarded focused self-test GREEN**

Rebuild `Mosh` serially after a passing preflight, then run one headless self-test
after another passing preflight. Expected: every Wave 8 check and the total harness
pass with zero failures.

- [ ] **Step 5: Commit native integration**

```bash
git add src/moshops/MoshOps.h src/moshops/MoshOps.Mixer.cpp src/moshops/MoshOps.cpp src/app/SelfTest.cpp
git commit -m "feat(moshops): expose send automation and levels"
```

---

### Task 3: Add Additive UI Telemetry and Mock Parity

**Files:**
- Modify: `ui/src/types.ts`
- Modify: `ui/src/store/telemetry.ts`
- Modify: `ui/src/store/events.ts`
- Modify: `ui/src/bridge.mock.ts`
- Create: `ui/src/store/events.send-levels.test.ts`
- Modify: `ui/src/bridge.mock.automation.test.ts`

**Interfaces:**
- Produces: `SendAutomationAddress`, `Send.automation`, `SendLevel`, `State.sendLevels: Record<string, Level>`, and `sendLevelKey(trackId,bus)`.
- Consumes: native event/snapshot shape from Task 2.

- [ ] **Step 1: Write failing parser and mock automation tests**

Assert that payloads without `sends` clear the ephemeral map, payloads with duplicates resolve deterministically to the last reading, existing track/master objects retain exact behavior, and mock generic automation commands accept all three native-shaped send addresses.

- [ ] **Step 2: Run guarded focused Vitest RED**

```bash
cd ui && MOSH_MAX_SWAP_USED_MIB=0 ../scripts/auto-loop/memory-preflight.sh && \
npx vitest run src/store/events.send-levels.test.ts src/bridge.mock.automation.test.ts
```

Expected: RED because `sendLevels` and send automation metadata do not exist.

- [ ] **Step 3: Implement types, parser, and mock**

Use a collision-safe key:

```ts
export const sendLevelKey = (trackId: string, bus: number): string =>
  `${trackId.length}:${trackId}:${bus}`
```

Keep `levels` unchanged and set `sendLevels` separately in `onLevels`. Build native-shaped AuxSend `PluginParam` entries and `Send.automation` when the mock assigns a send. Emit deterministic post-mute/pan/level stereo readings in the existing mock timer.

- [ ] **Step 4: Run guarded focused Vitest and typecheck GREEN**

Run each command separately, with a fresh preflight immediately before it:

```bash
cd ui && MOSH_MAX_SWAP_USED_MIB=0 ../scripts/auto-loop/memory-preflight.sh && \
npx vitest run src/store/events.send-levels.test.ts src/bridge.mock.automation.test.ts
```

```bash
cd ui && MOSH_MAX_SWAP_USED_MIB=0 ../scripts/auto-loop/memory-preflight.sh && npm run typecheck
```

- [ ] **Step 5: Commit telemetry/mock seam**

```bash
git add ui/src/types.ts ui/src/store/telemetry.ts ui/src/store/events.ts \
  ui/src/bridge.mock.ts ui/src/store/events.send-levels.test.ts \
  ui/src/bridge.mock.automation.test.ts
git commit -m "feat(ui): bridge send automation telemetry"
```

---

### Task 4: Resolve and Display Send Automation Targets

**Files:**
- Create: `ui/src/protools/sendAutomationTargets.ts`
- Create: `ui/src/protools/sendAutomationTargets.test.ts`
- Modify: `ui/src/protools/proToolsViewState.ts`
- Modify: `ui/src/protools/proToolsState.ts`
- Modify: `ui/src/protools/proToolsState.test.ts`
- Modify: `ui/src/protools/ProToolsTrackHeaders.tsx`
- Modify: `ui/src/protools/ProToolsTimeline.tsx`
- Modify: `ui/src/protools/ProToolsAutomationLane.tsx`
- Modify: `ui/src/protools/ProToolsTrackViews.test.ts`

**Interfaces:**
- Produces: `ProToolsAutomationTargetId`, `proToolsAutomationTargets(track,snapshot)`, `resolveProToolsAutomationTarget(track,targetId)`, and `setAutomationTarget(trackId,targetId)`.
- Consumes: `Send.automation`, serialized plugin params, existing `AutomationTarget`, and generic lane commands.

- [ ] **Step 1: Write failing pure/state/component tests**

Cover ordered labels `Volume`, `<Bus> · Level`, `<Bus> · Pan`, `<Bus> · Mute`; exact plugin/parameter resolution; discrete Mute metadata; missing-send fallback; project-epoch reset; native select semantics; and the command envelope produced by an edited send breakpoint.

- [ ] **Step 2: Run guarded focused Vitest RED**

```bash
cd ui && MOSH_MAX_SWAP_USED_MIB=0 ../scripts/auto-loop/memory-preflight.sh && \
npx vitest run src/protools/sendAutomationTargets.test.ts \
  src/protools/proToolsState.test.ts src/protools/ProToolsTrackViews.test.ts
```

- [ ] **Step 3: Implement shell-local target state and UI**

Store `automationTargets: Readonly<Record<string, ProToolsAutomationTargetId>>` in project defaults. Render a labelled native select when primary or secondary automation is visible. Pass a resolved `AutomationTarget` into `ProToolsAutomationLane`; remove name-based ambiguity for this path while retaining the old optional name API for other consumers.

- [ ] **Step 4: Run guarded focused Vitest and typecheck GREEN**

Run the focused files and `npm run typecheck` as separate commands, each preceded by the memory preflight.

- [ ] **Step 5: Commit automation-target UI**

```bash
git add ui/src/protools/sendAutomationTargets.ts \
  ui/src/protools/sendAutomationTargets.test.ts ui/src/protools/proToolsViewState.ts \
  ui/src/protools/proToolsState.ts ui/src/protools/proToolsState.test.ts \
  ui/src/protools/ProToolsTrackHeaders.tsx ui/src/protools/ProToolsTimeline.tsx \
  ui/src/protools/ProToolsAutomationLane.tsx ui/src/protools/ProToolsTrackViews.test.ts
git commit -m "feat(ui): edit Pro Tools send automation"
```

---

### Task 5: Render Accessible Edit and Mix Send Meters

**Files:**
- Modify: `ui/src/ui/Meter.tsx`
- Modify: `ui/src/ui/Meter.test.ts`
- Modify: `ui/src/protools/ProToolsSends.tsx`
- Modify: `ui/src/protools/ProToolsSends.test.ts`
- Modify: `ui/src/protools/ProToolsMixSends.tsx`
- Create: `ui/src/protools/ProToolsMixSends.test.ts`
- Modify: Pro Tools CSS files selected by existing send-row class ownership

**Interfaces:**
- Produces: `SendMeter({trackId,bus,label})` with `role="meter"` and imperative stereo bars.
- Consumes: Task 3 `sendLevels` and `sendLevelKey`.

- [ ] **Step 1: Write failing meter/component/accessibility tests**

Stub `requestAnimationFrame`, set one send reading, advance one frame, and assert both masks, `aria-valuenow`, stereo value text, no `aria-live`, no focusability, Edit/Mix placement, floor fallback, and one RAF subscription per mounted meter.

- [ ] **Step 2: Run guarded focused Vitest RED**

```bash
cd ui && MOSH_MAX_SWAP_USED_MIB=0 ../scripts/auto-loop/memory-preflight.sh && \
npx vitest run src/ui/Meter.test.ts src/protools/ProToolsSends.test.ts \
  src/protools/ProToolsMixSends.test.ts
```

- [ ] **Step 3: Implement shared accessible imperative bars and CSS**

Make the internal bars accept semantic props without changing existing track/master behavior. `SendMeter` reads the store imperatively and updates visual masks plus bounded meter attributes. Add compact rows that fit 720px overflow policy and reuse Pro Tools tokens.

- [ ] **Step 4: Run guarded focused Vitest and typecheck GREEN**

Run the three focused files and typecheck separately, with a fresh passing preflight before each.

- [ ] **Step 5: Commit meter surfaces**

```bash
git add ui/src/ui/Meter.tsx ui/src/ui/Meter.test.ts \
  ui/src/protools/ProToolsSends.tsx ui/src/protools/ProToolsSends.test.ts \
  ui/src/protools/ProToolsMixSends.tsx ui/src/protools/ProToolsMixSends.test.ts \
  ui/src/protools/*.css
git commit -m "feat(ui): meter Pro Tools aux sends"
```

---

### Task 6: Browser Flow, Docs, and PR/Merge Gate

**Files:**
- Modify: `ui/e2e/protools-shell.spec.ts`
- Modify: `docs/protools-clone/TUTORIAL_PARITY_AUDIT_2026-08-10.md`
- Modify: `ui/src/protools/DESIGN.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: current-source Chromium evidence, closed tutorial gap documentation, and a mergeable PR.

- [ ] **Step 1: Write the failing Chromium producer flow**

Add one bounded Pro Tools test that assigns a send, selects its Level/Pan/Mute automation targets, creates a breakpoint, verifies the mock command address, starts transport to see non-floor stereo readings in Edit and Mix, mutes the send to reach floor, removes it to verify Volume fallback, and repeats reachability at 720x720 reduced motion.

- [ ] **Step 2: Run guarded focused Playwright RED**

```bash
cd ui && MOSH_MAX_SWAP_USED_MIB=0 ../scripts/auto-loop/memory-preflight.sh && \
npx playwright test --config=playwright.isolated.config.ts \
  e2e/protools-shell.spec.ts --project=chromium --grep "send automation and meters"
```

- [ ] **Step 3: Complete integration/docs and make Chromium GREEN**

Fix only source-backed failures, then rerun the same one test after a fresh preflight. Update the tutorial audit from “gap” to “implemented, physical audible proof unclaimed,” and document the selector/meter behavior in the Pro Tools design contract.

- [ ] **Step 4: Run the bounded serial verification matrix**

Each command gets its own fresh memory preflight:

1. one bounded native self-test, checking the Wave 8 assertions in its transcript;
2. focused native Catch2 multiplayer lock test if touched;
3. focused Pro Tools Vitest files from Tasks 3-5;
4. UI typecheck;
5. focused Pro Tools Chromium test;
6. narrow Live boot/meter regression;
7. `git diff --check`, generated-artifact scan, staged secret scan, and source review.

Do not run the repository's full suite unless a focused failure identifies an integration surface that cannot be verified more narrowly.

- [ ] **Step 5: Commit integration evidence**

```bash
git add ui/e2e/protools-shell.spec.ts \
  docs/protools-clone/TUTORIAL_PARITY_AUDIT_2026-08-10.md ui/src/protools/DESIGN.md
git commit -m "test(ui): prove Pro Tools send automation and meters"
```

- [ ] **Step 6: Push, open ready PR, and wait for required checks**

Push `codex/protools-send-automation-meters`, open a ready PR describing authority,
memory receipts, native/browser boundaries, focused evidence, and rollback. Do not
merge while any required check is pending or red.

- [ ] **Step 7: Merge and confirm trunk state**

After every required hosted check is green, merge through GitHub, fetch `origin/main`,
confirm the merge commit contains the feature PR head, and report any remaining
owner-gated physical send-meter/audio acceptance separately.
