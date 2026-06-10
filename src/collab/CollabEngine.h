#pragma once

#include "moshops/MoshOps.h"
#include "moshir/MoshIR.h"
#include "moshir/SessionRecorder.h"

namespace mosh::collab
{
/** Git-style ASYNC session sync ("treat it like GitHub" — NOT real-time).

    The shared session is a git repo at <session>/collab/:
      session.json     — {collab_id, ir_version, created_by}
      oplog.jsonl      — LINEAR append-only log of native steps
                         {n, user, command, args, state_hash_after}
      assets/<sha>.<ext> — content-addressed audio the steps reference

    Linearity is enforced by git itself: push is fast-forward-only, so a
    behind push fails → pull first. Pull with local pending work = a REBASE:
    reset the edit to genesis, replay the remote log (recorder paused — the
    log already owns those steps), then re-execute your pending steps with
    engine-ids REMAPPED via each step's recorded result data (a track you
    created may come back with a different id after the remote ops land
    first). A pending step that fails validation on replay (e.g. it edits a
    clip a collaborator deleted) is a CONFLICT: skipped and reported, never
    silent, session stays consistent. Convergence is verified with the
    Stage 8 canonical state_hash after every pull.

    File args are rewritten on append — paths under the session dir become
    "session://" tokens (peer-relative), other audio is content-addressed
    into assets/ as "collab://assets/<sha>" — and resolved on replay.

    Commands (routed from MoshOps via setCollabHook): collab_init {remote?},
    collab_clone {remote}, collab_status, collab_push, collab_pull. */
class CollabEngine
{
public:
    CollabEngine (MoshOps& ops, MoshEngine& eng, ir::Executor& irExecutor,
                  ir::SessionRecorder& recorder);

    /** The collab_* hook: moshOps.setCollabHook (...) */
    juce::var handle (const juce::String& name, const juce::var& args);

private:
    juce::var init (const juce::var& args);
    juce::var clone (const juce::var& args);
    juce::var status();
    juce::var push();
    juce::var pull();

    // git plumbing
    bool git (const juce::StringArray& argv, juce::String& output);
    juce::File collabDir() const;
    bool isInitialised() const;

    // oplog
    juce::Array<juce::var> readOplog() const;
    void appendOplog (const juce::Array<juce::var>& entries);

    // local sync bookkeeping (NOT committed): how much of MY trajectory has
    // been pushed, and how much of the shared log has been applied.
    juce::var syncState() const;
    void saveSyncState (juce::int64 localSeq, int appliedLogCount);

    // pending local steps (trajectory steps after the last pushed seq)
    juce::Array<juce::var> pendingSteps (juce::int64 afterSeq) const;
    static bool isSyncable (const juce::String& command);

    // replay machinery
    struct ReplayReport { int applied = 0; juce::Array<juce::var> conflicts; };
    ReplayReport replayEntries (const juce::Array<juce::var>& entries,
                                std::map<juce::String, juce::String>& idMap);
    juce::var rewriteIds (const juce::var& args,
                          const std::map<juce::String, juce::String>& idMap) const;
    void captureIdMappings (const juce::var& oldData, const juce::var& newData,
                            std::map<juce::String, juce::String>& idMap) const;

    // asset / path translation
    juce::var outboundArgs (const juce::var& args);      // absolute → tokens (+ asset copy)
    juce::var inboundArgs (const juce::var& args) const; // tokens → absolute

    juce::String stateHashNow();
    juce::String userUuid() const;

    MoshOps& ops;
    MoshEngine& eng;
    ir::Executor& irExec;
    ir::SessionRecorder& recorder;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (CollabEngine)
};

} // namespace mosh::collab
