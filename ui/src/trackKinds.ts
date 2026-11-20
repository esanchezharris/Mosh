// Track kinds the add-track affordances can create, and the command sequence for each.
// Shared by every shell; was part of v2/lanes/TrackLaneList.tsx.

import type { CommandResult } from "./types";

// The kinds of track the add-track affordance can create. Both add-track sites used to be
// hardcoded to `create_track {name:"Audio"}`, which made drum and instrument tracks
// UNREACHABLE in the shipped (v2) shell — the backends were complete and Catch2-tested the
// whole time (`cmdCreateTrack type:"drum"` stamps the type and loads sampler+kit;
// `cmdAddMidiClip` auto-loads 4OSC on an instrument-less track), but nothing in v2 ever
// asked for them, and `add_midi_clip` had no v2 call site at all. Only the classic shell's
// Topbar did (`+ Drums` / `+ MIDI`), so programming a beat or a melody with the mouse was
// impossible in the default UI. `ui/src/trackKinds.test.ts` pins this.
export type TrackKind = "audio" | "drum" | "midi" | "tone" | "recipe";

export const TRACK_KINDS: { kind: TrackKind; label: string; hint: string }[] = [
  { kind: "audio",  label: "Audio",       hint: "Record or drop a file" },
  { kind: "drum",   label: "Drums",       hint: "Sampler + kit, ready to program" },
  { kind: "midi",   label: "Instrument",  hint: "Synth + an empty MIDI clip" },
  { kind: "tone",   label: "Test tone",   hint: "A reference tone — check you can hear anything" },
  { kind: "recipe", label: "Recipe beat", hint: "A full beat from the curated groove library" },
];

// Create a track of the given kind. Pure of React so the reachability test can drive it
// with a recording fake `exec` and assert the exact command sequence.
export async function addTrackOfKind(
  kind: TrackKind,
  exec: (command: string, args?: Record<string, unknown>) => Promise<CommandResult>,
): Promise<void> {
  if (kind === "audio") { await exec("create_track", { name: "Audio" }); return; }
  if (kind === "drum") { await exec("create_track", { name: "Drums", type: "drum" }); return; }
  // A reference tone, for hearing whether the output path works at all. Classic had this in
  // its Topbar targeting the SELECTED track; v2 has no "add a clip to this track" affordance
  // to hang it off, so it arrives the same way an Instrument track does — make the track,
  // then put the clip on it — which is also the shape you want when the question is "is
  // anything reaching my speakers", i.e. before you trust any existing track.
  if (kind === "tone") {
    const toneRes = await exec("create_track", { name: "Tone" });
    const toneTrackId = (toneRes.data as { trackId?: string } | undefined)?.trackId;
    if (toneRes.ok && toneTrackId) await exec("add_test_tone_clip", { trackId: toneTrackId });
    return;
  }
  // A whole beat from the curated recipe library — real grooves recombined per element
  // with a palette one-shot bound to every role. Unlike its siblings this entry creates
  // no track first: generate_beat_recipe's generated program creates its own tracks and
  // clips as ONE undoable batch. The slow fetch leg (service may cold-start) runs off
  // the message thread via the WebBridge two-phase hop, so the shell stays responsive.
  if (kind === "recipe") { await exec("generate_beat_recipe", {}); return; }
  // There is no native "midi" track TYPE — cmdCreateTrack accepts only audio|drum, and an
  // instrument track IS an audio track carrying a synth plus MIDI clips. So: make the
  // track, then put a clip on it. add_midi_clip loads 4OSC in its own transaction when the
  // track has no instrument, so the clip lands audible and piano-roll-ready rather than
  // silent. Two commands ⇒ two undo steps, which is deliberate: add_midi_clip DOES
  // auto-create a track when trackId is absent (one step), but native creates a NEW track
  // there while bridge.mock.ts falls back to tracks[0] — passing an explicit trackId keeps
  // mock and native identical, and the mock would otherwise error in the empty state.
  const res = await exec("create_track", { name: "Instrument" });
  const trackId = (res.data as { trackId?: string } | undefined)?.trackId;
  if (res.ok && trackId) await exec("add_midi_clip", { trackId });
}
