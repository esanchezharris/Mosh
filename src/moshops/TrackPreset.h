// Track-chain presets ("Mosh Clean Lead v0") — the pure, engine-free half: the file
// schema, the pinned processor table, and the unit adapter. Header-only, juce_core ONLY
// (NO tracktion), so tests/test_track_preset.cpp runs it hermetically — the same posture
// as ExportRange.h / DrumPattern.h. cmdApplyTrackPreset (MoshOps.Plugins.cpp) calls this
// to validate a preset with ZERO engine contact, then builds the plugin state from the
// native values this header resolved.
//
// WHY A PINNED TABLE. A preset file states every value in a readable unit (dB, Hz, ms,
// N:1). The pinned Tracktion built-ins do not store those units: CompressorPlugin keeps
// its threshold as LINEAR GAIN in 0.01..1.0 and its ratio as the reciprocal SLOPE in
// 0..0.95 (tracktion_Compressor.cpp:16-25), so a number read off a UI label is not the
// number the parameter holds. The 2026-09-06 calibration swept "ratio 0.80" believing it
// compressed harder; it is 1.3:1. The table below is the one place that mapping lives.
// It cannot be read off a live plugin at validation time — constructing a te::Plugin
// writes to the edit's UndoManager — so it is pinned here and the native selftest
// (VocalPresetSelfTest.cpp) fails if the engine's real ids or ranges ever disagree.
//
// SCHEMA 1 IS STRICT. An unknown key, a missing parameter, an unsupported processor or
// unit, a non-finite number, or a value outside the parameter's range is an ERROR. Nothing
// is clamped and nothing is defaulted: a preset that cannot be applied exactly as written
// must not be applied approximately.
#pragma once

#include <juce_core/juce_core.h>
#include <cmath>
#include <limits>
#include <vector>

