// _CRT_RAND_S must be defined BEFORE the first <stdlib.h> in the translation unit, and
// the JUCE headers below pull that in — so this cannot move down with the other includes.
#if defined (_MSC_VER)
 #define _CRT_RAND_S
 #include <cstdlib>
#endif

#include "RemoteCompanionProtocol.h"

#include <atomic>
#include <cmath>
#include <cstddef>

// JUCE_MAC / JUCE_WINDOWS only exist once a JUCE header has been seen, so the
// platform-specific secure-random includes come after RemoteCompanionProtocol.h.
#if JUCE_MAC || JUCE_IOS
 #include <Security/SecRandom.h>
#elif ! JUCE_WINDOWS
 #include <cerrno>
 #include <fcntl.h>
 #include <unistd.h>
#endif

namespace mosh
{
namespace
{
    /** Fill `bytes` from the PLATFORM CSPRNG, or return false without touching a byte of
        it. This is the pairing token: anything that can predict it can drive the
        producer's transport and land takes in the session, so a PRNG seeded from the
        clock is not an acceptable source. juce::Random::getSystemRandom() is exactly such
        a PRNG — it is a 64-bit LCG whose default seed is derived from the millisecond
        counter and a couple of process constants, so an attacker on the same LAN who
        knows roughly when pairing started has a small space to search. */
    bool fillSecureRandom (juce::uint8* bytes, size_t count)
    {
       #if JUCE_MAC || JUCE_IOS
        return SecRandomCopyBytes (kSecRandomDefault, count, bytes) == errSecSuccess;
       #elif defined (_MSC_VER)
        // rand_s is RtlGenRandom behind a CRT entry point: a real CSPRNG, and unlike
        // BCryptGenRandom it needs no extra import library on the link line.
        for (size_t i = 0; i < count; ++i)
        {
            unsigned int value = 0;
            if (rand_s (&value) != 0)
                return false;
            bytes[i] = (juce::uint8) (value & 0xffu);
        }
        return true;
       #elif JUCE_WINDOWS
        juce::ignoreUnused (bytes, count);
        return false;   // no secure source wired for this toolchain
       #else
        // getentropy() is the kernel CSPRNG with no file descriptor to run out of, but it
        // is absent on older glibc, so /dev/urandom stays as the second attempt. 32 bytes
        // is far inside getentropy's 256-byte per-call ceiling.
        #if defined (__GLIBC__) && (__GLIBC__ > 2 || (__GLIBC__ == 2 && __GLIBC_MINOR__ >= 25))
        if (::getentropy (bytes, count) == 0)
            return true;
        #endif
        const int fd = ::open ("/dev/urandom", O_RDONLY);
        if (fd < 0)
            return false;
        size_t filled = 0;
        while (filled < count)
        {
            const auto got = ::read (fd, bytes + filled, count - filled);
            if (got > 0)             { filled += (size_t) got; continue; }
            if (got < 0 && errno == EINTR) continue;
            break;                   // 0 (impossible on urandom) or a real error
        }
        ::close (fd);
        return filled == count;
       #endif
    }

