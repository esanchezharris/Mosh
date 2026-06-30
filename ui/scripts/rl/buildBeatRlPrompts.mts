// Build a NOTE-ELICITING rl-data set for the recipe-reward GRPO loop.
//
// The clean-apply rl-v1 prompts ("set tempo to 142") produce no notes → the recipe reward is
// uniformly ~0.06 → zero within-group variance → no gradient (the smoke confirmed signal=0/2).
// The recipe reward needs prompts where GOOD rollouts write a full note-bearing beat and weak
// ones don't — then the verifier's score spreads and GRPO has something to climb. The owner-v1
// SFT taught full create_track→add_midi_clip→add_note programs, so this is in-distribution.
//
//   npx tsx scripts/rl/buildBeatRlPrompts.mts --out ../service/sft/.rl-data/rl-beat-v1 --n 24

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { __resetMockForTests, mockExecute, mockSnapshot } from "../../src/bridge.mock";
import { buildSystemPrompt } from "../../src/agent/brainCore";
import type { Snapshot, CommandResult } from "../../src/types";

const arg = (k: string, d = "") => { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const OUT = arg("out", join(process.cwd(), "..", "service", "sft", ".rl-data", "rl-beat-v1"));
const N = parseInt(arg("n", "24"), 10);

// Full-beat note-eliciting instructions. Each asks for a COMPLETE beat with explicit note
// content across drums/bass/melody — so the recipe verifier (which wants all three parts,
// in-key, dynamic, developing) can grade the musical DNA the rollout actually writes.
const GENRES = [
  "dark trap beat at 140 BPM in A minor",
  "lo-fi boom-bap beat at 82 BPM in C major",
  "aggressive trap beat at 145 BPM in F# minor",
  "soulful boom-bap beat at 92 BPM in D minor",
  "spacey trap beat at 136 BPM in E minor",
  "warm lo-fi beat at 78 BPM in G major",
];
const ASK = (g: string) =>
  `Make a ${g}. Build the whole beat with real note content: create a Drums track and write a kick/snare/hat pattern, ` +
  `create a Bass track with a clip and write a bassline, and create a Melody track with a clip and write a melody. ` +
  `Use add_midi_clip then add_note for every part — give the kick accents and ghost notes (vary velocity), keep every ` +
  `melodic note in key, put notes on the 16th grid, and make bar 2 differ from bar 1. Emit all the commands now.`;

async function main() {
  __resetMockForTests();
  await mockExecute<CommandResult>({ command: "new_project", args: {} });
  const snap = await mockSnapshot<Snapshot>();
  const system = buildSystemPrompt(snap);  // empty-session system prompt (the policy must CREATE the parts)

  const prompts: string[] = [], evals: string[] = [];
  for (let i = 0; i < N; i++) {
    const g = GENRES[i % GENRES.length];
    const id = `beat_${String(i).padStart(3, "0")}`;
    const user = ASK(g);
    prompts.push(JSON.stringify({ id, messages: [{ role: "system", content: system }, { role: "user", content: user }] }));
    // recipe scorer ignores gold (it grades the produced DNA) — eval carries id + empty seed
    evals.push(JSON.stringify({ id, utterance: user, startCommands: [], goldCommandNames: [] }));
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "rl_train.prompts.jsonl"), prompts.join("\n") + "\n");
  writeFileSync(join(OUT, "rl_train.eval.jsonl"), evals.join("\n") + "\n");
  // small gate set (reuse the same prompts/evals — gate measures clean-apply, a sanity floor)
  const g = Math.min(8, N);
  writeFileSync(join(OUT, "gate.prompts.jsonl"), prompts.slice(0, g).join("\n") + "\n");
  writeFileSync(join(OUT, "gate.eval.jsonl"), evals.slice(0, g).join("\n") + "\n");
  writeFileSync(join(OUT, "manifest.json"), JSON.stringify({ n: N, genres: GENRES, kind: "note-eliciting full-beat", system_len: system.length }, null, 1));
  console.log(`wrote ${N} note-eliciting beat prompts → ${OUT}`);
}
main();
