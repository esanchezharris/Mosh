# Linked MIDI duplicates — design (reality-model invariant 91)

*Produced 2026-07-18 by a 16-agent design workflow: 3 parallel code/engine mappers -> 3 independent
designs from different angles -> 9 adversarial judges (3 lenses x 3 designs) -> synthesis.
Scores: copy-in-transaction 7.0 | link-group + propagation 6.3 | shared-note-data 5.0 (found infeasible).*

**STATUS: NOT BUILT.** Two owner decisions are open (see the addendum) — the plan is ready to execute
once they are answered.

---

## Addendum — open questions resolved after synthesis (verified against the pinned clone `2877b621`)

The plan below closes with five OPEN QUESTIONS. Three were verifiable and have been resolved; the
resolution of Q1 **materially simplifies the build**. Two are genuine owner calls and remain open.

### Q1 (the plan's "single unverified claim the plan depends on") — RESOLVED, and the risk is smaller than feared

The undo-size cap is real, but it is **floored at a transaction count**, so the catastrophic case cannot happen:

- `Edit::getDefaultNumUndoLevels() == 30` — `tracktion_Edit.h:362`. Mosh does **not** override it (no `numUndoLevels` anywhere in `src/`).
- `undoManager.setMaxNumberOfStoredUnits (1000 * 30, 30)` — `tracktion_Edit.cpp:643`, i.e. 30,000 units **and** `minimumTransactionsToKeep = 30`.
- Every `ValueTree` undo action reports `sizeof (*this)` units (`juce_ValueTree.cpp:454/522/555`) — tens of bytes each, so a large fanout does blow the *unit* budget.
- **But** the eviction loop is `while (nextIndex > 0 && totalUnitsStored > maxNumUnitsToKeep && transactions.size() > minimumTransactionsToKeep)` (`juce_UndoManager.cpp:202-207`) — it **stops at 30 transactions**.

**Consequence:** a fanout can never evict below 30 undo levels. The feared "one big linked edit wipes
undo history" outcome is impossible; the worst case is that a heavy-fanout project settles at exactly
the default 30 levels instead of more. **The size guard proposed in Risk 2 is therefore NOT required for
correctness** — drop it, and keep the bench purely as a latency/memory measurement.

### Q2 — RESOLVED: the identifiers are public and reachable

`isComp` (`tracktion_Identifiers.h:413`) and `channelNumber` (`:423`) are both public `DECLARE_ID`s in the
engine's `IDs` namespace, so `te::IDs::channelNumber` / `te::IDs::isComp` resolve from `MoshOps.cpp`.
**Caveat worth keeping:** `MoshOps.cpp` currently contains **no** `te::IDs::` usage at all, so this would be
the first — keep the plan's suggestion to pin the spelling with a Catch2 test, since a silent rename
upstream would otherwise degrade into a no-op save/restore.

### Q3 — RESOLVED: MIDI takes are unreachable through commands, but reachable through recording

Mosh's take surface is **wave-only** — the handler casts to `te::WaveAudioClip*` (`MoshOps.cpp:10940`-ish),
so no Mosh command can put takes on a MIDI clip. However `te::MidiClip` *does* implement takes
(`addTake` `tracktion_MidiClip.h:90`, `getNumTakes` `:127`) and `MidiInputDevice` calls `addTake` on overdub.
**So the takes guards are cheap insurance (keep them), and step 4.1 — unlink on record — is still load-bearing**,
because recording is the one path that can give a linked MIDI clip takes behind the command surface's back.

### Q4 — OPEN, owner call: unlink-on-record vs propagate-on-record

The plan recommends **unlink**, because `stop_recording` is non-undoable (`MoshOps.cpp:5074`) and a
propagating overdub would therefore be unrecoverable. The counter-argument is that "record a fill into
chorus 1, hear it in all four" is arguably what a producer wants. This is taste, not correctness.

### Q5 — OPEN, owner call: amending the reality model

The workflow **falsified invariant 91 as written**. "Duplicated as linked references the same note data" is
structurally impossible: `ValueTree::addChild` force-removes a child from its previous parent
(`juce_ValueTree.cpp:254-269`), so a second clip adopting a shared sequence *steals* it and the first
clip's notes vanish; and the pooled-tree workaround fails because `callListenersForAllParents` walks
parent pointers only (`:96-100`), so a pooled sequence would notify neither clip and playback would keep
playing pre-edit notes.

The observable behaviour producers expect is achievable; the **mechanism claim** is not. The proposed
amendment to `docs/reality-pack/mosh_daw_reality_model.md:154` is:

> *"A pattern duplicated as linked propagates edits to every copy in one undoable step; duplicated as unique creates independent note data."*