    juce::String safeName (juce::String name)
    {
        name = name.trim();
        if (name.isEmpty())
            name = "Phone Take";
        return name.retainCharacters ("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_");
    }

}

bool RemoteCompanionProtocol::isRestrictedPort (int port)
{
    if (port <= 0 || port < 1024)
        return true;
    if (port == 6000)
        return true;
    return port >= 6665 && port <= 6669;
}

RemotePairingInfo RemoteCompanionProtocol::beginPairing (const juce::String& host,
                                                         int port,
                                                         juce::int64 nowMs,
                                                         const juce::String& tokenOverride,
                                                         juce::int64 ttlOverrideMs)
{
    jassert (! isRestrictedPort (port));
    pairing.host = host;
    pairing.port = port;
    pairing.token = tokenOverride.isNotEmpty() ? tokenOverride : makeToken();
    pairing.expiresAtMs = nowMs + (ttlOverrideMs > 0 ? ttlOverrideMs : pairingTtlMs());
    pairing.pairingUrl = makePairingUrl (host, port, pairing.token);
    pairing.webUrl = makeWebUrl (host, port, pairing.token);
    pairing.padUrl = makePadUrl (host, port, pairing.token);
    return pairing;
}

RemoteAuthResult RemoteCompanionProtocol::authorize (const juce::String& token, juce::int64 nowMs) const
{
    if (pairing.token.isEmpty())
        return { false, "remote companion is not paired" };
    if (nowMs > pairing.expiresAtMs)
        return { false, "pairing token expired" };
    if (token != pairing.token)
        return { false, "invalid companion token" };
    return { true, {} };
}

void RemoteCompanionProtocol::clearPairing()
{
    pairing = {};
}

// 32 SECURE random bytes rendered as 64 lowercase hex characters.
//
// The bytes come from the platform CSPRNG (SecRandomCopyBytes on Apple, rand_s on MSVC,
// getentropy / /dev/urandom elsewhere). juce::Random::getSystemRandom() survives only as
// a loud last resort: it is a clock-seeded LCG, and this token is the ONLY thing between
// a stranger on the same Wi-Fi and the producer's transport.
//
// The previous implementation concatenated two UNPADDED toHexString(int64) values,
// so its output was 2-32 characters wide depending on how many leading zero nibbles
// the two random numbers happened to carry. The phone pad refuses anything outside
// /^[a-fA-F0-9]{32,128}$/ before it makes a request, so roughly one pairing in eight
// produced a QR code the phone discarded in silence. Fixed width, fixed alphabet.
juce::String RemoteCompanionProtocol::makeToken()
{
    juce::uint8 bytes[32] = {};
    if (! fillSecureRandom (bytes, sizeof (bytes)))
    {
        // A degraded token still beats no pairing at all — the producer is standing in
        // the live room holding a phone — but it is a security downgrade and must not be
        // silent. Once per process: a per-pairing line would train everyone to ignore it.
        static std::atomic<bool> warned { false };
        if (! warned.exchange (true))
            juce::Logger::writeToLog ("[remote] WARNING: the platform secure random source "
                                      "failed; pairing tokens fall back to juce::Random "
                                      "(predictable). Pair only on a trusted network.");
        juce::Random::getSystemRandom().fillBitsRandomly (bytes, sizeof (bytes));
    }
    return juce::String::toHexString (bytes, (int) sizeof (bytes), 0).toLowerCase();
}

juce::String RemoteCompanionProtocol::makePairingPayload (const juce::String& host,
                                                          int port,
                                                          const juce::String& token)
{
    juce::DynamicObject::Ptr obj = new juce::DynamicObject();
    obj->setProperty ("host", host);
    obj->setProperty ("port", port);
    obj->setProperty ("token", token);
    return juce::Base64::toBase64 (juce::JSON::toString (juce::var (obj.get())));
}

juce::String RemoteCompanionProtocol::makePairingUrl (const juce::String& host,
                                                      int port,
                                                      const juce::String& token)
{
    const auto payload = makePairingPayload (host, port, token);
    return "mosh://pair?payload=" + juce::URL::addEscapeChars (payload, true);
}

juce::String RemoteCompanionProtocol::makeWebUrl (const juce::String& host,
                                                  int port,
                                                  const juce::String& token)
{
    const auto payload = makePairingPayload (host, port, token);
    return "http://" + host + ":" + juce::String (port) + "/web?payload=" + juce::URL::addEscapeChars (payload, true);
}

// The token rides in the fragment, not the query: a fragment is never sent to the
// server, so it cannot appear in a request line, an access log or a Referer header.
// The pad page reads it from location.hash and then clears the hash.
juce::String RemoteCompanionProtocol::makePadUrl (const juce::String& host,
                                                  int port,
                                                  const juce::String& token)
{
    return "http://" + host + ":" + juce::String (port) + "/pad#token=" + token;
}

RemotePhoneTakeStore::RemotePhoneTakeStore (juce::File rootDirectory)
    : root (std::move (rootDirectory))
{
    root.createDirectory();
}

RemoteTakeStartResult RemotePhoneTakeStore::startTake (const RemoteTakeStartRequest& request)
{
    if (request.sampleRate < 8000.0 || request.sampleRate > 192000.0)
        return { false, "unsupported sample rate", {} };
    if (request.channels < 1 || request.channels > 2)
        return { false, "unsupported channel count", {} };

    ActiveTake take;
    take.id = "phone-" + juce::String::toHexString (juce::Time::currentTimeMillis())
        + "-" + juce::String::toHexString (juce::Random::getSystemRandom().nextInt());
    take.trackId = request.trackId;
    take.name = safeName (request.name);
    take.sampleRate = request.sampleRate;
    take.channels = request.channels;
    take.rawFile = root.getChildFile (take.id + ".pcm16");
    take.rawFile.deleteFile();

    if (auto out = std::unique_ptr<juce::FileOutputStream> (take.rawFile.createOutputStream()))
    {
        out->flush();
    }
    else
    {
        return { false, "could not create take staging file", {} };
    }

    const auto id = take.id;
    active.set (id, take);
    return { true, {}, id };
}

RemoteAuthResult RemotePhoneTakeStore::appendPcm16Chunk (const juce::String& takeId,
                                                         int sequence,
                                                         const juce::MemoryBlock& pcm16LittleEndian)
{
    if (! active.contains (takeId))
        return { false, "unknown take" };

    auto take = active[takeId];
    if (sequence != take.nextSequence)
        return { false, "out-of-order take chunk" };
    if (pcm16LittleEndian.getSize() == 0 || (pcm16LittleEndian.getSize() % (2u * (size_t) take.channels)) != 0)
        return { false, "invalid pcm16 chunk" };

    if (auto out = std::unique_ptr<juce::FileOutputStream> (take.rawFile.createOutputStream ((size_t) take.rawFile.getSize())))
    {
        out->write (pcm16LittleEndian.getData(), pcm16LittleEndian.getSize());
        out->flush();
    }
    else
    {
        return { false, "could not append take chunk" };
    }

    ++take.nextSequence;
    active.set (takeId, take);
    return { true, {} };
}

RemoteTakeFinishResult RemotePhoneTakeStore::finishTake (const juce::String& takeId)
{
    if (! active.contains (takeId))
        return { false, "unknown take", takeId, {}, {}, {} };

    auto take = active[takeId];
    juce::MemoryBlock raw;
    if (! take.rawFile.loadFileAsData (raw))
        return { false, "could not read staged take", takeId, take.trackId, take.name, {} };

    auto wav = root.getChildFile (take.id + ".wav");
    wav.deleteFile();
    if (! writePcm16Wav (wav, raw, take.channels, (int) std::round (take.sampleRate)))
        return { false, "could not write take wav", takeId, take.trackId, take.name, {} };

    take.rawFile.deleteFile();
    active.remove (takeId);
    return { true, {}, takeId, take.trackId, take.name, wav };
}

RemoteAuthResult RemotePhoneTakeStore::cancelTake (const juce::String& takeId)
{
    if (! active.contains (takeId))
        return { false, "unknown take" };
    auto take = active[takeId];
    take.rawFile.deleteFile();
    active.remove (takeId);
    return { true, {} };
}

bool RemotePhoneTakeStore::writePcm16Wav (const juce::File& destFile,
                                          const juce::MemoryBlock& pcm16LittleEndian,
                                          int channels,
                                          int sampleRate)
{
    if (channels < 1 || channels > 2 || sampleRate <= 0 || pcm16LittleEndian.getSize() == 0)
        return false;

    auto out = std::unique_ptr<juce::FileOutputStream> (destFile.createOutputStream());
    if (out == nullptr)
        return false;

    const auto dataBytes = (juce::uint32) pcm16LittleEndian.getSize();
    const auto byteRate = (juce::uint32) (sampleRate * channels * 2);
    const auto blockAlign = channels * 2;

    writeFourCC (*out, "RIFF");
    writeLe32 (*out, 36u + dataBytes);
    writeFourCC (*out, "WAVE");
    writeFourCC (*out, "fmt ");
    writeLe32 (*out, 16);
    writeLe16 (*out, 1);
    writeLe16 (*out, channels);
    writeLe32 (*out, (juce::uint32) sampleRate);
    writeLe32 (*out, byteRate);
    writeLe16 (*out, blockAlign);
    writeLe16 (*out, 16);
    writeFourCC (*out, "data");
    writeLe32 (*out, dataBytes);
    out->write (pcm16LittleEndian.getData(), pcm16LittleEndian.getSize());
    out->flush();
    return ! out->failedToOpen();
}

void RemotePhoneTakeStore::writeFourCC (juce::OutputStream& out, const char* text)
{
    out.write (text, 4);
}

void RemotePhoneTakeStore::writeLe16 (juce::OutputStream& out, int value)
{
    const juce::uint8 bytes[] {
        (juce::uint8) (value & 0xff),
        (juce::uint8) ((value >> 8) & 0xff)
    };
    out.write (bytes, 2);
}

void RemotePhoneTakeStore::writeLe32 (juce::OutputStream& out, juce::uint32 value)
{
    const juce::uint8 bytes[] {
        (juce::uint8) (value & 0xff),
        (juce::uint8) ((value >> 8) & 0xff),
        (juce::uint8) ((value >> 16) & 0xff),
        (juce::uint8) ((value >> 24) & 0xff)
    };
    out.write (bytes, 4);
}

RemoteMonitorStore::RemoteMonitorStore (juce::File rootDirectory)
    : root (std::move (rootDirectory))
{
    root.createDirectory();
}

RemoteMonitorStartResult RemoteMonitorStore::startMonitor (const juce::String& mode)
{
    ActiveMonitor monitor;
    monitor.id = "monitor-" + juce::String::toHexString (juce::Time::currentTimeMillis())
        + "-" + juce::String::toHexString (juce::Random::getSystemRandom().nextInt());
    monitor.mode = mode.isNotEmpty() ? mode : "both";
    monitor.startedAtMacMs = juce::Time::currentTimeMillis();
    const auto id = monitor.id;
    active.set (id, monitor);
    return { true, {}, id, monitor.sampleRate, monitor.chunkFrames };
}

RemoteMonitorChunkResult RemoteMonitorStore::nextProbeChunk (const juce::String& sessionId, int sequence)
{
    if (! active.contains (sessionId))
    {
        RemoteMonitorChunkResult result;
        result.error = "unknown monitor session";
        return result;
    }

    auto monitor = active[sessionId];
    if (sequence != monitor.nextSequence)
    {
        RemoteMonitorChunkResult result;
        result.error = "out-of-order monitor chunk";
        return result;
    }

    RemoteMonitorChunkResult result;
    result.ok = true;
    result.sessionId = sessionId;
    result.sequence = sequence;
    result.sampleRate = monitor.sampleRate;
    result.chunkFrames = monitor.chunkFrames;
    result.sentAtMacMs = juce::Time::currentTimeMillis();
    result.pcm16 = makeProbeChunk (sequence, monitor.chunkFrames);

    ++monitor.nextSequence;
    active.set (sessionId, monitor);
    return result;
}

RemoteMonitorReportResult RemoteMonitorStore::writeReport (const RemoteMonitorReportRequest& report,
                                                           juce::int64 receivedAtMacMs)
{
    if (! active.contains (report.sessionId))
        return { false, "unknown monitor session", {} };

    root.createDirectory();
    auto reportFile = root.getChildFile (report.sessionId + ".json");
    auto* o = new juce::DynamicObject();
    o->setProperty ("sessionId", report.sessionId);
    o->setProperty ("receivedAtMacMs", (double) receivedAtMacMs);
    o->setProperty ("networkMedianMs", report.networkMedianMs);
    o->setProperty ("networkP95Ms", report.networkP95Ms);
    o->setProperty ("networkJitterMs", report.networkJitterMs);
    o->setProperty ("acousticMedianMs", report.acousticMedianMs);
    o->setProperty ("acousticP95Ms", report.acousticP95Ms);
    o->setProperty ("acousticJitterMs", report.acousticJitterMs);

    if (! reportFile.replaceWithText (juce::JSON::toString (juce::var (o), true)))
        return { false, "could not write monitor report", {} };
    return { true, {}, reportFile };
}

RemoteAuthResult RemoteMonitorStore::stopMonitor (const juce::String& sessionId)
{
    if (! active.contains (sessionId))
        return { false, "unknown monitor session" };
    active.remove (sessionId);
    return { true, {} };
}

juce::MemoryBlock RemoteMonitorStore::makeProbeChunk (int sequence, int frames)
{
    juce::MemoryBlock data;
    data.ensureSize ((size_t) frames * 2);
    data.setSize (0);

    for (int i = 0; i < frames; ++i)
    {
        const bool click = i == 0 || (sequence % 8 == 0 && i == frames / 2);
        const double t = (double) i / 48000.0;
        const double chirp = std::sin (2.0 * juce::MathConstants<double>::pi * (1200.0 + sequence * 20.0) * t);
        const float sample = click ? 0.85f : (float) (0.10 * chirp);
        auto s = (juce::int16) juce::roundToInt (juce::jlimit (-1.0f, 1.0f, sample) * 32767.0f);
        s = juce::ByteOrder::swapIfBigEndian (s);
        data.append (&s, sizeof (s));
    }

    return data;
}

} // namespace mosh
