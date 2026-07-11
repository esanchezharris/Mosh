// add_drum_pattern (DRM-002) — pattern-string DSL parser golden vectors.
// These vectors are MIRRORED 1:1 in ui/src/ui/drumPatternUtil.test.ts — the TS
// parser must stay in lockstep (the kDefaultKit ⇄ DRUM_LANES "MUST mirror"
// discipline). Change a vector here → change it there.
#include <catch2/catch_test_macros.hpp>
#include "moshops/DrumPattern.h"

using namespace mosh;

static juce::var obj (std::initializer_list<std::pair<const char*, juce::var>> kv)
{
    auto* o = new juce::DynamicObject();
    for (auto& p : kv) o->setProperty (p.first, p.second);
    return juce::var (o);
}

static int hitsFor (const DrumPatternResult& r, int pitch)
{
    int n = 0;
    for (auto& s : r.steps) if (s.pitch == pitch) ++n;
    return n;
}

static bool hasHit (const DrumPatternResult& r, int pitch, int step, int vel = -1)
{
    for (auto& s : r.steps)
        if (s.pitch == pitch && s.step == step && (vel < 0 || s.velocity == vel))
            return true;
    return false;
}

// ── golden vector 1: the canonical 3-lane trap grid ─────────────────────────────
TEST_CASE ("object-form 3-lane grid lands hits at the drum-sequencer steps", "[drumpattern]")
{
    auto r = parseDrumPattern (obj ({ { "kick",  "x...x...x...x..." },
                                      { "snare", "....x.......x..." },
                                      { "hat",   "x.x.x.x.x.x.x.x." } }),
                               16, 0, 100);
    REQUIRE (r.ok);
    REQUIRE (r.stepsPerBar == 16);
    REQUIRE (r.bars == 1);
    REQUIRE (r.totalSteps == 16);
    REQUIRE (r.steps.size() == 14);       // 4 kicks + 2 snares + 8 hats

    for (int s : { 0, 4, 8, 12 }) REQUIRE (hasHit (r, 36, s, 100));
    for (int s : { 4, 12 })       REQUIRE (hasHit (r, 38, s, 100));
    for (int s : { 0, 2, 4, 6, 8, 10, 12, 14 }) REQUIRE (hasHit (r, 42, s, 100));

    // lanes register in input order (drives per-lane replace)
    REQUIRE (r.lanePitches == std::vector<int> { 36, 38, 42 });
    // deterministic ordering: lanes in input order, steps ascending within a lane
    REQUIRE (r.steps.front().pitch == 36);
    REQUIRE (r.steps.front().step == 0);
}

// ── golden vector 2: flat-string form ≡ object form ─────────────────────────────
TEST_CASE ("flat-string form (';' or newline separated) equals the object form", "[drumpattern]")
{
    auto o = parseDrumPattern (obj ({ { "kick",  "x...x...x...x..." },
                                      { "snare", "....x.......x..." } }),
                               16, 0, 100);
    auto s = parseDrumPattern (juce::var ("kick: x...x...x...x...; snare: ....x.......x..."),
                               16, 0, 100);
    auto n = parseDrumPattern (juce::var ("kick: x...x...x...x...\nsnare: ....x.......x..."),
                               16, 0, 100);
    REQUIRE (o.ok);
    REQUIRE (s.ok);
    REQUIRE (n.ok);
    REQUIRE (s.steps.size() == o.steps.size());
    REQUIRE (n.steps.size() == o.steps.size());
    for (size_t i = 0; i < o.steps.size(); ++i)
    {
        REQUIRE (s.steps[i].pitch == o.steps[i].pitch);
        REQUIRE (s.steps[i].step == o.steps[i].step);
        REQUIRE (s.steps[i].velocity == o.steps[i].velocity);
    }
    REQUIRE (s.lanePitches == o.lanePitches);
}

// ── golden vector 3: accent + rest chars ─────────────────────────────────────────
TEST_CASE ("'X' accents at 127, 'x' at the default velocity; '.' and '-' are rests", "[drumpattern]")
{
    auto r = parseDrumPattern (obj ({ { "kick", "x-X." } }), 4, 0, 90);
    REQUIRE (r.ok);
    REQUIRE (r.totalSteps == 4);
    REQUIRE (r.steps.size() == 2);
    REQUIRE (hasHit (r, 36, 0, 90));
    REQUIRE (hasHit (r, 36, 2, 127));
}

