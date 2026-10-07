// Track-chain presets — the engine-linked proof for "Mosh Clean Lead v0".
//
// Three questions, kept apart on purpose because a pass on one says nothing about the
// others (docs/vocal-presets/VALIDATION-2026-10-01.md reports them separately):
//
//   TABLE   does the pinned processor table in TrackPreset.h describe the plugins this
//           build actually links?  (ids, ranges, and — the part a parameter dump misses —
//           which ValueTree property each parameter and each piece of typed state lives in)
//   DSP     do the stages do what their numbers say?  Measured, not read back: filter
//           response, the compressor's static curve, peaks, latency, block-size and
//           sample-rate behaviour, mono and stereo.
//   COMMAND does apply_track_preset keep its contract?  One undo step, no partial chain,
//           no duplicate on re-apply, nothing else touched, survives save/reload.
//
// None of it is a listening test. Synthetic tones prove the chain is correct, not that
// it sounds good on a voice.
#include "VocalPresetSelfTest.h"
#include "engine/MoshEngine.h"
#include "moshops/MoshOps.h"
#include "moshops/TrackPresetEngine.h"
#include "plugins/mixer/TrackMutePlugin.h"
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_cryptography/juce_cryptography.h>
#include <cmath>
#include <iostream>
#include <vector>

namespace mosh
{
namespace
{
using juce::String;
using juce::var;
using namespace trackpreset;

var object (std::initializer_list<std::pair<const char*, var>> fields)
{
    auto* value = new juce::DynamicObject();
    for (const auto& [name, field] : fields)
        value->setProperty (name, field);
    return var (value);
}

var command (MoshOps& ops, const String& name, var args = {})
{
    auto* value = new juce::DynamicObject();
    value->setProperty ("command", name);
    if (! args.isVoid())
        value->setProperty ("args", args);
    return ops.execute (var (value));
}

bool ok (const var& result)             { return (bool) result.getProperty ("ok", false); }
var dataOf (const var& result)          { return result.getProperty ("data", var()); }
String errorOf (const var& result)      { return result.getProperty ("error", var()).toString(); }

void pumpFor (int milliseconds)
{
    auto* manager = juce::MessageManager::getInstanceWithoutCreating();
    const auto deadline = juce::Time::getMillisecondCounter() + (juce::uint32) milliseconds;
    while (juce::Time::getMillisecondCounter() < deadline)
    {
        if (manager != nullptr) manager->runDispatchLoopUntil (50);
        else juce::Thread::sleep (50);
    }
}

// The same canonical form SelfTest.cpp's undo matrix compares: volatile rails removed,
// numerics rounded, so string equality means STATE equality.
void roundNumbers (var& v)
{
    if (v.isDouble())
    {
        double d = std::round ((double) v * 1e6) / 1e6;
        if (d == 0.0) d = 0.0;
        v = d;
    }
    else if (v.isArray())
    {
        for (auto& e : *v.getArray()) roundNumbers (e);
    }
    else if (auto* o = v.getDynamicObject())
    {
        for (auto& p : o->getProperties())
        {
            var e = p.value;
            roundNumbers (e);
            o->setProperty (p.name, e);
        }
    }
}

String canon (MoshOps& ops)
{
    auto s = ops.snapshot().clone();
    if (auto* o = s.getDynamicObject())
    {
        o->removeProperty ("transport");
        o->removeProperty ("controller");
        if (auto* session = o->getProperty ("session").getDynamicObject())
            for (auto* volatileKey : { "dirty", "recentProjects", "recoveryAvailable", "recoverableCount", "revision" })
                session->removeProperty (volatileKey);
    }
    roundNumbers (s);
    return juce::JSON::toString (s, false);
}

var trackVar (MoshOps& ops, const String& trackId)
{
    const auto snapshot = ops.snapshot();
    if (auto* tracks = snapshot.getProperty ("tracks", var()).getArray())
        for (auto& t : *tracks)
            if (t.getProperty ("id", var()).toString() == trackId)
                return t;
    return {};
}

/** A track's visible rack, as a COPY of the array. Never iterate
    `someTemporaryVar.getArray()` directly: the temporary (and the array it owns) is gone
    by the time the loop body runs. */
juce::Array<var> rackOf (MoshOps& ops, const String& trackId)
{
    const auto plugins = trackVar (ops, trackId).getProperty ("plugins", var());
    if (auto* arr = plugins.getArray())
        return *arr;
    return {};
}

/** The rack rows on a track that carry `presetId`'s tag, in chain order. */
juce::Array<var> presetRows (MoshOps& ops, const String& trackId, const String& presetId)
{
    juce::Array<var> rows;
    for (auto& p : rackOf (ops, trackId))
        if (p.getProperty ("preset", var()).getProperty ("id", var()).toString() == presetId)
            rows.add (p);
    return rows;
}

int rackSize (MoshOps& ops, const String& trackId)   { return rackOf (ops, trackId).size(); }

te::AudioTrack* liveTrack (MoshEngine& eng, const String& trackId)
{
    return te::findAudioTrackForID (eng.edit(), te::EditItemID::fromString (trackId));
}

std::vector<te::Plugin*> ownedPlugins (MoshEngine& eng, const String& trackId, const String& presetId)
{
    std::vector<te::Plugin*> owned;
    if (auto* track = liveTrack (eng, trackId))
        for (auto* p : track->pluginList.getPlugins())
            if (p != nullptr && isOwnedBy (*p, presetId))
                owned.push_back (p);
    return owned;
}

/** Empty when the live owned group on the track is exactly the preset; else the reason. */
String liveGroupMismatch (MoshEngine& eng, const String& trackId, const TrackPreset& preset)
{
    const auto owned = ownedPlugins (eng, trackId, preset.id);
    if (owned.size() != preset.stages.size())
        return "owned plugin count is " + String ((int) owned.size());
    auto* track = liveTrack (eng, trackId);
    for (size_t i = 0; i < owned.size(); ++i)
    {
        if (auto why = stageMismatch (*owned[i], preset.stages[i]); why.isNotEmpty())
            return "stage " + String ((int) i) + ": " + why;
        if ((int) owned[i]->state.getProperty (ids::moshPresetStage, -1) != (int) i)
            return "stage tag out of order";
        if (i > 0 && track->pluginList.indexOf (owned[i]) != track->pluginList.indexOf (owned[i - 1]) + 1)
            return "owned stages are not contiguous";
    }
    return {};
}

// ── audio helpers ───────────────────────────────────────────────────────────────────
juce::AudioBuffer<float> sine (double sampleRate, double seconds, double hz, float amplitude, int channels)
{
    const int n = (int) std::llround (seconds * sampleRate);
    juce::AudioBuffer<float> b (channels, n);
    for (int i = 0; i < n; ++i)
    {
        const float s = amplitude * (float) std::sin (2.0 * juce::MathConstants<double>::pi * hz * i / sampleRate);
        for (int ch = 0; ch < channels; ++ch)
            b.setSample (ch, i, s);
    }
    return b;
}

/** A 1 kHz tone stepping UP through `amplitudes`, `segmentSeconds` each. */
juce::AudioBuffer<float> steppedTone (double sampleRate, const std::vector<float>& amplitudes,
                                      double segmentSeconds, int channels)
{
    const int seg = (int) std::llround (segmentSeconds * sampleRate);
    juce::AudioBuffer<float> b (channels, seg * (int) amplitudes.size());
    for (size_t a = 0; a < amplitudes.size(); ++a)
        for (int i = 0; i < seg; ++i)
        {
            const int at = (int) a * seg + i;
            const float s = amplitudes[a] * (float) std::sin (2.0 * juce::MathConstants<double>::pi * 1000.0 * at / sampleRate);
            for (int ch = 0; ch < channels; ++ch)
                b.setSample (ch, at, s);
        }
    return b;
}

double rmsOf (const juce::AudioBuffer<float>& b, int channel, int start, int count)
{
    double sum = 0.0;
    const float* d = b.getReadPointer (channel);
    for (int i = start; i < start + count; ++i)
        sum += (double) d[i] * (double) d[i];
    return std::sqrt (sum / juce::jmax (1, count));
}

double toDb (double linear)    { return 20.0 * std::log10 (juce::jmax (1.0e-12, linear)); }

bool allFinite (const juce::AudioBuffer<float>& b)
{
    for (int ch = 0; ch < b.getNumChannels(); ++ch)
    {
        const float* d = b.getReadPointer (ch);
        for (int i = 0; i < b.getNumSamples(); ++i)
            if (! std::isfinite (d[i]))
                return false;
    }
    return true;
}

double maxAbsDifference (const juce::AudioBuffer<float>& a, const juce::AudioBuffer<float>& b)
{
    if (a.getNumChannels() != b.getNumChannels() || a.getNumSamples() != b.getNumSamples())
        return 1.0e9;
    double worst = 0.0;
    for (int ch = 0; ch < a.getNumChannels(); ++ch)
        for (int i = 0; i < a.getNumSamples(); ++i)
            worst = juce::jmax (worst, (double) std::abs (a.getSample (ch, i) - b.getSample (ch, i)));
    return worst;
}

/** Run `io` through un-inserted plugins exactly as the playback graph's PluginNode does
    (tracktion_PluginNode.cpp): baseClassInitialise at this rate/block, one
    applyToBufferWithAutomation per block, baseClassDeinitialise. Deinitialising drops
    initialiseCount to 0, so the next call starts from reset filter/envelope state.
    Returns the slowest block in milliseconds — an observation, never a pass/fail. */
double processThrough (const std::vector<te::Plugin::Ptr>& chain, juce::AudioBuffer<float>& io,
                       double sampleRate, int blockSize)
{
    for (auto& p : chain)
        p->baseClassInitialise ({ tracktion::TimePosition(), sampleRate, blockSize });

    double slowestMs = 0.0;
    const auto layout = juce::AudioChannelSet::canonicalChannelSet (io.getNumChannels());
    for (int start = 0; start < io.getNumSamples(); start += blockSize)
    {
        const int n = juce::jmin (blockSize, io.getNumSamples() - start);
        const tracktion::TimeRange time (tracktion::TimePosition::fromSeconds (start / sampleRate),
                                         tracktion::TimePosition::fromSeconds ((start + n) / sampleRate));
        te::PluginRenderContext context (&io, layout, start, n, nullptr, 0.0, time,
                                         /*playing*/ true, /*scrubbing*/ false, /*rendering*/ true,
                                         /*allowBypassedProcessing*/ false);
        const auto began = juce::Time::getHighResolutionTicks();
        for (auto& p : chain)
            p->applyToBufferWithAutomation (context);
        slowestMs = juce::jmax (slowestMs, 1000.0 * juce::Time::highResolutionTicksToSeconds (
                                               juce::Time::getHighResolutionTicks() - began));
    }

    for (auto& p : chain)
        p->baseClassDeinitialise();
    return slowestMs;
}

bool writeWav (const juce::File& file, const juce::AudioBuffer<float>& b, double sampleRate)
{
    file.deleteFile();
    juce::WavAudioFormat format;
    auto stream = file.createOutputStream();
    if (stream == nullptr) return false;
    std::unique_ptr<juce::AudioFormatWriter> writer (
        format.createWriterFor (stream.get(), sampleRate, (unsigned) b.getNumChannels(), 32, {}, 0));
    if (writer == nullptr) return false;
    stream.release();   // the writer owns it now
    return writer->writeFromAudioSampleBuffer (b, 0, b.getNumSamples());
}

bool readWav (const juce::File& file, juce::AudioBuffer<float>& out, double& sampleRate)
{
    juce::AudioFormatManager formats;
    formats.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader (formats.createReaderFor (file));
    if (reader == nullptr || reader->lengthInSamples <= 0) return false;
    out.setSize ((int) reader->numChannels, (int) reader->lengthInSamples);
    sampleRate = reader->sampleRate;
    return reader->read (&out, 0, (int) reader->lengthInSamples, 0, true, true);
}

String sha256 (const juce::File& file)   { return juce::SHA256 (file).toHexString(); }

// Every value here is deliberately NOT the plugin's default, so a readback that matches
// proves the property the table names is the one the parameter really loads from.
const char* const kProbePresetJson = R"json({
  "kind": "mosh.track-chain", "schema": 1,
  "id": "selftest.probe", "revision": 7, "name": "Probe",
  "provenance": { "origin": "selftest" }, "validation": { "listening": "not-run" },
  "target": { "trackType": "audio" },
  "stages": [
    { "processor": "lowpass", "state": { "mode": "highpass" }, "bypassed": false,
      "params": { "frequency": { "value": 1234, "unit": "Hz" } } },
    { "processor": "compressor", "state": { "sidechainTrigger": true }, "bypassed": true,
      "params": {
        "threshold":   { "value": -30,  "unit": "dB" },
        "ratio":       { "value": 4,    "unit": ":1" },
        "attack":      { "value": 5,    "unit": "ms" },
        "release":     { "value": 250,  "unit": "ms" },
        "output gain": { "value": -3,   "unit": "dB" },
        "input gain":  { "value": 6,    "unit": "dB" } } }
  ] })json";

} // namespace

