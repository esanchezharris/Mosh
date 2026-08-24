#include "ReImagineProcessor.h"
#include "ReImagineEditor.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace mosh::reimagine
{
juce::AudioProcessorValueTreeState::ParameterLayout ReImagineProcessor::makeParameters()
{
    juce::AudioProcessorValueTreeState::ParameterLayout layout;
    layout.add (std::make_unique<juce::AudioParameterFloat> (
        juce::ParameterID { "mix", 1 }, "Mix",
        juce::NormalisableRange<float> (0.0f, 1.0f, 0.001f), 1.0f));
    return layout;
}

ReImagineProcessor::ReImagineProcessor()
    : AudioProcessor (BusesProperties()
          .withInput ("Input", juce::AudioChannelSet::stereo(), true)
          .withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
      juce::Thread ("Mosh Re-Imagine worker"),
      parameters (*this, nullptr, "MoshReImagineParameters", makeParameters())
{
    mixValue = parameters.getRawParameterValue ("mix");
    startThread (juce::Thread::Priority::low);
}

ReImagineProcessor::~ReImagineProcessor()
{
    juce::String jobToCancel;
    {
        const juce::ScopedLock lock (stateLock);
        jobToCancel = currentJobId;
    }
    if (jobToCancel.isNotEmpty())
        service.cancel (jobToCancel);
    signalThreadShouldExit();
    workerEvent.signal();
    stopThread (5000);
}

void ReImagineProcessor::prepareToPlay (double sampleRate, int)
{
    const auto channels = getTotalNumInputChannels();
    currentSampleRate.store (sampleRate, std::memory_order_release);
    currentChannels.store (channels, std::memory_order_release);
    const auto maximum = static_cast<int> (std::ceil (sampleRate * 240.0));
    captureBuffer.setSize (channels, maximum, false, true, false);
    captureBuffer.clear();
    transfer.prepare (sampleRate, channels, 240.0);
    transferStateMirror.store (static_cast<int> (CaptureState::idle), std::memory_order_release);
    captureWriteOffset.store (0, std::memory_order_release);
    loadRequested.store (1, std::memory_order_release);
    workerEvent.signal();
}

void ReImagineProcessor::releaseResources() {}

bool ReImagineProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    const auto input = layouts.getMainInputChannelSet();
    return (input == juce::AudioChannelSet::mono() || input == juce::AudioChannelSet::stereo())
        && input == layouts.getMainOutputChannelSet();
}

std::optional<HostPosition> ReImagineProcessor::hostPosition() const noexcept
{
    auto* playHead = getPlayHead();
    if (playHead == nullptr)
        return std::nullopt;
    const auto position = playHead->getPosition();
    if (! position)
        return std::nullopt;
    const auto samples = position->getTimeInSamples();
    const auto ppq = position->getPpqPosition();
    const auto bpm = position->getBpm();
    if (! samples || ! ppq || ! bpm)
        return std::nullopt;
    HostPosition result;
    result.isPlaying = position->getIsPlaying();
    result.isLooping = position->getIsLooping();
    result.samplePosition = *samples;
    result.ppqPosition = *ppq;
    result.bpm = *bpm;
    if (auto signature = position->getTimeSignature())
        result.timeSignatureNumerator = signature->numerator;
    return result;
}

void ReImagineProcessor::captureInput (const juce::AudioBuffer<float>& input, int64_t offset) noexcept
{
    const auto count = std::min<int64_t> (input.getNumSamples(), captureBuffer.getNumSamples() - offset);
    if (count <= 0)
        return;
    const auto channels = currentChannels.load (std::memory_order_relaxed);
    for (int channel = 0; channel < channels; ++channel)
        juce::FloatVectorOperations::copy (captureBuffer.getWritePointer (channel, static_cast<int> (offset)),
                                           input.getReadPointer (channel), static_cast<int> (count));
    captureWriteOffset.store (offset + count, std::memory_order_release);
}

int ReImagineProcessor::sampleForPpq (const PlaybackRegion& region, double ppq) const noexcept
{
    if (region.tempoMap.empty())
        return static_cast<int> (std::llround ((ppq - region.ppqStart) * 0.5 * region.sampleRate));
    const auto found = std::upper_bound (region.tempoMap.begin(), region.tempoMap.end(), ppq,
                                         [] (double value, const TempoPoint& point)
                                         {
                                             return value < point.ppq;
                                         });
    const auto index = found == region.tempoMap.begin()
        ? size_t { 0 } : static_cast<size_t> (std::distance (region.tempoMap.begin(), found) - 1);
    const auto& point = region.tempoMap[index];
    const auto seconds = region.secondsAtTempoPoint[index]
                       + std::max (0.0, ppq - point.ppq) * 60.0 / point.bpm;
    return static_cast<int> (std::llround (seconds * region.sampleRate));
}

void ReImagineProcessor::renderSelected (juce::AudioBuffer<float>& buffer, const HostPosition& host) noexcept
{
    snapshotReaders.fetch_add (1, std::memory_order_acq_rel);
    const auto* snapshot = audibleSnapshot.load (std::memory_order_acquire);
    if (snapshot == nullptr || compareDry.load (std::memory_order_acquire) != 0)
    {
        snapshotReaders.fetch_sub (1, std::memory_order_release);
        return;
    }
    const auto mix = mixValue->load();
    const auto ppqPerSample = host.bpm / (60.0 * currentSampleRate.load (std::memory_order_relaxed));
    const auto fadePpq = host.bpm * 0.010 / 60.0;
    for (int sample = 0; sample < buffer.getNumSamples(); ++sample)
    {
        const auto ppq = host.ppqPosition + sample * ppqPerSample;
        const PlaybackRegion* region = nullptr;
        for (const auto& candidate : snapshot->regions)
            if (ppq >= candidate->ppqStart && ppq < candidate->ppqEnd)
            {
                region = candidate.get();
                break;
            }
        if (region == nullptr)
            continue;
        if (region->stale.load (std::memory_order_acquire) != 0)
            continue;
        if (! tempoMatches (region->tempoMap, ppq, host.bpm))
        {
            int expected = 0;
            region->stale.compare_exchange_strong (expected, 2, std::memory_order_acq_rel);
            continue;
        }
        const auto gains = substitutionGainsForPosition (ppq, region->ppqStart, region->ppqEnd,
                                                         fadePpq, mix, false);
        if (gains.wet <= 0.0f)
            continue;
        const auto assetSample = sampleForPpq (*region, ppq);
        if (assetSample < 0 || assetSample >= region->audio.getNumSamples())
            continue;
        for (int channel = 0; channel < buffer.getNumChannels(); ++channel)
        {
            const auto sourceChannel = std::min (channel, region->audio.getNumChannels() - 1);
            const auto rendered = region->audio.getSample (sourceChannel, assetSample);
            buffer.setSample (channel, sample,
                              buffer.getSample (channel, sample) * gains.dry + rendered * gains.wet);
        }
    }
    snapshotReaders.fetch_sub (1, std::memory_order_release);
}

void ReImagineProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused (midi);
    juce::ScopedNoDenormals noDenormals;
    const auto position = hostPosition();
    const auto offline = isNonRealtime();
    offlineProcessing.store (offline ? 1 : 0, std::memory_order_release);
    lastHostPlaying.store (position && position->isPlaying ? 1 : 0, std::memory_order_release);
    if (! offline && armTransferRequested.exchange (0, std::memory_order_acq_rel) != 0)
    {
        captureWriteOffset.store (0, std::memory_order_release);
        transfer.arm();
    }
    if (! offline && transfer.state() == CaptureState::capturing && (! position || ! position->isPlaying))
    {
        transfer.stop();
        finalizationPending.store (1, std::memory_order_release);
        finalizeRequested.store (1, std::memory_order_release);
    }
    if (! offline && stopTransferRequested.exchange (0, std::memory_order_acq_rel) != 0)
    {
        if (transfer.state() == CaptureState::capturing)
        {
            transfer.stop();
            finalizationPending.store (1, std::memory_order_release);
            finalizeRequested.store (1, std::memory_order_release);
        }
        else if (transfer.state() == CaptureState::armed)
            transfer.cancel();
    }
    if (! offline && (transfer.state() == CaptureState::armed || transfer.state() == CaptureState::capturing))
    {
        const auto offset = captureWriteOffset.load (std::memory_order_relaxed);
        const auto event = transfer.beginOrContinue (position, buffer.getNumSamples(), buffer.getNumChannels());
        if (event == CaptureEvent::started || event == CaptureEvent::continued
            || event == CaptureEvent::reachedCaptureCap)
            captureInput (buffer, offset);
        if (event == CaptureEvent::reachedCaptureCap)
        {
            finalizationPending.store (1, std::memory_order_release);
            finalizeRequested.store (1, std::memory_order_release);
        }
        if (event == CaptureEvent::abortedMissingTiming || event == CaptureEvent::abortedDiscontinuity
            || event == CaptureEvent::abortedLoopWrap || event == CaptureEvent::abortedLayoutChange
            || event == CaptureEvent::abortedTempoMapCapacity)
            captureAbortEvent.store (static_cast<int> (event), std::memory_order_release);
    }
    if (position && shouldRenderSelected (*position, offline))
        renderSelected (buffer, *position);
    transferStateMirror.store (static_cast<int> (transfer.state()), std::memory_order_release);
}

