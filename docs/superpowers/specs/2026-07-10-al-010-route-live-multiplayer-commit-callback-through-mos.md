# AL-010: Route live multiplayer commit callback through MoshOps seam

_Execution-ready spec authored by the sprint bug-hunt/spec workflow (2026-07-10). feasible=True._

# AL-010 — Route the live multiplayer commit callback through the MoshOps seam

**Status: FEASIBLE — but the production routing is ALREADY LANDED.** The de-slop boundary
violation (HIGH-1) was fixed in commit `7b964d91` ("#274", 2026-07-09). The remaining,
genuinely-unfinished deliverable is the **focused live-callback regression** that the backlog
acceptance criteria calls for — a test seam was added for it but is currently **unused**.

This spec is written to be executed directly: it (a) verifies the production routing is present,
(b) adds the missing regression, and (c) includes the production diff-shape as a fallback in case
a future executor is on a branch where the routing was reverted.

---

## 1. Problem & current behavior (with code anchors)

### Original defect (de-slop audit HIGH-1)
The de-slop review recorded that the live `MultiplayerSession` commit callback mutated the Edit
**outside** `MoshOps::execute()`, even though an `apply_remote_track` command wrapper already
existed:

> `docs/auto-loop/deslop-evidence/native-seam-code-review.md:61-68` — "live multiplayer commit
> callback bypasses the MoshOps command chokepoint … lines 181-184 call
> `trackcommit::apply(eng.edit(), ...)`, `eng.markDirty()`, and `emitSnapshotInvalidated()`
> directly … I did not find coverage for the actual constructor callback path."

Confirmed via `git show 7b964d91 -- src/moshops/MoshOps.cpp`, the **old** callback body was:
```cpp
[this] (const juce::var& msg) {
    if (trackcommit::apply (eng.edit(), msg.getProperty ("blob", var()).toString()).ok)
        ... // markDirty + emitSnapshotInvalidated inline — bypasses execute()
}
```

### Current behavior (post-`7b964d91`) — routing is DONE
- **`src/moshops/MoshOps.cpp:439-449`** — the `MultiplayerSession` is constructed with the commit
  callback `[this] (const juce::var& msg) { applyMultiplayerCommitMessage (msg); }` (line 440).
- **`src/moshops/MoshOps.cpp:457-478`** — `applyMultiplayerCommitMessage()`:
  1. downloads any `audioRefs` (`{hash, ext}`) not already in `<editDir>/audio/by-hash/` (459-468),
  2. builds an `apply_remote_track` command object (470-474),
  3. calls **`execute (var (command))`** (475) — the single mutation chokepoint,
  4. on success emits **one** `emitSnapshotInvalidated()` for the local repaint (476-477).
- **`src/moshops/MoshOps.cpp:2751-2775`** — `cmdApplyRemoteTrack()` is the existing wrapper.
  It calls `trackcommit::apply (eng.edit(), blob)` with a **nullptr UndoManager** (see
  `src/multiplayer/TrackCommit.h:30-37`), `markDirty()`s, and deliberately **emits nothing**
  itself (no relay echo). Undo-invisibility is preserved by construction.
- **`src/moshops/MoshOps.cpp:948`** — dispatch `if (name == "apply_remote_track") return cmdApplyRemoteTrack (args);`.

### The real gap — no regression on the callback path
- **`src/moshops/MoshOps.h:53`** + **`src/moshops/MoshOps.cpp:452-455`** — a public test seam
  `applyMultiplayerCommitForSelfTest(const juce::var& msg)` was added (it forwards to the private
  `applyMultiplayerCommitMessage`). **It is called by nothing** (verified:
  `grep -rn applyMultiplayerCommitForSelfTest src tests` returns only the declaration + definition).
- Every existing `apply_remote_track` check invokes the command **directly**, never through the
  callback wiring:
  - `src/app/SelfTest.cpp:401-402` — peer-apply golden (direct `cmd(receiverOps, "apply_remote_track", …)`).
  - `src/app/SelfTest.cpp:4664-4697` — the strong undo-invisibility guard (sentinel pattern, direct command).
  - `src/app/SelfTest.cpp:5130-5141` — relay round-trip, then applies via direct command.
- So the callback-specific behavior is **untested**: the `audioRefs` download branch, and the
  callback-level `emitSnapshotInvalidated()` local repaint (which the direct-command tests
  explicitly assert does *not* happen — `SelfTest.cpp:4673`).

**Net:** production code satisfies AL-010's routing requirement; the acceptance clause "focused
regression covers the callback path" is not yet met.

