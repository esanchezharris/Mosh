#include "SessionRecorder.h"
#include "Lift.h"
#include "MoshIRVocab.h"
#include "state/StateHash.h"

namespace mosh::ir
{
using namespace juce;

namespace
{
    // Commands that never enter the trajectory: pure queries + UI plumbing.
    bool isReadOnly (const String& name)
    {
        return name == "ping" || name == "get_clip_peaks" || name == "get_state_hash"
            || name == "list_plugins" || name == "list_colors"
            || name == "open_plugin_editor"
            // Device prefs are machine-local, not musical actions (Stage 14).
            || name == "list_audio_outputs" || name == "set_audio_output"
            // Playback aids / dialogs, not musical actions (Stage 15).
            || name == "set_metronome" || name == "choose_file"
            // Crate browser (Stage 18) — browsing/audition is not a mutation.
            || name == "list_dir" || name == "audition_file" || name == "stop_audition"
            // Input device pick is machine-local (Stage 19); arming IS recorded.
            || name == "list_audio_inputs" || name == "set_audio_input"
            || name == "get_automation";   // lane reads (Stage 22)
    }
}

SessionRecorder::SessionRecorder (MoshEngine& engineToUse)
    : eng (engineToUse)
{
    loadOrCreateIdentity();
    trajFile = eng.sessionDir().getChildFile ("trajectory.jsonl");

    // Continuation sessions (MOSH_KEEP_SESSION runs, app restarts): step seqs
    // must stay strictly monotonic across processes — collab sync bookmarks
    // its push position by seq.
    if (trajFile.existsAsFile())
    {
        StringArray lines;
        trajFile.readLines (lines);
        for (auto& l : lines)
            if (l.contains ("\"seq\""))
                if (auto rec = JSON::parse (l); rec.getProperty ("type", var()).toString() == "step")
                    stepSeq = jmax (stepSeq, (int64) rec.getProperty ("seq", 0));
    }

    auto* header = new DynamicObject();
    header->setProperty ("type", "session");
    header->setProperty ("traj_id", Uuid().toString());
    header->setProperty ("ir_version", kIrVersion);
    header->setProperty ("mosh_version", String (MOSH_VERSION_STRING)
#ifdef MOSH_GIT_SHA
                                          + "+" + MOSH_GIT_SHA
#endif
                        );
    header->setProperty ("source", "human_session");
    auto* actor = new DynamicObject();
    actor->setProperty ("name", identityVar.getProperty ("name", var()));
    actor->setProperty ("uuid", identityVar.getProperty ("uuid", var()));
    header->setProperty ("actor", var (actor));
    header->setProperty ("consent", identityVar.getProperty ("consent", false));
    header->setProperty ("started_ts", Time::getCurrentTime().toMilliseconds());
    writeLine (header);
}

void SessionRecorder::afterCommand (const String& name, const var& args, const var& result)
{
    if (paused || isReadOnly (name))
        return;

    // ── recorder-directed commands (MoshOps only validates these) ──
    if (name == "set_tutorial")
    {
        auto* l = new DynamicObject();
        l->setProperty ("type", "tutorial");
        l->setProperty ("url", args.getProperty ("url", var()));
        writeLine (l);
        return;
    }
    if (name == "drop_marker")
    {
        auto* l = new DynamicObject();
        l->setProperty ("type", "marker");
        l->setProperty ("video_ts", args.getProperty ("videoTs", var()));
        l->setProperty ("op_seq", stepSeq);          // binds (op index ↔ video time)
        if (auto note = args.getProperty ("note", var()).toString(); note.isNotEmpty())
        {
            l->setProperty ("note", note);
            // Friction notes ARE gap-ledger entries (phase0 §6 tooling).
            const auto overridePath = SystemStats::getEnvironmentVariable ("MOSH_GAP_LEDGER", {});
            auto ledger = overridePath.isNotEmpty() ? File (overridePath)
                                                    : eng.sessionDir().getChildFile ("gap-ledger.jsonl");
            auto* g = new DynamicObject();
            g->setProperty ("ts", Time::getCurrentTime().toMilliseconds());
            g->setProperty ("reason", note);
            g->setProperty ("missing_capability", "friction_note");
            g->setProperty ("op_seq", stepSeq);
            ledger.appendText (JSON::toString (var (g), true) + "\n");
        }
        writeLine (l);
        return;
    }
    if (name == "set_consent")
    {
        const bool consent = (bool) args.getProperty ("consent", false);
        if (auto* o = identityVar.getDynamicObject())
            o->setProperty ("consent", consent);
        saveIdentity();
        auto* l = new DynamicObject();
        l->setProperty ("type", "consent");
        l->setProperty ("consent", consent);
        writeLine (l);
        return;
    }

    // ── ordinary mutation step ──
    const bool ok = (bool) result.getProperty ("ok", false);
    auto* l = new DynamicObject();
    l->setProperty ("type", "step");
    l->setProperty ("seq", ++stepSeq);
    l->setProperty ("ts", Time::getCurrentTime().toMilliseconds());
    l->setProperty ("command", name);
    l->setProperty ("args", args);
    l->setProperty ("ok", ok);
    // Result data (created ids etc.) — the collab rebase remaps ids from it.
    if (auto data = result.getProperty ("data", var()); ! data.isVoid())
        l->setProperty ("data", data);

    if (name == "execute_ir")
    {
        // The corpus view, verbatim — no lift needed.
        l->setProperty ("ir", args.getProperty ("ops", var()));
        l->setProperty ("ir_results", result.getProperty ("data", var()).getProperty ("counts", var()));
    }
    else
    {
        auto lifted = lift (name, args, result, eng.edit());
        if (lifted.isArray() && lifted.size() > 0)
            l->setProperty ("ir", lifted);
    }

    if (ok)
        l->setProperty ("state_hash_after", stateHash (eng.edit()));
    writeLine (l);
}

void SessionRecorder::writeLine (DynamicObject* line)
{
    trajFile.appendText (JSON::toString (var (line), true) + "\n");
}

void SessionRecorder::loadOrCreateIdentity()
{
    const auto overridePath = SystemStats::getEnvironmentVariable ("MOSH_IDENTITY_FILE", {});
    identityFile = overridePath.isNotEmpty()
                       ? File (overridePath)
                       : File::getSpecialLocation (File::userHomeDirectory)
                             .getChildFile (".config/mosh/identity.json");
    if (identityFile.existsAsFile())
    {
        identityVar = JSON::parse (identityFile.loadFileAsString());
        if (identityVar.isObject()) return;
    }
    auto* o = new DynamicObject();
    o->setProperty ("name", SystemStats::getFullUserName());
    o->setProperty ("uuid", Uuid().toString());
    o->setProperty ("consent", false);     // opt-IN: corpus entry needs an explicit flip
    identityVar = var (o);
    saveIdentity();
}

void SessionRecorder::saveIdentity()
{
    identityFile.getParentDirectory().createDirectory();
    identityFile.replaceWithText (JSON::toString (identityVar) + "\n");
}

} // namespace mosh::ir
