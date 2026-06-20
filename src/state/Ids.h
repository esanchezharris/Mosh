#pragma once

#include <juce_data_structures/juce_data_structures.h>

// Mosh-owned ValueTree identifiers layered onto the Edit tree (01 §3–§4).
// Tracktion owns its own IDs (TRACK, CLIP, PLUGIN, ...); these are the extra
// sub-trees Mosh adds (the RenderLayer / source-graph model). Because they are
// plain ValueTree data parented under the Edit, they inherit undo,
// serialization, and observation for free.
namespace mosh::ids
{
#define MOSH_DECLARE_ID(name) const juce::Identifier name (#name);

    // The Tier-B generative transform record (01 §4.2). Parented under a clip
    // (default) or track. All fields are CachedValue bound to the undo manager.
    MOSH_DECLARE_ID (MOSH_RENDERLAYER)

    // PRJ-008 — per-project format / time-base INTENT. A single child of the
    // Edit's own ValueTree (mirrors how MOSH_RENDERLAYER is parented under the
    // clip/Edit state), so it saves/reloads with the .tracktionedit with no new
    // storage format. This is producer intent (the export/format default), NOT a
    // live device setting — the device readout stays the live truth; this is the
    // remembered preference. NON-undoable preference, written without the undo
    // manager (like the device prefs).
    MOSH_DECLARE_ID (MOSH_PROJECT)
    MOSH_DECLARE_ID (projectSampleRate)
    MOSH_DECLARE_ID (projectBitDepth)
    MOSH_DECLARE_ID (timeBase)         // "seconds" | "barsBeats"

    // KEY-001 — the project's MUSICAL KEY (tonic pitch-class + scale mode), stored
    // on the same MOSH_PROJECT node next to timeBase. Producer intent that the song
    // is "in" this key; it feeds the RenderLayer fingerprint (a key change is a
    // cache MISS) and drives Moshi's in-key voice (ui/src/vendor/voice.js). The
    // tonic/mode domains MUST mirror voice.js's NOTE_PC / SCALES literals exactly.
    // NON-undoable preference (written without the undo manager, like timeBase).
    MOSH_DECLARE_ID (musicalTonic)     // pitch-class name: "C".."B" incl. sharps/flats
    MOSH_DECLARE_ID (musicalMode)      // scale mode: "major" | "minor" | ... (SCALES)

    // RTG-001 — the track's CHOSEN input device (a WaveInputDevice deviceID).
    // A plain property on the track's own state tree so the choice saves/reloads
    // with the edit; arm_track prefers it over first-match. NON-undoable
    // preference (written without the undo manager, like monitor mode).
    MOSH_DECLARE_ID (moshInputDevice)

    // DRM-001 — the track's TYPE ("audio" | "drum"). A plain property on the
    // track's own state tree (like moshInputDevice), so it saves/reloads with the
    // edit. A "drum" track defaults to the working sampler + bundled kit and is the
    // binding point for the FL-style drum window. Absent ⇒ "audio". Written WITH
    // the undo manager by set_track_type / create_track so undo restores the prior
    // type (and the same transaction's auto-loaded instrument) together.
    MOSH_DECLARE_ID (trackType)
    // FL drum-lane mute/solo: comma-separated GM pitches whose sampler pad is muted /
    // soloed on a drum track. Persisted on the track; applied as sampler pad gains.
    MOSH_DECLARE_ID (drumMute)
    MOSH_DECLARE_ID (drumSolo)

    // MP-001 (multiplayer) — STABLE LOGICAL IDs that survive across two peers'
    // independent engines. Tracktion's own te::EditItemID is allocator-dependent
    // and so differs per process; these UUIDs are the cross-peer identity used to
    // address a track on commit/apply (and a bus, whose integer busNumber is a
    // local-scan counter that races between peers). Plain properties on the
    // track's / bus's own state tree (like trackType / moshInputDevice) so they
    // save/reload with the .tracktionedit. Stamped once at creation (and lazily
    // backfilled on load); identity is NOT user state, so written WITHOUT the undo
    // manager. Absent ⇒ stamp on next access. See [[finish-prototype-roadmap]].
    MOSH_DECLARE_ID (moshLogicalId)   // stable per-track UUID (cross-peer track identity)
    MOSH_DECLARE_ID (mpBusId)         // stable per-bus UUID (cross-peer bus identity)

    MOSH_DECLARE_ID (id)
    MOSH_DECLARE_ID (inputRef)
    MOSH_DECLARE_ID (timeRangeStart)
    MOSH_DECLARE_ID (timeRangeEnd)
    MOSH_DECLARE_ID (modelAdapter)
    MOSH_DECLARE_ID (modelVersion)
    MOSH_DECLARE_ID (adapterVersion)
    MOSH_DECLARE_ID (mode)             // generate | reimagine | inpaint | continue
    MOSH_DECLARE_ID (modelVariant)     // size/decoder variant
    MOSH_DECLARE_ID (params)           // prompt, colors[], cfg, steps, nl (child tree)
    MOSH_DECLARE_ID (seed)
    MOSH_DECLARE_ID (safetyMappingVersion)
    MOSH_DECLARE_ID (sourceFingerprint)
    MOSH_DECLARE_ID (cacheKey)
    MOSH_DECLARE_ID (cacheArtifact)
    MOSH_DECLARE_ID (status)           // empty | queued | rendering | ready | error | dirty
    MOSH_DECLARE_ID (createdBy)        // user | (future) monster
    MOSH_DECLARE_ID (userKept)

    // params child + colors
    MOSH_DECLARE_ID (PARAMS)
    MOSH_DECLARE_ID (prompt)
    MOSH_DECLARE_ID (COLORS)
    MOSH_DECLARE_ID (COLOR)
    MOSH_DECLARE_ID (name)
    MOSH_DECLARE_ID (value)            // 0–100 ASTD UI value
    MOSH_DECLARE_ID (cfg)
    MOSH_DECLARE_ID (steps)
    MOSH_DECLARE_ID (nl)               // init_noise_level (reimagine)

#undef MOSH_DECLARE_ID
} // namespace mosh::ids
