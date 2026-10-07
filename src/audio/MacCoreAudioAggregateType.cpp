#include "CombinedAudioDevice.h"

#if JUCE_MAC

#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <unistd.h>

#include <atomic>
#include <iostream>
#include <optional>
#include <vector>

// See CombinedAudioDevice.h for why this exists. This file is the CoreAudio half: find
// the two devices the user picked, ask the HAL for a private aggregate of them, open it
// through JUCE's ordinary single-device path, and wrap it in a CombinedDeviceProxy.
// Anything that goes wrong falls back to JUCE's own two-device path, so the worst case
// is exactly the behaviour before this file existed.

namespace mosh::audio
{
namespace
{
    constexpr AudioObjectPropertyElement kMain = kAudioObjectPropertyElementMain;

    struct DeviceInfo
    {
        AudioDeviceID id = 0;
        juce::String name, uid;
        int numInputs = 0, numOutputs = 0;
    };

    juce::String stringProperty (AudioObjectID object, AudioObjectPropertySelector selector)
    {
        AudioObjectPropertyAddress address { selector, kAudioObjectPropertyScopeGlobal, kMain };
        CFStringRef value = nullptr;
        UInt32 size = sizeof (value);
        if (AudioObjectGetPropertyData (object, &address, 0, nullptr, &size, &value) != noErr || value == nullptr)
            return {};
        const auto result = juce::String::fromCFString (value);
        CFRelease (value);
        return result;
    }

    int channelCount (AudioDeviceID device, bool input)
    {
        AudioObjectPropertyAddress address { kAudioDevicePropertyStreamConfiguration,
                                             input ? kAudioObjectPropertyScopeInput : kAudioObjectPropertyScopeOutput, kMain };
        UInt32 size = 0;
        if (AudioObjectGetPropertyDataSize (device, &address, 0, nullptr, &size) != noErr || size == 0)
            return 0;
        juce::HeapBlock<char> storage (size);
        auto* list = reinterpret_cast<AudioBufferList*> (storage.getData());
        if (AudioObjectGetPropertyData (device, &address, 0, nullptr, &size, list) != noErr)
            return 0;
        int channels = 0;
        for (UInt32 i = 0; i < list->mNumberBuffers; ++i)
            channels += (int) list->mBuffers[i].mNumberChannels;
        return channels;
    }

    std::vector<AudioDeviceID> allDeviceIDs()
    {
        AudioObjectPropertyAddress address { kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal, kMain };
        UInt32 size = 0;
        if (AudioObjectGetPropertyDataSize (kAudioObjectSystemObject, &address, 0, nullptr, &size) != noErr || size == 0)
            return {};
        std::vector<AudioDeviceID> ids (size / sizeof (AudioDeviceID));
        if (AudioObjectGetPropertyData (kAudioObjectSystemObject, &address, 0, nullptr, &size, ids.data()) != noErr)
            return {};
        ids.resize (size / sizeof (AudioDeviceID));
        return ids;
    }

    // The devices in the HAL's own order, which is the order JUCE scans them in.
    std::vector<DeviceInfo> enumerateDevices()
    {
        std::vector<DeviceInfo> devices;
        for (const auto id : allDeviceIDs())
        {
            DeviceInfo info;
            info.id = id;
            info.name = stringProperty (id, kAudioDevicePropertyDeviceNameCFString);
            info.uid = stringProperty (id, kAudioDevicePropertyDeviceUID);
            info.numInputs = channelCount (id, true);
            info.numOutputs = channelCount (id, false);
            if (info.name.isNotEmpty())
                devices.push_back (std::move (info));
        }
        return devices;
    }

    // JUCE lists input and output names separately and numbers duplicates within each
    // list; the same rule here resolves the name JUCE showed back to one device.
    std::optional<DeviceInfo> findByListedName (const std::vector<DeviceInfo>& devices, const juce::String& listedName, bool input)
    {
        juce::StringArray names;
        std::vector<const DeviceInfo*> owners;
        for (const auto& d : devices)
            if ((input ? d.numInputs : d.numOutputs) > 0)
            {
                names.add (d.name);
                owners.push_back (&d);
            }
        names.appendNumbersToDuplicates (false, true);
        const int index = names.indexOf (listedName);
        if (index < 0)
            return {};
        return *owners[(size_t) index];
    }

