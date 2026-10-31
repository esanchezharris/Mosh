// ?mockSeed=fresh — a first launch on a fresh install, for the dev/e2e mock.
//
// What a friend sees the first time they open Mosh: no tracks, no clips, the engine's
// default 120 BPM, no loop engaged, nothing in Recent and no project file yet. The Start
// page's "Start a new song" path begins here. The rest of the fresh-install picture lives
// next to the state it changes in bridge.mock.ts: the audio selection reads External
// Headphones (unless ?mockFault=speakers), and the microphone permission reads
// "not-determined" until it is requested.
//
// Dev/e2e only. The 3-track default seed stays the boot session for every other lane.
import type { Snapshot } from "../types";

export const FRESH_TEMPO = 120;

/** The fresh-install session, built over the default seed's session shape so the two stay
 *  in lockstep (sample rate, click defaults, record options, ...). */
export function freshSeed(base: Snapshot): Snapshot {
  return {
    ...base,
    session: {
      ...base.session,
      tempo: FRESH_TEMPO,
      tempoMap: [{ time: 0, bpm: FRESH_TEMPO, curve: 1 }],
      countInBars: 0,
      editFile: "",
      recentProjects: [],
      project: base.session.project
        ? { ...base.session.project, countInBars: 0 }
        : base.session.project,
    },
    tracks: [],
    buses: [],
    sections: [],
    annotations: [],
    transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
    master: { volumeDb: 0, pan: 0, plugins: [] },
  };
}