**Not applied here** — the conformance suite reads that file, so amending a spec document is the owner's
call, not an autonomous one.

---

I've verified enough to correct several claims the designs and judges made. Writing the plan.

---

# FINAL BUILD PLAN — Linked MIDI duplicates (reality-model invariant 91)

## 1. VERDICT

**Build it — but not as invariant 91 is written, and not with the highest-scoring design's scope.**

Two corrections up front:

**(a) The invariant's wording is unachievable and must be amended.** "Duplicated as linked references the same note data" is structurally impossible. Two clips cannot share one note tree: `ValueTree::addChild` asserts `child->parent == nullptr` and then *force-removes* the child from its previous parent (`juce_ValueTree.cpp:254-269`) — the second clip steals the tree, the first clip's notes vanish. The pooled-tree workaround also fails, because `callListenersForAllParents` walks parent pointers only (`juce_ValueTree.cpp:96-100`) and `Clip` listens on its own tree, so a pooled SEQUENCE would notify neither clip and playback would keep playing pre-edit notes. Amend line ~154 of `docs/reality-pack/mosh_daw_reality_model.md` to *"…edits to one propagate to every copy in one undoable step."* The observable behaviour is identical; the mechanism claim is not.

**(b) Ship cross-track linking, or don't ship.** The top-scoring design (7.0) enforced same-track groups and auto-unlinked on cross-track move. That kills the primary professional use of linked MIDI — one part driving a bass and a sub, edit once, both follow — and worse, it makes the Logic user's option-drag *destroy* a link. All three producer judges independently scored their designs 5/5/4 on exactly this axis. Cross-track is also **cheaper** than same-track: it's simply *not writing* the auto-unlink rule. Its only cost is multiplayer, and MP linked-duplicates are already broken in every design (the group id crosses the wire in `clipToVar` but no apply path honours it), so v1 refuses link *creation* while a MP session is active (`LockManager::isActive()`, `src/multiplayer/LockManager.h:39`) rather than pretending same-track buys correctness.

**Scope: single-player, MIDI-only, cross-track-capable, with an unlink escape hatch and group teardown on delete.** Mechanism = Mosh-owned group tag + whole-sequence `copyFrom` with a real UndoManager, synchronously inside the command's existing transaction.

**Do NOT use Tracktion's native `IDs::linkID`.** It is complete and public but disqualified twice over: `MidiClip::cloneFrom` hard-codes `juce::UndoManager* um = nullptr` (`tracktion_MidiClip.cpp:213`) so propagated notes bypass undo entirely, and `Clip::changed()` fires it via `updateLinkedClipsCaller.triggerAsyncUpdate()` (`tracktion_Clip.cpp:352`) so siblings mutate *after* the transaction closed and after `emitSnapshotInvalidated()` went out. Never writing `linkID` also means `isLinked()` (`tracktion_Clip.h:324`) stays permanently false, so the engine's async lane can never arm — that negative invariant is load-bearing and is pinned by a test below.

### Corrections to claims made in the design round

| Claim | Verdict |
|---|---|
| "Only note data propagates" | **FALSE.** `copyFrom` does `state.copyPropertiesFrom (other.state, um)` (`tracktion_MidiList.cpp:1188`), and `initialise` binds `IDs::channelNumber` and `IDs::isComp` on that tree (`:1170-1173`). Propagation silently overwrites each member's MIDI channel and comp flag. **Fixed below** by save/restore. |
| "Unstable `std::sort` breaks note-index parity" (raised as a fatal flaw) | **REFUTED for whole-list copy.** `sortMidiEventsByTime` is a plain `std::sort` on beat only (`tracktion_MidiList.h:174-179`), but `getSortedList()` sorts a copy of `objects` (`:253-267`), and `ValueTreeObjectList::valueTreeChildAdded` appends when the child is last else `addSorted` by tree index (`tracktion_ValueTreeUtilities.h:141-158`) — so `objects` order == child order, always. `addFrom` copies children in source order, so leader and follower feed *identical* input to a deterministic comparator. Parity holds. **This is a decisive argument for whole-list copy over diff-and-patch**, which would *not* have this property. |
| "Recording bypasses the chokepoint" (raised, unverified) | **CONFIRMED AND REACHABLE.** `mergeRecordings` defaults `true` (`tracktion_MidiInputDevice.h:85`, set at `.cpp:366`), and `MidiInputDevice.cpp:716-717` merges a take into an existing clip with no new clip created. Mosh's `cmdStopRecording` detects takes by **diffing clip IDs** (`MoshOps.cpp:5118-5143`) — a merged MIDI recording is invisible to it. **Handled below.** |
| "`remove_clip` leaves a stale group" | **CONFIRMED.** `cmdRemoveClip` (`MoshOps.cpp:4126-4142`) has no link handling. **Fixed below.** |
| "`getSequence()` is a safe accessor" | **FALSE.** It falls back to a **process-global `static MidiList dummyList`** after a `jassertfalse` when `!hasValidSequence()` (`tracktion_MidiClip.cpp:251-258`) — silent in Release. A fanout calling it unguarded on every member could write into shared global state. **Guarded below.** |

