#pragma once
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_audio_basics/juce_audio_basics.h>
#include <cmath>
namespace mosh {
inline bool stageWavRegionAt44k (const juce::File& sourceFile, double srcStartSec, double srcEndSec,
                                 const juce::File& destWav)
{
    static constexpr double kStageSR   = 44100.0;
    static constexpr int    kStageBits = 16;
    static constexpr int    kStageCh   = 2;   // engine read_wav duplicates mono → stereo anyway

    if (srcEndSec <= srcStartSec) return false;
    juce::AudioFormatManager fm; fm.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader (fm.createReaderFor (sourceFile));
    if (reader == nullptr || reader->sampleRate <= 0.0) return false;

    const double sr = reader->sampleRate;
    const juce::int64 total = reader->lengthInSamples;
    juce::int64 startSamp = juce::jlimit ((juce::int64) 0, total, (juce::int64) std::floor (srcStartSec * sr));
    juce::int64 endSamp   = juce::jlimit (startSamp,       total, (juce::int64) std::ceil  (srcEndSec   * sr));
    const int numSamps = (int) (endSamp - startSamp);
    if (numSamps <= 0) return false;

    const int srcNumCh = (int) juce::jmax ((unsigned) 1, reader->numChannels);
    juce::AudioBuffer<float> srcBuf (srcNumCh, numSamps);
    if (! reader->read (&srcBuf, 0, numSamps, startSamp, true, true)) return false;

    const bool needResample = std::abs (sr - kStageSR) > 1.0e-6;
    const double ratio = sr / kStageSR;   // > 1 downsamples (48k→44.1k)
    // floor keeps outNum*ratio <= numSamps so the interpolator never reads past srcBuf
    // (a sub-sample duration loss, inaudible). For a 44100 source ratio==1 → outNum==numSamps.
    const int outNum = needResample
        ? (int) std::floor ((double) numSamps * kStageSR / sr)
        : numSamps;
    if (outNum <= 0) return false;

    juce::AudioBuffer<float> outBuf (kStageCh, outNum);
    for (int ch = 0; ch < kStageCh; ++ch)
    {
        const int srcCh = juce::jmin (ch, srcNumCh - 1);   // mono → duplicate into L/R
        if (needResample)
        {
            juce::LagrangeInterpolator interp;             // fresh per channel: zeroed history, deterministic
            interp.process (ratio, srcBuf.getReadPointer (srcCh), outBuf.getWritePointer (ch), outNum);
        }
        else
            outBuf.copyFrom (ch, 0, srcBuf, srcCh, 0, outNum);
    }

    destWav.deleteFile();
    std::unique_ptr<juce::FileOutputStream> os (destWav.createOutputStream());
    if (os == nullptr) return false;
    juce::WavAudioFormat wav;
    std::unique_ptr<juce::AudioFormatWriter> writer (
        wav.createWriterFor (os.get(), kStageSR, (unsigned) kStageCh, kStageBits, {}, 0));
    if (writer == nullptr) return false;
    os.release();   // the writer owns the stream now
    const bool wrote = writer->writeFromAudioSampleBuffer (outBuf, 0, outNum);
    writer.reset(); // flush + close before the caller reads the file back
    return wrote;
}

}
