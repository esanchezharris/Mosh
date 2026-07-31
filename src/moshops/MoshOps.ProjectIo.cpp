// RFC 001 (A-PR3) — MoshOps partial-class split: the project-I/O command
// bodies (save/reload/new/open/open-recent/save-as, Stage-6 export_audio +
// export_stems, audio-device + MIDI-input + buffer/thread configuration,
// the file-browser directory listing, the command-log inspector + its cache,
// and the Stage-7 training/LoRA-adapter commands), moved VERBATIM from
// MoshOps.cpp. Same class, same member functions — only the translation unit
// changed. The dispatch if-chain and all transaction/log/result/emit plumbing
// stay in MoshOps.cpp (one mutation path, by construction). Cross-TU helpers
// (kCommandLogInspectorMaxEntries, makeCommandLogInspectorEntry — also used
// by logLine, which stays behind) live in MoshOpsInternal.h;
// looksLikeCommandLogRecord (only consumer here) moved into this TU's
// anonymous namespace, verbatim.

#include "MoshOps.h"
#include "MoshOpsInternal.h"
#include "AgentMemoryStore.h"
#include "ExportRange.h"
#include "StemExport.h"
#include "state/Ids.h"
#include "engine/AudioDeviceStartup.h"
#include "engine/SourceRef.h"
#include "engine/RenderArtifacts.h"
#include "multiplayer/LogicalId.h"
#include <thread>

