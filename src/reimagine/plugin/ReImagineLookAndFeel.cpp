#include "ReImagineLookAndFeel.h"

namespace mosh::reimagine
{
ReImagineLookAndFeel::ReImagineLookAndFeel()
{
    setColour (juce::TextEditor::backgroundColourId, field());
    setColour (juce::TextEditor::textColourId, text());
    setColour (juce::TextEditor::highlightColourId, accent().withAlpha (0.45f));
    setColour (juce::TextEditor::outlineColourId, border());
    setColour (juce::TextEditor::focusedOutlineColourId, accent());
    setColour (juce::ComboBox::backgroundColourId, field());
    setColour (juce::ComboBox::textColourId, text());
    setColour (juce::ComboBox::outlineColourId, border());
    setColour (juce::ComboBox::arrowColourId, muted());
    setColour (juce::PopupMenu::backgroundColourId, panel());
    setColour (juce::PopupMenu::textColourId, text());
    setColour (juce::PopupMenu::highlightedBackgroundColourId, accent().withAlpha (0.75f));
    setColour (juce::PopupMenu::highlightedTextColourId, text());
    setColour (juce::Slider::textBoxTextColourId, text());
    setColour (juce::Slider::textBoxBackgroundColourId, field());
    setColour (juce::Slider::textBoxOutlineColourId, border());
}

juce::Font ReImagineLookAndFeel::getTextButtonFont (juce::TextButton&, int)
{
    return juce::Font (juce::FontOptions (13.0f, juce::Font::bold));
}

juce::Font ReImagineLookAndFeel::getComboBoxFont (juce::ComboBox&)
{
    return juce::Font (juce::FontOptions (13.0f));
}

juce::Font ReImagineLookAndFeel::getLabelFont (juce::Label& label)
{
    return label.getFont();
}

juce::Font ReImagineLookAndFeel::getPopupMenuFont()
{
    return juce::Font (juce::FontOptions (13.0f));
}

void ReImagineLookAndFeel::drawButtonBackground (juce::Graphics& g, juce::Button& button,
                                                  const juce::Colour&, bool highlighted, bool down)
{
    auto colour = button.getToggleState() || button.getComponentID() == "primary" ? accent() : field();
    if (! button.isEnabled()) colour = field().withAlpha (0.45f);
    else if (down) colour = colour.brighter (0.12f);
    else if (highlighted) colour = colour.brighter (0.07f);
    auto bounds = button.getLocalBounds().toFloat().reduced (0.5f);
    g.setColour (colour);
    g.fillRoundedRectangle (bounds, 6.0f);
    g.setColour (button.hasKeyboardFocus (true) ? accent() : border());
    g.drawRoundedRectangle (bounds, 6.0f, button.hasKeyboardFocus (true) ? 1.5f : 1.0f);
}

void ReImagineLookAndFeel::drawButtonText (juce::Graphics& g, juce::TextButton& button,
                                            bool, bool)
{
    g.setFont (getTextButtonFont (button, button.getHeight()));
    g.setColour (button.isEnabled() ? text() : muted().withAlpha (0.55f));
    g.drawFittedText (button.getButtonText(), button.getLocalBounds().reduced (8, 2),
                      juce::Justification::centred, 1);
}

void ReImagineLookAndFeel::drawComboBox (juce::Graphics& g, int width, int height, bool down,
                                         int, int, int, int, juce::ComboBox& box)
{
    auto bounds = juce::Rectangle<float> (0.5f, 0.5f, static_cast<float> (width - 1),
                                          static_cast<float> (height - 1));
    g.setColour (down ? field().brighter (0.08f) : field());
    g.fillRoundedRectangle (bounds, 5.0f);
    g.setColour (box.hasKeyboardFocus (true) ? accent() : border());
    g.drawRoundedRectangle (bounds, 5.0f, box.hasKeyboardFocus (true) ? 1.5f : 1.0f);
    const auto cx = static_cast<float> (width - 16);
    const auto cy = static_cast<float> (height) * 0.5f;
    juce::Path arrow;
    arrow.startNewSubPath (cx - 4.0f, cy - 2.0f);
    arrow.lineTo (cx, cy + 2.0f);
    arrow.lineTo (cx + 4.0f, cy - 2.0f);
    g.setColour (muted());
    g.strokePath (arrow, juce::PathStrokeType (1.5f));
}

void ReImagineLookAndFeel::positionComboBoxText (juce::ComboBox& box, juce::Label& label)
{
    label.setBounds (10, 1, box.getWidth() - 34, box.getHeight() - 2);
    label.setFont (getComboBoxFont (box));
}

void ReImagineLookAndFeel::drawLinearSlider (juce::Graphics& g, int x, int y, int width, int height,
                                              float sliderPos, float, float,
                                              juce::Slider::SliderStyle, juce::Slider& slider)
{
    const auto cy = static_cast<float> (y + height / 2);
    const auto left = static_cast<float> (x + 5);
    const auto right = static_cast<float> (x + width - 5);
    const auto enabled = slider.isEnabled();
    g.setColour (enabled ? border() : border().withAlpha (0.45f));
    g.fillRoundedRectangle (left, cy - 2.0f, right - left, 4.0f, 2.0f);
    g.setColour (enabled ? accent() : muted().withAlpha (0.35f));
    g.fillRoundedRectangle (left, cy - 2.0f, juce::jmax (0.0f, sliderPos - left), 4.0f, 2.0f);
    g.setColour (enabled ? text() : muted().withAlpha (0.65f));
    g.fillEllipse (sliderPos - 6.0f, cy - 6.0f, 12.0f, 12.0f);
}

void ReImagineLookAndFeel::drawRotarySlider (juce::Graphics& g, int x, int y, int width, int height,
                                              float sliderPos, float startAngle, float endAngle,
                                              juce::Slider& slider)
{
    auto bounds = juce::Rectangle<float> (static_cast<float> (x), static_cast<float> (y),
                                           static_cast<float> (width), static_cast<float> (height)).reduced (8.0f);
    const auto radius = juce::jmin (bounds.getWidth(), bounds.getHeight()) * 0.5f;
    const auto centre = bounds.getCentre();
    const auto angle = startAngle + sliderPos * (endAngle - startAngle);
    juce::Path track;
    track.addCentredArc (centre.x, centre.y, radius, radius, 0.0f, startAngle, endAngle, true);
    const auto enabled = slider.isEnabled();
    g.setColour (enabled ? border() : border().withAlpha (0.45f));
    g.strokePath (track, juce::PathStrokeType (5.0f, juce::PathStrokeType::curved));
    juce::Path value;
    value.addCentredArc (centre.x, centre.y, radius, radius, 0.0f, startAngle, angle, true);
    g.setColour (enabled ? accent() : muted().withAlpha (0.35f));
    g.strokePath (value, juce::PathStrokeType (5.0f, juce::PathStrokeType::curved));
}

void ReImagineLookAndFeel::drawToggleButton (juce::Graphics& g, juce::ToggleButton& button,
                                              bool, bool)
{
    const auto box = juce::Rectangle<float> (2.0f,
        (static_cast<float> (button.getHeight()) - 16.0f) * 0.5f, 16.0f, 16.0f);
    g.setColour (button.getToggleState() ? accent() : field());
    g.fillRoundedRectangle (box, 4.0f);
    g.setColour (button.getToggleState() ? accent() : border());
    g.drawRoundedRectangle (box, 4.0f, 1.0f);
    if (button.getToggleState())
    {
        g.setColour (text());
        g.drawLine (6.0f, box.getCentreY(), 9.0f, box.getBottom() - 4.0f, 1.5f);
        g.drawLine (9.0f, box.getBottom() - 4.0f, 15.0f, box.getY() + 4.0f, 1.5f);
    }
    g.setColour (button.isEnabled() ? text() : muted());
    g.setFont (juce::FontOptions (12.0f));
    g.drawFittedText (button.getButtonText(), 25, 0, button.getWidth() - 25, button.getHeight(),
                      juce::Justification::centredLeft, 2);
}

void ReImagineLookAndFeel::drawProgressBar (juce::Graphics& g, juce::ProgressBar&, int width,
                                            int height, double progress, const juce::String&)
{
    auto bounds = juce::Rectangle<float> (0.0f, 0.0f, static_cast<float> (width),
                                           static_cast<float> (height));
    g.setColour (field());
    g.fillRoundedRectangle (bounds, 3.0f);
    if (progress >= 0.0)
    {
        g.setColour (accent());
        g.fillRoundedRectangle (bounds.withWidth (bounds.getWidth() * static_cast<float> (progress)), 3.0f);
    }
}
}
