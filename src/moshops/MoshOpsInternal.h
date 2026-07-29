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
} // namespace mosh
