#pragma once

// A native plugin's CachedValue-only settings: the values Tracktion keeps in the
// plugin's state but does NOT expose as automatable parameters, so set_plugin_param
// cannot reach them (delay length, every chorus and phaser control, the low/high-pass
// mode and slope, the 4OSC's waves, unison voices, filter type/slope, FX switches,
// delay length in beats, voice mode and analog envelopes). One whitelist serves both
// the snapshot's `plugin.state` object
// (MoshOps::pluginToVar) and the set_plugin_state command, so what is shown and what
// can be set cannot drift apart. docs/02_MOSHOPS_CONTRACT.md has the contract.
//
// Values are physical (ms, Hz, octaves, beats, a 0-1 proportion, a mode string), never
// normalised. Reads report what the plugin holds, even if a saved session put it
// outside the range; writes are validated and clamped by set_plugin_state. The 4OSC's
// stored ints are read as what the synth does with them: a wave or filter type outside
// its enum reads "off" (it plays no wave / runs no filter), unison voices are clamped to
// 1..8, a filter slope other than 24 reads 12, a voice mode other than 1 or 2 reads
// "mono".

#include <tracktion_engine/tracktion_engine.h>
#include "plugins/moshfx/MoshLowPassPlugin.h"
#include <cmath>

namespace mosh::pluginstate
{
namespace te = tracktion::engine;

struct Spec
{
    enum class Kind { number, integer, choice };
    const char* type;     // the snapshot's plugin.type (effectiveBuiltinType)
    const char* key;
    Kind kind;
    double min, max;      // number/integer only
    const char* unit;     // "" when unitless
    const char* choices;  // choice only, '|'-separated
    int step = 0;         // integer only: values snap to min + k * step (0 or 1 = whole numbers)
};

inline constexpr Spec kSpecs[] = {
    // Tracktion's DelayPlugin divides by the length in samples on the audio thread
    // (tracktion_Delay.cpp applyToBuffer), so the length never goes below 1 ms.
    { "delay",    "lengthMs", Spec::Kind::integer, 1.0,   2000.0, "ms",  "" },
    { "chorus",   "depthMs",  Spec::Kind::number,  0.1,   20.0,   "ms",  "" },
    { "chorus",   "speedHz",  Spec::Kind::number,  0.1,   10.0,   "Hz",  "" },
    { "chorus",   "width",    Spec::Kind::number,  0.0,   1.0,    "",    "" },
    { "chorus",   "mix",      Spec::Kind::number,  0.0,   1.0,    "",    "" },
    { "phaser",   "depth",    Spec::Kind::number,  0.0,   8.0,    "oct", "" },
    { "phaser",   "rate",     Spec::Kind::number,  0.05,  10.0,   "Hz",  "" },
    { "phaser",   "feedback", Spec::Kind::number,  -0.95, 0.95,   "",    "" },
    // "highpass" is te::LowPassPlugin in high-pass mode; changing the mode changes the
    // plugin's reported type between "lowpass" and "highpass".
    { "lowpass",  "mode",     Spec::Kind::choice,  0.0,   0.0,    "",    "lowpass|highpass" },
    { "highpass", "mode",     Spec::Kind::choice,  0.0,   0.0,    "",    "lowpass|highpass" },
    // The filter's slope in dB/oct: a Butterworth cascade of order slope / 6
    // (plugins/moshfx/MoshLowPassPlugin.h). Only Mosh's subclass has it: on a plain
    // te::LowPassPlugin read() is void, so the snapshot omits it and set_plugin_state
    // refuses it.
    { "lowpass",  "slope",    Spec::Kind::integer, 6.0,   48.0,   "dB/oct", "", 6 },
    { "highpass", "slope",    Spec::Kind::integer, 6.0,   48.0,   "dB/oct", "", 6 },
    // te::FourOscPlugin (tracktion_FourOscPlugin.h): public CachedValues on the plugin's
    // ROOT state. A choice's index IS the engine int (waves: Oscillator::Waves 0..5;
    // filter: 0 none, 1 LP, 2 HP, 3 BP, 4 notch; voice mode: 0 mono, 1 legato, 2 poly;
    // switches: 0/1). Nothing outside these enums is ever written: a filter type outside
    // 0..4 zeroes the voice filter's coefficients (silence). Unison voices stop at 8
    // (MultiVoiceOscillator's size; above it the gain is still divided by the setting).
    // delayBeats is Tracktion's "delay" in beats; its line is 5.1 s, so 4 beats wrap
    // below about 47 BPM. Left out on purpose: polyphony and the LFO/MPE/mod-matrix
    // settings (inert without a mod route, or reallocating, or unsafe: lfoBeat <= 0
    // hangs the audio thread).
    { "4osc", "waveShape1",   Spec::Kind::choice,  0.0,    0.0,  "",       "off|sine|square|saw|triangle|noise" },
    { "4osc", "waveShape2",   Spec::Kind::choice,  0.0,    0.0,  "",       "off|sine|square|saw|triangle|noise" },
    { "4osc", "waveShape3",   Spec::Kind::choice,  0.0,    0.0,  "",       "off|sine|square|saw|triangle|noise" },
    { "4osc", "waveShape4",   Spec::Kind::choice,  0.0,    0.0,  "",       "off|sine|square|saw|triangle|noise" },
    { "4osc", "voices1",      Spec::Kind::integer, 1.0,    8.0,  "",       "", 1 },
    { "4osc", "voices2",      Spec::Kind::integer, 1.0,    8.0,  "",       "", 1 },
    { "4osc", "voices3",      Spec::Kind::integer, 1.0,    8.0,  "",       "", 1 },
    { "4osc", "voices4",      Spec::Kind::integer, 1.0,    8.0,  "",       "", 1 },
    { "4osc", "filterType",   Spec::Kind::choice,  0.0,    0.0,  "",       "off|lowpass|highpass|bandpass|notch" },
    // The voice runs its second filter stage only when the value is exactly 24.
    { "4osc", "filterSlope",  Spec::Kind::integer, 12.0,   24.0, "dB/oct", "", 12 },
    { "4osc", "distortionOn", Spec::Kind::choice,  0.0,    0.0,  "",       "off|on" },
    { "4osc", "reverbOn",     Spec::Kind::choice,  0.0,    0.0,  "",       "off|on" },
    { "4osc", "delayOn",      Spec::Kind::choice,  0.0,    0.0,  "",       "off|on" },
    { "4osc", "chorusOn",     Spec::Kind::choice,  0.0,    0.0,  "",       "off|on" },
    { "4osc", "delayBeats",   Spec::Kind::number,  0.0625, 4.0,  "beats",  "" },
    { "4osc", "voiceMode",    Spec::Kind::choice,  0.0,    0.0,  "",       "mono|legato|poly" },
    { "4osc", "ampAnalog",    Spec::Kind::choice,  0.0,    0.0,  "",       "off|on" },
};

/** Compile-time lookup of a spec's max (for static_asserts tying other ceilings to the
    table, e.g. the delay-line pre-sizing in plugins/moshfx/MoshDelayLinePlugins.h). */
constexpr bool sameText (const char* a, const char* b)
{
    while (*a != 0 && *a == *b) { ++a; ++b; }
    return *a == *b;
}
constexpr double maxOf (const char* type, const char* key)
{
    for (const auto& s : kSpecs)
        if (sameText (s.type, type) && sameText (s.key, key))
            return s.max;
    return -1.0;
}
constexpr double minOf (const char* type, const char* key)
{
    for (const auto& s : kSpecs)
        if (sameText (s.type, type) && sameText (s.key, key))
            return s.min;
    return -1.0;
}
constexpr int stepOf (const char* type, const char* key)
{
    for (const auto& s : kSpecs)
        if (sameText (s.type, type) && sameText (s.key, key))
            return s.step;
    return -1;
}

inline const Spec* find (const juce::String& type, const juce::String& key)
{
    for (auto& s : kSpecs)
        if (type == s.type && key == s.key)
            return &s;
    return nullptr;
}

inline juce::StringArray choicesOf (const Spec& spec)
{
    return juce::StringArray::fromTokens (spec.choices, "|", "");
}

namespace fourosc
{
    /** The oscillator (0-3) a per-oscillator key names ("waveShape2" -> 1), or -1. */
    inline int oscIndexOf (const juce::String& key, const char* prefix)
    {
        const juce::String start (prefix);
        if (! key.startsWith (start) || key.length() != start.length() + 1)
            return -1;
        const int n = (int) (key.getLastCharacter() - '0');
        return n >= 1 && n <= 4 ? n - 1 : -1;
    }

