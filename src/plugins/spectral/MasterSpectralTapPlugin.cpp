#include "MasterSpectralTapPlugin.h"
#include "audio/RealtimeAudioGuard.h"

namespace mosh
{

const char* MasterSpectralTapPlugin::xmlTypeName = "moshMasterSpectralTap";

MasterSpectralTapPlugin::MasterSpectralTapPlugin (te::PluginCreationInfo info)
    : te::Plugin (info) {}

void MasterSpectralTapPlugin::applyToBuffer (const te::PluginRenderContext& fc)
{
    MOSH_RT_SCOPE();   // RT-safety tripwire (debug): assert no alloc/lock/IO on this thread
    auto* buf = fc.destBuffer;
    if (buf == nullptr) return;

    const int numCh = buf->getNumChannels();
    const int n     = fc.bufferNumSamples;
    const int start = fc.bufferStartSample;
    if (numCh <= 0 || n <= 0) return;

    // Cache read pointers (no alloc, no per-sample virtual calls).
    const float* rd[8];
    const int ch = juce::jmin (numCh, 8);
    for (int c = 0; c < ch; ++c) rd[c] = buf->getReadPointer (c);
    const float inv = 1.0f / (float) ch;

    int s1, sz1, s2, sz2;
    fifo.prepareToWrite (n, s1, sz1, s2, sz2);   // may be < n if the consumer fell behind → drop oldest excess
    int w = 0;
    for (int i = 0; i < sz1; ++i) { float m = 0.0f; for (int c = 0; c < ch; ++c) m += rd[c][start + w]; ring[s1 + i] = m * inv; ++w; }
    for (int i = 0; i < sz2; ++i) { float m = 0.0f; for (int c = 0; c < ch; ++c) m += rd[c][start + w]; ring[s2 + i] = m * inv; ++w; }
    fifo.finishedWrite (sz1 + sz2);

    // PURE MEASURE: destBuffer is left exactly as received — the master audio
    // passes through bit-for-bit (the RT null-test guarantee).
}

int MasterSpectralTapPlugin::read (float* dest, int maxN)
{
    const int toRead = juce::jmin (fifo.getNumReady(), maxN);
    int s1, sz1, s2, sz2;
    fifo.prepareToRead (toRead, s1, sz1, s2, sz2);
    int w = 0;
    for (int i = 0; i < sz1; ++i) dest[w++] = ring[s1 + i];
    for (int i = 0; i < sz2; ++i) dest[w++] = ring[s2 + i];
    fifo.finishedRead (sz1 + sz2);
    return w;
}

} // namespace mosh
