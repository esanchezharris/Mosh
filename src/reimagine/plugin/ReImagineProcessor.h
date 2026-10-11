#pragma once

#include "../ReImagineCore.h"
#include "../ReImagineService.h"
#include "../ReImagineSession.h"

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_audio_processors/juce_audio_processors.h>

#include <atomic>
#include <memory>
#include <vector>

namespace mosh::reimagine
{
class ReImagineProcessor final : public juce::AudioProcessor, private juce::Thread
{
public:
    ReImagineProcessor();
    ~ReImagineProcessor() override;

    void prepareToPlay (double sampleRate, int maximumExpectedSamplesPerBlock) override;
    void releaseResources() override;
    bool isBusesLayoutSupported (const BusesLayout&) const override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    using AudioProcessor::processBlock;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }
    const juce::String getName() const override { return JucePlugin_Name; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return "Default"; }
    void changeProgramName (int, const juce::String&) override {}
    void getStateInformation (juce::MemoryBlock&) override;
    void setStateInformation (const void*, int) override;

    void toggleTransfer();
    void replacePendingOverlap();
    void discardPendingOverlap();
    void commitRack (RackSettings);
    void newTake();
    void setSelectedRegion (int index);
    void setSelectedTake (int index);
    void setCompareDry (bool enabled) noexcept { compareDry.store (boolToInt (enabled), std::memory_order_release); }
    void clearCompareDry() noexcept { compareDry.store (0, std::memory_order_release); }
    void resetSelection();
    void relinkSelectedAsset (const juce::File&);
    // IMP-001 — drop an externally recorded WAV (a Mosh take, another DAW's bounce) onto
    // the Live timeline at a 1-based bar. It becomes an ordinary region whose source and
    // selected take share one content hash, so playback substitution, Relink, New Take
    // and Set restore all treat it like a Transfer. Refuses a sample-rate mismatch
    // (no resampling — same rule as the consolidated-export contract) and a bar < 1.
    // Tempo/time signature come from the host's last reported position; with none yet
    // (plug-in never processed) 120 BPM in 4/4 is assumed and the status says so.
    void importTakeFromFile (const juce::File&, double bar);
    void setLabEnabled (bool);
    PluginStateV1 stateSnapshot() const;
    juce::String statusText() const;
    float progress() const noexcept { return renderProgress.load (std::memory_order_acquire); }
    bool transferActive() const noexcept;
    bool hasPendingOverlap() const;
    void refreshLoraCatalog();
    LoraCatalogSnapshot loraCatalogSnapshot() const;
    // Stores the rack without rendering. Edits never spend a model call; only
    // Generate, Revise and New Take do.
    void storeRack (RackSettings);

    // ── M1 contextual generation loop (docs/reimagine-plugin/M1-CONTEXTUAL-LOOP.md) ──
    // The selected region's stored context merged with host facts (host never
    // overrides user values; unknown stays unknown).
    SessionContext selectedContext() const;
    // Validates and stores user context for the selected region. Returns errors;
    // nothing is stored when any field is invalid.
    juce::StringArray setSelectedContext (const juce::String& key, const juce::String& chords,
                                          const juce::String& section, const juce::String& protectedChoices);
    // Starts a new intention: freezes a SessionSnapshot, compiles the typed request
    // and queues `candidateCount` candidates from the region's original source.
    // Returns errors (nothing queued) or warnings (queued).
    juce::StringArray generateCandidates (IntentionInput);
    // Continues the selected take's intention with a revision linked to it. With
    // `fromSelectedAudio` the selected take's audio is the init audio; otherwise the
    // original source is used again.
    juce::StringArray reviseSelected (IntentionInput, bool fromSelectedAudio);
    void cancelGeneration();
    // Marks the selected take as a durable kept version. Never writes the host timeline.
    void keepSelected();
    // Copies the selected take to ~/Music/Mosh Exports with a JSON sidecar. The copy is
    // durable (not a cache) and safe to drag into any DAW.
    juce::File exportSelected (juce::String& error);
    juce::String selectedReport() const;
    bool generationActive() const noexcept { return batchActive.load (std::memory_order_acquire) != 0; }
    const juce::String& instanceIdentifier() const noexcept { return instanceId; }