    /** The choice an engine int stands for; `fallback` (a choice index) when the stored
        int is outside the enum. */
    inline juce::String choiceAt (const Spec& spec, int engineValue, int fallback)
    {
        const auto choices = choicesOf (spec);
        return choices[juce::isPositiveAndBelow (engineValue, choices.size()) ? engineValue : fallback];
    }

    inline juce::var read (te::FourOscPlugin& fo, const Spec& spec)
    {
        const juce::String key (spec.key);
        auto onOff = [&spec] (bool on) { return choiceAt (spec, on ? 1 : 0, 0); };
        if (const int osc = oscIndexOf (key, "waveShape"); osc >= 0 && osc < fo.oscParams.size())
            // A wave outside 0..5 matches no case in Oscillator::process: it plays nothing.
            return choiceAt (spec, fo.oscParams[osc]->waveShapeValue.get(), 0);
        if (const int osc = oscIndexOf (key, "voices"); osc >= 0 && osc < fo.oscParams.size())
            return juce::jlimit ((int) spec.min, (int) spec.max, fo.oscParams[osc]->voicesValue.get());
        // A filter type outside 0..4 runs no filter stage: "off".
        if (key == "filterType")   return choiceAt (spec, fo.filterTypeValue.get(), 0);
        // The voice adds its second stage only for exactly 24; anything else plays as 12.
        if (key == "filterSlope")  return fo.filterSlopeValue.get() == 24 ? 24 : 12;
        if (key == "distortionOn") return onOff (fo.distortionOnValue.get());
        if (key == "reverbOn")     return onOff (fo.reverbOnValue.get());
        if (key == "delayOn")      return onOff (fo.delayOnValue.get());
        if (key == "chorusOn")     return onOff (fo.chorusOnValue.get());
        if (key == "delayBeats")   return (double) fo.delayValue.get();
        if (key == "voiceMode")
        {
            // Tracktion: 2 allocates the poly voices, 1 glides (legato); anything else
            // keeps one voice and retriggers it: mono.
            const int mode = fo.voiceModeValue.get();
            return choiceAt (spec, mode == 2 || mode == 1 ? mode : 0, 0);
        }
        if (key == "ampAnalog")    return onOff (fo.ampAnalogValue.get());
        return {};
    }

