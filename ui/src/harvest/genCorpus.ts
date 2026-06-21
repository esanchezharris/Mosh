// Seed utterance corpus for headless real-turn generation (genTurns.ts).
//
// One continuous session ARC, from an empty project. Order matters: creation
// turns come before the turns that edit what they made, because the brain is told
// to use the REAL ids in the session — it can only reference a track/clip that an
// earlier turn already created. Covers the breadth of the agent command catalog
// (tracks, clips, notes, tempo/key/time-sig, mixer, transport, undo/redo, save)
// plus a couple of deliberate deferrals (off-topic / too-vague → the brain should
// emit no commands, producing no tuple). These are natural-language requests, not
// commands: the brain maps each to whatever the catalog actually offers.

export const SESSION_ARC: string[] = [
  // build the skeleton
  "add a punchy drum track",
  "add a bass track",
  "add a keys track for chords",
  "add a lead synth track",
  "set the tempo to 88",
  "set the key to F minor",

  // populate — clip first, then notes (a later turn can ground on the new clip id)
  "put a 4-bar MIDI clip on the drums",
  "lay a boom-bap kick and snare into that drum clip",
  "give the bass an 8-bar MIDI clip",
  "write a simple sub bassline in the bass clip",
  "add a 4-bar chord clip on the keys",
  "put a moody minor chord progression in the keys clip",
  "add a 2-bar clip on the lead",
  "sketch a short melody on the lead",

  // mix moves
  "turn the bass up a couple dB",
  "pan the keys slightly right",
  "mute the lead for now",
  "solo the drums",
  "unsolo the drums",
  "bring the overall volume down a touch",

  // structural edits
  'rename the lead track to "Topline"',
  "delete the lead clip",

  // transport + housekeeping
  "play it from the top",
  "stop playback",
  "save the project",
  "undo that last change",
  "actually, redo it",

  // deferrals — should produce no commands (no tuple)
  "what's the weather like today?",
  "just make it sound better",
];

export default SESSION_ARC;
