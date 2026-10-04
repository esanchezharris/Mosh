// MoshRetuneCli — renders a WAV through Mosh AutoTune's engine, for listening.
//
//   MoshRetuneCli in.wav out.wav [--root 0..11] [--scale chromatic|major|minor]
//                 [--retune ms] [--amount 0..1] [--range cents] [--glide 0..1]
//                 [--mix 0..1] [--lookahead ms] [--chunk frames] [--no-trim]
//
// The input is summed to mono. The output is mono 32-bit float at the input rate,
// trimmed by the engine's reported latency so it lines up with the input (pass
// --no-trim to keep the raw delay). See docs/AUTOTUNE-SCOPE-2026-10-01.md.

#include <juce_audio_formats/juce_audio_formats.h>

#include "plugins/moshfx/retune/RetuneCore.h"

#include <cmath>
#include <cstdio>
#include <memory>
#include <vector>

namespace
{
    int fail (const juce::String& message)
    {
        std::fprintf (stderr, "MoshRetuneCli: %s\n", message.toRawUTF8());
        return 1;
    }

    double rmsDb (const std::vector<float>& samples)
    {
        double energy = 0.0;
        for (const float s : samples)
            energy += (double) s * s;
        return 10.0 * std::log10 (std::max (energy / (double) std::max<std::size_t> (samples.size(), 1), 1.0e-20));
    }
}

int main (int argc, char* argv[])
{
    const juce::StringArray args (argv + 1, argc - 1);
    if (args.size() < 2)
        return fail ("usage: MoshRetuneCli in.wav out.wav [--root N] [--scale chromatic|major|minor] [--retune ms] "
                     "[--amount A] [--range cents] [--glide G] [--mix M] [--lookahead ms] [--chunk N] [--no-trim]");

    mosh::moshfx::retune::RetuneSettings settings;
    int chunk = 512;
    float lookaheadMs = 0.0f;
    bool trim = true;
    for (int i = 2; i < args.size(); ++i)
    {
        const auto& key = args[i];
        if (key == "--no-trim") { trim = false; continue; }
        if (i + 1 >= args.size())
            return fail ("missing value for " + key);
        const auto& value = args[++i];
        if (key == "--root") settings.rootSemitone = value.getIntValue();
        else if (key == "--scale") settings.scale = value == "major" ? 1 : value == "minor" ? 2 : 0;
        else if (key == "--retune") settings.retuneMs = value.getFloatValue();
        else if (key == "--amount") settings.amount = value.getFloatValue();
        else if (key == "--range") settings.maxCorrectionCents = value.getFloatValue();
        else if (key == "--glide") settings.glide = value.getFloatValue();
        else if (key == "--mix") settings.mix = value.getFloatValue();
        else if (key == "--lookahead") lookaheadMs = value.getFloatValue();
        else if (key == "--chunk") chunk = juce::jmax (1, value.getIntValue());
        else return fail ("unknown option " + key);
    }

    juce::AudioFormatManager formats;
    formats.registerBasicFormats();
    const juce::File inputFile = juce::File::getCurrentWorkingDirectory().getChildFile (args[0]);
    std::unique_ptr<juce::AudioFormatReader> reader (formats.createReaderFor (inputFile));
    if (reader == nullptr)
        return fail ("cannot read " + inputFile.getFullPathName());

    const int frames = (int) reader->lengthInSamples;
    juce::AudioBuffer<float> source ((int) reader->numChannels, frames);
    reader->read (&source, 0, frames, 0, true, true);

    std::vector<float> input ((std::size_t) frames, 0.0f);
    for (int ch = 0; ch < source.getNumChannels(); ++ch)
        for (int i = 0; i < frames; ++i)
            input[(std::size_t) i] += source.getSample (ch, i) / (float) source.getNumChannels();

    mosh::moshfx::retune::RetuneCore core;
    if (! core.prepare (reader->sampleRate))
        return fail ("unsupported sample rate");
    core.setLookaheadMs (lookaheadMs);
    const int latency = core.latencySamples();

    // Run past the end by the latency so the tail is not cut off.
    std::vector<float> work (input);
    work.resize (input.size() + (std::size_t) latency, 0.0f);
    long voicedChunks = 0, chunks = 0;
    for (std::size_t at = 0; at < work.size(); at += (std::size_t) chunk)
    {
        const int count = (int) std::min ((std::size_t) chunk, work.size() - at);
        voicedChunks += core.process (work.data() + at, count, settings).voiced ? 1 : 0;
        ++chunks;
    }

    const std::size_t skip = trim ? (std::size_t) latency : 0;
    std::vector<float> output (work.begin() + (std::ptrdiff_t) skip, work.begin() + (std::ptrdiff_t) (skip + input.size()));

    const juce::File outputFile = juce::File::getCurrentWorkingDirectory().getChildFile (args[1]);
    outputFile.deleteFile();
    juce::WavAudioFormat wav;
    std::unique_ptr<juce::FileOutputStream> stream (outputFile.createOutputStream());
    if (stream == nullptr)
        return fail ("cannot write " + outputFile.getFullPathName());
    std::unique_ptr<juce::AudioFormatWriter> writer (wav.createWriterFor (stream.get(), reader->sampleRate, 1, 32, {}, 0));
    if (writer == nullptr)
        return fail ("cannot create a WAV writer");
    stream.release(); // the writer owns it now
    const float* channel = output.data();
    writer->writeFromFloatArrays (&channel, 1, (int) output.size());
    writer.reset();

    std::printf ("%s rate=%.0f frames=%d latency=%d voiced=%.0f%% in_rms=%.2fdB out_rms=%.2fdB\n",
                 outputFile.getFileName().toRawUTF8(), reader->sampleRate, frames, latency,
                 100.0 * (double) voicedChunks / (double) std::max (1L, chunks), rmsDb (input), rmsDb (output));
    return 0;
}
