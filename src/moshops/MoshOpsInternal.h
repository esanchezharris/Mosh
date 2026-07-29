#pragma once

// RFC 001 — MoshOps partial-class split: PRIVATE cross-TU helpers.
//
// Not installed anywhere; included only by the src/moshops/MoshOps*.cpp
// translation units. A helper lands here ONLY when the compiler forces it:
// an (ex-)anonymous-namespace helper referenced by BOTH a moved domain TU
// and code remaining in MoshOps.cpp. Everything else stays file-local in
// its own TU's anonymous namespace. Bodies are verbatim moves (plus the
// `inline` keyword) — never duplicated.

#include <tracktion_engine/tracktion_engine.h>
#include <juce_data_structures/juce_data_structures.h>
#include "state/Ids.h"
#include "plugins/spectral/MasterSpectralTapPlugin.h"
#if MOSH_HAVE_ANIRA
 #include "plugins/transform/RaveInsertPlugin.h"
#endif

namespace te = tracktion::engine;

namespace mosh
{
    inline bool lyricTextIsCompleteForSing (const juce::String& text)
    {
        const auto t = text.trim();
        if (t.isEmpty() || t.contains ("___"))
            return false;
        for (auto p = t.getCharPointer(); ! p.isEmpty(); ++p)
            if (juce::CharacterFunctions::isLetterOrDigit (*p))
                return true;
        return false;
    }

    inline bool lyricLineIsAssertedForSing (const juce::ValueTree& line)
    {
        return line.hasProperty (ids::lyricScore)
            && line[ids::status].toString() == "asserted"
            && lyricTextIsCompleteForSing (line[ids::lyricText].toString());
    }

    // ── RFC 001 (A-PR2) — promoted from MoshOps.cpp's anonymous namespace ─────
    // Each entry below is referenced by BOTH a moved domain TU and code that
    // remains in MoshOps.cpp, so the compiler forces the promotion. Bodies are
    // verbatim moves (plus the `inline` keyword); their comments still describe
    // the original file-local intent and are kept unedited on purpose.

    // AL-008 — the id of the wave clip a render-layer landed on the "Neural Renders"
    // lane via accept_render. Stored on the MOSH_RENDERLAYER node so bypass_layer can
    // mute/un-mute THAT clip (the real audio re-route), not just flip a status flag.
    // File-local on purpose: this is a MoshOps mechanism detail, not a schema field in
    // src/state (the RenderLayer node is an open ValueTree; an extra string property is
    // round-trip-safe through save/load and ignored by the fingerprint).
    inline const juce::Identifier kLandedClipId ("landedClipId");

    // Phase 2 — discriminates the drum/MIDI "hidden audio beneath the MIDI" model from the
    // legacy "Neural Renders" lane landing. When true, the render-layer auto-applied beneath a
    // MIDI/drum clip: kLandedClipId is the HIDDEN audio clip (on the SAME track) and the source
    // MIDI clip was MUTED by us. Reset/remove use it to know to remove the hidden clip + un-mute
    // (vs the legacy lane, which never touches the source clip). File-local, round-trip-safe.
    inline const juce::Identifier kSourceMutedByLayer ("sourceMutedByLayer");

    // G14 — make a VolumeAndPanPlugin fader change UNDOABLE.
    //
    // vp->setVolumeDb()/setPan() route through the AutomatableParameter, whose
    // ValueTree writeback uses a NULL UndoManager (AttachedFloatValue::handleAsyncUpdate
    // -> CachedValue::setValue(.., nullptr)). So writing the fader inside a MoshOps
    // transaction produced an EMPTY transaction — undo restored nothing even though the
    // command logged undoable:true. A bare ValueTree write through the UndoManager would
    // record the property change, but on undo Tracktion deliberately refreshes only the
    // CachedValue and does NOT push the value back into the parameter's currentValue (the
    // atomic getVolumeDb()/getPan() — and thus snapshot() — read). So the parameter must
    // be replayed on perform/undo/redo, but without nesting another UndoManager action
    // while JUCE is already inside this UndoableAction. Tracktion's Mosh patch exposes
    // setParameterWithoutUndo for that replay path.
    struct SetFaderValueAction final : public juce::UndoableAction
    {
        SetFaderValueAction (te::VolumeAndPanPlugin& p, bool panNotVol, float newValue)
            : plugin (p), isPan (panNotVol), valueAfter (newValue),
              valueBefore (panNotVol ? p.getPan() : p.getVolumeDb()) {}

