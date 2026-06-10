#pragma once

#include <map>
#include "moshops/MoshOps.h"
#include "engine/MoshEngine.h"

namespace mosh::ir
{
/** MoshIR v0.1 executor (phase0 spec §3–§4).

    The IR layer sits ABOVE MoshOps: it validates typed ops against the closed
    v0.1 vocabulary (moshir/moshir-0.1.schema.json is the cross-checked source
    of truth; Python validates the full schema, this validates what execution
    needs), lowers each op to native MoshOps commands, and feeds them through
    MoshOps::execute() — the one mutation path is preserved, IR is just another
    caller. Ops that cannot lower return Unsupported{reason} and are appended
    to the gap ledger (JSONL): a feature gap is a *finding*, never a crash.

    Symbolic ids: IR ops carry caller-assigned ids ('t808', 'c808a'); the
    executor owns the binding table (symbol → engine id / file / device slot)
    and persists it in the edit state so bindings survive save/reload. Engine
    ids never appear in IR — that is what keeps the corpus stable across
    engine churn (§3.1.6).

    Determinism: stochastic ops (latent.*, notes.humanize) are hard-rejected
    without a seed — there is NO default seed (§4.3). latent.* additionally
    requires model_version. v0 lowers latent.* to Unsupported (Tier-B wiring
    is Stage 8 harness work). */
class Executor
{
public:
    Executor (MoshOps& opsToUse, MoshEngine& engineToUse);

    /** The `execute_ir` hook: args = { ops: [op...], tutorialId?, dryRun? }.
        Returns { ok, results: [...], counts, irVersion }. Wire it with
        moshOps.setIRHook ([&] (auto& a) { return executor.executeOps (a); }). */
    juce::var executeOps (const juce::var& args);

    /** All op kinds in the closed v0.1 vocabulary (for cheatsheets/tests). */
    static juce::StringArray opKinds();

    /** Where Unsupported ops are appended (JSONL). Defaults to
        <sessionDir>/gap-ledger.jsonl; override with MOSH_GAP_LEDGER. */
    juce::File gapLedgerFile() const { return ledgerFile; }

    /** Drop in-memory bindings and reload from the (possibly replaced) edit
        state. The collab engine calls this after resetEmpty()/clone — stale
        symbol bindings would otherwise reject replayed track.create ops. */
    void resyncBindings()
    {
        bindings.clear();
        nextBusNumber = 1;
        loadBindings();
    }

private:
    struct Binding
    {
        juce::String kind;      // track | clip | asset | device
        juce::String ref;       // engine EditItemID / absolute file path
        juce::String trackRef;  // devices: owning track's engine id
        juce::String type;      // devices: neural | builtin:<t> | external ; tracks: audio|midi|bus
        int index = -1;         // devices: plugin index ; bus tracks: bus number
    };

    juce::var runOp (const juce::var& op, const juce::String& tutorialId);

    // Lowering helpers (each returns a result var via ok()/unsupported()/fail()).
    juce::var lowerDeviceAdd  (const juce::var& p, const juce::String& outSym, const juce::String& tutorialId);
    juce::var lowerAssetResolve (const juce::var& p, const juce::String& outSym, const juce::String& tutorialId);
    juce::var lowerMixerSend  (const juce::var& p, const juce::String& tutorialId);
    juce::var lowerSidechain  (const juce::var& p, const juce::String& tutorialId);

    // Native dispatch through the one mutation path.
    juce::var run (const juce::String& command, juce::DynamicObject* args);
    static bool succeeded (const juce::var& result);

    // Binding table.
    bool bindingExists (const juce::String& sym) const { return bindings.count (sym) > 0; }
    const Binding* find (const juce::String& sym, const juce::String& kind) const;
    void bind (const juce::String& sym, Binding b);
    void loadBindings();
    void saveBindings();

    // Musical-time conversions (read-only engine access).
    double beatsPerBar() const;
    double barToBeats (int bar) const     { return (double) (bar - 1) * beatsPerBar(); }
    double beatsToSeconds (double beats) const;
    static double gridToBeats (const juce::String& grid);
    static int parsePitch (const juce::var& pitch);   // "Eb1" | 0–127 → MIDI, -1 = bad

    // Gap ledger.
    void ledger (const juce::var& op, const juce::String& reason,
                 const juce::String& missingCapability, const juce::String& tutorialId);

    // Result envelopes (per-op).
    static juce::var okOp (const juce::String& kind, const juce::StringArray& commands,
                           juce::var data = {});
    static juce::var failOp (const juce::String& kind, const juce::String& stage,
                             const juce::String& error);
    juce::var unsupportedOp (const juce::var& op, const juce::String& reason,
                             const juce::String& missing, const juce::String& tutorialId);

    MoshOps& ops;
    MoshEngine& eng;
    std::map<juce::String, Binding> bindings;
    juce::File ledgerFile;
    int nextBusNumber = 1;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (Executor)
};

} // namespace mosh::ir
