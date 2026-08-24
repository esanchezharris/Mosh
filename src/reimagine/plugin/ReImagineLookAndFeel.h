#pragma once

#include <juce_gui_extra/juce_gui_extra.h>

namespace mosh::reimagine
{
class ReImagineLookAndFeel final : public juce::LookAndFeel_V4
{
public:
    ReImagineLookAndFeel();

    juce::Font getTextButtonFont (juce::TextButton&, int) override;
    juce::Font getComboBoxFont (juce::ComboBox&) override;
    juce::Font getLabelFont (juce::Label&) override;
    juce::Font getPopupMenuFont() override;
    void drawButtonBackground (juce::Graphics&, juce::Button&, const juce::Colour&,
                               bool highlighted, bool down) override;
    void drawButtonText (juce::Graphics&, juce::TextButton&, bool highlighted, bool down) override;
    void drawComboBox (juce::Graphics&, int width, int height, bool down,
                       int buttonX, int buttonY, int buttonW, int buttonH,
                       juce::ComboBox&) override;
    void positionComboBoxText (juce::ComboBox&, juce::Label&) override;
    void drawLinearSlider (juce::Graphics&, int x, int y, int width, int height,
                           float sliderPos, float minPos, float maxPos,
                           juce::Slider::SliderStyle, juce::Slider&) override;
    void drawRotarySlider (juce::Graphics&, int x, int y, int width, int height,
                           float sliderPos, float startAngle, float endAngle,
                           juce::Slider&) override;
    void drawToggleButton (juce::Graphics&, juce::ToggleButton&,
                           bool highlighted, bool down) override;
    void drawProgressBar (juce::Graphics&, juce::ProgressBar&, int width, int height,
                          double progress, const juce::String& text) override;

    static juce::Colour background() { return juce::Colour::fromRGB (15, 17, 22); }
    static juce::Colour panel() { return juce::Colour::fromRGB (25, 28, 36); }
    static juce::Colour panelRaised() { return juce::Colour::fromRGB (29, 33, 43); }
    static juce::Colour panelInset() { return juce::Colour::fromRGB (21, 24, 31); }
    static juce::Colour field() { return juce::Colour::fromRGB (34, 38, 49); }
    static juce::Colour border() { return juce::Colour::fromRGB (57, 63, 79); }
    static juce::Colour text() { return juce::Colour::fromRGB (241, 243, 248); }
    static juce::Colour muted() { return juce::Colour::fromRGB (160, 168, 185); }
    static juce::Colour accent() { return juce::Colour::fromRGB (137, 106, 255); }
    static juce::Colour success() { return juce::Colour::fromRGB (91, 211, 154); }
};
}