void ReImagineProcessor::toggleTransfer()
{
    const auto state = static_cast<CaptureState> (transferStateMirror.load (std::memory_order_acquire));
    if (state == CaptureState::capturing || state == CaptureState::armed)
    {
        stopTransferRequested.store (1, std::memory_order_release);
        return;
    }
    if (finalizationPending.load (std::memory_order_acquire) != 0)
        return setStatus ("Finishing the previous Transfer...");
    if (lastHostPlaying.load (std::memory_order_acquire) != 0)
        return setStatus ("Stop Live before arming Transfer");
    armTransferRequested.store (1, std::memory_order_release);
    transferStateMirror.store (static_cast<int> (CaptureState::armed), std::memory_order_release);
    setStatus ("Transfer armed - press Play in Live");
}

void ReImagineProcessor::replacePendingOverlap()
{
    const juce::ScopedLock lock (stateLock);
    if (! regionCollection.pendingOverlap())
        return;
    const auto pending = *regionCollection.pendingOverlap();
    const auto replacementId = pending.id;
    RegionCollection current;
    for (const auto& existing : pluginState.regions)
        current.offer (existing);
    current.offer (pending);
    regionCollection = std::move (current);
    regionCollection.replaceOverlaps();
    pluginState.regions = regionCollection.regions();
    if (replacementId.isNotEmpty())
        pluginState.selectedRegionId = replacementId;
    uiStatus = "Overlapping region replaced";
    loadRequested.store (1, std::memory_order_release);
    workerEvent.signal();
}

