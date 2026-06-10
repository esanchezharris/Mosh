#include "CollabEngine.h"
#include "state/StateHash.h"
#include <juce_cryptography/juce_cryptography.h>
#include <map>

namespace mosh::collab
{
using namespace juce;

namespace
{
    DynamicObject* obj() { return new DynamicObject(); }

    // Args keys that hold engine ids (the remap surface for rebase).
    const char* const kIdKeys[] = { "trackId", "clipId", "destTrackId", "sourceTrackId" };
    // Args keys that hold file paths (the asset-translation surface).
    const char* const kFileKeys[] = { "file", "initFile" };
}

CollabEngine::CollabEngine (MoshOps& opsToUse, MoshEngine& engToUse,
                            ir::Executor& irExecutor, ir::SessionRecorder& rec)
    : ops (opsToUse), eng (engToUse), irExec (irExecutor), recorder (rec)
{
}

juce::var CollabEngine::handle (const String& name, const var& args)
{
    if (name == "collab_init")   return init (args);
    if (name == "collab_clone")  return clone (args);
    if (name == "collab_status") return status();
    if (name == "collab_push")   return push();
    if (name == "collab_pull")   return pull();
    return MoshOps::errResult (name, "unknown collab command");
}

// ─────────────────────────────────────────────────────────────────────────────
// git plumbing
// ─────────────────────────────────────────────────────────────────────────────
File CollabEngine::collabDir() const   { return eng.sessionDir().getChildFile ("collab"); }
bool CollabEngine::isInitialised() const { return collabDir().getChildFile (".git").isDirectory(); }

bool CollabEngine::git (const StringArray& argv, String& output)
{
    StringArray full { "git", "-C", collabDir().getFullPathName() };
    full.addArray (argv);
    ChildProcess p;
    if (! p.start (full, ChildProcess::wantStdOut | ChildProcess::wantStdErr))
    {
        output = "failed to launch git";
        return false;
    }
    output = p.readAllProcessOutput();
    return p.waitForProcessToFinish (30000) && p.getExitCode() == 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// init / clone
// ─────────────────────────────────────────────────────────────────────────────
juce::var CollabEngine::init (const var& args)
{
    if (isInitialised()) return MoshOps::errResult ("collab_init", "already initialised");
    auto dir = collabDir();
    dir.getChildFile ("assets").createDirectory();

    auto* meta = obj();
    meta->setProperty ("collab_id", Uuid().toString());
    meta->setProperty ("ir_version", "0.1");
    meta->setProperty ("created_by", userUuid());
    dir.getChildFile ("session.json").replaceWithText (JSON::toString (var (meta)) + "\n");
    dir.getChildFile ("oplog.jsonl").replaceWithText ("");

    String out;
    if (! git ({ "init", "-b", "main" }, out))           return MoshOps::errResult ("collab_init", "git init failed: " + out);
    git ({ "config", "user.email", "mosh@local" }, out);
    git ({ "config", "user.name", "Mosh (" + userUuid().substring (0, 8) + ")" }, out);
    if (! git ({ "add", "-A" }, out))                    return MoshOps::errResult ("collab_init", out);
    if (! git ({ "commit", "-m", "session genesis" }, out)) return MoshOps::errResult ("collab_init", out);

    const auto remote = args.getProperty ("remote", var()).toString();
    if (remote.isNotEmpty())
    {
        if (! git ({ "remote", "add", "origin", remote }, out)) return MoshOps::errResult ("collab_init", out);
        if (! git ({ "push", "-u", "origin", "main" }, out))    return MoshOps::errResult ("collab_init", "push failed: " + out);
    }
    saveSyncState (0, 0);
    // Everything in the trajectory so far predates the share — push it now so
    // the genesis share contains the current session.
    return push();
}

juce::var CollabEngine::clone (const var& args)
{
    const auto remote = args.getProperty ("remote", var()).toString();
    if (remote.isEmpty()) return MoshOps::errResult ("collab_clone", "missing 'remote'");
    if (isInitialised()) return MoshOps::errResult ("collab_clone", "already initialised");

    // Clone into the collab dir (git requires an empty target).
    collabDir().deleteRecursively();
    ChildProcess p;
    StringArray argv { "git", "clone", remote, collabDir().getFullPathName() };
    if (! p.start (argv, ChildProcess::wantStdOut | ChildProcess::wantStdErr))
        return MoshOps::errResult ("collab_clone", "failed to launch git");
    const auto out = p.readAllProcessOutput();
    if (! p.waitForProcessToFinish (60000) || p.getExitCode() != 0)
        return MoshOps::errResult ("collab_clone", "git clone failed: " + out);

    // Materialize: replay the whole shared log from genesis.
    eng.resetEmpty();
    irExec.resyncBindings();
    auto entries = readOplog();
    std::map<String, String> idMap;
    recorder.setPaused (true);
    auto report = replayEntries (entries, idMap);
    recorder.setPaused (false);
    saveSyncState (0, entries.size());

    auto* d = obj();
    d->setProperty ("applied", report.applied);
    d->setProperty ("conflicts", report.conflicts);
    d->setProperty ("state_hash", stateHashNow());
    return MoshOps::okResult ("collab_clone", var (d));
}

// ─────────────────────────────────────────────────────────────────────────────
// status / push / pull
// ─────────────────────────────────────────────────────────────────────────────
juce::var CollabEngine::status()
{
    if (! isInitialised()) return MoshOps::errResult ("collab_status", "not a collab session (collab_init/clone first)");
    String out;
    git ({ "fetch", "origin" }, out);
    String counts;
    const bool haveUpstream = git ({ "rev-list", "--left-right", "--count", "main...origin/main" }, counts);
    int ahead = 0, behind = 0;
    if (haveUpstream)
    {
        auto tokens = StringArray::fromTokens (counts.trim(), "\t ", {});
        ahead = tokens[0].getIntValue();
        behind = tokens.size() > 1 ? tokens[1].getIntValue() : 0;
    }
    auto sync = syncState();
    auto* d = obj();
    d->setProperty ("ahead", ahead);
    d->setProperty ("behind", behind);
    d->setProperty ("pendingLocal", pendingSteps ((int64) sync.getProperty ("localSeq", 0)).size());
    d->setProperty ("appliedLog", sync.getProperty ("appliedLog", 0));
    d->setProperty ("state_hash", stateHashNow());
    return MoshOps::okResult ("collab_status", var (d));
}

juce::var CollabEngine::push()
{
    if (! isInitialised()) return MoshOps::errResult ("collab_push", "not a collab session");
    auto sync = syncState();
    const auto lastPushed = (int64) sync.getProperty ("localSeq", 0);
    auto pending = pendingSteps (lastPushed);

    String out;
    git ({ "fetch", "origin" }, out);
    String counts;
    if (git ({ "rev-list", "--count", "main..origin/main" }, counts)
        && counts.trim().getIntValue() > 0)
        return MoshOps::errResult ("collab_push", "behind origin: collab_pull first (linear history)");

    if (! pending.isEmpty())
    {
        auto entries = readOplog();
        int n = entries.size();
        Array<var> outEntries;
        int64 maxSeq = lastPushed;
        for (auto& step : pending)
        {
            auto* e = obj();
            e->setProperty ("n", ++n);
            e->setProperty ("user", userUuid());
            e->setProperty ("command", step.getProperty ("command", var()));
            e->setProperty ("args", outboundArgs (step.getProperty ("args", var())));
            e->setProperty ("state_hash_after", step.getProperty ("state_hash_after", var()));
            outEntries.add (var (e));
            maxSeq = jmax (maxSeq, (int64) step.getProperty ("seq", 0));
        }
        appendOplog (outEntries);
        saveSyncState (maxSeq, n);
    }

    if (! git ({ "add", "-A" }, out))                       return MoshOps::errResult ("collab_push", out);
    String st;
    git ({ "status", "--porcelain" }, st);
    if (st.trim().isNotEmpty())
        if (! git ({ "commit", "-m", "ops from " + userUuid().substring (0, 8) }, out))
            return MoshOps::errResult ("collab_push", out);
    String remotes;
    if (git ({ "remote" }, remotes) && remotes.trim().isNotEmpty())
        if (! git ({ "push", "origin", "main" }, out))
            return MoshOps::errResult ("collab_push", "push rejected: " + out + " — collab_pull first");

    auto* d = obj();
    d->setProperty ("pushed", pending.size());
    d->setProperty ("state_hash", stateHashNow());
    return MoshOps::okResult ("collab_push", var (d));
}

juce::var CollabEngine::pull()
{
    if (! isInitialised()) return MoshOps::errResult ("collab_pull", "not a collab session");
    auto sync = syncState();
    const auto lastPushed = (int64) sync.getProperty ("localSeq", 0);
    const int appliedLog = (int) sync.getProperty ("appliedLog", 0);
    auto pending = pendingSteps (lastPushed);

    String out;
    if (! git ({ "pull", "--ff-only", "origin", "main" }, out))
        return MoshOps::errResult ("collab_pull", "ff-only pull failed: " + out);

    auto entries = readOplog();
    if (entries.size() < appliedLog)
        return MoshOps::errResult ("collab_pull", "shared log shrank — refusing (history must be append-only)");

    Array<var> fresh;
    for (int i = appliedLog; i < entries.size(); ++i)
        fresh.add (entries[i]);

    ReplayReport report;
    std::map<String, String> idMap;
    Array<var> survivors;       // pending steps that re-executed cleanly
    recorder.setPaused (true);
    if (pending.isEmpty())
    {
        // Fast-forward: apply only the new remote entries on top.
        report = replayEntries (fresh, idMap);
    }
    else
    {
        // REBASE: genesis → full shared log → re-execute pending ONE AT A
        // TIME with id remap. Only survivors enter the shared log — a step
        // that fails on rebase (its target was deleted upstream, etc.) is a
        // CONFLICT: reported, kept in the local trajectory for the record,
        // but never pushed (dead ops must not pollute every peer's replay).
        eng.resetEmpty();
        irExec.resyncBindings();
        auto base = replayEntries (entries, idMap);
        report.applied = base.applied;
        report.conflicts.addArray (base.conflicts);
        for (auto& step : pending)
        {
            auto* e = obj();
            e->setProperty ("command", step.getProperty ("command", var()));
            e->setProperty ("args", step.getProperty ("args", var()));
            e->setProperty ("data", step.getProperty ("data", var()));
            Array<var> one;
            one.add (var (e));
            auto re = replayEntries (one, idMap);
            if (re.applied == 1)
            {
                ++report.applied;
                survivors.add (step);
            }
            else
                report.conflicts.addArray (re.conflicts);
        }
    }
    recorder.setPaused (false);
    saveSyncState (lastPushed, entries.size());

    if (! pending.isEmpty())
    {
        // Append the rebased SURVIVORS now (their canonical, id-remapped
        // form), and advance the push bookmark past every pending step —
        // survivors are in the log, conflicted steps are dropped from sync
        // (a later push must not resurrect them with stale ids).
        auto entriesNow = readOplog();
        int n = entriesNow.size();
        Array<var> outEntries;
        int64 maxSeq = lastPushed;
        for (auto& step : pending)
            maxSeq = jmax (maxSeq, (int64) step.getProperty ("seq", 0));
        for (auto& step : survivors)
        {
            auto* e = obj();
            e->setProperty ("n", ++n);
            e->setProperty ("user", userUuid());
            e->setProperty ("command", step.getProperty ("command", var()));
            e->setProperty ("args", outboundArgs (rewriteIds (step.getProperty ("args", var()), idMap)));
            e->setProperty ("state_hash_after", var());
            outEntries.add (var (e));
        }
        if (! outEntries.isEmpty())
            appendOplog (outEntries);
        saveSyncState (maxSeq, n);
        String aout;
        git ({ "add", "-A" }, aout);
        git ({ "commit", "-m", "rebased ops from " + userUuid().substring (0, 8) }, aout);
    }

    auto* d = obj();
    d->setProperty ("applied", report.applied);
    d->setProperty ("conflicts", report.conflicts);
    d->setProperty ("rebasedPending", pending.size());
    d->setProperty ("state_hash", stateHashNow());
    return MoshOps::okResult ("collab_pull", var (d));
}

// ─────────────────────────────────────────────────────────────────────────────
// oplog + sync state
// ─────────────────────────────────────────────────────────────────────────────
Array<var> CollabEngine::readOplog() const
{
    Array<var> entries;
    StringArray lines;
    collabDir().getChildFile ("oplog.jsonl").readLines (lines);
    for (auto& l : lines)
        if (l.trim().isNotEmpty())
            entries.add (JSON::parse (l));
    return entries;
}

void CollabEngine::appendOplog (const Array<var>& entries)
{
    auto f = collabDir().getChildFile ("oplog.jsonl");
    String text;
    for (auto& e : entries)
        text << JSON::toString (e, true) << "\n";
    f.appendText (text);
}

juce::var CollabEngine::syncState() const
{
    // .sync.json is local bookkeeping — never committed (.gitignore'd).
    auto f = collabDir().getChildFile (".sync.json");
    return f.existsAsFile() ? JSON::parse (f.loadFileAsString()) : var (obj());
}

void CollabEngine::saveSyncState (int64 localSeq, int appliedLogCount)
{
    auto gi = collabDir().getChildFile (".gitignore");
    if (! gi.existsAsFile()) gi.replaceWithText (".sync.json\n.gitignore\n");
    auto* o = obj();
    o->setProperty ("localSeq", localSeq);
    o->setProperty ("appliedLog", appliedLogCount);
    collabDir().getChildFile (".sync.json").replaceWithText (JSON::toString (var (o)) + "\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// pending steps from the trajectory
// ─────────────────────────────────────────────────────────────────────────────
bool CollabEngine::isSyncable (const String& command)
{
    // State-affecting commands only. Playback, queries, markers, consent and
    // renders-to-file stay local; undo/redo ARE state and replay as such.
    static const StringArray excluded {
        "set_transport", "save", "reload", "export_audio", "render_layer",
        "cancel_render", "open_plugin_editor", "set_tutorial", "drop_marker",
        "set_consent", "generate_asset", "agent_propose",
        "collab_init", "collab_clone", "collab_status", "collab_push", "collab_pull",
    };
    return ! excluded.contains (command);
}

Array<var> CollabEngine::pendingSteps (int64 afterSeq) const
{
    Array<var> pending;
    StringArray lines;
    recorder.trajectoryFile().readLines (lines);
    for (auto& l : lines)
    {
        if (l.trim().isEmpty()) continue;
        auto rec = JSON::parse (l);
        if (rec.getProperty ("type", var()).toString() != "step") continue;
        if ((int64) rec.getProperty ("seq", 0) <= afterSeq) continue;
        if (! (bool) rec.getProperty ("ok", false)) continue;
        if (! isSyncable (rec.getProperty ("command", var()).toString())) continue;
        pending.add (rec);
    }
    return pending;
}

// ─────────────────────────────────────────────────────────────────────────────
// replay + id remap + asset translation
// ─────────────────────────────────────────────────────────────────────────────
CollabEngine::ReplayReport CollabEngine::replayEntries (const Array<var>& entries,
                                                        std::map<String, String>& idMap)
{
    ReplayReport report;
    for (auto& e : entries)
    {
        const auto command = e.getProperty ("command", var()).toString();
        auto args = inboundArgs (rewriteIds (e.getProperty ("args", var()), idMap));

        auto* c = obj();
        c->setProperty ("command", command);
        c->setProperty ("args", args);
        auto result = ops.execute (var (c));

        if ((bool) result.getProperty ("ok", false))
        {
            ++report.applied;
            captureIdMappings (e.getProperty ("data", var()),
                               result.getProperty ("data", var()), idMap);
        }
        else
        {
            auto* conflict = obj();
            conflict->setProperty ("command", command);
            conflict->setProperty ("args", args);
            conflict->setProperty ("error", result.getProperty ("error", var()));
            report.conflicts.add (var (conflict));
        }
    }
    return report;
}

juce::var CollabEngine::rewriteIds (const var& args,
                                    const std::map<String, String>& idMap) const
{
    if (idMap.empty() || ! args.isObject()) return args;
    auto* o = args.getDynamicObject();
    auto* rewritten = obj();
    for (auto& prop : o->getProperties())
    {
        auto value = prop.value;
        for (auto* key : kIdKeys)
            if (prop.name == Identifier (key))
                if (auto it = idMap.find (value.toString()); it != idMap.end())
                    value = it->second;
        rewritten->setProperty (prop.name, value);
    }
    return var (rewritten);
}

void CollabEngine::captureIdMappings (const var& oldData, const var& newData,
                                      std::map<String, String>& idMap) const
{
    if (! oldData.isObject() || ! newData.isObject()) return;
    for (auto* key : { "trackId", "clipId", "newClipId" })
    {
        const auto oldId = oldData.getProperty (key, var()).toString();
        const auto newId = newData.getProperty (key, var()).toString();
        if (oldId.isNotEmpty() && newId.isNotEmpty() && oldId != newId)
            idMap[oldId] = newId;
    }
}

juce::var CollabEngine::outboundArgs (const var& args)
{
    if (! args.isObject()) return args;
    auto* o = args.getDynamicObject();
    auto* rewritten = obj();
    for (auto& prop : o->getProperties())
    {
        auto value = prop.value;
        bool isFileKey = false;
        for (auto* key : kFileKeys) isFileKey = isFileKey || prop.name == Identifier (key);
        if (isFileKey)
        {
            // Content-address EVERY referenced audio file into the shared
            // assets dir — peers never have our local paths (generated tones,
            // renders, user samples all travel by content, spec §5 storage).
            File src (value.toString());
            if (src.existsAsFile())
            {
                MemoryBlock mb;
                src.loadFileAsData (mb);
                const auto sha = SHA256 (mb).toHexString();
                auto dest = collabDir().getChildFile ("assets")
                                .getChildFile (sha + src.getFileExtension());
                if (! dest.existsAsFile()) src.copyFileTo (dest);
                value = "collab://assets/" + dest.getFileName();
            }
        }
        rewritten->setProperty (prop.name, value);
    }
    return var (rewritten);
}

juce::var CollabEngine::inboundArgs (const var& args) const
{
    if (! args.isObject()) return args;
    auto* o = args.getDynamicObject();
    auto* rewritten = obj();
    for (auto& prop : o->getProperties())
    {
        auto value = prop.value;
        const auto s = value.toString();
        if (s.startsWith ("session://"))
            value = eng.sessionDir().getChildFile (s.substring (10)).getFullPathName();
        else if (s.startsWith ("collab://"))
            value = collabDir().getChildFile (s.substring (9)).getFullPathName();
        rewritten->setProperty (prop.name, value);
    }
    return var (rewritten);
}

juce::String CollabEngine::stateHashNow()
{
    return stateHash (eng.edit());
}

juce::String CollabEngine::userUuid() const
{
    return recorder.identity().getProperty ("uuid", "unknown").toString();
}

} // namespace mosh::collab