namespace mosh::trackpreset
{

inline constexpr const char* kKind = "mosh.track-chain";
inline constexpr int kSchema = 1;
/** The library key a track-chain preset lives under: <presets root>/track-chain/<file>. */
inline constexpr const char* kLibraryKey = "track-chain";
inline constexpr int kMaxStages = 8;

/** How a canonical (file) value becomes the value the engine parameter stores. */
enum class Encoding
{
    identity,        // Hz, ms, dB stored as-is
    dbToLinearGain,  // dB in the file  -> 10^(dB/20) in the parameter
    ratioToSlope     // N (as in N:1)   -> 1/N in the parameter
};

struct ParamSpec
{
    const char* id;          // te::AutomatableParameter::paramID
    const char* stateProp;   // the PLUGIN ValueTree property the parameter persists under
    const char* unit;        // the canonical unit a preset file must state
    Encoding encoding;
    float nativeMin, nativeMax;   // the parameter's valueRange in the pinned engine
};

struct StateSpec
{
    enum class Kind { string, boolean };
    const char* key;         // the key in a preset file's "state" object
    const char* stateProp;   // the PLUGIN ValueTree property
    Kind kind;
    const char* allowed;     // '|'-separated legal strings (Kind::string only)
};

struct ProcessorSpec
{
    const char* type;        // the engine's genuine xmlTypeName
    const ParamSpec* params;
    int numParams;
    const StateSpec* state;
    int numState;
};

// ── the pinned table: exactly the two processors "Mosh Clean Lead v0" needs ──────────
// tracktion_LowPass.cpp:18-25 — frequency 10..22000 Hz; `mode` is a plain CachedValue
// ("lowpass" | "highpass"), NOT a parameter, so a parameter dump alone would miss it.
inline constexpr ParamSpec kLowPassParams[] = {
    { "frequency", "frequency", "Hz", Encoding::identity, 10.0f, 22000.0f },
};
inline constexpr StateSpec kLowPassState[] = {
    { "mode", "mode", StateSpec::Kind::string, "lowpass|highpass" },
};

// tracktion_Compressor.cpp:16-47, in the engine's own parameter order.
inline constexpr ParamSpec kCompressorParams[] = {
    { "threshold",   "threshold", "dB", Encoding::dbToLinearGain,  0.01f,   1.0f },
    { "ratio",       "ratio",     ":1", Encoding::ratioToSlope,    0.0f,    0.95f },
    { "attack",      "attack",    "ms", Encoding::identity,        0.3f,  200.0f },
    { "release",     "release",   "ms", Encoding::identity,       10.0f,  300.0f },
    { "output gain", "outputDb",  "dB", Encoding::identity,      -10.0f,   24.0f },
    { "input gain",  "inputDb",   "dB", Encoding::identity,      -24.0f,   24.0f },
};
inline constexpr StateSpec kCompressorState[] = {
    { "sidechainTrigger", "sidechainTrigger", StateSpec::Kind::boolean, "" },
};

inline constexpr ProcessorSpec kProcessors[] = {
    { "lowpass",    kLowPassParams,    1, kLowPassState,    1 },
    { "compressor", kCompressorParams, 6, kCompressorState, 1 },
};

inline const ProcessorSpec* findProcessor (const juce::String& type)
{
    for (auto& p : kProcessors)
        if (type == p.type)
            return &p;
    return nullptr;
}

inline const ParamSpec* findParam (const ProcessorSpec& processor, const juce::String& id)
{
    for (int i = 0; i < processor.numParams; ++i)
        if (id == processor.params[i].id)
            return &processor.params[i];
    return nullptr;
}

// ── the unit adapter ────────────────────────────────────────────────────────────────
struct Conversion
{
    bool ok = false;
    float native = 0.0f;
    juce::String error;
};

/** A canonical (file) value -> the value the engine parameter stores. Fails, never
    clamps: a result outside the parameter's range is the caller's error to surface. */
inline Conversion toNative (const ParamSpec& spec, double canonical)
{
    Conversion out;
    const juce::String who = juce::String (spec.id) + " " + juce::String (canonical) + " " + spec.unit;
    if (! std::isfinite (canonical))
    {
        out.error = juce::String (spec.id) + " is not a finite number";
        return out;
    }

    double native = canonical;
    switch (spec.encoding)
    {
        case Encoding::identity:
            break;
        case Encoding::dbToLinearGain:
            native = std::pow (10.0, canonical / 20.0);
            break;
        case Encoding::ratioToSlope:
            if (canonical <= 0.0)
            {
                out.error = who + " is not a ratio (must be greater than 0)";
                return out;
            }
            native = 1.0 / canonical;
            break;
    }

    // Compare as float: that is the precision the parameter holds, and it is what makes
    // the exact endpoints (-40 dB -> 0.01, 1/0.95 : 1 -> 0.95) land ON the range instead
    // of a double-rounding hair outside it.
    const float f = (float) native;
    if (! std::isfinite (f) || f < spec.nativeMin || f > spec.nativeMax)
    {
        out.error = who + " is outside what this parameter can hold";
        return out;
    }
    out.ok = true;
    out.native = f;
    return out;
}

/** The inverse, for readback: what the engine parameter holds -> the canonical unit.
    A slope of 0 is an infinite ratio; it is returned as +infinity, never a made-up number. */
inline double toCanonical (const ParamSpec& spec, float native)
{
    switch (spec.encoding)
    {
        case Encoding::identity:        return (double) native;
        case Encoding::dbToLinearGain:  return native > 0.0f ? 20.0 * std::log10 ((double) native)
                                                              : -std::numeric_limits<double>::infinity();
        case Encoding::ratioToSlope:    return native > 0.0f ? 1.0 / (double) native
                                                              : std::numeric_limits<double>::infinity();
    }
    return (double) native;
}

// ── the parsed preset ───────────────────────────────────────────────────────────────
struct ParamValue
{
    const ParamSpec* spec = nullptr;
    double canonical = 0.0;   // as written in the file
    float native = 0.0f;      // what the engine parameter must hold
};

struct StateValue
{
    const StateSpec* spec = nullptr;
    juce::var value;          // juce::String or bool, per spec->kind
};

struct Stage
{
    const ProcessorSpec* processor = nullptr;
    bool bypassed = false;
    std::vector<ParamValue> params;   // in the processor's own parameter order, complete
    std::vector<StateValue> state;    // in the processor's own state order, complete
};

struct TrackPreset
{
    juce::String id;
    int revision = 0;
    juce::String name;
    juce::String targetTrackType;
    juce::var provenance, validation;
    std::vector<Stage> stages;
};

struct ParseResult
{
    bool ok = false;
    juce::String error;
    TrackPreset preset;
};

namespace detail
{
    inline bool isNumber (const juce::var& v)   { return v.isInt() || v.isInt64() || v.isDouble(); }

