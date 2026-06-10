#pragma once

#include "engine/MoshEngine.h"

namespace mosh::ir
{
/** The op logger / session recorder (phase0 §5 + §6) — a PRODUCT feature, not
    lab tooling: every session always records, with a per-user consent flag
    gating whether it may ever enter the training corpus.

    Observes MoshOps::execute() at depth 0 (wired via setCommandObserver — the
    same hook pattern as the IR executor, so MoshOps stays layer-clean) and
    appends to <session>/trajectory.jsonl:

      {type:"session", traj_id, ir_version, mosh_version, source, actor,
       consent, started_ts}                                  — one header line
      {type:"step", seq, command, args, ok, ir:[...],
       state_hash_after?, ts}                                — per mutation
      {type:"tutorial", url}                                 — tutorial binding
      {type:"marker", video_ts, op_seq, note?}               — op↔video anchor
      {type:"consent", consent}                              — consent change

    execute_ir steps record the IR ops VERBATIM (the corpus view needs no
    lift); native commands get a best-effort lift() plus the exact native
    record. Markers' friction notes append to the gap ledger.

    Identity: MOSH_IDENTITY_FILE or ~/.config/mosh/identity.json —
    {name, uuid, consent}; created on first run with consent=false (opt-IN:
    nothing enters the corpus until the user flips it). */
class SessionRecorder
{
public:
    explicit SessionRecorder (MoshEngine& engineToUse);

    /** Wire as: moshOps.setCommandObserver ([&] (n, a, r) { rec.afterCommand (n, a, r); }); */
    void afterCommand (const juce::String& name, const juce::var& args, const juce::var& result);

    juce::var identity() const { return identityVar; }
    juce::File trajectoryFile() const { return trajFile; }

    /** Collab replay suppression: replayed ops are already in the shared log —
        recording them again would duplicate history on the next push. */
    void setPaused (bool p) { paused = p; }

private:
    void writeLine (juce::DynamicObject* line);
    void loadOrCreateIdentity();
    void saveIdentity();

    MoshEngine& eng;
    juce::File trajFile;
    juce::File identityFile;
    juce::var identityVar;
    juce::int64 stepSeq = 0;
    bool paused = false;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (SessionRecorder)
};

} // namespace mosh::ir