// ── golden vector 4: cosmetic separators ─────────────────────────────────────────
TEST_CASE ("'|' and whitespace inside a lane are cosmetic", "[drumpattern]")
{
    auto plain = parseDrumPattern (obj ({ { "kick", "x...x...x...x..." } }), 16, 0, 100);
    auto piped = parseDrumPattern (obj ({ { "kick", " x... | x... | x... | x... " } }), 16, 0, 100);
    REQUIRE (piped.ok);
    REQUIRE (piped.steps.size() == plain.steps.size());
    for (int s : { 0, 4, 8, 12 }) REQUIRE (hasHit (piped, 36, s));
}

// ── golden vector 5: tiling ──────────────────────────────────────────────────────
TEST_CASE ("a short lane tiles when its length divides the total steps", "[drumpattern]")
{
    auto r = parseDrumPattern (obj ({ { "hat", "x." } }), 16, 0, 100);
    REQUIRE (r.ok);
    REQUIRE (r.steps.size() == 8);
    for (int s : { 0, 2, 4, 6, 8, 10, 12, 14 }) REQUIRE (hasHit (r, 42, s));
}

TEST_CASE ("a lane whose length does not divide the total steps errors", "[drumpattern]")
{
    auto r = parseDrumPattern (obj ({ { "hat", "x...x...x..." } }), 16, 0, 100); // 12 into 16
    REQUIRE_FALSE (r.ok);
    REQUIRE (r.error.isNotEmpty());
}

TEST_CASE ("a lane longer than stepsPerBar x explicit bars errors", "[drumpattern]")
{
    auto r = parseDrumPattern (obj ({ { "kick", "x...x...x...x...x...x...x...x..." } }), 16, 1, 100); // 32 into 16
    REQUIRE_FALSE (r.ok);
}

// ── golden vector 6: bars derivation ─────────────────────────────────────────────
TEST_CASE ("bars derives from the longest lane when not given; short lanes tile across", "[drumpattern]")
{
    auto r = parseDrumPattern (obj ({ { "kick",  "x...x...x...x...x...x...x...x..." },   // 32 chars
                                      { "snare", "....x..." } }),                        // 8 chars, tiles x4
                               16, 0, 100);
    REQUIRE (r.ok);
    REQUIRE (r.bars == 2);
    REQUIRE (r.totalSteps == 32);
    REQUIRE (hitsFor (r, 36) == 8);
    REQUIRE (hitsFor (r, 38) == 4);
    REQUIRE (hasHit (r, 38, 28));   // last tiled snare: step 4 of the 4th 8-step tile
}

// ── golden vector 7: bad chars / unknown lanes name the offender ─────────────────
TEST_CASE ("a bad step char errors naming the char", "[drumpattern]")
{
    auto r = parseDrumPattern (obj ({ { "kick", "x..q" } }), 4, 0, 100);
    REQUIRE_FALSE (r.ok);
    REQUIRE (r.error.contains ("q"));
}

TEST_CASE ("an unknown lane errors naming the lane", "[drumpattern]")
{
    auto r = parseDrumPattern (obj ({ { "cowbell", "x..." } }), 4, 0, 100);
    REQUIRE_FALSE (r.ok);
    REQUIRE (r.error.contains ("cowbell"));
}

// ── golden vector 8: lane aliases (MUST mirror kDefaultKit / DRUM_LANES) ─────────
TEST_CASE ("lane aliases normalize case-insensitively, stripping space/underscore/hyphen", "[drumpattern]")
{
    REQUIRE (drumPatternLanePitch ("kick") == 36);
    REQUIRE (drumPatternLanePitch ("snare") == 38);
    REQUIRE (drumPatternLanePitch ("clap") == 39);
    REQUIRE (drumPatternLanePitch ("hat") == 42);
    REQUIRE (drumPatternLanePitch ("hihat") == 42);
    REQUIRE (drumPatternLanePitch ("HiHat") == 42);
    REQUIRE (drumPatternLanePitch ("hi-hat") == 42);
    REQUIRE (drumPatternLanePitch ("closedhat") == 42);
    REQUIRE (drumPatternLanePitch ("Closed Hat") == 42);
    REQUIRE (drumPatternLanePitch ("closed_hat") == 42);
    REQUIRE (drumPatternLanePitch ("CH") == 42);
    REQUIRE (drumPatternLanePitch ("openhat") == 46);
    REQUIRE (drumPatternLanePitch ("Open Hat") == 46);
    REQUIRE (drumPatternLanePitch ("OH") == 46);
    REQUIRE (drumPatternLanePitch ("lowtom") == 45);
    REQUIRE (drumPatternLanePitch ("Low Tom") == 45);
    REQUIRE (drumPatternLanePitch ("midtom") == 47);
    REQUIRE (drumPatternLanePitch ("crash") == 49);
    REQUIRE (drumPatternLanePitch ("cowbell") == -1);
}

