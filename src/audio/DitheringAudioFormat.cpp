#include "DitheringAudioFormat.h"

namespace mosh
{

// ─────────────────────────────────────────────────────────────────────────────
// DitheringAudioFormat — a pure pass-through except for createWriterFor.
// ─────────────────────────────────────────────────────────────────────────────
DitheringAudioFormat::DitheringAudioFormat (juce::AudioFormat& formatToWrap)
    : juce::AudioFormat (formatToWrap.getFormatName(), formatToWrap.getFileExtensions()),
      inner (formatToWrap)
{
}

juce::Array<int> DitheringAudioFormat::getPossibleSampleRates()   { return inner.getPossibleSampleRates(); }
juce::Array<int> DitheringAudioFormat::getPossibleBitDepths()     { return inner.getPossibleBitDepths(); }
bool DitheringAudioFormat::canDoStereo()                          { return inner.canDoStereo(); }
bool DitheringAudioFormat::canDoMono()                            { return inner.canDoMono(); }
bool DitheringAudioFormat::isCompressed()                         { return inner.isCompressed(); }
bool DitheringAudioFormat::canHandleFile (const juce::File& f)    { return inner.canHandleFile (f); }
juce::StringArray DitheringAudioFormat::getQualityOptions()       { return inner.getQualityOptions(); }

juce::AudioFormatReader* DitheringAudioFormat::createReaderFor (juce::InputStream* stream,
                                                                bool deleteStreamIfOpeningFails)
{
    return inner.createReaderFor (stream, deleteStreamIfOpeningFails);
}

std::unique_ptr<juce::AudioFormatWriter>
DitheringAudioFormat::createWriterFor (std::unique_ptr<juce::OutputStream>& streamToWriteTo,
                                       const juce::AudioFormatWriterOptions& options)
{
    auto target = inner.createWriterFor (streamToWriteTo, options);
    if (target == nullptr)
        return {};

    // Ask the writer that actually exists rather than trusting the options: a format is
    // free to clamp an unsupported depth, and dithering to a depth the file does not have
    // would put the noise at the wrong level. A float writer is not a requantisation at
    // all — pass it through untouched.
    if (target->isFloatingPoint() || ! shouldDither (target->getBitsPerSample()))
        return target;

    return std::make_unique<TpdfDitherWriter> (std::move (target), kExportDitherSeed);
}

// ─────────────────────────────────────────────────────────────────────────────
// TpdfDitherWriter
// ─────────────────────────────────────────────────────────────────────────────
TpdfDitherWriter::TpdfDitherWriter (std::unique_ptr<juce::AudioFormatWriter> target, std::uint64_t seed)
    // nullptr stream: the wrapped writer owns the OutputStream, and ~AudioFormatWriter
    // only ever does `delete output`, which is a no-op on null.
    : juce::AudioFormatWriter (nullptr,
                               target->getFormatName(),
                               target->getSampleRate(),
                               (unsigned int) target->getNumChannels(),
                               (unsigned int) target->getBitsPerSample()),
      inner (std::move (target)),
      baseSeed (seed)
{
    usesFloatingPointData = false;   // we only ever wrap fixed-point writers
}

void TpdfDitherWriter::ensureCapacity (int numChannels, int numSamples)
{
    while ((int) ditherers.size() < numChannels)
    {
        // Distinct, reproducible per-channel seeds. The odd multiplier keeps successive
        // channel seeds far apart in the generator's state space.
        const std::uint64_t s = baseSeed + 0x9E3779B97F4A7C15ull * (std::uint64_t) (ditherers.size() + 1);
        ditherers.emplace_back ((int) bitsPerSample, s);
    }

    if ((int) scratch.size() < numChannels)
        scratch.resize ((size_t) numChannels);

    for (int c = 0; c < numChannels; ++c)
        if ((int) scratch[(size_t) c].size() < numSamples)
            scratch[(size_t) c].resize ((size_t) numSamples);

    if ((int) pointers.size() < numChannels + 1)
        pointers.resize ((size_t) numChannels + 1);
}

bool TpdfDitherWriter::write (const int** samplesToWrite, int numSamples)
{
    if (inner == nullptr)
        return false;

    if (samplesToWrite == nullptr || numSamples <= 0)
        return inner->write (samplesToWrite, numSamples);

    // The contract (juce_AudioFormatWriter.h) is a ZERO-TERMINATED array of channel
    // pointers whose length need not match the stream's channel count — so count it,
    // never assume numChannels.
    int numIncoming = 0;
    while (samplesToWrite[numIncoming] != nullptr)
        ++numIncoming;

    if (numIncoming == 0)
        return inner->write (samplesToWrite, numSamples);

    ensureCapacity (numIncoming, numSamples);

    for (int c = 0; c < numIncoming; ++c)
    {
        auto& dither = ditherers[(size_t) c];
        const int* src = samplesToWrite[c];
        int* dst = scratch[(size_t) c].data();

        for (int i = 0; i < numSamples; ++i)
            dst[i] = (int) dither.process ((std::int32_t) src[i]);

        pointers[(size_t) c] = dst;
    }

    pointers[(size_t) numIncoming] = nullptr;   // preserve the zero terminator
    return inner->write (pointers.data(), numSamples);
}

bool TpdfDitherWriter::flush()
{
    return inner != nullptr && inner->flush();
}

} // namespace mosh
