#include "MoshOps.h"
#include "state/RenderLayer.h"
#include "engine/SourceRef.h"
#include "engine/RenderArtifacts.h"
#include "generative/DirectRenderJob.h"
#include "DirectRenderState.h"

namespace mosh
{
using namespace juce;
using namespace direct_render;

void MoshOps::restoreDirectAuditions()
{
    bool changed = false;
    for (auto it = directRenders_.begin(); it != directRenders_.end();)
    {
        if (it->second->work.purpose == DirectRenderJob::Purpose::decisionValidation && it->second->decision == "result")
        {
            it->second->work.cancelled = true;
            if (it->second->edit == eng.edit().state && findRenderLayer (it->first) == it->second->layer)
            {
                it->second->layer.setProperty (ids::status, "ready", nullptr);
                it->second->layer.setProperty (ids::renderError, "", nullptr);
            }
            it = directRenders_.erase (it);
            changed = true;
        }
        else ++it;
    }
    for (auto& [id, saved] : directAuditions_)
    {
        if (saved->edit != eng.edit().state) continue;
        if (auto* clip = dynamic_cast<te::WaveAudioClip*> (findClip (id)); clip && clip->state == saved->clip)
            direct_render::pointSource (*clip, saved->source, saved->offset, eng.editFile().getParentDirectory());
        saved->layer.setProperty (audition, "committed", nullptr);
    }
    if (changed || ! directAuditions_.empty()) emitSnapshotInvalidated();
    directAuditions_.clear();
}

bool MoshOps::autosaveTick()
{
    // The timer's save would run beforePersist → restoreDirectAuditions and flip a live
    // Source/Result audition back to committed mid-listen. Postpone instead: the next
    // tick after the audition ends saves (the session stays dirty until then).
    if (! directAuditions_.empty()) return false;
    for (const auto& [id, entry] : directRenders_)
        if (entry->work.purpose == DirectRenderJob::Purpose::decisionValidation && entry->decision == "result")
            return false;   // a Result audition is being validated and will start on success
    return eng.saveIfDirty();
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
    work.originalSource = resolveCacheArtifact (layer[ids::originalSourceRef].toString(), parent);
    if (! work.originalSource.existsAsFile()) return errResult ("render_layer", "Original source audio is missing.");
    work.sourceStart = (double) layer[anchor] + clip->getPosition().getOffset().inSeconds();
    work.duration = clip->getPosition().getLength().inSeconds();
    if (work.duration < 2 || work.duration > 240) return errResult ("render_layer", "Direct Re-Imagine currently supports audio clips from 2 to 240 seconds.");
    work.requestId = Uuid().toString();
    work.directory = eng.sessionDir().getChildFile ("renders").getChildFile (layer[ids::id].toString()).getChildFile (work.requestId);
    work.source = work.directory.getChildFile ("source-snapshot" + work.originalSource.getFileExtension());
    work.output = work.directory.getChildFile ("output.wav");
    work.manifest = work.directory.getChildFile ("output_manifest.json");
    if (const auto frozen = createDirectSourceSnapshot (work.originalSource, work.source); frozen.failed())
        return errResult ("render_layer", frozen.getErrorMessage());
    work.fixture = fixtureEnabled();
    auto* params = new DynamicObject();
    params->setProperty ("decision_policy", "explicit"); params->setProperty ("request_id", work.requestId);
    params->setProperty ("prompt", prompt); params->setProperty ("seed", (int) layer[ids::seed]);
    params->setProperty ("nl", (double) parameters[ids::nl]); params->setProperty ("mode", "reimagine");
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
    entry->sourceSize = work.originalSource.getSize(); entry->sourceModified = work.originalSource.getLastModificationTime().toMilliseconds();
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
            && (work.purpose == DirectRenderJob::Purpose::decisionValidation
                ? (entry->liveSource.getSize() == entry->sourceSize
                    && entry->liveSource.getLastModificationTime().toMilliseconds() == entry->sourceModified
                    && entry->liveOutput.getSize() == entry->outputSize
                    && entry->liveOutput.getLastModificationTime().toMilliseconds() == entry->outputModified)
                : (work.originalSource.getSize() == entry->sourceSize
                    && work.originalSource.getLastModificationTime().toMilliseconds() == entry->sourceModified));
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
                if (work.purpose == DirectRenderJob::Purpose::generation)
                {
                    entry->layer.setProperty (ids::cacheArtifact, work.output.getFullPathName(), nullptr);
                    entry->layer.setProperty (ids::cacheKey, work.outputHash, nullptr);
                    entry->layer.setProperty (provenance, work.manifest.getFullPathName(), nullptr);
                    entry->layer.setProperty (pendingSourceHash, work.originalSourceHash, nullptr);
                    entry->layer.setProperty (pending, true, nullptr);
                    entry->layer.setProperty (pendingShape, entry->shapeAtSubmit, nullptr);
                    entry->layer.setProperty (pendingStart, work.sourceStart, nullptr);
                    entry->layer.setProperty (fixtureProperty, work.fixture, nullptr);
                    eng.markDirty();
                }
                else if (entry->decision == "result")
                {
                    auto saved = std::make_shared<DirectAudition>(); saved->edit = eng.edit().state; saved->clip = clip->state;
                    saved->layer = entry->layer; saved->source = clip->getCurrentSourceFile(); saved->offset = clip->getPosition().getOffset().inSeconds();
                    directAuditions_[it->first] = saved;
                    direct_render::pointSource (*clip, work.output, 0.0, eng.editFile().getParentDirectory());
                    entry->layer.setProperty (audition, "result", nullptr);
                }
                else if (entry->decision == "accept")
                {
                    beginTxn ("accept_render");
                    if (! undoManager().perform (new direct_render::SourceAction (*clip, work.output, 0.0, eng.editFile().getParentDirectory())))
                    {
                        status = "error"; error = "Could not apply the validated stored audio.";
                        entry->layer.setProperty (ids::status, status, nullptr);
                        entry->layer.setProperty (ids::renderError, error, nullptr);
                    }
                    else
                    {
                        entry->layer.setProperty (committed, work.output.getFullPathName(), &undoManager());
                        entry->layer.setProperty (anchor, entry->layer[pendingStart], &undoManager());
                        entry->layer.setProperty (ids::userKept, true, &undoManager());
                        entry->layer.setProperty (ids::appliedInPlace, true, &undoManager());
                        entry->layer.setProperty (pending, false, &undoManager());
                        eng.markDirty();
                    }
                }
            }
            if (finished && work.purpose == DirectRenderJob::Purpose::decisionValidation && entry->decision == "accept")
            {
                auto* completion = new DynamicObject(); completion->setProperty ("clipId", it->first);
                completion->setProperty ("requestId", work.requestId);
                logLine ("accept_render", var (completion), status == "ready", error, status == "ready");
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

}
