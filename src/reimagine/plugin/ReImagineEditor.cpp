#include "ReImagineEditor.h"

namespace mosh::reimagine
{
namespace
{
constexpr int editorWidth = 780;
constexpr int editorHeight = 690;
}

ReImagineEditor::ReImagineEditor (ReImagineProcessor& p)
    : AudioProcessorEditor (&p), processorRef (p), progressBar (progressValue)
{
    setLookAndFeel (&lookAndFeel);
    setOpaque (true);
    setSize (editorWidth, editorHeight);

    std::array<juce::Component*, 21> components {
        &transfer, &newTake, &compare, &reset, &relink, &importTake, &importBar, &replace, &discard, &refreshLoras,
        &prompt, &reimagine, &mix, &seed, &takes, &regions, &lab, &status, &progressBar,
        &loraInfo, &labHelp
    };
    for (auto* component : components)
        addAndMakeVisible (component);
    std::array<juce::Label*, 6> labels {
        &promptLabel, &reimagineLabel, &colorsLabel, &lorasLabel, &seedLabel, &mixLabel
    };
    for (auto* label : labels)
        addAndMakeVisible (label);

    configureLabel (promptLabel, "PROMPT", 11.0f, true);
    configureLabel (reimagineLabel, "KEEP / RE-IMAGINE", 11.0f, true);
    configureLabel (colorsLabel, "COLORS", 11.0f, true);
    configureLabel (lorasLabel, "LoRA STACK", 11.0f, true);
    configureLabel (seedLabel, "SEED", 11.0f, true);
    configureLabel (mixLabel, "MIX", 11.0f, true);
    configureLabel (loraInfo, "Loading local adapters...", 11.5f);
    configureLabel (labHelp, "Allows experimental strengths above the safe range.", 11.0f);
    configureLabel (status, "Ready - arm Transfer while stopped", 12.5f);
    status.setColour (juce::Label::textColourId, ReImagineLookAndFeel::text());

    transfer.setComponentID ("primary");
    transfer.setColour (juce::TextButton::buttonColourId, ReImagineLookAndFeel::accent());
    transfer.setTooltip ("Arm while stopped, then start Live playback to capture a region.");
    newTake.setTooltip ("Advance the seed and render a new immutable take.");
    compare.setTooltip ("Temporarily monitor the original dry audio.");
    reset.setTooltip ("Deselect the audible take without deleting history.");
    relink.setTooltip ("Relink a missing source or render WAV by verified content hash.");
    importTake.setTooltip ("Import an external WAV (a Mosh take, another DAW's bounce) as a take at the bar on the right. Same sample rate as the host; no resampling.");
    importBar.setInputRestrictions (8, "0123456789.");
    importBar.setFont (juce::FontOptions (13.0f));
    importBar.setText ("1", false);
    importBar.setTooltip ("1-based bar the imported take starts on (fractions allowed).");
    refreshLoras.setTooltip ("Refresh the local SA3 LoRA library.");
    refreshLoras.setComponentID ("refresh-loras");
    loraInfo.setComponentID ("lora-info");
    regions.setTextWhenNothingSelected ("No regions");
    regions.setTooltip ("Choose a transferred timeline region.");
    takes.setTextWhenNothingSelected ("No takes");
    takes.setTooltip ("Choose an immutable rendered take.");
    replace.setVisible (false);
    discard.setVisible (false);

    for (size_t i = 0; i < colorNames.size(); ++i)
    {
        addAndMakeVisible (colorNames[i]);
        addAndMakeVisible (colorAmounts[i]);
        colorNames[i].setComponentID ("color-name-" + juce::String (i + 1));
        colorNames[i].setTextToShowWhenEmpty ("Color " + juce::String (i + 1),
                                              ReImagineLookAndFeel::muted());
        colorNames[i].setFont (juce::FontOptions (13.0f));
        colorAmounts[i].setRange (0.0, 100.0, 1.0);
        colorAmounts[i].setValue (65.0, juce::dontSendNotification);
        colorAmounts[i].setSliderStyle (juce::Slider::LinearHorizontal);
        colorAmounts[i].setTextBoxStyle (juce::Slider::TextBoxRight, false, 50, 24);
        colorAmounts[i].setTextValueSuffix ("%");
        colorAmounts[i].onDragEnd = [this] { commit(); };
        colorNames[i].onReturnKey = [this] { commit(); };
        colorNames[i].onFocusLost = [this] { commit(); };
    }

    for (size_t i = 0; i < loraSelectors.size(); ++i)
    {
        addAndMakeVisible (loraSelectors[i]);
        addAndMakeVisible (loraAmounts[i]);
        loraSelectors[i].setComponentID ("lora-slot-" + juce::String (i + 1));
        loraAmounts[i].setComponentID ("lora-strength-" + juce::String (i + 1));
        loraSelectors[i].addItem ("Loading adapters...", 1);
        loraSelectors[i].setSelectedId (1, juce::dontSendNotification);
        loraSelectors[i].setEnabled (false);
        loraAmounts[i].setRange (0.0, 150.0, 1.0);
        loraAmounts[i].setValue (100.0, juce::dontSendNotification);
        loraAmounts[i].setSliderStyle (juce::Slider::LinearHorizontal);
        loraAmounts[i].setTextBoxStyle (juce::Slider::TextBoxRight, false, 54, 24);
        loraAmounts[i].setTextValueSuffix ("%");
        loraAmounts[i].setEnabled (false);
        loraAmounts[i].onDragEnd = [this] { commit(); };
        loraSelectors[i].onChange = [this, i]
        {
            if (syncingLoras)
                return;
            const auto index = loraSelectors[i].getSelectedItemIndex();
            loraSlotIds[i] = juce::isPositiveAndBelow (index,
                static_cast<int> (loraMenuIds[i].size())) ? loraMenuIds[i][static_cast<size_t> (index)]
                                                         : juce::String();
            loraAmounts[i].setEnabled (loraSlotIds[i].isNotEmpty());
            updateLoraInfo();
            commit();
        };
    }

    prompt.setMultiLine (true);
    prompt.setReturnKeyStartsNewLine (false);
    prompt.setTextToShowWhenEmpty ("Describe the transformation", ReImagineLookAndFeel::muted());
    prompt.setFont (juce::FontOptions (14.0f));
    prompt.onReturnKey = [this] { commit(); };
    prompt.onFocusLost = [this] { commit(); };
    reimagine.setRange (0.15, 0.5, 0.01);
    reimagine.setSliderStyle (juce::Slider::LinearHorizontal);
    reimagine.setTextBoxStyle (juce::Slider::TextBoxRight, false, 54, 24);
    reimagine.onDragEnd = [this] { commit(); };
    mix.setSliderStyle (juce::Slider::RotaryHorizontalVerticalDrag);
    mix.setTextBoxStyle (juce::Slider::TextBoxBelow, false, 64, 22);
    mixAttachment = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment> (
        processorRef.parameters, "mix", mix);
    seed.setInputRestrictions (12, "0123456789-");
    seed.setFont (juce::FontOptions (13.0f));
    seed.onReturnKey = [this] { commit(); };
    seed.onFocusLost = [this] { commit(); };

    transfer.onClick = [this] { processorRef.toggleTransfer(); };
    newTake.onClick = [this] { processorRef.newTake(); };
    compare.setClickingTogglesState (true);
    compare.onClick = [this]
    {
        if (compare.getToggleState()) processorRef.setCompareDry (true);
        else processorRef.clearCompareDry();
    };
    reset.onClick = [this] { processorRef.resetSelection(); };
    refreshLoras.onClick = [this]
    {
        showLoraLoadingState();
        processorRef.refreshLoraCatalog();
    };
    relink.onClick = [this]
    {
        fileChooser = std::make_unique<juce::FileChooser> ("Relink hash-matching WAV",
                                                           juce::File(), "*.wav");
        fileChooser->launchAsync (juce::FileBrowserComponent::openMode
                                  | juce::FileBrowserComponent::canSelectFiles,
                                  [this] (const juce::FileChooser& chooser)
                                  {
                                      const auto file = chooser.getResult();
                                      if (file.existsAsFile()) processorRef.relinkSelectedAsset (file);
                                  });
    };
    importTake.onClick = [this]
    {
        fileChooser = std::make_unique<juce::FileChooser> ("Import a WAV as a take at bar " + importBar.getText(),
                                                           juce::File(), "*.wav");
        fileChooser->launchAsync (juce::FileBrowserComponent::openMode
                                  | juce::FileBrowserComponent::canSelectFiles,
                                  [this] (const juce::FileChooser& chooser)
                                  {
                                      const auto file = chooser.getResult();
                                      const auto bar = importBar.getText().getDoubleValue();
                                      if (file.existsAsFile()) processorRef.importTakeFromFile (file, bar > 0.0 ? bar : 1.0);
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

    const auto state = processorRef.stateSnapshot();
    prompt.setText (state.rack.prompt, false);
    reimagine.setRange (0.15, state.labEnabled ? 1.5 : 0.5, 0.01);
    reimagine.setValue (state.rack.reimagine, juce::dontSendNotification);
    seed.setText (juce::String (state.rack.seed), false);
    lab.setToggleState (state.labEnabled, juce::dontSendNotification);
    for (size_t i = 0; i < loraSlotIds.size() && i < state.rack.loras.size(); ++i)
    {
        loraSlotIds[i] = state.rack.loras[i].id;
        loraAmounts[i].setValue (state.rack.loras[i].scale * 100.0f,
                                 juce::dontSendNotification);
    }
    processorRef.refreshLoraCatalog();
    startTimerHz (10);
}

ReImagineEditor::~ReImagineEditor()
{
    setLookAndFeel (nullptr);
}

void ReImagineEditor::configureLabel (juce::Label& label, const juce::String& textValue,
                                      float size, bool heading)
{
    label.setText (textValue, juce::dontSendNotification);
    label.setFont (juce::FontOptions (size, heading ? juce::Font::bold : juce::Font::plain));
    label.setColour (juce::Label::textColourId, ReImagineLookAndFeel::muted());
    label.setJustificationType (juce::Justification::centredLeft);
    label.setInterceptsMouseClicks (false, false);
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
    for (size_t i = 0; i < loraSlotIds.size(); ++i)
        if (loraSlotIds[i].isNotEmpty())
            rack.loras.push_back ({ loraSlotIds[i],
                                    static_cast<float> (loraAmounts[i].getValue() / 100.0) });
    return rack;
}

void ReImagineEditor::commit()
{
    if (! syncingLoras)
        processorRef.commitRack (rackFromControls());
}

void ReImagineEditor::showLoraLoadingState()
{
    for (size_t slot = 0; slot < loraSelectors.size(); ++slot)
    {
        auto& selector = loraSelectors[slot];
        selector.clear (juce::dontSendNotification);
        selector.addItem ("Loading adapters...", 1);
        selector.setSelectedId (1, juce::dontSendNotification);
        selector.setEnabled (false);
        loraAmounts[slot].setEnabled (false);
    }
    loraInfo.setText ("Loading local adapters...", juce::dontSendNotification);
}

void ReImagineEditor::syncLoraCatalog (const LoraCatalogSnapshot& catalog)
{
    syncingLoras = true;
    if (catalog.status == LoraCatalogStatus::loading)
    {
        showLoraLoadingState();
        syncingLoras = false;
        return;
    }
    for (size_t slot = 0; slot < loraSelectors.size(); ++slot)
    {
        auto& selector = loraSelectors[slot];
        const auto desired = loraSlotIds[slot];
        selector.clear (juce::dontSendNotification);
        loraMenuIds[slot].clear();
        selector.addItem ("None", 1);
        loraMenuIds[slot].push_back ({});
        int selectedIndex = desired.isEmpty() ? 0 : -1;
        for (const auto& item : catalog.items)
        {
            auto menuText = item.displayName;
            if (item.isLab) menuText << " [Lab]";
            selector.addItem (menuText, selector.getNumItems() + 1);
            loraMenuIds[slot].push_back (item.id);
            if (item.id == desired)
                selectedIndex = selector.getNumItems() - 1;
        }
        if (desired.isNotEmpty() && selectedIndex < 0)
        {
            selector.addItem ("Missing - " + desired, selector.getNumItems() + 1);
            loraMenuIds[slot].push_back (desired);
            selectedIndex = selector.getNumItems() - 1;
        }
        selector.setSelectedItemIndex (juce::jmax (0, selectedIndex), juce::dontSendNotification);
        selector.setEnabled (catalog.status == LoraCatalogStatus::ready || desired.isNotEmpty());
        loraAmounts[slot].setEnabled (desired.isNotEmpty());
    }
    syncingLoras = false;
    if (catalog.status == LoraCatalogStatus::error)
        loraInfo.setText (catalog.error + " - use Refresh to try again", juce::dontSendNotification);
    else
        updateLoraInfo();
}

void ReImagineEditor::updateLoraInfo()
{
    const auto catalog = processorRef.loraCatalogSnapshot();
    juce::StringArray details;
    for (const auto& selected : loraSlotIds)
        if (selected.isNotEmpty())
        {
            bool found = false;
            for (const auto& item : catalog.items)
                if (item.id == selected)
                {
                    found = true;
                    auto detail = item.displayName;
                    if (item.trigger.isNotEmpty()) detail << " - trigger: " << item.trigger;
                    details.add (detail);
                }
            if (! found)
                details.add ("Missing - " + selected);
        }
    if (! details.isEmpty())
        loraInfo.setText (details.joinIntoString ("  |  "), juce::dontSendNotification);
    else if (catalog.status == LoraCatalogStatus::ready)
        loraInfo.setText (catalog.items.empty() ? "No compatible SA3 adapters found"
                                                : juce::String (catalog.items.size()) + " local adapters available",
                          juce::dontSendNotification);
}

void ReImagineEditor::timerCallback()
{
    status.setText (processorRef.statusText(), juce::dontSendNotification);
    progressValue = processorRef.progress();
    transfer.setButtonText (processorRef.transferActive() ? "Stop Transfer" : "Transfer");
    const auto overlap = processorRef.hasPendingOverlap();
    replace.setVisible (overlap);
    discard.setVisible (overlap);
    const auto catalog = processorRef.loraCatalogSnapshot();
    if (catalog.revision != knownLoraRevision)
    {
        knownLoraRevision = catalog.revision;
        syncLoraCatalog (catalog);
    }
    const auto state = processorRef.stateSnapshot();
    if (static_cast<int> (state.regions.size()) != knownRegionCount)
    {
        knownRegionCount = static_cast<int> (state.regions.size());
        regions.clear (juce::dontSendNotification);
        for (int i = 0; i < knownRegionCount; ++i)
        {
            const auto& region = state.regions[static_cast<size_t> (i)];
            regions.addItem ("Region " + juce::String (i + 1) + " - "
                             + juce::String (region.ppqStart, 2) + " to "
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
                takes.addItem ("Take " + juce::String (i + 1) + " - seed " + juce::String (take.seed), i + 1);
                if (take.id == found->selectedTakeId)
                    takes.setSelectedItemIndex (i, juce::dontSendNotification);
            }
    }
    repaint();
}

void ReImagineEditor::paint (juce::Graphics& g)
{
    g.fillAll (ReImagineLookAndFeel::background());
    juce::ColourGradient topRule (ReImagineLookAndFeel::accent(), 0.0f, 0.0f,
                                  ReImagineLookAndFeel::accent().withAlpha (0.15f),
                                  static_cast<float> (getWidth()), 0.0f, false);
    g.setGradientFill (topRule);
    g.fillRect (0, 0, getWidth(), 5);
    g.setColour (ReImagineLookAndFeel::text());
    g.setFont (juce::FontOptions (23.0f, juce::Font::bold));
    g.drawText ("MOSH RE-IMAGINE", 24, 17, 360, 32, juce::Justification::centredLeft);
    g.setColour (ReImagineLookAndFeel::muted());
    g.setFont (juce::FontOptions (12.5f));
    g.drawText ("Timeline-aware local audio transformation", 25, 48, 430, 20,
                juce::Justification::centredLeft);
    g.setColour (ReImagineLookAndFeel::panelRaised());
    g.fillRoundedRectangle (642.0f, 18.0f, 112.0f, 24.0f, 7.0f);
    g.setColour (ReImagineLookAndFeel::accent().withAlpha (0.7f));
    g.drawRoundedRectangle (642.5f, 18.5f, 111.0f, 23.0f, 7.0f, 1.0f);
    g.setColour (ReImagineLookAndFeel::text());
    g.setFont (juce::FontOptions (10.0f, juce::Font::bold));
    g.drawText ("LOCAL SA3", 650, 18, 96, 24, juce::Justification::centred);
    g.setColour (ReImagineLookAndFeel::muted());
    g.setFont (juce::FontOptions (10.0f));
    g.drawText ("VST3 / AUDIO EFFECT", 25, 68, 220, 14, juce::Justification::centredLeft);
    g.setColour (ReImagineLookAndFeel::panel());
    g.fillRoundedRectangle (20.0f, 84.0f, 740.0f, 548.0f, 10.0f);
    g.setColour (ReImagineLookAndFeel::border());
    g.drawRoundedRectangle (20.5f, 84.5f, 739.0f, 547.0f, 10.0f, 1.0f);
    g.setColour (ReImagineLookAndFeel::panelRaised());
    g.fillRoundedRectangle (27.0f, 94.0f, 726.0f, 38.0f, 8.0f);
    g.setColour (ReImagineLookAndFeel::panelInset());
    g.fillRoundedRectangle (27.0f, 143.0f, 516.0f, 483.0f, 8.0f);
    g.fillRoundedRectangle (560.0f, 143.0f, 193.0f, 483.0f, 8.0f);
    g.setColour (ReImagineLookAndFeel::border().withAlpha (0.65f));
    g.drawRoundedRectangle (27.5f, 143.5f, 515.0f, 482.0f, 8.0f, 1.0f);
    g.drawRoundedRectangle (560.5f, 143.5f, 192.0f, 482.0f, 8.0f, 1.0f);
    g.setColour (ReImagineLookAndFeel::muted());
    g.setFont (juce::FontOptions (9.5f, juce::Font::bold));
    g.drawText ("RACK / TRANSFORM", 34, 134, 200, 12, juce::Justification::centredLeft);
    g.drawText ("OUTPUT / MONITOR", 568, 134, 180, 12, juce::Justification::centredLeft);
    g.drawLine (552.0f, 146.0f, 552.0f, 616.0f, 1.0f);
    g.setColour (processorRef.transferActive() ? ReImagineLookAndFeel::accent()
                                                : ReImagineLookAndFeel::success());
    g.fillEllipse (31.0f, 651.0f, 8.0f, 8.0f);
}

void ReImagineEditor::resized()
{
    transfer.setBounds (28, 96, 116, 34);
    newTake.setBounds (152, 96, 88, 34);
    regions.setBounds (248, 96, 136, 34);
    takes.setBounds (392, 96, 104, 34);
    compare.setBounds (504, 96, 86, 34);
    reset.setBounds (598, 96, 72, 34);
    relink.setBounds (678, 96, 70, 34);
    // IMP-001 — second row under the transport strip: Import + the bar it lands on.
    importTake.setBounds (28, 134, 70, 22);
    importBar.setBounds (104, 134, 56, 22);

    promptLabel.setBounds (28, 154, 160, 18);
    prompt.setBounds (28, 175, 510, 66);
    reimagineLabel.setBounds (28, 250, 180, 18);
    reimagine.setBounds (92, 267, 446, 28);
    colorsLabel.setBounds (28, 304, 160, 18);
    for (size_t i = 0; i < colorNames.size(); ++i)
    {
        const auto y = 327 + static_cast<int> (i) * 39;
        colorNames[i].setBounds (28, y, 220, 30);
        colorAmounts[i].setBounds (260, y, 278, 30);
    }
    lorasLabel.setBounds (28, 448, 160, 18);
    refreshLoras.setBounds (458, 444, 80, 28);
    for (size_t i = 0; i < loraSelectors.size(); ++i)
    {
        const auto y = 476 + static_cast<int> (i) * 39;
        loraSelectors[i].setBounds (28, y, 292, 30);
        loraAmounts[i].setBounds (332, y, 206, 30);
    }
    loraInfo.setBounds (28, 595, 510, 28);

    mixLabel.setBounds (568, 154, 90, 18);
    mix.setBounds (606, 176, 104, 116);
    seedLabel.setBounds (568, 306, 100, 18);
    seed.setBounds (568, 328, 164, 32);
    lab.setBounds (568, 382, 164, 28);
    labHelp.setBounds (568, 412, 164, 48);
    replace.setBounds (568, 478, 164, 30);
    discard.setBounds (568, 516, 164, 30);
    status.setBounds (46, 642, 592, 26);
    progressBar.setBounds (646, 649, 102, 10);
}
}