void ReImagineProcessor::discardPendingOverlap()
{
    const juce::ScopedLock lock (stateLock);
    regionCollection.discardPending();
    uiStatus = "Overlapping Transfer discarded";
}

void ReImagineProcessor::commitRack (RackSettings rack)
{
    const auto revision = nextRevision.fetch_add (1, std::memory_order_acq_rel);
    const juce::ScopedLock lock (stateLock);
    pluginState.rack = std::move (rack);
    if (regionCollection.pendingOverlap())
    {
        uiStatus = "Choose Replace or Discard for the overlapping Transfer first";
        return;
    }
    if (offlineProcessing.load (std::memory_order_acquire) != 0)
    {
        uiStatus = "Rack saved; offline export never launches inference";
        return;
    }
    if (selectedRegionUnsafe() == nullptr)
    {
        uiStatus = "Transfer a passage before rendering";
        return;
    }
    renderCoordinator.commitRequest ({ revision, selectedRegionUnsafe()->id,
                                       pluginState.rack, pluginState.labEnabled });
    renderRequested.store (1, std::memory_order_release);
    uiStatus = "Render queued";
    workerEvent.signal();
}

void ReImagineProcessor::newTake()
{
    auto rack = stateSnapshot().rack;
    ++rack.seed;
    commitRack (std::move (rack));
}

