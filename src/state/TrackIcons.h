#pragma once

#include <juce_core/juce_core.h>
#include <set>

// CAP-TRK-002 (#613) — the vocabulary of track icons.
//
// THE SHAPE OF THE STORED VALUE. `ids::trackIcon` persists an icon NAME ("bass"), never
// an index into whatever list the UI renders this month. That is the same decision
// `ids::trackColour` made and for the same reason: a palette is a UI concern, and an
// index baked into the project file turns every future reorder — or every insertion
// anywhere but the end — into a silent remap of icons on projects already saved. A name
// means the palette can grow, shrink or be reordered freely and no project file needs
// migrating, because a name that meant "bass" in one release means "bass" in the next.
//
// WHY THIS LIST EXISTS AT ALL, when colour needs no equivalent. Colour validates FORM
// only (`#rrggbb`) and never membership, because the space is TOTAL: every well-formed
// hex is a colour something can draw. Icon names are not total. An unrecognised name has
// nothing to render, so a form-only check would let `set_track_icon {icon:"banana"}`
// report ok, persist, and display as the track type's default forever — a command that
// succeeds and visibly does nothing. That is the failure class this programme removes,
// so membership is checked and an unknown name is an error the caller sees.
//
// The list therefore has to stay in step with the palette v2 renders. It is not trusted
// to: `ui/src/v2/trackIcons.test.ts` parses this header at test time and fails if the two
// disagree in either direction, and --selftest walks the registry asserting the command
// accepts every name in it. Adding an icon = one entry here, one glyph in the UI map.
//
// Chosen for a beat-first session: the rows a producer scans for are drums, the low end,
// the chords, the voice, and the noise. Not an orchestra — ten silhouettes that stay
// apart from each other at 16px, which is the size that actually ships in the header.
namespace mosh::trackIcons
{
    inline const std::set<juce::String>& registry()
    {
        static const std::set<juce::String> known {
            "drum",     // kit / the beat
            "perc",     // shakers, congas, tops
            "bass",     // the low end, whatever plays it
            "guitar",
            "keys",     // piano / Rhodes / anything with a keybed
            "synth",    // leads, pads, plucks
            "vocal",
            "strings",
            "fx",       // risers, impacts, sound design
            "sample",   // a chopped loop or a one-shot bed
        };
        return known;
    }

    /** True when `name` is one this build can actually draw. Callers normalize
        (trim + lowercase) before asking; the registry is lowercase by construction. */
    inline bool isKnown (const juce::String& name)
    {
        return registry().count (name) > 0;
    }
}
