#pragma once

#include <juce_data_structures/juce_data_structures.h>
#include <juce_cryptography/juce_cryptography.h>
#include "state/Ids.h"

namespace mosh
{
/** The Tier-B generative transform record (01 §4.2), stored as a MOSH_RENDERLAYER
    sub-tree on the Edit. Stage 1: define the schema + prove a node round-trips
    save/load. Stage 5 wires the render flow and the full cache fingerprint.

    This is a thin typed view over a juce::ValueTree — the tree is authoritative
    (01 §3); we never hold shadow state. CachedValue binding to the undo manager
    happens in the command handlers (Stage 5); here we keep pure construction +
    fingerprint helpers so they're unit-testable without the engine. */
struct RenderLayer
{
    juce::ValueTree state;

    /** Build a fresh empty RenderLayer node (status="empty"). */
    static juce::ValueTree create (const juce::String& layerId,
                                   const juce::String& inputRef,
                                   double timeStart, double timeEnd,
                                   const juce::String& adapter = "fake")
    {
        juce::ValueTree v (ids::MOSH_RENDERLAYER);
        v.setProperty (ids::id, layerId, nullptr);
        v.setProperty (ids::inputRef, inputRef, nullptr);
        v.setProperty (ids::timeRangeStart, timeStart, nullptr);
        v.setProperty (ids::timeRangeEnd, timeEnd, nullptr);
        v.setProperty (ids::modelAdapter, adapter, nullptr);
        v.setProperty (ids::modelVersion, "0", nullptr);
        v.setProperty (ids::adapterVersion, "0", nullptr);
        v.setProperty (ids::mode, "reimagine", nullptr);
        v.setProperty (ids::modelVariant, "", nullptr);
        v.setProperty (ids::seed, 0, nullptr);
        v.setProperty (ids::safetyMappingVersion, "0", nullptr);
        v.setProperty (ids::sourceFingerprint, "", nullptr);
        v.setProperty (ids::cacheKey, "", nullptr);
        v.setProperty (ids::cacheArtifact, "", nullptr);
        v.setProperty (ids::status, "empty", nullptr);
        v.setProperty (ids::coverage, "auto", nullptr);   // whole-clip coverage strategy
        v.setProperty (ids::createdBy, "user", nullptr);
        v.setProperty (ids::userKept, false, nullptr);

        juce::ValueTree params (ids::PARAMS);
        params.setProperty (ids::prompt, "", nullptr);
        params.setProperty (ids::cfg, 7.0, nullptr);
        params.setProperty (ids::steps, 30, nullptr);
        params.setProperty (ids::nl, 0.4, nullptr);
        params.setProperty (ids::target, "", nullptr);       // Route B transform target
        params.setProperty (ids::strength, 65.0, nullptr);   // Route B transform strength (0–100)
        params.appendChild (juce::ValueTree (ids::COLORS), nullptr);
        params.appendChild (juce::ValueTree (ids::LORAS), nullptr);
        v.appendChild (params, nullptr);
        return v;
    }

    /** The FULL cache fingerprint (05 §5 / 01 §4.3) — NEVER shortcut to
        source+params. Hashes every input that can change the rendered audio:
        upstream hash · range · tempo/key · SR/channels · adapter · model/adapter
        version · variant · mode (route) · prompt/controls · seed · sampling
        hyperparams · safetyMappingVersion · service build. Any mismatch ⇒ dirty.

        Stage 1 takes the documented inputs that exist now; Stage 5 fills the
        upstream-audio hash + tempo/key/service-build once the render flow exists.
        Mode + variant are in the key deliberately (same clip, different route or
        model size = different audio). */
    static juce::String fingerprint (const juce::ValueTree& v,
                                     const juce::String& upstreamHash,
                                     const juce::String& tempoKeyContext,
                                     int sampleRate, int channels,
                                     const juce::String& serviceBuild)
    {
        auto params = v.getChildWithName (ids::PARAMS);
        juce::String colorsKey;
        if (auto colors = params.getChildWithName (ids::COLORS); colors.isValid())
            for (int i = 0; i < colors.getNumChildren(); ++i)
            {
                auto c = colors.getChild (i);
                colorsKey << c[ids::name].toString() << "=" << c[ids::value].toString() << ";";
            }
        juce::String lorasKey;   // LoRA rack — order matters (stacks merge sequentially)
        if (auto loras = params.getChildWithName (ids::LORAS); loras.isValid())
            for (int i = 0; i < loras.getNumChildren(); ++i)
            {
                auto l = loras.getChild (i);
                lorasKey << l[ids::name].toString() << "=" << l[ids::value].toString() << ";";
            }

        juce::StringArray parts {
            upstreamHash,
            v[ids::timeRangeStart].toString() + ":" + v[ids::timeRangeEnd].toString(),
            tempoKeyContext,
            juce::String (sampleRate) + "/" + juce::String (channels),
            v[ids::modelAdapter].toString(),
            v[ids::modelVersion].toString(),
            v[ids::adapterVersion].toString(),
            v[ids::modelVariant].toString(),       // size/decoder — part of key
            v[ids::mode].toString(),               // transform route — part of key
            v[ids::coverage].toString(),           // whole-clip coverage (tile/stitch) — part of key
            params[ids::prompt].toString(),
            params[ids::target].toString(),        // Route B transform target — part of key
            params[ids::strength].toString(),      // Route B transform strength — part of key
            colorsKey,
            lorasKey,                              // LoRA rack selection — part of key
            v[ids::seed].toString(),
            params[ids::cfg].toString() + "/" + params[ids::steps].toString() + "/" + params[ids::nl].toString(),
            v[ids::safetyMappingVersion].toString(),
            serviceBuild
        };

        const auto joined = parts.joinIntoString ("|");
        return juce::SHA256 (joined.toRawUTF8(),
                             (size_t) joined.getNumBytesAsUTF8()).toHexString();
    }

    /** Round-trip a node through XML (proves serialization, 01 §6 / Stage 1 test). */
    static juce::ValueTree roundTripViaXml (const juce::ValueTree& v)
    {
        auto xml = v.toXmlString();
        return juce::ValueTree::fromXml (xml);
    }
};

} // namespace mosh