void ReImagineProcessor::setSelectedTake (int index)
{
    const juce::ScopedLock lock (stateLock);
    if (auto* region = selectedRegionUnsafe(); region != nullptr
        && juce::isPositiveAndBelow (index, static_cast<int> (region->takes.size())))
    {
        region->selectedTakeId = region->takes[static_cast<size_t> (index)].id;
        loadRequested.store (1, std::memory_order_release);
        workerEvent.signal();
    }
}

void ReImagineProcessor::resetSelection()
{
    const juce::ScopedLock lock (stateLock);
    if (auto* region = selectedRegionUnsafe())
        region->selectedTakeId.clear();
    uiStatus = "Dry - take history preserved";
    loadRequested.store (1, std::memory_order_release);
    workerEvent.signal();
}

void ReImagineProcessor::setSelectedRegion (int index)
{
    const juce::ScopedLock lock (stateLock);
    if (juce::isPositiveAndBelow (index, static_cast<int> (pluginState.regions.size())))
        pluginState.selectedRegionId = pluginState.regions[static_cast<size_t> (index)].id;
}

void ReImagineProcessor::relinkSelectedAsset (const juce::File& wav)
{
    juce::String expected;
    bool source = false;
    {
        const juce::ScopedLock lock (stateLock);
        const auto* region = selectedRegionUnsafe();
        if (region == nullptr)
            return;
        if (! assets.verify (assets.sourceFile (region->sourceHash), region->sourceHash))
        {
            expected = region->sourceHash;
            source = true;
        }
        else
            for (const auto& take : region->takes)
                if (take.id == region->selectedTakeId)
                    expected = take.assetHash;
    }
    if (expected.isEmpty())
        return setStatus ("No selected missing asset to Relink");
    juce::String error;
    if (! assets.relink (wav, expected, source, error))
        return setStatus (error);
    setStatus ("Asset Relinked and hash verified");
    loadRequested.store (1, std::memory_order_release);
    workerEvent.signal();
}

void ReImagineProcessor::setLabEnabled (bool enabled)
{
    const juce::ScopedLock lock (stateLock);
    pluginState.labEnabled = enabled;
}

PluginStateV1 ReImagineProcessor::stateSnapshot() const
{
    const juce::ScopedLock lock (stateLock);
    return pluginState;
}

juce::String ReImagineProcessor::statusText() const
{
    const juce::ScopedLock lock (stateLock);
    return uiStatus;
}

bool ReImagineProcessor::transferActive() const noexcept
{
    const auto state = static_cast<CaptureState> (transferStateMirror.load (std::memory_order_acquire));
    return state == CaptureState::armed || state == CaptureState::capturing;
}

bool ReImagineProcessor::hasPendingOverlap() const
{
    const juce::ScopedLock lock (stateLock);
    return regionCollection.pendingOverlap().has_value();
}

void ReImagineProcessor::getStateInformation (juce::MemoryBlock& destination)
{
    auto state = stateSnapshot();
    state.mix = mixValue->load();
    const auto json = serializeState (state);
    destination.replaceAll (json.toRawUTF8(), static_cast<size_t> (json.getNumBytesAsUTF8()));
}

void ReImagineProcessor::setStateInformation (const void* data, int size)
{
    const auto json = juce::String::fromUTF8 (static_cast<const char*> (data), size);
    auto restored = deserializeState (json);
    if (! restored)
        return;
    const auto restoredMix = restored->mix;
    {
        const juce::ScopedLock lock (stateLock);
        pluginState = std::move (*restored);
        regionCollection = {};
        for (const auto& region : pluginState.regions)
            regionCollection.offer (region);
        uiStatus = "Set restored - loading selected take";
    }
    if (auto* mixParameter = parameters.getParameter ("mix"))
        mixParameter->setValueNotifyingHost (juce::jlimit (0.0f, 1.0f, restoredMix));
    loadRequested.store (1, std::memory_order_release);
    workerEvent.signal();
}