---

## 2. State representation

One additive identifier in `/Users/emiliosanchez-harris/Mosh/src/state/Ids.h`, declared next to `moshHidden` (`Ids.h:208`):

```cpp
MOSH_DECLARE_ID (moshLinkGroup)   // linked-duplicate group tag (UUID string); absent ⇒ unique
```

- Written on the **clip's own ValueTree**: `clip->state.setProperty (ids::moshLinkGroup, group, &undoManager())` — the exact idiom already used at `MoshOps.cpp:8418` for `moshHidden`.
- Value: `juce::Uuid().toDashedString()`. Absent **or** empty ⇒ unique. Flat peer membership — no leader record, no ordering.
- Written **with** `&undoManager()` (unlike `moshLogicalId`, which `Ids.h:76-87` documents as identity, not user state). "These clips are linked" is a user decision, so undo must restore it.

**No project-format bump. No snapshot-schema bump.** `kMoshFormatVersion` stays `1`, `kSnapshotSchemaVersion` stays `1`, `migrations()` keeps only its v0→v1 scaffold. This is verbatim the carve-out at `src/state/Migrations.h:22-25`: *"Adding a NEW optional property with a safe absent-default does NOT require a bump."*

Degradation is graceful in both directions. Old file → new build: no property, everything unique, correct. New file → old build: the property is ignored and the clips read as ordinary independent MIDI clips holding identical notes — which is physically what they are on disk, because propagation is a real copy, not a reference. They stop following each other; nothing is corrupted; reopening restores linkage, and the next linked edit self-heals divergence leader-wins. Note this in release copy.

---

## 3. Command surface

**Extend `duplicate_clip`; add exactly one command.**

### `duplicate_clip {clipId, linked?: boolean = false}`
`MoshOps.cpp:4592`. Default `false` ⇒ today's behaviour byte-identical.

Validation, in order:
1. Clip not found ⇒ existing `errResult ("duplicate_clip", "no clip")`.
2. `linked && !dynamic_cast<te::MidiClip*>` ⇒ `errResult ("duplicate_clip", "linked duplicate is MIDI-only")`. Invariant 91 is about note data; wave clips have none.
3. `linked && lockManager.isActive()` ⇒ `errResult ("duplicate_clip", "linked duplicate is not available in a multiplayer session")`. See §8.
4. `linked && source has takes` (`m->getNumTakes() > 1`) ⇒ `errResult ("duplicate_clip", "cannot link a clip with takes")`. `getSequence()` is take-indexed (`tracktion_MidiClip.cpp:262`), so a group spanning differing `currentTake` values would mirror into the wrong take.

On success: reuse the source's `moshLinkGroup` if present (duplicating a linked clip **joins the same group** — matches FL/Logic), else mint one and stamp it on **both** source and copy, inside the existing `beginTxn ("duplicate_clip")` at `:4603`.

Result gains `linked: bool` and `linkGroup: string` beside the existing `newClipId` (`:4630`).

> **Contract-test constraint** (`ui/src/agent/commands.contract.test.ts:59` matches `/args\.(?:getProperty|hasProperty) ?\("([a-zA-Z0-9_]+)"/g`): the read must be **one line, at most one space before the paren**, inside the handler span. Write exactly:
> ```cpp
> const bool linked = (bool) args.getProperty ("linked", false);
> ```
> Wrapping it across lines reds the test on correct C++. Dispatch at `:1145` must keep single spaces around `==`.

### `unlink_clip {clipId}` — NEW, undoable, agent-callable
Clears `moshLinkGroup` on that clip with `&undoManager()`. If exactly one member remains afterwards, clear that member's tag too — a one-member group renders a badge that promises linkage and does nothing. Returns `{remaining: int}`.

Dispatch line must read exactly:
```cpp
if (name == "unlink_clip")    return cmdUnlinkClip (args);
```

**This command is non-negotiable.** Every reference DAW ships link and unlink as a pair (FL "Make unique", Logic "Make Real Copy", Cubase "Convert to Real Copy"), because the workflow that always follows linking is wanting one copy to differ. Shipping a destructive default with no escape is worse than not shipping.

