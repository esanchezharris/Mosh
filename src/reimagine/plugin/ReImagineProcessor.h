#pragma once

#include "../ReImagineCore.h"
#include "../ReImagineService.h"

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
    void setLabEnabled (bool);
    PluginStateV1 stateSnapshot() const;
    juce::String statusText() const;
    float progress() const noexcept { return renderProgress.load (std::memory_order_acquire); }
    bool transferActive() const noexcept;
    bool hasPendingOverlap() const;
    void refreshLoraCatalog();
    LoraCatalogSnapshot loraCatalogSnapshot() const;

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

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (ReImagineProcessor)
};
}