TransferRegion* ReImagineProcessor::selectedRegionUnsafe()
{
    for (auto& region : pluginState.regions)
        if (region.id == pluginState.selectedRegionId)
            return &region;
    return nullptr;
}

const TransferRegion* ReImagineProcessor::selectedRegionUnsafe() const
{
    for (const auto& region : pluginState.regions)
        if (region.id == pluginState.selectedRegionId)
            return &region;
    return nullptr;
}

void ReImagineProcessor::setStatus (juce::String text)
{
    const juce::ScopedLock lock (stateLock);
    uiStatus = std::move (text);
}

void ReImagineProcessor::refreshLoraCatalog()
{
    {
        const juce::ScopedLock lock (stateLock);
        loraCatalog.status = LoraCatalogStatus::loading;
        loraCatalog.error.clear();
        ++loraCatalog.revision;
    }
    loraCatalogRequested.store (1, std::memory_order_release);
    workerEvent.signal();
}

LoraCatalogSnapshot ReImagineProcessor::loraCatalogSnapshot() const
{
    const juce::ScopedLock lock (stateLock);
    return loraCatalog;
}

void ReImagineProcessor::finalizeCapture()
{
    const auto samples = static_cast<int> (captureWriteOffset.load (std::memory_order_acquire));
    if (samples <= 0)
        return setStatus ("Transfer contained no audio");
    auto work = assets.root().getSiblingFile ("work");
    work.createDirectory();
    auto temp = work.getNonexistentChildFile ("transfer", ".wav", false);
    juce::WavAudioFormat wav;
    auto output = std::unique_ptr<juce::FileOutputStream> (temp.createOutputStream());
    if (! output)
        return setStatus ("Could not create Transfer asset");
    const auto captureRate = currentSampleRate.load (std::memory_order_acquire);
    const auto captureChannels = currentChannels.load (std::memory_order_acquire);
    const auto writerOptions = juce::AudioFormatWriterOptions()
        .withSampleRate (captureRate)
        .withNumChannels (captureChannels)
        .withBitsPerSample (24);
    std::unique_ptr<juce::OutputStream> outputStream (output.release());
    auto writer = wav.createWriterFor (outputStream, writerOptions);
    if (! writer || ! writer->writeFromAudioSampleBuffer (captureBuffer, 0, samples))
        return setStatus ("Could not write Transfer asset");
    writer.reset();
    juce::String error;
    const auto hash = assets.importWav (temp, true, error);
    temp.deleteFile();
    if (hash.isEmpty())
        return setStatus (error);

    TransferRegion region;
    region.id = juce::Uuid().toString();
    region.ppqStart = transfer.startPpq();
    region.ppqEnd = transfer.endPpq();
    region.tempoMap = transfer.tempoMap();
    region.sourceHash = hash;
    const juce::ScopedLock lock (stateLock);
    regionCollection = {};
    for (const auto& existing : pluginState.regions)
        regionCollection.offer (existing);
    const auto offer = regionCollection.offer (region);
    if (offer == RegionOffer::needsOverlapDecision)
    {
        uiStatus = "Overlap detected - choose Replace or Discard";
        return;
    }
    pluginState.regions = regionCollection.regions();
    pluginState.selectedRegionId = region.id;
    uiStatus = "Transfer ready - edit the rack to Re-Imagine";
}

