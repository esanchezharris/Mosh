#pragma once
#include <juce_core/juce_core.h>
#include <vector>

// ──────────────────────────────────────────────────────────────────────────────
// The FULL cache fingerprint for Tier-B renders (01 §4.3, 05 §5).
//
// CRITICAL INVARIANT: the cache key is keyed by the COMPLETE fingerprint, never
// just source+params. Anything less yields "why did the cache reuse the wrong
// audio?" bugs. On any fingerprint-input change → status="dirty" → re-render.
//
// cacheKey = SHA256( canonical ordered concatenation of every input below ).
// ──────────────────────────────────────────────────────────────────────────────
namespace mosh
{
    // Ordered key/value accumulator → stable canonical string → SHA256 hex.
    class FingerprintBuilder
    {
    public:
        FingerprintBuilder& add (juce::String key, juce::String value)
        {
            fields.push_back ({ std::move (key), std::move (value) });
            return *this;
        }
        FingerprintBuilder& add (juce::String key, double value)
        {
            // Canonical numeric form (fixed precision) so 1.0 and 1 hash identically.
            return add (std::move (key), juce::String (value, 9));
        }
        FingerprintBuilder& add (juce::String key, juce::int64 value)
        {
            return add (std::move (key), juce::String (value));
        }
        FingerprintBuilder& add (juce::String key, int value)
        {
            return add (std::move (key), juce::String (value));
        }
        FingerprintBuilder& addList (juce::String key, const juce::StringArray& values)
        {
            return add (std::move (key), values.joinIntoString (","));
        }

        // Deterministic: ordered by insertion, "key=value" newline-joined.
        juce::String canonical() const
        {
            juce::String s;
            for (const auto& f : fields)
                s << f.first << '=' << f.second << '\n';
            return s;
        }

        juce::String cacheKey() const
        {
            // FNV-1a 64-bit over the canonical UTF-8 string. A cache identity, not a
            // security hash — deterministic and low-collision, and it keeps the spine
            // free of juce_cryptography (MD5/SHA live there, not in juce_core).
            const auto s = canonical();
            const char* p = s.toRawUTF8();
            const size_t n = s.getNumBytesAsUTF8();

            juce::uint64 h = 1469598103934665603ull;          // FNV offset basis
            for (size_t i = 0; i < n; ++i)
            {
                h ^= (juce::uint8) p[i];
                h *= 1099511628211ull;                         // FNV prime
            }

            char buf[17];
            for (int i = 0; i < 16; ++i)
                buf[15 - i] = "0123456789abcdef"[(h >> (i * 4)) & 0xF];
            buf[16] = 0;
            return juce::String (buf);
        }

        bool isEmpty() const { return fields.empty(); }

    private:
        std::vector<std::pair<juce::String, juce::String>> fields;
    };

    // The named inputs that MUST go into the fingerprint (01 §4.3). Modelled as a
    // struct so the "don't shortcut" rule is explicit and unit-testable: every
    // field is folded into the key in a fixed canonical order.
    struct FingerprintInputs
    {
        // Upstream content + context
        juce::String upstreamHash;        // hash of upstream audio/MIDI/plugin-state
        double       clipRangeStart = 0.0;
        double       clipRangeEnd   = 0.0;
        double       tempoBpm       = 0.0;
        juce::String keyContext;          // tonal/key context
        double       sampleRate     = 0.0;
        int          numChannels    = 0;

        // Model identity
        juce::String modelAdapter;
        juce::String modelVersion;
        juce::String adapterVersion;
        juce::String serviceBuild;        // service build/version

        // Semantic controls
        juce::String prompt;
        juce::StringArray colors;         // ordered, ≤3 (01 §4.4)
        juce::int64  seed = 0;

        // Sampling hyperparameters
        double cfg   = 0.0;
        int    steps = 0;
        double nl    = 0.0;               // re-noise level (reimagine)

        // Safety
        juce::String safetyMappingVersion;

        juce::String cacheKey() const { return build().cacheKey(); }

        FingerprintBuilder build() const
        {
            FingerprintBuilder b;
            b.add ("upstreamHash", upstreamHash)
             .add ("clipRangeStart", clipRangeStart)
             .add ("clipRangeEnd", clipRangeEnd)
             .add ("tempoBpm", tempoBpm)
             .add ("keyContext", keyContext)
             .add ("sampleRate", sampleRate)
             .add ("numChannels", numChannels)
             .add ("modelAdapter", modelAdapter)
             .add ("modelVersion", modelVersion)
             .add ("adapterVersion", adapterVersion)
             .add ("serviceBuild", serviceBuild)
             .add ("prompt", prompt)
             .addList ("colors", colors)
             .add ("seed", (juce::int64) seed)
             .add ("cfg", cfg)
             .add ("steps", steps)
             .add ("nl", nl)
             .add ("safetyMappingVersion", safetyMappingVersion);
            return b;
        }
    };
}
