#include "ReImagineSession.h"

#include <algorithm>
#include <cmath>
#include <set>

namespace mosh::reimagine
{
const char* const kTransformTemplateVersion = "reimagine-transform-template/1";

namespace
{
constexpr float kSilentPeak = 1.0e-4f;         // -80 dBFS: nothing usable
constexpr float kQuietRms = 1.0e-3f;           // -60 dBFS RMS: visible warning only
constexpr float kClipPeak = 0.999f;

bool isChordSymbol (const juce::String& symbol)
{
    if (symbol.isEmpty() || symbol.length() > 16)
        return false;
    const auto root = symbol[0];
    if (root < 'A' || root > 'G')
        return false;
    return symbol.containsOnly ("ABCDEFGabcdefgimjsuMdo0123456789#+-/()^");
}

juce::String formatBar (double bar)
{
    return std::abs (bar - std::round (bar)) < 1.0e-9 ? juce::String (static_cast<int> (std::round (bar)))
                                                      : juce::String (bar, 2);
}

juce::String nowIso()
{
    return juce::Time::getCurrentTime().toISO8601 (true);
}

juce::var settingsArray (const std::vector<ColorSetting>& colors)
{
    juce::Array<juce::var> rows;
    for (const auto& color : colors)
    {
        auto* row = new juce::DynamicObject();
        row->setProperty ("name", color.id);
        row->setProperty ("value", color.amount);
        rows.add (juce::var (row));
    }
    return rows;
}

juce::var settingsArray (const std::vector<LoraSetting>& loras)
{
    juce::Array<juce::var> rows;
    for (const auto& lora : loras)
    {
        auto* row = new juce::DynamicObject();
        row->setProperty ("name", lora.id);
        row->setProperty ("value", lora.scale * 100.0f);
        rows.add (juce::var (row));
    }
    return rows;
}

juce::var stringArrayToVar (const juce::StringArray& strings)
{
    juce::Array<juce::var> values;
    for (const auto& s : strings)
        values.add (s);
    return values;
}

// The structured chord-timing field shared by the service request and the stored request.
juce::var chordTimingToVar (const std::vector<ChordEvent>& chords, Provenance from)
{
    auto* o = new juce::DynamicObject();
    o->setProperty ("unit", "bar");
    o->setProperty ("origin", "region-start");   // bar 1 == the first sample of the input
    o->setProperty ("provenance", provenanceName (from));
    o->setProperty ("enforced", false);
    juce::Array<juce::var> events;
    for (const auto& chord : chords)
    {
        auto* row = new juce::DynamicObject();
        row->setProperty ("bar", chord.bar);
        row->setProperty ("symbol", chord.symbol);
        events.add (juce::var (row));
    }
    o->setProperty ("events", events);
    return juce::var (o);
}

juce::StringArray stringArrayFromVar (const juce::var& v)
{
    juce::StringArray result;
    if (auto* items = v.getArray())
        for (const auto& item : *items)
            result.add (item.toString());
    return result;
}
}

juce::String provenanceName (Provenance p) noexcept
{
    switch (p)
    {
        case Provenance::host: return "host";
        case Provenance::user: return "user";
        case Provenance::inferred: return "inferred";
        case Provenance::unknown: break;
    }
    return "unknown";
}

Provenance provenanceFromName (const juce::String& name) noexcept
{
    if (name == "host") return Provenance::host;
    if (name == "user") return Provenance::user;
    if (name == "inferred") return Provenance::inferred;
    return Provenance::unknown;
}

ChordParseResult parseChordList (const juce::String& text, double regionBars)
{
    ChordParseResult result;
    auto tokens = juce::StringArray::fromTokens (text.replaceCharacters (",|", "  "), " \t\r\n", {});
    tokens.removeEmptyStrings();
    double previousBar = 0.0;
    for (const auto& token : tokens)
    {
        const auto colon = token.indexOfChar (':');
        if (colon <= 0 || colon == token.length() - 1)
        {
            result.errors.add ("\"" + token + "\" is not bar:chord (e.g. 1:Fm7)");
            continue;
        }
        const auto barText = token.substring (0, colon).trim();
        const auto symbol = token.substring (colon + 1).trim();
        if (! barText.containsOnly ("0123456789.") || barText.isEmpty())
        {
            result.errors.add ("\"" + barText + "\" is not a bar number");
            continue;
        }
        const auto bar = barText.getDoubleValue();
        if (! std::isfinite (bar) || bar < 1.0)
        {
            result.errors.add ("Bar " + barText + " is before bar 1");
            continue;
        }
        if (bar <= previousBar)
        {
            result.errors.add ("Bar " + barText + " is not after the previous chord");
            continue;
        }
        if (regionBars > 0.0 && bar >= regionBars + 1.0)
        {
            result.errors.add ("Bar " + barText + " starts after the region ends (" + formatBar (regionBars) + " bars)");
            continue;
        }
        if (! isChordSymbol (symbol))
        {
            result.errors.add ("\"" + symbol + "\" is not a chord symbol");
            continue;
        }
        previousBar = bar;
        result.chords.push_back ({ bar, symbol });
    }
    return result;
}

juce::String formatChordList (const std::vector<ChordEvent>& chords)
{
    juce::StringArray parts;
    for (const auto& chord : chords)
        parts.add (formatBar (chord.bar) + ":" + chord.symbol);
    return parts.joinIntoString (" ");
}

juce::String formatChordTimingForPrompt (const std::vector<ChordEvent>& chords)
{
    if (chords.empty())
        return {};
    juce::StringArray parts;
    for (const auto& chord : chords)
        parts.add (formatBar (chord.bar) + " " + chord.symbol);
    return "chords by bar: " + parts.joinIntoString (", ");
}

bool isConstantTempo (const TempoMap& map, double tolerance) noexcept
{
    if (map.empty())
        return false;
    for (const auto& point : map)
        if (! std::isfinite (point.bpm) || std::abs (point.bpm - map.front().bpm) > tolerance)
            return false;
    return true;
}

SessionContext mergeHostFacts (SessionContext context, const RegionFacts& facts)
{
    if (context.bpmFrom != Provenance::user)
    {
        if (! context.tempoAssumed && isConstantTempo (facts.tempoMap) && facts.tempoMap.front().bpm > 0.0)
        {
            context.bpm = facts.tempoMap.front().bpm;
            context.bpmFrom = Provenance::host;
        }
        else
        {
            context.bpm.reset();
            context.bpmFrom = Provenance::unknown;
        }
    }
    if (context.meterFrom != Provenance::user)
    {
        if (facts.hostMeterNumerator && *facts.hostMeterNumerator > 0)
        {
            context.meterNumerator = facts.hostMeterNumerator;
            context.meterDenominator.reset();   // the plug-in's HostPosition carries no denominator
            context.meterFrom = Provenance::host;
        }
        else
        {
            context.meterNumerator.reset();
            context.meterDenominator.reset();
            context.meterFrom = Provenance::unknown;
        }
    }
    return context;
}

CompileResult compileIntention (const IntentionInput& input, const SessionSnapshot& snapshot,
                                const juce::String& intentionId, const juce::String& parentTakeId,
                                int attemptsSoFar, int maxAttempts)
{
    CompileResult result;
    const auto request = input.request.trim();
    const auto revision = input.revision.trim();
    if (request.isEmpty())
        result.errors.add ("Type what the variation should do");
    if (parentTakeId.isNotEmpty() && revision.isEmpty())
        result.errors.add ("Type what to change from the selected version");
    if (snapshot.inputHash.isEmpty() || snapshot.frames <= 0 || ! (snapshot.sampleRate > 0.0))
        result.errors.add ("No staged audio for this region - Transfer or Import first");
    const auto seconds = snapshot.sampleRate > 0.0 ? static_cast<double> (snapshot.frames) / snapshot.sampleRate : 0.0;
    if (snapshot.frames > 0 && (seconds < kMinSeconds || seconds > kMaxSeconds))
        result.errors.add ("Local SA3 handles " + juce::String (kMinSeconds, 0) + "-" + juce::String (kMaxSeconds, 0)
                           + " s; this audio is " + juce::String (seconds, 2) + " s");
    const bool timingKnown = snapshot.context.bpm.has_value();
    if (snapshot.context.bpmFrom == Provenance::host && ! snapshot.constantTempo)
        result.errors.add ("Tempo changes inside the region - M1 supports constant-tempo regions only");
    if (input.candidateCount < 1 || input.candidateCount > kMaxCandidatesPerBatch)
        result.errors.add ("Candidates per batch must be 1-" + juce::String (kMaxCandidatesPerBatch));
    if (! std::isfinite (input.strength) || input.strength < kMinStrength || input.strength > kMaxStrength)
        result.errors.add ("Strength must be within 0.01-0.5");
    const auto remaining = maxAttempts - attemptsSoFar;
    if (input.candidateCount > remaining)
        result.errors.add ("Budget: " + juce::String (juce::jmax (0, remaining)) + " of " + juce::String (maxAttempts)
                           + " model attempts left for this intention - start a new intention");

    // Template: the typed request, the revision, then context the user supplied. Context
    // goes in as TEXT ONLY; the conditioning report says so rather than implying control.
    juce::StringArray promptParts;
    promptParts.add (request);
    if (revision.isNotEmpty())
        promptParts.add (revision);
    if (snapshot.context.key.isNotEmpty())
        promptParts.add ("in " + snapshot.context.key);
    if (timingKnown)
        promptParts.add (juce::String (*snapshot.context.bpm, 0) + " BPM");
    // Chords last: their timed form contains ", " separators of its own.
    promptParts.add (formatChordTimingForPrompt (snapshot.context.chords));
    promptParts.removeEmptyStrings();
    const auto prompt = promptParts.joinIntoString (", ");
    if (prompt.length() > kMaxPromptChars)
        result.errors.add ("Request is too long for the template (" + juce::String (prompt.length()) + " > "
                           + juce::String (kMaxPromptChars) + " characters)");

    if (! timingKnown)
        result.warnings.add ("Tempo unknown - alignment with the host timeline is not verified");
    if (! snapshot.context.chords.empty())
        result.warnings.add ("Chords and their change bars go to the model as text only - harmony is not enforced, "
                             "nor is change timing");
    if (! snapshot.context.protectedChoices.isEmpty())
        result.warnings.add ("Protected choices are recorded for review; the model is not constrained by them");
    if (! result.errors.isEmpty())
        return result;

    CompiledRequest compiled;
    compiled.intentionId = intentionId;
    compiled.snapshotId = snapshot.id;
    compiled.parentTakeId = parentTakeId;
    compiled.templateVersion = kTransformTemplateVersion;
    compiled.prompt = prompt;
    compiled.strength = input.strength;
    compiled.durationSeconds = seconds;
    for (int i = 0; i < input.candidateCount; ++i)
        compiled.seeds.push_back (input.baseSeed + attemptsSoFar + i);
    compiled.colors = input.colors;
    compiled.loras = input.loras;
    compiled.protectedChoices = snapshot.context.protectedChoices;
    compiled.chordTiming = snapshot.context.chords;
    compiled.chordTimingFrom = snapshot.context.chords.empty() ? Provenance::unknown : snapshot.context.chordsFrom;
    compiled.attemptsBefore = attemptsSoFar;
    compiled.maxAttempts = maxAttempts;

    const auto& ctx = snapshot.context;
    compiled.conditioning.push_back ({ snapshot.inputRole == "parent-take" ? "parent-take-audio" : "source-audio", true, "audio", true,
                                       "init audio at strength " + juce::String (input.strength, 2)
                                       + "; resemblance is not a preservation guarantee" });
    compiled.conditioning.push_back ({ "duration", true, "duration", true,
                                       "output length requested equal to the input (" + juce::String (seconds, 3) + " s)" });
    compiled.conditioning.push_back ({ "tempo", timingKnown, timingKnown ? "text-prompt" : "not-sent", false,
                                       timingKnown ? "BPM named in the prompt (" + provenanceName (ctx.bpmFrom)
                                                         + "); beat alignment is not enforced"
                                                   : "unknown" });
    compiled.conditioning.push_back ({ "meter", ctx.meterNumerator.has_value(), "not-sent", false,
                                       ctx.meterNumerator ? "stored (" + provenanceName (ctx.meterFrom) + ")" : "unknown" });
    compiled.conditioning.push_back ({ "key", ctx.key.isNotEmpty(), ctx.key.isNotEmpty() ? "text-prompt" : "not-sent", false,
                                       ctx.key.isNotEmpty() ? "named in the prompt (" + provenanceName (ctx.keyFrom) + ")" : "unknown" });
    compiled.conditioning.push_back ({ "chords", ! ctx.chords.empty(), ctx.chords.empty() ? "not-sent" : "text-prompt+structured", false,
                                       ctx.chords.empty() ? "unknown"
                                                          : "chord names and change bars (" + formatChordList (ctx.chords)
                                                                + ", " + provenanceName (ctx.chordsFrom)
                                                                + ") sent in the prompt and as chord_timing; "
                                                                  "neither harmony nor change timing is enforced" });
    compiled.conditioning.push_back ({ "section", ctx.sectionLabel.isNotEmpty(), "not-sent", false,
                                       ctx.sectionLabel.isNotEmpty() ? "stored only" : "unknown" });
    compiled.conditioning.push_back ({ "protected-choices", ! ctx.protectedChoices.isEmpty(), "not-sent", false,
                                       "recorded for review; not a model constraint" });

    if (auto problems = validateRequest (compiled); ! problems.isEmpty())
    {
        result.errors.addArray (problems);
        return result;
    }
    result.request = std::move (compiled);
    return result;
}

juce::StringArray validateRequest (const CompiledRequest& r)
{
    juce::StringArray problems;
    if (r.intentionId.isEmpty() || r.snapshotId.isEmpty())
        problems.add ("Request is not bound to an intention and snapshot");
    if (r.task != "transform")
        problems.add ("Unsupported task \"" + r.task + "\" (M1 supports transform)");
    if (r.backend != "stable_audio3" || r.modelVariant != "sa3-medium")
        problems.add ("Unsupported backend " + r.backend + "/" + r.modelVariant);
    if (r.prompt.trim().isEmpty() || r.prompt.length() > kMaxPromptChars)
        problems.add ("Prompt must be 1-" + juce::String (kMaxPromptChars) + " characters");
    if (! std::isfinite (r.strength) || r.strength < kMinStrength || r.strength > kMaxStrength)
        problems.add ("Strength outside 0.01-0.5");
    if (! std::isfinite (r.durationSeconds) || r.durationSeconds < kMinSeconds || r.durationSeconds > kMaxSeconds)
        problems.add ("Duration outside the backend's range");
    if (r.seeds.empty() || static_cast<int> (r.seeds.size()) > kMaxCandidatesPerBatch)
        problems.add ("Candidate count outside 1-" + juce::String (kMaxCandidatesPerBatch));
    if (std::set<int64_t> (r.seeds.begin(), r.seeds.end()).size() != r.seeds.size())
        problems.add ("Candidate seeds must be distinct");
    if (r.attemptsBefore < 0 || r.attemptsBefore + static_cast<int> (r.seeds.size()) > r.maxAttempts)
        problems.add ("Request exceeds the intention's attempt budget");
    for (const auto& color : r.colors)
        if (color.id.isEmpty() || ! std::isfinite (color.amount) || color.amount < 0.0f || color.amount > 100.0f)
            problems.add ("Invalid color setting");
    for (const auto& lora : r.loras)
        if (lora.id.isEmpty() || ! std::isfinite (lora.scale) || lora.scale < 0.0f || lora.scale > 1.5f)
            problems.add ("Invalid LoRA setting");
    double previousBar = 0.0;
    for (const auto& chord : r.chordTiming)
    {
        if (! std::isfinite (chord.bar) || chord.bar < 1.0 || chord.bar <= previousBar || ! isChordSymbol (chord.symbol))
        {
            problems.add ("Invalid chord timing (bars must be >= 1 and increasing, symbols must be chords)");
            break;
        }
        previousBar = chord.bar;
    }
    return problems;
}

juce::var directServiceParams (const CompiledRequest& r, size_t candidateIndex,
                               const juce::String& inputSha256, const juce::String& requestId)
{
    auto* params = new juce::DynamicObject();
    params->setProperty ("prompt", r.prompt);
    params->setProperty ("nl", static_cast<double> (r.strength));
    params->setProperty ("seed", static_cast<juce::int64> (candidateIndex < r.seeds.size() ? r.seeds[candidateIndex] : 0));
    params->setProperty ("lab", false);
    params->setProperty ("mode", "reimagine");
    params->setProperty ("coverage", "single");
    params->setProperty ("duration_s", r.durationSeconds);
    params->setProperty ("decision_policy", "explicit");
    params->setProperty ("request_id", requestId);
    params->setProperty ("source_sha256", inputSha256);
    params->setProperty ("colors", settingsArray (r.colors));
    params->setProperty ("loras", settingsArray (r.loras));
    // Additive and optional (service/direct_render.py): absent when no chords are known,
    // so requests without chords are byte-for-byte what they were before.
    if (! r.chordTiming.empty())
        params->setProperty ("chord_timing", chordTimingToVar (r.chordTiming, r.chordTimingFrom));
    return juce::var (params);
}

juce::var contextToVar (const SessionContext& c)
{
    auto* o = new juce::DynamicObject();
    o->setProperty ("bpm", c.bpm ? juce::var (*c.bpm) : juce::var());
    o->setProperty ("bpmFrom", provenanceName (c.bpmFrom));
    o->setProperty ("meterNumerator", c.meterNumerator ? juce::var (*c.meterNumerator) : juce::var());
    o->setProperty ("meterDenominator", c.meterDenominator ? juce::var (*c.meterDenominator) : juce::var());
    o->setProperty ("meterFrom", provenanceName (c.meterFrom));
    o->setProperty ("key", c.key);
    o->setProperty ("keyFrom", provenanceName (c.keyFrom));
    juce::Array<juce::var> chords;
    for (const auto& chord : c.chords)
    {
        auto* row = new juce::DynamicObject();
        row->setProperty ("bar", chord.bar);
        row->setProperty ("symbol", chord.symbol);
        chords.add (juce::var (row));
    }
    o->setProperty ("chords", chords);
    o->setProperty ("chordsFrom", provenanceName (c.chordsFrom));
    o->setProperty ("section", c.sectionLabel);
    o->setProperty ("protected", stringArrayToVar (c.protectedChoices));
    o->setProperty ("tempoMapAssumed", c.tempoAssumed);
    return juce::var (o);
}

SessionContext contextFromVar (const juce::var& v)
{
    SessionContext c;
    auto* o = v.getDynamicObject();
    if (o == nullptr)
        return c;
    if (const auto bpm = o->getProperty ("bpm"); ! bpm.isVoid() && static_cast<double> (bpm) > 0.0)
        c.bpm = static_cast<double> (bpm);
    c.bpmFrom = c.bpm ? provenanceFromName (o->getProperty ("bpmFrom").toString()) : Provenance::unknown;
    if (const auto n = o->getProperty ("meterNumerator"); ! n.isVoid() && static_cast<int> (n) > 0)
        c.meterNumerator = static_cast<int> (n);
    if (const auto d = o->getProperty ("meterDenominator"); ! d.isVoid() && static_cast<int> (d) > 0)
        c.meterDenominator = static_cast<int> (d);
    c.meterFrom = c.meterNumerator ? provenanceFromName (o->getProperty ("meterFrom").toString()) : Provenance::unknown;
    c.key = o->getProperty ("key").toString();
    c.keyFrom = c.key.isNotEmpty() ? provenanceFromName (o->getProperty ("keyFrom").toString()) : Provenance::unknown;
    if (auto* chords = o->getProperty ("chords").getArray())
        for (const auto& item : *chords)
            if (auto* row = item.getDynamicObject())
                c.chords.push_back ({ static_cast<double> (row->getProperty ("bar")), row->getProperty ("symbol").toString() });
    c.chordsFrom = c.chords.empty() ? Provenance::unknown : provenanceFromName (o->getProperty ("chordsFrom").toString());
    c.sectionLabel = o->getProperty ("section").toString();
    c.protectedChoices = stringArrayFromVar (o->getProperty ("protected"));
    c.tempoAssumed = static_cast<bool> (o->getProperty ("tempoMapAssumed"));
    return c;
}

juce::var snapshotToVar (const SessionSnapshot& s)
{
    auto* o = new juce::DynamicObject();
    o->setProperty ("id", s.id);
    o->setProperty ("instanceId", s.instanceId);
    o->setProperty ("regionId", s.regionId);
    o->setProperty ("sourceHash", s.sourceHash);
    o->setProperty ("inputHash", s.inputHash);
    o->setProperty ("inputRole", s.inputRole);
    o->setProperty ("sampleRate", s.sampleRate);
    o->setProperty ("channels", s.channels);
    o->setProperty ("frames", static_cast<juce::int64> (s.frames));
    o->setProperty ("regionOffsetSamples", static_cast<juce::int64> (s.regionOffsetSamples));
    o->setProperty ("ppqStart", s.ppqStart);
    o->setProperty ("ppqEnd", s.ppqEnd);
    o->setProperty ("constantTempo", s.constantTempo);
    o->setProperty ("context", contextToVar (s.context));
    o->setProperty ("created", s.createdIso8601);
    return juce::var (o);
}

juce::var compiledRequestToVar (const CompiledRequest& r)
{
    auto* o = new juce::DynamicObject();
    o->setProperty ("intentionId", r.intentionId);
    o->setProperty ("snapshotId", r.snapshotId);
    o->setProperty ("parentTakeId", r.parentTakeId);
    o->setProperty ("task", r.task);
    o->setProperty ("backend", r.backend);
    o->setProperty ("modelVariant", r.modelVariant);
    o->setProperty ("template", r.templateVersion);
    o->setProperty ("controller", "template-only (no language model)");
    o->setProperty ("prompt", r.prompt);
    o->setProperty ("strength", static_cast<double> (r.strength));
    o->setProperty ("durationSeconds", r.durationSeconds);
    juce::Array<juce::var> seeds;
    for (auto seed : r.seeds)
        seeds.add (static_cast<juce::int64> (seed));
    o->setProperty ("seeds", seeds);
    o->setProperty ("colors", settingsArray (r.colors));
    o->setProperty ("loras", settingsArray (r.loras));
    o->setProperty ("protected", stringArrayToVar (r.protectedChoices));
    o->setProperty ("chordTiming", r.chordTiming.empty() ? juce::var() : chordTimingToVar (r.chordTiming, r.chordTimingFrom));
    juce::Array<juce::var> conditioning;
    for (const auto& entry : r.conditioning)
    {
        auto* row = new juce::DynamicObject();
        row->setProperty ("field", entry.field);
        row->setProperty ("stored", entry.stored);
        row->setProperty ("sentAs", entry.sentAs);
        row->setProperty ("enforced", entry.enforced);
        row->setProperty ("note", entry.note);
        conditioning.add (juce::var (row));
    }
    o->setProperty ("conditioning", conditioning);
    o->setProperty ("attemptsBefore", r.attemptsBefore);
    o->setProperty ("maxAttempts", r.maxAttempts);
    return juce::var (o);
}

int remainingAttempts (const IntentionRecord& intention) noexcept
{
    return juce::jmax (0, intention.maxAttempts - intention.attempts);
}

juce::var intentionToVar (const IntentionRecord& i)
{
    auto* o = new juce::DynamicObject();
    o->setProperty ("id", i.id);
    o->setProperty ("regionId", i.regionId);
    o->setProperty ("request", i.request);
    o->setProperty ("revisions", stringArrayToVar (i.revisions));
    o->setProperty ("snapshot", i.snapshot);
    o->setProperty ("attempts", i.attempts);
    o->setProperty ("failures", i.failures);
    o->setProperty ("maxAttempts", i.maxAttempts);
    o->setProperty ("created", i.createdIso8601);
    return juce::var (o);
}

IntentionRecord intentionFromVar (const juce::var& v)
{
    IntentionRecord i;
    if (auto* o = v.getDynamicObject())
    {
        i.id = o->getProperty ("id").toString();
        i.regionId = o->getProperty ("regionId").toString();
        i.request = o->getProperty ("request").toString();
        i.revisions = stringArrayFromVar (o->getProperty ("revisions"));
        i.snapshot = o->getProperty ("snapshot");
        i.attempts = juce::jmax (0, static_cast<int> (o->getProperty ("attempts")));
        i.failures = juce::jmax (0, static_cast<int> (o->getProperty ("failures")));
        const auto maxAttempts = static_cast<int> (o->getProperty ("maxAttempts"));
        i.maxAttempts = maxAttempts > 0 ? maxAttempts : kDefaultMaxAttemptsPerIntention;
        i.createdIso8601 = o->getProperty ("created").toString();
    }
    return i;
}

AudioStats measureAudio (const float* const* channels, int numChannels, int64_t frames, double sampleRate) noexcept
{
    AudioStats stats;
    stats.frames = frames;
    stats.sampleRate = sampleRate;
    stats.channels = numChannels;
    double sumSquares = 0.0;
    int64_t counted = 0;
    for (int channel = 0; channel < numChannels; ++channel)
    {
        const auto* data = channels[channel];
        if (data == nullptr)
            continue;
        for (int64_t i = 0; i < frames; ++i)
        {
            const auto sample = data[i];
            if (! std::isfinite (sample))
            {
                ++stats.nonFiniteSamples;
                continue;
            }
            stats.peak = std::max (stats.peak, std::abs (sample));
            sumSquares += static_cast<double> (sample) * sample;
            ++counted;
        }
    }
    stats.rms = counted > 0 ? static_cast<float> (std::sqrt (sumSquares / static_cast<double> (counted))) : 0.0f;
    return stats;
}

TechnicalReport checkCandidate (const AudioStats& s, double expectedSeconds, int expectedChannels)
{
    TechnicalReport report;
    if (s.frames <= 0 || ! (s.sampleRate > 0.0) || s.channels <= 0)
        report.failures.add ("Audio did not decode to any frames");
    if (s.nonFiniteSamples > 0)
        report.failures.add (juce::String (s.nonFiniteSamples) + " non-finite samples");
    if (report.failures.isEmpty() && s.peak < kSilentPeak)
        report.failures.add ("Silent (peak below -80 dBFS)");
    if (report.failures.isEmpty())
    {
        if (s.peak >= kClipPeak)
            report.warnings.add ("Peak reaches 0 dBFS - possible clipping");
        if (s.rms < kQuietRms)
            report.warnings.add ("Very quiet (RMS below -60 dBFS)");
        if (expectedChannels > 0 && s.channels != expectedChannels)
            report.warnings.add (juce::String (s.channels) + " channel(s); source has " + juce::String (expectedChannels));
        const auto seconds = static_cast<double> (s.frames) / s.sampleRate;
        report.durationDeltaSeconds = seconds - expectedSeconds;
        if (expectedSeconds > 0.0
            && std::abs (report.durationDeltaSeconds) > std::max (0.05, expectedSeconds * 0.01))
            report.warnings.add ("Length differs from the region by " + juce::String (report.durationDeltaSeconds, 3)
                                 + " s - playback stops at the shorter of the two; no stretching applied");
    }
    report.usable = report.failures.isEmpty();
    return report;
}

juce::var technicalReportToVar (const TechnicalReport& r)
{
    auto* o = new juce::DynamicObject();
    o->setProperty ("kind", "technical-checks (not a taste judgement)");
    o->setProperty ("usable", r.usable);
    o->setProperty ("failures", stringArrayToVar (r.failures));
    o->setProperty ("warnings", stringArrayToVar (r.warnings));
    o->setProperty ("durationDeltaSeconds", r.durationDeltaSeconds);
    return juce::var (o);
}

juce::String tempoVerdictName (TempoVerdict v) noexcept
{
    switch (v)
    {
        case TempoVerdict::conforms: return "conforms";
        case TempoVerdict::drifts: return "drifts";
        case TempoVerdict::undetermined: break;
    }
    return "undetermined";
}

namespace
{
constexpr double kTempoHopSeconds = 0.005;
constexpr double kTempoSearchFraction = 0.15;  // look for the pulse within +-15% of the session period
constexpr double kTempoMinBeats = 4.0;
constexpr int64_t kTempoWindowHops = 4;          // 20 ms energy window
constexpr double kTempoRiseGate = 0.1;           // natural-log rise ignored below ~0.4 dB

// Normalized, overlap-corrected autocorrelation of a mean-removed envelope at one lag.
double autocorrelationAt (const std::vector<double>& x, double energy, int lag) noexcept
{
    const auto n = static_cast<int> (x.size());
    if (lag <= 0 || lag >= n || energy <= 0.0)
        return 0.0;
    double sum = 0.0;
    for (int i = 0; i + lag < n; ++i)
        sum += x[static_cast<size_t> (i)] * x[static_cast<size_t> (i + lag)];
    return (sum / static_cast<double> (n - lag)) / (energy / static_cast<double> (n));
}

struct LagPeak
{
    bool found = false;
    double lag = 0.0;                            // fractional, in hops
    double strength = 0.0;
};

// Strongest lag inside [lo, hi]; rejected when the maximum sits on the window edge (the
// true peak lies outside, so the window says nothing). Fractional position by the
// centroid of the peak and its two neighbours, which undoes hop quantization of onsets.
LagPeak findPeak (const std::vector<double>& x, double energy, int lo, int hi)
{
    LagPeak peak;
    lo = std::max (lo, 1);
    hi = std::min (hi, static_cast<int> (x.size()) - 2);
    if (hi - lo < 2)
        return peak;
    std::vector<double> values;
    values.reserve (static_cast<size_t> (hi - lo + 1));
    for (int lag = lo; lag <= hi; ++lag)
        values.push_back (autocorrelationAt (x, energy, lag));
    const auto best = std::max_element (values.begin(), values.end());
    const auto index = static_cast<int> (std::distance (values.begin(), best));
    if (index == 0 || index == static_cast<int> (values.size()) - 1)
        return peak;
    const auto left = std::max (0.0, values[static_cast<size_t> (index - 1)]);
    const auto centre = std::max (0.0, *best);
    const auto right = std::max (0.0, values[static_cast<size_t> (index + 1)]);
    const auto mass = left + centre + right;
    if (! (mass > 0.0))
        return peak;
    peak.found = true;
    peak.lag = lo + index + (right - left) / mass;
    peak.strength = *best;
    return peak;
}
}

TempoConformanceReport checkTempoConformance (const float* const* channels, int numChannels, int64_t frames,
                                              double sampleRate, const SessionContext& context)
{
    TempoConformanceReport r;
    r.sessionBpm = context.bpm;
    r.bpmFrom = context.bpm ? context.bpmFrom : Provenance::unknown;
    r.meterAssumed = ! (context.meterNumerator && *context.meterNumerator > 0);
    r.beatsPerBar = r.meterAssumed ? 4.0 : static_cast<double> (*context.meterNumerator);
    const auto undetermined = [&r] (const juce::String& why)
    {
        r.verdict = TempoVerdict::undetermined;
        r.estimatedBpm.reset();
        r.driftMsPerBar = 0.0;
        r.reason = why;
        return r;
    };
    if (context.tempoAssumed)
        return undetermined ("the region's tempo map was assumed (import before host timing), so there is no session tempo to compare against");
    if (! context.bpm || r.bpmFrom == Provenance::unknown || ! std::isfinite (*context.bpm) || *context.bpm <= 0.0)
        return undetermined ("session BPM unknown");
    if (channels == nullptr || numChannels <= 0 || frames <= 0 || ! (sampleRate > 0.0))
        return undetermined ("no decoded audio");

    const auto hop = std::max (1, static_cast<int> (std::lround (sampleRate * kTempoHopSeconds)));
    const auto hopSeconds = static_cast<double> (hop) / sampleRate;
    const auto beatSeconds = 60.0 / *context.bpm;
    const auto hops = static_cast<int64_t> (frames / hop);
    if (static_cast<double> (frames) / sampleRate < kTempoMinBeats * beatSeconds || hops < 16)
        return undetermined ("shorter than " + juce::String (kTempoMinBeats, 0) + " beats at the session tempo");

    // Per-hop energy of the first difference (high-frequency emphasis): transients pass,
    // steady low tones and their window ripple are strongly attenuated.
    std::vector<double> hopEnergy (static_cast<size_t> (hops), 0.0);
    for (int c = 0; c < numChannels; ++c)
    {
        const auto* data = channels[c];
        if (data == nullptr)
            continue;
        float last = 0.0f;
        for (int64_t i = 0; i < hops * hop; ++i)
        {
            const auto sample = std::isfinite (data[i]) ? data[i] : 0.0f;
            const auto diff = static_cast<double> (sample) - last;
            last = sample;
            hopEnergy[static_cast<size_t> (i / hop)] += diff * diff;
        }
    }
    // Log energy over a sliding window ending at each hop, floored at -60 dB below the
    // loudest window; the onset envelope is its rise, gated so ripple and noise do not count.
    std::vector<double> level (static_cast<size_t> (hops), 0.0);
    double loudest = 0.0;
    for (int64_t h = 0; h < hops; ++h)
    {
        double sum = 0.0;
        for (int64_t k = std::max<int64_t> (0, h - kTempoWindowHops + 1); k <= h; ++k)
            sum += hopEnergy[static_cast<size_t> (k)];
        level[static_cast<size_t> (h)] = sum;
        loudest = std::max (loudest, sum);
    }
    if (! (loudest > 0.0))
        return undetermined ("no onsets (silent audio)");
    std::vector<double> envelope (static_cast<size_t> (hops), 0.0);
    for (size_t h = 0; h < level.size(); ++h)
        level[h] = std::log (std::max (level[h], loudest * 1.0e-6));
    for (size_t h = 1; h < level.size(); ++h)
        envelope[h] = std::max (0.0, level[h] - level[h - 1] - kTempoRiseGate);
    double mean = 0.0;
    for (auto v : envelope)
        mean += v;
    mean /= static_cast<double> (envelope.size());
    double energy = 0.0;
    for (auto& v : envelope)
    {
        v -= mean;
        energy += v * v;
    }
    if (! (energy > 1.0e-12))
        return undetermined ("no onsets (steady or silent audio)");

    // Coarse: the beat lag, or 2 beats for a half-time pulse. Longer lags are not used:
    // 4 beats at 120 BPM equal 3 beats at 90, so a 4-beat match would pass a wrong tempo.
    const auto period = beatSeconds / hopSeconds;   // in hops
    const auto maxLag = static_cast<double> (hops) * 0.75;
    double estimate = 0.0;
    for (const int beats : { 1, 2 })
    {
        const auto target = period * beats;
        if (target * (1.0 + kTempoSearchFraction) >= maxLag)
            break;
        const auto spread = std::max (2.0, target * kTempoSearchFraction);
        const auto peak = findPeak (envelope, energy, static_cast<int> (std::floor (target - spread)),
                                    static_cast<int> (std::ceil (target + spread)));
        if (peak.found && peak.strength >= kTempoMinPulseStrength)
        {
            estimate = peak.lag / beats;
            r.pulseStrength = juce::jlimit (0.0, 1.0, peak.strength);
            break;
        }
    }
    if (! (estimate > 0.0))
        return undetermined ("no clear periodic pulse within " + juce::String (kTempoSearchFraction * 100.0, 0)
                             + "% of the session tempo");

    // Refine on longer lags: hop quantization is divided by the number of beats spanned.
    for (int beats = 2; estimate * beats + 3.0 < maxLag; beats *= 2)
    {
        const auto target = estimate * beats;
        const auto peak = findPeak (envelope, energy, static_cast<int> (std::floor (target - 3.0)),
                                    static_cast<int> (std::ceil (target + 3.0)));
        if (! peak.found || peak.strength < kTempoMinPulseStrength * 0.5)
            break;
        estimate = peak.lag / beats;
    }

    const auto estimatedBeatSeconds = estimate * hopSeconds;
    r.estimatedBpm = 60.0 / estimatedBeatSeconds;
    r.driftMsPerBar = (estimatedBeatSeconds - beatSeconds) * r.beatsPerBar * 1000.0;
    r.verdict = std::abs (r.driftMsPerBar) <= kTempoConformsMsPerBar ? TempoVerdict::conforms : TempoVerdict::drifts;
    r.reason = "beat period only; downbeat phase and swing are not checked";
    return r;
}

juce::String describeTempoConformance (const TempoConformanceReport& r)
{
    if (r.verdict == TempoVerdict::undetermined)
        return "undetermined - " + r.reason;
    const auto session = juce::String (r.sessionBpm.value_or (0.0), 2) + " BPM (" + provenanceName (r.bpmFrom) + ")";
    const auto estimated = juce::String (r.estimatedBpm.value_or (0.0), 2) + " BPM";
    const auto meter = r.meterAssumed ? juce::String (", 4 beats/bar assumed") : juce::String();
    if (r.verdict == TempoVerdict::conforms)
        return "conforms to " + session + " (measured " + estimated + ", "
               + juce::String (r.driftMsPerBar, 1) + " ms per bar" + meter + ")";
    return "drifts " + juce::String (std::abs (r.driftMsPerBar), 1) + " ms per bar "
           + (r.driftMsPerBar > 0.0 ? "slower" : "faster") + " than " + session + " (measured " + estimated + meter + ")";
}

juce::var tempoConformanceToVar (const TempoConformanceReport& r)
{
    auto* o = new juce::DynamicObject();
    o->setProperty ("kind", "tempo-conformance (technical, not a taste judgement)");
    o->setProperty ("method", "onset-autocorrelation/1");
    o->setProperty ("verdict", tempoVerdictName (r.verdict));
    o->setProperty ("sessionBpm", r.sessionBpm ? juce::var (*r.sessionBpm) : juce::var());
    o->setProperty ("bpmFrom", provenanceName (r.bpmFrom));
    o->setProperty ("estimatedBpm", r.estimatedBpm ? juce::var (*r.estimatedBpm) : juce::var());
    o->setProperty ("driftMsPerBar", r.verdict == TempoVerdict::undetermined ? juce::var() : juce::var (r.driftMsPerBar));
    o->setProperty ("beatsPerBar", r.beatsPerBar);
    o->setProperty ("meterAssumed", r.meterAssumed);
    o->setProperty ("toleranceMsPerBar", kTempoConformsMsPerBar);
    o->setProperty ("pulseStrength", r.pulseStrength);
    o->setProperty ("phaseChecked", false);
    o->setProperty ("reason", r.reason);
    o->setProperty ("summary", describeTempoConformance (r));
    return juce::var (o);
}

juce::String describeStoredTempoConformance (const juce::var& stored)
{
    const auto summary = stored.getProperty ("summary", {}).toString();
    return summary.isNotEmpty() ? summary : juce::String ("not measured (version predates the check)");
}

juce::String conformContextRefusal (const SessionContext& context)
{
    if (context.tempoAssumed)
        return "the region's tempo map was assumed (import before host timing); set or confirm the BPM first";
    if (! context.bpm || ! std::isfinite (*context.bpm) || *context.bpm <= 0.0)
        return "session BPM unknown";
    if (context.bpmFrom == Provenance::unknown)
        return "session BPM provenance unknown";
    return {};
}

ConformPlan planConform (const TempoConformanceReport& measured, const SessionContext& context)
{
    ConformPlan plan;
    const auto refuse = [&plan] (const juce::String& why)
    {
        plan.allowed = false;
        plan.stretchRatio = 1.0;
        plan.refusal = why;
        return plan;
    };
    if (const auto why = conformContextRefusal (context); why.isNotEmpty())
        return refuse (why);
    plan.toBpm = *context.bpm;
    if (measured.verdict == TempoVerdict::undetermined)
        return refuse ("tempo conformance is undetermined (" + measured.reason + ")");
    if (! measured.sessionBpm || std::abs (*measured.sessionBpm - *context.bpm) > 0.01)
        return refuse ("the measurement was taken against a different session BPM; measure again");
    if (measured.verdict == TempoVerdict::conforms)
        return refuse ("already conforms (within " + juce::String (kTempoConformsMsPerBar, 0) + " ms per bar); nothing to stretch");
    if (! measured.estimatedBpm || ! std::isfinite (*measured.estimatedBpm) || *measured.estimatedBpm <= 0.0)
        return refuse ("no measured BPM");
    plan.fromBpm = *measured.estimatedBpm;
    plan.driftMsPerBar = measured.driftMsPerBar;
    const auto ratio = plan.fromBpm / plan.toBpm;
    if (! std::isfinite (ratio) || std::abs (ratio - 1.0) > kMaxConformStretch)
        return refuse ("would stretch by " + juce::String ((ratio - 1.0) * 100.0, 1) + "% (limit +-"
                       + juce::String (kMaxConformStretch * 100.0, 0)
                       + "%): more likely another tempo or feel than drift");
    plan.allowed = true;
    plan.stretchRatio = ratio;
    return plan;
}

juce::var conformPlanToVar (const ConformPlan& plan)
{
    auto* o = new juce::DynamicObject();
    o->setProperty ("kind", "conform (timing only; downbeat phase not aligned; not checked by ear)");
    o->setProperty ("allowed", plan.allowed);
    o->setProperty ("stretchRatio", plan.stretchRatio);
    o->setProperty ("fromBpm", plan.fromBpm);
    o->setProperty ("toBpm", plan.toBpm);
    o->setProperty ("driftMsPerBarBefore", plan.driftMsPerBar);
    o->setProperty ("maxStretch", kMaxConformStretch);
    if (plan.refusal.isNotEmpty())
        o->setProperty ("refusal", plan.refusal);
    return juce::var (o);
}

TakeLineage lineageOf (const RenderTake& take)
{
    TakeLineage lineage;
    if (auto* m1 = take.manifest.getProperty ("m1", {}).getDynamicObject())
    {
        lineage.intentionId = m1->getProperty ("intentionId").toString();
        lineage.parentTakeId = m1->getProperty ("parentTakeId").toString();
        lineage.role = m1->getProperty ("role").toString();
        lineage.kept = static_cast<bool> (m1->getProperty ("kept"));
        lineage.testFixture = static_cast<bool> (m1->getProperty ("testFixture"));
        lineage.conformedFrom = m1->getProperty ("conformedFrom").toString();
        if (const auto ratio = m1->getProperty ("stretchRatio"); ratio.isDouble() || ratio.isInt() || ratio.isInt64())
            lineage.stretchRatio = static_cast<double> (ratio);
    }
    return lineage;
}

void setLineage (RenderTake& take, const TakeLineage& lineage)
{
    // Deep copy: take copies share DynamicObjects, and another thread may hold a copy.
    auto manifest = take.manifest.isObject() ? take.manifest.clone() : juce::var (new juce::DynamicObject());
    auto* m1 = new juce::DynamicObject();
    if (auto* existing = manifest.getProperty ("m1", {}).getDynamicObject())
        for (const auto& property : existing->getProperties())
            m1->setProperty (property.name, property.value);
    m1->setProperty ("intentionId", lineage.intentionId);
    m1->setProperty ("parentTakeId", lineage.parentTakeId);
    m1->setProperty ("role", lineage.role);
    m1->setProperty ("kept", lineage.kept);
    m1->setProperty ("testFixture", lineage.testFixture);
    if (lineage.conformedFrom.isNotEmpty())
        m1->setProperty ("conformedFrom", lineage.conformedFrom);
    if (lineage.stretchRatio)
        m1->setProperty ("stretchRatio", *lineage.stretchRatio);
    manifest.getDynamicObject()->setProperty ("m1", juce::var (m1));
    take.manifest = manifest;
}

juce::String takeLabel (const TransferRegion& region, size_t takeIndex)
{
    if (takeIndex >= region.takes.size())
        return {};
    const auto& take = region.takes[takeIndex];
    const auto lineage = lineageOf (take);
    juce::String label = "v" + juce::String (static_cast<int> (takeIndex) + 1);
    if (take.manifest.getProperty ("source", {}).toString() == "import")
        label << " import";
    else if ((lineage.role == "revision" || lineage.role == "conform") && lineage.parentTakeId.isNotEmpty())
    {
        for (size_t i = 0; i < region.takes.size(); ++i)
            if (region.takes[i].id == lineage.parentTakeId)
                label << (lineage.role == "conform" ? " conform of v" : " rev of v") << juce::String (static_cast<int> (i) + 1);
        if (lineage.role == "conform" && lineage.stretchRatio)
            label << " x" << juce::String (*lineage.stretchRatio, 4);
    }
    else
        label << " seed " << juce::String (take.seed);
    if (lineage.kept)
        label << " - KEPT";
    if (lineage.testFixture)
        label << " [test fixture]";
    return label;
}

juce::String exportFileName (const TransferRegion& region, const RenderTake& take, const SessionContext& context,
                             std::optional<int> meterNumerator)
{
    auto stem = context.sectionLabel.trim().retainCharacters ("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_");
    stem = stem.replaceCharacter (' ', '-');
    if (stem.isEmpty())
        stem = "Mosh";
    const auto beats = meterNumerator.value_or (context.meterNumerator.value_or (0));
    juce::String name = stem;
    if (beats > 0)
        name << "_bar" << juce::String (static_cast<int> (std::floor (region.ppqStart / beats)) + 1);
    if (context.bpm)
        name << "_" << juce::String (*context.bpm, 0) << "bpm";
    name << "_" << take.assetHash.substring (0, 8) << ".wav";
    return name;
}

juce::var exportSidecar (const TransferRegion& region, const RenderTake& take, const SessionContext& context,
                         double fileSampleRate, int64_t fileFrames, std::optional<int> meterNumerator)
{
    auto* o = new juce::DynamicObject();
    o->setProperty ("schema", "mosh.reimagine.export/1");
    o->setProperty ("regionId", region.id);
    o->setProperty ("takeId", take.id);
    o->setProperty ("assetSha256", take.assetHash);
    o->setProperty ("sourceSha256", region.sourceHash);
    o->setProperty ("sampleRate", fileSampleRate);
    o->setProperty ("frames", static_cast<juce::int64> (fileFrames));
    o->setProperty ("seconds", fileSampleRate > 0.0 ? static_cast<double> (fileFrames) / fileSampleRate : 0.0);
    o->setProperty ("ppqStart", region.ppqStart);
    o->setProperty ("ppqEnd", region.ppqEnd);
    const auto beats = meterNumerator.value_or (context.meterNumerator.value_or (0));
    o->setProperty ("startBar", beats > 0 ? juce::var (region.ppqStart / beats + 1.0) : juce::var());
    o->setProperty ("context", contextToVar (context));
    o->setProperty ("lineage", take.manifest.getProperty ("m1", {}));
    o->setProperty ("hostPlacement", "unobserved");
    return juce::var (o);
}

juce::String auditionStopName (AuditionStop why) noexcept
{
    switch (why)
    {
        case AuditionStop::user: return "stopped";
        case AuditionStop::finished: return "finished";
        case AuditionStop::hostTookOver: return "host transport started (host-synced playback took over)";
        case AuditionStop::selectionChanged: return "selection changed";
        case AuditionStop::nothingLoaded: return "nothing loaded for the selected version";
        case AuditionStop::none: break;
    }
    return "none";
}

FreeAudition::StartResult FreeAudition::start (bool hasSelectedVersion, bool hostSyncedPlaybackActive) noexcept
{
    if (! hasSelectedVersion)
        return StartResult::noVersion;
    if (hostSyncedPlaybackActive)
        return StartResult::hostSyncedActive;
    // Position first, then the flag: the audio thread only reads the cursor while active.
    cursor.store (0, std::memory_order_release);
    stopReason.store (static_cast<int> (AuditionStop::none), std::memory_order_release);
    active.store (1, std::memory_order_release);
    return StartResult::started;
}

void FreeAudition::stop (AuditionStop why) noexcept
{
    if (active.exchange (0, std::memory_order_acq_rel) != 0)
        stopReason.store (static_cast<int> (why), std::memory_order_release);
}

FreeAudition::Block FreeAudition::advance (int blockSamples, int64_t lengthSamples, bool hostSyncedPlaybackActive) noexcept
{
    if (! playing() || blockSamples <= 0)
        return {};
    if (hostSyncedPlaybackActive)
    {
        stop (AuditionStop::hostTookOver);
        return {};
    }
    if (lengthSamples <= 0)
    {
        stop (AuditionStop::nothingLoaded);
        return {};
    }
    auto from = cursor.load (std::memory_order_acquire);
    Block block;
    block.start = from;
    block.count = static_cast<int> (std::max<int64_t> (0, std::min<int64_t> (blockSamples, lengthSamples - from)));
    // A restart (start() on another thread) between the load and here wins.
    if (! cursor.compare_exchange_strong (from, from + block.count, std::memory_order_acq_rel))
        return {};
    if (from + block.count >= lengthSamples)
        stop (AuditionStop::finished);
    return block;
}

ExperienceLog::ExperienceLog()
    :ExperienceLog (reimagineUserHome()
                         .getChildFile ("Library/Mosh/ReImagine/experience.jsonl"))
{
}

ExperienceLog::ExperienceLog (juce::File file) : logFile (std::move (file)) {}

bool ExperienceLog::append (const juce::String& event, const juce::String& signal,
                            const juce::String& instanceId, const juce::var& payload) const
{
    auto* o = new juce::DynamicObject();
    o->setProperty ("schema", "mosh.reimagine.experience/1");
    o->setProperty ("ts", nowIso());
    o->setProperty ("event", event);
    o->setProperty ("signal", signal);
    o->setProperty ("instanceId", instanceId);
    o->setProperty ("payload", payload);
    const auto line = juce::JSON::toString (juce::var (o), true).replace ("\n", " ") + "\n";
    // The worker and message threads (and several plug-in instances in one host) append
    // concurrently; one line must never interleave with another.
    static juce::CriticalSection appendLock;
    const juce::ScopedLock lock (appendLock);
    if (! logFile.getParentDirectory().createDirectory())
        return false;
    juce::FileOutputStream out (logFile);
    if (! out.openedOk())
        return false;
    out.setPosition (out.getFile().getSize());
    return out.writeText (line, false, false, nullptr) && (out.flush(), out.getStatus().wasOk());
}
}