    void setString (CFMutableDictionaryRef dictionary, CFStringRef key, const juce::String& value)
    {
        const auto cf = value.toCFString();
        CFDictionarySetValue (dictionary, key, cf);
        CFRelease (cf);
    }

    void setInt (CFMutableDictionaryRef dictionary, CFStringRef key, int value)
    {
        const auto number = CFNumberCreate (kCFAllocatorDefault, kCFNumberIntType, &value);
        CFDictionarySetValue (dictionary, key, number);
        CFRelease (number);
    }

    CFMutableDictionaryRef newDictionary()
    {
        return CFDictionaryCreateMutable (kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    }

    // A private aggregate: output device first (it is the clock, and its channels lead),
    // input device second with drift compensation against it.
    AudioDeviceID createPrivateAggregate (const DeviceInfo& output, const DeviceInfo& input, const juce::String& name)
    {
        static std::atomic<int> serial { 0 };
        const auto uid = "studio.mosh.aggregate." + juce::String ((int) getpid()) + "." + juce::String (++serial);

        auto description = newDictionary();
        setString (description, CFSTR (kAudioAggregateDeviceNameKey), name);
        setString (description, CFSTR (kAudioAggregateDeviceUIDKey), uid);
        setInt (description, CFSTR (kAudioAggregateDeviceIsPrivateKey), 1);
        setInt (description, CFSTR (kAudioAggregateDeviceIsStackedKey), 0);
        // Renamed ...MainSubDeviceKey in macOS 12; the deployment target is 11 and the
        // value is the same string.
        JUCE_BEGIN_IGNORE_WARNINGS_GCC_LIKE ("-Wdeprecated-declarations")
        setString (description, CFSTR (kAudioAggregateDeviceMasterSubDeviceKey), output.uid);
        JUCE_END_IGNORE_WARNINGS_GCC_LIKE

        auto outputEntry = newDictionary();
        setString (outputEntry, CFSTR (kAudioSubDeviceUIDKey), output.uid);
        auto inputEntry = newDictionary();
        setString (inputEntry, CFSTR (kAudioSubDeviceUIDKey), input.uid);
        setInt (inputEntry, CFSTR (kAudioSubDeviceDriftCompensationKey), 1);

        const void* entries[] = { outputEntry, inputEntry };
        auto list = CFArrayCreate (kCFAllocatorDefault, entries, 2, &kCFTypeArrayCallBacks);
        CFDictionarySetValue (description, CFSTR (kAudioAggregateDeviceSubDeviceListKey), list);

        AudioDeviceID aggregate = 0;
        const auto status = AudioHardwareCreateAggregateDevice (description, &aggregate);

        CFRelease (list);
        CFRelease (inputEntry);
        CFRelease (outputEntry);
        CFRelease (description);
        return status == noErr ? aggregate : 0;
    }

    UInt32 streamLatency (AudioStreamID stream)
    {
        AudioObjectPropertyAddress address { kAudioStreamPropertyLatency, kAudioObjectPropertyScopeGlobal, kMain };
        UInt32 value = 0, size = sizeof (value);
        return AudioObjectGetPropertyData (stream, &address, 0, nullptr, &size, &value) == noErr ? value : 0;
    }

    // How much more latency the input stream carrying `firstChannel` (0-based among the
    // aggregate's inputs) has than the aggregate's first input stream, which is the only
    // one JUCE asks. Zero when they are the same stream.
    int inputStreamLatencyBeyondFirst (AudioDeviceID aggregate, int firstChannel)
    {
        AudioObjectPropertyAddress address { kAudioDevicePropertyStreams, kAudioObjectPropertyScopeInput, kMain };
        UInt32 size = 0;
        if (AudioObjectGetPropertyDataSize (aggregate, &address, 0, nullptr, &size) != noErr || size < 2 * sizeof (AudioStreamID))
            return 0;
        std::vector<AudioStreamID> streams (size / sizeof (AudioStreamID));
        if (AudioObjectGetPropertyData (aggregate, &address, 0, nullptr, &size, streams.data()) != noErr)
            return 0;
        streams.resize (size / sizeof (AudioStreamID));

        int channel = 0;
        for (const auto stream : streams)
        {
            AudioObjectPropertyAddress formatAddress { kAudioStreamPropertyVirtualFormat, kAudioObjectPropertyScopeGlobal, kMain };
            AudioStreamBasicDescription format {};
            UInt32 formatSize = sizeof (format);
            if (AudioObjectGetPropertyData (stream, &formatAddress, 0, nullptr, &formatSize, &format) != noErr)
                return 0;
            const int count = (int) format.mChannelsPerFrame;
            if (firstChannel >= channel && firstChannel < channel + count)
                return (int) streamLatency (stream) - (int) streamLatency (streams.front());
            channel += count;
        }
        return 0;
    }

    void note (const juce::String& message)
    {
        std::cerr << "[audio] " << message << std::endl;
    }

    class CoreAudioTypeWithAggregates final : public juce::AudioIODeviceType,
                                              private juce::AudioIODeviceType::Listener
    {
    public:
        CoreAudioTypeWithAggregates()
            : juce::AudioIODeviceType ("CoreAudio"),
              inner (juce::AudioIODeviceType::createAudioIODeviceType_CoreAudio()),
              aggregatesAllowed (juce::SystemStats::getEnvironmentVariable ("MOSH_AUDIO_NO_AGGREGATE", {}).isEmpty())
        {
            inner->addListener (this);
        }

        ~CoreAudioTypeWithAggregates() override
        {
            inner->removeListener (this);
        }

        void scanForDevices() override
        {
            inner->scanForDevices();
            rememberLists();
        }

        juce::StringArray getDeviceNames (bool wantInputNames) const override
        {
            juce::StringArray names;
            for (const auto& name : inner->getDeviceNames (wantInputNames))
                if (! isPrivateAggregateName (name))
                    names.add (name);
            return names;
        }

        int getDefaultDeviceIndex (bool forInput) const override
        {
            const auto innerNames = inner->getDeviceNames (forInput);
            const int innerIndex = inner->getDefaultDeviceIndex (forInput);
            const int index = getDeviceNames (forInput).indexOf (innerNames[innerIndex]);
            return index >= 0 ? index : 0;
        }

        int getIndexOfDevice (juce::AudioIODevice* device, bool asInput) const override
        {
            if (device == nullptr)
                return -1;
            if (auto* proxy = dynamic_cast<CombinedDeviceProxy*> (device))
                return getDeviceNames (asInput).indexOf (asInput ? proxy->getInputDeviceName() : proxy->getOutputDeviceName());
            const int innerIndex = inner->getIndexOfDevice (device, asInput);
            return innerIndex < 0 ? -1 : getDeviceNames (asInput).indexOf (inner->getDeviceNames (asInput)[innerIndex]);
        }

        bool hasSeparateInputsAndOutputs() const override { return true; }

        juce::AudioIODevice* createDevice (const juce::String& outputDeviceName, const juce::String& inputDeviceName) override
        {
            if (aggregatesAllowed && outputDeviceName.isNotEmpty() && inputDeviceName.isNotEmpty())
                if (auto proxy = createAggregateDevice (outputDeviceName, inputDeviceName))
                    return proxy.release();
            return inner->createDevice (outputDeviceName, inputDeviceName);
        }

    private:
        std::unique_ptr<CombinedDeviceProxy> createAggregateDevice (const juce::String& outputDeviceName,
                                                                    const juce::String& inputDeviceName)
        {
            const auto devices = enumerateDevices();
            const auto output = findByListedName (devices, outputDeviceName, false);
            const auto input = findByListedName (devices, inputDeviceName, true);
            if (! output || ! input || output->uid.isEmpty() || input->uid.isEmpty())
                return {};
            if (output->id == input->id)
                return {}; // one physical device: JUCE's single-device path is already right

            // A device that another program has just let go of can take a moment to settle,
            // and an aggregate made in that moment may never show all its channels. A fresh
            // one usually does, so the whole thing is tried twice before giving up.
            for (int attempt = 1; attempt <= 2; ++attempt)
            {
                juce::String why;
                if (auto proxy = tryAggregate (*output, *input, outputDeviceName, inputDeviceName, why))
                {
                    note ("opened \"" + outputDeviceName + "\" + \"" + inputDeviceName + "\" as one combined device");
                    return proxy;
                }
                note ("combined device for \"" + outputDeviceName + "\" + \"" + inputDeviceName + "\", attempt "
                      + juce::String (attempt) + ": " + why);
                juce::Thread::sleep (150);
            }
            note ("using the two-device path instead (more monitoring delay)");
            return {};
        }

        std::unique_ptr<CombinedDeviceProxy> tryAggregate (const DeviceInfo& output, const DeviceInfo& input,
                                                           const juce::String& outputDeviceName,
                                                           const juce::String& inputDeviceName, juce::String& why)
        {
            const auto name = juce::String (kPrivateAggregatePrefix) + outputDeviceName + " + " + inputDeviceName;
            const auto aggregate = createPrivateAggregate (output, input, name);
            if (aggregate == 0)
            {
                why = "the system would not create it";
                return {};
            }
            auto destroy = [aggregate] { AudioHardwareDestroyAggregateDevice (aggregate); };

            CombinedLayout layout;
            layout.numOutputs = output.numOutputs;
            layout.inputOffset = output.numInputs;
            layout.numInputs = input.numInputs;
            const int wantOutputs = layout.numOutputs, wantInputs = layout.inputOffset + layout.numInputs;

            // The HAL publishes the aggregate's streams a moment after creating it, and
            // JUCE's device list and device object each read them again.
            std::unique_ptr<juce::AudioIODevice> device;
            int gotOutputs = 0, gotInputs = 0, deviceOutputs = -1, deviceInputs = -1;
            bool listed = false;
            const auto deadline = juce::Time::getMillisecondCounter() + 1500;
            for (;;)
            {
                gotOutputs = channelCount (aggregate, false);
                gotInputs = channelCount (aggregate, true);
                if (gotOutputs >= wantOutputs && gotInputs >= wantInputs)
                {
                    inner->scanForDevices();
                    listed = inner->getDeviceNames (true).contains (name) && inner->getDeviceNames (false).contains (name);
                    if (listed)
                    {
                        device.reset (inner->createDevice (name, name));
                        deviceOutputs = device != nullptr ? device->getOutputChannelNames().size() : -1;
                        deviceInputs = device != nullptr ? device->getInputChannelNames().size() : -1;
                        if (deviceOutputs >= wantOutputs && deviceInputs >= wantInputs)
                            break;
                        device.reset();
                    }
                }
                if (juce::Time::getMillisecondCounter() >= deadline)
                    break;
                juce::Thread::sleep (25);
            }

            if (device == nullptr)
            {
                destroy();
                inner->scanForDevices();
                why = "it did not come up (channels out " + juce::String (gotOutputs) + "/" + juce::String (wantOutputs)
                      + " in " + juce::String (gotInputs) + "/" + juce::String (wantInputs)
                      + ", listed " + juce::String (listed ? "yes" : "no")
                      + ", device out " + juce::String (deviceOutputs) + " in " + juce::String (deviceInputs) + ")";
                return {};
            }

            const int firstInputChannel = layout.inputOffset;
            return std::make_unique<CombinedDeviceProxy> (
                outputDeviceName, inputDeviceName, getTypeName(), std::move (device), layout, std::move (destroy),
                [aggregate, firstInputChannel] { return inputStreamLatencyBeyondFirst (aggregate, firstInputChannel); });
        }

        void rememberLists()
        {
            lastInnerInputs = inner->getDeviceNames (true);
            lastInnerOutputs = inner->getDeviceNames (false);
            lastInputs = getDeviceNames (true);
            lastOutputs = getDeviceNames (false);
        }

        // The inner type reports every HAL change: a device plugged or unplugged, a new
        // system default, and also the appearance and disappearance of our own private
        // aggregates. Only that last kind is swallowed (the full list changed but the
        // list this type publishes did not): to everyone above, nothing happened.
        void audioDeviceListChanged() override
        {
            const bool innerChanged = inner->getDeviceNames (true) != lastInnerInputs
                                      || inner->getDeviceNames (false) != lastInnerOutputs;
            const bool publishedChanged = getDeviceNames (true) != lastInputs || getDeviceNames (false) != lastOutputs;
            rememberLists();
            if (innerChanged && ! publishedChanged)
                return;
            callDeviceChangeListeners();
        }

        std::unique_ptr<juce::AudioIODeviceType> inner;
        const bool aggregatesAllowed;
        juce::StringArray lastInnerInputs, lastInnerOutputs, lastInputs, lastOutputs;
    };
}

std::unique_ptr<juce::AudioIODeviceType> createCoreAudioTypeWithPrivateAggregates()
{
    return std::make_unique<CoreAudioTypeWithAggregates>();
}
}

#endif
