#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_audio_utils/juce_audio_utils.h>

#include <iostream>

namespace
{
class FakePlayHead final : public juce::AudioPlayHead
{
public:
    juce::Optional<PositionInfo> getPosition() const override
    {
        PositionInfo info;
        info.setIsPlaying (true);
        info.setTimeInSamples (0);
        info.setPpqPosition (0.0);
        info.setBpm (120.0);
        TimeSignature signature;
        signature.numerator = 4;
        signature.denominator = 4;
        info.setTimeSignature (signature);
        return info;
    }
};
}

int main (int argc, char** argv)
{
    if (argc != 2)
    {
        std::cerr << "usage: MoshReImagineBundleSmoke <plugin.vst3>\n";
        return 2;
    }
    juce::ScopedJuceInitialiser_GUI juce;
    const auto bundle = juce::File (argv[1]);
    juce::ChildProcess plist;
    if (! plist.start (juce::StringArray { "/usr/bin/plutil", "-extract", "CFBundleIdentifier",
                                           "raw", "-o", "-",
                                           bundle.getChildFile ("Contents/Info.plist").getFullPathName() })
        || plist.readAllProcessOutput().trim() != "studio.mosh.reimagine")
    {
        std::cerr << "bundle identifier smoke failed\n";
        return 3;
    }
    const auto executable = bundle.getChildFile ("Contents/MacOS/Mosh Re-Imagine");
    juce::ChildProcess lipo;
    if (! lipo.start (juce::StringArray { "/usr/bin/lipo", "-archs", executable.getFullPathName() })
        || lipo.readAllProcessOutput().trim() != "arm64")
    {
        std::cerr << "bundle is not native arm64\n";
        return 3;
    }
    juce::VST3PluginFormat format;
    juce::OwnedArray<juce::PluginDescription> descriptions;
    format.findAllTypesForFile (descriptions, argv[1]);
    if (descriptions.isEmpty())
    {
        std::cerr << "VST3 scan found no plug-in type\n";
        return 3;
    }
    juce::String error;
    auto instance = format.createInstanceFromDescription (*descriptions[0], 48000.0, 512, error);
    if (! instance)
    {
        std::cerr << "VST3 instantiate failed: " << error << "\n";
        return 4;
    }
    int userParameters = 0;
    for (auto* parameter : instance->getParameters())
        if (! parameter->getName (64).containsIgnoreCase ("bypass"))
            ++userParameters;
    if (instance->getName() != "Mosh Re-Imagine" || userParameters != 1
        || instance->getParameters()[0]->getName (64) != "Mix")
    {
        std::cerr << "unexpected identity or host parameter count: name="
                  << instance->getName() << " params=" << instance->getParameters().size()
                  << " userParams=" << userParameters << "\n";
        for (auto* parameter : instance->getParameters())
            std::cerr << "parameter: " << parameter->getName (64) << "\n";
        return 5;
    }
    instance->setBusesLayout ({ { juce::AudioChannelSet::stereo() },
                                { juce::AudioChannelSet::stereo() } });
    instance->prepareToPlay (48000.0, 512);
    FakePlayHead playHead;
    instance->setPlayHead (&playHead);
    juce::AudioBuffer<float> audio (2, 512);
    audio.clear();
    audio.setSample (0, 0, 0.25f);
    audio.setSample (1, 0, -0.25f);
    juce::MidiBuffer midi;
    instance->processBlock (audio, midi);
    if (audio.getSample (0, 0) != 0.25f || audio.getSample (1, 0) != -0.25f)
    {
        std::cerr << "dry-through smoke failed\n";
        return 6;
    }
    std::unique_ptr<juce::AudioProcessorEditor> editor (instance->createEditorIfNeeded());
    if (! editor || editor->getWidth() <= 0 || editor->getHeight() <= 0)
    {
        std::cerr << "editor smoke failed\n";
        return 7;
    }
    juce::MemoryBlock before;
    instance->getStateInformation (before);
    instance->setStateInformation (before.getData(), static_cast<int> (before.getSize()));
    juce::MemoryBlock after;
    instance->getStateInformation (after);
    if (before != after)
    {
        std::cerr << "state round-trip failed\n";
        return 8;
    }
    auto second = format.createInstanceFromDescription (*descriptions[0], 44100.0, 256, error);
    if (! second)
    {
        std::cerr << "second instance failed: " << error << "\n";
        return 9;
    }
    if (! second->setBusesLayout ({ { juce::AudioChannelSet::mono() },
                                    { juce::AudioChannelSet::mono() } }))
    {
        std::cerr << "mono layout rejected\n";
        return 10;
    }
    second->prepareToPlay (44100.0, 256);
    second->setPlayHead (&playHead);
    juce::AudioBuffer<float> mono (1, 256);
    mono.clear();
    mono.setSample (0, 0, 0.5f);
    second->processBlock (mono, midi);
    if (mono.getSample (0, 0) != 0.5f)
    {
        std::cerr << "mono 44.1k dry-through failed\n";
        return 11;
    }
    std::cout << "Mosh Re-Imagine VST3 scan/load/editor/dry/state smoke passed\n";
    return 0;
}
