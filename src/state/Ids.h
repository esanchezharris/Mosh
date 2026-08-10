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

    // PRJ-FMT — the Mosh PROJECT FORMAT version (int, >= 1). Stored on the same
    // MOSH_PROJECT node so it saves/reloads with the .tracktionedit and survives
    // Save-As/consolidate. The schema version of Mosh's OWN ValueTree state — distinct
    // from Tracktion's free-form Edit appVersion (which we don't control) and from the
    // C++→UI snapshot wire contract. Stamped on every save (see state/Migrations.h);
    // absent ⇒ a pre-versioning (v0/legacy) file. Drives forward-migration on open and
    // a graceful "made by a newer Mosh" refusal. NON-undoable (a format stamp).
    MOSH_DECLARE_ID (moshFormatVersion)

    // KEY-001 — the project's MUSICAL KEY (tonic pitch-class + scale mode), stored
    // on the same MOSH_PROJECT node next to timeBase. Producer intent that the song
    // is "in" this key; it feeds the RenderLayer fingerprint (a key change is a
    // cache MISS) and drives Moshi's in-key voice (ui/src/vendor/voice.js). The
    // tonic/mode domains MUST mirror voice.js's NOTE_PC / SCALES literals exactly.
    // NON-undoable preference (written without the undo manager, like timeBase).
    MOSH_DECLARE_ID (musicalTonic)     // pitch-class name: "C".."B" incl. sharps/flats
    MOSH_DECLARE_ID (musicalMode)      // scale mode: "major" | "minor" | ... (SCALES)

    // G2b — count-in / pre-roll BARS before recording starts. Stored on the same
    // MOSH_PROJECT node as timeBase/key (producer INTENT), so it saves/reloads
    // with the .tracktionedit. Domain is deliberately {0,1,2} bars, matching
    // tracktion_engine's own te::Edit::CountIn enum (none/oneBar/twoBar — whose
    // underlying values are 0/1/2, so a validated bars value casts straight
    // across with no lookup table; see mosh::countin::isValidBars in
    // state/CountIn.h + MoshOps::cmdSetCountIn/applyCountInToEdit). Absent ⇒ 0
    // (off). NON-undoable preference (written without the undo manager, like
    // timeBase/musicalTonic).
    MOSH_DECLARE_ID (countInBars)

    // REC-001 — how a live MIDI take BEHAVES. Stored on the same MOSH_PROJECT node as
    // countInBars, and for the same reason: the engine's own homes for these settings
    // are unreachable when they are set.
    //
    //   recOverdub / recReplaceExisting / recQuantize live on MidiInputDevice
    //     (mergeRecordings / replaceExistingClips / quantisation), which are PER-DEVICE
    //     and exist only while an audio device is open. A producer setting "overdub"
    //     with no interface plugged in would otherwise be writing to nothing, and the
    //     value could not be proven headless.
    //   recPunchInOut mirrors te::Edit::recordingPunchInOut, which DOES live in the Edit
    //     — but is bound with a nullptr UndoManager, so writing it inside a transaction
    //     makes an empty one (the G14 undo class: the next undo then destroys the
    //     PREVIOUS edit). Storing intent here keeps one write path for all five.
    //
    // MoshOps::applyRecordOptionsToDevices() pushes the stored intent into the live
    // engine every time it could matter (on set, on record-start, on project load), so
    // the setting is real rather than merely remembered — the same discipline
    // applyCountInToEdit uses. NON-undoable preferences, all five.
    MOSH_DECLARE_ID (recOverdub)          // bool — a new take MERGES into the clip it lands on
    MOSH_DECLARE_ID (recReplaceExisting)  // bool — a take REPLACES clips under it
    MOSH_DECLARE_ID (recQuantize)         // double — beats; 0 = off. Same domain as quantize_notes' `division`
    MOSH_DECLARE_ID (recPunchInOut)       // bool — capture only inside the loop/punch range
    MOSH_DECLARE_ID (recRetroSeconds)     // double — how much played-but-not-recorded MIDI capture_midi can reach back for

    // RTG-001 — the track's CHOSEN input device (a WaveInputDevice deviceID).
    // A plain property on the track's own state tree so the choice saves/reloads
    // with the edit; arm_track prefers it over first-match. NON-undoable
    // preference (written without the undo manager, like monitor mode).
    MOSH_DECLARE_ID (moshInputDevice)

    // FREEZE TRACK (Live 12 ⌥⇧⌘F) — a plain property on the track's own state
    // tree (like moshInputDevice): present ⇒ the track is frozen (rendered to
    // audio, device chain disabled). Written WITH the undo manager by
    // freeze_track / unfreeze_track, so undo restores the exact pre-state.
    // Saves/reloads with the edit — a frozen track stays frozen across sessions.
    MOSH_DECLARE_ID (moshFrozen)
    // FREEZE TRACK — each plugin's enabled state immediately before freeze. This
    // lets unfreeze restore deliberately bypassed devices instead of changing the
    // mix by enabling the entire chain. Absent in a legacy frozen session => enabled.
    MOSH_DECLARE_ID (moshPreFreezeEnabled)

    // DRM-001 — the track's TYPE ("audio" | "drum"). A plain property on the
    // track's own state tree (like moshInputDevice), so it saves/reloads with the
    // edit. A "drum" track defaults to the working sampler + bundled kit and is the
    // binding point for the FL-style drum window. Absent ⇒ "audio". Written WITH
    // the undo manager by set_track_type / create_track so undo restores the prior
    // type (and the same transaction's auto-loaded instrument) together.
    MOSH_DECLARE_ID (trackType)
    // Track colour: "#rrggbb" (lowercase hex), or absent for the type's default. Lives on
    // the track's own state tree like trackType, so it saves/reloads with the edit and is
    // written WITH the undo manager — recolouring is an edit a producer expects to undo.
    // Deliberately a free hex value rather than a palette index: a palette is a UI
    // decision (v2 offers eight swatches) and baking one into the persisted format would
    // make every future palette change a migration.
    MOSH_DECLARE_ID (trackColour)

    // CAP-TRK-002 (#613) — the track's chosen ICON, as a NAME ("bass"), or absent for the
    // track type's default glyph. Lives on the track's own state tree like trackType, so
    // it saves/reloads with the edit, and is written WITH the undo manager — picking an
    // icon is an edit a producer expects ⌘Z to take back.
    //
    // A NAME, never an index into the palette the UI happens to render. An index would
    // make every future reorder — or every insertion anywhere but the end — silently
    // repaint the icons of projects already on disk, and there is no migration that can
    // fix that afterwards, because the file does not record which palette it meant. A
    // name means the palette can grow, shrink and be reordered freely and old projects
    // stay correct. Same reasoning as a colour storing "#rrggbb" rather than "swatch 3".
    // The vocabulary of legal names lives in state/TrackIcons.h.
    MOSH_DECLARE_ID (trackIcon)

    // Pro Tools dynamic Clip Gain — identifies the hidden clip-local VolumeAndPanPlugin
    // whose absolute automation curve applies the per-breakpoint gain offsets. It lives
    // inside the audio clip's own plugin list, so Tracktion moves, duplicates, saves and
    // reloads it with the clip rather than leaking the envelope onto the track fader.
    MOSH_DECLARE_ID (moshClipGainEnvelope)
    // FL drum-lane mute/solo: comma-separated GM pitches whose sampler pad is muted /
    // soloed on a drum track. Persisted on the track; applied as sampler pad gains.
    MOSH_DECLARE_ID (drumMute)
    MOSH_DECLARE_ID (drumSolo)
    // The pad's OWN gain, parked here while the pad is muted, and restored verbatim on
    // unmute. Lives on te::SamplerPlugin's SOUND child (mosh-prefixed so it cannot
    // collide with a te::IDs property), and so saves/reloads with the edit.
    //
    // It exists because a pad's mute state CANNOT be inferred from its gain. The engine
    // clamps every gain write to [-48, +48] dB — in SamplerPlugin::setSoundGains and
    // again in the SamplerSound constructor — so the old scheme (mute by writing -100,
    // detect mute by reading back <= -99) could never see its own sentinel: the stored
    // value was always -48. Muting a lane was therefore permanent, and it persisted
    // through save/reload. Written WITH the undo manager so mute/unmute undoes as one.
    MOSH_DECLARE_ID (moshPadGainDb)
    // The pad's CHOKE GROUP (1-16; absent/0 = none). Pads sharing a group cut each other
    // off — a closed hat silencing an open one. Lives on the SOUND child alongside the
    // parked gain above.
    //
    // This is a MOSH-SIDE property with NO engine backing: te::SamplerPlugin has no choke
    // concept, its playingNotes list is private, and an open-ended voice ignores note-off
    // entirely (the only stops it offers kill every voice on the track at once). It is
    // therefore enforced by exactly two mechanisms, and nothing else:
    //   - live triggering, where MoshOps owns the injected stream (audition_note); and
    //   - apply_choke, which BAKES it into note lengths so clip playback and export obey
    //     it too. During playback the MIDI comes from the engine's own MidiNode, which
    //     MoshOps is not in the path of, so there is no third way to do this short of a
    //     custom sampler subclass — rejected for v1 because the plugin type name is
    //     persisted in every existing edit.
    MOSH_DECLARE_ID (moshChokeGroup)
    // The kit a drum track last loaded, so the picker can show what is on it.
    MOSH_DECLARE_ID (drumKitId)

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

    // SEC-001 — named SONG SECTIONS (Intro/Verse/Hook/…). A MOSH_SECTIONS container
    // child of the Edit's own ValueTree (mirrors MOSH_PROJECT's parenting) holding
    // MOSH_SECTION nodes — each a BEAT-range region with a name + colour, so it's
    // tempo-independent. Plain ValueTree data parented under the Edit ⇒ it saves/
    // reloads with the .tracktionedit and is UNDOABLE when written with the undo
    // manager. Drives the section navigator + (later) agent scope handles.
    MOSH_DECLARE_ID (MOSH_SECTIONS)
    MOSH_DECLARE_ID (MOSH_SECTION)
    MOSH_DECLARE_ID (sectionName)
    MOSH_DECLARE_ID (sectionStartBeat)
    MOSH_DECLARE_ID (sectionEndBeat)
    MOSH_DECLARE_ID (sectionColor)

    // Pro Tools Clip Groups — arrangement membership only, never a Tracktion folder
    // or routing submix. Inactive nodes stay persisted so Regroup can restore the
    // last Ungroup without reconstructing a selection from UI state.
    MOSH_DECLARE_ID (MOSH_CLIP_GROUPS)
    MOSH_DECLARE_ID (MOSH_CLIP_GROUP)
    MOSH_DECLARE_ID (MOSH_CLIP_GROUP_MEMBER)
    MOSH_DECLARE_ID (clipGroupName)
    MOSH_DECLARE_ID (clipGroupActive)
    MOSH_DECLARE_ID (clipGroupClipId)
    MOSH_DECLARE_ID (lastUngroupedClipGroupId)

    // Pro Tools Track Groups — non-routing Edit/Mix linkage. These nodes never
    // create Tracktion folder tracks or alter signal flow.
    MOSH_DECLARE_ID (MOSH_TRACK_GROUPS)
    MOSH_DECLARE_ID (MOSH_TRACK_GROUP)
    MOSH_DECLARE_ID (MOSH_TRACK_GROUP_MEMBER)
    MOSH_DECLARE_ID (trackGroupName)
    MOSH_DECLARE_ID (trackGroupKind)
    MOSH_DECLARE_ID (trackGroupEnabled)
    MOSH_DECLARE_ID (trackGroupMixAttributes)
    MOSH_DECLARE_ID (trackGroupTrackId)
    MOSH_DECLARE_ID (trackGroupsSuspended)

    // ANN-001 — timeline ANNOTATIONS (lightweight, authored comment pins). A
    // MOSH_ANNOTATIONS container child of the Edit's own ValueTree (mirrors
    // MOSH_SECTIONS) holding MOSH_ANNOTATION nodes — each a BEAT-anchored note with
    // text + colour + author, so it stays on its musical spot across tempo edits.
    // Plain ValueTree data parented under the Edit ⇒ saves/reloads with the
    // .tracktionedit and is UNDOABLE when written with the undo manager. Unlike
    // sections, annotations BROADCAST over multiplayer (a shared collaborator comment),
    // so the create handler mints a stable cross-peer id and broadcasts it.
    MOSH_DECLARE_ID (MOSH_ANNOTATIONS)
    MOSH_DECLARE_ID (MOSH_ANNOTATION)
    MOSH_DECLARE_ID (annotationText)
    MOSH_DECLARE_ID (annotationBeat)
    MOSH_DECLARE_ID (annotationColor)
    MOSH_DECLARE_ID (annotationAuthor)

    // LYR-001 — Finish-My-Song LYRIC SHEET. A MOSH_LYRICSHEET node parented under a
    // TRACK's own state (the vocal track) — one sheet per track, mirroring how
    // moshInputDevice/trackType ride the track. It holds a LYRIC_LINES container of
    // MOSH_LYRICLINE nodes, each a constraint-bearing line (role, syllable target,
    // stress contour, rhyme group, locked words, seed text with ___ gaps). Plain
    // ValueTree data ⇒ it saves/reloads with the .tracktionedit and is UNDOABLE when
    // written with the undo manager. A purely ADDITIVE optional node (absent ⇒ no
    // sheet), so it needs no format-version bump. Lines optionally reference a
    // MOSH_SECTION via lyricSectionId. The constraint spec (§5) is materialised as
    // these structured props, not an opaque blob.
    MOSH_DECLARE_ID (MOSH_LYRICSHEET)
    MOSH_DECLARE_ID (MOSH_LYRICLINE)
    MOSH_DECLARE_ID (LYRIC_LINES)
    // sheet-level
    MOSH_DECLARE_ID (lyricGrid)            // "1/4" | "1/8" | "1/16" — bar subdivision for syllable inference
    MOSH_DECLARE_ID (lyricLanguage)        // phonology language tag, e.g. "en"
    MOSH_DECLARE_ID (lyricTopic)
    MOSH_DECLARE_ID (lyricMood)
    MOSH_DECLARE_ID (lyricExplicit)        // "allow" | "clean" | "mild"
    MOSH_DECLARE_ID (lyricStyleBias)       // bool — §7 style-RAG: bias generation toward the artist's own voice
    MOSH_DECLARE_ID (lyricSpecVersion)     // constraint-spec schema version (int, >= 1)
    // per-line
    MOSH_DECLARE_ID (lyricIndex)           // 0-based line order
    MOSH_DECLARE_ID (lyricRole)            // "verse" | "hook" | "bridge" | "adlib"
    MOSH_DECLARE_ID (lyricSeedText)        // partial line with ___ gaps
    MOSH_DECLARE_ID (lyricText)            // finalized line text
    MOSH_DECLARE_ID (lyricSyllableTarget)  // 0 ⇒ infer from the beat grid
    MOSH_DECLARE_ID (lyricSyllableTol)     // +/- tolerance on the target
    MOSH_DECLARE_ID (lyricStress)          // contour string, e.g. "xXxxxXxxx" ('?' = free)
    MOSH_DECLARE_ID (lyricRhymeGroup)      // lines sharing a group must rhyme ("A","B",…)
    MOSH_DECLARE_ID (lyricRhymeStrictness) // "perfect" | "slant" | "free" ("" ⇒ inherit sheet)
    MOSH_DECLARE_ID (lyricLocked)          // hard-fixed line (don't regenerate)
    MOSH_DECLARE_ID (lyricSectionId)       // optional link to a MOSH_SECTION
    // L2 generation — TRANSIENT, non-undoable: the ranked top-N proposals for a line
    // as a JSON-string blob (the service result's per-line proposals array), plus a
    // regen counter that varies the LLM/fake sample. accept copies the chosen
    // proposal's text into lyricText (undoable) and clears these; reject just clears.
    // status flows empty→seed→generating→proposed→asserted.
    MOSH_DECLARE_ID (lyricProposals)       // JSON array string of {text,score,syllables,passes,grade,endWord,...}
    MOSH_DECLARE_ID (lyricRegen)           // int — bumped by regenerate_lyric
    // L1 — TRANSIENT, non-undoable: precise per-line phonology from analyze_lyrics, a
    // JSON-object blob {syllables,target,stress,rhymeGrade,rhymeOk,words,...} → snapshot →
    // the flow visualizer. Refreshed on demand; never persisted (recomputable).
    MOSH_DECLARE_ID (lyricAnalysis)
    // Phase-3 Stage 1 — PERSISTED render-ready score from the take (kill-shot B GO): the
    // line's bar of articulation slots, melisma segments underneath (per-note pitch/time),
    // a JSON-object blob {v,algo,bar,bpm,timeSig,grid,slots:[{start,end,kind,segments}]}
    // landed by build_skeleton_from_clip. NOT a generation constraint — excluded from
    // lineFingerprint; grid edits leave it untouched (it is the take's truth; the Stage-2
    // score author reconciles text vs slots). Additive optional ⇒ no format bump.
    MOSH_DECLARE_ID (lyricScore)
    // Pipeline correction 2026-07-04 — lyric PROVENANCE, honest by construction:
    //   "sung"      the producer really sang this line; text is VERBATIM his (extraction)
    //   "partial"   some heard words anchor the line; gaps regenerate
    //   "mixed"     accepted a proposal that kept heard words
    //   "generated" accepted a proposal with no heard words
    //   "edited"    a hand edit touched a sung line (never claim it verbatim-his again)
    // Absent ⇒ legacy/typed. Additive optional ⇒ no format bump.
    MOSH_DECLARE_ID (lyricOrigin)
    // Everything ASR HEARD in the take for this line — kept AND rejected words with
    // times/confidence/slot hints ({v,bar,words:[{word,start,end,conf,syl,slot,kept,
    // label,tier}]}). PERSISTED like lyricScore (future splice boundaries + correction
    // seeds); take truth, NOT a generation constraint — excluded from lineFingerprint.
    MOSH_DECLARE_ID (lyricHeard)

    MOSH_DECLARE_ID (id)
    MOSH_DECLARE_ID (inputRef)
    MOSH_DECLARE_ID (timeRangeStart)
    MOSH_DECLARE_ID (timeRangeEnd)
    MOSH_DECLARE_ID (modelAdapter)
    MOSH_DECLARE_ID (modelVersion)
    MOSH_DECLARE_ID (adapterVersion)
    MOSH_DECLARE_ID (mode)             // generate | reimagine | inpaint | continue
    MOSH_DECLARE_ID (modelVariant)     // size/decoder variant
    MOSH_DECLARE_ID (params)           // prompt, colors[], nl, target, strength (child tree)
    MOSH_DECLARE_ID (seed)
    MOSH_DECLARE_ID (safetyMappingVersion)
    MOSH_DECLARE_ID (sourceFingerprint)
    MOSH_DECLARE_ID (cacheKey)
    MOSH_DECLARE_ID (cacheArtifact)
    MOSH_DECLARE_ID (status)           // empty | queued | rendering | ready | error | dirty
    MOSH_DECLARE_ID (renderError)      // last service error string when status=="error" (additive, optional)
    MOSH_DECLARE_ID (originalSourceRef) // wave clips: the pre-render source path, stored once, so Reset can restore it (additive)
    MOSH_DECLARE_ID (appliedInPlace)   // wave clips: true while the clip's source IS the render artifact (auto-apply) (additive)
    MOSH_DECLARE_ID (coverage)         // whole-clip coverage: "auto" | "loop" (tile a cycle) | "stitch" (window+crossfade) (additive)
    // Phase 2 (drum/MIDI re-imagine): marks the HIDDEN looping render that plays beneath a muted
    // MIDI/drum clip. Set on BOTH the dedicated hidden audio TRACK's state (so snapshot() excludes
    // the whole track — the producer hears it but never sees it; export uses the real edit, so it
    // still plays) AND the landed clip's state (defensive UI filter). It can't live on the SOURCE
    // track because a track's instrument synth overwrites the buffer (silencing any audio clip on
    // it), so the render lands on its own instrument-free track. Additive, round-trip-safe.
    MOSH_DECLARE_ID (moshHidden)
    // Phase 3 (reactive auto-re-render): when an applied render layer is live (a wave clip's source
    // IS the render, or a MIDI clip's hidden audio plays beneath it), editing the SOURCE — notes,
    // trim, the track's instrument/FX, or a generative knob — debounce-fires a background re-render
    // that HOT-SWAPS the result, so the producer never has to manually re-imagine. `reactive` is the
    // per-layer opt-out (default ON, absent ⇒ true). `reactiveEpoch` is bumped on every edit-touch;
    // finalizeRender drops a result whose epoch is stale (a newer edit superseded it). Both non-undoable.
    MOSH_DECLARE_ID (reactive)
    MOSH_DECLARE_ID (reactiveEpoch)
    // Lane A (render-ahead / "Live"): when armed on a wave clip, transport playback drives a
    // progressive window-by-window re-imagine that lays crossfaded audio AHEAD of the playhead and
    // repoints the clip's source to the growing file (byte-stable prefix ⇒ glitch-free mid-play).
    // `liveArmed` is the per-layer toggle surfaced in the snapshot for the UI. Non-undoable.
    MOSH_DECLARE_ID (liveArmed)
    MOSH_DECLARE_ID (createdBy)        // user | (future) monster
    MOSH_DECLARE_ID (userKept)
    MOSH_DECLARE_ID (compiledEnvelope) // TRANSIENT: JSON of the last compile_render result (mode/backend/reasoning/say) — non-undoable, like lyricProposals

    // params child + colors
    MOSH_DECLARE_ID (PARAMS)
    MOSH_DECLARE_ID (prompt)
    MOSH_DECLARE_ID (COLORS)
    MOSH_DECLARE_ID (COLOR)
    MOSH_DECLARE_ID (name)
    MOSH_DECLARE_ID (value)            // 0–100 ASTD UI value
    MOSH_DECLARE_ID (nl)               // init_noise_level (reimagine)
    MOSH_DECLARE_ID (target)           // Route B transform target (instrument or free-text)
    MOSH_DECLARE_ID (strength)         // Route B transform strength (0–100 ASTD UI value)
    MOSH_DECLARE_ID (LORAS)            // LoRA rack selection (≤2 LORA children, ordered)
    MOSH_DECLARE_ID (LORA)             // one selected LoRA: name + value (0–100 UI strength)

#undef MOSH_DECLARE_ID
} // namespace mosh::ids