### Agent catalog — `ui/src/agent/commands.ts:39`
```ts
{ command: "duplicate_clip", desc: "Duplicate a clip (linked: note edits follow every copy)",
  args: [S("clipId"), B("linked", false, "share note data with the original")] },
{ command: "unlink_clip", desc: "Break a clip out of its linked group", args: [S("clipId")] },
```
`ArgType` is `string|number|boolean` only (`commands.ts:8`) — a boolean flag is the only expressible shape. Add `unlink_clip` to the summariser (`commands.ts:213`) and to `LockManager.cpp:86`'s scoped set. It does **not** belong in `TASTE_COMMANDS` (`policy.ts:19`) or `smallModel.ts:38` — it is a structural correction, not a taste op. `duplicate_clip` keeps its name, so those three lists need no other change.

---

## 4. Code sites, in build order

**Step 0 — fidelity fix, standalone and independently revertable.**
| # | File:line | Change |
|---|---|---|
| 0.1 | `src/moshops/MoshOps.cpp:4617-4623` | Replace the hand-rolled note loop in the unique MIDI branch with `dst.copyFrom (src, &undoManager());`. Today it copies only pitch/start/length/velocity and silently drops controllers, sysex, quantisation and groove. Since the linked path uses `copyFrom` (which copies **all** children), leaving this would make linked and unique copies disagree about what a "pattern" contains — and a note edit would then propagate CC data the unique copy never had. This is a real behaviour change to a shipped command (strictly more faithful) and gets its own test. |