void ReImagineProcessor::performRender (const RenderRequest& request)
{
    TransferRegion region;
    {
        const juce::ScopedLock lock (stateLock);
        const auto target = std::find_if (pluginState.regions.begin(), pluginState.regions.end(),
                                          [&] (const auto& candidate)
                                          {
                                              return candidate.id == request.regionId;
                                          });
        if (target == pluginState.regions.end())
        {
            const auto completion = renderCoordinator.finish (request.revision, false);
            uiStatus = "Render target no longer exists; request discarded";
            if (completion.startRequest)
                renderRequested.store (1, std::memory_order_release);
            return;
        }
        region = *target;
        uiStatus = "Starting local SA3...";
    }
    juce::String error;
    if (! service.ensureRunning (error))
    {
        setStatus (error);
        const juce::ScopedLock lock (stateLock);
        if (renderCoordinator.finish (request.revision, false).startRequest)
            renderRequested.store (1, std::memory_order_release);
        return;
    }
    const auto input = assets.sourceFile (region.sourceHash);
    if (! assets.verify (input, region.sourceHash))
    {
        setStatus ("Source asset missing or hash mismatch - Relink or Re-transfer");
        const juce::ScopedLock lock (stateLock);
        for (auto& candidate : pluginState.regions)
            if (candidate.id == region.id)
                candidate.status = RegionStatus::missingAsset;
        if (renderCoordinator.finish (request.revision, false).startRequest)
            renderRequested.store (1, std::memory_order_release);
        return;
    }
    auto work = assets.root().getSiblingFile ("work");
    work.createDirectory();
    auto output = work.getNonexistentChildFile ("render", ".wav", false);
    auto manifest = output.withFileExtension ("json");
    const auto jobId = service.submit (input, output, manifest, request.rack,
                                       request.labEnabled, error);
    {
        const juce::ScopedLock lock (stateLock);
        currentJobId = jobId;
    }
    if (jobId.isEmpty())
    {
        setStatus (error);
        const juce::ScopedLock lock (stateLock);
        if (renderCoordinator.finish (request.revision, false).startRequest)
            renderRequested.store (1, std::memory_order_release);
        return;
    }
    bool succeeded = false;
    juce::var returnedManifest;
    while (! threadShouldExit())
    {
        const auto status = service.status (jobId);
        const auto state = status.getProperty ("status", {}).toString();
        renderProgress.store (static_cast<float> (status.getProperty ("progress", 0.0)), std::memory_order_release);
        if (state == "ready")
        {
            succeeded = output.existsAsFile();
            returnedManifest = status.getProperty ("manifest", {});
            break;
        }
        if (state == "error" || state == "cancelled")
        {
            error = status.getProperty ("error", state).toString();
            break;
        }
        wait (200);
    }
    juce::String hash;
    if (succeeded)
        hash = assets.importWav (output, false, error);
    output.deleteFile();
    manifest.deleteFile();
    RenderCompletion completion;
    {
        const juce::ScopedLock lock (stateLock);
        completion = renderCoordinator.finish (request.revision, succeeded && hash.isNotEmpty());
        if (completion.publish)
        {
            const auto target = std::find_if (pluginState.regions.begin(), pluginState.regions.end(),
                                              [&] (const auto& candidate)
                                              {
                                                  return candidate.id == request.regionId;
                                              });
            if (target != pluginState.regions.end())
            {
                RenderTake take;
                take.id = juce::Uuid().toString();
                take.assetHash = hash;
                take.timestampIso8601 = juce::Time::getCurrentTime().toISO8601 (true);
                take.seed = request.rack.seed;
                take.parameters = request.rack;
                take.manifest = returnedManifest;
                target->takes.push_back (take);
                target->selectedTakeId = take.id;
                target->status = RegionStatus::ready;
                uiStatus = "Take ready";
                loadRequested.store (1, std::memory_order_release);
            }
        }
        else if (! completion.startRequest)
            uiStatus = error.isNotEmpty() ? error : "Render failed - previous take remains audible";
    }
    renderProgress.store (0.0f, std::memory_order_release);
    {
        const juce::ScopedLock lock (stateLock);
        if (currentJobId == jobId)
            currentJobId.clear();
    }
    if (completion.startRequest)
        renderRequested.store (1, std::memory_order_release);
}

void ReImagineProcessor::publishPlayback (std::unique_ptr<PlaybackSnapshot> snapshot)
{
    {
        const juce::ScopedLock lock (stateLock);
        for (auto& playbackRegion : snapshot->regions)
            for (const auto& stateRegion : pluginState.regions)
                if (stateRegion.id == playbackRegion->id && stateRegion.status == RegionStatus::staleTempo)
                    playbackRegion->stale.store (1, std::memory_order_relaxed);
    }
    const auto* raw = snapshot.get();
    audibleSnapshot.store (raw, std::memory_order_release);
    while (snapshotReaders.load (std::memory_order_acquire) != 0)
        wait (1);
    ownedPlaybackSnapshot = std::move (snapshot);
}

