#pragma once

#include "ReImagineProcessor.h"

#include <juce_gui_extra/juce_gui_extra.h>

namespace mosh::reimagine
{
class ReImagineEditor final : public juce::AudioProcessorEditor,
                              private juce::Timer
{
public:
    explicit ReImagineEditor (ReImagineProcessor&);
    ~ReImagineEditor() override = default;
    void paint (juce::Graphics&) override;
    void resized() override;

private:
    void timerCallback() override;
    RackSettings rackFromControls() const;
    void commit();
    ReImagineProcessor& processorRef;
    juce::TextButton transfer { "Transfer" };
    juce::TextButton newTake { "New Take" };
    juce::TextButton compare { "A/B Dry" };
    juce::TextButton reset { "Reset" };
    juce::TextButton relink { "Relink…" };
    juce::TextButton replace { "Replace overlap" };
    juce::TextButton discard { "Discard" };
    juce::TextEditor prompt;
    juce::Slider reimagine;
    juce::Slider mix;
    std::unique_ptr<juce::AudioProcessorValueTreeState::SliderAttachment> mixAttachment;
    std::array<juce::TextEditor, 3> colorNames;
    std::array<juce::Slider, 3> colorAmounts;
    juce::TextEditor loraStack;
    juce::TextEditor seed;
    juce::ComboBox takes;
    juce::ComboBox regions;
    juce::ToggleButton lab { "Advanced / Lab (may produce unstable audio)" };
    juce::Label status;
    juce::ProgressBar progressBar;
    double progressValue = 0.0;
    std::unique_ptr<juce::FileChooser> fileChooser;
    int knownTakeCount = -1;
    int knownRegionCount = -1;
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (ReImagineEditor)
};
}
