#pragma once

// What render_lora_take asks the service for, and the identity its cached take is
// stored under. Pure (no engine, no service) so tests can hold both to account.

#include <juce_core/juce_core.h>

namespace mosh::loratake
{
/** The re-imagine amount a Lab audition over a source clip uses: the same default
 *  the Re-Imagine panel starts at (DirectReImagine's nl 0.4). */
inline constexpr double kDefaultSourceNl = 0.4;

/** A take over a source clip needs at least this much of it (the engine's minimum). */
inline constexpr double kMinSourceSeconds = 2.0;

/** Where in its file a take over a clip reads, and for how long, in file seconds. */
struct SourceRegion
{
    double start = 0.0;
    double length = 0.0;
};

/** The material the producer selected: from the clip's offset into its file, for the
 *  clip's own span (its length at its speed), never past the end of the file, and no
 *  longer than the take. Reading the file from 0 for `maxSeconds` re-imagined audio
 *  from outside the clip, and a source shorter than the take padded it with silence. */
inline SourceRegion sourceRegion (double clipOffset, double clipLength, double speedRatio,
                                  double fileLength, double maxSeconds)
{
    const double fileEnd = juce::jmax (0.0, fileLength);
    const double start = juce::jlimit (0.0, fileEnd, clipOffset);
    const double span = clipLength * (speedRatio > 0.0 ? speedRatio : 1.0);
    const double available = juce::jmin (span, fileEnd - start);
    return { start, juce::jmax (0.0, juce::jmin (maxSeconds, available)) };
}

/** The identity of the audio a take is rendered over: the file as it is on disk (path,
 *  size, modification time) and the region read from it. A clip id is not one: a kept
 *  Re-Imagine, a re-record or an undo changes the audio under the same id. */
inline juce::String sourceIdentity (const juce::String& path, juce::int64 size, juce::int64 modifiedMs,
                                    SourceRegion region)
{
    juce::String id;
    id << path << "#" << size << "@" << modifiedMs << "[" << juce::String (region.start, 4)
       << "+" << juce::String (region.length, 4) << "]";
    return id;
}

/** The SA3 params for one Lab take. `nl` is sent only with a source: the adapter
 *  re-imagines only when it has both a source and an nl, so a source without one
 *  was staged and then ignored, and the take was rendered text-to-audio. */
inline juce::var params (const juce::String& prompt, int seed, double seconds,
                         const juce::Array<juce::var>& stack, bool hasSource, double nl)
{
    auto* p = new juce::DynamicObject();
    p->setProperty ("prompt", prompt);
    p->setProperty ("seed", seed);
    p->setProperty ("mode", hasSource ? "reimagine" : "generate");
    if (hasSource)
        p->setProperty ("nl", nl);
    p->setProperty ("loras", stack);
    p->setProperty ("duration_s", seconds);
    // No colours and no ASTD here on purpose: a take exists to answer "what did the
    // TRAINING do", and a colour stacked on top would confound the one variable the
    // Lab is there to isolate.
    p->setProperty ("colors", juce::Array<juce::var>{});
    return juce::var (p);
}

/** The cache identity of a take: everything that changes its audio. `source` is
 *  sourceIdentity() for a take over a clip, empty otherwise. `shaByName`
 *  maps adapter names to content digests, so a retrained adapter of the same name
 *  is a different take. The re-imagine amount is part of it: a take rendered over
 *  a source at one amount is not the take at another. */
inline juce::String cacheKey (const juce::String& prompt, int seed, double seconds,
                              const juce::String& source, double nl,
                              const juce::Array<juce::var>& stack, const juce::var& shaByName)
{
    juce::String key;
    key << prompt << "|" << seed << "|" << juce::String (seconds, 3) << "|" << source;
    if (source.isNotEmpty())
        key << "|nl=" << juce::String (nl, 4);
    for (const auto& e : stack)
    {
        const auto nm = e.getProperty ("name", juce::var()).toString();
        key << "|" << nm << "@" << e.getProperty ("value", juce::var()).toString()
            << "#" << (shaByName.isObject() ? shaByName.getProperty (juce::Identifier (nm), juce::var()).toString()
                                            : juce::String());
    }
    return key;
}
} // namespace mosh::loratake