    /** What the plugin stores for `spec`: the engine's own value (an int, a 0/1 switch,
        the float delay as a double), not the choice id; void for a key it does not have. */
    inline juce::var stored (te::FourOscPlugin& fo, const Spec& spec)
    {
        const juce::String key (spec.key);
        if (const int osc = oscIndexOf (key, "waveShape"); osc >= 0 && osc < fo.oscParams.size())
            return fo.oscParams[osc]->waveShapeValue.get();
        if (const int osc = oscIndexOf (key, "voices"); osc >= 0 && osc < fo.oscParams.size())
            return fo.oscParams[osc]->voicesValue.get();
        if (key == "filterType")   return fo.filterTypeValue.get();
        if (key == "filterSlope")  return fo.filterSlopeValue.get();
        if (key == "distortionOn") return fo.distortionOnValue.get() ? 1 : 0;
        if (key == "reverbOn")     return fo.reverbOnValue.get() ? 1 : 0;
        if (key == "delayOn")      return fo.delayOnValue.get() ? 1 : 0;
        if (key == "chorusOn")     return fo.chorusOnValue.get() ? 1 : 0;
        if (key == "delayBeats")   return (double) fo.delayValue.get();
        if (key == "voiceMode")    return fo.voiceModeValue.get();
        if (key == "ampAnalog")    return fo.ampAnalogValue.get() ? 1 : 0;
        return {};
    }

    /** The engine value write() stores for an already-validated `value` (same shapes as
        stored()), or void when it is not one this key may hold: a choice id outside the
        list, a filter slope other than 12 or 24. Nothing outside an enum is ever stored. */
    inline juce::var toStored (const Spec& spec, const juce::var& value)
    {
        const juce::String key (spec.key);
        if (spec.kind == Spec::Kind::choice)
        {
            // The index of the id IS the engine int (a switch's "on" is 1).
            const int choice = choicesOf (spec).indexOf (value.toString());
            return choice >= 0 ? juce::var (choice) : juce::var();
        }
        if (key == "filterSlope")
        {
            const int slope = (int) value;
            return slope == 12 || slope == 24 ? juce::var (slope) : juce::var();
        }
        if (key == "delayBeats")
            return (double) (float) juce::jlimit (spec.min, spec.max, (double) value);
        if (oscIndexOf (key, "voices") >= 0)
            return juce::jlimit ((int) spec.min, (int) spec.max, (int) value);
        return {};
    }