**Step 1 — state + helpers.**
| # | File:line | Change |
|---|---|---|
| 1.1 | `src/state/Ids.h:208` | Add `MOSH_DECLARE_ID (moshLinkGroup)`. |
| 1.2 | `src/state/ClipLink.h` (new) | Pure header, `DrumPattern.h` precedent (`MoshTests` is engine-free and won't compile `MoshOps.cpp`): `linkGroupOf(ValueTree)`, `isLinkedClip(ValueTree)`, `setLinkGroup/clearLinkGroup(ValueTree, UndoManager*)`, `newLinkGroupId()`. |
| 1.3 | `src/moshops/MoshOps.h` (private, near `beginTxn`:670) | Declare `juce::Array<te::MidiClip*> findLinkGroupMembers (te::MidiClip&);` and `int propagateLinkedNotes (te::MidiClip& leader);`. |
| 1.4 | `src/moshops/MoshOps.cpp` (beside `findClip`:11436) | Implement both — see §5. |

**Step 2 — create/destroy the link.**
| # | File:line | Change |
|---|---|---|
| 2.1 | `MoshOps.cpp:4592-4636` | `linked` arg + validation + group stamping in `cmdDuplicateClip`. |
| 2.2 | `MoshOps.cpp` (new handler) + dispatch beside `:1145` | `cmdUnlinkClip`. |
| 2.3 | `MoshOps.cpp:4117` (`cmdSplitClip`) | **Strip the tag from both halves.** `ClipTrack::splitClip` → `clip.state.createCopy()` (`tracktion_ClipOwner.cpp:667`) and `updateClipState` rewrites only name/start/length/offset/itemID (`:218-228`) — so the split-off half silently inherits the group and the next fanout rewrites it to the full note list. Half a pattern is not the pattern. |
| 2.4 | `MoshOps.cpp:4126-4142` (`cmdRemoveClip`) | **Group teardown.** After `removeFromParent()`, if the removed clip carried a tag and ≤1 member now remains, clear the survivor's tag. Without this, deleting three of four choruses leaves a survivor wearing a chain badge linked to nothing — persisted into the project file. |
| 2.5 | `MoshOps.cpp:4826-4853` (`cmdPasteClip`) | Explicitly do **not** read `linkGroup` from the descriptor. Paste yields a unique clip. Add a comment so a future refactor doesn't "helpfully" honour it. |

**Step 3 — fan the edits out.** Insert `propagateLinkedNotes (*mc);` as the last mutation step, inside the already-open `beginTxn`, immediately before `logLine`:
| # | File:line |
|---|---|
| 3.1 | `cmdAddNote` `MoshOps.cpp:6986` |
| 3.2 | `cmdRemoveNote` `:7005` |
| 3.3 | `cmdSetNote` `:7032` (after the last of the three optional setters) |
| 3.4 | `cmdQuantizeNotes` `:7067` (after the pointer-snapshot loop completes — the loop holds `te::MidiNote*` into the **source**, which `copyFrom` never touches, so this ordering is safe) |
| 3.5 | `cmdAddDrumPattern` `:6497-6512`, the **per-lane-replace branch only** (resolved via the same `targetClip` that already gates `reactiveTouch` at `:6567`) |

The four remaining note-writers create brand-new clips and must **not** propagate (a new clip is never already a member): `cmdDuplicateClip:4623`, `cmdPasteClip:4850`, `cmdAddMidiClip:6421` (also the sink for `cmdTranscribeClip` via the direct call at `:6624`), and `cmdAddDrumPattern`'s new-clip branch `:6545`.

**Step 4 — the recording hole (verified reachable).**
| # | File:line | Change |
|---|---|---|
| 4.1 | `MoshOps.cpp:5140-5143` (`cmdStopRecording`) | After the landed-clip diff, for every clip on an armed track that carries a `moshLinkGroup`, **clear the tag** and report `unlinkedByRecording: [ids]` in the result. Rationale: `mergeRecordings` defaults true, so a MIDI take merges into an existing clip with **no new clip** — invisible to the ID diff — and `stop_recording` is explicitly non-undoable (`:5074`). Silently mirroring an un-undoable overdub across four choruses is worse than breaking the link. See §9 for the alternative. |

**Step 5 — snapshot + UI + mock.** See §6.

---

## 5. Propagation, and why one undo restores every member

```cpp
int MoshOps::propagateLinkedNotes (te::MidiClip& leader)
{
    const auto group = leader.state.getProperty (ids::moshLinkGroup, "").toString();
    if (group.isEmpty()) return 0;                    // fast path: ONE property read, no scan

    if (! leader.hasValidSequence()) return 0;        // never touch the global dummyList
    auto& src = leader.getSequence();

    int updated = 0;
    for (auto* m : findLinkGroupMembers (leader))
    {
        if (m == &leader || ! m->hasValidSequence()) continue;
        if (m->getNumTakes() > 1) continue;            // take-indexed getSequence(); skip, report

        auto& dst = m->getSequence();
        // copyFrom does state.copyPropertiesFrom (MidiList.cpp:1188) and the SEQUENCE tree
        // carries channelNumber + isComp (MidiList.cpp:1170-1173). Those are PER-INSTANCE
        // (a linked part driving a bass and a sub needs its own channel) — save/restore.
        const auto ch   = dst.state.getProperty (te::IDs::channelNumber);
        const auto comp = dst.state.getProperty (te::IDs::isComp);

        dst.copyFrom (src, &undoManager());

        if (! ch.isVoid())   dst.state.setProperty (te::IDs::channelNumber, ch,   &undoManager());
        if (! comp.isVoid()) dst.state.setProperty (te::IDs::isComp,        comp, &undoManager());

        reactiveTouch (m->itemID.toString());
        ++updated;
    }
    return updated;
}
```

`findLinkGroupMembers` scans **exactly** the same set as `findClip` (`MoshOps.cpp:11439`) — `for (auto* t : te::getAudioTracks (eng.edit())) for (auto* c : t->getClips())` — matching the tag, sorted by `itemID.toString()` for deterministic iteration in `--selftest`. Deliberately **not** `Edit::findClipsInLinkGroup` (`tracktion_Edit.cpp:1856-1862`): that walks folder tracks recursively *and* `edit.clipSlotCache`, which would surface clips MoshOps cannot resolve by `clipId` (notably the snapshot-excluded hidden render track, `clipToVar:11013`), and it returns an **empty array** when `treeWatcher == nullptr` — a fail-open that reads as "linking silently stopped working".

**Whole-list copy, not edit replay.** Notes are addressed positionally (`noteIndex` at `:7001`/`:7017`, `i` in the snapshot at `:11078` and `ui/src/types.ts:179`), and Tracktion synchronously re-sorts the live `MidiList` when a note start changes — the warning `cmdQuantizeNotes` already carries at `:7051-7056`. A replay design cannot assume index parity across members. Whole-list copy makes parity *structural*: verified in §1, members get child-for-child identical SEQUENCE trees, and identical input through a deterministic comparator yields identical arrays.

**Undo.** `beginTxn` (`MoshOps.h:670`) calls `undoManager().beginNewTransaction(name)` once per command. The fanout runs after that call and before the handler returns, and every write it makes takes `&undoManager()`: `copyFrom` → `clear(um)` → `state.removeAllChildren(um)`, then `state.copyPropertiesFrom(other.state, um)`, then `addFrom(um)` → `state.addChild(child.createCopy(), -1, um)` (`tracktion_MidiList.cpp:1180-1201`). JUCE coalesces all of it into the one open transaction, so a single Cmd+Z reverts the leader and every follower together. `Clip::getUndoManager()` returns `&edit.getUndoManager()` (`tracktion_Clip.cpp:137-140`) — one UM per Edit, no second stack. Inside an agent batch `beginTxn` no-ops the new transaction, so a multi-edit batch stays one undo step.

Synchronous by construction: the copy completes before `logLine` and `emitSnapshotInvalidated()`, so the snapshot the UI refetches already reflects every member. That is precisely the failure the native async path would have produced.

**Honest audit trail** (a gap in every design): the five affected handlers must return `linkedUpdated: int` (and `linkedSkipped: int` when non-zero, for takes-bearing members), and pass the member ids to `logLine`. A command that rewrites four clips' note lists must not log as touching one — the JSONL is the taste-label corpus and the substrate for the deferred replay-recovery lane.

**Known amplification, accepted:** `reactiveTouch` routes to `renderAheadParamChanged` when that clip is Live-armed (`MoshOps.cpp:8494-8495`), so an N-member group with live re-imagine layers fires N re-lays per note edit. It self-gates to clips that actually own a live layer, and stays Tier B off the audio thread, so the tier wall holds. Calling it per member is *required* — `stableSourceSig` hashes a clip's own notes (`:7657-7672`), so skipping it would leave followers with silently stale generative caches.

---

## 6. Snapshot + UI

**Snapshot** — `clipToVar` (`MoshOps.cpp:11000`), emitted only when set, mirroring the `hidden` idiom at `:11013`:
```cpp
if (auto g = c.state.getProperty (ids::moshLinkGroup, "").toString(); g.isNotEmpty())
    o->setProperty ("linkGroup", g);
```
`ui/src/types.ts:186-229` gains `linkGroup?: string;`. The UI treats it as an **opaque equality token** — it groups by it and never parses it, so no backend concept crosses the seam. Member counts are derived UI-side by scanning `snap.tracks[].clips[]`, not denormalised into the snapshot where they could go stale.

**Creating a link.**
- v2 clip context menu (`ui/src/v2/lanes/ClipView.tsx:194-218`): "Duplicate linked" after the existing "Duplicate", MIDI-only, plus "Unlink" shown only when `clip.linkGroup` (progressive disclosure). Give **both** new items and the existing Duplicate a `data-testid` — Playwright's `getByRole("menuitem", {name})` defaults to case-insensitive **substring**, so a second item containing "Duplicate" turns any `name: "Duplicate"` query into a strict-mode violation.
- Keyboard: **ship it.** `Mod+Shift+D`, verified free — the union of all five presets (`ui/src/interaction/keymap.ts:94-139`) contains no such combo, and no preset uses Alt at all. Requires the full four-part fan-out or it silently no-ops: `EditorAction.DUPLICATE_LINKED` (`interaction/actions.ts:36` — a **new** id, never a rename; values persist in templates/localStorage), `ActionId` (`ui/src/keymap.ts:8-15`), a case in `useKeyboardShortcuts.ts:47`, a `case "duplicate_linked"` in `menuActions.ts:151-153`, and a `KEY_LABELS` entry (`settings/schema.ts:215-220`) or it renders label-less in the rebind UI.
- **Multi-select semantics** (the code does not currently answer this): each selected clip links to **its own** duplicate — N groups of two, never one group of 2N. That is what every reference DAW does, and merging four unrelated clips into one shared note list would be destructive. The top-scoring design declined the keyboard path over this; that was over-caution, and it cost the most-used duplicate gesture.

**Seeing a link.** A chain badge on any clip with `linkGroup`, following the shipped `≈` warp-badge idiom (`warped` class + glyph). **Non-negotiable** — without it, a user edits one clip, three others change, and nothing on screen explains why.

**Dev mock — fix first, it is currently broken.** `ui/src/bridge.mock.ts:1100-1105` always builds a **wave** clip via `waveClip()` and drops notes entirely, and returns `{clipId}` where native returns `{newClipId}` (`MoshOps.cpp:4631`). Since the whole feature *is* MIDI note propagation, dev mode and e2e cannot demonstrate anything until both are fixed. Then add group fanout to all four note cases — `add_note` (`:1786`), `remove_note` (`:1979`), `set_note` (`:1983`), `quantize_notes` (`:1992`) — plus an `unlink_clip` case. Keep command names **string literals** at the call site or `bridge.mock.test.ts`'s drift guard (literals only, `:52-58`) silently stops covering them.

---

## 7. Test plan

**RED first.** In `src/app/SelfTest.cpp`, beside the existing duplicate block (`:1444-1453`):
```
duplicate_clip {clipId: A, linked: true} -> B
add_note {clipId: A, pitch: 64}
CHECK("linked add_note reaches the copy", noteCountOf(B) == 1)
```
Before the helper exists this reads 0 and reds. Then the undo assertion, written before the fanout is moved inside the transaction — implemented naively against `setLinkGroupID` this is the check that goes red, and running that variant *once, deliberately* is worth it to pin why the native path was declined.

**`--selftest` (hermetic — the helper spawns nothing and pumps no dispatch loop; `reactiveTouch` self-gates off without an audio device):**

| Check | RED proof (what you break) |
|---|---|
| Fanout across all five writers, comparing full note **content** not just counts | Remove one `propagateLinkedNotes` call site |
| **One undo restores ALL members**; redo re-applies to all | Pass `nullptr` instead of `&undoManager()` in `copyFrom` — reproduces the native-path bug exactly |
| Negative control: `linked:false` + `add_note` leaves the other clip untouched | Make the group id mint unconditionally |
| Note-index parity: members' `clipToVar` note arrays element-wise equal | Swap `copyFrom` for a per-note replay loop |
| **`channelNumber` / `isComp` stay per-instance** after a fanout | Delete the save/restore — reds, proving the copy carries them |
| Per-instance fields: mute, gain, name, position, length unchanged on followers | Switch to `MidiClip::cloneFrom` — reds on mute/gain (`tracktion_MidiClip.cpp:200-201`) |
| **Negative invariant:** `clip->getLinkGroupID().isEmpty()` on every member after duplicate and after fanout | Call `setLinkGroupID` anywhere — this is the double-apply tripwire |
| 3-member group converges; a note added once appears once | Skip the `m == &leader` self-skip |
| `unlink_clip` stops propagation; last-member-standing clears the orphan tag | Drop the ≤1-member cleanup |
| **`remove_clip` tears the group down** — delete to one survivor, assert no tag | Omit step 2.4 |
| Split unlinks **both** halves | Omit step 2.3 — reds via inherited `createCopy()` state |
| Paste yields a unique clip | Teach `cmdPasteClip` to read `linkGroup` |
| **Cross-track move preserves the link** (the layering case) | Add an auto-unlink on `moveTo` |
| Save → reload → group intact → edit still fans out | Write the tag with `nullptr` UM / a non-persisted store |
| Rejections: wave clip, takes-bearing clip, MP-active session | Remove each guard |
| `linkedUpdated` reported in the result envelope | Return a bare `{noteCount}` |
| Baseline `duplicate_clip` checks (`:1444-1453`) pass **unchanged**, and the whole no-link path is assertion-signature identical to main (A/B via stash-rebuild) | — |

**Catch2** (`tests/test_clip_link.cpp`, against the pure `ClipLink.h`): absent vs empty-string both read unique; tag round-trips through a ValueTree; undo restores the tag; the group predicate excludes the leader and ignores same-id clips outside the scanned set.

**vitest:** mock fanout across all four note cases + `unlink_clip`; the fixed mock MIDI duplicate (notes copied, `newClipId` returned); `bridge.mock.test.ts` drift guard green with `unlink_clip` **cased**, not allowlisted; `commands.contract.test.ts` green — specifically that the `linked` read is single-line with one space before the paren.

**e2e** (`ui/playwright.isolated.config.ts`, port 5191 — mandatory whenever a concurrent worktree owns `:5173`, or the foreign bundle false-fails every spec): duplicate linked from the v2 menu **by testid**, add a note, assert both clips render it, undo once and assert both revert, unlink and assert they diverge.

**Bench, shipped with the feature, not asserted away:** time `quantize_notes` across an 8-member group of 64-note clips via the `__bench_snapshot`-style run-script hook, and record undo memory. See §9.

**Full gate before merge:** `--selftest` ×3 signature-deterministic, Catch2, `verify.py --gate` (golden audio must be unchanged — this touches no render path), DAW-conformance, vitest, e2e isolated, tsc.

---

## 8. Explicitly out of scope for v1

| Deferred | Reason |
|---|---|
| **Multiplayer linked groups** | `clipToVar` will carry `linkGroup` but no MP apply path honours it, and a cross-track fanout mutates clips outside the Clip-scoped lock (`LockManager.cpp:86`). v1 **refuses link creation** while `LockManager::isActive()`. Correct support needs the id in the MP serialise/apply path plus a lock scope that can span tracks — a real piece of work, not a flag. |
| **Paste keeps the link** | `cmdPasteClip` rebuilds from a descriptor; honouring the id there is a deliberate feature ("paste linked"), not a serialisation accident. Ableton users will ask for it. |
| **Linking two pre-existing clips** | Forces "whose notes win?" on divergent content, with no defensible answer. Declining it is what makes every group note-identical at birth. |
| **Shared clip length / loop range** | Ableton links MIDI clip length; we link notes only. Lengthening one member looks divergent on the timeline while the notes agree. Trim is safe today — `cmdTrimClip` (`:4048-4080`) touches position/length/offset only and never the sequence. |
| **Takes** | `getSequence()` is take-indexed (`tracktion_MidiClip.cpp:262`). v1 refuses to link a takes-bearing clip and skips takes-bearing members (reported via `linkedSkipped`). A member can still *gain* takes after linking — see §9. |
| **Propagate-on-record** | `stop_recording` is non-undoable by design; v1 unlinks instead (step 4.1). See the open question in §9. |
| **Alt-drag duplicate gesture** | Alt is free in every keymap *and* every gesture table, and a `mods:{alt:true}` clip-drag rule would out-rank bare MOVE on modifier count (`gestures.ts:67-75`) exactly as `A.STRETCH` out-ranks TRIM. Cheap follow-up, but not in the same PR. |
| **Native macOS Edit-menu item** | Requires a C++ change in `MenuController.cpp:17-22`; the keyboard + context-menu paths cover the feature. |
| **"Revert this copy to the original"** | The group is a symmetric UUID with no leader record. Would need a second property. |

---

## 9. Top three risks

**1. Silent divergence via a writer that bypasses the chokepoint.** The invariant is maintained by discipline at 8 call sites, not by construction — and the engine itself contains note-writers Mosh doesn't route through (`MidiInputDevice.cpp:730/765`, `QuantisationType.cpp`, `EditUtilities.cpp`). The recording merge path is the confirmed live one.
*De-risk:* step 4.1 unlinks on record rather than diverging silently; the leader-wins whole-list copy **self-heals** any divergence on the next linked edit; MP creation is refused. Add a comment block at `propagateLinkedNotes` listing the known external writers so the next contributor adding a note command sees the contract. **Follow-up worth doing:** fold group resolution into a single accessor so "get the sequence" and "get the group" are the same call and forgetting is not expressible — that turns discipline into structure.

**2. Unmeasured cost, and a possible hard undo-history cap.** Every note edit copies the entire sequence into every member: `removeAllChildren` plus one `createCopy`+`addChild` per child, per member. A 500-note clip in a 4-member group turns a one-note edit into ~1500 undo-recorded ValueTree operations. One judge reported that `Edit` sets `undoManager.setMaxNumberOfStoredUnits (1000 * numUndoLevels, numUndoLevels)` with a default of 30 levels — **I did not verify this myself** (see open questions). If true, a single large fanout could evict undo history.
*De-risk:* the unlinked fast path costs one property read, so projects that never link pay zero. Run the §7 bench **before** building step 3, and if the cap is real, add a size guard (refuse to link above N notes × M members, with the threshold from the measurement, not a guess).

**3. Undo across an unlink destroys work.** Unlink, edit the now-independent clip heavily, then undo past the unlink: the group re-forms divergent, and the next edit to any member overwrites the others wholesale. The undo stack is technically consistent and redo is still available, but a producer can lose real editing.
*De-risk:* no clean fix inside this slice. Mitigations: the chain badge reappearing on undo is a visible signal, and the §7 self-heal test pins the behaviour as deterministic rather than random. Name it in the release note. **If the owner wants it closed**, the shape is a content-hash divergence check that refuses to overwrite a diverged member without an explicit "push this one to the group" action — that is a v2 feature, not a patch.

---

## OPEN QUESTIONS — resolve before coding

1. **Undo-size cap.** Verify `setMaxNumberOfStoredUnits` in `tracktion_Edit.cpp` (~:643) and JUCE's `AddOrRemoveChildAction::getSizeInUnits()`. If the ~30,000-unit ceiling is real, risk 2 becomes a design constraint and step 3 needs a size guard. **This is the single unverified claim the plan depends on.**
2. **`te::IDs::channelNumber` / `IDs::isComp` reachability** from `MoshOps.cpp` — confirm the namespace resolves there (they are engine-internal identifiers). If not, reach them by literal `juce::Identifier` names, and pin the spelling with a Catch2 test.
3. **Are MIDI takes reachable in Mosh today?** The mapping says `setCurrentTake`/`deleteAllUnusedTakes` (`:10975`/`:10987`) operate on `WaveAudioClip`. If MIDI takes are unreachable, the takes guards are cheap insurance; if `addTake` fires on MIDI overdub (`MidiInputDevice.cpp:723`), step 4.1 is doing more work than "unlink" and needs a second look.
4. **Owner call on recording:** unlink-on-record (planned, safe) vs propagate-on-record (arguably what a producer wants — record a fill into chorus 1 and hear it in all four). The blocker is that `stop_recording` is non-undoable, so a propagating overdub would be unrecoverable. My recommendation is unlink; this is a taste call.
5. **Confirm the reality-model amendment** (§1a) with the owner before editing `docs/reality-pack/mosh_daw_reality_model.md:154` — the conformance suite reads that file, so the eval row's wording may need to move with it.