    inline bool isWholeNumber (const juce::var& v)
    {
        if (v.isInt() || v.isInt64()) return true;
        return v.isDouble() && std::isfinite ((double) v) && std::floor ((double) v) == (double) v;
    }

    /** Every key of `object` must be in `allowed`, and every `required` key present. */
    inline juce::String checkKeys (const juce::var& object, const juce::String& where,
                                   const juce::StringArray& required, const juce::StringArray& optional = {})
    {
        auto* o = object.getDynamicObject();
        if (o == nullptr)
            return where + " must be an object";
        for (auto& p : o->getProperties())
            if (! required.contains (p.name.toString()) && ! optional.contains (p.name.toString()))
                return where + " has an unknown key: " + p.name.toString();
        for (auto& k : required)
            if (! o->hasProperty (k))
                return where + " is missing '" + k + "'";
        return {};
    }

    inline bool isPresetIdChar (juce::juce_wchar c)
    {
        return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '_';
    }
}

/** Validate a parsed JSON document as a schema-1 track-chain preset. Pure: no file, no
    engine. On failure `error` names the first problem; `preset` is then meaningless. */
inline ParseResult parseTrackPreset (const juce::var& json)
{
    using namespace detail;
    ParseResult out;
    auto fail = [&out] (const juce::String& message) { out.error = message; return out; };

    if (auto e = checkKeys (json, "preset",
                            { "kind", "schema", "id", "revision", "name", "provenance", "validation", "target", "stages" });
        e.isNotEmpty())
        return fail (e);

    if (! json["kind"].isString() || json["kind"].toString() != kKind)
        return fail ("not a track-chain preset (kind must be '" + juce::String (kKind) + "')");
    // Compared as a double: a 64-bit integer such as 4294967297 truncates to 1 as an int.
    if (! isWholeNumber (json["schema"]) || (double) json["schema"] != (double) kSchema)
        return fail ("unsupported preset schema (this build reads schema " + juce::String (kSchema) + ")");

    auto& p = out.preset;
    p.id = json["id"].isString() ? json["id"].toString() : juce::String();
    if (p.id.isEmpty() || p.id.length() > 64)
        return fail ("preset id must be 1-64 characters");
    for (auto c : p.id)
        if (! isPresetIdChar (c))
            return fail ("preset id may only use a-z, 0-9, '.', '-' and '_'");

    if (! isWholeNumber (json["revision"]) || (double) json["revision"] < 0.0 || (double) json["revision"] > 1.0e6)
        return fail ("preset revision must be a whole number of 0 or more");
    p.revision = (int) json["revision"];

    p.name = json["name"].isString() ? json["name"].toString().trim() : juce::String();
    if (p.name.isEmpty() || p.name.length() > 64)
        return fail ("preset name must be 1-64 characters");

    if (json["provenance"].getDynamicObject() == nullptr)
        return fail ("provenance must be an object");
    if (json["validation"].getDynamicObject() == nullptr)
        return fail ("validation must be an object");
    p.provenance = json["provenance"];
    p.validation = json["validation"];

    if (auto e = checkKeys (json["target"], "target", { "trackType" }); e.isNotEmpty())
        return fail (e);
    p.targetTrackType = json["target"]["trackType"].isString() ? json["target"]["trackType"].toString() : juce::String();
    if (p.targetTrackType != "audio")
        return fail ("target.trackType must be 'audio'");

    auto* stages = json["stages"].getArray();
    if (stages == nullptr || stages->isEmpty())
        return fail ("stages must be a non-empty array");
    if (stages->size() > kMaxStages)
        return fail ("too many stages (at most " + juce::String (kMaxStages) + ")");

    for (int si = 0; si < stages->size(); ++si)
    {
        const auto& sv = stages->getReference (si);
        const juce::String where = "stage " + juce::String (si + 1);
        if (auto e = checkKeys (sv, where, { "processor", "state", "bypassed", "params" }); e.isNotEmpty())
            return fail (e);

        Stage stage;
        const auto type = sv["processor"].isString() ? sv["processor"].toString() : juce::String();
        stage.processor = findProcessor (type);
        if (stage.processor == nullptr)
            return fail (where + " uses an unsupported processor: " + (type.isEmpty() ? juce::String ("(none)") : type));
        const auto& spec = *stage.processor;

        if (! sv["bypassed"].isBool())
            return fail (where + " 'bypassed' must be true or false");
        stage.bypassed = (bool) sv["bypassed"];

        // state — exactly the processor's typed non-parameter state, nothing more or less.
        juce::StringArray stateKeys;
        for (int i = 0; i < spec.numState; ++i) stateKeys.add (spec.state[i].key);
        if (auto e = checkKeys (sv["state"], where + " state", stateKeys); e.isNotEmpty())
            return fail (e);
        for (int i = 0; i < spec.numState; ++i)
        {
            const auto& ss = spec.state[i];
            const auto v = sv["state"][ss.key];
            if (ss.kind == StateSpec::Kind::boolean)
            {
                if (! v.isBool())
                    return fail (where + " state '" + ss.key + "' must be true or false");
                stage.state.push_back ({ &ss, juce::var ((bool) v) });
            }
            else
            {
                if (! v.isString() || ! juce::StringArray::fromTokens (ss.allowed, "|", "").contains (v.toString()))
                    return fail (where + " state '" + ss.key + "' must be one of: "
                                 + juce::String (ss.allowed).replace ("|", ", "));
                stage.state.push_back ({ &ss, juce::var (v.toString()) });
            }
        }

        // params — every parameter of the processor, each with its value AND its unit.
        juce::StringArray paramKeys;
        for (int i = 0; i < spec.numParams; ++i) paramKeys.add (spec.params[i].id);
        if (auto e = checkKeys (sv["params"], where + " params", paramKeys); e.isNotEmpty())
            return fail (e);
        for (int i = 0; i < spec.numParams; ++i)
        {
            const auto& ps = spec.params[i];
            const auto pv = sv["params"][ps.id];
            const juce::String pwhere = where + " " + ps.id;
            if (auto e = checkKeys (pv, pwhere, { "value", "unit" }); e.isNotEmpty())
                return fail (e);
            if (! pv["unit"].isString() || pv["unit"].toString() != ps.unit)
                return fail (pwhere + " must be given in " + ps.unit);
            if (! isNumber (pv["value"]))
                return fail (pwhere + " value must be a number");
            const double canonical = (double) pv["value"];
            const auto conv = toNative (ps, canonical);
            if (! conv.ok)
                return fail (where + ": " + conv.error);
            stage.params.push_back ({ &ps, canonical, conv.native });
        }

        p.stages.push_back (std::move (stage));
    }

    out.ok = true;
    return out;
}

namespace detail
{
    /** Deepest bracket nesting in `text`, ignoring brackets inside strings. JUCE's JSON
        parser recurses once per level with no limit, so a small file of "[[[[…" can
        exhaust the stack; a schema-1 preset nests five levels. */
    inline int maxNestingDepth (const juce::String& text)
    {
        int depth = 0, deepest = 0;
        bool inString = false, escaped = false;
        for (auto c : text)
        {
            if (inString)
            {
                if (escaped)        escaped = false;
                else if (c == '\\') escaped = true;
                else if (c == '"')  inString = false;
            }
            else if (c == '"')              inString = true;
            else if (c == '{' || c == '[')  deepest = juce::jmax (deepest, ++depth);
            else if (c == '}' || c == ']')  --depth;
        }
        return deepest;
    }
}

inline constexpr int kMaxNesting = 16;

/** parseTrackPreset over raw file text. A document that is not valid JSON is an error
    here rather than an empty var that happens to fail the first key check. */
inline ParseResult parseTrackPresetText (const juce::String& text)
{
    if (detail::maxNestingDepth (text) > kMaxNesting)
    {
        ParseResult out;
        out.error = "preset is not valid JSON: nested too deeply";
        return out;
    }

    juce::var parsed;
    const auto result = juce::JSON::parse (text, parsed);
    if (result.failed())
    {
        ParseResult out;
        out.error = "preset is not valid JSON: " + result.getErrorMessage();
        return out;
    }
    return parseTrackPreset (parsed);
}

} // namespace mosh::trackpreset