void ReImagineProcessor::loadSelectedTake()
{
    PluginStateV1 state;
    {
        const juce::ScopedLock lock (stateLock);
        state = pluginState;
    }
    auto playback = std::make_unique<PlaybackSnapshot>();
    playback->regions.reserve (state.regions.size());
    const auto playbackRate = currentSampleRate.load (std::memory_order_acquire);
    const auto playbackChannels = currentChannels.load (std::memory_order_acquire);
    juce::AudioFormatManager formats;
    formats.registerBasicFormats();
    bool missing = false;
    bool loadedAny = false;
    for (const auto& region : state.regions)
    {
        if (region.selectedTakeId.isEmpty())
            continue;
        if (! assets.selectedAssetsAvailable (region))
        {
            missing = true;
            const juce::ScopedLock lock (stateLock);
            for (auto& stateRegion : pluginState.regions)
                if (stateRegion.id == region.id)
                    stateRegion.status = RegionStatus::missingAsset;
            continue;
        }
        const auto take = std::find_if (region.takes.begin(), region.takes.end(), [&] (const auto& candidate)
        {
            return candidate.id == region.selectedTakeId;
        });
        if (take == region.takes.end())
            continue;
        const auto file = assets.renderFile (take->assetHash);
        auto reader = std::unique_ptr<juce::AudioFormatReader> (formats.createReaderFor (file));
        if (! reader || reader->lengthInSamples <= 0
            || reader->lengthInSamples > std::numeric_limits<int>::max())
        {
            missing = true;
            const juce::ScopedLock lock (stateLock);
            for (auto& stateRegion : pluginState.regions)
                if (stateRegion.id == region.id)
                    stateRegion.status = RegionStatus::missingAsset;
            continue;
        }
        const auto ratio = playbackRate / reader->sampleRate;
        const auto outputSamples = static_cast<int> (
            std::ceil (static_cast<double> (reader->lengthInSamples) * ratio));
        juce::AudioBuffer<float> source (static_cast<int> (reader->numChannels),
                                         static_cast<int> (reader->lengthInSamples));
        reader->read (&source, 0, source.getNumSamples(), 0, true, true);
        auto loaded = std::make_unique<PlaybackRegion>();
        loaded->id = region.id;
        loaded->audio.setSize (playbackChannels, outputSamples);
        loaded->sampleRate = playbackRate;
        loaded->ppqStart = region.ppqStart;
        loaded->ppqEnd = region.ppqEnd;
        loaded->tempoMap = region.tempoMap;
        if (loaded->tempoMap.empty())
            loaded->tempoMap.push_back ({ region.ppqStart, 120.0 });
        loaded->secondsAtTempoPoint.resize (loaded->tempoMap.size(), 0.0);
        for (size_t i = 1; i < loaded->tempoMap.size(); ++i)
            loaded->secondsAtTempoPoint[i] = loaded->secondsAtTempoPoint[i - 1]
                + (loaded->tempoMap[i].ppq - loaded->tempoMap[i - 1].ppq)
                    * 60.0 / loaded->tempoMap[i - 1].bpm;
        for (int channel = 0; channel < playbackChannels; ++channel)
        {
            const auto sourceChannel = std::min (channel, source.getNumChannels() - 1);
            const auto* input = source.getReadPointer (sourceChannel);
            auto* output = loaded->audio.getWritePointer (channel);
            if (std::abs (reader->sampleRate - playbackRate) < 0.01)
            {
                juce::FloatVectorOperations::copy (output, input,
                                                   std::min (outputSamples, source.getNumSamples()));
                continue;
            }
            const auto speedRatio = reader->sampleRate / playbackRate;
            for (int sample = 0; sample < outputSamples; ++sample)
            {
                const auto sourcePosition = static_cast<double> (sample) * speedRatio;
                const auto lower = juce::jlimit (0, source.getNumSamples() - 1,
                                                 static_cast<int> (sourcePosition));
                const auto upper = std::min (lower + 1, source.getNumSamples() - 1);
                const auto fraction = static_cast<float> (sourcePosition - std::floor (sourcePosition));
                output[sample] = input[lower] + fraction * (input[upper] - input[lower]);
            }
        }
        playback->regions.push_back (std::move (loaded));
        loadedAny = true;
    }
    publishPlayback (std::move (playback));
    if (missing && loadedAny)
        setStatus ("Some selected assets are missing; available regions loaded");
    else if (missing)
        setStatus ("Selected assets are missing; audio is dry");
    else if (loadedAny)
        setStatus ("Selected takes loaded");
    else
        setStatus ("No selected takes; audio is dry");
}

