#include "MoshOps.h"
#include "state/RenderLayer.h"
#include "engine/SourceRef.h"
#include "engine/RenderArtifacts.h"
#include "generative/DirectRenderJob.h"

namespace mosh
{
using namespace juce;
namespace
{
const Identifier policy ("decisionPolicy"), committed ("committedArtifact"), anchor ("directCommittedAnchor"),
    pending ("hasPending"), request ("requestId"), jobIdProperty ("jobId"), audition ("audition"),
    pendingShape ("directPendingShape"), pendingStart ("directSourceStart"), provenance ("directManifest"),
    fixtureProperty ("testFixture");

bool explicitLayer (const ValueTree& node) { return node[policy].toString() == "explicit"; }
bool fixtureEnabled()
{
    return SystemStats::getEnvironmentVariable ("MOSH_DIRECT_RENDER_TEST_FIXTURE", "0") == "1"
        && SystemStats::getEnvironmentVariable ("MOSH_SELFTEST_SESSION", {}).isNotEmpty();
}
String unsupported (const te::WaveAudioClip& clip)
{
    if (clip.isLooping() || clip.getAutoTempo() || clip.getWarpTime() || clip.getIsReversed()
        || clip.getAutoPitch() || std::abs (clip.getSpeedRatio() - 1.0) > 1.0e-8)
        return "Direct Re-Imagine needs a non-looping, unwarped, unreversed audio clip at its original speed. Bounce this material first.";
    return {};
}
String shape (const te::WaveAudioClip& clip, const ValueTree& layer)
{
    const auto p = clip.getPosition();
    return clip.itemID.toString() + ":" + clip.getTrack()->itemID.toString()
        + ":" + String (p.getStart().inSeconds(), 12) + ":" + String (p.getLength().inSeconds(), 12)
        + ":" + String (p.getOffset().inSeconds(), 12) + ":" + String (clip.getSpeedRatio(), 12)
        + ":" + String (int (clip.isLooping())) + String (int (clip.getAutoTempo())) + String (int (clip.getWarpTime()))
        + String (int (clip.getIsReversed())) + String (int (clip.getAutoPitch()))
        + ":" + layer[ids::seed].toString() + ":" + layer.getChildWithName (ids::PARAMS).toXmlString();
}
void pointSource (te::WaveAudioClip& clip, const File& file, double offset, const File& parent)
{
    auto& source = clip.getSourceFileReference().source;
    source.setValue (file.isAChildOf (parent)
        ? file.getRelativePathFrom (parent).replaceCharacter ('\\', '/') : file.getFullPathName(), nullptr);
    clip.sourceMediaChanged();
    // Monitoring and the custom undo action must not create a second undo step.
    clip.state.setProperty (te::IDs::offset, offset, nullptr);
}
struct SourceAction final : UndoableAction
{
    te::Edit& edit;
    te::EditItemID clipId;
    File before, after, parent;
    double beforeOffset, afterOffset;
    SourceAction (te::WaveAudioClip& clip, File destination, double offset, File directory)
        : edit (clip.edit), clipId (clip.itemID), before (clip.getCurrentSourceFile()), after (destination), parent (directory),
          beforeOffset (clip.getPosition().getOffset().inSeconds()), afterOffset (offset) {}
    bool set (const File& file, double offset)
    {
        if (auto* clip = dynamic_cast<te::WaveAudioClip*> (te::findClipForID (edit, clipId)); clip && file.existsAsFile())
        { pointSource (*clip, file, offset, parent); return true; }
        return false;
    }
    bool perform() override { return set (after, afterOffset); }
    bool undo() override { return set (before, beforeOffset); }
};
}

struct MoshOps::DirectRenderRequest
{
    DirectRenderJob work;
    ValueTree edit, clip, layer;
    String shapeAtSubmit, lastStatus, lastJobId;
    int64 sourceSize = 0, sourceModified = 0;
};
struct MoshOps::DirectAudition
{
    ValueTree edit, clip, layer;
    File source;
    double offset = 0;
};

std::function<var (const var&)> MoshOps::generativeReadHandler()
{
    return [manager = jobManagerOwner_] (const var& command)
    {
        const auto name = command.getProperty ("command", {}).toString();
        if (name != "list_colors" && name != "list_loras") return errResult (name, "Not a generative read command.");
        if (! manager->ensureServiceRunning()) return errResult (name, "Local generative service unavailable.");
        auto data = name == "list_colors" ? manager->listColors() : manager->listLoras();
        if (! (bool) data.getProperty ("ok", false)) return errResult (name, "Local service capability could not be read.");
        if (name == "list_colors" && fixtureEnabled())
        { data.getDynamicObject()->setProperty ("testFixture", true);  }
        return okResult (name, data);
    };
}

var MoshOps::createDirectRenderLayer (const var& args)
{
    const auto clipId = args.getProperty ("clipId", {}).toString();
    auto* clip = dynamic_cast<te::WaveAudioClip*> (findClip (clipId));
    if (! clip) return errResult ("create_render_layer", "Select one audio clip for Re-Imagine.");
    if (findRenderLayer (clipId).isValid()) return errResult ("create_render_layer", "This clip already has a render layer.");
    if (const auto reason = unsupported (*clip); reason.isNotEmpty()) return errResult ("create_render_layer", reason);
    if (args.hasProperty ("regionStart") || args.hasProperty ("regionEnd")) return errResult ("create_render_layer", "Direct Re-Imagine processes the full selected clip.");
    if (args.getProperty ("adapter", "stable_audio3").toString() != "stable_audio3") return errResult ("create_render_layer", "Direct Re-Imagine requires local SA3.");
    const auto source = clip->getCurrentSourceFile();
    if (! source.existsAsFile()) return errResult ("create_render_layer", "The selected clip's source audio is missing.");
    const auto p = clip->getPosition();
    auto layer = RenderLayer::create ("rl-" + Uuid().toString(), clipId, p.getStart().inSeconds(), p.getEnd().inSeconds(), "stable_audio3");
    layer.setProperty (policy, "explicit", nullptr);
    layer.setProperty (ids::modelVariant, "sa3-medium", nullptr);
    layer.setProperty (ids::mode, "reimagine", nullptr);
    layer.setProperty (ids::reactive, false, nullptr);
    layer.setProperty (ids::originalSourceRef, source.getFullPathName(), nullptr);
    layer.setProperty (committed, source.getFullPathName(), nullptr);
    layer.setProperty (anchor, 0.0, nullptr);
    layer.setProperty (fixtureProperty, fixtureEnabled(), nullptr);
    beginTxn ("create_render_layer");
    clip->state.appendChild (layer, &undoManager());
    logLine ("create_render_layer", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject(); data->setProperty ("layerId", layer[ids::id]);
    return okResult ("create_render_layer", var (data));
}

void MoshOps::restoreDirectAuditions()
{
    for (auto& [id, saved] : directAuditions_)
    {
        if (saved->edit != eng.edit().state) continue;
        if (auto* clip = dynamic_cast<te::WaveAudioClip*> (findClip (id)); clip && clip->state == saved->clip)
            pointSource (*clip, saved->source, saved->offset, eng.editFile().getParentDirectory());
        saved->layer.setProperty (audition, "committed", nullptr);
    }
    if (! directAuditions_.empty()) emitSnapshotInvalidated();
    directAuditions_.clear();
}

void MoshOps::cancelDirectRenders (const String& reason)
{
    for (auto& [id, entry] : directRenders_)
    {
        entry->work.cancelled = true;
        if (entry->edit == eng.edit().state && findRenderLayer (id) == entry->layer)
        { entry->layer.setProperty (ids::status, "cancelled", nullptr); entry->layer.setProperty (ids::renderError, reason, nullptr); }
    }
    directRenders_.clear();
}

void MoshOps::prepareDirectCommand (const var& command)
{
    const auto name = command.getProperty ("command", {}).toString();
    // Read/transport operations retain monitoring. Any edit restores committed material first.
    if (name.startsWith ("get_") || name.startsWith ("list_") || name == "set_transport" || name == "bypass_layer") return;
    restoreDirectAuditions();
    if (name == "undo" || name == "redo" || name == "jump_to_history" || name == "open_project"
        || name == "new_project" || name == "save_as" || name == "reload" || name == "recover_session")
        cancelDirectRenders ("Result application cancelled by undo or project change. Inference may continue.");
}

var MoshOps::submitDirectRender (const var& args)
{
    const auto id = args.getProperty ("clipId", {}).toString();
    auto* clip = dynamic_cast<te::WaveAudioClip*> (findClip (id));
    auto layer = findRenderLayer (id);
    if (! clip || ! explicitLayer (layer)) return errResult ("render_layer", "No direct audio render layer.");
    if (const auto reason = unsupported (*clip); reason.isNotEmpty()) return errResult ("render_layer", reason);
    if ((bool) args.getProperty ("wait", false) && eng.hasAudio()) return errResult ("render_layer", "Interactive generation is asynchronous.");
    if (directRenders_.count (id)) return errResult ("render_layer", "A generation is already active for this clip.");
    const auto parent = eng.editFile().getParentDirectory();
    if (clip->getCurrentSourceFile() != resolveCacheArtifact (layer[committed].toString(), parent))
        return errResult ("render_layer", "Clip source changed. Remove this layer and prepare Re-Imagine again.");
    const auto parameters = layer.getChildWithName (ids::PARAMS);
    const auto prompt = parameters[ids::prompt].toString().trim();
    if (prompt.isEmpty()) return errResult ("render_layer", "Enter a prompt first.");
    auto entry = std::make_shared<DirectRenderRequest>();
    auto& work = entry->work;
    work.source = resolveCacheArtifact (layer[ids::originalSourceRef].toString(), parent);
    if (! work.source.existsAsFile()) return errResult ("render_layer", "Original source audio is missing.");
    work.sourceStart = (double) layer[anchor] + clip->getPosition().getOffset().inSeconds();
    work.duration = clip->getPosition().getLength().inSeconds();
    if (work.duration < 2 || work.duration > 240) return errResult ("render_layer", "Direct Re-Imagine currently supports audio clips from 2 to 240 seconds.");
    work.requestId = Uuid().toString();
    work.directory = eng.sessionDir().getChildFile ("renders").getChildFile (layer[ids::id].toString()).getChildFile (work.requestId);
    work.output = work.directory.getChildFile ("output.wav");
    work.manifest = work.directory.getChildFile ("output_manifest.json");
    work.fixture = fixtureEnabled();
    auto* params = new DynamicObject();
    params->setProperty ("decision_policy", "explicit"); params->setProperty ("request_id", work.requestId);
    params->setProperty ("prompt", prompt); params->setProperty ("seed", layer[ids::seed]);
    params->setProperty ("nl", parameters[ids::nl]); params->setProperty ("mode", "reimagine");
    params->setProperty ("lab", false); params->setProperty ("duration_s", work.duration);
    for (auto type : { ids::COLORS, ids::LORAS })
    {
        Array<var> rows;
        for (auto row : parameters.getChildWithName (type))
        { auto* value = new DynamicObject(); value->setProperty ("name", row[ids::name]); value->setProperty ("value", row[ids::value]); rows.add (var (value)); }
        params->setProperty (type == ids::COLORS ? "colors" : "loras", rows);
    }
    work.params = var (params);
    entry->edit = eng.edit().state; entry->clip = clip->state; entry->layer = layer;
    entry->shapeAtSubmit = shape (*clip, layer);
    entry->sourceSize = work.source.getSize(); entry->sourceModified = work.source.getLastModificationTime().toMilliseconds();
    if ((bool) layer[pending])
    {
        beginTxn ("render_layer");
        layer.setProperty (pending, false, &undoManager());
    }
    layer.setProperty (request, work.requestId, nullptr); layer.setProperty (jobIdProperty, "", nullptr);
    layer.setProperty (ids::status, "queued", nullptr); layer.setProperty (ids::renderError, "", nullptr);
    directRenders_[id] = entry;
    eng.markDirty(); logLine ("render_layer", args, true, {}, false); emitSnapshotInvalidated();
    if ((bool) args.getProperty ("wait", false)) { work.run (jobManagerOwner_); pollDirectRenders(); }
    else Thread::launch ([entry, manager = jobManagerOwner_] { entry->work.run (manager); });
    auto* result = new DynamicObject(); result->setProperty ("requestId", work.requestId); result->setProperty ("status", layer[ids::status]);
    return okResult ("render_layer", var (result));
}

void MoshOps::pollDirectRenders()
{
    // Persisted jobs cannot resume after replacing an edit; their assets remain on disk.
    for (auto* track : te::getAudioTracks (eng.edit()))
        for (auto* clip : track->getClips())
        {
            auto layer = clip->state.getChildWithName (ids::MOSH_RENDERLAYER);
            if (explicitLayer (layer) && ! directRenders_.count (clip->itemID.toString())
                && (layer[ids::status].toString() == "queued" || layer[ids::status].toString() == "rendering"))
            {
                layer.setProperty (ids::status, "cancelled", nullptr);
                layer.setProperty (ids::renderError, "This request belongs to a previous edit lifetime. Its result will not be applied.", nullptr);
                emitSnapshotInvalidated();
            }
        }

    for (auto it = directRenders_.begin(); it != directRenders_.end();)
    {
        auto entry = it->second;
        auto& work = entry->work;
        auto* clip = dynamic_cast<te::WaveAudioClip*> (findClip (it->first));
        const bool current = entry->edit == eng.edit().state && clip && clip->state == entry->clip
            && findRenderLayer (it->first) == entry->layer && entry->layer[request].toString() == work.requestId;
        const bool unchanged = current && shape (*clip, entry->layer) == entry->shapeAtSubmit
            && clip->getCurrentSourceFile() == resolveCacheArtifact (entry->layer[committed].toString(), eng.editFile().getParentDirectory())
            && work.source.getSize() == entry->sourceSize && work.source.getLastModificationTime().toMilliseconds() == entry->sourceModified;
        if (! unchanged || work.cancelled)
        {
            work.cancelled = true;
            if (current) { entry->layer.setProperty (ids::status, "cancelled", nullptr);
                entry->layer.setProperty (ids::renderError, "Result application cancelled after a source or state change. Inference may continue.", nullptr); emitSnapshotInvalidated(); }
            it = directRenders_.erase (it); continue;
        }
        String status, error, job;
        { const ScopedLock guard (work.lock); status = work.status; error = work.error; job = work.jobId; }
        const bool finished = work.finished.load();
        if (status != entry->lastStatus || job != entry->lastJobId || finished)
        {
            entry->layer.setProperty (ids::status, status, nullptr); entry->layer.setProperty (ids::renderError, error, nullptr);
            entry->layer.setProperty (jobIdProperty, job, nullptr);
            if (finished && status == "ready")
            {
                entry->layer.setProperty (ids::cacheArtifact, work.output.getFullPathName(), nullptr);
                entry->layer.setProperty (ids::cacheKey, work.outputHash, nullptr);
                entry->layer.setProperty (provenance, work.manifest.getFullPathName(), nullptr);
                entry->layer.setProperty (pending, true, nullptr);
                entry->layer.setProperty (pendingShape, entry->shapeAtSubmit, nullptr);
                entry->layer.setProperty (pendingStart, work.sourceStart, nullptr);
                entry->layer.setProperty (fixtureProperty, work.fixture, nullptr);
                eng.markDirty();
            }
            auto* event = new DynamicObject(); event->setProperty ("clipId", it->first);
            event->setProperty ("layerId", entry->layer[ids::id]); event->setProperty ("requestId", work.requestId);
            event->setProperty ("jobId", job); event->setProperty ("status", status); event->setProperty ("error", error);
            emit ("layer_status", var (event)); emitSnapshotInvalidated();
            entry->lastStatus = status; entry->lastJobId = job;
        }
        if (finished) it = directRenders_.erase (it); else ++it;
    }
}

var MoshOps::decideDirectRender (const String& command, const var& args)
{
    const auto id = args.getProperty ("clipId", {}).toString();
    auto* clip = dynamic_cast<te::WaveAudioClip*> (findClip (id));
    auto layer = findRenderLayer (id);
    if (! clip || ! explicitLayer (layer)) return errResult (command, "No direct audio render layer.");
    if (command == "cancel_render")
    {
        const auto it = directRenders_.find (id);
        if (it == directRenders_.end()) return errResult (command, "No active generation for this clip.");
        auto& work = it->second->work;
        String job; { const ScopedLock guard (work.lock); job = work.jobId; }
        if ((args.getProperty ("requestId", {}).toString().isNotEmpty() && args["requestId"].toString() != work.requestId)
            || (args.hasProperty ("jobId") && args["jobId"].toString().isNotEmpty() && args["jobId"].toString() != job))
            return errResult (command, "The cancellation identifies a different request.");
        work.cancelled = true; directRenders_.erase (it);
        layer.setProperty (ids::status, "cancelled", nullptr);
        layer.setProperty (ids::renderError, "Result application cancelled. Running inference may continue.", nullptr);
        logLine (command, args, true, {}, false); emitSnapshotInvalidated(); return okResult (command);
    }
    restoreDirectAuditions();
    const auto parent = eng.editFile().getParentDirectory();
    const auto original = resolveCacheArtifact (layer[ids::originalSourceRef].toString(), parent);
    const auto result = resolveCacheArtifact (layer, parent);
    const auto committedFile = resolveCacheArtifact (layer[committed].toString(), parent);
    const bool pendingValid = (bool) layer[pending] && result.existsAsFile() && layer[pendingShape].toString() == shape (*clip, layer)
        && clip->getCurrentSourceFile() == committedFile;
    if (command == "bypass_layer")
    {
        const auto choice = args.getProperty ("audition", "committed").toString();
        if (choice == "committed") return okResult (command);
        if (choice != "source" && choice != "result") return errResult (command, "Choose source, result or committed audition.");
        if (choice == "result" && ! pendingValid && ! ((bool) layer[ids::userKept] && ! (bool) layer[pending])) return errResult (command, "No current pending result. Reject stale output and generate again.");
        if (directRenders_.count (id)) return errResult (command, "Wait for generation before auditioning.");
        const auto target = choice == "source" ? original : pendingValid ? result : committedFile;
        if (! target.existsAsFile()) return errResult (command, "Audition audio is missing.");
        auto saved = std::make_shared<DirectAudition>(); saved->edit = eng.edit().state; saved->clip = clip->state;
        saved->layer = layer; saved->source = clip->getCurrentSourceFile(); saved->offset = clip->getPosition().getOffset().inSeconds();
        directAuditions_[id] = saved;
        pointSource (*clip, target, choice == "source" ? (double) layer[anchor] + saved->offset : pendingValid ? 0.0 : saved->offset, parent);
        layer.setProperty (audition, choice, nullptr);
        logLine (command, args, true, {}, false); emitSnapshotInvalidated(); return okResult (command);
    }
    if (directRenders_.count (id)) return errResult (command, "Cancel or finish generation before making a result decision.");
    if (command == "accept_render" && ! pendingValid) return errResult (command, "No current pending result. Reject stale output and generate again.");
    if ((command == "remove_render_layer" || command == "reset_render_layer") && ! original.existsAsFile())
        return errResult (command, "Original source is missing; the layer was preserved.");
    beginTxn (command);
    if (command == "accept_render")
    {
        if (! undoManager().perform (new SourceAction (*clip, result, 0.0, parent))) return errResult (command, "Could not apply stored audio.");
        layer.setProperty (committed, result.getFullPathName(), &undoManager());
        layer.setProperty (anchor, layer[pendingStart], &undoManager());
        layer.setProperty (ids::userKept, true, &undoManager()); layer.setProperty (ids::appliedInPlace, true, &undoManager());
    }
    else if (command == "remove_render_layer" || command == "reset_render_layer")
    {
        if (clip->getCurrentSourceFile() == committedFile
            && ! undoManager().perform (new SourceAction (*clip, original, (double) layer[anchor] + clip->getPosition().getOffset().inSeconds(), parent)))
            return errResult (command, "Could not restore original source.");
        if (command == "remove_render_layer") clip->state.removeChild (layer, &undoManager());
        else { layer.setProperty (committed, original.getFullPathName(), &undoManager()); layer.setProperty (anchor, 0.0, &undoManager());
               layer.setProperty (ids::userKept, false, &undoManager()); layer.setProperty (ids::appliedInPlace, false, &undoManager()); }
    }
    layer.setProperty (pending, false, &undoManager());
    layer.setProperty (ids::status, command == "accept_render" ? "ready" : "dirty", &undoManager());
    layer.setProperty (ids::renderError, "", &undoManager());
    logLine (command, args, true, {}, true); emitSnapshotInvalidated(); return okResult (command);
}

void MoshOps::appendDirectRenderSnapshot (DynamicObject& result, te::Clip& clip, const ValueTree& layer)
{
    if (! explicitLayer (layer)) return;
    result.setProperty (policy, "explicit");
    result.setProperty (pending, (bool) layer[pending]);
    result.setProperty (fixtureProperty, (bool) layer[fixtureProperty]);
    result.setProperty (request, layer[request].toString());
    result.setProperty (jobIdProperty, layer[jobIdProperty].toString());
    result.setProperty (audition, layer.getProperty (audition, "committed"));
    const auto it = directAuditions_.find (clip.itemID.toString());
    const double offset = it == directAuditions_.end() ? clip.getPosition().getOffset().inSeconds() : it->second->offset;
    result.setProperty ("sourceStart", (double) layer[anchor] + offset);
    result.setProperty ("sourceDuration", clip.getPosition().getLength().inSeconds());
}
}