---

## 2. Proposed design

Keep the landed routing exactly as-is (it is correct and seam-clean — see §6). Add **one focused
regression** that drives the live-callback entry point `applyMultiplayerCommitForSelfTest()` and
asserts the three properties that distinguish the callback path from the direct command:

1. **Applies through the seam** — the peer's track lands on the receiver (found by `moshLogicalId`).
2. **Local repaint, no undo entry** — exactly **one** `snapshot_invalidated` event fires (the
   callback's explicit repaint), and the apply is **not** on the undo stack (sentinel pattern:
   a subsequent `undo` reverts a control track, not the applied track — mirrors `SelfTest.cpp:4691-4697`).
3. **audioRefs branch is exercised** — pass an `audioRefs` entry whose by-hash file already exists
   locally so `downloadBlob` is correctly skipped (`MoshOps.cpp:466`) and the apply still succeeds
   (proves the loop is wired without needing a live relay).

This is **test-only**; no production change is required as long as §3.A verification passes.

---

## 3. Exact files to add/modify + shape of each change

### 3.A (Guard) Verify the production routing is present — no code change expected
Run, and confirm the routing exists before writing the test:
```bash
grep -n "applyMultiplayerCommitMessage (msg)" src/moshops/MoshOps.cpp      # expect ~line 440
grep -n 'command", "apply_remote_track"'      src/moshops/MoshOps.cpp      # expect ~line 473
grep -n "applyMultiplayerCommitForSelfTest"   src/moshops/MoshOps.h        # expect line 53
```
If all three are present → skip to §3.B. If (and only if) a branch reverted them, re-apply the
landed shape: callback lambda `[this](const juce::var& msg){ applyMultiplayerCommitMessage(msg); }`
at the `MultiplayerSession` construction (`MoshOps.cpp:439-449`); `applyMultiplayerCommitMessage`
building an `apply_remote_track` command and calling `execute(...)` then `emitSnapshotInvalidated()`
on ok; and the public `applyMultiplayerCommitForSelfTest` forwarder. That is the entirety of the
production requirement — do **not** add a new command or a new flag.

### 3.B (New test) `src/app/SelfTest.cpp` — add a focused live-callback section
Insert a new section adjacent to the existing MP-apply undo-guard block (after
`SelfTest.cpp:4698`), reusing the in-scope helpers (`cmd`, `ok`, `objN`, `args1`, `check`,
`eventTypes`, `trackByLogicalId`/`trackSnapshotByLogicalId`). Shape:

