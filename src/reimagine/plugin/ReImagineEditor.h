#pragma once

#include "ReImagineLookAndFeel.h"
#include "ReImagineProcessor.h"

#include <juce_gui_extra/juce_gui_extra.h>

namespace mosh::reimagine
{
class ReImagineEditor final : public juce::AudioProcessorEditor,
                              private juce::Timer
{
public:
    explicit ReImagineEditor (ReImagineProcessor&);
    ~ReImagineEditor() override;
    void paint (juce::Graphics&) override;
    void resized() override;

private:
    void timerCallback() override;
    RackSettings rackFromControls() const;
    void commit();
    void showLoraLoadingState();
    void syncLoraCatalog (const LoraCatalogSnapshot&);
    void updateLoraInfo();
    void configureLabel (juce::Label&, const juce::String&, float size, bool heading = false);
    ReImagineProcessor& processorRef;
    ReImagineLookAndFeel lookAndFeel;
    juce::TextButton transfer { "Transfer" };
    juce::TextButton newTake { "New Take" };
    juce::TextButton compare { "Dry A/B" };
    juce::TextButton reset { "Reset" };
    juce::TextButton relink { "Relink" };
    juce::TextButton replace { "Replace overlap" };
    juce::TextButton discard { "Discard" };
    juce::TextButton refreshLoras { "Refresh" };
    juce::TextEditor prompt;
    juce::Slider reimagine;
    juce::Slider mix;
    std::unique_ptr<juce::AudioProcessorValueTreeState::SliderAttachment> mixAttachment;
    std::array<juce::TextEditor, 3> colorNames;
    std::array<juce::Slider, 3> colorAmounts;
    std::array<juce::ComboBox, 3> loraSelectors;
    std::array<juce::Slider, 3> loraAmounts;
    std::array<std::vector<juce::String>, 3> loraMenuIds;
    std::array<juce::String, 3> loraSlotIds;
    juce::TextEditor seed;
    juce::ComboBox takes;
    juce::ComboBox regions;
    juce::ToggleButton lab { "Advanced / Lab" };
    juce::Label promptLabel;
    juce::Label reimagineLabel;
    juce::Label colorsLabel;
    juce::Label lorasLabel;
    juce::Label seedLabel;
    juce::Label mixLabel;
    juce::Label loraInfo;
    juce::Label labHelp;
    juce::Label status;
    juce::ProgressBar progressBar;
    double progressValue = 0.0;
    std::unique_ptr<juce::FileChooser> fileChooser;
    int knownTakeCount = -1;
    int knownRegionCount = -1;
    uint64_t knownLoraRevision = 0;
    bool syncingLoras = false;
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (ReImagineEditor)
};
}
