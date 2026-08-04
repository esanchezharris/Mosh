#pragma once

#include <juce_audio_formats/juce_audio_formats.h>

#include <memory>
#include <vector>

#include "TpdfDither.h"

namespace mosh
{

/**
    CAP-EXP-001 — a juce::AudioFormat decorator that TPDF-dithers the final
    requantisation of anything written through it.

    WHY A FORMAT DECORATOR. The requantisation we need to intercept happens inside
    JUCE's concrete writer, several layers below us: te::Renderer::RenderTask owns a
    NodeRenderContext, which owns a te::AudioFileWriter, which asks
    AudioFileUtils::createWriterFor(params.audioFormat, ...) for the writer. The ONLY
    handle the caller keeps on that chain is `Renderer::Parameters::audioFormat`. Handing
    it this wrapper — which delegates every AudioFormat query to the real format and
    differs only in returning a dithering writer — puts our processing at exactly the
    right point without a temp file, a second render pass, or a patch to the vendored
    engine. (Tracktion does ship a `Parameters::ditheringEnabled` flag, but its Ditherer
    is noise-shaped and driven by the global rand(): out of scope on both counts.)

    Everything else about the export is untouched: same format object underneath, same
    header, same metadata, same file.
*/
class DitheringAudioFormat : public juce::AudioFormat
{
public:
    explicit DitheringAudioFormat (juce::AudioFormat& formatToWrap);

    /** True when writing `bits` really is a word-length reduction from the 32-bit float
        render bus. 32-bit exports take the untouched path and stay byte-identical. */
    static bool shouldDither (int bits) noexcept   { return TpdfDither::shouldDither (bits); }

    juce::Array<int> getPossibleSampleRates() override;
    juce::Array<int> getPossibleBitDepths() override;
    bool canDoStereo() override;
    bool canDoMono() override;
    bool isCompressed() override;
    bool canHandleFile (const juce::File&) override;
    juce::StringArray getQualityOptions() override;

    juce::AudioFormatReader* createReaderFor (juce::InputStream*, bool deleteStreamIfOpeningFails) override;

    std::unique_ptr<juce::AudioFormatWriter> createWriterFor (std::unique_ptr<juce::OutputStream>&,
                                                              const juce::AudioFormatWriterOptions&) override;

private:
    juce::AudioFormat& inner;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (DitheringAudioFormat)
};

/**
    The writer half: adds ±1 LSB TPDF dither and snaps to the destination lattice, then
    forwards to the real writer, which narrows the (already lattice-aligned) int32 with
    its arithmetic shift and therefore emits exactly the codes chosen here.

    One independent dither stream per channel — sharing one would put identical noise in
    left and right, which sums to a centred mono hiss instead of a diffuse floor.
*/
class TpdfDitherWriter : public juce::AudioFormatWriter
{
public:
    TpdfDitherWriter (std::unique_ptr<juce::AudioFormatWriter> target, std::uint64_t seed);

    bool write (const int** samplesToWrite, int numSamples) override;
    bool flush() override;

private:
    void ensureCapacity (int numChannels, int numSamples);

    std::unique_ptr<juce::AudioFormatWriter> inner;
    std::uint64_t baseSeed;
    std::vector<TpdfDither> ditherers;             // one per channel, index == channel
    std::vector<std::vector<int>> scratch;         // dithered copies (the input is const)
    std::vector<const int*> pointers;              // zero-terminated view handed downstream

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (TpdfDitherWriter)
};

} // namespace mosh
