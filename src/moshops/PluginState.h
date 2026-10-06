#pragma once

// A native plugin's CachedValue-only settings: the values Tracktion keeps in the
// plugin's state but does NOT expose as automatable parameters, so set_plugin_param
// cannot reach them (delay length, every chorus and phaser control, the low/high-pass
// mode). One whitelist serves both the snapshot's `plugin.state` object
// (MoshOps::pluginToVar) and the set_plugin_state command, so what is shown and what
// can be set cannot drift apart. docs/02_MOSHOPS_CONTRACT.md has the contract.
//
// Values are physical (ms, Hz, octaves, a 0-1 proportion, a mode string), never
// normalised. Reads report what the plugin holds, even if a saved session put it
// outside the range; writes are validated and clamped by set_plugin_state.

#include <tracktion_engine/tracktion_engine.h>
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
                entry->setProperty ("step", 1);
            if (juce::String (s.unit).isNotEmpty())
                entry->setProperty ("unit", juce::String (s.unit));
        }
        if (state == nullptr)
            state = new juce::DynamicObject();
        state->setProperty (s.key, juce::var (entry));
    }
    return state != nullptr ? juce::var (state.get()) : juce::var();
}

/** Validates and clamps a requested value for `spec`. On success returns true and sets
    `applied` (numbers clamped to [min, max]; integers rounded; choices verbatim). On
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
    if (spec.kind == Spec::Kind::integer)
        applied = juce::jlimit ((int) spec.min, (int) spec.max, juce::roundToInt (clamped));
    else
        applied = clamped;
    return true;
}
}