```cpp
section ("MP-001: live commit CALLBACK routes through the MoshOps seam (AL-010)");
{
    // Sender authors a track and serializes it to a commit blob (same producer path
    // mp_commit_track uses; see MoshOps.cpp:2905-2907).
    MoshEngine senderEng (false, true, "al010-sender");
    MoshOps    senderOps (senderEng);
    const auto sc  = cmd (senderOps, "create_track", args1 ("name", "AL010 Src"));
    const auto sid = sc.getProperty ("data", var()).getProperty ("trackId", var()).toString();
    cmd (senderOps, "add_test_tone_clip", objN ({ { "trackId", sid }, { "seconds", 1.0 } }));
    const auto ser  = cmd (senderOps, "mp_serialize_track", args1 ("trackId", sid));
    const auto blob = ser.getProperty ("data", var()).getProperty ("blob", var()).toString();
    const auto lid  = ser.getProperty ("data", var()).getProperty ("logicalId", var()).toString();
    check (blob.isNotEmpty(), "sender produced a commit blob");

    // Receiver with a captured event sink.
    MoshEngine rxEng (false, true, "al010-receiver");
    MoshOps    rxOps (rxEng);
    std::vector<juce::String> rxEvents;
    rxOps.setEventSink ([&] (const juce::var& e)
        { rxEvents.push_back (e.getProperty ("type", var()).toString()); });

    // Undo-invisibility sentinel: a fresh create sits on TOP of the receiver's undo
    // stack. If the callback apply is (wrongly) undoable, a later undo reverts the
    // applied track; if invisible, undo reverts THIS sentinel instead.
    cmd (rxOps, "create_track", args1 ("name", "AL010 Sentinel"));
    auto sentinelPresent = [&] {
        auto snap = rxOps.snapshot();
        if (auto* a = snap["tracks"].getArray())
            for (auto& t : *a)
                if (t.getProperty ("name", var()).toString() == "AL010 Sentinel") return true;
        return false;
    };
    check (sentinelPresent(), "sentinel present before callback");

    // Pre-stage a by-hash file so the audioRefs branch (MoshOps.cpp:459-468) runs and
    // correctly SKIPS download (dest already exists) — exercises the loop hermetically.
    auto byHash = rxEng.editFile().getParentDirectory()
                       .getChildFile ("audio").getChildFile ("by-hash");
    byHash.createDirectory();
    byHash.getChildFile ("deadbeef.wav").replaceWithText ("stub");   // any bytes; not decoded here

    auto* refs = new juce::DynamicObject();  // one already-present ref
    juce::Array<var> refArr;
    { auto* r = new juce::DynamicObject(); r->setProperty ("hash", "deadbeef");
      r->setProperty ("ext", "wav"); refArr.add (var (r)); }
    auto* msg = new juce::DynamicObject();
    msg->setProperty ("blob", blob);
    msg->setProperty ("audioRefs", var (refArr));

    // DRIVE THE LIVE CALLBACK (the wiring at MoshOps.cpp:440 → 457-478 → execute).
    rxEvents.clear();
    rxOps.applyMultiplayerCommitForSelfTest (var (msg));

    // (1) applied through the seam.
    check (trackSnapshotByLogicalId (rxOps, lid).isObject(),
           "callback applied the peer track (found by logicalId)");

    // (2) local repaint: exactly one snapshot_invalidated from the callback.
    int inval = 0; for (auto& e : rxEvents) if (e == "snapshot_invalidated") ++inval;
    check (inval == 1, "callback emitted exactly one snapshot_invalidated (local repaint, no echo)");

    // (3) undo-invisibility: undo reverts the sentinel, applied track survives.
    check (ok (cmd (rxOps, "undo")), "undo ok");
    check (! sentinelPresent(), "undo removed the sentinel (callback apply is NOT on the undo stack)");
    check (trackSnapshotByLogicalId (rxOps, lid).isObject(),
           "applied track survives the undo (apply is outside the undo system)");
}
```
Notes for the executor:
- `MoshEngine (false, true, name)` is the headless/fresh-session ctor already used at
  `SelfTest.cpp:382` (`src/engine/MoshEngine.h:28`).
- `trackSnapshotByLogicalId` is the helper used at `SelfTest.cpp:408`; if it is file-local to a
  different section, either hoist it or inline the snapshot walk (see `sentinelPresent`).
- Do **not** assert `inval == 0`; that is the *direct-command* invariant (`SelfTest.cpp:4673`).
  The callback path deliberately adds one local repaint.

### 3.C (Optional, if a Catch2 unit is preferred over selftest)
The callback needs a live `MoshEngine`+`MoshOps`, which the `--selftest` harness already builds;
adding it to `tests/` would duplicate that fixture. **Recommendation: keep it in `SelfTest.cpp`.**
No change to `tests/test_multiplayer_lock_manager.cpp` is needed (it already pins
`classify("apply_remote_track") == Unguarded`, `tests/test_multiplayer_lock_manager.cpp:18`).

---

## 4. Commands / contracts affected (additive?)

- **No command surface change.** `apply_remote_track` already exists and is dispatched
  (`MoshOps.cpp:948`). No new command, no new snapshot field, no new event type.
- **No frontend/contract change** — the callback is backend-internal (peer poll thread →
  message thread). The TypeScript command contract is untouched; `vitest`/`commands.contract`
  need not change.
- **Additive test only.** `--selftest` check count increases by the number of `check(...)` lines
  added (≈7); update any hard-coded selftest count only if the gate asserts an exact total.

---

## 5. Test plan (concrete assertions)

Primary — **`Mosh --selftest` (the new section in §3.B)**, run ×3 for determinism:
- `blob.isNotEmpty()` — sender produced a commit.
- `sentinelPresent()` before callback == true.
- After `applyMultiplayerCommitForSelfTest`:
  - `trackSnapshotByLogicalId(rxOps, lid).isObject()` — **applied via the seam**.
  - `count(snapshot_invalidated) == 1` — **local repaint, single**.
  - `undo` ok; `!sentinelPresent()` and applied track still present — **undo-invisibility**.

Regression safety — the existing direct-command guards must stay green and unchanged:
- `SelfTest.cpp:4673` — direct `apply_remote_track` emits **no** `snapshot_invalidated`.
- `SelfTest.cpp:4691-4697` — direct apply is outside the undo system.
- `SelfTest.cpp:401-406`, `5130-5141` — golden + relay round-trip apply.

