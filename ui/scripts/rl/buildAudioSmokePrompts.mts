// Minimal RENDERABLE prompt scaffold for the Rung-2 audio reward (the "I scaffold,
// Ytripper finalizes" half of the Reward+PromptFeed contract). The existing rl-v1 pool
// is the symbolic SFT tasks ("set the tempo to 142" → silence), useless for an audio
// reward. This emits a handful of guaranteed-renderable tasks — each seeds a DRUM track
// (auto-loads the sampler + kit, so MIDI is audible) + an empty MIDI clip, and asks the
// policy to write notes into it → the completion renders to real audio the Reward can
// judge. It is intentionally TINY: enough to smoke the loop and show reward variance.
// The rich teardown-seeded PromptFeed (varied instruments/contexts) is Ytripper's half.
//
//   cd ui && npx tsx scripts/rl/buildAudioSmokePrompts.mts --out ../service/sft/.rl-data/rl-audio-smoke
//
// Writes rl_train.{prompts,eval}.jsonl + gate.{prompts,eval}.jsonl + manifest.json,
// the exact shapes grpo.py / buildRlPrompts produce.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { buildExamplePrompt } from "../../src/gepa/metric";
import { DEFAULT_RULES } from "../../src/agent/brainCore";
import type { EvalExample } from "../../src/gepa/evalset";
import type { BoundCommand } from "../../src/import/emit";

const flag = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const outDir = resolve(flag("out", "../service/sft/.rl-data/rl-audio-smoke")!);

/** A drum track + empty MIDI clip; the policy is asked to write a pattern into the clip. */
function task(id: string, trackName: string, utterance: string): EvalExample {
  const startCommands: BoundCommand[] = [
    { command: "create_track", args: { name: trackName, type: "drum" }, bind: "t0" },
    { command: "add_midi_clip", args: { trackId: "$t0", start: 0 }, bind: "c0" },
  ];
  return { id, utterance, startCommands, goldCommandNames: ["add_note"] };
}

const tasks: EvalExample[] = [
  task("smoke#0", "Drums", "write a drum beat into the clip on the Drums track"),
  task("smoke#1", "Beat", "lay down a four-on-the-floor kick pattern in the clip"),
  task("smoke#2", "Kit", "put a simple boom-bap groove into the clip on the Kit track"),
  task("smoke#3", "Drums", "fill the clip with a busy hi-hat pattern"),
  task("smoke#4", "Perc", "write a syncopated snare-and-kick rhythm into the clip"),
  task("smoke#5", "Drums", "add a half-time beat to the clip on the Drums track"),
];

mkdirSync(outDir, { recursive: true });
async function dumpPrompts(path: string, exs: EvalExample[]): Promise<void> {
  const lines: string[] = [];
  for (const ex of exs) lines.push(JSON.stringify({ id: ex.id, messages: await buildExamplePrompt(DEFAULT_RULES, ex) }));
  writeFileSync(path, lines.join("\n") + "\n");
}
const dumpEval = (path: string, exs: EvalExample[]) =>
  writeFileSync(path, exs.map((e) => JSON.stringify({ id: e.id, utterance: e.utterance, startCommands: e.startCommands, goldCommandNames: e.goldCommandNames })).join("\n") + "\n");

dumpEval(join(outDir, "rl_train.eval.jsonl"), tasks);
dumpEval(join(outDir, "gate.eval.jsonl"), tasks);
await dumpPrompts(join(outDir, "rl_train.prompts.jsonl"), tasks);
await dumpPrompts(join(outDir, "gate.prompts.jsonl"), tasks);
writeFileSync(join(outDir, "manifest.json"), JSON.stringify({ kind: "audio-smoke-scaffold", tasks: tasks.length, note: "renderable drum tasks; replace with Ytripper PromptFeed for a real run" }, null, 2) + "\n");
console.log(`wrote ${tasks.length} renderable tasks → ${outDir}`);
