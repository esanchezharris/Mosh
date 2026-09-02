#pragma once

// CAP-001 — recording residue after an unclean exit: the pure decisions.
//
// Tracktion streams a take straight to disk while recording and only lands the clip
// when the transport STOPS (applyLastRecording). So a crash mid-take leaves a WAV on
// disk that no clip references: real audio the producer sang, invisible to the
// project. Mosh's journal replay (recover_session) cannot bring it back — the clip
// never existed. This header decides, engine-free, what to do with such a file; the
// engine-side scan (MoshEngine::scanRecordingResidue) and the commands that act on a
// decision live elsewhere. Policy ported from Moshpit M005-08: a completed capture is
// adopted through the NORMAL landing path; anything torn or unreadable is quarantined
// IN PLACE (renamed, never deleted, never adopted); the project document is never
// rewritten on a failure.
//
// Tracktion's default recording filename pattern is
//   %projectdir%/%edit%_%track%_Take_%take%.<ext>
// (EngineBehaviour::getDefaultAudioRecordingFilePattern; Mosh does not override it).

#include <juce_core/juce_core.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <optional>
#include <set>

namespace mosh::residue
{
struct TakeFileName
{
    juce::String editName;
    juce::String trackName;
    int take = 0;
};

/** Parses "<edit>_<track>_Take_<n>" or "<track>_Take_<n>" (extension already stripped).
    Tracktion's pattern is %edit%_%track%_Take_%take%, and it DROPS the "%edit%_" part when
    the Edit has no name — which is every Mosh project, so the on-disk form is normally
    "Vox_Take_1". Track names may contain underscores, so the split is on the LAST
    "_Take_"; with a prefix present, the first underscore separates edit from track.
    Fails closed on anything that does not fit. */
[[nodiscard]] inline std::optional<TakeFileName> parseTakeFileName (const juce::String& stem)
{
    const auto marker = stem.lastIndexOf ("_Take_");
    if (marker <= 0)
        return std::nullopt;
    const auto takeText = stem.substring (marker + 6);
    if (takeText.isEmpty() || ! takeText.containsOnly ("0123456789"))
        return std::nullopt;
    const auto head = stem.substring (0, marker);
    if (head.isEmpty())
        return std::nullopt;
    TakeFileName r;
    r.take = takeText.getIntValue();
    const auto split = head.indexOfChar ('_');
    if (split > 0 && split < head.length() - 1)
    {
        r.editName  = head.substring (0, split);
        r.trackName = head.substring (split + 1);
    }
    else
    {
        r.editName.clear();          // the unnamed-Edit form: "<track>_Take_<n>"
        r.trackName = head;
    }
    return r;
}

/** What a crash actually leaves behind. JUCE's WAV writer puts a header with a ZERO data
    size at open and only rewrites the sizes on close, so a take killed mid-record is
    "unreadable" to every reader while every PCM byte after the header is intact. That
    is not a torn take — it is a torn HEADER, and the audio is recoverable by patching
    two size fields into a copy. inspectWav walks the RIFF chunks without any decoder. */
struct WavShape
{
    bool riff = false;              // RIFF/WAVE with an fmt chunk and a data chunk
    int channels = 0;
    int bitsPerSample = 0;
    double sampleRate = 0.0;
    std::int64_t dataOffset = 0;    // first PCM byte
    std::int64_t declaredDataBytes = 0;
    std::int64_t payloadBytes = 0;  // bytes actually present after dataOffset
    std::int64_t bextTimeReference = 0;
    [[nodiscard]] int blockAlign() const noexcept { return channels * (bitsPerSample / 8); }
    [[nodiscard]] std::int64_t payloadFrames() const noexcept
    {
        return blockAlign() > 0 ? payloadBytes / blockAlign() : 0;
    }
    /** The header lies about the data size (0, the 0xFFFFFFFF placeholder, or more than
        the file holds) while real PCM follows: a size patch makes it readable. */
    [[nodiscard]] bool headerTorn() const noexcept
    {
        return riff && payloadFrames() > 0
            && (declaredDataBytes == 0 || declaredDataBytes == 0xFFFFFFFFLL || declaredDataBytes > payloadBytes);
    }
};

[[nodiscard]] inline WavShape inspectWav (const juce::File& file)
{
    WavShape w;
    juce::FileInputStream in (file);
    if (! in.openedOk()) return w;
    const auto total = in.getTotalLength();
    auto readU32 = [&] (std::int64_t at) -> std::uint32_t
    {
        in.setPosition (at);
        return (std::uint32_t) in.readInt();
    };
    auto readTag = [&] (std::int64_t at) -> juce::String
    {
        char t[5] = { 0, 0, 0, 0, 0 };
        in.setPosition (at);
        in.read (t, 4);
        return juce::String (t, 4);
    };
    if (total < 12 || readTag (0) != "RIFF" || readTag (8) != "WAVE") return w;
    bool haveFmt = false;
    std::int64_t p = 12;
    while (p + 8 <= total)
    {
        const auto id = readTag (p);
        const std::int64_t sz = readU32 (p + 4);
        if (id == "fmt " && sz >= 16 && p + 8 + 16 <= total)
        {
            in.setPosition (p + 8);
            in.readShort();                                   // format tag
            w.channels = (int) in.readShort();
            w.sampleRate = (double) (std::uint32_t) in.readInt();
            in.readInt();                                     // avg bytes/sec
            in.readShort();                                   // block align
            w.bitsPerSample = (int) in.readShort();
            haveFmt = true;
        }
        else if (id == "bext" && sz >= 346 && p + 8 + 346 <= total)
        {
            in.setPosition (p + 8 + 338);
            w.bextTimeReference = in.readInt64();
        }
        else if (id == "data")
        {
            w.dataOffset = p + 8;
            w.declaredDataBytes = sz;
            w.payloadBytes = juce::jmax ((std::int64_t) 0, total - w.dataOffset);
            w.riff = haveFmt && w.channels > 0 && w.bitsPerSample > 0 && w.sampleRate > 0.0;
            return w;
        }
        if (sz == 0xFFFFFFFFLL) break;
        p += 8 + sz + (sz & 1);
    }
    return w;
}

/** Copies `src` to `dst` with the RIFF and data sizes patched to what the file actually
    holds. Never touches `src`. Returns false (and leaves no `dst`) on anything odd. */
[[nodiscard]] inline bool repairTruncatedWav (const juce::File& src, const juce::File& dst)
{
    const auto w = inspectWav (src);
    if (! w.headerTorn()) return false;
    const auto wholeFrames = w.payloadFrames();
    const std::int64_t dataBytes = wholeFrames * w.blockAlign();
    juce::MemoryBlock bytes;
    if (! src.loadFileAsData (bytes)) return false;
    const std::int64_t keep = w.dataOffset + dataBytes;
    if (keep > (std::int64_t) bytes.getSize()) return false;
    auto* b = static_cast<std::uint8_t*> (bytes.getData());
    auto put32 = [&] (std::int64_t at, std::uint32_t v)
    {
        b[at] = (std::uint8_t) v; b[at + 1] = (std::uint8_t) (v >> 8);
        b[at + 2] = (std::uint8_t) (v >> 16); b[at + 3] = (std::uint8_t) (v >> 24);
    };
    put32 (4, (std::uint32_t) (keep - 8));
    put32 (w.dataOffset - 4, (std::uint32_t) dataBytes);
    dst.deleteFile();
    juce::FileOutputStream out (dst);
    if (! out.openedOk()) return false;
    const bool ok = out.write (b, (size_t) keep);
    out.flush();
    if (! ok) dst.deleteFile();
    return ok;
}

enum class Decision { adopt, quarantine };

/** A file is adoptable only if it reads as audio with real content at the project's
    rate; everything else is quarantined — a wrong adoption is worse than none. */
[[nodiscard]] inline Decision decide (bool readable, std::int64_t frames,
                                      double fileSampleRate, double projectSampleRate) noexcept
{
    // `readable` here means "a reader can decode it OR its header is torn but repairable"
    // — the caller resolves that; a torn header is the NORMAL crash residue, not junk.
    if (! readable || frames <= 0)
        return Decision::quarantine;
    if (projectSampleRate > 0.0 && fileSampleRate > 0.0
        && std::abs (fileSampleRate - projectSampleRate) > 0.5)
        return Decision::quarantine;
    return Decision::adopt;
}

/** The in-place quarantine name: same directory, same stem, a tag that no reader
    matches as audio. Never overwrites: the uuid makes it unique. */
[[nodiscard]] inline juce::File quarantineName (const juce::File& file)
{
    return file.getSiblingFile (file.getFileName() + ".quarantined-"
                                + juce::Uuid().toString().substring (0, 8));
}

/** Where the take belongs on the timeline: BWAV "time reference" is the sample the
    recording started at (Tracktion writes the punch start there). Absent → 0. */
[[nodiscard]] inline double startSecondsFromTimeReference (const juce::String& bwavTimeReference,
                                                           double sampleRate) noexcept
{
    if (bwavTimeReference.isEmpty() || sampleRate <= 0.0)
        return 0.0;
    const auto samples = bwavTimeReference.getLargeIntValue();
    return samples > 0 ? (double) samples / sampleRate : 0.0;
}
/** Why a file under the project dir is NOT residue (empty == eligible). Deliberately
    NO freshness rule: relaunching Mosh reopens the last project and re-saves it, so
    "newer than the last save" would exclude every crashed take in exactly the relaunch
    that is meant to recover it. An orphan take file a removed clip left behind is
    therefore offered too — adoption is a per-file human decision from the notice, and
    the notice itself only appears after an unclean exit. */
[[nodiscard]] inline juce::String reasonNotEligible (const juce::File& file,
                                                     const std::set<juce::String>& referencedPaths)
{
    if (! file.existsAsFile()) return "file does not exist";
    if (file.getFileExtension().toLowerCase() != ".wav") return "not a WAV";
    if (! parseTakeFileName (file.getFileNameWithoutExtension()).has_value()) return "not a Tracktion take file";
    if (referencedPaths.count (file.getFullPathName()) > 0) return "a clip already references it";
    return {};
}

/** The candidate files: every eligible take WAV directly under the project dir,
    newest first (the crashed take is almost always the top row). */
[[nodiscard]] inline juce::Array<juce::File> findResidue (const juce::File& projectDir,
                                                          const std::set<juce::String>& referencedPaths)
{
    juce::Array<juce::File> out;
    if (! projectDir.isDirectory())
        return out;
    for (const auto& f : projectDir.findChildFiles (juce::File::findFiles, false, "*.wav"))
        if (reasonNotEligible (f, referencedPaths).isEmpty())
            out.add (f);
    std::sort (out.begin(), out.end(), [] (const juce::File& x, const juce::File& y)
    {
        return x.getLastModificationTime() > y.getLastModificationTime();
    });
    return out;
}
} // namespace mosh::residue
