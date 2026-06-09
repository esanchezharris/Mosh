#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>

namespace
{
    class MoshTestToneProcessor final : public juce::AudioProcessor
    {
    public:
        MoshTestToneProcessor()
            : AudioProcessor (BusesProperties()
                  .withInput ("Input", juce::AudioChannelSet::stereo(), true)
                  .withOutput ("Output", juce::AudioChannelSet::stereo(), true))
        {
        }

        const juce::String getName() const override { return JucePlugin_Name; }
        bool acceptsMidi() const override { return false; }
        bool producesMidi() const override { return false; }
        bool isMidiEffect() const override { return false; }
        double getTailLengthSeconds() const override { return 0.0; }

        void prepareToPlay (double sampleRate, int samplesPerBlock) override
        {
            juce::ignoreUnused (sampleRate, samplesPerBlock);
        }

        void releaseResources() override {}

        bool isBusesLayoutSupported (const BusesLayout& layouts) const override
        {
            const auto output = layouts.getMainOutputChannelSet();
            if (output != juce::AudioChannelSet::mono() && output != juce::AudioChannelSet::stereo())
                return false;

            return output == layouts.getMainInputChannelSet();
        }

        void processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override
        {
            juce::ignoreUnused (midi);
            juce::ScopedNoDenormals noDenormals;

            const auto inputChannels = getTotalNumInputChannels();
            const auto outputChannels = getTotalNumOutputChannels();

            for (auto channel = inputChannels; channel < outputChannels; ++channel)
                buffer.clear (channel, 0, buffer.getNumSamples());

            for (auto channel = 0; channel < inputChannels; ++channel)
                buffer.applyGain (channel, 0, buffer.getNumSamples(), 0.5f);
        }

        using AudioProcessor::processBlock;

        juce::AudioProcessorEditor* createEditor() override
        {
            class Editor final : public juce::AudioProcessorEditor
            {
            public:
                explicit Editor (juce::AudioProcessor& processor)
                    : juce::AudioProcessorEditor (&processor)
                {
                    setSize (360, 160);
                }

                void paint (juce::Graphics& g) override
                {
                    g.fillAll (juce::Colour::fromRGB (18, 20, 22));
                    g.setColour (juce::Colour::fromRGB (86, 205, 168));
                    g.fillRect (0, 0, getWidth(), 6);

                    g.setColour (juce::Colours::white);
                    g.setFont (juce::FontOptions (22.0f, juce::Font::bold));
                    g.drawText ("MOSH Test Tone", getLocalBounds().reduced (22, 22), juce::Justification::centredTop);

                    g.setColour (juce::Colour::fromRGB (185, 190, 195));
                    g.setFont (juce::FontOptions (14.0f));
                    g.drawText ("VST3 fixture - deterministic 0.5x gain",
                                getLocalBounds().reduced (22, 64),
                                juce::Justification::centredTop);
                }

            private:
                JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (Editor)
            };

            return new Editor (*this);
        }

        bool hasEditor() const override { return true; }

        int getNumPrograms() override { return 1; }
        int getCurrentProgram() override { return 0; }
        void setCurrentProgram (int index) override { juce::ignoreUnused (index); }
        const juce::String getProgramName (int index) override
        {
            juce::ignoreUnused (index);
            return "Default";
        }
        void changeProgramName (int index, const juce::String& newName) override
        {
            juce::ignoreUnused (index, newName);
        }

        void getStateInformation (juce::MemoryBlock& destData) override
        {
            const auto state = juce::String ("mosh-test-tone-v1");
            destData.replaceAll (state.toRawUTF8(), state.getNumBytesAsUTF8());
        }

        void setStateInformation (const void* data, int sizeInBytes) override
        {
            juce::ignoreUnused (data, sizeInBytes);
        }

    private:
        JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MoshTestToneProcessor)
    };
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new MoshTestToneProcessor();
}