Full native gate (per CLAUDE.md gate discipline):
- `Mosh --selftest` ×3 deterministic (current baseline ≈1199; expect baseline + ≈7).
- Catch2 suite green (`tests/`), incl. `test_multiplayer_lock_manager` unchanged.
- `relay/run-mp-selftest.sh` green (end-to-end relay path unaffected).
- `scripts/verify-hardware/verify.py --gate` green (audio unaffected — no production change).
- `vitest` / `e2e` / `tsc` — untouched (no UI/contract delta); run only to confirm no drift.

No Python goldens are implicated.

---

## 6. Risks & seam concerns

**All seam concerns verified benign against the current code — no hard-excluded module is touched.**

- **MoshEngine, src/state, plugins/hosting, deploy, CI:** **not touched.** Test-only change lives
  in `src/app/SelfTest.cpp`; production routing already merged.
- **Undo-invisibility (core invariant):** preserved. `cmdApplyRemoteTrack` → `trackcommit::apply`
  uses a **nullptr UndoManager** (`TrackCommit.h:30-37`), and `execute()`/`executeImpl`
  (`MoshOps.cpp:761-794`) does **not** wrap dispatch in a transaction — each handler owns its own
  transaction, and this one deliberately owns none. The §3.B sentinel assertion locks this.
- **Lock-guard interference:** none. `apply_remote_track` is classified **Unguarded**
  (`src/multiplayer/LockManager.cpp:30`), so the guard at `MoshOps.cpp:785-794` is skipped and no
  `applyingRemote_` flag is needed for it. (The `applyingRemote_` flag exists only for
  `cmdMpApplyStructural`, `MoshOps.cpp:2961-2963`, which re-executes *guarded* structural commands.)
- **Recovery-journal side effect of routing through `execute()`:** verified **harmless**.
  `execute()` funnels every command into `appendRecoveryJournal` (`MoshOps.cpp:765-767`), but that
  early-returns unless `isReplayableCommand(name)` (`MoshOps.cpp:9100-9101`), and
  `apply_remote_track` is **not** in the replayable allowlist (`MoshOps.cpp` allowlist ends at
  `set_project_settings`). So a remote apply is never journaled and never resurrected on
  crash-recovery replay. Worth a one-line comment in the test to document the check.
- **No relay echo / no infinite loop:** `cmdApplyRemoteTrack` sends nothing over the relay and is
  not wrapped in `broadcastStructuralIfActive` (contrast `MoshOps.cpp:825-827, 833-835`). The only
  emission is the callback-level local `snapshot_invalidated`. The §3.B `inval == 1` assertion
  guards against an accidental future double-emit.
- **Determinism:** `applyMultiplayerCommitMessage` deliberately does **no** message-loop drain
  (`MoshOps.cpp:2764-2768`) to avoid ticking 30 Hz telemetry or advancing an open undo transaction
  — so the event count stays exactly one and the test is deterministic ×3.

---

## 7. Acceptance criteria

1. `grep` guard in §3.A passes — the live callback routes through `execute("apply_remote_track")`
   → `cmdApplyRemoteTrack`; the old direct `trackcommit::apply(...)` bypass is absent.
2. A focused regression drives `applyMultiplayerCommitForSelfTest()` (the callback path, not the
   direct command) and asserts: applied-by-logicalId, exactly one local `snapshot_invalidated`,
   audioRefs-branch exercised (download skipped for a pre-present hash), and undo-invisibility via
   the sentinel pattern.
3. `Mosh --selftest` ×3 deterministic and green; the pre-existing direct-command MP guards
   (`SelfTest.cpp:401, 4673, 4691-4697, 5130-5141`) remain green and unmodified.
4. Full native gate green (Catch2, `relay/run-mp-selftest.sh`, `verify.py --gate`); no UI/contract
   drift (`tsc`/`vitest`/`e2e` unchanged).

---

## 8. Size & merge posture

- **Size: S.** The production routing already landed (`7b964d91`); the deliverable is one focused
  selftest section (~40 lines) plus verification. If a future branch has *not* landed the routing,
  it becomes **S–M** (re-apply the ~25-line callback/forwarder shape in §3.A, then the test).
- **Auto-mergeable.** Test-only addition guarded by the full fail-closed native gate; no
  hard-excluded seam (MoshEngine / src/state / plugins-hosting / deploy / CI) is touched. Standard
  auto-loop adversarial review applies. **Recommend confirming, in the PR description, that
  commit `7b964d91` already satisfies the routing clause** so a reviewer doesn't expect a
  production diff — the value of this item is closing the untested-callback gap, not re-fixing an
  already-fixed boundary violation.
