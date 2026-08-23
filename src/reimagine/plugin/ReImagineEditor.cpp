#include "ReImagineEditor.h"

namespace mosh::reimagine
{
ReImagineEditor::ReImagineEditor (ReImagineProcessor& p)
    : AudioProcessorEditor (&p), processorRef (p), progressBar (progressValue)
{
    setSize (720, 590);
    std::array<juce::Component*, 17> components { &transfer, &newTake, &compare, &reset, &relink,
                                                  &replace, &discard, &prompt, &reimagine, &mix,
                                                  &loraStack, &seed, &takes, &regions, &lab, &status, &progressBar };
    for (auto* component : components)
        addAndMakeVisible (component);
    for (size_t i = 0; i < colorNames.size(); ++i)
    {
        addAndMakeVisible (colorNames[i]);
        addAndMakeVisible (colorAmounts[i]);
        colorNames[i].setTextToShowWhenEmpty ("Color " + juce::String (i + 1), juce::Colours::grey);
        colorAmounts[i].setRange (0.0, 100.0, 1.0);
        colorAmounts[i].setValue (65.0, juce::dontSendNotification);
        colorAmounts[i].setSliderStyle (juce::Slider::LinearHorizontal);
        colorAmounts[i].setTextBoxStyle (juce::Slider::TextBoxRight, false, 54, 20);
        colorAmounts[i].onDragEnd = [this] { commit(); };
        colorNames[i].onReturnKey = [this] { commit(); };
        colorNames[i].onFocusLost = [this] { commit(); };
    }
    prompt.setMultiLine (true);
    prompt.setReturnKeyStartsNewLine (false);
    prompt.setTextToShowWhenEmpty ("Describe how to re-imagine this passage…", juce::Colours::grey);
    prompt.onReturnKey = [this] { commit(); };
    prompt.onFocusLost = [this] { commit(); };
    reimagine.setRange (0.15, 0.5, 0.01);
    reimagine.setSliderStyle (juce::Slider::LinearHorizontal);
    reimagine.setTextBoxStyle (juce::Slider::TextBoxRight, false, 60, 20);
    reimagine.onDragEnd = [this] { commit(); };
    mix.setSliderStyle (juce::Slider::RotaryHorizontalVerticalDrag);
    mix.setTextBoxStyle (juce::Slider::TextBoxBelow, false, 60, 20);
    mixAttachment = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment> (
        processorRef.parameters, "mix", mix);
    loraStack.setTextToShowWhenEmpty ("LoRA stack: id@scale, id@scale", juce::Colours::grey);
    loraStack.onReturnKey = [this] { commit(); };
    loraStack.onFocusLost = [this] { commit(); };
    seed.setInputRestrictions (12, "0123456789-");
    seed.onReturnKey = [this] { commit(); };
    transfer.onClick = [this] { processorRef.toggleTransfer(); };
    newTake.onClick = [this] { processorRef.newTake(); };
    compare.setClickingTogglesState (true);
    compare.onClick = [this]
    {
        if (compare.getToggleState()) processorRef.setCompareDry (true); else processorRef.clearCompareDry();
    };
    reset.onClick = [this] { processorRef.resetSelection(); };
    relink.onClick = [this]
    {
        fileChooser = std::make_unique<juce::FileChooser> ("Relink hash-matching WAV", juce::File(), "*.wav");
        fileChooser->launchAsync (juce::FileBrowserComponent::openMode
                                  | juce::FileBrowserComponent::canSelectFiles,
                                  [this] (const juce::FileChooser& chooser)
                                  {
                                      const auto file = chooser.getResult();
                                      if (file.existsAsFile()) processorRef.relinkSelectedAsset (file);
                                  });
    };
    replace.onClick = [this] { processorRef.replacePendingOverlap(); };
    discard.onClick = [this] { processorRef.discardPendingOverlap(); };
    lab.onClick = [this]
    {
        const auto enabled = lab.getToggleState();
        processorRef.setLabEnabled (enabled);
        reimagine.setRange (0.15, enabled ? 1.5 : 0.5, 0.01);
        commit();
    };
    takes.onChange = [this] { processorRef.setSelectedTake (takes.getSelectedItemIndex()); };
    regions.onChange = [this]
    {
        processorRef.setSelectedRegion (regions.getSelectedItemIndex());
        knownTakeCount = -1;
    };
    status.setColour (juce::Label::textColourId, juce::Colour::fromRGB (195, 202, 214));
    status.setJustificationType (juce::Justification::centredLeft);
    const auto state = processorRef.stateSnapshot();
    prompt.setText (state.rack.prompt, false);
    reimagine.setRange (0.15, state.labEnabled ? 1.5 : 0.5, 0.01);
    reimagine.setValue (state.rack.reimagine, juce::dontSendNotification);
    seed.setText (juce::String (state.rack.seed), false);
    lab.setToggleState (state.labEnabled, juce::dontSendNotification);
    startTimerHz (10);
}

RackSettings ReImagineEditor::rackFromControls() const
{
    RackSettings rack;
    rack.prompt = prompt.getText().trim();
    rack.reimagine = static_cast<float> (reimagine.getValue());
    rack.seed = seed.getText().getLargeIntValue();
    for (size_t i = 0; i < colorNames.size(); ++i)
        if (colorNames[i].getText().trim().isNotEmpty())
            rack.colors.push_back ({ colorNames[i].getText().trim(),
                                     static_cast<float> (colorAmounts[i].getValue()) });
    for (auto token : juce::StringArray::fromTokens (loraStack.getText(), ",", {}))
    {
        auto parts = juce::StringArray::fromTokens (token, "@", {});
        if (! parts.isEmpty() && parts[0].trim().isNotEmpty())
            rack.loras.push_back ({ parts[0].trim(), parts.size() > 1 ? parts[1].getFloatValue() : 1.0f });
    }
    return rack;
}

void ReImagineEditor::commit() { processorRef.commitRack (rackFromControls()); }

void ReImagineEditor::timerCallback()
{
    status.setText (processorRef.statusText(), juce::dontSendNotification);
    progressValue = processorRef.progress();
    transfer.setButtonText (processorRef.transferActive() ? "Stop Transfer" : "Transfer");
    const auto overlap = processorRef.hasPendingOverlap();
    replace.setVisible (overlap);
    discard.setVisible (overlap);
    const auto state = processorRef.stateSnapshot();
    if (static_cast<int> (state.regions.size()) != knownRegionCount)
    {
        knownRegionCount = static_cast<int> (state.regions.size());
        regions.clear (juce::dontSendNotification);
        for (int i = 0; i < knownRegionCount; ++i)
        {
            const auto& region = state.regions[static_cast<size_t> (i)];
            regions.addItem ("Region " + juce::String (i + 1) + " · "
                             + juce::String (region.ppqStart, 2) + "–"
                             + juce::String (region.ppqEnd, 2), i + 1);
        }
        knownTakeCount = -1;
    }
    for (int i = 0; i < knownRegionCount; ++i)
        if (state.regions[static_cast<size_t> (i)].id == state.selectedRegionId
            && regions.getSelectedItemIndex() != i)
        {
            regions.setSelectedItemIndex (i, juce::dontSendNotification);
            knownTakeCount = -1;
            break;
        }
    const auto found = std::find_if (state.regions.begin(), state.regions.end(), [&] (const auto& region)
    {
        return region.id == state.selectedRegionId;
    });
    const auto takeCount = found == state.regions.end() ? 0 : static_cast<int> (found->takes.size());
    if (takeCount != knownTakeCount)
    {
        knownTakeCount = takeCount;
        takes.clear (juce::dontSendNotification);
        if (found != state.regions.end())
            for (int i = 0; i < takeCount; ++i)
            {
                const auto& take = found->takes[static_cast<size_t> (i)];
                takes.addItem ("Take " + juce::String (i + 1) + " · seed " + juce::String (take.seed), i + 1);
                if (take.id == found->selectedTakeId)
                    takes.setSelectedItemIndex (i, juce::dontSendNotification);
            }
    }
}

void ReImagineEditor::paint (juce::Graphics& g)
{
    g.fillAll (juce::Colour::fromRGB (14, 16, 21));
    g.setColour (juce::Colour::fromRGB (124, 92, 255));
    g.fillRect (0, 0, getWidth(), 7);
    g.setColour (juce::Colours::white);
    g.setFont (juce::FontOptions (24.0f, juce::Font::bold));
    g.drawText ("MOSH  RE-IMAGINE", 24, 18, 360, 34, juce::Justification::centredLeft);
    g.setColour (juce::Colour::fromRGB (150, 157, 172));
    g.setFont (juce::FontOptions (13.0f));
    g.drawText ("Timeline-aware local Stable Audio transformation", 25, 49, 420, 22,
                juce::Justification::centredLeft);
    g.setColour (juce::Colour::fromRGB (45, 49, 61));
    g.drawRoundedRectangle (20.0f, 82.0f, 680.0f, 470.0f, 10.0f, 1.0f);
    g.setColour (juce::Colour::fromRGB (188, 194, 208));
    g.drawText ("KEEP", 36, 202, 70, 20, juce::Justification::left);
    g.drawText ("RE-IMAGINE", 582, 202, 100, 20, juce::Justification::right);
    g.drawText ("MIX", 607, 92, 70, 20, juce::Justification::centred);
}

void ReImagineEditor::resized()
{
    transfer.setBounds (36, 96, 120, 34);
    newTake.setBounds (164, 96, 92, 34);
    regions.setBounds (264, 96, 130, 34);
    takes.setBounds (402, 96, 99, 34);
    compare.setBounds (511, 96, 82, 34);
    mix.setBounds (607, 112, 70, 80);
    reset.setBounds (511, 140, 82, 28);
    relink.setBounds (511, 174, 82, 28);
    prompt.setBounds (36, 144, 455, 52);
    reimagine.setBounds (100, 202, 475, 24);
    for (size_t i = 0; i < colorNames.size(); ++i)
    {
        const auto y = 244 + static_cast<int> (i) * 48;
        colorNames[i].setBounds (36, y, 210, 30);
        colorAmounts[i].setBounds (260, y, 300, 30);
    }
    loraStack.setBounds (36, 394, 524, 32);
    seed.setBounds (574, 394, 102, 32);
    lab.setBounds (36, 438, 360, 26);
    replace.setBounds (404, 438, 150, 28);
    discard.setBounds (564, 438, 112, 28);
    status.setBounds (36, 480, 520, 28);
    progressBar.setBounds (36, 518, 640, 16);
}
}
