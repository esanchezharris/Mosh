#include "ReImagineProcessor.h"
#include "ReImagineEditor.h"
#include "../ReImagineConform.h"

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
    cancelledThroughBatch.store (std::numeric_limits<uint64_t>::max(), std::memory_order_release);
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
    // seq_cst on the reader count and the pointer, here and in publishPlayback: with
    // acquire/release alone the reader's load may see the OLD pointer while the
    // publisher's load still sees zero readers (store->load reordering), and the old
    // snapshot is freed under the audio thread. Two seq_cst pairs cannot both miss.
    snapshotReaders.fetch_add (1, std::memory_order_seq_cst);
    const auto* snapshot = audibleSnapshot.load (std::memory_order_seq_cst);
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

void ReImagineProcessor::renderFreeAudition (juce::AudioBuffer<float>& buffer, bool hostSyncedActive) noexcept
{
    if (! audition.playing())
        return;
    snapshotReaders.fetch_add (1, std::memory_order_seq_cst);   // see renderSelected
    const auto* snapshot = audibleSnapshot.load (std::memory_order_seq_cst);
    const PlaybackRegion* region = nullptr;
    if (snapshot != nullptr && juce::isPositiveAndBelow (snapshot->selectedIndex, static_cast<int> (snapshot->regions.size())))
        region = snapshot->regions[static_cast<size_t> (snapshot->selectedIndex)].get();
    const auto length = region != nullptr ? static_cast<int64_t> (region->audio.getNumSamples()) : int64_t { 0 };
    const auto block = audition.advance (buffer.getNumSamples(), length, hostSyncedActive);
    // Replace, never add: the preview substitutes for the input like the host-synced route.
    if (block.count > 0 && region != nullptr && compareDry.load (std::memory_order_acquire) == 0)
        for (int channel = 0; channel < buffer.getNumChannels(); ++channel)
        {
            const auto sourceChannel = std::min (channel, region->audio.getNumChannels() - 1);
            juce::FloatVectorOperations::copy (buffer.getWritePointer (channel),
                                               region->audio.getReadPointer (sourceChannel, static_cast<int> (block.start)),
                                               block.count);
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
    if (position && position->timeSignatureNumerator > 0.0)
        lastMeterNumerator.store (static_cast<int> (position->timeSignatureNumerator), std::memory_order_relaxed);
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
    const auto hostSynced = offline || (position && shouldRenderSelected (*position, offline));
    if (position && shouldRenderSelected (*position, offline))
        renderSelected (buffer, *position);
    // After the host-synced route: the free preview stops itself whenever that route is
    // active, so the selected version is never audible twice.
    renderFreeAudition (buffer, hostSynced);
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
        const auto& take = region->takes[static_cast<size_t> (index)];
        region->selectedTakeId = take.id;
        loadRequested.store (1, std::memory_order_release);
        workerEvent.signal();
        auto* payload = new juce::DynamicObject();
        payload->setProperty ("regionId", region->id);
        payload->setProperty ("takeId", take.id);
        payload->setProperty ("intentionId", lineageOf (take).intentionId);
        logEvent ("version.auditioned", "implicit", juce::var (payload));
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

void ReImagineProcessor::importTakeFromFile (const juce::File& wav, double bar)
{
    if (! wav.existsAsFile())
        return setStatus ("Import: file does not exist");
    if (! std::isfinite (bar) || bar < 1.0)
        return setStatus ("Import: bar must be 1 or later");

    juce::AudioFormatManager formats;
    formats.registerBasicFormats();
    const auto reader = std::unique_ptr<juce::AudioFormatReader> (formats.createReaderFor (wav));
    if (! reader || reader->lengthInSamples <= 0)
        return setStatus ("Import: could not read the WAV");

    const auto hostRate = currentSampleRate.load (std::memory_order_acquire);
    if (std::abs (reader->sampleRate - hostRate) > 0.5)
        return setStatus ("Import: WAV is " + juce::String (reader->sampleRate, 0) + " Hz but the host runs at "
                          + juce::String (hostRate, 0) + " Hz - export it at the host rate (no resampling)");

    double bpm = 120.0, signature = 4.0;
    bool assumedTempo = true;
    if (const auto host = hostPosition(); host.has_value() && std::isfinite (host->bpm) && host->bpm > 0.0)
    {
        bpm = host->bpm;
        signature = host->timeSignatureNumerator > 0.0 ? host->timeSignatureNumerator : 4.0;
        assumedTempo = false;
    }

    // One content hash, stored as BOTH the region's source and its selected take: the
    // region's own source check (selectedAssetsAvailable) then passes, and "New Take" can
    // re-imagine the import exactly like a transferred region.
    juce::String error;
    const auto hash = assets.importWav (wav, true, error);
    if (hash.isEmpty())
        return setStatus ("Import: " + error);
    if (assets.importWav (wav, false, error).isEmpty())
        return setStatus ("Import: " + error);

    auto region = regionForImportedTake (hash, reader->lengthInSamples, reader->sampleRate,
                                         ppqForBar (bar, signature), bpm);
    if (! region.has_value())
        return setStatus ("Import: could not place the take");
    if (assumedTempo)
    {
        SessionContext assumed;
        assumed.tempoAssumed = true;   // 120 BPM was assumed, not reported by the host
        region->context = contextToVar (assumed);
    }
    auto take = importedTake (hash, juce::Time::getCurrentTime().toISO8601 (true), wav.getFileName());
    region->takes.push_back (take);
    region->selectedTakeId = take.id;

    const juce::ScopedLock lock (stateLock);
    regionCollection = {};
    for (const auto& existing : pluginState.regions)
        regionCollection.offer (existing);
    const auto offer = regionCollection.offer (*region);
    if (offer == RegionOffer::invalid)
    {
        uiStatus = "Import: region is invalid";
        return;
    }
    if (offer == RegionOffer::needsOverlapDecision)
    {
        uiStatus = "Overlap detected - choose Replace or Discard";
        return;
    }
    pluginState.regions = regionCollection.regions();
    pluginState.selectedRegionId = region->id;
    uiStatus = "Imported " + wav.getFileName() + " at bar " + juce::String (bar, 2)
             + (assumedTempo ? " (host tempo unknown - assumed 120 BPM 4/4; play once and re-import if wrong)"
                             : " at " + juce::String (bpm, 1) + " BPM");
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
    // Unique per request (see performBatch): two instances must never share a path.
    auto output = work.getChildFile ("render-" + juce::Uuid().toDashedString() + ".wav");
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
    // A new snapshot means the selection or its audio changed; a running preview stops
    // rather than continuing on other audio. (A preview being armed starts afterwards.)
    audition.stop (AuditionStop::selectionChanged);
    {
        const juce::ScopedLock lock (stateLock);
        for (auto& playbackRegion : snapshot->regions)
            for (const auto& stateRegion : pluginState.regions)
                if (stateRegion.id == playbackRegion->id && stateRegion.status == RegionStatus::staleTempo)
                    playbackRegion->stale.store (1, std::memory_order_relaxed);
    }
    const auto* raw = snapshot.get();
    audibleSnapshot.store (raw, std::memory_order_seq_cst);
    while (snapshotReaders.load (std::memory_order_seq_cst) != 0)
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
        if (region.id == state.selectedRegionId)
            playback->selectedIndex = static_cast<int> (playback->regions.size());
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
        if (auditionArmRequested.exchange (0, std::memory_order_acq_rel) != 0)
        {
            bool loaded = false;
            if (const auto* playback = audibleSnapshot.load (std::memory_order_acquire); playback != nullptr)
                loaded = playback->selectedIndex >= 0;   // the worker owns the snapshot; no reader guard needed
            const auto hostSynced = lastHostPlaying.load (std::memory_order_acquire) != 0
                                 || offlineProcessing.load (std::memory_order_acquire) != 0;
            const auto started = audition.start (loaded, hostSynced);
            if (started == FreeAudition::StartResult::started)
            {
                setStatus ("Free audition playing - local preview, not synced to the host timeline");
                logEvent ("version.auditioned", "implicit", juce::JSON::parse ("{\"mode\": \"free-running\"}"));
            }
            else
                setStatus (started == FreeAudition::StartResult::hostSyncedActive
                               ? "Free audition refused: the host is playing the region in sync"
                               : "Free audition refused: the selected version is not loaded");
        }
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
        if (batchRequested.exchange (0, std::memory_order_acq_rel) != 0)
        {
            std::optional<GenerationBatch> batch;
            {
                const juce::ScopedLock lock (stateLock);
                batch.swap (pendingBatch);
                if (batch)
                    batchActive.store (1, std::memory_order_release);   // no second batch can queue in between
            }
            if (batch)
                performBatch (*batch);
        }
        if (conformRequested.exchange (0, std::memory_order_acq_rel) != 0)
        {
            std::optional<ConformJob> job;
            {
                const juce::ScopedLock lock (stateLock);
                job.swap (pendingConform);
                if (job)
                    conformRunning.store (1, std::memory_order_release);
            }
            if (job)
            {
                performConform (*job);
                conformRunning.store (0, std::memory_order_release);
            }
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

// ── M1 contextual generation loop ─────────────────────────────────────────────────

void ReImagineProcessor::storeRack (RackSettings rack)
{
    const juce::ScopedLock lock (stateLock);
    pluginState.rack = std::move (rack);
}

void ReImagineProcessor::logEvent (const juce::String& event, const juce::String& signal,
                                   const juce::var& payload) const
{
    experience.append (event, signal, instanceId, payload);
}

SessionContext ReImagineProcessor::contextForUnsafe (const TransferRegion& region) const
{
    RegionFacts facts;
    facts.regionId = region.id;
    facts.sourceHash = region.sourceHash;
    facts.ppqStart = region.ppqStart;
    facts.ppqEnd = region.ppqEnd;
    facts.tempoMap = region.tempoMap;
    if (const auto meter = lastMeterNumerator.load (std::memory_order_relaxed); meter > 0)
        facts.hostMeterNumerator = meter;
    return mergeHostFacts (contextFromVar (region.context), facts);
}

SessionContext ReImagineProcessor::selectedContext() const
{
    const juce::ScopedLock lock (stateLock);
    if (const auto* region = selectedRegionUnsafe())
        return contextForUnsafe (*region);
    return {};
}

juce::StringArray ReImagineProcessor::setSelectedContext (const juce::String& key, const juce::String& chords,
                                                          const juce::String& section,
                                                          const juce::String& protectedChoices)
{
    const juce::ScopedLock lock (stateLock);
    auto* region = selectedRegionUnsafe();
    if (region == nullptr)
        return { "Transfer or Import a region first" };
    auto stored = contextFromVar (region->context);
    const auto merged = contextForUnsafe (*region);
    const auto regionBars = merged.meterNumerator && *merged.meterNumerator > 0
        ? (region->ppqEnd - region->ppqStart) / *merged.meterNumerator : 0.0;
    auto parsed = parseChordList (chords, regionBars);
    if (! parsed.errors.isEmpty())
        return parsed.errors;
    stored.key = key.trim();
    stored.keyFrom = stored.key.isNotEmpty() ? Provenance::user : Provenance::unknown;
    stored.chords = std::move (parsed.chords);
    stored.chordsFrom = stored.chords.empty() ? Provenance::unknown : Provenance::user;
    stored.sectionLabel = section.trim();
    stored.protectedChoices = juce::StringArray::fromTokens (protectedChoices, ",;", {});
    stored.protectedChoices.trim();
    stored.protectedChoices.removeEmptyStrings();
    region->context = contextToVar (stored);
    uiStatus = "Context saved for this region (user values override host values)";
    auto* payload = new juce::DynamicObject();
    payload->setProperty ("regionId", region->id);
    payload->setProperty ("context", region->context);
    logEvent ("context.edited", "explicit", juce::var (payload));
    return {};
}

int ReImagineProcessor::intentionIndexUnsafe (const juce::String& id) const
{
    if (id.isEmpty())
        return -1;
    for (int i = 0; i < pluginState.intentions.size(); ++i)
        if (pluginState.intentions.getReference (i).getProperty ("id", {}).toString() == id)
            return i;
    return -1;
}

void ReImagineProcessor::storeIntentionUnsafe (const IntentionRecord& record)
{
    const int index = intentionIndexUnsafe (record.id);
    if (index >= 0)
        pluginState.intentions.set (index, intentionToVar (record));
    else
        pluginState.intentions.add (intentionToVar (record));
}

juce::StringArray ReImagineProcessor::generateCandidates (IntentionInput input)
{
    return enqueueBatch (std::move (input), false, false);
}

juce::StringArray ReImagineProcessor::reviseSelected (IntentionInput input, bool fromSelectedAudio)
{
    return enqueueBatch (std::move (input), true, fromSelectedAudio);
}

juce::StringArray ReImagineProcessor::enqueueBatch (IntentionInput input, bool revision, bool fromSelectedAudio)
{
    auto refuse = [this] (juce::StringArray errors)
    {
        setStatus (errors.joinIntoString ("; "));
        return errors;
    };

    TransferRegion region;
    IntentionRecord intention;
    juce::String parentTakeId, inputHash, inputRole = "source";
    SessionContext context;
    {
        const juce::ScopedLock lock (stateLock);
        if (offlineProcessing.load (std::memory_order_acquire) != 0)
            return refuse ({ "Offline export never launches inference" });
        if (regionCollection.pendingOverlap())
            return refuse ({ "Choose Replace or Discard for the overlapping Transfer first" });
        if (pendingBatch || batchActive.load (std::memory_order_acquire) != 0)
            return refuse ({ "A generation is already running - Cancel it first" });
        if (pendingConform || conformRunning.load (std::memory_order_acquire) != 0)
            return refuse ({ "A conform is running - wait for it to finish" });
        const auto* selected = selectedRegionUnsafe();
        if (selected == nullptr)
            return refuse ({ "Transfer or Import a region first" });
        if (selected->status == RegionStatus::staleTempo)
            return refuse ({ "Region is stale after a tempo change - Re-transfer before generating" });
        region = *selected;
        context = contextForUnsafe (region);
        inputHash = region.sourceHash;
        if (revision)
        {
            const auto take = std::find_if (region.takes.begin(), region.takes.end(), [&] (const auto& t)
            {
                return t.id == region.selectedTakeId;
            });
            if (take == region.takes.end())
                return refuse ({ "Select the version to revise first" });
            parentTakeId = take->id;
            if (fromSelectedAudio)
            {
                inputHash = take->assetHash;
                inputRole = "parent-take";
            }
            const auto lineage = lineageOf (*take);
            const int index = intentionIndexUnsafe (lineage.intentionId);
            if (index >= 0)
                intention = intentionFromVar (pluginState.intentions[index]);
            if (input.request.trim().isEmpty())
                input.request = intention.request;
        }
        if (intention.id.isEmpty())
        {
            intention.id = juce::Uuid().toString();
            intention.regionId = region.id;
            intention.request = input.request.trim();
            intention.createdIso8601 = juce::Time::getCurrentTime().toISO8601 (true);
        }
        else
            input.request = intention.request;
    }

    // Header-only read of the audio that will be sent (message thread; no decode).
    const auto inputFile = inputRole == "source" ? assets.sourceFile (inputHash) : assets.renderFile (inputHash);
    juce::AudioFormatManager formats;
    formats.registerBasicFormats();
    const auto reader = std::unique_ptr<juce::AudioFormatReader> (formats.createReaderFor (inputFile));
    if (! reader || reader->lengthInSamples <= 0)
        return refuse ({ "Input audio is missing - Relink or Re-transfer" });

    SessionSnapshot snapshot;
    snapshot.id = juce::Uuid().toString();
    snapshot.instanceId = instanceId;
    snapshot.regionId = region.id;
    snapshot.sourceHash = region.sourceHash;
    snapshot.inputHash = inputHash;
    snapshot.inputRole = inputRole;
    snapshot.sampleRate = reader->sampleRate;
    snapshot.channels = static_cast<int> (reader->numChannels);
    snapshot.frames = reader->lengthInSamples;
    snapshot.ppqStart = region.ppqStart;
    snapshot.ppqEnd = region.ppqEnd;
    snapshot.constantTempo = isConstantTempo (region.tempoMap);
    snapshot.context = context;
    snapshot.createdIso8601 = juce::Time::getCurrentTime().toISO8601 (true);

    auto compiled = compileIntention (input, snapshot, intention.id, parentTakeId,
                                      intention.attempts, intention.maxAttempts);
    if (! compiled.request)
        return refuse (compiled.errors);

    GenerationBatch batch;
    batch.id = nextBatchId.fetch_add (1, std::memory_order_acq_rel);
    batch.regionId = region.id;
    batch.sourceHash = region.sourceHash;
    batch.request = *compiled.request;
    batch.snapshot = snapshot;
    batch.adapter = juce::SystemStats::getEnvironmentVariable ("MOSH_REIMAGINE_ADAPTER", "stable_audio3");
    {
        const juce::ScopedLock lock (stateLock);
        const auto* current = selectedRegionUnsafe();
        if (current == nullptr || current->id != region.id || current->sourceHash != region.sourceHash)
        {
            uiStatus = "Selection changed while preparing - nothing queued";
            return { uiStatus };
        }
        if (pendingBatch || batchActive.load (std::memory_order_acquire) != 0)
        {
            uiStatus = "A generation is already running - Cancel it first";
            return { uiStatus };
        }
        if (revision)
            intention.revisions.add (input.revision.trim());
        if (intention.snapshot.isVoid())
            intention.snapshot = snapshotToVar (snapshot);
        storeIntentionUnsafe (intention);
        pendingBatch = batch;
        uiStatus = "Generating " + juce::String (static_cast<int> (batch.request.seeds.size()))
                 + (revision ? " revision(s)" : " candidate(s)") + " - attempts "
                 + juce::String (intention.attempts) + "/" + juce::String (intention.maxAttempts) + " used so far";
    }
    auto* payload = new juce::DynamicObject();
    payload->setProperty ("intentionId", intention.id);
    payload->setProperty ("request", input.request);
    payload->setProperty ("revision", input.revision);
    payload->setProperty ("parentTakeId", parentTakeId);
    payload->setProperty ("snapshot", snapshotToVar (snapshot));
    payload->setProperty ("compiled", compiledRequestToVar (*compiled.request));
    payload->setProperty ("warnings", juce::var (compiled.warnings));
    payload->setProperty ("adapter", batch.adapter);
    logEvent (revision ? "revision.requested" : "intention.compiled", "explicit", juce::var (payload));
    batchRequested.store (1, std::memory_order_release);
    workerEvent.signal();
    return compiled.warnings;
}

void ReImagineProcessor::cancelGeneration()
{
    juce::String job;
    {
        const juce::ScopedLock lock (stateLock);
        const auto queued = pendingBatch.has_value();
        pendingBatch.reset();
        if (! queued && batchActive.load (std::memory_order_acquire) == 0)
            return;
        job = currentJobId;
        uiStatus = "Cancelling - a running render may finish in the helper; its result is discarded";
    }
    cancelledThroughBatch.store (nextBatchId.load (std::memory_order_acquire) - 1, std::memory_order_release);
    juce::ignoreUnused (job);   // the worker owns the job and cancels it on its next poll
    workerEvent.signal();
    logEvent ("generation.cancel-requested", "explicit", {});
}

void ReImagineProcessor::performBatch (const GenerationBatch& batch)
{
    struct ActiveScope
    {
        std::atomic<int>& flag;
        explicit ActiveScope (std::atomic<int>& f) : flag (f) { flag.store (1, std::memory_order_release); }
        ~ActiveScope() { flag.store (0, std::memory_order_release); }
    } active (batchActive);

    if (batchCancelled (batch.id))
        return setStatus ("Generation cancelled before it started");

    auto logAttempt = [this, &batch] (size_t index, const juce::String& outcome, const juce::String& detail,
                                      double seconds, const juce::var& extra)
    {
        auto* payload = new juce::DynamicObject();
        payload->setProperty ("intentionId", batch.request.intentionId);
        payload->setProperty ("snapshotId", batch.snapshot.id);
        payload->setProperty ("candidateIndex", static_cast<int> (index));
        payload->setProperty ("seed", static_cast<juce::int64> (batch.request.seeds[index]));
        payload->setProperty ("outcome", outcome);
        payload->setProperty ("detail", detail);
        payload->setProperty ("generationSeconds", seconds);
        payload->setProperty ("adapter", batch.adapter);
        payload->setProperty ("costUsd", 0.0);   // local model; no paid calls
        payload->setProperty ("extra", extra);
        logEvent ("generation.attempt", "system", juce::var (payload));
    };
    auto bumpIntention = [this, &batch] (bool attempt, bool failure) -> IntentionRecord
    {
        const juce::ScopedLock lock (stateLock);
        const int index = intentionIndexUnsafe (batch.request.intentionId);
        auto record = index >= 0 ? intentionFromVar (pluginState.intentions[index]) : IntentionRecord {};
        if (index < 0)
            return record;
        if (attempt)
            ++record.attempts;
        if (failure)
            ++record.failures;
        storeIntentionUnsafe (record);
        return record;
    };

    juce::String error;
    if (! service.ensureRunning (error))
    {
        auto* payload = new juce::DynamicObject();
        payload->setProperty ("intentionId", batch.request.intentionId);
        payload->setProperty ("error", error);
        logEvent ("generation.unavailable", "system", juce::var (payload));
        return setStatus ("Local helper unavailable - " + error + " (no attempts spent, no remote fallback)");
    }
    const auto input = batch.snapshot.inputRole == "source" ? assets.sourceFile (batch.snapshot.inputHash)
                                                             : assets.renderFile (batch.snapshot.inputHash);
    if (! assets.verify (input, batch.snapshot.inputHash))
        return setStatus ("Input audio missing or changed - Relink or Re-transfer (nothing generated)");

    auto work = assets.root().getSiblingFile ("work");
    work.createDirectory();
    juce::AudioFormatManager formats;
    formats.registerBasicFormats();
    const auto expectedSeconds = static_cast<double> (batch.snapshot.frames) / batch.snapshot.sampleRate;
    const auto count = batch.request.seeds.size();
    juce::StringArray produced;
    int failed = 0;
    bool cancelled = false;

    for (size_t index = 0; index < count && ! threadShouldExit(); ++index)
    {
        if (batchCancelled (batch.id))
        {
            cancelled = true;
            break;
        }
        // Unique per request: the helper creates these files later, so a "nonexistent"
        // name check alone would hand two plug-in instances the same path.
        const auto artifact = "m1-" + juce::Uuid().toDashedString();
        const auto output = work.getChildFile (artifact + ".wav");
        const auto manifest = work.getChildFile (artifact + ".manifest.json");
        const auto requestId = batch.request.intentionId + ":" + juce::String (static_cast<juce::int64> (batch.id))
                             + ":" + juce::String (static_cast<int> (index));
        const auto params = directServiceParams (batch.request, index, batch.snapshot.inputHash, requestId);
        if (auto problems = validateRequest (batch.request); ! problems.isEmpty())
        {
            setStatus ("Request refused: " + problems.joinIntoString ("; "));
            break;
        }
        bumpIntention (true, false);
        const auto started = juce::Time::getMillisecondCounterHiRes();
        const auto jobId = service.submitDirect (input, output, manifest, batch.adapter, params, error);
        if (jobId.isEmpty())
        {
            ++failed;
            bumpIntention (false, true);
            logAttempt (index, "submit-refused", error, 0.0, {});
            break;   // a refused contract fails identically for every seed
        }
        {
            const juce::ScopedLock lock (stateLock);
            currentJobId = jobId;
        }
        juce::String state;
        juce::var finalStatus;
        int unanswered = 0;
        const auto deadline = started + 20.0 * 60.0 * 1000.0;
        while (! threadShouldExit())
        {
            if (batchCancelled (batch.id))
            {
                service.cancel (jobId);
                cancelled = true;
                break;
            }
            finalStatus = service.status (jobId);
            state = finalStatus.getProperty ("status", {}).toString();
            if (state.isEmpty())
            {
                if (++unanswered > 50)
                {
                    state = "error";
                    error = "helper stopped responding";
                    break;
                }
            }
            else
                unanswered = 0;
            const auto p = static_cast<float> (static_cast<double> (finalStatus.getProperty ("progress", 0.0)));
            renderProgress.store ((static_cast<float> (index) + juce::jlimit (0.0f, 1.0f, p)) / static_cast<float> (count),
                                  std::memory_order_release);
            if (state == "ready" || state == "error" || state == "cancelled")
                break;
            if (juce::Time::getMillisecondCounterHiRes() > deadline)
            {
                service.cancel (jobId);
                state = "error";
                error = "timed out after 20 minutes";
                break;
            }
            wait (200);
        }
        {
            const juce::ScopedLock lock (stateLock);
            if (currentJobId == jobId)
                currentJobId.clear();
        }
        const auto seconds = (juce::Time::getMillisecondCounterHiRes() - started) / 1000.0;
        if (cancelled || threadShouldExit())
        {
            logAttempt (index, "cancelled", "result (if any) will be discarded", seconds, {});
            break;
        }
        if (state != "ready")
        {
            ++failed;
            bumpIntention (false, true);
            const auto detail = state == "error" && error.isEmpty() ? finalStatus.getProperty ("error", state).toString()
                                                                    : (error.isNotEmpty() ? error : state);
            logAttempt (index, "failed", detail, seconds, {});
            output.deleteFile();
            manifest.deleteFile();
            error.clear();
            continue;
        }

        // Technical checks on what actually came back (not a taste judgement).
        auto reader = std::unique_ptr<juce::AudioFormatReader> (formats.createReaderFor (output));
        AudioStats stats;
        TempoConformanceReport tempo;
        if (reader && reader->lengthInSamples > 0 && reader->lengthInSamples <= std::numeric_limits<int>::max())
        {
            juce::AudioBuffer<float> audio (static_cast<int> (reader->numChannels), static_cast<int> (reader->lengthInSamples));
            reader->read (&audio, 0, audio.getNumSamples(), 0, true, true);
            stats = measureAudio (audio.getArrayOfReadPointers(), audio.getNumChannels(), audio.getNumSamples(),
                                  reader->sampleRate);
            // Reported beside the checks, never folded into them: a drifting take stays usable.
            tempo = checkTempoConformance (audio.getArrayOfReadPointers(), audio.getNumChannels(), audio.getNumSamples(),
                                           reader->sampleRate, batch.snapshot.context);
        }
        reader.reset();
        const auto report = checkCandidate (stats, expectedSeconds, batch.snapshot.channels);
        if (! report.usable)
        {
            ++failed;
            bumpIntention (false, true);
            logAttempt (index, "rejected-technical", report.failures.joinIntoString ("; "), seconds,
                        technicalReportToVar (report));
            output.deleteFile();
            manifest.deleteFile();
            continue;
        }
        const auto hash = assets.importWav (output, false, error);
        output.deleteFile();
        manifest.deleteFile();
        if (hash.isEmpty())
        {
            ++failed;
            bumpIntention (false, true);
            logAttempt (index, "store-failed", error, seconds, {});
            continue;
        }

        const auto returned = finalStatus.getProperty ("manifest", {});
        RenderTake take;
        take.id = juce::Uuid().toString();
        take.assetHash = hash;
        take.timestampIso8601 = juce::Time::getCurrentTime().toISO8601 (true);
        take.seed = batch.request.seeds[index];
        take.parameters.prompt = batch.request.prompt;
        take.parameters.reimagine = batch.request.strength;
        take.parameters.colors = batch.request.colors;
        take.parameters.loras = batch.request.loras;
        take.parameters.seed = take.seed;
        take.manifest = returned.isObject() ? returned.clone() : juce::var (new juce::DynamicObject());
        const auto fixture = static_cast<bool> (take.manifest.getProperty ("test_fixture", false))
                          || take.manifest.getProperty ("backend", {}).toString() == "fixture";
        setLineage (take, { batch.request.intentionId, batch.request.parentTakeId,
                            batch.request.parentTakeId.isEmpty() ? "candidate" : "revision", false, fixture,
                            {}, std::nullopt });
        if (auto* m1 = take.manifest.getProperty ("m1", {}).getDynamicObject())
        {
            m1->setProperty ("snapshotId", batch.snapshot.id);
            m1->setProperty ("requestId", requestId);
            m1->setProperty ("candidateIndex", static_cast<int> (index));
            m1->setProperty ("inputRole", batch.snapshot.inputRole);
            m1->setProperty ("inputHash", batch.snapshot.inputHash);
            m1->setProperty ("adapter", batch.adapter);
            m1->setProperty ("generationSeconds", seconds);
            m1->setProperty ("checks", technicalReportToVar (report));
            m1->setProperty ("tempoConformance", tempoConformanceToVar (tempo));
            m1->setProperty ("request", compiledRequestToVar (batch.request));
        }

        bool published = false;
        juce::String label;
        {
            const juce::ScopedLock lock (stateLock);
            const auto target = std::find_if (pluginState.regions.begin(), pluginState.regions.end(),
                                              [&] (const auto& candidate) { return candidate.id == batch.regionId; });
            if (! batchCancelled (batch.id) && target != pluginState.regions.end()
                && target->sourceHash == batch.sourceHash)
            {
                const bool anyKept = std::any_of (target->takes.begin(), target->takes.end(),
                                                  [] (const auto& t) { return lineageOf (t).kept; });
                target->takes.push_back (take);
                label = takeLabel (*target, target->takes.size() - 1);
                if (produced.isEmpty() && ! anyKept)
                {
                    target->selectedTakeId = take.id;
                    loadRequested.store (1, std::memory_order_release);
                }
                target->status = RegionStatus::ready;
                published = true;
            }
        }
        if (! published)
        {
            logAttempt (index, "late-result-discarded", "cancelled or region changed during generation", seconds, {});
            cancelled = cancelled || batchCancelled (batch.id);
            break;
        }
        produced.add (label);
        auto* payload = new juce::DynamicObject();
        payload->setProperty ("intentionId", batch.request.intentionId);
        payload->setProperty ("takeId", take.id);
        payload->setProperty ("parentTakeId", batch.request.parentTakeId);
        payload->setProperty ("assetSha256", hash);
        payload->setProperty ("rawAssetSha256", hash);   // no conforming in M1: raw == stored
        payload->setProperty ("checks", technicalReportToVar (report));
        payload->setProperty ("tempoConformance", tempoConformanceToVar (tempo));
        payload->setProperty ("testFixture", fixture);
        const juce::var presented (payload);   // one owner: the object is ref-counted
        logAttempt (index, "ok", label, seconds, presented);
        logEvent ("version.presented", "implicit", presented);
    }

    renderProgress.store (0.0f, std::memory_order_release);
    IntentionRecord record;
    {
        const juce::ScopedLock lock (stateLock);
        const int index = intentionIndexUnsafe (batch.request.intentionId);
        if (index >= 0)
            record = intentionFromVar (pluginState.intentions[index]);
    }
    juce::String summary;
    if (cancelled)
        summary = "Cancelled";
    else if (produced.isEmpty())
        summary = "No usable candidates";
    else
        summary = juce::String (produced.size()) + " ready: " + produced.joinIntoString (", ");
    if (failed > 0)
        summary << " (" << failed << " failed" << (error.isNotEmpty() ? ": " + error : juce::String()) << ")";
    summary << " - budget " << record.attempts << "/" << record.maxAttempts << " attempts used";
    setStatus (summary);
    workerEvent.signal();
}

void ReImagineProcessor::keepSelected()
{
    const juce::ScopedLock lock (stateLock);
    auto* region = selectedRegionUnsafe();
    if (region == nullptr)
        return;
    for (size_t i = 0; i < region->takes.size(); ++i)
        if (region->takes[i].id == region->selectedTakeId)
        {
            auto lineage = lineageOf (region->takes[i]);
            lineage.kept = true;
            setLineage (region->takes[i], lineage);
            uiStatus = takeLabel (*region, i) + " - kept in Mosh (not written to the DAW timeline; Export or drag to place it)";
            auto* payload = new juce::DynamicObject();
            payload->setProperty ("regionId", region->id);
            payload->setProperty ("takeId", region->takes[i].id);
            payload->setProperty ("intentionId", lineage.intentionId);
            payload->setProperty ("assetSha256", region->takes[i].assetHash);
            logEvent ("version.kept", "explicit", juce::var (payload));
            return;
        }
    uiStatus = "Select a version to keep";
}

juce::File ReImagineProcessor::exportSelected (juce::String& error)
{
    TransferRegion region;
    RenderTake take;
    SessionContext context;
    {
        const juce::ScopedLock lock (stateLock);
        const auto* selected = selectedRegionUnsafe();
        if (selected == nullptr)
        {
            error = "Nothing to export";
            return {};
        }
        const auto found = std::find_if (selected->takes.begin(), selected->takes.end(),
                                         [&] (const auto& t) { return t.id == selected->selectedTakeId; });
        if (found == selected->takes.end())
        {
            error = "Select a version to export";
            return {};
        }
        region = *selected;
        take = *found;
        context = contextForUnsafe (region);
    }
    const auto asset = assets.renderFile (take.assetHash);
    if (! assets.verify (asset, take.assetHash))
    {
        error = "Version audio is missing or changed - Relink it first";
        return {};
    }
    juce::AudioFormatManager formats;
    formats.registerBasicFormats();
    const auto reader = std::unique_ptr<juce::AudioFormatReader> (formats.createReaderFor (asset));
    if (! reader)
    {
        error = "Version audio does not decode";
        return {};
    }
    const auto meter = context.meterNumerator;
    const auto directory = reimagineMusicDirectory().getChildFile ("Mosh Exports");
    if (! directory.createDirectory())
    {
        error = "Could not create " + directory.getFullPathName();
        return {};
    }
    const auto target = directory.getChildFile (exportFileName (region, take, context, meter));
    if (! assets.verify (target, take.assetHash))
    {
        if ((target.existsAsFile() && ! target.deleteFile()) || ! asset.copyFileTo (target)
            || ! assets.verify (target, take.assetHash))
        {
            error = "Could not write " + target.getFullPathName();
            return {};
        }
    }
    const auto sidecar = exportSidecar (region, take, context, reader->sampleRate, reader->lengthInSamples, meter);
    target.withFileExtension ("json").replaceWithText (juce::JSON::toString (sidecar));
    setStatus ("Exported " + target.getFileName() + " (" + juce::String (reader->sampleRate, 0) + " Hz) to Mosh Exports");
    auto* payload = new juce::DynamicObject();
    payload->setProperty ("regionId", region.id);
    payload->setProperty ("takeId", take.id);
    payload->setProperty ("assetSha256", take.assetHash);
    payload->setProperty ("file", target.getFullPathName());
    payload->setProperty ("hostPlacement", "unobserved");
    logEvent ("version.exported", "implicit", juce::var (payload));
    return target;
}

juce::String ReImagineProcessor::selectedReport() const
{
    const juce::ScopedLock lock (stateLock);
    const auto* region = selectedRegionUnsafe();
    if (region == nullptr)
        return "No region. Transfer (capture while Live plays) or Import a WAV at a bar.";
    juce::StringArray lines;
    const auto context = contextForUnsafe (*region);
    lines.add ("Tempo: " + (context.bpm ? juce::String (*context.bpm, 2) + " BPM (" + provenanceName (context.bpmFrom) + ")"
                                        : juce::String ("unknown - host alignment not verified"))
               + "   Meter: " + (context.meterNumerator ? juce::String (*context.meterNumerator) + " beats ("
                                                             + provenanceName (context.meterFrom) + ")"
                                                       : juce::String ("unknown")));
    const auto found = std::find_if (region->takes.begin(), region->takes.end(),
                                     [&] (const auto& t) { return t.id == region->selectedTakeId; });
    if (found == region->takes.end())
    {
        lines.add ("Audible: original source (no version selected)");
        return lines.joinIntoString ("\n");
    }
    const auto index = static_cast<size_t> (std::distance (region->takes.begin(), found));
    const auto lineage = lineageOf (*found);
    lines.add ("Audible: " + takeLabel (*region, index));
    if (lineage.testFixture)
        lines.add ("TEST FIXTURE output - not a model render");
    for (const auto& item : pluginState.intentions)
        if (item.getProperty ("id", {}).toString() == lineage.intentionId && lineage.intentionId.isNotEmpty())
        {
            const auto intention = intentionFromVar (item);
            lines.add ("Intention: " + intention.request.substring (0, 90)
                       + "  [" + juce::String (intention.attempts) + "/" + juce::String (intention.maxAttempts)
                       + " attempts, " + juce::String (intention.failures) + " failed]");
            if (! intention.revisions.isEmpty())
                lines.add ("Revisions: " + intention.revisions.joinIntoString (" / ").substring (0, 110));
        }
    const auto m1 = found->manifest.getProperty ("m1", {});
    if (auto* warnings = m1.getProperty ("checks", {}).getProperty ("warnings", {}).getArray(); warnings != nullptr && ! warnings->isEmpty())
    {
        juce::StringArray w;
        for (const auto& item : *warnings)
            w.add (item.toString());
        lines.add ("Checks: " + w.joinIntoString ("; "));
    }
    else if (m1.isObject())
        lines.add ("Checks: decodes, finite, not silent (technical only - not a taste judgement)");
    if (m1.isObject())
        lines.add ("Tempo conformance (technical): " + describeStoredTempoConformance (m1.getProperty ("tempoConformance", {})));
    if (lineage.role == "conform" && lineage.stretchRatio)
    {
        const auto conform = m1.getProperty ("conform", {});
        lines.add ("Conform: x" + juce::String (*lineage.stretchRatio, 4) + " ("
                   + juce::String (static_cast<double> (conform.getProperty ("fromBpm", 0.0)), 2) + " -> "
                   + juce::String (static_cast<double> (conform.getProperty ("toBpm", 0.0)), 2)
                   + " BPM); timing only - downbeats not aligned, not checked by ear");
    }
    if (audition.playing())
        lines.add ("Audition: FREE-RUNNING local preview - not host-synced, does not follow the timeline");
    else if (const auto stopped = audition.lastStop(); stopped != AuditionStop::none)
        lines.add ("Audition: free preview " + auditionStopName (stopped));
    if (auto* conditioning = m1.getProperty ("request", {}).getProperty ("conditioning", {}).getArray())
    {
        juce::StringArray notEnforced;
        for (const auto& entry : *conditioning)
            if (static_cast<bool> (entry.getProperty ("stored", false)) && ! static_cast<bool> (entry.getProperty ("enforced", false)))
                notEnforced.add (entry.getProperty ("field", {}).toString() + " (" + entry.getProperty ("sentAs", {}).toString() + ")");
        if (! notEnforced.isEmpty())
            lines.add ("Not enforced by the model: " + notEnforced.joinIntoString (", "));
    }
    return lines.joinIntoString ("\n");
}

// ── Conform (timing only) and free audition ───────────────────────────────────────

juce::String ReImagineProcessor::conformSelected()
{
    const juce::ScopedLock lock (stateLock);
    const auto refuse = [this] (const juce::String& why)
    {
        uiStatus = "Conform refused: " + why;
        auto* payload = new juce::DynamicObject();
        payload->setProperty ("refusal", why);
        logEvent ("conform.refused", "system", juce::var (payload));
        return why;
    };
    if (offlineProcessing.load (std::memory_order_acquire) != 0)
        return refuse ("offline export never conforms");
    if (regionCollection.pendingOverlap())
        return refuse ("choose Replace or Discard for the overlapping Transfer first");
    if (pendingBatch || batchActive.load (std::memory_order_acquire) != 0)
        return refuse ("a generation is running");
    if (pendingConform || conformRunning.load (std::memory_order_acquire) != 0)
        return refuse ("a conform is already running");
    const auto* region = selectedRegionUnsafe();
    if (region == nullptr)
        return refuse ("Transfer or Import a region first");
    if (region->status == RegionStatus::staleTempo)
        return refuse ("the region is stale after a tempo change - Re-transfer first");
    const auto take = std::find_if (region->takes.begin(), region->takes.end(),
                                    [&] (const auto& t) { return t.id == region->selectedTakeId; });
    if (take == region->takes.end())
        return refuse ("select the version to conform");
    const auto context = contextForUnsafe (*region);
    if (const auto why = conformContextRefusal (context); why.isNotEmpty())
        return refuse (why);
    pendingConform = ConformJob { region->id, region->sourceHash, take->id, take->assetHash, context };
    uiStatus = "Measuring and conforming the selected version (off the audio thread)...";
    auto* payload = new juce::DynamicObject();
    payload->setProperty ("regionId", region->id);
    payload->setProperty ("takeId", take->id);
    payload->setProperty ("sessionBpm", *context.bpm);
    payload->setProperty ("bpmFrom", provenanceName (context.bpmFrom));
    logEvent ("conform.requested", "explicit", juce::var (payload));
    conformRequested.store (1, std::memory_order_release);
    workerEvent.signal();
    return {};
}

void ReImagineProcessor::performConform (const ConformJob& job)
{
    const auto refuse = [this, &job] (const juce::String& why, const juce::var& measured)
    {
        setStatus ("Conform refused: " + why);
        auto* payload = new juce::DynamicObject();
        payload->setProperty ("takeId", job.parentTakeId);
        payload->setProperty ("refusal", why);
        payload->setProperty ("measured", measured);
        logEvent ("conform.refused", "system", juce::var (payload));
    };
    const auto file = assets.renderFile (job.parentAssetHash);
    if (! assets.verify (file, job.parentAssetHash))
        return refuse ("the version's audio is missing or changed - Relink it first", {});
    juce::AudioFormatManager formats;
    formats.registerBasicFormats();
    auto reader = std::unique_ptr<juce::AudioFormatReader> (formats.createReaderFor (file));
    if (! reader || reader->lengthInSamples <= 0 || reader->lengthInSamples > std::numeric_limits<int>::max() / 2)
        return refuse ("the version's audio does not decode", {});
    const auto rate = reader->sampleRate;
    juce::AudioBuffer<float> audio (static_cast<int> (reader->numChannels), static_cast<int> (reader->lengthInSamples));
    reader->read (&audio, 0, audio.getNumSamples(), 0, true, true);
    reader.reset();

    // Measured now, against the session as it is now (a stored report may be stale).
    const auto before = checkTempoConformance (audio.getArrayOfReadPointers(), audio.getNumChannels(),
                                               audio.getNumSamples(), rate, job.context);
    const auto plan = planConform (before, job.context);
    if (! plan.allowed)
        return refuse (plan.refusal, tempoConformanceToVar (before));

    juce::AudioBuffer<float> stretched;
    juce::String error;
    if (! stretchForConform (audio, rate, plan.stretchRatio, stretched, error, [this] { return threadShouldExit(); }))
        return refuse (error, tempoConformanceToVar (before));
    // The conformed version replaces the same region as its parent, so it keeps the
    // parent's exact length: a sped-up take is padded with silence (never the dry source,
    // which renderSelected would otherwise play under "Replace"), a slowed one is trimmed.
    const auto stretchedFrames = stretched.getNumSamples();
    const auto parentFrames = audio.getNumSamples();
    if (stretchedFrames != parentFrames)
    {
        juce::AudioBuffer<float> fitted (stretched.getNumChannels(), parentFrames);
        fitted.clear();
        for (int channel = 0; channel < fitted.getNumChannels(); ++channel)
            fitted.copyFrom (channel, 0, stretched, channel, 0, std::min (stretchedFrames, parentFrames));
        stretched = std::move (fitted);
    }
    const auto paddedFrames = std::max (0, parentFrames - stretchedFrames);
    const auto trimmedFrames = std::max (0, stretchedFrames - parentFrames);
    const auto checks = checkCandidate (measureAudio (stretched.getArrayOfReadPointers(), stretched.getNumChannels(),
                                                      stretched.getNumSamples(), rate),
                                        static_cast<double> (parentFrames) / rate, audio.getNumChannels());
    if (! checks.usable)
        return refuse ("the conformed audio failed the technical checks: " + checks.failures.joinIntoString ("; "),
                       tempoConformanceToVar (before));
    const auto after = checkTempoConformance (stretched.getArrayOfReadPointers(), stretched.getNumChannels(),
                                              stretched.getNumSamples(), rate, job.context);

    auto work = assets.root().getSiblingFile ("work");
    work.createDirectory();
    const auto temp = work.getChildFile ("conform-" + juce::Uuid().toDashedString() + ".wav");
    {
        juce::WavAudioFormat wav;
        std::unique_ptr<juce::OutputStream> stream (temp.createOutputStream().release());
        auto writer = stream ? wav.createWriterFor (stream, juce::AudioFormatWriterOptions()
                                                                .withSampleRate (rate)
                                                                .withNumChannels (stretched.getNumChannels())
                                                                .withBitsPerSample (24))
                             : nullptr;
        if (! writer || ! writer->writeFromAudioSampleBuffer (stretched, 0, stretched.getNumSamples()))
        {
            temp.deleteFile();
            return refuse ("could not write the conformed audio", tempoConformanceToVar (before));
        }
    }
    const auto hash = assets.importWav (temp, false, error);
    temp.deleteFile();
    if (hash.isEmpty())
        return refuse (error, tempoConformanceToVar (before));

    bool published = false;
    juce::String label;
    RenderTake take;
    {
        const juce::ScopedLock lock (stateLock);
        const auto target = std::find_if (pluginState.regions.begin(), pluginState.regions.end(),
                                          [&] (const auto& r) { return r.id == job.regionId; });
        const auto parent = target == pluginState.regions.end()
            ? std::vector<RenderTake>::iterator {}
            : std::find_if (target->takes.begin(), target->takes.end(),
                            [&] (const auto& t) { return t.id == job.parentTakeId; });
        if (target != pluginState.regions.end() && target->sourceHash == job.sourceHash && parent != target->takes.end())
        {
            take.id = juce::Uuid().toString();
            take.assetHash = hash;
            take.timestampIso8601 = juce::Time::getCurrentTime().toISO8601 (true);
            take.seed = parent->seed;
            take.parameters = parent->parameters;
            take.manifest = parent->manifest.isObject() ? parent->manifest.clone() : juce::var (new juce::DynamicObject());
            // A conform of an imported take is a conform, not an import (label and sidecar).
            const auto parentSource = take.manifest.getProperty ("source", {}).toString();
            take.manifest.getDynamicObject()->removeProperty ("source");
            auto lineage = lineageOf (*parent);
            lineage.parentTakeId = parent->id;
            lineage.role = "conform";
            lineage.kept = false;
            lineage.conformedFrom = parent->id;
            lineage.stretchRatio = plan.stretchRatio;
            setLineage (take, lineage);
            if (auto* m1 = take.manifest.getProperty ("m1", {}).getDynamicObject())
            {
                auto conform = conformPlanToVar (plan);
                conform.getDynamicObject()->setProperty ("method", "SoundTouch (Tracktion-vendored, Better settings), pitch kept");
                conform.getDynamicObject()->setProperty ("measuredBefore", tempoConformanceToVar (before));
                conform.getDynamicObject()->setProperty ("rawAssetSha256", parent->assetHash);
                conform.getDynamicObject()->setProperty ("stretchedFrames", stretchedFrames);
                conform.getDynamicObject()->setProperty ("paddedFrames", paddedFrames);
                conform.getDynamicObject()->setProperty ("trimmedFrames", trimmedFrames);
                if (parentSource.isNotEmpty())
                    conform.getDynamicObject()->setProperty ("parentSource", parentSource);
                m1->setProperty ("conform", conform);
                m1->setProperty ("checks", technicalReportToVar (checks));   // of the conformed audio, not the parent
                m1->setProperty ("tempoConformance", tempoConformanceToVar (after));
            }
            target->takes.push_back (take);
            target->selectedTakeId = take.id;
            label = takeLabel (*target, target->takes.size() - 1);
            loadRequested.store (1, std::memory_order_release);
            published = true;
        }
    }
    if (! published)
        return refuse ("the region or version changed while conforming; result discarded", tempoConformanceToVar (before));
    setStatus (label + ": " + juce::String (plan.fromBpm, 2) + " -> " + juce::String (plan.toBpm, 2)
               + " BPM; now " + describeTempoConformance (after) + " (timing only, downbeats not aligned)");
    auto* payload = new juce::DynamicObject();
    payload->setProperty ("regionId", job.regionId);
    payload->setProperty ("takeId", take.id);
    payload->setProperty ("parentTakeId", job.parentTakeId);
    payload->setProperty ("conformedFrom", job.parentTakeId);
    payload->setProperty ("stretchRatio", plan.stretchRatio);
    payload->setProperty ("fromBpm", plan.fromBpm);
    payload->setProperty ("toBpm", plan.toBpm);
    payload->setProperty ("driftMsPerBarBefore", plan.driftMsPerBar);
    payload->setProperty ("verdictAfter", tempoVerdictName (after.verdict));
    payload->setProperty ("paddedFrames", paddedFrames);
    payload->setProperty ("trimmedFrames", trimmedFrames);
    payload->setProperty ("assetSha256", hash);
    payload->setProperty ("rawAssetSha256", job.parentAssetHash);
    logEvent ("version.conformed", "explicit", juce::var (payload));
    workerEvent.signal();
}

bool ReImagineProcessor::undoLastConform()
{
    const juce::ScopedLock lock (stateLock);
    auto* region = selectedRegionUnsafe();
    if (region == nullptr || region->takes.empty() || region->takes.back().id != region->selectedTakeId)
    {
        uiStatus = "Nothing to undo: select the newest version, which must be a conform";
        return false;
    }
    const auto conformed = region->takes.back();
    const auto lineage = lineageOf (conformed);
    if (lineage.role != "conform" || lineage.kept)
    {
        uiStatus = lineage.kept ? "The conformed version is kept - not removed"
                                : "Nothing to undo: the selected version is not a conform";
        return false;
    }
    region->takes.pop_back();
    const auto parentExists = std::any_of (region->takes.begin(), region->takes.end(),
                                           [&] (const auto& t) { return t.id == lineage.parentTakeId; });
    region->selectedTakeId = parentExists ? lineage.parentTakeId : juce::String();
    uiStatus = "Conform undone - the version it was stretched from is selected again";
    loadRequested.store (1, std::memory_order_release);
    workerEvent.signal();
    auto* payload = new juce::DynamicObject();
    payload->setProperty ("regionId", region->id);
    payload->setProperty ("takeId", conformed.id);
    payload->setProperty ("parentTakeId", lineage.parentTakeId);
    payload->setProperty ("assetSha256", conformed.assetHash);
    logEvent ("version.conform-undone", "explicit", juce::var (payload));
    return true;
}

juce::String ReImagineProcessor::startFreeAudition()
{
    const juce::ScopedLock lock (stateLock);
    const auto refuse = [this] (const juce::String& why)
    {
        uiStatus = "Free audition refused: " + why;
        return why;
    };
    if (offlineProcessing.load (std::memory_order_acquire) != 0)
        return refuse ("offline export");
    if (lastHostPlaying.load (std::memory_order_acquire) != 0)
        return refuse ("the host is playing - the region already plays in sync; stop the host to preview freely");
    const auto* region = selectedRegionUnsafe();
    if (region == nullptr)
        return refuse ("Transfer or Import a region first");
    if (std::none_of (region->takes.begin(), region->takes.end(),
                      [&] (const auto& t) { return t.id == region->selectedTakeId; }))
        return refuse ("select a version to audition");
    // Arm before load: the worker loads the selection, then starts from its snapshot.
    auditionArmRequested.store (1, std::memory_order_release);
    loadRequested.store (1, std::memory_order_release);
    uiStatus = "Preparing free audition...";
    workerEvent.signal();
    return {};
}

void ReImagineProcessor::stopFreeAudition()
{
    auditionArmRequested.store (0, std::memory_order_release);
    audition.stop (AuditionStop::user);
    setStatus ("Free audition stopped");
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