void ReImagineProcessor::run()
{
    while (! threadShouldExit())
    {
        workerEvent.wait (250);
        if (const auto aborted = captureAbortEvent.exchange (0, std::memory_order_acq_rel); aborted != 0)
        {
            juce::String reason = "Transfer aborted";
            switch (static_cast<CaptureEvent> (aborted))
            {
                case CaptureEvent::abortedMissingTiming: reason << ": host timing unavailable"; break;
                case CaptureEvent::abortedDiscontinuity: reason << ": seek/discontinuity detected"; break;
                case CaptureEvent::abortedLoopWrap: reason << ": loop wrap detected"; break;
                case CaptureEvent::abortedLayoutChange: reason << ": channel layout changed"; break;
                case CaptureEvent::abortedTempoMapCapacity: reason << ": tempo map is too dense"; break;
                case CaptureEvent::none:
                case CaptureEvent::started:
                case CaptureEvent::continued:
                case CaptureEvent::completed:
                case CaptureEvent::reachedCaptureCap: break;
            }
            setStatus (reason);
        }
        if (const auto* playback = audibleSnapshot.load (std::memory_order_acquire); playback != nullptr)
        {
            const juce::ScopedLock lock (stateLock);
            bool reported = false;
            for (const auto& playbackRegion : playback->regions)
            {
                int expected = 2;
                if (playbackRegion->stale.compare_exchange_strong (expected, 1, std::memory_order_acq_rel))
                {
                    for (auto& stateRegion : pluginState.regions)
                        if (stateRegion.id == playbackRegion->id)
                                stateRegion.status = RegionStatus::staleTempo;
                    reported = true;
                }
            }
            if (reported)
                uiStatus = "Tempo map changed - region is stale; Re-transfer required";
        }
        if (finalizeRequested.exchange (0, std::memory_order_acq_rel) != 0)
        {
            finalizeCapture();
            finalizationPending.store (0, std::memory_order_release);
        }
        if (loadRequested.exchange (0, std::memory_order_acq_rel) != 0)
            loadSelectedTake();
        if (loraCatalogRequested.exchange (0, std::memory_order_acq_rel) != 0)
        {
            juce::String error;
            juce::var response;
            if (service.ensureRunning (error))
                response = service.loras();
            const auto items = loraCatalogFromResponse (response);
            const auto ok = static_cast<bool> (response.getProperty ("ok", false));
            const juce::ScopedLock lock (stateLock);
            loraCatalog.items = items;
            loraCatalog.status = ok ? LoraCatalogStatus::ready : LoraCatalogStatus::error;
            loraCatalog.error = ok ? juce::String()
                                   : response.getProperty ("error", error).toString();
            if (loraCatalog.error.isEmpty() && ! ok)
                loraCatalog.error = "Could not load LoRA library";
            ++loraCatalog.revision;
        }
        if (renderRequested.exchange (0, std::memory_order_acq_rel) != 0)
        {
            std::optional<RenderRequest> request;
            {
                const juce::ScopedLock lock (stateLock);
                request = renderCoordinator.activeRequest();
            }
            if (request)
                performRender (*request);
        }
    }
}

juce::AudioProcessorEditor* ReImagineProcessor::createEditor()
{
    return new ReImagineEditor (*this);
}
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new mosh::reimagine::ReImagineProcessor();
}