    inline bool write (te::FourOscPlugin& fo, const Spec& spec, const juce::var& value, juce::UndoManager* um)
    {
        const juce::String key (spec.key);
        const auto v = toStored (spec, value);
        if (v.isVoid())
            return false;
        if (const int osc = oscIndexOf (key, "waveShape"); osc >= 0 && osc < fo.oscParams.size())
        {
            fo.oscParams[osc]->waveShapeValue.setValue ((int) v, um);
            return true;
        }
        if (const int osc = oscIndexOf (key, "voices"); osc >= 0 && osc < fo.oscParams.size())
        {
            fo.oscParams[osc]->voicesValue.setValue ((int) v, um);
            return true;
        }
        if (key == "filterType")   { fo.filterTypeValue.setValue ((int) v, um); return true; }
        if (key == "filterSlope")  { fo.filterSlopeValue.setValue ((int) v, um); return true; }
        if (key == "distortionOn") { fo.distortionOnValue.setValue ((int) v == 1, um); return true; }
        if (key == "reverbOn")     { fo.reverbOnValue.setValue ((int) v == 1, um); return true; }
        if (key == "delayOn")      { fo.delayOnValue.setValue ((int) v == 1, um); return true; }
        if (key == "chorusOn")     { fo.chorusOnValue.setValue ((int) v == 1, um); return true; }
        if (key == "delayBeats")   { fo.delayValue.setValue ((float) (double) v, um); return true; }
        if (key == "voiceMode")    { fo.voiceModeValue.setValue ((int) v, um); return true; }
        if (key == "ampAnalog")    { fo.ampAnalogValue.setValue ((int) v == 1, um); return true; }
        return false;
    }
}

/** The keys a plugin type has, in table order (empty for a type with no state). */
inline juce::StringArray keysFor (const juce::String& type)
{
    juce::StringArray keys;
    for (auto& s : kSpecs)
        if (type == s.type)
            keys.add (s.key);
    return keys;
}

/** The plugin's current value for `spec`, or a void var if the plugin is not the
    class the spec belongs to. */
inline juce::var read (te::Plugin& p, const Spec& spec)
{
    const juce::String key (spec.key);
    if (auto* d = dynamic_cast<te::DelayPlugin*> (&p))
    {
        if (key == "lengthMs") return d->lengthMs.get();
    }
    else if (auto* c = dynamic_cast<te::ChorusPlugin*> (&p))
    {
        if (key == "depthMs") return c->depthMs.get();
        if (key == "speedHz") return c->speedHz.get();
        if (key == "width")   return c->width.get();
        if (key == "mix")     return c->mixProportion.get();
    }
    else if (auto* ph = dynamic_cast<te::PhaserPlugin*> (&p))
    {
        if (key == "depth")    return ph->depth.get();
        if (key == "rate")     return ph->rate.get();
        if (key == "feedback") return ph->feedbackGain.get();
    }
    else if (auto* lp = dynamic_cast<te::LowPassPlugin*> (&p))
    {
        // Tracktion treats every mode string other than "highpass" as low-pass.
        if (key == "mode") return juce::String (lp->isLowPass() ? "lowpass" : "highpass");
        // The slope the filter runs at (the saved value snapped onto the grid).
        if (key == "slope")
        {
            if (auto* m = dynamic_cast<MoshLowPassPlugin*> (lp))
                return m->getSlope();
            return {};
        }
    }
    else if (auto* fo = dynamic_cast<te::FourOscPlugin*> (&p))
    {
        return fourosc::read (*fo, spec);
    }
    return {};
}

/** Writes an already-validated value through `um` (so it is undoable). Returns false
    if the plugin is not the class the spec belongs to. */
inline bool write (te::Plugin& p, const Spec& spec, const juce::var& value, juce::UndoManager* um)
{
    const juce::String key (spec.key);
    if (auto* d = dynamic_cast<te::DelayPlugin*> (&p))
    {
        if (key == "lengthMs") { d->lengthMs.setValue ((int) value, um); return true; }
    }
    else if (auto* c = dynamic_cast<te::ChorusPlugin*> (&p))
    {
        if (key == "depthMs") { c->depthMs.setValue ((float) (double) value, um); return true; }
        if (key == "speedHz") { c->speedHz.setValue ((float) (double) value, um); return true; }
        if (key == "width")   { c->width.setValue ((float) (double) value, um); return true; }
        if (key == "mix")     { c->mixProportion.setValue ((float) (double) value, um); return true; }
    }
    else if (auto* ph = dynamic_cast<te::PhaserPlugin*> (&p))
    {
        if (key == "depth")    { ph->depth.setValue ((float) (double) value, um); return true; }
        if (key == "rate")     { ph->rate.setValue ((float) (double) value, um); return true; }
        if (key == "feedback") { ph->feedbackGain.setValue ((float) (double) value, um); return true; }
    }
    else if (auto* lp = dynamic_cast<te::LowPassPlugin*> (&p))
    {
        if (key == "mode") { lp->mode.setValue (value.toString(), um); return true; }
        if (key == "slope")
        {
            if (auto* m = dynamic_cast<MoshLowPassPlugin*> (lp))
            {
                m->slope.setValue ((int) value, um);
                return true;
            }
            return false;
        }
    }
    else if (auto* fo = dynamic_cast<te::FourOscPlugin*> (&p))
    {
        return fourosc::write (*fo, spec, value, um);
    }
    return false;
}

/** The snapshot's `plugin.state` object for a plugin reported as `type`, or a void var
    when the type has no state keys. Each key: { value, min?, max?, step?, unit?,
    choices? }. */
inline juce::var describe (te::Plugin& p, const juce::String& type)
{
    juce::DynamicObject::Ptr state;
    for (auto& s : kSpecs)
    {
        if (type != s.type)
            continue;
        const auto value = read (p, s);
        if (value.isVoid())
            continue;
        auto* entry = new juce::DynamicObject();
        entry->setProperty ("value", value);
        if (s.kind == Spec::Kind::choice)
        {
            juce::Array<juce::var> choices;
            for (auto& c : choicesOf (s))
                choices.add (c);
            entry->setProperty ("choices", choices);
        }
        else
        {
            entry->setProperty ("min", s.min);
            entry->setProperty ("max", s.max);
            if (s.kind == Spec::Kind::integer)
                entry->setProperty ("step", s.step > 1 ? s.step : 1);
            if (juce::String (s.unit).isNotEmpty())
                entry->setProperty ("unit", juce::String (s.unit));
        }
        if (state == nullptr)
            state = new juce::DynamicObject();
        state->setProperty (s.key, juce::var (entry));
    }
    return state != nullptr ? juce::var (state.get()) : juce::var();
}

/** True when writing the already-coerced `applied` would leave the plugin as it is, so
    set_plugin_state makes no edit. Compares what the plugin holds with what would be
    written: the read value for most keys (a choice as its id, an integer as an int, a
    number as a float); for the 4OSC the STORED engine value, because its reads map
    values the synth cannot play onto what it does play instead (a filter type of 7
    reads "off" but silences the voice), and picking "off" must then really write 0. */
inline bool isNoChange (te::Plugin& p, const Spec& spec, const juce::var& applied)
{
    if (auto* fo = dynamic_cast<te::FourOscPlugin*> (&p))
    {
        const auto now = fourosc::stored (*fo, spec), next = fourosc::toStored (spec, applied);
        if (! now.isVoid() && ! next.isVoid())
            return now.isDouble() ? juce::exactlyEqual ((float) (double) now, (float) (double) next)
                                  : (int) now == (int) next;
    }
    const auto before = read (p, spec);
    return spec.kind == Spec::Kind::choice
               ? before.toString() == applied.toString()
               : spec.kind == Spec::Kind::integer
                     ? (int) before == (int) applied
                     : juce::exactlyEqual ((float) (double) before, (float) (double) applied);
}

/** Validates and clamps a requested value for `spec`. On success returns true and sets
    `applied` (numbers clamped to [min, max]; integers rounded, or snapped onto
    min + k * step when the spec has a step > 1, a tie rounding up as JavaScript's
    Math.round does: slope 25 -> 24, 27 -> 30, 0 -> 6, 100 -> 48; choices verbatim). On
    failure returns false and sets `error`. */
inline bool coerce (const Spec& spec, const juce::var& requested, juce::var& applied, juce::String& error)
{
    if (spec.kind == Spec::Kind::choice)
    {
        const auto choices = choicesOf (spec);
        if (! requested.isString() || ! choices.contains (requested.toString()))
        {
            error = juce::String ("bad value for ") + spec.key + ": must be one of " + choices.joinIntoString (", ");
            return false;
        }
        applied = requested.toString();
        return true;
    }

    const bool numeric = requested.isInt() || requested.isInt64() || requested.isDouble();
    const double v = numeric ? (double) requested : 0.0;
    if (! numeric || ! std::isfinite (v))
    {
        error = juce::String ("bad value for ") + spec.key + ": must be a finite number";
        return false;
    }
    const double clamped = juce::jlimit (spec.min, spec.max, v);
    if (spec.kind == Spec::Kind::integer && spec.step > 1)
    {
        const int lo = (int) spec.min;
        const int top = lo + spec.step * (((int) spec.max - lo) / spec.step);   // the last grid point <= max
        const int steps = (int) std::floor ((clamped - spec.min) / spec.step + 0.5);
        applied = juce::jlimit (lo, top, lo + spec.step * steps);
    }
    else if (spec.kind == Spec::Kind::integer)
        applied = juce::jlimit ((int) spec.min, (int) spec.max, juce::roundToInt (clamped));
    else
        applied = clamped;
    return true;
}
}