TEST_CASE ("numeric lane keys are raw MIDI pitches; out-of-range keys error", "[drumpattern]")
{
    auto r = parseDrumPattern (obj ({ { "47", "x..............." } }), 16, 0, 100);
    REQUIRE (r.ok);
    REQUIRE (hasHit (r, 47, 0));
    REQUIRE (r.lanePitches == std::vector<int> { 47 });

    REQUIRE_FALSE (parseDrumPattern (obj ({ { "128", "x..." } }), 4, 0, 100).ok);
    REQUIRE_FALSE (parseDrumPattern (obj ({ { "-1", "x..." } }), 4, 0, 100).ok);
}

TEST_CASE ("duplicate lanes after aliasing error", "[drumpattern]")
{
    auto r = parseDrumPattern (juce::var ("hat: x...; ch: ...."), 4, 0, 100);
    REQUIRE_FALSE (r.ok);
    REQUIRE (r.error.containsIgnoreCase ("duplicate"));
}

// ── golden vector 9: all-rest lane registers for per-lane clear ──────────────────
TEST_CASE ("an all-rest lane registers its pitch with zero hits", "[drumpattern]")
{
    auto r = parseDrumPattern (obj ({ { "snare", "................" } }), 16, 0, 100);
    REQUIRE (r.ok);
    REQUIRE (r.steps.empty());
    REQUIRE (r.lanePitches == std::vector<int> { 38 });
}

// ── golden vector 10: range validation ───────────────────────────────────────────
TEST_CASE ("stepsPerBar, bars and velocity ranges are validated", "[drumpattern]")
{
    auto p = obj ({ { "kick", "x..." } });
    REQUIRE_FALSE (parseDrumPattern (p, 0, 0, 100).ok);    // stepsPerBar too small
    REQUIRE_FALSE (parseDrumPattern (p, 65, 0, 100).ok);   // stepsPerBar too big
    REQUIRE_FALSE (parseDrumPattern (p, 4, 17, 100).ok);   // bars too big
    REQUIRE_FALSE (parseDrumPattern (p, 4, -1, 100).ok);   // bars negative
    REQUIRE_FALSE (parseDrumPattern (p, 4, 0, 0).ok);      // velocity too small
    REQUIRE_FALSE (parseDrumPattern (p, 4, 0, 128).ok);    // velocity too big
}

// ── golden vector 11: empty / malformed patterns ─────────────────────────────────
TEST_CASE ("empty or malformed patterns error", "[drumpattern]")
{
    REQUIRE_FALSE (parseDrumPattern (juce::var(), 16, 0, 100).ok);                       // void
    REQUIRE_FALSE (parseDrumPattern (juce::var (12), 16, 0, 100).ok);                    // wrong type
    REQUIRE_FALSE (parseDrumPattern (juce::var (""), 16, 0, 100).ok);                    // empty string
    REQUIRE_FALSE (parseDrumPattern (obj ({}), 16, 0, 100).ok);                          // no lanes
    REQUIRE_FALSE (parseDrumPattern (obj ({ { "hat", "" } }), 16, 0, 100).ok);           // empty lane
    REQUIRE_FALSE (parseDrumPattern (juce::var ("kick x..."), 16, 0, 100).ok);           // no ':' in string form
}

// ── golden vector 12: step→beats math mirrors drumGrid.stepBeats ─────────────────
TEST_CASE ("stepBeats mirrors ui drumGrid: beatsPerBar / stepsPerBar", "[drumpattern]")
{
    REQUIRE (drumPatternStepBeats (4.0, 16) == 0.25);
    REQUIRE (drumPatternStepBeats (3.0, 16) == 0.1875);
}