    juce::AudioProcessorValueTreeState parameters;

private:
    struct PlaybackRegion
    {
        juce::String id;
        juce::AudioBuffer<float> audio;
        double sampleRate = 0.0;
        double ppqStart = 0.0;
        double ppqEnd = 0.0;
        TempoMap tempoMap;
        std::vector<double> secondsAtTempoPoint;
        // 0 = valid, 1 = stale and reported, 2 = stale and awaiting worker report.
        mutable std::atomic<int> stale { 0 };
    };

    struct PlaybackSnapshot
    {
        std::vector<std::unique_ptr<PlaybackRegion>> regions;
    };

    static juce::AudioProcessorValueTreeState::ParameterLayout makeParameters();
    static int boolToInt (bool value) noexcept { return value ? 1 : 0; }
    std::optional<HostPosition> hostPosition() const noexcept;
    void captureInput (const juce::AudioBuffer<float>&, int64_t offset) noexcept;
    void renderSelected (juce::AudioBuffer<float>&, const HostPosition&) noexcept;
    int sampleForPpq (const PlaybackRegion&, double ppq) const noexcept;
    void run() override;
    void finalizeCapture();
    void performRender (const RenderRequest&);
    void loadSelectedTake();
    void publishPlayback (std::unique_ptr<PlaybackSnapshot>);
    TransferRegion* selectedRegionUnsafe();
    const TransferRegion* selectedRegionUnsafe() const;
    void setStatus (juce::String);

    struct GenerationBatch
    {
        uint64_t id = 0;
        juce::String regionId;
        juce::String sourceHash;
        CompiledRequest request;
        SessionSnapshot snapshot;
        juce::String adapter;
    };
    juce::StringArray enqueueBatch (IntentionInput, bool revision, bool fromSelectedAudio);
    void performBatch (const GenerationBatch&);
    bool batchCancelled (uint64_t id) const noexcept
    {
        return cancelledThroughBatch.load (std::memory_order_acquire) >= id;
    }
    int intentionIndexUnsafe (const juce::String& id) const;
    void storeIntentionUnsafe (const IntentionRecord&);
    SessionContext contextForUnsafe (const TransferRegion&) const;
    void logEvent (const juce::String& event, const juce::String& signal, const juce::var& payload) const;

    mutable juce::CriticalSection stateLock;
    PluginStateV1 pluginState;
    RegionCollection regionCollection;
    RenderCoordinator renderCoordinator;
    TransferCapture transfer;
    juce::AudioBuffer<float> captureBuffer;
    std::atomic<int64_t> captureWriteOffset { 0 };
    std::atomic<int> armTransferRequested { 0 };
    std::atomic<int> stopTransferRequested { 0 };
    std::atomic<int> transferStateMirror { static_cast<int> (CaptureState::idle) };
    std::atomic<int> lastHostPlaying { 0 };
    std::atomic<int> offlineProcessing { 0 };
    std::atomic<int> finalizeRequested { 0 };
    std::atomic<int> finalizationPending { 0 };
    std::atomic<int> captureAbortEvent { 0 };
    std::atomic<int> renderRequested { 0 };
    std::atomic<int> loadRequested { 0 };
    std::atomic<int> loraCatalogRequested { 0 };
    std::atomic<int> compareDry { 0 };
    std::atomic<float> renderProgress { 0.0f };
    std::atomic<uint64_t> nextRevision { 1 };
    juce::WaitableEvent workerEvent;
    AssetStore assets;
    SharedServiceClient service;
    LoraCatalogSnapshot loraCatalog;
    juce::String currentJobId;
    juce::String uiStatus { "Ready - arm Transfer while stopped" };
    std::atomic<double> currentSampleRate { 48000.0 };
    std::atomic<int> currentChannels { 2 };
    std::atomic<float>* mixValue = nullptr;
    std::atomic<const PlaybackSnapshot*> audibleSnapshot { nullptr };
    std::atomic<int> snapshotReaders { 0 };
    std::unique_ptr<PlaybackSnapshot> ownedPlaybackSnapshot;

    // M1 loop state. pendingBatch is guarded by stateLock.
    std::optional<GenerationBatch> pendingBatch;
    std::atomic<int> batchRequested { 0 };
    std::atomic<int> batchActive { 0 };
    std::atomic<uint64_t> nextBatchId { 1 };
    std::atomic<uint64_t> cancelledThroughBatch { 0 };
    std::atomic<int> lastMeterNumerator { 0 };
    const juce::String instanceId { juce::Uuid().toString() };
    ExperienceLog experience;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (ReImagineProcessor)
};
}
