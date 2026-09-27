#include "MoshOps.h"
#include "DirectRenderState.h"
#include "engine/RenderArtifacts.h"
#include "state/RenderLayer.h"

namespace mosh
{
using namespace juce;
using namespace direct_render;

std::function<var (const var&)> MoshOps::generativeReadHandler()
{
    return [manager = jobManagerOwner_] (const var& command)
    {
        const auto name = command.getProperty ("command", {}).toString();
        if (name != "list_colors" && name != "list_loras") return errResult (name, "Not a generative read command.");
        if (! manager->ensureServiceRunning()) return errResult (name, "Local generative service unavailable.");
        auto data = name == "list_colors" ? manager->listColors() : manager->listLoras();
        if (! (bool) data.getProperty ("ok", false)) return errResult (name, "Local service capability could not be read.");
        if (name == "list_colors" && fixtureEnabled()) data.getDynamicObject()->setProperty ("testFixture", true);
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
    const auto validatePending = [&] (const String& decision) -> var
    {
        if (directRenders_.count (id)) return errResult (command, "Wait for the current validation or generation to finish.");
        auto entry = std::make_shared<DirectRenderRequest>();
        auto& work = entry->work;
        work.purpose = DirectRenderJob::Purpose::decisionValidation;
        work.requestId = Uuid().toString();
        work.expectedSourceHash = layer[pendingSourceHash].toString();
        work.expectedOutputHash = layer[ids::cacheKey].toString();
        const auto validationDir = eng.sessionDir().getChildFile ("renders").getChildFile (layer[ids::id].toString()).getChildFile (work.requestId);
        work.originalSource = validationDir.getChildFile ("source-snapshot" + original.getFileExtension());
        work.output = validationDir.getChildFile ("result-snapshot" + result.getFileExtension());
        entry->liveSource = original; entry->liveOutput = result;
        entry->sourceSize = original.getSize(); entry->sourceModified = original.getLastModificationTime().toMilliseconds();
        entry->outputSize = result.getSize(); entry->outputModified = result.getLastModificationTime().toMilliseconds();
        if (const auto frozen = createDirectSourceSnapshot (original, work.originalSource); frozen.failed())
            return errResult (command, frozen.getErrorMessage());
        if (const auto frozen = createDirectSourceSnapshot (result, work.output); frozen.failed())
            return errResult (command, frozen.getErrorMessage());
        entry->edit = eng.edit().state; entry->clip = clip->state; entry->layer = layer;
        entry->shapeAtSubmit = shape (*clip, layer); entry->decision = decision;
        layer.setProperty (request, work.requestId, nullptr); layer.setProperty (jobIdProperty, "", nullptr);
        layer.setProperty (ids::status, "queued", nullptr);
        layer.setProperty (ids::renderError, "Validating stored audio before " + (decision == "accept" ? String ("Keep.") : String ("audition.")), nullptr);
        directRenders_[id] = entry;
        // FINDINGS.md #7 — this line records the SUBMISSION of a decision, not its outcome:
        // the actual mutation (a Tracktion transaction, and a SECOND "accept_render" log line
        // with undoable:true) lands later, asynchronously, once validation finishes (see
        // pollDirectRenders()). Stamping "status":"queued" into the logged args means a
        // reader of mosh-log.jsonl never mistakes THIS undoable:false line for the final
        // word on whether Keep is undoable.
        {
            auto queuedArgs = args.clone();
            if (auto* o = queuedArgs.getDynamicObject()) o->setProperty ("status", "queued");
            logLine (command, queuedArgs, true, {}, false);
        }
        emitSnapshotInvalidated();
        if ((bool) args.getProperty ("wait", false) && ! eng.hasAudio()) { work.run (jobManagerOwner_); pollDirectRenders(); }
        else Thread::launch ([entry, manager = jobManagerOwner_] { entry->work.run (manager); });
        auto* response = new DynamicObject(); response->setProperty ("requestId", work.requestId); response->setProperty ("status", "queued");
        return okResult (command, var (response));
    };
    if (command == "bypass_layer")
    {
        const auto choice = args.getProperty ("audition", "committed").toString();
        if (choice == "committed") return okResult (command);
        if (choice != "source" && choice != "result") return errResult (command, "Choose source, result or committed audition.");
        if (choice == "result" && ! pendingValid && ! ((bool) layer[ids::userKept] && ! (bool) layer[pending])) return errResult (command, "No current pending result. Reject stale output and generate again.");
        if (directRenders_.count (id)) return errResult (command, "Wait for generation before auditioning.");
        if (choice == "result" && pendingValid) return validatePending ("result");
        const auto target = choice == "source" ? original : committedFile;
        if (! target.existsAsFile()) return errResult (command, "Audition audio is missing.");
        auto saved = std::make_shared<DirectAudition>(); saved->edit = eng.edit().state; saved->clip = clip->state;
        saved->layer = layer; saved->source = clip->getCurrentSourceFile(); saved->offset = clip->getPosition().getOffset().inSeconds();
        directAuditions_[id] = saved;
        pointSource (*clip, target, choice == "source" ? (double) layer[anchor] + saved->offset : saved->offset, parent);
        layer.setProperty (audition, choice, nullptr);
        logLine (command, args, true, {}, false); emitSnapshotInvalidated(); return okResult (command);
    }
    if (directRenders_.count (id)) return errResult (command, "Cancel or finish generation before making a result decision.");
    if (command == "accept_render" && ! pendingValid) return errResult (command, "No current pending result. Reject stale output and generate again.");
    if (command == "accept_render") return validatePending ("accept");
    if ((command == "remove_render_layer" || command == "reset_render_layer") && ! original.existsAsFile())
        return errResult (command, "Original source is missing; the layer was preserved.");
    beginTxn (command);
    if (command == "remove_render_layer" || command == "reset_render_layer")
    {
        if (clip->getCurrentSourceFile() == committedFile
            && ! undoManager().perform (new SourceAction (*clip, original, (double) layer[anchor] + clip->getPosition().getOffset().inSeconds(), parent)))
            return errResult (command, "Could not restore original source.");
        if (command == "remove_render_layer") clip->state.removeChild (layer, &undoManager());
        else { layer.setProperty (committed, original.getFullPathName(), &undoManager()); layer.setProperty (anchor, 0.0, &undoManager());
               layer.setProperty (ids::userKept, false, &undoManager()); layer.setProperty (ids::appliedInPlace, false, &undoManager()); }
    }
    layer.setProperty (pending, false, &undoManager());
    layer.setProperty (ids::status, "dirty", &undoManager());
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
