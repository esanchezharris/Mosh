// What an empty-lane double-click should DO, as a pure function of track state.
//
// Split out of TrackLaneList so the decision is unit-testable with no DOM and no store.
// The caller owns the side effects: "clip" means run add_midi_clip at the snapped bar,
// "menu" means open the LaneMenu at the pointer.
//
// Why the branch exists at all: there is no native "midi" track TYPE — an instrument
// track is type:"audio" carrying a synth (see the spec). So a bare instrument track and
// a plain audio track are indistinguishable here, and guessing either way is wrong for
// half the users. A bare track is asked; a track that already has a synth is not.

import type { Track } from "../../types";

export type LaneTrack = Pick<Track, "isInstrument">;

export type LaneNewPlan =
  | { kind: "clip" }   // has an instrument -> a MIDI clip here is audible
  | { kind: "menu" };  // bare -> offer instrument vs audio rather than a silent clip

export function resolveLaneNew(track: LaneTrack): LaneNewPlan {
  return track.isInstrument ? { kind: "clip" } : { kind: "menu" };
}
