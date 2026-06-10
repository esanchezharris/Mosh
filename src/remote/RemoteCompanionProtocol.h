#pragma once

#include <juce_core/juce_core.h>

namespace mosh
{

struct RemoteAuthResult
{
    bool ok = false;
    juce::String error;
};

struct RemotePairingInfo
{
    juce::String host;
    int port = 0;
    juce::String token;
    juce::int64 expiresAtMs = 0;
    juce::String pairingUrl;
    juce::String webUrl;
};

class RemoteCompanionProtocol
{
public:
    static int defaultPort() { return 47873; }
    static juce::int64 pairingTtlMs() { return 5 * 60 * 1000; }
    static bool isRestrictedPort (int port);

    RemotePairingInfo beginPairing (const juce::String& host, int port,
                                    juce::int64 nowMs,
                                    const juce::String& tokenOverride = {},
                                    juce::int64 ttlOverrideMs = 0);
    RemoteAuthResult authorize (const juce::String& token, juce::int64 nowMs) const;
    RemotePairingInfo currentPairing() const { return pairing; }
    void clearPairing();

private:
    static juce::String makeToken();
    static juce::String makePairingPayload (const juce::String& host, int port,
                                            const juce::String& token);
    static juce::String makePairingUrl (const juce::String& host, int port,
                                        const juce::String& token);
    static juce::String makeWebUrl (const juce::String& host, int port,
                                    const juce::String& token);

    RemotePairingInfo pairing;
};

struct RemoteTakeStartRequest
{
    juce::String trackId;
    juce::String name;
    double sampleRate = 44100.0;
    int channels = 1;
};

struct RemoteTakeStartResult
{
    bool ok = false;
    juce::String error;
    juce::String takeId;
};

struct RemoteTakeFinishResult
{
    bool ok = false;
    juce::String error;
    juce::String takeId;
    juce::String trackId;
    juce::String name;
    juce::File file;
};

struct RemoteMonitorStartResult
{
    bool ok = false;
    juce::String error;
    juce::String sessionId;
    int sampleRate = 48000;
    int chunkFrames = 2400;
};

struct RemoteMonitorChunkResult
{
    bool ok = false;
    juce::String error;
    juce::String sessionId;
    int sequence = 0;
    int sampleRate = 48000;
    int chunkFrames = 2400;
    juce::int64 sentAtMacMs = 0;
    juce::MemoryBlock pcm16;
};

struct RemoteMonitorReportRequest
{
    juce::String sessionId;
    double networkMedianMs = 0.0;
    double networkP95Ms = 0.0;
    double networkJitterMs = 0.0;
    double acousticMedianMs = 0.0;
    double acousticP95Ms = 0.0;
    double acousticJitterMs = 0.0;
};

struct RemoteMonitorReportResult
{
    bool ok = false;
    juce::String error;
    juce::File reportFile;
};

class RemotePhoneTakeStore
{
public:
    explicit RemotePhoneTakeStore (juce::File rootDirectory);

    RemoteTakeStartResult startTake (const RemoteTakeStartRequest& request);
    RemoteAuthResult appendPcm16Chunk (const juce::String& takeId, int sequence,
                                       const juce::MemoryBlock& pcm16LittleEndian);
    RemoteTakeFinishResult finishTake (const juce::String& takeId);
    RemoteAuthResult cancelTake (const juce::String& takeId);

private:
    struct ActiveTake
    {
        juce::String id;
        juce::String trackId;
        juce::String name;
        double sampleRate = 44100.0;
        int channels = 1;
        int nextSequence = 0;
        juce::File rawFile;
    };

    static bool writePcm16Wav (const juce::File& destFile,
                               const juce::MemoryBlock& pcm16LittleEndian,
                               int channels, int sampleRate);
    static void writeFourCC (juce::OutputStream& out, const char* text);
    static void writeLe16 (juce::OutputStream& out, int value);
    static void writeLe32 (juce::OutputStream& out, juce::uint32 value);

    juce::File root;
    juce::HashMap<juce::String, ActiveTake> active;
};

class RemoteMonitorStore
{
public:
    explicit RemoteMonitorStore (juce::File rootDirectory);

    RemoteMonitorStartResult startMonitor (const juce::String& mode);
    RemoteMonitorChunkResult nextProbeChunk (const juce::String& sessionId, int sequence);
    RemoteMonitorReportResult writeReport (const RemoteMonitorReportRequest& report,
                                           juce::int64 receivedAtMacMs);
    RemoteAuthResult stopMonitor (const juce::String& sessionId);

private:
    struct ActiveMonitor
    {
        juce::String id;
        juce::String mode;
        int nextSequence = 0;
        int sampleRate = 48000;
        int chunkFrames = 2400;
        juce::int64 startedAtMacMs = 0;
    };

    static juce::MemoryBlock makeProbeChunk (int sequence, int frames);

    juce::File root;
    juce::HashMap<juce::String, ActiveMonitor> active;
};

} // namespace mosh