        bool perform() override     { apply (valueAfter);  return true; }
        bool undo() override        { apply (valueBefore); return true; }
        int  getSizeInUnits() override { return (int) sizeof (*this); }

        void apply (float v)
        {
            if (isPan)
            {
                if (v >= -0.005f && v <= 0.005f)
                    v = 0.0f;

                plugin.panParam->setParameterWithoutUndo (juce::jlimit (-1.0f, 1.0f, v),
                                                          juce::sendNotification);
            }
            else
            {
                plugin.volParam->setParameterWithoutUndo (juce::jlimit (0.0f, 1.0f,
                                                                         te::decibelsToVolumeFaderPosition (v)),
                                                          juce::sendNotification);
            }
        }

        te::VolumeAndPanPlugin& plugin;
        const bool  isPan;
        const float valueAfter;
        const float valueBefore;
    };

    // Maps a clip's PLAYED span — position offset/length, or the loop range for a
    // looping clip — onto a [startSec, lengthSec) window in SOURCE-FILE seconds: the
    // samples that actually sound when the clip plays, as opposed to the whole
    // (possibly much longer) source file it was trimmed from. Mirrors the arithmetic
    // in the (private) non-auto-tempo branch of te::AudioClipBase::getReferencedItems
    // — sourceSec = clipTimeSec * getSpeedRatio() — which is the same formula
    // Tracktion itself uses to report a clip's "used" file range for export/reference
    // purposes, just not exposed as a public helper.
    //
    // WARPED CAVEAT: auto-tempo (warp-locked) clips are deliberately NOT mapped —
    // lengthSec is returned negative to mean "unmapped, scan the whole file", which
    // callers should treat as a fallback. This matches Tracktion's own
    // getReferencedItems, which ALSO falls back to the whole source file for
    // auto-tempo clips (see the `if (getAutoTempo())` branch that resets
    // firstTimeUsed/lengthUsed to the full file): the elastique-driven mapping from
    // edit time to source time isn't a simple linear scale, so there's no cheap exact
    // window to compute here either. A precise warped-clip mapping is a documented
    // follow-up, not attempted in this pass.
    struct ClipSourceSpan { double startSec = 0.0; double lengthSec = -1.0; };

    inline ClipSourceSpan clipAudibleSourceSpan (te::AudioClipBase& ac)
    {
        if (ac.getAutoTempo())
            return {};   // warped — see the WARPED CAVEAT above; caller scans the whole file

        const double speed = ac.getSpeedRatio();
        if (ac.isLooping())
            return { ac.getLoopStart().inSeconds() * speed, ac.getLoopLength().inSeconds() * speed };

        auto pos = ac.getPosition();
        return { pos.getOffset().inSeconds() * speed, pos.getLength().inSeconds() * speed };
    }

    // ── RFC 001 (A-PR3) — promoted from MoshOps.cpp's anonymous namespace ─────
    // Same promotion rule as A-PR2: each entry is referenced by BOTH a moved
    // domain TU and code that remains in MoshOps.cpp (or, for isSerumPlugin/
    // findSerumRealtimeRenderReason, by TWO different moved TUs), so the
    // compiler forces the promotion. Bodies are verbatim moves plus the
    // `inline` keyword and the two qualifications header scope requires
    // (juce::String / juce::DynamicObject — MoshOps.cpp's file-level
    // `using namespace juce` does not exist here); comments kept unedited.

   #if MOSH_HAVE_ANIRA
    inline RaveInsertPlugin* asRave (te::Plugin* p) { return dynamic_cast<RaveInsertPlugin*> (p); }
   #endif

