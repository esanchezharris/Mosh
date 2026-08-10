#include "Vst3ScanWorker.h"

#include <juce_audio_processors/juce_audio_processors.h>
#include <pluginterfaces/vst/ivstaudioprocessor.h>
#include <public.sdk/source/vst/hosting/module.h>

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace mosh
{
namespace
{

template <typename Range>
int hashForRange (const Range& range) noexcept
{
    std::uint32_t value = 0;
    for (const auto& item : range)
        value = (value * 31u) + static_cast<std::uint32_t> (item);
    return static_cast<int> (value);
}

std::array<Steinberg::uint32, 4> normalisedUid (const VST3::UID& uid) noexcept
{
    const Steinberg::FUID fuid (uid.data());
    return { fuid.getLong1(), fuid.getLong2(), fuid.getLong3(), fuid.getLong4() };
}

juce::String fromUtf8 (const std::string& value)
{
    return juce::String::fromUTF8 (value.data(), static_cast<int> (value.size()));
}

std::vector<juce::PluginDescription> readFactoryDescriptions (const juce::File& pluginBundle,
                                                              std::string& error)
{
    auto module = VST3::Hosting::Module::create (
        pluginBundle.getFullPathName().toStdString(), error);
    if (module == nullptr)
        return {};
    error.clear();

    std::vector<juce::PluginDescription> descriptions;
    juce::StringArray names;

    for (const auto& info : module->getFactory().classInfos())
    {
        if (info.category() != kVstAudioEffectClass)
            continue;

        const auto name = fromUtf8 (info.name()).trim();
        if (name.isEmpty() || names.contains (name, true))
            continue;
        names.add (name);

        juce::PluginDescription description;
        description.fileOrIdentifier = pluginBundle.getFullPathName();
        description.lastFileModTime = pluginBundle.getLastModificationTime();
        description.lastInfoUpdateTime = juce::Time::getCurrentTime();
        description.manufacturerName = fromUtf8 (info.vendor()).trim();
        description.name = name;
        description.descriptiveName = name;
        description.pluginFormatName = "VST3";
        description.numInputChannels = 0;
        description.numOutputChannels = 0;
        description.version = fromUtf8 (info.version()).trim();
        description.deprecatedUid = hashForRange (info.ID().data());
        description.uniqueId = hashForRange (normalisedUid (info.ID()));

        juce::StringArray categories;
        bool isInstrument = false;
        for (const auto& category : info.subCategories())
        {
            categories.add (fromUtf8 (category));
            isInstrument = isInstrument || category == Steinberg::Vst::PlugType::kInstrument;
        }
        description.category = categories.joinIntoString ("|");
        description.isInstrument = isInstrument;

        if (description.uniqueId != 0)
            descriptions.push_back (std::move (description));
    }

    return descriptions;
}

} // namespace

int runVst3ScanWorker (const juce::StringArray& args)
{
    const auto request = parseVst3ScanWorkerRequest (args);
    if (! request.valid)
        return 2;
    if ((! request.pluginBundle.exists() && ! request.pluginBundle.existsAsFile())
        || ! request.pluginBundle.hasFileExtension ("vst3"))
        return 3;
    if (! request.outputXml.getParentDirectory().isDirectory())
        return 4;

    std::string error;
    const auto found = readFactoryDescriptions (request.pluginBundle, error);
    if (! error.empty())
        return 5;

    juce::XmlElement result (kVst3ScanResultTag);
    for (const auto& description : found)
        if (auto xml = description.createXml())
            result.addChildElement (xml.release());

    return result.writeTo (request.outputXml) ? 0 : 6;
}

Vst3ScanChildResult scanVst3InChild (const juce::File& pluginBundle, int timeoutMs)
{
    const auto outputXml = juce::File::createTempFile ("mosh-vst3-scan.xml");
    outputXml.deleteFile();

    struct TempFileCleanup
    {
        juce::File file;
        ~TempFileCleanup() { file.deleteFile(); }
    } cleanup { outputXml };

    juce::StringArray command {
        juce::File::getSpecialLocation (juce::File::currentExecutableFile)
            .getFullPathName(),
        kVst3ScanWorkerFlag,
        pluginBundle.getFullPathName(),
        outputXml.getFullPathName(),
    };

    juce::ChildProcess process;
    if (! process.start (command, 0))
        return { Vst3ScanOutcome::launchFailed, {} };

    if (! process.waitForProcessToFinish (juce::jmax (1, timeoutMs)))
    {
        process.kill();
        process.waitForProcessToFinish (2000);
        return { Vst3ScanOutcome::timedOut, {} };
    }

    if (process.getExitCode() != 0)
        return { Vst3ScanOutcome::crashed, {} };

    auto xml = juce::parseXML (outputXml);
    if (xml == nullptr || ! xml->hasTagName (kVst3ScanResultTag))
        return { Vst3ScanOutcome::invalidOutput, {} };

    return { Vst3ScanOutcome::completed, std::move (xml) };
}

} // namespace mosh
