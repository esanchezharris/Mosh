#include "ReImagineEditor.h"

#include <cmath>
#include <iostream>

int main (int argc, char** argv)
{
    if (argc != 2)
    {
        std::cerr << "usage: MoshReImagineEditorSmoke <editor.png>\n";
        return 2;
    }
    juce::ScopedJuceInitialiser_GUI juce;
    mosh::reimagine::ReImagineProcessor processor;
    const auto missingLora = juce::SystemStats::getEnvironmentVariable (
        "MOSH_REIMAGINE_EDITOR_MISSING_LORA", {});
    if (missingLora.isNotEmpty())
    {
        mosh::reimagine::PluginStateV1 state;
        state.rack.loras.push_back ({ missingLora, 0.75f });
        const auto json = mosh::reimagine::serializeState (state);
        processor.setStateInformation (json.toRawUTF8(), static_cast<int> (json.getNumBytesAsUTF8()));
    }
    mosh::reimagine::ReImagineEditor editor (processor);
    editor.resized();
    auto* refresh = dynamic_cast<juce::TextButton*> (editor.findChildWithID ("refresh-loras"));
    auto* loraInfo = dynamic_cast<juce::Label*> (editor.findChildWithID ("lora-info"));
    if (refresh == nullptr || loraInfo == nullptr)
    {
        std::cerr << "LoRA refresh surface is incomplete\n";
        return 3;
    }
    std::array<double, 3> originalStrengths {};
    for (int slot = 1; slot <= 3; ++slot)
    {
        auto* selector = dynamic_cast<juce::ComboBox*> (
            editor.findChildWithID ("lora-slot-" + juce::String (slot)));
        auto* strength = dynamic_cast<juce::Slider*> (
            editor.findChildWithID ("lora-strength-" + juce::String (slot)));
        if (selector == nullptr || strength == nullptr)
        {
            std::cerr << "LoRA slot " << slot << " is not a dropdown plus strength control\n";
            return 4;
        }
        selector->clear (juce::dontSendNotification);
        selector->addItem ("Stale adapter " + juce::String (slot), 1);
        selector->setSelectedId (1, juce::dontSendNotification);
        selector->setEnabled (true);
        originalStrengths[static_cast<size_t> (slot - 1)] = strength->getValue();
        strength->setValue (20.0 * slot + 5.0, juce::dontSendNotification);
        strength->setEnabled (true);
    }
    loraInfo->setText ("stale adapter details", juce::dontSendNotification);
    refresh->onClick();
    for (int slot = 1; slot <= 3; ++slot)
    {
        auto* selector = dynamic_cast<juce::ComboBox*> (
            editor.findChildWithID ("lora-slot-" + juce::String (slot)));
        auto* strength = dynamic_cast<juce::Slider*> (
            editor.findChildWithID ("lora-strength-" + juce::String (slot)));
        if (selector == nullptr || strength == nullptr || selector->isEnabled()
            || selector->getText() != "Loading adapters..." || strength->isEnabled()
            || std::abs (strength->getValue() - (20.0 * slot + 5.0)) > 0.001)
        {
            std::cerr << "LoRA refresh did not reset slot " << slot << " to loading\n";
            return 5;
        }
    }
    if (loraInfo->getText() != "Loading local adapters...")
    {
        std::cerr << "LoRA refresh left stale catalog copy visible\n";
        return 6;
    }
    if (juce::SystemStats::getEnvironmentVariable (
            "MOSH_REIMAGINE_EDITOR_CAPTURE_REFRESH_VALUES", "0") != "1")
        for (int slot = 1; slot <= 3; ++slot)
            if (auto* strength = dynamic_cast<juce::Slider*> (
                    editor.findChildWithID ("lora-strength-" + juce::String (slot))))
                strength->setValue (originalStrengths[static_cast<size_t> (slot - 1)],
                                    juce::dontSendNotification);
    const auto waitMs = juce::SystemStats::getEnvironmentVariable (
        "MOSH_REIMAGINE_EDITOR_WAIT_MS", "0").getIntValue();
    if (waitMs > 0)
    {
        juce::Thread::sleep (waitMs);
        juce::Timer::callPendingTimersSynchronously();
    }
    for (int slot = 1; slot <= 3; ++slot)
    {
        auto* selector = editor.findChildWithID ("lora-slot-" + juce::String (slot));
        auto* strength = editor.findChildWithID ("lora-strength-" + juce::String (slot));
        if (dynamic_cast<juce::ComboBox*> (selector) == nullptr
            || dynamic_cast<juce::Slider*> (strength) == nullptr)
        {
            std::cerr << "LoRA slot " << slot << " is not a dropdown plus strength control\n";
            return 7;
        }
    }
    if (juce::SystemStats::getEnvironmentVariable (
            "MOSH_REIMAGINE_EDITOR_SELECT_FIRST", "0") == "1")
    {
        if (auto* selector = dynamic_cast<juce::ComboBox*> (
                editor.findChildWithID ("lora-slot-1")))
            selector->setSelectedItemIndex (1, juce::sendNotificationSync);
    }
    const auto image = editor.createComponentSnapshot (editor.getLocalBounds());
    juce::Image::BitmapData pixels (image, juce::Image::BitmapData::readOnly);
    int nonBackgroundPixels = 0;
    const auto background = mosh::reimagine::ReImagineLookAndFeel::background();
    for (int y = 0; y < image.getHeight(); y += 4)
        for (int x = 0; x < image.getWidth(); x += 4)
            if (pixels.getPixelColour (x, y) != background)
                ++nonBackgroundPixels;
    if (nonBackgroundPixels < 500)
    {
        std::cerr << "editor screenshot is blank or incompletely composited\n";
        return 8;
    }
    auto outputFile = juce::File::isAbsolutePath (argv[1])
                        ? juce::File (argv[1])
                        : juce::File::getCurrentWorkingDirectory().getChildFile (argv[1]);
    auto output = outputFile.createOutputStream();
    juce::PNGImageFormat png;
    if (! output || ! png.writeImageToStream (image, *output))
    {
        std::cerr << "editor screenshot write failed\n";
        return 9;
    }
    std::cout << "Mosh Re-Imagine native editor controls and screenshot passed\n";
    return 0;
}