namespace mosh
{
using namespace juce;

namespace
{
    bool looksLikeCommandLogRecord (const juce::String& line)
    {
        const auto t = line.trim();
        return t.startsWithChar ('{')
               && t.endsWithChar ('}')
               && t.contains ("\"ts\"")
               && t.contains ("\"seq\"")
               && t.contains ("\"command\"")
               && t.contains ("\"ok\"")
               && t.contains ("\"undoable\"");
    }
}

void MoshOps::invalidateCommandLogCache()
{
    const juce::ScopedLock sl (commandLogCacheLock_);
    commandLogRecentEntries_.clearQuick();
    commandLogTotal_ = 0;
    commandLogBytes_ = -1;
    commandLogPath_.clear();
    commandLogCachePrimed_ = false;
}

void MoshOps::refreshCommandLogCacheIfNeeded (const juce::File& file)
{
    const auto filePath = file.getFullPathName();
    const auto fileBytes = file.existsAsFile() ? file.getSize() : 0;
    const juce::ScopedLock sl (commandLogCacheLock_);

    if (commandLogCachePrimed_ && commandLogPath_ == filePath && commandLogBytes_ == fileBytes)
        return;

    commandLogRecentEntries_.clearQuick();
    commandLogTotal_ = 0;
    commandLogBytes_ = fileBytes;
    commandLogPath_ = filePath;
    commandLogCachePrimed_ = true;

    if (! file.existsAsFile())
        return;

    if (auto stream = file.createInputStream())
    {
        while (! stream->isExhausted())
        {
            const auto line = stream->readNextLine().trim();
            if (! looksLikeCommandLogRecord (line))
                continue;

            ++commandLogTotal_;

            juce::var parsed;
            if (juce::JSON::parse (line, parsed).failed())
                continue;

            auto entry = makeCommandLogInspectorEntry (parsed);
            if (! entry.isObject())
                continue;

            commandLogRecentEntries_.add (entry);
            if (commandLogRecentEntries_.size() > kCommandLogInspectorMaxEntries)
                commandLogRecentEntries_.remove (0);
        }
    }
}

juce::var MoshOps::cmdSave (const juce::var& args)
{
    const bool ok = eng.save();
    logLine ("save", args, ok, ok ? String() : String ("save failed"), false);
    if (ok) logKeptRenderLabels();   // TASTE-002 — surviving applied renders = soft positives
    return ok ? okResult ("save") : errResult ("save", "save failed");
}

juce::var MoshOps::cmdReload (const juce::var& args)
{
    unregisterAllMeterClients();        // old measurers are still valid here
    // PRJ-FMT — a newer-format file on disk is refused; the current Edit is kept untouched.
    if (auto refusal = eng.reloadFromFile(); refusal.isNotEmpty())   // reconcileMeterClients() re-registers next frame
    {
        logLine ("reload", args, false, refusal, false);
        emitSnapshotInvalidated();
        return errResult ("reload", refusal);
    }
    logFile = eng.sessionDir().getChildFile ("mosh-log.jsonl");
    invalidateCommandLogCache();
    logLine ("reload", args, true, {}, false);
    emitSnapshotInvalidated();
    return okResult ("reload");
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 7 — rights-cleared type-beat LoRA training
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdImportTrainingSource (const juce::var& args)
{
    String error;
    auto src = trainerRegistry.importSource (args, error);
    if (! error.isEmpty()) return errResult ("import_training_source", error);
    logLine ("import_training_source", args, true, {}, false);
    emitSnapshotInvalidated();
    return okResult ("import_training_source", src);
}

juce::var MoshOps::cmdListTrainingSources (const juce::var&)
{
    return okResult ("list_training_sources", trainerRegistry.listSources());
}

juce::var MoshOps::cmdApproveTrainingSource (const juce::var& args)
{
    String error;
    const auto sourceId = args.getProperty ("sourceId", var()).toString();
    if (sourceId.isEmpty()) return errResult ("approve_training_source", "missing sourceId");
    const bool approved = (bool) args.getProperty ("approved", true);
    auto src = trainerRegistry.approveSource (sourceId, approved, error);
    if (! error.isEmpty()) return errResult ("approve_training_source", error);
    logLine ("approve_training_source", args, true, {}, false);
    emitSnapshotInvalidated();
    return okResult ("approve_training_source", src);
}

juce::var MoshOps::cmdBuildTrainingCorpus (const juce::var& args)
{
    String error;
    auto bundle = trainerRegistry.buildCorpus (args, error);
    if (! error.isEmpty()) return errResult ("build_training_corpus", error);
    logLine ("build_training_corpus", args, true, {}, false);
    emitSnapshotInvalidated();
    return okResult ("build_training_corpus", bundle);
}

juce::var MoshOps::cmdSubmitTrainingJob (const juce::var& args)
{
    if (! trainingJobManager.ensureServiceRunning())
        return errResult ("submit_training_job", "training service unavailable");

    const auto bundlePath = args.getProperty ("corpusBundle", var()).toString();
    if (bundlePath.isEmpty())
        return errResult ("submit_training_job", "missing corpusBundle");
    const auto config = args.getProperty ("config", var());
    const auto outputDir = args.getProperty ("outputDir", var()).toString();
    const auto jobId = trainingJobManager.submitJob (bundlePath, config, outputDir);
    if (jobId.isEmpty()) return errResult ("submit_training_job", "job submit failed");

    auto* job = new DynamicObject();
    job->setProperty ("jobId", jobId);
    job->setProperty ("status", "queued");
    job->setProperty ("progress", 0.0);
    job->setProperty ("bundlePath", bundlePath);
    job->setProperty ("outputDir", outputDir.isNotEmpty()
                                    ? outputDir
                                    : File (bundlePath).getChildFile ("training-output").getChildFile (jobId).getFullPathName());
    job->setProperty ("config", config);
    trainerRegistry.updateJob (var (job));

    auto* data = new DynamicObject();
    data->setProperty ("jobId", jobId);
    data->setProperty ("bundlePath", bundlePath);
    data->setProperty ("outputDir", job->getProperty ("outputDir"));
    logLine ("submit_training_job", args, true, {}, false);
    emitSnapshotInvalidated();
    return okResult ("submit_training_job", var (data));
}

juce::var MoshOps::cmdTrainingJobStatus (const juce::var& args)
{
    const auto jobId = args.getProperty ("jobId", var()).toString();
    if (jobId.isEmpty()) return errResult ("training_job_status", "missing jobId");
    auto st = trainingJobManager.jobStatus (jobId);
    if (! (bool) st.getProperty ("ok", false))
        return errResult ("training_job_status", st.getProperty ("error", "job lookup failed").toString());

    auto* job = new DynamicObject();
    job->setProperty ("jobId", jobId);
    job->setProperty ("status", st.getProperty ("status", "queued"));
    job->setProperty ("progress", st.getProperty ("progress", 0.0));
    job->setProperty ("error", st.getProperty ("error", var()));
    job->setProperty ("result", st.getProperty ("result", var()));
    trainerRegistry.updateJob (var (job));
    return okResult ("training_job_status", st);
}

juce::var MoshOps::cmdCancelTrainingJob (const juce::var& args)
{
    const auto jobId = args.getProperty ("jobId", var()).toString();
    if (jobId.isEmpty()) return errResult ("cancel_training_job", "missing jobId");
    trainingJobManager.cancelJob (jobId);
    auto* job = new DynamicObject();
    job->setProperty ("jobId", jobId);
    job->setProperty ("status", "cancelled");
    job->setProperty ("progress", 0.0);
    trainerRegistry.updateJob (var (job));
    logLine ("cancel_training_job", args, true, {}, false);
    emitSnapshotInvalidated();
    return okResult ("cancel_training_job");
}

juce::var MoshOps::cmdImportLoraAdapter (const juce::var& args)
{
    const auto jobId = args.getProperty ("jobId", var()).toString();
    auto artifactPath = args.getProperty ("artifactPath", var()).toString();
    auto manifestPath = args.getProperty ("manifestPath", var()).toString();
    auto adapterId = args.getProperty ("adapterId", var()).toString();

    if (artifactPath.isEmpty() && jobId.isNotEmpty())
    {
        auto st = trainingJobManager.jobStatus (jobId);
        if ((bool) st.getProperty ("ok", false))
        {
            auto result = st.getProperty ("result", var());
            artifactPath = result.getProperty ("artifact_path", var()).toString();
            manifestPath = result.getProperty ("manifest_path", var()).toString();
            adapterId = result.getProperty ("adapter_id", var()).toString();
        }
    }

    String error;
    auto rec = trainerRegistry.importAdapter (artifactPath, manifestPath, adapterId, error);
    if (! error.isEmpty()) return errResult ("import_lora_adapter", error);
    logLine ("import_lora_adapter", args, true, {}, false);
    emitSnapshotInvalidated();
    return okResult ("import_lora_adapter", rec);
}

juce::var MoshOps::cmdActivateLoraAdapter (const juce::var& args)
{
    const auto adapterId = args.getProperty ("adapterId", var()).toString();
    if (adapterId.isEmpty()) return errResult ("activate_lora_adapter", "missing adapterId");

    auto adapters = trainerRegistry.listAdapters();
    auto adapterList = adapters.getProperty ("adapters", Array<var>());
    String adapterPath, corpusHash;
    if (auto* arr = adapterList.getArray())
        for (auto& a : *arr)
            if (a.getProperty ("adapterId", var()).toString() == adapterId)
            {
                adapterPath = a.getProperty ("artifactPath", var()).toString();
                corpusHash = a.getProperty ("bundleHash", var()).toString();
                break;
            }
    if (adapterPath.isEmpty())
        adapterPath = args.getProperty ("adapterPath", var()).toString();
    if (corpusHash.isEmpty())
        corpusHash = args.getProperty ("corpusHash", var()).toString();
    if (adapterPath.isEmpty())
        return errResult ("activate_lora_adapter", "adapter not found");

    String error;
    auto rec = trainerRegistry.activateAdapter (adapterId, adapterPath, corpusHash, error);
    if (! error.isEmpty()) return errResult ("activate_lora_adapter", error);
    logLine ("activate_lora_adapter", args, true, {}, false);
    emitSnapshotInvalidated();
    return okResult ("activate_lora_adapter", rec);
}

juce::var MoshOps::cmdListLoraAdapters (const juce::var&)
{
    return okResult ("list_lora_adapters", trainerRegistry.listAdapters());
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 6 — export (the full producer loop ends here)
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdExportAudio (const juce::var& args)
{
    auto& edit = eng.edit();

    // ── Format / extension resolution ────────────────────────────────────────
    // The UI speaks generic media-format names ("wav"/"aiff"/"flac"), never engine
    // type names. Resolve them through the Engine's AudioFileFormatManager (the
    // robust path: per-format getters + getFormatFromFileName), and FALL BACK to
    // the default WAV format on anything unknown. An explicitly-requested-but-
    // unsupported format is a hard error (caught before any render).
    auto& afm = edit.engine.getAudioFileFormatManager();

    const auto requestedFormat = args.getProperty ("format", var()).toString().trim().toLowerCase();

    // Map a format keyword -> (juce::AudioFormat*, canonical extension). Empty
    // keyword means "infer from the destination file extension" below.
    struct FormatChoice { juce::AudioFormat* format = nullptr; juce::String extension; };
    auto formatForKeyword = [&afm] (const juce::String& kw) -> FormatChoice
    {
        if (kw == "wav")  return { afm.getWavFormat(),  ".wav" };
        if (kw == "aiff" || kw == "aif") return { afm.getAiffFormat(), ".aiff" };
        if (kw == "flac") return { afm.getFlacFormat(), ".flac" };
        return {};
    };

    if (requestedFormat.isNotEmpty() && formatForKeyword (requestedFormat).format == nullptr)
        return errResult ("export_audio", "unsupported format: " + requestedFormat
                          + " (supported: wav, aiff, flac)");

    auto file = args.getProperty ("file", var()).toString().isNotEmpty()
                    ? juce::File (args.getProperty ("file", var()).toString())
                    : eng.sessionDir().getChildFile ("exports")
                          .getChildFile ("mix-" + String (Time::getCurrentTime().toMilliseconds()))
                          .withFileExtension ("wav");

    // Choose the format: explicit keyword wins; otherwise infer from the file
    // extension; otherwise the default WAV. Then force the destination extension
    // to match the chosen format so the bytes and the name agree.
    juce::AudioFormat* audioFormat = nullptr;
    juce::String formatName = "wav";
    if (requestedFormat.isNotEmpty())
    {
        auto choice = formatForKeyword (requestedFormat);
        audioFormat = choice.format;
        formatName = requestedFormat == "aif" ? "aiff" : requestedFormat;
        file = file.withFileExtension (choice.extension);
    }
    else
    {
        const auto ext = file.getFileExtension().toLowerCase();
        if (ext == ".wav")       { audioFormat = afm.getWavFormat();  formatName = "wav"; }
        else if (ext == ".aiff" || ext == ".aif") { audioFormat = afm.getAiffFormat(); formatName = "aiff"; file = file.withFileExtension (".aiff"); }
        else if (ext == ".flac") { audioFormat = afm.getFlacFormat(); formatName = "flac"; }
        else if (ext == ".mid")  { audioFormat = afm.getDefaultFormat(); formatName = "mid"; }
        else { audioFormat = afm.getDefaultFormat(); formatName = "wav"; file = file.withFileExtension (".wav"); }
    }
    if (audioFormat == nullptr)   // belt-and-braces: never render with a null format
        audioFormat = afm.getDefaultFormat();

    file.getParentDirectory().createDirectory();
    file.deleteFile();

    // ── Bit depth ────────────────────────────────────────────────────────────
    // Validate the requested depth against what this format can actually write
    // (getPossibleBitDepths). Reject an unsupported depth rather than silently
    // writing the wrong one. Absent -> 24 (or the format's nearest supported).
    // PRJ-008 — when the export omits bitDepth, default it from the stored per-project
    // setting (NON-mutating read; an invalid/absent tree's hasProperty() is false ->
    // the 24-bit / device-rate defaults below).
    auto projectSettings = eng.edit().state.getChildWithName (ids::MOSH_PROJECT);
    int bitDepth = projectSettings.hasProperty (ids::projectBitDepth)
                       ? (int) projectSettings.getProperty (ids::projectBitDepth)
                       : 24;
    {
        auto depths = audioFormat->getPossibleBitDepths();   // local copy of the Array<int>
        const bool depthRequested = args.hasProperty ("bitDepth");
        if (depthRequested)
        {
            bitDepth = (int) args.getProperty ("bitDepth", 24);
            if (! depths.contains (bitDepth))
            {
                juce::StringArray supported;
                for (auto d : depths) supported.add (String (d));
                return errResult ("export_audio", "format " + formatName + " does not support bit depth "
                                  + String (bitDepth) + " (supported: " + supported.joinIntoString (", ") + ")");
            }
        }
        else if (! depths.isEmpty() && ! depths.contains (bitDepth))
        {
            // Nearest supported to the 24-bit default.
            int best = depths[0];
            for (auto d : depths) if (std::abs (d - 24) < std::abs (best - 24)) best = d;
            bitDepth = best;
        }
    }

    const auto requestedMode = args.getProperty ("renderMode", "auto").toString().toLowerCase();
    if (requestedMode != "auto" && requestedMode != "fast" && requestedMode != "realtime")
        return errResult ("export_audio", "renderMode must be 'auto', 'fast', or 'realtime'");

    String renderMode = requestedMode;
    String renderModeReason;
    if (requestedMode == "auto")
    {
        renderModeReason = findSerumRealtimeRenderReason (edit);
        renderMode = renderModeReason.isNotEmpty() ? "realtime" : "fast";
        if (renderModeReason.isEmpty())
            renderModeReason = "no realtime-only hosted plugin detected";
    }
    else if (requestedMode == "realtime")
    {
        renderModeReason = "requested realtime render";
    }
    else
    {
        renderModeReason = "requested fast render";
    }

    // ── Export range (invariant 78) + delay-tail policy (invariant 81) ──────────
    // Resolved + validated BEFORE the device teardown below so a bad range/tail arg
    // returns an error without a needless freePlaybackContext(). getLoopRange() reads
    // transport CachedValue state and is context-independent either way. The actual
    // resolution/validation math is pure + engine-free (mosh::resolveExportRange,
    // src/moshops/ExportRange.h) so it's unit-testable without a live MoshEngine —
    // see tests/test_export_range.cpp.
    const auto loopRange = edit.getTransport().getLoopRange();
    const auto rangeRes = resolveExportRange (
        edit.getLength().inSeconds(),
        loopRange.getStart().inSeconds(), loopRange.getEnd().inSeconds(),
        args.hasProperty ("range"), args.getProperty ("range", var()).toString(),
        args.hasProperty ("start"), (double) args.getProperty ("start", 0.0),
        args.hasProperty ("end"),   (double) args.getProperty ("end", 0.0),
        args.hasProperty ("tail"),  args.getProperty ("tail", var()).toString(),
        args.hasProperty ("tailSeconds"), (double) args.getProperty ("tailSeconds", 2.0));
    if (! rangeRes.ok)
        return errResult ("export_audio", rangeRes.error);
    const double rStart = rangeRes.rangeStart, rEnd = rangeRes.rangeEnd;
    const juce::String rangeKind = rangeRes.rangeKind, tailKind = rangeRes.tailKind;
    const double tailSeconds = rangeRes.tailSeconds;

    // Render exclusivity (01 §5): detach the Edit from the device before an
    // offline/realtime export render (asserts otherwise). No-op when no device
    // is attached. Tear down our level-meter taps first (the master tap lives on
    // the playback context we are about to free) and clear lastSeenContext so the
    // master meter re-attaches to the *next* context rather than an ABA-reused
    // address — same swap guard cmdNewProject/cmdOpenProject use.
    unregisterAllMeterClients();           // master tap follows the context being freed
    edit.getTransport().stop (false, false);
    edit.getTransport().freePlaybackContext();
    lastSeenContext = nullptr;             // old ctx freed; force master-meter re-attach to the next ctx

    const double len = juce::jmax (0.1, rEnd - rStart);

    // Sample rate: honor a valid explicit request (>= 7000), else the stored
    // per-project setting (PRJ-008), else the device rate with the 44100 fallback.
    double sampleRate = edit.engine.getDeviceManager().getSampleRate();
    if (sampleRate < 7000.0)
        sampleRate = 44100.0;
    if (! args.hasProperty ("sampleRate") && projectSettings.hasProperty (ids::projectSampleRate))
    {
        const double projSr = (double) projectSettings.getProperty (ids::projectSampleRate);
        if (projSr >= 7000.0)
            sampleRate = projSr;
    }
    if (args.hasProperty ("sampleRate"))
    {
        const double reqSr = (double) args.getProperty ("sampleRate", sampleRate);
        if (reqSr >= 7000.0)
            sampleRate = reqSr;
    }

    te::Renderer::Parameters params (edit);
    params.destFile = file;
    params.audioFormat = audioFormat;
    params.bitDepth = bitDepth;
    params.sampleRateForAudio = sampleRate;
    params.blockSizeForAudio = edit.engine.getDeviceManager().getBlockSize();
    if (params.blockSizeForAudio <= 0)
        params.blockSizeForAudio = 512;
    params.time = { tracktion::TimePosition::fromSeconds (rStart),
                     tracktion::TimePosition::fromSeconds (rEnd) };
    params.endAllowance = tracktion::TimeDuration::fromSeconds (tailSeconds);
    params.tracksToDo = te::toBitSet (te::getAllTracks (edit));
    params.usePlugins = true;
    params.useMasterPlugins = true;
    params.createMidiFile = file.hasFileExtension (".mid");
    params.realTimeRender = renderMode == "realtime";

    String renderError;
    {
        const te::Edit::ScopedRenderStatus srs (edit, true);
        te::TransportControl::stopAllTransports (edit.engine, false, true);
        te::Renderer::turnOffAllPlugins (edit);

        if (params.tracksToDo.countNumberOfSetBits() > 0
            && params.destFile.hasWriteAccess()
            && ! params.destFile.isDirectory())
        {
            te::Renderer::RenderTask task ("Mosh export", params, nullptr, nullptr);

            // Defense-in-depth: bound the render loop. runJob() returns jobNeedsRunningAgain
            // once per block; if a leaf node can NEVER become ready (e.g. a clip whose source
            // file can't be opened), progress stalls and this loop would otherwise spin
            // forever. A no-progress watchdog + an absolute deadline (scaled to the edit
            // length to allow legitimate realtime renders) turn any such stall into a clean
            // error instead of an app hang.
            const double renderSpan   = (rEnd - rStart) + tailSeconds;   // actual rendered span, not the whole edit
            const juce::uint32 startMs    = juce::Time::getMillisecondCounter();
            const juce::uint32 deadlineMs = (juce::uint32) juce::jmax (60000.0, renderSpan * 8000.0 + 60000.0);
            const juce::uint32 stallMs    = 20000;   // abort if progress doesn't advance for 20s
            float  lastProgress   = -1.0f;
            juce::uint32 lastProgressMs = startMs;

            while (task.runJob() == juce::ThreadPoolJob::jobNeedsRunningAgain)
            {
                const juce::uint32 nowMs = juce::Time::getMillisecondCounter();
                const float p = task.getCurrentTaskProgress();
                if (p > lastProgress) { lastProgress = p; lastProgressMs = nowMs; }

                if (nowMs - lastProgressMs > stallMs || nowMs - startMs > deadlineMs)
                {
                    if (task.errorMessage.isEmpty())
                        task.errorMessage = "export render stalled (a clip's audio source could not be read)";
                    break;
                }
            }

            te::Renderer::turnOffAllPlugins (edit);

            if (task.errorMessage.isNotEmpty())
            {
                renderError = task.errorMessage;
                file.deleteFile();
            }
        }
        else
        {
            renderError = "render target is not writable or no tracks are renderable";
        }
    }

    const bool ok = renderError.isEmpty() && file.existsAsFile() && file.getSize() > 0;

    logLine ("export_audio", args, ok, ok ? String() : (renderError.isNotEmpty() ? renderError : String ("render produced no file")), false);
    if (ok) logKeptRenderLabels();   // TASTE-002 — surviving applied renders = soft positives
    if (! ok) return errResult ("export_audio", renderError.isNotEmpty() ? renderError : String ("export render failed"));

    auto* data = new DynamicObject();
    data->setProperty ("file", file.getFullPathName());
    data->setProperty ("format", formatName);
    if (formatName != "mid")   // bit depth / sample rate are meaningless for a MIDI export
    {
        data->setProperty ("bitDepth", bitDepth);
        data->setProperty ("sampleRate", sampleRate);
    }
    data->setProperty ("bytes", (juce::int64) file.getSize());
    data->setProperty ("seconds", len);
    data->setProperty ("range", rangeKind);
    data->setProperty ("rangeStart", rStart);
    data->setProperty ("rangeEnd", rEnd);
    data->setProperty ("tail", tailKind);
    data->setProperty ("endAllowance", tailSeconds);
    data->setProperty ("renderModeRequested", requestedMode);
    data->setProperty ("renderMode", renderMode);
    data->setProperty ("renderModeReason", renderModeReason);
    data->setProperty ("realTimeRender", params.realTimeRender);
    return okResult ("export_audio", var (data));
}

bool MoshOps::writeSilentStemFile (const juce::File& dest, juce::AudioFormat* format, int bitDepth,
                                   double sampleRate, double lengthSeconds)
{
    if (format == nullptr) return false;
    dest.deleteFile();
    std::unique_ptr<juce::FileOutputStream> os (dest.createOutputStream());
    if (os == nullptr) return false;

    const int numChannels = 2;   // stereo, matching the rest of the stem set
    std::unique_ptr<juce::AudioFormatWriter> writer (
        format->createWriterFor (os.get(), sampleRate, (unsigned) numChannels, bitDepth, {}, 0));
    if (writer == nullptr) return false;
    os.release();   // the writer owns the stream now

    const int numSamples = juce::jmax (1, (int) std::ceil (lengthSeconds * sampleRate));
    juce::AudioBuffer<float> silence (numChannels, numSamples);
    silence.clear();
    const bool wrote = writer->writeFromAudioSampleBuffer (silence, 0, numSamples);
    writer.reset();   // flush + close before the caller reads the file back
    return wrote;
}

// ─────────────────────────────────────────────────────────────────────────────
// G7 — cmdExportStems: one WAV/AIFF/FLAC per visible, non-empty audio track, ALL
// sharing the same {0, editLength} render window (the "common zero point" — a
// track whose clips start at bar 8 yields a stem with 8 bars of leading silence,
// so every stem is the same length and re-imports aligned). Mirrors
// cmdExportAudio's format/bit-depth/sample-rate resolution (deliberately kept
// self-contained rather than sharing a helper — see the spec §2 "shared-helper
// refactor (recommended)" note; duplication is the smaller, lower-risk diff and
// the golden/verify gate catches any drift) and reuses bounceClipToWav's
// single-track render primitive in a loop instead of a single all-tracks render.
// NON-undoable (read/render, no ValueTree mutation the undo system needs to
// know about) — same posture as export_audio.
//
// ── CORRECTNESS FIX (found by adversarial review, empirically reproduced): the
// original version of this command set ONLY `params.tracksToDo = te::toBitSet(one)`
// to try to isolate the single target track, per the spec's "NO allowedClips —
// we render the whole track" design. That design was built on a false premise:
// `te::toBitSet()` in the PINNED tracktion_engine clone (2877b621,
// modules/tracktion_engine/model/edit/tracktion_EditUtilities.cpp:179-193) does
// NOT restrict the bitset to the tracks passed in — it's an upstream bug. Its body
// loops `t` over `getAllTracks(edit)` and sets the bit whenever
// `allTracks.indexOf(t) >= 0`, which is trivially true for every t (t is drawn
// FROM allTracks), so it unconditionally sets every track's bit regardless of the
// `tracks` array argument. `params.tracksToDo` therefore evaluated to "every
// track in the edit" no matter which single track was passed in, and
// `cnp.allowedTracks` (tracktion_Renderer.cpp:38/140) ended up permitting ALL
// tracks — so every "stem" actually rendered the full mix. Verified by reading
// the upstream source (see the exact lines above); `bounceClipToWav` (:6867)
// never hit this because it ALSO sets `params.allowedClips` to the one clip it
// wants, and `allowedClips` is filtered independently, per-clip, in
// EditNodeBuilder.cpp regardless of tracksToDo/allowedTracks — so its bug was
// silently masked. The fix: populate `params.allowedClips` with every clip that
// belongs to the target track (not just one), which genuinely isolates it the
// same proven way bounceClipToWav does. `tracksToDo` is left set (harmless —
// it's not load-bearing for isolation) only because the render-gate check below
// reads `tracksToDo.countNumberOfSetBits() > 0`.
//
// One wrinkle: `allowedClips` can't express "zero clips" — an EMPTY array means
// "no filter" (ALL clips), not "no clips." So a genuinely clip-less track
// (`includeEmpty:true`) is written directly as silence via writeSilentStemFile,
// bypassing te::Renderer for that one stem.
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdExportStems (const juce::var& args)
{
    auto& edit = eng.edit();

    // ── Format / extension resolution (trimmed-down cmdExportAudio copy — stems
    // take a destination "dir", not a per-file "file", so there is no extension-
    // inference-from-filename branch to mirror). ───────────────────────────────
    auto& afm = edit.engine.getAudioFileFormatManager();
    const auto requestedFormat = args.getProperty ("format", var()).toString().trim().toLowerCase();

    struct FormatChoice { juce::AudioFormat* format = nullptr; juce::String extension; };
    auto formatForKeyword = [&afm] (const juce::String& kw) -> FormatChoice
    {
        if (kw == "wav")  return { afm.getWavFormat(),  ".wav" };
        if (kw == "aiff" || kw == "aif") return { afm.getAiffFormat(), ".aiff" };
        if (kw == "flac") return { afm.getFlacFormat(), ".flac" };
        return {};
    };

    juce::AudioFormat* audioFormat = afm.getWavFormat();
    juce::String formatName = "wav";
    juce::String extension = ".wav";
    if (requestedFormat.isNotEmpty())
    {
        auto choice = formatForKeyword (requestedFormat);
        if (choice.format == nullptr)
            return errResult ("export_stems", "unsupported format: " + requestedFormat
                              + " (supported: wav, aiff, flac)");
        audioFormat = choice.format;
        formatName  = requestedFormat == "aif" ? "aiff" : requestedFormat;
        extension   = choice.extension;
    }
    if (audioFormat == nullptr)   // belt-and-braces: never render with a null format
        audioFormat = afm.getDefaultFormat();

    // ── Bit depth — PRJ-008: default from the stored per-project setting, same
    // precedence as cmdExportAudio. ─────────────────────────────────────────────
    auto projectSettings = edit.state.getChildWithName (ids::MOSH_PROJECT);
    int bitDepth = projectSettings.hasProperty (ids::projectBitDepth)
                       ? (int) projectSettings.getProperty (ids::projectBitDepth)
                       : 24;
    {
        auto depths = audioFormat->getPossibleBitDepths();
        if (args.hasProperty ("bitDepth"))
        {
            bitDepth = (int) args.getProperty ("bitDepth", 24);
            if (! depths.contains (bitDepth))
            {
                juce::StringArray supported;
                for (auto d : depths) supported.add (String (d));
                return errResult ("export_stems", "format " + formatName + " does not support bit depth "
                                  + String (bitDepth) + " (supported: " + supported.joinIntoString (", ") + ")");
            }
        }
        else if (! depths.isEmpty() && ! depths.contains (bitDepth))
        {
            int best = depths[0];
            for (auto d : depths) if (std::abs (d - 24) < std::abs (best - 24)) best = d;
            bitDepth = best;
        }
    }

    // ── Sample rate — same PRJ-008 precedence as cmdExportAudio. ────────────────
    double sampleRate = edit.engine.getDeviceManager().getSampleRate();
    if (sampleRate < 7000.0)
        sampleRate = 44100.0;
    if (! args.hasProperty ("sampleRate") && projectSettings.hasProperty (ids::projectSampleRate))
    {
        const double projSr = (double) projectSettings.getProperty (ids::projectSampleRate);
        if (projSr >= 7000.0)
            sampleRate = projSr;
    }
    if (args.hasProperty ("sampleRate"))
    {
        const double reqSr = (double) args.getProperty ("sampleRate", sampleRate);
        if (reqSr >= 7000.0)
            sampleRate = reqSr;
    }

    const auto requestedMode = args.getProperty ("renderMode", "auto").toString().toLowerCase();
    if (requestedMode != "auto" && requestedMode != "fast" && requestedMode != "realtime")
        return errResult ("export_stems", "renderMode must be 'auto', 'fast', or 'realtime'");

    // Destination directory: explicit `dir` arg, else sessionDir/exports/stems-<ms>.
    juce::File dir = args.getProperty ("dir", var()).toString().isNotEmpty()
        ? juce::File (args.getProperty ("dir", var()).toString())
        : eng.sessionDir().getChildFile ("exports")
              .getChildFile ("stems-" + String (Time::getCurrentTime().toMilliseconds()));
    dir.createDirectory();

    const bool includeEmpty = (bool) args.getProperty ("includeEmpty", false);

    // Render exclusivity (01 §5), done ONCE for the whole stem set — mirrors
    // cmdExportAudio's teardown so the master meter re-attaches to the NEXT context.
    unregisterAllMeterClients();
    edit.getTransport().stop (false, false);
    edit.getTransport().freePlaybackContext();
    lastSeenContext = nullptr;

    // Edit-wide render mode: one realtime-only hosted synth (e.g. Serum) anywhere in
    // the edit forces ALL stems to render realtime — a safe superset, computed once
    // rather than per-track (mirrors cmdExportAudio's "auto" resolution).
    const bool realtime = requestedMode == "realtime"
                          || (requestedMode == "auto" && findSerumRealtimeRenderReason (edit).isNotEmpty());

    const double len = juce::jmax (0.1, edit.getLength().inSeconds());
    int blockSize = edit.engine.getDeviceManager().getBlockSize();
    if (blockSize <= 0) blockSize = 512;

    juce::Array<var> stems;
    juce::String firstError;
    int index = 0;   // matches snapshot()'s track index (te::getAudioTracks, moshHidden filtered)

    for (auto* t : te::getAudioTracks (edit))
    {
        if (t == nullptr) continue;
        if ((bool) t->state.getProperty (ids::moshHidden, false)) continue;   // Phase-2 hidden beneath-render track — never a stem
        const int myIndex = index++;
        const juce::Array<te::Clip*> trackClips = t->getClips();             // THIS track's own clips (may be empty)
        if (! includeEmpty && trackClips.isEmpty()) continue;                // skip silent tracks by default

        auto file = dir.getChildFile (stemFileBaseName (myIndex, t->getName())).withFileExtension (extension);
        file.deleteFile();

        juce::String renderError;

        if (trackClips.isEmpty())
        {
            // includeEmpty:true on a genuinely clip-less track — allowedClips can't express
            // "zero clips" (see the comment above this function), so write silence directly
            // at the common-zero-point length instead of going through te::Renderer.
            if (! writeSilentStemFile (file, audioFormat, bitDepth, sampleRate, len))
                renderError = "could not write a silent stem file";
        }
        else
        {
            te::Renderer::Parameters params (edit);
            params.destFile           = file;
            params.audioFormat        = audioFormat;
            params.bitDepth           = bitDepth;
            params.sampleRateForAudio = sampleRate;
            params.blockSizeForAudio  = blockSize;
            params.time               = { tracktion::TimePosition(), edit.getLength() };   // COMMON zero point — every stem shares this window
            juce::Array<te::Track*> one; one.add (t);
            params.tracksToDo         = te::toBitSet (one);   // kept for the countNumberOfSetBits() gate below; NOT load-bearing for isolation (see the comment above cmdExportStems)
            params.allowedClips.addArray (trackClips);        // ← the ACTUAL per-track isolation mechanism
            params.usePlugins         = true;                 // instrument + insert FX = the track's own post-fader sound
            params.useMasterPlugins   = false;                // pre-master — sum of stems + master chain reproduces the mix
            params.createMidiFile     = false;
            params.realTimeRender     = realtime;

            const te::Edit::ScopedRenderStatus srs (edit, true);
            te::TransportControl::stopAllTransports (edit.engine, false, true);
            te::Renderer::turnOffAllPlugins (edit);

            if (params.tracksToDo.countNumberOfSetBits() > 0
                && params.destFile.hasWriteAccess()
                && ! params.destFile.isDirectory())
            {
                te::Renderer::RenderTask task ("Mosh stem export", params, nullptr, nullptr);

                // Same no-progress watchdog + absolute deadline as cmdExportAudio /
                // bounceClipToWav, so ONE bad track's stalled render (e.g. an unreadable
                // source) errors cleanly instead of hanging the whole stem set.
                const juce::uint32 startMs    = juce::Time::getMillisecondCounter();
                const juce::uint32 deadlineMs = (juce::uint32) juce::jmax (60000.0, len * 8000.0 + 60000.0);
                const juce::uint32 stallMs    = 20000;
                float  lastProgress   = -1.0f;
                juce::uint32 lastProgressMs = startMs;

                while (task.runJob() == juce::ThreadPoolJob::jobNeedsRunningAgain)
                {
                    const juce::uint32 nowMs = juce::Time::getMillisecondCounter();
                    const float p = task.getCurrentTaskProgress();
                    if (p > lastProgress) { lastProgress = p; lastProgressMs = nowMs; }

                    if (nowMs - lastProgressMs > stallMs || nowMs - startMs > deadlineMs)
                    {
                        if (task.errorMessage.isEmpty())
                            task.errorMessage = "stem render stalled (a clip's audio source could not be read)";
                        break;
                    }
                }

                te::Renderer::turnOffAllPlugins (edit);

                if (task.errorMessage.isNotEmpty())
                {
                    renderError = task.errorMessage;
                    file.deleteFile();
                }
            }
            else
            {
                renderError = "render target is not writable or no tracks are renderable";
            }
        }

        if (renderError.isNotEmpty())
        {
            // Best-effort: one bad track must not abort the whole stem set — record the
            // first failure (surfaced only if EVERY track ends up failing) and continue.
            if (firstError.isEmpty())
                firstError = t->getName() + ": " + renderError;
            continue;
        }

        if (file.existsAsFile() && file.getSize() > 0)
        {
            auto* so = new DynamicObject();
            so->setProperty ("trackId",   t->itemID.toString());
            so->setProperty ("logicalId", logicalid::ensureTrack (t->state));
            so->setProperty ("name",      t->getName());
            so->setProperty ("index",     myIndex);
            so->setProperty ("file",      file.getFullPathName());
            so->setProperty ("bytes",     (juce::int64) file.getSize());
            stems.add (var (so));
        }
    }

    const bool ok = ! stems.isEmpty();
    logLine ("export_stems", args, ok, ok ? String() : (firstError.isNotEmpty() ? firstError : String ("no renderable tracks")), false);
    if (! ok)
        return errResult ("export_stems", firstError.isNotEmpty() ? firstError
                          : String ("no renderable tracks (all empty or hidden)"));

    auto* data = new DynamicObject();
    data->setProperty ("dir",        dir.getFullPathName());
    data->setProperty ("format",     formatName);
    data->setProperty ("bitDepth",   bitDepth);
    data->setProperty ("sampleRate", sampleRate);
    data->setProperty ("seconds",    len);
    data->setProperty ("count",      stems.size());
    data->setProperty ("stems",      var (stems));
    return okResult ("export_stems", var (data));
}

// ─────────────────────────────────────────────────────────────────────────────
// Wave: settings — audio device picker + project lifecycle
//
// Device + project commands are NON-undoable by design (no beginNewTransaction):
// a device change is a machine preference (like set_metronome) and new/open/save-as
// replace or persist the whole Edit — there is nothing to put on the Edit's own
// undo stack, and pushing an empty transaction would silently undo an unrelated
// prior edit. All log undoable:false. list_audio_devices is read-only (no log).
// ─────────────────────────────────────────────────────────────────────────────

juce::var MoshOps::currentAudioSelection()
{
    // Lightweight current-selection summary for the snapshot's audio{} block + the
    // set_audio_device result. NO full device lists here (those stay behind the
    // on-demand list_audio_devices so the snapshot stays small).
    auto& dm = adm();
    auto setup = dm.getAudioDeviceSetup();
    auto* o = new DynamicObject();
    o->setProperty ("type", dm.getCurrentAudioDeviceType());
    o->setProperty ("outputDevice", setup.outputDeviceName);
    o->setProperty ("inputDevice", setup.inputDeviceName);
    o->setProperty ("sampleRate", setup.sampleRate);
    o->setProperty ("bufferSize", setup.bufferSize);
    return var (o);
}

juce::var MoshOps::cmdListAudioDevices (const juce::var&)
{
    // Read-only enumeration — no transaction, no log line. Headless (no audio) the
    // engine never adds system device types (MoshEngine addSystemAudioIODeviceTypes
    // returns false), so `types` is a well-formed empty array and audioEnabled:false.
    auto& dm = adm();

    Array<var> types;
    if (audiostartup::shouldEnumerateDeviceTypes (eng.hasAudio()))
        for (auto* type : dm.getAvailableDeviceTypes())
        {
            if (type == nullptr) continue;
            type->scanForDevices();                          // required before getDeviceNames

            Array<var> outputs, inputs;
            for (auto& n : type->getDeviceNames (false)) outputs.add (n);
            for (auto& n : type->getDeviceNames (true))  inputs.add (n);

            auto* to = new DynamicObject();
            to->setProperty ("name", type->getTypeName());
            to->setProperty ("outputs", outputs);
            to->setProperty ("inputs", inputs);
            types.add (var (to));
        }

    // Valid sample-rate / buffer-size lists are only meaningful when a device is
    // open (null headless → empty arrays).
    Array<var> sampleRates, bufferSizes;
    int defaultBufferSize = 0;
    if (auto* dev = dm.getCurrentAudioDevice())
    {
        for (auto sr : dev->getAvailableSampleRates()) sampleRates.add (sr);
        for (auto bs : dev->getAvailableBufferSizes()) bufferSizes.add (bs);
        defaultBufferSize = dev->getDefaultBufferSize();
    }

    auto* data = new DynamicObject();
    data->setProperty ("types", types);
    data->setProperty ("current", currentAudioSelection());
    data->setProperty ("sampleRates", sampleRates);
    data->setProperty ("bufferSizes", bufferSizes);
    data->setProperty ("defaultBufferSize", defaultBufferSize);
    data->setProperty ("audioEnabled", eng.hasAudio());
    return okResult ("list_audio_devices", var (data));
}

juce::var MoshOps::cmdListMidiInputs (const juce::var&)
{
    // Read-only MIDI-input enumeration (CTL-001) — modelled on cmdListAudioDevices:
    // no transaction, no log line, no event. Headless (no audio device) the engine's
    // MIDI device list is empty (devices are only enumerated once CoreAudio/MIDI is
    // up), so `inputs` is a well-formed empty array. The live note flow (controller ->
    // armed instrument track -> audible synth) is hardware-gated and verified live.
    auto& dm = eng.engine().getDeviceManager();

    Array<var> inputs;
    for (auto& mi : dm.getMidiInDevices())
    {
        if (mi == nullptr) continue;

        auto* o = new DynamicObject();
        o->setProperty ("name", mi->getName());
        o->setProperty ("alias", mi->getAlias());
        o->setProperty ("deviceID", mi->getDeviceID());
        o->setProperty ("enabled", mi->isEnabled());
        switch (mi->getMonitorMode())
        {
            case te::InputDevice::MonitorMode::off:       o->setProperty ("monitor", "off"); break;
            case te::InputDevice::MonitorMode::on:        o->setProperty ("monitor", "on"); break;
            case te::InputDevice::MonitorMode::automatic: o->setProperty ("monitor", "automatic"); break;
            default:                                      o->setProperty ("monitor", "automatic"); break;
        }
        inputs.add (var (o));
    }

    auto* data = new DynamicObject();
    data->setProperty ("inputs", inputs);
    data->setProperty ("audioEnabled", eng.hasAudio());
    return okResult ("list_midi_inputs", var (data));
}

juce::var MoshOps::cmdListDirectory (const juce::var& args)
{
    // BRW-001 — content/file browser enumerator. STRICTLY READ-ONLY: no transaction,
    // no log line, no event. Like cmdListAudioDevices / cmdGetCommandLog it returns
    // okResult(...) directly — listing the filesystem must never pollute the undo
    // stack or mosh-log.jsonl. There is no new mutation path: the UI imports a chosen
    // file via the existing import_clip command (which re-validates at import time).
    //
    // Never recurses (one level per call). Never writes / deletes / mkdir. Graceful on
    // a missing / not-a-directory / permission-denied path: returns ok:true with
    // exists:false + an error string + the well-known roots so the UI can recover.
    // errResult is reserved for a genuinely malformed request.
    using TFTF = File::TypesOfFileToFind;
    static const StringArray audioExts { ".wav", ".aif", ".aiff", ".flac", ".mp3", ".ogg" };

    // Well-known roots — ALWAYS returned regardless of path validity, so the browser
    // always has sane recovery targets. Skip-if-absent keeps this strictly read-only
    // (we never create the imports dir just to advertise it).
    Array<var> roots;
    auto addRoot = [&] (const String& name, const File& dir)
    {
        if (dir.isDirectory())
        {
            auto* o = new DynamicObject();
            o->setProperty ("name", name);
            o->setProperty ("path", dir.getFullPathName());
            roots.add (var (o));
        }
    };
    addRoot ("Home",     File::getSpecialLocation (File::userHomeDirectory));
    addRoot ("Music",    File::getSpecialLocation (File::userMusicDirectory));
    addRoot ("Desktop",  File::getSpecialLocation (File::userDesktopDirectory));
    addRoot ("Documents",File::getSpecialLocation (File::userDocumentsDirectory));
    addRoot ("Imports",  eng.sessionDir().getChildFile ("imports"));

    auto makeResult = [&] (const File& dir, bool exists, const String& error,
                           const Array<var>& entries, const File* parentForUp) -> juce::var
    {
        auto* data = new DynamicObject();
        data->setProperty ("path", dir.getFullPathName());
        // parent drives the Up button; null at the filesystem root.
        if (parentForUp != nullptr && *parentForUp != dir && parentForUp->isDirectory())
            data->setProperty ("parent", parentForUp->getFullPathName());
        else
            data->setProperty ("parent", var());   // null
        data->setProperty ("exists", exists);
        data->setProperty ("error", error.isNotEmpty() ? var (error) : var());
        data->setProperty ("roots", roots);
        data->setProperty ("entries", entries);
        return okResult ("list_directory", var (data));
    };

    const auto req = args.getProperty ("path", var()).toString();

    // Resolve the target. Empty -> default to Home. NEVER resolve a relative path
    // against the (unstable) process cwd, and NEVER construct File() with a non-absolute
    // path (that trips a JUCE assertion) — guard with isAbsolutePath first.
    File dir;
    if (req.isEmpty())
    {
        dir = File::getSpecialLocation (File::userHomeDirectory);
    }
    else if (! File::isAbsolutePath (req))
    {
        // Malformed/relative request: return the home dir's parent? No — just report
        // invalid with roots so the UI recovers, without ever building a relative File.
        auto* data = new DynamicObject();
        data->setProperty ("path", req);
        data->setProperty ("parent", var());
        data->setProperty ("exists", false);
        data->setProperty ("error", "invalid path (must be absolute)");
        data->setProperty ("roots", roots);
        data->setProperty ("entries", Array<var>());
        return okResult ("list_directory", var (data));
    }
    else
    {
        dir = File (req);
    }

    File parent = dir.getParentDirectory();

    if (! dir.isDirectory())
        return makeResult (dir, false, "not a directory or not found", Array<var>(), &parent);
    if (! dir.hasReadAccess())
        return makeResult (dir, false, "permission denied", Array<var>(), &parent);

    // Gather sub-directories then audio files, each sorted case-insensitively, dirs
    // first. ignoreHiddenFiles keeps dotfiles / .DS_Store out. searchRecursively=false.
    Array<File> dirs  = dir.findChildFiles (TFTF::findDirectories | TFTF::ignoreHiddenFiles, false, "*");
    Array<File> files = dir.findChildFiles (TFTF::findFiles       | TFTF::ignoreHiddenFiles, false, "*");

    struct ByName { int compareElements (const File& a, const File& b) const {
        return a.getFileName().compareIgnoreCase (b.getFileName()); } } byName;
    dirs.sort (byName);
    files.sort (byName);

    Array<var> entries;
    auto addEntry = [&] (const File& f, bool isDir)
    {
        auto* o = new DynamicObject();
        o->setProperty ("name", f.getFileName());
        o->setProperty ("path", f.getFullPathName());
        o->setProperty ("isDir", isDir);
        // File::getSize() is int64; juce::var has no int64 ctor — store as double to
        // avoid overflow on large files (formatted in the UI).
        o->setProperty ("size", isDir ? var() : var ((double) f.getSize()));
        entries.add (var (o));
    };

    for (auto& d : dirs)  addEntry (d, true);
    for (auto& f : files)
        if (audioExts.contains (f.getFileExtension().toLowerCase()))
            addEntry (f, false);

    return makeResult (dir, true, {}, entries, &parent);
}

juce::var MoshOps::cmdGetCommandLog (const juce::var& args)
{
    // READ-ONLY inspector over the canonical command log (mosh-log.jsonl). This is
    // the one command that must NOT log/transact/emit — doing so would pollute the
    // very file it returns (and make get_command_log appear in its own results).
    // Modelled on cmdListAudioDevices / cmdListPlugins: returns okResult directly.
    int limit = (int) args.getProperty ("limit", 50);
    if (limit <= 0) limit = 50;
    if (limit > kCommandLogInspectorMaxEntries) limit = kCommandLogInspectorMaxEntries;

    const auto file = eng.sessionDir().getChildFile ("mosh-log.jsonl");
    refreshCommandLogCacheIfNeeded (file);

    Array<var> recent;
    int total = 0;
    double logBytes = 0.0;
    {
        const juce::ScopedLock sl (commandLogCacheLock_);
        total = (int) commandLogTotal_;
        logBytes = (double) juce::jmax<juce::int64> (commandLogBytes_, 0);

        for (int i = commandLogRecentEntries_.size() - 1; i >= 0 && recent.size() < limit; --i)
            recent.add (commandLogRecentEntries_.getReference (i));
    }

    auto* data = new DynamicObject();
    data->setProperty ("entries", recent);
    data->setProperty ("total", total);
    data->setProperty ("limit", limit);
    data->setProperty ("logBytes", logBytes);
    return okResult ("get_command_log", var (data));
}

// Applies a device-setup patch (type/output/input/sampleRate/bufferSize) to the
// AudioDeviceManager. Returns the error string (empty == success). NO logging / no
// snapshot emit — the callers (set_audio_device / set_buffer_size) log exactly once
// under their own command name so the JSONL has one line per user action.
juce::String MoshOps::applyAudioDeviceSetup (const juce::var& args)
{
    auto& dm = adm();

    // Device type switch (optional).
    const auto type = args.getProperty ("type", var()).toString();
    if (type.isNotEmpty() && type != dm.getCurrentAudioDeviceType())
        dm.setCurrentAudioDeviceType (type, true);

    auto setup = dm.getAudioDeviceSetup();
    if (args.hasProperty ("outputDevice"))
        setup.outputDeviceName = args.getProperty ("outputDevice", var()).toString();
    if (args.hasProperty ("inputDevice"))
    {
        setup.inputDeviceName = args.getProperty ("inputDevice", var()).toString();
        // Only request default input channels when an input device is selected.
        setup.inputChannels.clear();
        setup.useDefaultInputChannels = setup.inputDeviceName.isNotEmpty();
    }
    if (args.hasProperty ("sampleRate"))
        setup.sampleRate = (double) args.getProperty ("sampleRate", 0.0);
    if (args.hasProperty ("bufferSize"))
        setup.bufferSize = (int) args.getProperty ("bufferSize", 0);
    setup.useDefaultOutputChannels = true;

    // setAudioDeviceSetup returns an ERROR STRING (empty == success) — do not invert.
    const auto err = dm.setAudioDeviceSetup (setup, true);
    if (err.isNotEmpty())
        return err;

    // Rebuild Tracktion's wave-device wrappers + flush the async device update
    // before the next snapshot.
    eng.engine().getDeviceManager().rescanWaveDeviceList();
    if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
        mm->runDispatchLoopUntil (50);

    // PRE-001 — persist the chosen device setup to the session dir so it is restored
    // on the next launch (MoshEngine reads it before the MOSH_AUDIO_OUTPUT_DEVICE env
    // fallback). A machine/whole-app preference, written without the undo manager.
    if (auto stateXml = std::unique_ptr<juce::XmlElement> (adm().createStateXml()))
        stateXml->writeTo (eng.sessionDir().getChildFile ("audio-device.xml"));

    return {};
}

juce::var MoshOps::cmdSetAudioDevice (const juce::var& args)
{
    // Graceful degradation: headless / no-audio session has no device to drive.
    // Log the failed attempt (undoable:false) so the JSONL trail records it, then
    // return a real, honest error (NOT a crash).
    if (! eng.hasAudio())
    {
        logLine ("set_audio_device", args, false, "no audio device in this session", false);
        return errResult ("set_audio_device", "no audio device in this session");
    }

    const auto err = applyAudioDeviceSetup (args);
    if (err.isNotEmpty())
    {
        logLine ("set_audio_device", args, false, err, false);
        return errResult ("set_audio_device", err);
    }

    logLine ("set_audio_device", args, true, {}, false);   // machine preference — not undoable
    emitSnapshotInvalidated();
    return okResult ("set_audio_device", currentAudioSelection());
}

juce::var MoshOps::cmdRetryAudioDevice (const juce::var& args)
{
    // AUD-017 — the recovery half of the bounded device open. When startup could not
    // open the device inside its timeout the app runs WITHOUT audio and says so
    // (snapshot.session.audioDeviceError); this lets the user fix the hardware and get
    // audio back without relaunching. NOT undoable (a machine/device action, like
    // set_audio_device) and NOT agent-callable — it is a response to an error banner.
    //
    // Hermetic by construction: audioRequested() is false in every headless run, so
    // this returns an error WITHOUT touching the HAL. The one hardware-touching branch
    // is unreachable from --selftest.
    if (! eng.audioRequested())
    {
        logLine ("retry_audio_device", args, false, "no audio device in this session", false);
        return errResult ("retry_audio_device", "no audio device in this session");
    }

    if (auto err = eng.retryAudioDevice(); err.isNotEmpty())
    {
        logLine ("retry_audio_device", args, false, err, false);
        emitSnapshotInvalidated();   // the error text itself changed — let the UI re-read
        return errResult ("retry_audio_device", err);
    }

    logLine ("retry_audio_device", args, true, {}, false);
    emitSnapshotInvalidated();
    return okResult ("retry_audio_device", currentAudioSelection());
}

juce::var MoshOps::cmdSetBufferSize (const juce::var& args)
{
    // Thin convenience wrapper = a bufferSize-only device-setup. Maps 1:1 to a UI
    // control; shares the no-device guard + non-undoable logging. Logs exactly ONE
    // JSONL line under set_buffer_size (it applies the setup directly, not via
    // cmdSetAudioDevice, so there is no phantom set_audio_device line).
    if (! args.hasProperty ("bufferSize"))
        return errResult ("set_buffer_size", "missing 'bufferSize'");
    if (! eng.hasAudio())
    {
        logLine ("set_buffer_size", args, false, "no audio device in this session", false);
        return errResult ("set_buffer_size", "no audio device in this session");
    }

    auto* patch = new DynamicObject();
    patch->setProperty ("bufferSize", args.getProperty ("bufferSize", var()));
    const auto err = applyAudioDeviceSetup (var (patch));
    if (err.isNotEmpty())
    {
        logLine ("set_buffer_size", args, false, err, false);
        return errResult ("set_buffer_size", err);
    }

    logLine ("set_buffer_size", args, true, {}, false);   // machine preference — not undoable
    emitSnapshotInvalidated();
    return okResult ("set_buffer_size", currentAudioSelection());
}

juce::var MoshOps::cmdSetAudioThreads (const juce::var& args)
{
    // PRF-001 — multicore audio processing preference. This is a GENUINE knob, not a
    // dead toggle: it drives MoshEngineBehaviour::getNumberOfCPUsToUseForAudio(), which
    // Tracktion applies as setNumThreads(N-1) on the parallel playback/render graph.
    // UI value 1 => 0 worker threads => single-threaded; higher => more parallelism.
    //
    // Unlike set_buffer_size / set_audio_device this is NOT gated on an open audio
    // device: the preference + readout are valid headless (only the live re-apply,
    // handled inside setAudioThreadPref, is conditional on a running context). That
    // keeps it testable in --selftest (which runs MOSH_NO_AUDIO).
    if (! args.hasProperty ("threads"))
        return errResult ("set_audio_threads", "missing 'threads'");

    const int cores = eng.availableCores();
    const int requested = (int) args.getProperty ("threads", var());

    // Reject clearly-invalid input (<=0 or absurdly large) rather than silently
    // coercing it into the valid range — keeps the readout honest and the UI safe.
    if (requested < 1 || requested > 4096)
        return errResult ("set_audio_threads",
                          "threads out of range (expected 1.." + String (cores) + ")");

    const int clamped = juce::jlimit (1, cores, requested);   // clamp to the real core count
    eng.setAudioThreadPref (clamped);                         // store + LIVE re-apply (if a device is open)

    logLine ("set_audio_threads", args, true, {}, false);     // machine preference — NOT undoable
    emitSnapshotInvalidated();

    auto* data = new DynamicObject();
    data->setProperty ("availableCores", cores);
    data->setProperty ("audioThreads", eng.effectiveAudioThreads());
    return okResult ("set_audio_threads", var (data));
}

juce::var MoshOps::cmdNewProject (const juce::var& args)
{
    unregisterAllMeterClients();           // old measurers valid here; dead after the swap
    auto name = args.getProperty ("name", var()).toString().trim();
    if (name.isEmpty())
        name = "untitled-" + String (Time::getCurrentTime().toMilliseconds());

    auto file = eng.sessionDir().getChildFile ("projects")
                    .getChildFile (File::createLegalFileName (name))
                    .withFileExtension ("tracktionedit");

    eng.newProject (file);                 // stops transport + frees ctx before swap, re-points retriever
    lastSeenContext = nullptr;             // old ctx freed; force master-meter re-attach to the new ctx
    logFile = eng.sessionDir().getChildFile ("mosh-log.jsonl");
    invalidateCommandLogCache();
    refreshMpStemDir();   // PR-2: eng.editFile() just changed
    logLine ("new_project", args, true, {}, false);   // replaces the Edit — not undoable
    emitSnapshotInvalidated();

    auto* data = new DynamicObject();
    data->setProperty ("editFile", eng.editFile().getFullPathName());
    return okResult ("new_project", var (data));
}

// Shared open-by-path body for open_project / open_recent. The caller has already
// validated the file exists; this performs the identical Edit-swap dance both ops
// need (one mutation path). `commandName` tags the log/result so each op stays
// distinguishable in the JSONL + the structured envelope.
juce::var MoshOps::openProjectFile (const File& file, const juce::var& args, const char* commandName)
{
    unregisterAllMeterClients();           // old measurers valid here; dead after the swap
    // PRJ-FMT — a newer-format file is refused; the current project stays loaded + saveable.
    if (auto refusal = eng.openProject (file); refusal.isNotEmpty())  // else: stops transport + frees ctx before swap
    {
        logLine (commandName, args, false, refusal, false);
        emitSnapshotInvalidated();         // re-attaches meters to the unchanged context
        return errResult (commandName, refusal);
    }
    lastSeenContext = nullptr;             // old ctx freed; force master-meter re-attach to the new ctx
    logFile = eng.sessionDir().getChildFile ("mosh-log.jsonl");
    invalidateCommandLogCache();
    refreshMpStemDir();   // PR-2: eng.editFile() just changed
    logLine (commandName, args, true, {}, false);  // replaces the Edit — not undoable
    emitSnapshotInvalidated();

    auto* data = new DynamicObject();
    data->setProperty ("editFile", eng.editFile().getFullPathName());
    return okResult (commandName, var (data));
}

juce::var MoshOps::cmdOpenProject (const juce::var& args)
{
    const auto path = args.getProperty ("file", var()).toString();
    if (path.isEmpty()) return errResult ("open_project", "missing 'file'");

    File file (path);
    if (! file.existsAsFile()) return errResult ("open_project", "file not found: " + path);

    return openProjectFile (file, args, "open_project");
}

// PRJ — Open Recent by position in the recent list (0 = most-recent). The backend
// owns the resolution so the UI never round-trips a stale path: the index is mapped
// against the SAME existing-file Recent list the snapshot exposes (eng.recentProjects),
// which is already filtered to files that exist. Out-of-range indices and an
// already-pruned entry degrade to a clean error result. Replaces the Edit — not undoable.
juce::var MoshOps::cmdOpenRecent (const juce::var& args)
{
    if (! args.hasProperty ("index")) return errResult ("open_recent", "missing 'index'");
    const int index = (int) args.getProperty ("index", var (0));
    if (index < 0) return errResult ("open_recent", "index out of range: " + String (index));

    const auto recents = eng.recentProjects();   // newest-first, existing files only
    if (! recents.isArray() || index >= recents.size())
        return errResult ("open_recent", "no recent project at index " + String (index));

    const auto path = recents[index].getProperty ("path", var()).toString();
    File file (path);
    if (path.isEmpty() || ! file.existsAsFile())
        return errResult ("open_recent", "recent project no longer on disk: " + path);

    return openProjectFile (file, args, "open_recent");
}

juce::var MoshOps::cmdSaveAs (const juce::var& args)
{
    const auto path = args.getProperty ("file", var()).toString();
    if (path.isEmpty()) return errResult ("save_as", "missing 'file'");

    File file (path);
    if (file.getFileExtension().isEmpty())
        file = file.withFileExtension ("tracktionedit");

    // AGT-MEM — capture the OLD edit file BEFORE saveProjectAs adopts the new one, so
    // the project-scope agent-memory sidecar (a sibling of the edit file, keyed by its
    // name) can be carried over below.
    const auto oldEditFile = eng.editFile();

    const bool didSave = eng.saveProjectAs (file);   // saveAs + adopt the new backing file + consolidate wave/sampler audio
    logLine ("save_as", args, didSave, didSave ? String() : String ("saveAs failed"), false);
    if (! didSave) return errResult ("save_as", "saveAs failed");

    // AGT-MEM — carry the project-scope agent-memory sidecar to the new location (the
    // engine's own saveProjectAs only consolidates audio/sampler sources; it knows
    // nothing about this sidecar). Best-effort: a copy failure must never fail the
    // save_as command itself (matches consolidateRenderArtifacts' posture below).
    mosh::AgentMemoryStore::copySidecarForSaveAs (oldEditFile, eng.editFile());

    // AL-009 — consolidate Tier-B render-layer artifacts too. eng.saveProjectAs localises
    // wave-clip sources + sampler sounds, but a render layer's cacheArtifact (the file
    // freeze_layer / re-accept_render depend on) is written by finalizeRender as an
    // ABSOLUTE path into the shared session pool, NOT the project dir. Copy each into the
    // project's audio/renders/ and re-point with a portable RELATIVE ref so the rendered
    // audio survives a project move, then persist the rewritten refs. Kept here (not in
    // MoshEngine, a prime-directive seam) and after the engine consolidation.
    mosh::consolidateRenderArtifacts (eng.edit().state, eng.editFile().getParentDirectory());
    eng.save();
    refreshMpStemDir();   // PR-2: eng.editFile() just changed (saveProjectAs adopts the new backing file)
    emitSnapshotInvalidated();

    auto* data = new DynamicObject();
    data->setProperty ("file", eng.editFile().getFullPathName());
    return okResult ("save_as", var (data));
}

} // namespace mosh