    // Tracktion's compiled-in built-in plugin palette (registered unconditionally
    // by PluginManager). These ship inside the engine — no scan, no third-party
    // dependency — so the FX palette and built-in instruments are pure surface
    // work over the existing plugin command path. xmlTypeName strings are the
    // stable serialization ids createNewPlugin(type, {}) dispatches on.
    struct BuiltinSpec { const char* type; const char* name; const char* category; bool isInstrument; };
    inline const BuiltinSpec kBuiltins[] = {
        { "4osc",         "4OSC Synth",            "Instrument", true  },
        { "sampler",      "Sampler",               "Instrument", true  },
        { "4bandEq",      "4-Band EQ",             "EQ",         false },
        { "compressor",   "Compressor",            "Dynamics",   false },
        { "reverb",       "Reverb",                "Reverb",     false },
        { "delay",        "Delay",                 "Delay",      false },
        { "chorus",       "Chorus",                "Modulation", false },
        { "phaser",       "Phaser",                "Modulation", false },
        { "lowpass",      "Low / High-Pass Filter","Filter",     false },
        { "pitchShifter", "Pitch Shifter",         "Pitch",      false },
        { "moshAutoTune", "Mosh AutoTune",         "Mosh FX",    false },
        { "moshOTT",      "Mosh OTT",              "Mosh FX",    false },
        { "moshXFeedback","Mosh X-FDBK",           "Mosh FX",    false },
    };

    inline const BuiltinSpec* findBuiltin (const juce::String& type)
    {
        for (auto& b : kBuiltins)
            if (type == b.type)
                return &b;
        return nullptr;
    }

    inline bool isSerumPlugin (te::ExternalPlugin& plugin)
    {
        const auto name = plugin.getName();
        const auto vendor = plugin.getVendor();
        const auto file = plugin.desc.fileOrIdentifier;
        return vendor == "Xfer Records"
               && (name == "Serum 2"
                   || name == "Serum 2 FX"
                   || file.containsIgnoreCase ("Serum2.vst3"));
    }

    inline void addExternalPluginMetadata (juce::DynamicObject& o, te::ExternalPlugin& plugin)
    {
        o.setProperty ("manufacturer", plugin.getVendor());
        o.setProperty ("file", plugin.desc.fileOrIdentifier);
        o.setProperty ("identifier", te::createIdentifierString (plugin.desc));
        o.setProperty ("numInputs", plugin.getNumInputs());
        o.setProperty ("numOutputs", plugin.getNumOutputs());
        o.setProperty ("pluginInstanceLoaded", plugin.getAudioPluginInstance() != nullptr);
        o.setProperty ("isNonRealtime", plugin.getAudioPluginInstance() != nullptr
                                            && plugin.getAudioPluginInstance()->isNonRealtime());
    }

    // Master-bus plugins — the master plugin list also carries internal utility plugins
    // Mosh itself inserts (currently only the spectral tap that feeds Moshi reactivity,
    // MasterSpectralTapPlugin — see MoshOps::ensureMasterSpectralTap()); those must never
    // be user-visible or user-addressable. This is the single filter both master-plugin
    // index resolution (MoshOps::findMasterPlugin/masterVisibleBoundary) and snapshot
    // serialization key off of.
    inline bool isInternalMasterPlugin (te::Plugin* p)
    {
        return p != nullptr && p->getPluginType() == MasterSpectralTapPlugin::xmlTypeName;
    }

    inline juce::String findSerumRealtimeRenderReason (te::Edit& edit)
    {
        for (auto* track : te::getAudioTracks (edit))
            for (auto* plugin : track->pluginList.getPlugins())
                if (auto* ext = dynamic_cast<te::ExternalPlugin*> (plugin))
                    if (ext->isEnabled() && isSerumPlugin (*ext))
                        return "Serum compatibility: " + ext->getName();

        return {};
    }

    inline constexpr int kCommandLogInspectorMaxEntries = 500;

    inline juce::var makeCommandLogInspectorEntry (const juce::var& parsed)
    {
        if (! parsed.isObject())
            return {};

        auto* o = new juce::DynamicObject();
        o->setProperty ("ts",       parsed.getProperty ("ts", juce::var()));
        o->setProperty ("seq",      parsed.getProperty ("seq", juce::var()));
        o->setProperty ("command",  parsed.getProperty ("command", juce::var()));
        o->setProperty ("ok",       (bool) parsed.getProperty ("ok", false));
        o->setProperty ("undoable", (bool) parsed.getProperty ("undoable", false));
        if (parsed.hasProperty ("error"))
            o->setProperty ("error", parsed.getProperty ("error", juce::var()));
        return juce::var (o);
    }
} // namespace mosh