void runVocalPresetSelfTest (MoshEngine& eng, MoshOps& ops, const VocalPresetSelfTestCallbacks& cb)
{
    auto section = [&cb] (const char* name)                    { cb.section (String (juce::CharPointer_UTF8 (name))); };
    auto check   = [&cb] (bool condition, const String& what)  { cb.check (condition, what); };

    // A clean edit: no leftover tracks or master-bus plugins from earlier sections, so an
    // export here is the preset track and nothing else (the precedent is the G1 and
    // stem-export sections, which isolate themselves the same way).
    section ("VOCAL-PRESET: fixture — a clean project and the bundled preset");
    check (ok (command (ops, "new_project", object ({ { "name", "vocal-preset-selftest" } }))),
           "new_project (vocal preset isolation) ok");

    String presetFile;
    {
        const auto listed = command (ops, "list_presets", object ({ { "plugin", kLibraryKey } }));
        check (ok (listed), "list_presets {plugin:'track-chain'} ok");
        if (auto* presets = dataOf (listed).getProperty ("presets", var()).getArray())
            for (auto& p : *presets)
                if (p.getProperty ("name", var()).toString() == "mosh-clean-lead-v0"
                    && p.getProperty ("source", var()).toString() == "bundled")
                    presetFile = p.getProperty ("file", var()).toString();
        check (presetFile.isNotEmpty(), "the bundled track-chain library lists mosh-clean-lead-v0");
    }
    const auto parsed = parseTrackPresetText (juce::File (presetFile).loadFileAsString());
    check (parsed.ok, "the bundled preset passes schema validation" + (parsed.ok ? String() : " — " + parsed.error));
    if (! parsed.ok)
        return;   // nothing below can mean anything
    const auto& preset = parsed.preset;
    const auto presetSha = sha256 (juce::File (presetFile));
    const bool remap = eng.engine().getEngineBehaviour().arePluginsRemappedWhenTempoChanges();

    // ── TABLE ────────────────────────────────────────────────────────────────────────
    section ("VOCAL-PRESET TABLE: the pinned processor table matches the linked engine");
    {
        const auto probe = parseTrackPresetText (kProbePresetJson);
        check (probe.ok, "the all-non-default probe preset parses");
        if (probe.ok)
        {
            for (int si = 0; si < (int) probe.preset.stages.size(); ++si)
            {
                const auto& stage = probe.preset.stages[(size_t) si];
                const String type (stage.processor->type);
                // Creating a stage must record NOTHING on the edit's undo manager: the
                // tree already holds everything the constructors would otherwise write.
                auto& um = eng.edit().getUndoManager();
                const int actionsBefore = um.getNumActionsInCurrentTransaction();
                auto plugin = eng.edit().getPluginCache().createNewPlugin (makeStageState (probe.preset, si, remap));
                check (plugin != nullptr, type + " instantiates from preset state");
                if (plugin == nullptr) continue;
                check (um.getNumActionsInCurrentTransaction() == actionsBefore,
                       type + " is created without a single undoable action (found "
                           + String (um.getNumActionsInCurrentTransaction() - actionsBefore) + ")");

                check (plugin->getPluginType() == type, type + " reports its pinned type id");
                check (plugin->getNumAutomatableParameters() == stage.processor->numParams,
                       type + " has exactly the " + String (stage.processor->numParams)
                           + " parameter(s) the table pins (found "
                           + String (plugin->getNumAutomatableParameters()) + ")");
                for (int i = 0; i < juce::jmin (stage.processor->numParams, plugin->getNumAutomatableParameters()); ++i)
                {
                    const auto& spec = stage.processor->params[i];
                    auto param = plugin->getAutomatableParameter (i);
                    const auto range = param->getValueRange();
                    check (param->paramID == spec.id,
                           type + " parameter " + String (i) + " id is '" + spec.id + "' (engine: '" + param->paramID + "')");
                    check (range.getStart() == spec.nativeMin && range.getEnd() == spec.nativeMax,
                           type + " '" + spec.id + "' range is " + String (spec.nativeMin) + ".." + String (spec.nativeMax)
                               + " (engine: " + String (range.getStart()) + ".." + String (range.getEnd()) + ")");
                }
                // The part a parameter dump cannot show: created from state, every
                // parameter and every piece of typed state came up at the probe's value.
                const auto why = stageMismatch (*plugin, stage);
                check (why.isEmpty(), type + " created from preset state reads back every probe value"
                                          + (why.isEmpty() ? String() : " — " + why));
                check (plugin->getLatencySeconds() == 0.0, type + " declares zero latency");
            }

            // Effective typed state, through the plugin's own members rather than the tree.
            auto hpf = eng.edit().getPluginCache().createNewPlugin (makeStageState (probe.preset, 0, remap));
            auto* lp = dynamic_cast<te::LowPassPlugin*> (hpf.get());
            check (lp != nullptr && lp->mode.get() == "highpass" && ! lp->isLowPass(),
                   "lowpass 'mode' state really selects the high-pass filter");
            check (lp != nullptr && std::abs (lp->frequency->getCurrentValue() - 1234.0f) < 0.01f,
                   "lowpass frequency PARAMETER (what the filter reads) is the probe's 1234 Hz");
            auto comp = eng.edit().getPluginCache().createNewPlugin (makeStageState (probe.preset, 1, remap));
            auto* cp = dynamic_cast<te::CompressorPlugin*> (comp.get());
            check (cp != nullptr && cp->useSidechainTrigger.get(), "compressor 'sidechainTrigger' state reaches the plugin");
            check (cp != nullptr && ! cp->isEnabled(), "a bypassed stage is created disabled");
            check (cp != nullptr && std::abs (cp->getRatio() - 0.25f) < 1.0e-6f,
                   "compressor ratio 4:1 is held as slope 0.25 (reciprocal encoding)");
            check (cp != nullptr && std::abs (cp->getThreshold() - 0.0316228f) < 1.0e-6f,
                   "compressor threshold -30 dB is held as linear gain 0.0316");
            check (comp != nullptr && comp->getAutomatableParameterByID ("ratio")->getCurrentValueAsString() == "4.00 : 1",
                   "the engine's own display reads the stored slope back as '4.00 : 1'");
        }
    }

    // ── DSP ──────────────────────────────────────────────────────────────────────────
    section ("VOCAL-PRESET DSP: measured behaviour of the bundled chain");
    {
        // Fresh, un-inserted instances of exactly the state the command inserts.
        std::vector<te::Plugin::Ptr> chain;
        for (int si = 0; si < (int) preset.stages.size(); ++si)
            chain.push_back (eng.edit().getPluginCache().createNewPlugin (makeStageState (preset, si, remap)));
        const bool built = chain.size() == 2 && chain[0] != nullptr && chain[1] != nullptr
                        && String (preset.stages[0].processor->type) == "lowpass"
                        && String (preset.stages[1].processor->type) == "compressor";
        check (built, "the bundled chain is high-pass -> compressor and both stages instantiate");
        if (built)
        {
            const std::vector<te::Plugin::Ptr> hpfOnly { chain[0] }, compOnly { chain[1] };
            const double cutoff = preset.stages[0].params[0].native;
            const float threshold  = preset.stages[1].params[0].native;       // linear gain
            const float slope      = preset.stages[1].params[1].native;       // 1 / ratio
            const double outGainDb = preset.stages[1].params[4].native;

            // Second-order Butterworth high-pass magnitude, the response
            // juce::IIRCoefficients::makeHighPass (Q = 1/sqrt 2) is designed to.
            auto butterworthDb = [cutoff] (double hz)
            {
                const double r = hz / cutoff;
                return toDb ((r * r) / std::sqrt (1.0 + r * r * r * r));
            };

            // Levels are placed relative to the preset's own threshold so the test keeps
            // meaning if the numbers are retuned: one tone whose PEAK is under the
            // threshold (the detector can never exceed the peak, so no reduction is
            // possible), then three well above it.
            const std::vector<float> levels { 0.5f * threshold, 2.0f * threshold,
                                              juce::jmin (0.6f, 8.0f * threshold),
                                              juce::jmin (0.98f, 16.0f * threshold) };
            const double segmentSeconds = 0.6;

            std::map<int, double> gainAtTopBySampleRate;   // for the 44.1k <-> 48k comparison
            for (const double sampleRate : { 44100.0, 48000.0 })
            {
                for (const int channels : { 1, 2 })
                {
                    const String cfg = String ((int) sampleRate) + " Hz " + (channels == 1 ? "mono" : "stereo");
                    juce::AudioBuffer<float> reference;   // block-64 output of the stepped tone
                    double slowestMs = 0.0;

                    for (const int blockSize : { 64, 128, 256 })
                    {
                        const String at = cfg + " / " + String (blockSize);

                        // Silence in, silence out — no DC, no denormal residue, no noise.
                        juce::AudioBuffer<float> silence (channels, (int) (0.25 * sampleRate));
                        silence.clear();
                        slowestMs = juce::jmax (slowestMs, processThrough (chain, silence, sampleRate, blockSize));
                        check (silence.getMagnitude (0, silence.getNumSamples()) == 0.0f, at + ": silence stays digital silence");

                        // An impulse: finite, and the first output sample is the first input
                        // sample — the chain adds no latency and does not pre-ring.
                        juce::AudioBuffer<float> impulse (channels, 4096);
                        impulse.clear();
                        for (int ch = 0; ch < channels; ++ch) impulse.setSample (ch, 100, 0.5f);
                        processThrough (chain, impulse, sampleRate, blockSize);
                        int firstNonZero = -1;
                        for (int i = 0; i < impulse.getNumSamples() && firstNonZero < 0; ++i)
                            if (std::abs (impulse.getSample (0, i)) > 1.0e-9f) firstNonZero = i;
                        check (allFinite (impulse) && firstNonZero == 100,
                               at + ": impulse response is finite and starts at the input sample (no added latency)");

                        // The stepped tone through the whole chain.
                        auto dry = steppedTone (sampleRate, levels, segmentSeconds, channels);
                        auto wet = dry;
                        slowestMs = juce::jmax (slowestMs, processThrough (chain, wet, sampleRate, blockSize));
                        check (allFinite (wet), at + ": stepped tone output is finite");
                        check (wet.getMagnitude (0, wet.getNumSamples()) <= dry.getMagnitude (0, dry.getNumSamples()) + 1.0e-6f,
                               at + ": on the stepped tone the output peak does not exceed the input peak");

                        if (blockSize == 64)
                            reference = wet;
                        else
                            check (maxAbsDifference (wet, reference) <= 1.0e-6,
                                   at + ": output is identical to the 64-sample-block render (block-size invariant)");
                    }

                    // ── high-pass response (block size already shown not to matter) ──
                    auto hpfGainDb = [&] (double hz)
                    {
                        auto in = sine (sampleRate, 1.0, hz, 0.25f, channels);
                        auto out = in;
                        processThrough (hpfOnly, out, sampleRate, 128);
                        const int half = in.getNumSamples() / 2;
                        return toDb (rmsOf (out, channels - 1, half, half) / rmsOf (in, channels - 1, half, half));
                    };
                    const double atCutoff = hpfGainDb (cutoff), below = hpfGainDb (cutoff / 2.0),
                                 above = hpfGainDb (cutoff * 2.0), voice = hpfGainDb (1000.0);
                    check (std::abs (atCutoff - butterworthDb (cutoff)) <= 0.35,
                           cfg + ": high-pass is " + String (atCutoff, 2) + " dB at its " + String (cutoff, 0)
                               + " Hz corner (2nd-order Butterworth: -3.01)");
                    check (std::abs (below - butterworthDb (cutoff / 2.0)) <= 0.6,
                           cfg + ": high-pass is " + String (below, 2) + " dB an octave below (design: "
                               + String (butterworthDb (cutoff / 2.0), 2) + ", 12 dB/oct)");
                    check (std::abs (above - butterworthDb (cutoff * 2.0)) <= 0.3,
                           cfg + ": high-pass is " + String (above, 2) + " dB an octave above (design: "
                               + String (butterworthDb (cutoff * 2.0), 2) + ")");
                    check (std::abs (voice) <= 0.2,
                           cfg + ": high-pass leaves 1 kHz alone (" + String (voice, 3) + " dB)");

                    // ── compressor static curve ──
                    // Steady-state gain per level, compressor alone, last 0.25 s of each step.
                    auto dry = steppedTone (sampleRate, levels, segmentSeconds, channels);
                    auto wet = dry;
                    processThrough (compOnly, wet, sampleRate, 128);
                    const int seg = (int) std::llround (segmentSeconds * sampleRate);
                    const int window = (int) (0.25 * sampleRate);
                    std::vector<double> gain;   // linear, per level
                    for (size_t a = 0; a < levels.size(); ++a)
                    {
                        const int start = (int) (a + 1) * seg - window;
                        gain.push_back (rmsOf (wet, channels - 1, start, window) / rmsOf (dry, channels - 1, start, window));
                    }

                    check (std::abs (toDb (gain[0]) - outGainDb) <= 0.02,
                           cfg + ": a tone peaking under the threshold passes at the output trim ("
                               + String (toDb (gain[0]), 3) + " dB, trim " + String (outGainDb, 1) + ")");
                    check (gain[1] <= gain[0] + 1.0e-4 && gain[2] < gain[1] && gain[3] < gain[2],
                           cfg + ": gain falls monotonically as level rises ("
                               + String (toDb (gain[0]), 2) + " / " + String (toDb (gain[1]), 2) + " / "
                               + String (toDb (gain[2]), 2) + " / " + String (toDb (gain[3]), 2) + " dB)");
                    // THE anti-vacuity check for the 2026-09-06 "does not compress" finding.
                    check (toDb (gain[3]) - outGainDb <= -1.5,
                           cfg + ": the compressor measurably compresses — " + String (toDb (gain[3]) - outGainDb, 2)
                               + " dB of gain reduction at " + String (toDb (levels[3]), 1) + " dBFS peak");

                    // The pinned formula is  gain = (th + (L - th) * slope) / L  with L the
                    // DETECTOR level, a smoothed rectified average — not peak, not RMS. So
                    // solve for the detector constant k = L / peak from one level, and demand
                    // the formula then predicts the other. k itself must sit between the
                    // rectified mean of a sine (0.637) and its peak (1.0).
                    const double k = threshold * (1.0 - slope) / (levels[2] * (gain[2] / juce::Decibels::decibelsToGain (outGainDb) - slope));
                    check (k > 0.55 && k < 1.0,
                           cfg + ": detector reads " + String (k, 3) + " x peak for a sine (between rectified mean 0.637 and peak 1.0)");
                    const double predictedTop = juce::Decibels::decibelsToGain (outGainDb)
                                                  * (threshold + (k * levels[3] - threshold) * slope) / (k * levels[3]);
                    check (std::abs (toDb (gain[3]) - toDb (predictedTop)) <= 0.5,
                           cfg + ": the pinned amplitude-domain formula predicts the top step ("
                               + String (toDb (gain[3]), 2) + " dB measured, " + String (toDb (predictedTop), 2) + " predicted)");

                    if (channels == 2)
                        gainAtTopBySampleRate[(int) sampleRate] = toDb (gain[3]);

                    // Realtime headroom, recorded only. A 64-sample block at 48 kHz is 1.33 ms.
                    std::cerr << "  note  VOCAL-PRESET DSP " << cfg.toStdString()
                              << ": slowest block through both stages " << String (slowestMs, 4).toStdString()
                              << " ms (observation, not a gate)" << std::endl;
                }
            }
            check (std::abs (gainAtTopBySampleRate[44100] - gainAtTopBySampleRate[48000]) <= 0.5,
                   "44.1 kHz and 48 kHz agree on the top-step gain within 0.5 dB ("
                       + String (gainAtTopBySampleRate[44100], 2) + " vs " + String (gainAtTopBySampleRate[48000], 2)
                       + " dB; the detector's pre-filter is per-sample, so they are not identical)");
        }
    }

    // ── COMMAND ──────────────────────────────────────────────────────────────────────
    section ("VOCAL-PRESET APPLY: one transaction, read back, pre-fader, tagged");
    auto newTrack = [&] (const char* name)
    {
        return dataOf (command (ops, "create_track", object ({ { "name", name } }))).getProperty ("trackId", var()).toString();
    };
    auto apply = [&] (const String& trackId, const String& file)
    {
        return command (ops, "apply_track_preset", object ({ { "trackId", trackId }, { "file", file } }));
    };

    const auto vox = newTrack ("VP Vox");
    const auto other = newTrack ("VP Other");
    check (vox.isNotEmpty() && other.isNotEmpty(), "fixture tracks created");

    // The dry recording: a stepped 1 kHz tone, imported as a clip. Its source file is
    // hashed now and again at the very end.
    const std::vector<float> clipLevels { 0.5f * preset.stages[1].params[0].native,
                                          2.0f * preset.stages[1].params[0].native,
                                          juce::jmin (0.6f, 8.0f * preset.stages[1].params[0].native),
                                          juce::jmin (0.98f, 16.0f * preset.stages[1].params[0].native) };
    const auto toneFile = cb.tempPath ("vp-stepped-tone.wav");
    check (writeWav (toneFile, steppedTone (48000.0, clipLevels, 0.6, 2), 48000.0), "stepped-tone fixture written");
    const auto imported = command (ops, "import_clip", object ({ { "trackId", vox }, { "file", toneFile.getFullPathName() } }));
    check (ok (imported), "import_clip (the 'dry recording') ok");
    const juce::File sessionCopy (dataOf (imported).getProperty ("file", var()).toString());
    const auto toneSha = sha256 (toneFile);
    const auto copySha = sessionCopy.existsAsFile() ? sha256 (sessionCopy) : String();
    const auto clipsBefore = juce::JSON::toString (trackVar (ops, vox).getProperty ("clips", var()));

    // A user effect that must survive untouched.
    check (ok (command (ops, "load_builtin", object ({ { "trackId", vox }, { "type", "4bandEq" } }))), "user EQ loaded on the vocal track");
    auto userEqRow = [&]
    {
        for (auto& p : rackOf (ops, vox))
            if (p.getProperty ("type", var()).toString() == "4bandEq")
            {
                auto copy = p.clone();
                copy.getDynamicObject()->removeProperty ("index");   // position may shift; content may not
                return juce::JSON::toString (copy);
            }
        return String();
    };
    const auto eqBefore = userEqRow();
    check (eqBefore.isNotEmpty(), "the user EQ row is visible in the rack");

    // Tracktion sorts the edit's top-level nodes on a deferred callback after a track is
    // created, and writes that sort THROUGH the UndoManager. Headless, it fires on the
    // next message-loop pump — as its own transaction, which would silently eat a pending
    // redo. Let it land now, before anything here depends on the undo history. (The GUI
    // pumps between commands, so there it joins the creating command's transaction.)
    auto settle = [] { pumpFor (250); };
    settle();

    auto exportTo = [&] (const char* leaf, double sampleRate)
    {
        auto file = cb.tempPath (leaf);
        file.deleteFile();
        const auto r = command (ops, "export_audio", object ({ { "file", file.getFullPathName() }, { "format", "wav" },
                                                                { "bitDepth", 32 }, { "sampleRate", sampleRate },
                                                                { "range", "full" } }));
        check (ok (r), String ("export_audio ") + leaf + " ok" + (ok (r) ? String() : " — " + errorOf (r)));
        return file;
    };
    const auto dryExport = exportTo ("vp-dry.wav", 48000.0);

    const auto beforeApply = canon (ops);
    const auto applied = apply (vox, presetFile);
    check (ok (applied), "apply_track_preset ok" + (ok (applied) ? String() : " — " + errorOf (applied)));
    {
        const auto d = dataOf (applied);
        check (d.getProperty ("presetId", var()).toString() == preset.id
                   && d.getProperty ("name", var()).toString() == preset.name
                   && (int) d.getProperty ("revision", -1) == preset.revision,
               "result names the preset it applied (id, name, revision)");
        check ((bool) d.getProperty ("changed", false) && ! (bool) d.getProperty ("replaced", true),
               "first application reports changed:true, replaced:false");

        const auto stages = d.getProperty ("stages", var());
        check (stages.size() == (int) preset.stages.size(), "result reports one readback per stage");
        bool unitsMatch = stages.size() == (int) preset.stages.size();
        for (int si = 0; unitsMatch && si < stages.size(); ++si)
        {
            const auto& stage = preset.stages[(size_t) si];
            const auto params = stages[si].getProperty ("params", var());
            unitsMatch = params.size() == (int) stage.params.size();
            for (int pi = 0; unitsMatch && pi < params.size(); ++pi)
            {
                const double want = stage.params[(size_t) pi].canonical;
                const double got = (double) params[pi].getProperty ("value", 1.0e9);
                unitsMatch = std::abs (got - want) <= 1.0e-3 * juce::jmax (1.0, std::abs (want))
                          && params[pi].getProperty ("unit", var()).toString() == stage.params[(size_t) pi].spec->unit
                          && params[pi].getProperty ("display", var()).toString().isNotEmpty();
            }
        }
        check (unitsMatch, "every parameter reads back in the preset's own unit at the preset's value");
        for (int si = 0; si < stages.size(); ++si)
            for (auto& rp : *stages[si].getProperty ("params", var()).getArray())
                std::cerr << "  note  VOCAL-PRESET READBACK stage " << si << " ("
                          << stages[si].getProperty ("processor", var()).toString().toStdString() << ") "
                          << rp.getProperty ("id", var()).toString().toStdString() << ": native "
                          << String ((double) rp.getProperty ("native", 0.0), 6).toStdString() << " = "
                          << String ((double) rp.getProperty ("value", 0.0), 3).toStdString() << " "
                          << rp.getProperty ("unit", var()).toString().toStdString() << ", engine display \""
                          << rp.getProperty ("display", var()).toString().toStdString() << "\"" << std::endl;
        check (stages[0].getProperty ("state", var()).getProperty ("mode", var()).toString() == "highpass",
               "stage 1 reads back mode 'highpass'");
        check (stages.size() > 1 && (int) stages[1].getProperty ("index", -1) == (int) stages[0].getProperty ("index", -9) + 1,
               "the two stages sit next to each other, high-pass first");
    }
    check (liveGroupMismatch (eng, vox, preset).isEmpty(),
           "the LIVE plugins hold the preset (parameters the DSP reads, typed state, bypass, order)"
               + (liveGroupMismatch (eng, vox, preset).isEmpty() ? String() : " — " + liveGroupMismatch (eng, vox, preset)));
    {
        const auto rows = presetRows (ops, vox, preset.id);
        check (rows.size() == 2, "the snapshot shows two rack rows tagged with the preset");
        if (rows.size() == 2)
        {
            check (rows[0].getProperty ("type", var()).toString() == "highpass"
                       && rows[1].getProperty ("type", var()).toString() == "compressor",
                   "rows are the high-pass and the compressor, in that order");
            check (rows[0].getProperty ("preset", var()).getProperty ("name", var()).toString() == preset.name
                       && (int) rows[0].getProperty ("preset", var()).getProperty ("stage", -1) == 0
                       && (int) rows[1].getProperty ("preset", var()).getProperty ("stage", -1) == 1
                       && (int) rows[1].getProperty ("preset", var()).getProperty ("revision", -1) == preset.revision,
                   "each row carries the preset name, revision and stage");
            check ((bool) rows[0].getProperty ("enabled", false) && (bool) rows[1].getProperty ("enabled", false),
                   "both stages are enabled (existing bypass state is exposed per row)");
            check (rows[0].getProperty ("params", var())[0].getProperty ("display", var()).toString()
                       == String (juce::roundToInt (preset.stages[0].params[0].native)) + " Hz",
                   "the high-pass row displays its corner in Hz");
            check (rows[1].getProperty ("params", var()).size() == 6, "the compressor row exposes all six parameters");
            check (rows[1].getProperty ("params", var())[1].getProperty ("display", var()).toString().endsWith (": 1"),
                   "the compressor row displays its ratio as N : 1");
        }
        check (userEqRow() == eqBefore, "the user's own EQ is unchanged (same parameters, still present)");
        check (rackSize (ops, vox) == 3, "the rack now holds the user EQ plus the two preset stages");
    }
    check (juce::JSON::toString (trackVar (ops, vox).getProperty ("clips", var())) == clipsBefore,
           "the clip (timing, source, gain) is unchanged by applying the preset");

    section ("VOCAL-PRESET UNDO: one step out, one step back, even after the plugin objects are purged");
    check (ok (command (ops, "undo")), "undo ok");
    check (canon (ops) == beforeApply, "ONE undo restores the canonical pre-apply snapshot");
    check (ownedPlugins (eng, vox, preset.id).empty(), "no preset stage remains on the track after undo");
    check (ok (command (ops, "redo")), "redo ok");
    check (liveGroupMismatch (eng, vox, preset).isEmpty(), "redo restores the chain with its effective parameter values");
    check (ok (command (ops, "undo")), "undo again ok");
    pumpFor (1300);   // past te::PluginCache's 1 s purge: the plugin C++ objects are really destroyed
    check (ok (command (ops, "redo")), "redo after the cache purge ok");
    check (liveGroupMismatch (eng, vox, preset).isEmpty(),
           "plugins RE-CREATED from the undone state still hold the preset values"
               + (liveGroupMismatch (eng, vox, preset).isEmpty() ? String() : " — " + liveGroupMismatch (eng, vox, preset)));

    section ("VOCAL-PRESET RENDER: the track render matches the measured curve, pre-fader");
    std::vector<double> renderGainDb;
    double wetTopStepRms = 0.0;   // absolute level of the loudest step in the 48 kHz render
    {
        const auto wetExport = exportTo ("vp-wet.wav", 48000.0);
        juce::AudioBuffer<float> dry, wet;
        double drySr = 0.0, wetSr = 0.0;
        const bool readable = readWav (dryExport, dry, drySr) && readWav (wetExport, wet, wetSr);
        check (readable && drySr == 48000.0 && wetSr == 48000.0, "dry and processed exports are readable 48 kHz files");
        if (readable)
        {
            const int seg = (int) (0.6 * 48000.0), window = (int) (0.25 * 48000.0);
            check (wet.getNumSamples() >= 4 * seg && dry.getNumSamples() >= 4 * seg, "exports cover the whole clip");
            check (allFinite (wet), "processed export is finite");
            if (wet.getNumSamples() >= 4 * seg && dry.getNumSamples() >= 4 * seg)
            {
                for (int a = 0; a < 4; ++a)
                {
                    const int start = (a + 1) * seg - window;
                    renderGainDb.push_back (toDb (rmsOf (wet, 0, start, window) / rmsOf (dry, 0, start, window)));
                    if (a == 3) wetTopStepRms = rmsOf (wet, 0, start, window);
                }
                check (std::abs (renderGainDb[0]) <= 0.05,
                       "under-threshold step is unchanged in the track render (" + String (renderGainDb[0], 3) + " dB)");
                check (renderGainDb[3] <= -1.5 && renderGainDb[3] < renderGainDb[2] && renderGainDb[2] < renderGainDb[1] + 1.0e-3,
                       "the track render shows the same rising gain reduction ("
                           + String (renderGainDb[1], 2) + " / " + String (renderGainDb[2], 2) + " / " + String (renderGainDb[3], 2) + " dB)");
                check (wet.getMagnitude (0, wet.getNumSamples()) <= dry.getMagnitude (0, dry.getNumSamples()) + 1.0e-5f,
                       "processed track peak does not exceed the dry track peak");
            }
        }

        // Pre-fader: the fader is created on first touch and must land AFTER the chain,
        // so pulling it down changes the level, not the amount of compression.
        check (ok (command (ops, "set_track_volume", object ({ { "trackId", vox }, { "db", -12.0 } }))), "set_track_volume -12 dB ok");
        if (auto* track = liveTrack (eng, vox))
        {
            const auto owned = ownedPlugins (eng, vox, preset.id);
            check (owned.size() == 2 && track->getVolumePlugin() != nullptr
                       && track->pluginList.indexOf (owned.back()) < track->pluginList.indexOf (track->getVolumePlugin()),
                   "the lazily created fader sits after the preset stages");
        }
        const auto fadedExport = exportTo ("vp-wet-faded.wav", 48000.0);
        juce::AudioBuffer<float> faded;
        double fadedSr = 0.0;
        if (readWav (fadedExport, faded, fadedSr) && readable && renderGainDb.size() == 4)
        {
            const int seg = (int) (0.6 * 48000.0), window = (int) (0.25 * 48000.0);
            bool preFader = true;
            for (int a = 0; a < 4; ++a)
            {
                const int start = (a + 1) * seg - window;
                const double db = toDb (rmsOf (faded, 0, start, window) / rmsOf (dry, 0, start, window));
                preFader = preFader && std::abs ((db - renderGainDb[(size_t) a]) - (-12.0)) <= 0.2;
            }
            check (preFader, "a -12 dB fader move shifts every step by -12 dB: the gain reduction is unchanged (chain is pre-fader)");
        }
        else
            check (false, "faded export readable");
        check (ok (command (ops, "undo")), "undo the fader move");

        // 44.1 kHz render of the same track (the 48 kHz source is resampled by the engine).
        const auto wet441 = exportTo ("vp-wet-44k1.wav", 44100.0);
        juce::AudioBuffer<float> low;
        double lowSr = 0.0;
        if (readWav (wet441, low, lowSr) && lowSr == 44100.0 && renderGainDb.size() == 4)
        {
            const int seg = (int) (0.6 * 44100.0), window = (int) (0.25 * 44100.0);
            const int start = 4 * seg - window;
            const double topLevel = rmsOf (low, 0, start, window);
            check (allFinite (low) && wetTopStepRms > 0.0 && std::abs (toDb (topLevel / wetTopStepRms)) <= 0.6,
                   "a 44.1 kHz render of the same track lands within 0.6 dB of the 48 kHz one on the top step ("
                       + String (toDb (topLevel / juce::jmax (1.0e-9, wetTopStepRms)), 2) + " dB apart)");
        }
        else
            check (false, "44.1 kHz export readable at 44.1 kHz");

        for (auto* leaf : { "vp-wet.wav", "vp-wet-faded.wav", "vp-wet-44k1.wav" })
            cb.tempPath (leaf).deleteFile();
    }

    section ("VOCAL-PRESET REAPPLY: no duplicate, and only the preset's own group is replaced");
    {
        // The G14 probe: a real edit, then a no-op re-apply, then ONE undo must revert
        // the real edit — proving the no-op opened no transaction of its own.
        check (ok (command (ops, "rename_track", object ({ { "trackId", vox }, { "name", "VP Vox Renamed" } }))), "a real edit before the no-op");
        const auto beforeNoop = canon (ops);
        const auto again = apply (vox, presetFile);
        check (ok (again) && ! (bool) dataOf (again).getProperty ("changed", true),
               "re-applying an intact, unmodified preset reports changed:false");
        check (dataOf (again).getProperty ("stages", var()).size() == 2, "…and still reports the live readback");
        check (canon (ops) == beforeNoop && presetRows (ops, vox, preset.id).size() == 2 && rackSize (ops, vox) == 3,
               "…and changes nothing: still exactly two preset rows");
        check (ok (command (ops, "undo")), "undo after the no-op");
        check (trackVar (ops, vox).getProperty ("name", var()).toString() == "VP Vox",
               "that undo reverted the EARLIER real edit (the no-op left no transaction behind)");

        // Tweak a preset parameter, then re-apply: reset in place, one undo returns the tweak.
        const auto rows = presetRows (ops, vox, preset.id);
        const int compIndex = rows.size() == 2 ? (int) rows[1].getProperty ("index", -1) : -1;
        check (ok (command (ops, "set_plugin_param", object ({ { "trackId", vox }, { "index", compIndex },
                                                                { "paramIndex", 2 }, { "value", 0.9 } }))),
               "user tweaks the preset compressor's attack");
        const auto tweaked = canon (ops);
        check (liveGroupMismatch (eng, vox, preset).isNotEmpty(), "the tweaked group no longer equals the preset");
        const auto reset = apply (vox, presetFile);
        check (ok (reset) && (bool) dataOf (reset).getProperty ("changed", false) && (bool) dataOf (reset).getProperty ("replaced", false),
               "re-applying over a tweaked group reports changed:true, replaced:true");
        check (liveGroupMismatch (eng, vox, preset).isEmpty() && presetRows (ops, vox, preset.id).size() == 2
                   && rackSize (ops, vox) == 3,
               "…the group is back at the preset values and there are still exactly two preset rows");
        check (userEqRow() == eqBefore, "…and the user's EQ was not touched by the replace");
        check (ok (command (ops, "undo")), "undo the re-apply");
        check (canon (ops) == tweaked, "ONE undo of a re-apply restores the user's tweaked chain exactly");
        check (ok (command (ops, "redo")), "redo the re-apply");

        // A steepened preset filter is no longer the preset: re-applying restores
        // 12 dB/oct. (A preset file cannot name a slope, so the filter it builds runs at
        // Tracktion's 12; stageMismatch requires that, TrackPresetEngine.h.)
        {
            auto hpSlope = [&]
            {
                const auto group = presetRows (ops, vox, preset.id);
                return group.size() == 2 ? (int) group[0].getProperty ("state", var()).getProperty ("slope", var()).getProperty ("value", -1)
                                         : -1;
            };
            const auto rowsBefore = presetRows (ops, vox, preset.id);
            const int hpIndex = rowsBefore.size() == 2 ? (int) rowsBefore[0].getProperty ("index", -1) : -1;
            check (hpSlope() == 12, "the preset's high-pass runs at 12 dB/oct");
            check (ok (command (ops, "set_plugin_state", object ({ { "trackId", vox }, { "index", hpIndex },
                                                                    { "key", "slope" }, { "value", 48 } })))
                       && hpSlope() == 48,
                   "user steepens the preset's high-pass to 48 dB/oct");
            const auto mismatch = liveGroupMismatch (eng, vox, preset);
            check (mismatch.contains ("slope is 48 dB/oct"), "the steepened group no longer equals the preset (" + mismatch + ")");
            const auto steep = canon (ops);
            const auto restored = apply (vox, presetFile);
            check (ok (restored) && (bool) dataOf (restored).getProperty ("changed", false)
                       && (bool) dataOf (restored).getProperty ("replaced", false),
                   "re-applying over the steepened filter reports changed:true, replaced:true");
            check (hpSlope() == 12 && liveGroupMismatch (eng, vox, preset).isEmpty() && presetRows (ops, vox, preset.id).size() == 2,
                   "...the preset's high-pass is back at 12 dB/oct, still exactly two preset rows");
            const auto stages = dataOf (restored).getProperty ("stages", var());
            check (stages.size() == 2 && (int) stages[0].getProperty ("state", var()).getProperty ("slope", -1) == 12
                       && stages[0].getProperty ("state", var()).getProperty ("mode", var()).toString() == "highpass",
                   "...and the high-pass stage reads back slope 12 beside mode 'highpass'");
            check (ok (command (ops, "undo")) && canon (ops) == steep && hpSlope() == 48,
                   "ONE undo brings the user's 48 dB/oct filter back exactly");
            check (ok (command (ops, "redo")) && hpSlope() == 12, "redo the re-apply (12 dB/oct)");
        }

        // A partial group (the user deleted one stage) is completed, not doubled.
        const auto rowsNow = presetRows (ops, vox, preset.id);
        check (ok (command (ops, "remove_plugin", object ({ { "trackId", vox },
                                                             { "index", rowsNow.size() == 2 ? (int) rowsNow[0].getProperty ("index", -1) : -1 } }))),
               "user removes the preset's high-pass");
        check (presetRows (ops, vox, preset.id).size() == 1, "one preset stage remains");
        check (ok (apply (vox, presetFile)) && liveGroupMismatch (eng, vox, preset).isEmpty()
                   && presetRows (ops, vox, preset.id).size() == 2,
               "re-applying over a partial group rebuilds a complete, ordered two-stage group");
    }

    section ("VOCAL-PRESET ISOLATION: another track, sends, fader, automation");
    {
        // `other` gets a fader, a send and a user plugin with automation BEFORE the preset.
        const int bus = (int) dataOf (command (ops, "create_bus", object ({ { "name", "VP Bus" } }))).getProperty ("busNumber", -1);
        check (bus >= 0, "fixture bus created");
        settle();
        check (ok (command (ops, "set_track_volume", object ({ { "trackId", other }, { "db", -4.0 } }))), "fader touched on the second track");
        check (ok (command (ops, "add_send", object ({ { "trackId", other }, { "bus", bus }, { "db", -9.0 } }))), "send added on the second track");
        // A user delay with an automation point (the engine's chorus has no automatable
        // parameters, so it could not carry one).
        const auto userFx = command (ops, "load_builtin", object ({ { "trackId", other }, { "type", "delay" } }));
        const int userFxIndex = (int) dataOf (userFx).getProperty ("index", -1);
        const auto point = command (ops, "add_automation_point", object ({ { "trackId", other }, { "pluginIndex", userFxIndex },
                                                                           { "paramIndex", 0 }, { "time", 1.0 }, { "value", 0.5 } }));
        check (ok (userFx) && ok (point), "automation point written on the second track's user plugin"
                                              + (ok (point) ? String() : " — " + errorOf (userFx) + " / " + errorOf (point)));

        auto strip = [&] (const String& trackId)
        {
            // Everything about a track EXCEPT the preset rows and raw list positions,
            // which legitimately shift when the chain is inserted ahead of sends/fader.
            auto t = trackVar (ops, trackId).clone();
            std::function<void (var&)> dropPositions = [&dropPositions] (var& v)
            {
                if (auto* arr = v.getArray())
                    for (auto& e : *arr) dropPositions (e);
                else if (auto* o = v.getDynamicObject())
                {
                    for (auto* key : { "index", "pluginIndex" })
                        o->removeProperty (key);
                    for (auto& p : o->getProperties())
                    {
                        var child = p.value;
                        dropPositions (child);
                    }
                }
            };
            if (auto* o = t.getDynamicObject())
            {
                juce::Array<var> kept;
                if (auto* plugins = o->getProperty ("plugins").getArray())
                    for (auto& p : *plugins)
                        if (! p.hasProperty ("preset"))
                            kept.add (p);
                o->setProperty ("plugins", kept);
                o->removeProperty ("muteGateIndex");
            }
            dropPositions (t);
            return juce::JSON::toString (t);
        };
        const auto otherBefore = strip (other);
        const auto voxBefore = juce::JSON::toString (trackVar (ops, vox));

        check (ok (apply (other, presetFile)), "apply to the second track ok");
        check (juce::JSON::toString (trackVar (ops, vox)) == voxBefore,
               "the first track's snapshot is byte-identical after applying to the second");
        check (strip (other) == otherBefore,
               "on the second track the fader level, send, user plugin and its automation are unchanged");
        if (auto* track = liveTrack (eng, other))
        {
            const auto owned = ownedPlugins (eng, other, preset.id);
            int firstSend = -1;
            for (auto* p : track->pluginList.getPlugins())
                if (firstSend < 0 && dynamic_cast<te::AuxSendPlugin*> (p) != nullptr)
                    firstSend = track->pluginList.indexOf (p);
            const int fader = track->pluginList.indexOf (track->getVolumePlugin());
            check (owned.size() == 2 && firstSend >= 0 && fader >= 0
                       && track->pluginList.indexOf (owned.back()) < juce::jmin (firstSend, fader),
                   "with a fader and a send already present, the chain is inserted ahead of both");
        }
        check (liveGroupMismatch (eng, other, preset).isEmpty(), "the second track's chain holds the preset");
    }

    section ("VOCAL-PRESET REFUSALS: every failure leaves the session exactly as it was");
    {
        auto refused = [&] (const var& result, const String& mustMention, const String& before, const String& what)
        {
            check (! ok (result), what + " is refused");
            check (errorOf (result).containsIgnoreCase (mustMention),
                   what + " says why (" + errorOf (result) + ")");
            check (canon (ops) == before, what + " mutates nothing (canonical snapshot equal)");
        };

        const auto keys = newTrack ("VP Keys");
        command (ops, "add_midi_clip", object ({ { "trackId", keys } }));               // default-instrument policy loads 4OSC
        const auto drums = newTrack ("VP Drums");
        command (ops, "set_track_type", object ({ { "trackId", drums }, { "type", "drum" } }));
        const auto returnTrack = dataOf (command (ops, "create_bus", object ({ { "name", "VP Return" } }))).getProperty ("trackId", var()).toString();
        const auto bare = newTrack ("VP Bare");
        check (keys.isNotEmpty() && drums.isNotEmpty() && returnTrack.isNotEmpty() && bare.isNotEmpty(), "refusal fixture tracks created");
        settle();

        auto tempPreset = [&] (const char* leaf, const String& text)
        {
            auto f = cb.tempPath (leaf);
            f.replaceWithText (text);
            return f;
        };
        const auto original = juce::File (presetFile).loadFileAsString();
        const auto notJson       = tempPreset ("vp-bad-notjson.json", "{ this is not json");
        const auto wrongKind     = tempPreset ("vp-bad-kind.json", R"({"waveShapes":[3,3,0,0],"params":{"Level 1":0.8}})");
        const auto newerSchema   = tempPreset ("vp-bad-schema.json", original.replace ("\"schema\": 1", "\"schema\": 2"));
        const auto badProcessor  = tempPreset ("vp-bad-processor.json", original.replace ("\"processor\": \"compressor\"", "\"processor\": \"DeEss\""));
        const auto badState      = tempPreset ("vp-bad-state.json", original.replace ("\"mode\": \"highpass\"", "\"mode\": \"bandpass\""));
        const auto unknownKey    = tempPreset ("vp-bad-key.json", original.replace ("\"unit\": \"Hz\"", "\"unit\": \"Hz\", \"extra\": 1"));
        check (newerSchema.loadFileAsString() != original && badProcessor.loadFileAsString() != original
                   && badState.loadFileAsString() != original && unknownKey.loadFileAsString() != original,
               "each malformed fixture really differs from the bundled preset");

        auto before = canon (ops);
        refused (command (ops, "apply_track_preset", object ({ { "file", presetFile } })), "trackId", before, "a missing trackId");
        refused (apply ("999999", presetFile), "no track", before, "an unknown track id");
        refused (apply (keys, presetFile), "instrument", before, "an instrument track");
        refused (apply (drums, presetFile), "audio track", before, "a drum track");
        refused (apply (returnTrack, presetFile), "return", before, "a return track");
        refused (apply (bare, "/nonexistent/preset.json"), "not found", before, "a missing preset file");
        refused (apply (bare, "relative/preset.json"), "not found", before, "a relative preset path");
        refused (apply (bare, notJson.getFullPathName()), "not valid JSON", before, "a file that is not JSON");
        refused (apply (bare, wrongKind.getFullPathName()), "preset", before, "an instrument patch offered as a track preset");
        refused (apply (bare, newerSchema.getFullPathName()), "schema", before, "a newer-schema preset");
        refused (apply (bare, badProcessor.getFullPathName()), "DeEss", before, "an unsupported processor");
        refused (apply (bare, badState.getFullPathName()), "mode", before, "unsupported typed state");
        refused (apply (bare, unknownKey.getFullPathName()), "extra", before, "an unknown key on a parameter");

        // The old seam must not misapply a track preset — and must say "wrong command"
        // on the vocal track it was meant for, not only on a track that has a 4OSC.
        refused (command (ops, "load_preset", object ({ { "trackId", keys }, { "file", presetFile } })),
                 "track preset", before, "load_preset given a track-chain file on an instrument track");
        refused (command (ops, "load_preset", object ({ { "trackId", bare }, { "file", presetFile } })),
                 "track preset", before, "load_preset given a track-chain file on a vocal track");
        // A copy outside the library folder is still recognised by its own `kind`.
        const auto strayCopy = tempPreset ("vp-stray-copy.json", original);
        refused (command (ops, "load_preset", object ({ { "trackId", keys }, { "file", strayCopy.getFullPathName() } })),
                 "track preset", before, "load_preset given a track-chain file copied elsewhere");
        strayCopy.deleteFile();
        // …and a deeply nested document is refused as invalid rather than recursed into.
        const auto deep = tempPreset ("vp-bad-deep.json", String::repeatedString ("[", 5000));
        refused (apply (bare, deep.getFullPathName()), "nested too deeply", before, "a pathologically nested file");
        deep.deleteFile();

        // Frozen: refused by the dispatch freeze guard, like every other device edit.
        if (auto* track = liveTrack (eng, bare))
        {
            track->state.setProperty (ids::moshFrozen, true, nullptr);
            before = canon (ops);
            refused (apply (bare, presetFile), "frozen", before, "a frozen track");
            track->state.removeProperty (ids::moshFrozen, nullptr);
        }

        // Recording: plain --selftest has no device and cannot record, so the guard's
        // input is forced through the selftest seam; the guard itself is the real one.
        before = canon (ops);
        ops.setTrackPresetHooksForSelfTest (0, true);
        refused (apply (bare, presetFile), "recording", before, "applying while recording");
        ops.setTrackPresetHooksForSelfTest (0, false);
        check (ok (apply (bare, presetFile)) && ok (command (ops, "undo")), "…and the same call succeeds once recording has stopped");

        // Capacity: 16 plugins per track, hidden mixer elements included.
        const auto full = newTrack ("VP Full");
        if (auto* track = liveTrack (eng, full))
        {
            int guard = 0;
            while (track->pluginList.size() < 15 && guard++ < 20)
                command (ops, "load_builtin", object ({ { "trackId", full }, { "type", "phaser" } }));
            check (track->pluginList.size() == 15, "fixture track filled to one slot short of the engine limit");
            settle();
            before = canon (ops);
            refused (apply (full, presetFile), "room", before, "a track without room for both stages");
        }

        // No failure above may have opened a transaction. A real edit, a refusal, then
        // undo must revert the real edit; and a pending redo must survive a refusal.
        check (ok (command (ops, "rename_track", object ({ { "trackId", bare }, { "name", "VP Bare 2" } }))), "a real edit");
        check (! ok (apply (bare, notJson.getFullPathName())), "a refusal after it");
        check (ok (command (ops, "undo")) && trackVar (ops, bare).getProperty ("name", var()).toString() == "VP Bare",
               "undo after a refusal reverts the real edit (no empty transaction was opened)");
        check (! ok (apply (bare, notJson.getFullPathName())), "a refusal while a redo is pending");
        check (ok (command (ops, "redo")) && trackVar (ops, bare).getProperty ("name", var()).toString() == "VP Bare 2",
               "the pending redo survives the refusal");
        check (ok (command (ops, "undo")), "restore the fixture name");

        for (auto& f : { notJson, wrongKind, newerSchema, badProcessor, badState, unknownKey })
            f.deleteFile();

        section ("VOCAL-PRESET FAULTS: an injected mid-apply failure leaves no partial chain");
        // Point 1: after the plugins are created, before anything touches the track.
        // Point 2: after the first stage is inserted.
        for (const int point : { 1, 2 })
        {
            const String at = "fault point " + String (point);
            check (ok (command (ops, "rename_track", object ({ { "trackId", bare }, { "name", "VP Bare F" } }))), at + ": a real edit first");
            before = canon (ops);
            ops.setTrackPresetHooksForSelfTest (point, false);
            const auto failed = apply (bare, presetFile);
            ops.setTrackPresetHooksForSelfTest (0, false);
            check (! ok (failed) && errorOf (failed).contains ("injected"), at + ": the apply fails");
            check (canon (ops) == before && ownedPlugins (eng, bare, preset.id).empty(),
                   at + ": no partial chain — the canonical snapshot is unchanged");
            check (ok (command (ops, "undo")) && trackVar (ops, bare).getProperty ("name", var()).toString() == "VP Bare",
                   at + ": the next undo reverts the earlier real edit, not a phantom step");
            check (ok (command (ops, "redo")) && trackVar (ops, bare).getProperty ("name", var()).toString() == "VP Bare F",
                   at + ": redo restores that edit and nothing else");
            check (ownedPlugins (eng, bare, preset.id).empty(), at + ": redo did not resurrect a half-applied chain");
            check (ok (command (ops, "undo")), at + ": fixture restored");
        }

        // A failed REPLACE must put the user's existing (tweaked) group back.
        {
            const auto rows = presetRows (ops, other, preset.id);
            command (ops, "set_plugin_param", object ({ { "trackId", other }, { "index", rows.size() == 2 ? (int) rows[1].getProperty ("index", -1) : -1 },
                                                         { "paramIndex", 3 }, { "value", 0.2 } }));
            before = canon (ops);
            ops.setTrackPresetHooksForSelfTest (2, false);
            const auto failed = apply (other, presetFile);
            ops.setTrackPresetHooksForSelfTest (0, false);
            check (! ok (failed) && canon (ops) == before,
                   "a failed re-apply restores the existing tweaked group exactly");
        }

        // Inside a batch the rollback must not take the batch's earlier commands with it.
        {
            check (ok (command (ops, "batch_begin", object ({ { "name", "vp batch" } }))), "batch_begin");
            check (ok (command (ops, "rename_track", object ({ { "trackId", bare }, { "name", "VP Bare Batch" } }))), "an earlier command in the batch");
            before = canon (ops);
            ops.setTrackPresetHooksForSelfTest (2, false);
            const auto failed = apply (bare, presetFile);
            ops.setTrackPresetHooksForSelfTest (0, false);
            check (! ok (failed) && canon (ops) == before && ownedPlugins (eng, bare, preset.id).empty(),
                   "a fault inside a batch removes the partial chain but keeps the batch's earlier edit");
            check (ok (apply (bare, presetFile)), "the preset then applies inside the same batch");
            check (ok (command (ops, "batch_end")), "batch_end");
            check (liveGroupMismatch (eng, bare, preset).isEmpty(), "the batch left a complete chain");
            check (ok (command (ops, "undo")), "one undo for the whole batch");
            check (trackVar (ops, bare).getProperty ("name", var()).toString() == "VP Bare"
                       && ownedPlugins (eng, bare, preset.id).empty(),
                   "…removes the rename AND the chain together (the apply coalesced into the batch's one step)");
        }
    }

    section ("VOCAL-PRESET PERSIST: save, reload — serialized, effective and rendered state");
    {
        const auto preSaveExport = exportTo ("vp-presave.wav", 48000.0);
        const auto preSaveVox = juce::JSON::toString (trackVar (ops, vox));
        check (ok (command (ops, "save")), "save ok");

        // Serialized: what is actually on disk.
        int liveTagged = 0;
        for (auto* t : te::getAudioTracks (eng.edit()))
            for (auto* p : t->pluginList.getPlugins())
                if (p != nullptr && isOwnedBy (*p, preset.id))
                    ++liveTagged;
        const auto onDisk = eng.editFile().loadFileAsString();
        int tagged = 0;
        for (int at = 0; (at = onDisk.indexOf (at, "moshPresetId=\"" + preset.id + "\"")) >= 0; ++at) ++tagged;
        check (liveTagged >= 4 && tagged == liveTagged,
               "the saved edit carries the ownership tag on every preset plugin (" + String (liveTagged)
                   + " live, " + String (tagged) + " on disk)");
        check (onDisk.contains ("mode=\"highpass\"") && onDisk.contains ("moshPresetName=\"" + preset.name + "\""),
               "the saved edit carries the filter mode and the preset name");

        check (ok (command (ops, "reload")), "reload ok");
        check (trackVar (ops, vox).isObject(), "the target track keeps its id across reload");
        check (juce::JSON::toString (trackVar (ops, vox)) == preSaveVox,
               "the track's snapshot (order, values, bypass, preset tags, clip) is identical after reload");
        // Effective: brand-new plugin objects built from the file hold the preset.
        check (liveGroupMismatch (eng, vox, preset).isEmpty(),
               "plugins rebuilt from the saved file hold the preset's effective values"
                   + (liveGroupMismatch (eng, vox, preset).isEmpty() ? String() : " — " + liveGroupMismatch (eng, vox, preset)));
        check (! (bool) dataOf (apply (vox, presetFile)).getProperty ("changed", true),
               "re-applying after reload is still a no-op (ownership survived, nothing duplicates)");

        // Rendered: the same audio before and after the round trip.
        const auto postLoadExport = exportTo ("vp-postload.wav", 48000.0);
        juce::AudioBuffer<float> a, b;
        double aSr = 0.0, bSr = 0.0;
        if (readWav (preSaveExport, a, aSr) && readWav (postLoadExport, b, bSr))
        {
            const double residual = maxAbsDifference (a, b);
            check (residual <= 3.2e-5,
                   "render after reload matches the render before save (peak residual "
                       + String (toDb (residual), 1) + " dBFS; tolerance -90)");
        }
        else
            check (false, "pre-save and post-reload exports readable");
        preSaveExport.deleteFile();
        postLoadExport.deleteFile();
    }

    section ("VOCAL-PRESET DRY AUDIO: source recordings and the preset file are untouched");
    check (sha256 (toneFile) == toneSha, "the original recording's SHA-256 is unchanged");
    check (copySha.isNotEmpty() && sessionCopy.existsAsFile() && sha256 (sessionCopy) == copySha,
           "the session's imported copy of the recording is byte-identical");
    check (juce::JSON::toString (trackVar (ops, vox).getProperty ("clips", var())) == clipsBefore,
           "the clip's timing and source reference are what they were before any preset was applied");
    check (sha256 (juce::File (presetFile)) == presetSha, "the bundled preset file itself was never written to");

    toneFile.deleteFile();
    dryExport.deleteFile();
}

} // namespace mosh
