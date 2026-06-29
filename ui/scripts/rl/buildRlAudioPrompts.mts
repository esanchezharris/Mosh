// Build the AUDIO-reward RL prompt set: trap/lofi tasks whose `startCommands` seed a
// NON-SILENT base so EVERY rollout renders (the floor guarantee). With the audio reward,
// a silent rollout scores 0 and grpo.py zeros the whole group's advantage when reward
// std < 1e-6 — an all-silent group gives NO gradient. Seeding a non-silent base turns a
// dead all-zero group into a within-group ranking (good edits > no-ops > broken edits) →
// a real gradient. The policy SEES the seeded session in its system prompt (buildSystemPrompt
// renders the post-startCommands snapshot), so it edits on top — matching the SFT distribution.
//
//   cd ui && npx tsx scripts/rl/buildRlAudioPrompts.mts \
//     --out ../service/sft/.rl-data/rl-audio-v1 [--variants 1] [--tier-b] [--seed 1]
//
// Writes into <out>/:  rl_train.{eval,prompts}.jsonl  gate.{eval,prompts}.jsonl  manifest.json
// — the EXACT set grpo.py consumes (prompts via buildExamplePrompt, byte-identical to SFT/eval).
//
// Strategy & traps documented in service/teardown/flywheel/GRPO_HANDOFF.md. DO NOT seed
// startCommands from grpo_bridge.seed_promptfeed — those flattened commands don't render as a
// sequence; use these whole-sequence audio-bearing templates.

import { mkdirSync, writeFileSync, openSync, writeSync, closeSync } from "node:fs";
import { resolve, join } from "node:path";
import { buildExamplePrompt } from "../../src/gepa/metric";
import { DEFAULT_RULES } from "../../src/agent/brainCore";
import type { EvalExample } from "../../src/gepa/evalset";
import type { BoundCommand } from "../../src/import/emit";

const flag = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const has = (n: string) => process.argv.includes(`--${n}`);

const outDir = flag("out");
if (!outDir) { console.error("--out <dir> required"); process.exit(1); }
const variants = Math.max(1, Number(flag("variants", "1")) || 1);
const tierB = has("tier-b");

type Note = { pitch: number; start: number; length: number; velocity: number };

// ---- non-silent seed builders (the floor) -------------------------------------------------
// A proven-audible trap drum pattern (kick=36, snare=38, hat=42 — GM drum map, the sampler kit
// covers these; see SelfTest.cpp drum-audible check). 4 beats, 1 bar.
function drumNotes(transpose = 0): Note[] {
  const k = 36, s = 38, h = 42; // transpose only shifts a melodic layer, not drums
  return [
    { pitch: k, start: 0, length: 0.5, velocity: 120 },
    { pitch: h, start: 0, length: 0.25, velocity: 80 },
    { pitch: h, start: 0.5, length: 0.25, velocity: 80 },
    { pitch: s, start: 1, length: 0.5, velocity: 110 },
    { pitch: h, start: 1, length: 0.25, velocity: 80 },
    { pitch: h, start: 1.5, length: 0.25, velocity: 80 },
    { pitch: k, start: 2, length: 0.5, velocity: 120 },
    { pitch: h, start: 2, length: 0.25, velocity: 80 },
    { pitch: h, start: 2.5, length: 0.25, velocity: 80 },
    { pitch: s, start: 3, length: 0.5, velocity: 110 },
    { pitch: h, start: 3.5, length: 0.25, velocity: 80 },
  ];
}
// C minor pentatonic melody (C=60), transposable per variant for distinct prompts.
function melodyNotes(transpose = 0): Note[] {
  const scale = [60, 63, 65, 67, 70];
  return scale.map((p, i) => ({ pitch: p + transpose, start: i * 0.75, length: 0.5, velocity: 96 }));
}

function drumSeed(transpose = 0): BoundCommand[] {
  return [
    { command: "create_track", args: { name: "Drums", type: "drum" }, bind: "t0" },
    { command: "add_midi_clip", args: { trackId: "$t0", start: 0, length: 4, notes: drumNotes(transpose) }, bind: "c0" },
  ];
}
function toneSeed(freq = 110): BoundCommand[] {
  return [
    { command: "create_track", args: { name: "Bass", type: "audio" }, bind: "t0" },
    { command: "add_test_tone_clip", args: { trackId: "$t0", seconds: 4, freq }, bind: "c0" },
  ];
}
function melodySeed(transpose = 0): BoundCommand[] {
  return [
    { command: "create_track", args: { name: "Keys", type: "audio" }, bind: "t0" },
    { command: "add_midi_clip", args: { trackId: "$t0", start: 0, length: 4, notes: melodyNotes(transpose) }, bind: "c0" },
  ];
}

// ---- template definitions -----------------------------------------------------------------
// Each maps a variant index → an EvalExample with a NON-SILENT seed + a trap/lofi edit utterance.
// `gold` is the edit-command multiset (used only by the symbolic gate metric — the AUDIO reward
// scores the rendered WAV regardless of gold).
type Tmpl = { key: string; make: (v: number) => Omit<EvalExample, "id"> };

// CONTENT-changing edits only. The reward loudness-normalizes (the "can't win by getting louder"
// guard), so volume/gain/mute edits are reward-INVARIANT → zero within-group variance → no gradient.
// Every template here ADDS audible content (a new melodic/percussive/tonal layer), so different
// completions render different audio → a reward spread the gradient can climb. (Mix/volume control
// is real product surface, but it's not learnable from a loudness-normalized timbre+timing reward,
// so it doesn't belong in THIS RL set.)
const tierA: Tmpl[] = [
  { key: "drum-add-mel", make: () => ({ utterance: "add a dark 808 melody on a new track", startCommands: drumSeed(), goldCommandNames: ["create_track", "add_midi_clip"] }) },
  { key: "drum-add-stab", make: () => ({ utterance: "lay a hazy lofi chord stab over the beat on a new track", startCommands: drumSeed(), goldCommandNames: ["create_track", "add_midi_clip"] }) },
  { key: "drum-add-bass", make: () => ({ utterance: "add a deep sub-bass tone on a new track", startCommands: drumSeed(), goldCommandNames: ["create_track", "add_test_tone_clip"] }) },
  { key: "drum-add-lead", make: () => ({ utterance: "put a bright lead melody over the beat on a new track", startCommands: drumSeed(), goldCommandNames: ["create_track", "add_midi_clip"] }) },
  { key: "tone-add-keys", make: () => ({ utterance: "add some moody lofi keys on a new track", startCommands: toneSeed(), goldCommandNames: ["create_track", "add_midi_clip"] }) },
  { key: "tone-add-drums", make: () => ({ utterance: "add a punchy trap drum pattern on a new track", startCommands: toneSeed(), goldCommandNames: ["create_track", "add_midi_clip"] }) },
  { key: "tone-add-lead", make: () => ({ utterance: "layer a bright lead tone on a new track", startCommands: toneSeed(), goldCommandNames: ["create_track", "add_test_tone_clip"] }) },
  { key: "mel-add-drums", make: () => ({ utterance: "add a hard-hitting trap drum pattern on a new track", startCommands: melodySeed(), goldCommandNames: ["create_track", "add_midi_clip"] }) },
  { key: "mel-add-sub", make: () => ({ utterance: "add a sub bass tone underneath the keys on a new track", startCommands: melodySeed(), goldCommandNames: ["create_track", "add_test_tone_clip"] }) },
  { key: "mel-add-hats", make: () => ({ utterance: "add a busy hi-hat pattern on a new drum track", startCommands: melodySeed(), goldCommandNames: ["create_track", "add_midi_clip"] }) },
  { key: "mel-add-counter", make: () => ({ utterance: "add a counter-melody on a new track", startCommands: melodySeed(), goldCommandNames: ["create_track", "add_midi_clip"] }) },
  { key: "drum-add-pad", make: () => ({ utterance: "add a warm pad tone on a new track", startCommands: drumSeed(), goldCommandNames: ["create_track", "add_test_tone_clip"] }) },
];

const gateTmpl: Tmpl[] = [
  { key: "g-drum-bass", make: () => ({ utterance: "add a rumbling sub-bass tone on a new track", startCommands: drumSeed(), goldCommandNames: ["create_track", "add_test_tone_clip"] }) },
  { key: "g-tone-pad", make: () => ({ utterance: "add a soft pad tone on a new track", startCommands: toneSeed(), goldCommandNames: ["create_track", "add_test_tone_clip"] }) },
  { key: "g-mel-kick", make: () => ({ utterance: "add a boom-bap kick pattern on a new drum track", startCommands: melodySeed(), goldCommandNames: ["create_track", "add_midi_clip"] }) },
  { key: "g-drum-mel", make: () => ({ utterance: "add a dark melody on top of the beat on a new track", startCommands: drumSeed(), goldCommandNames: ["create_track", "add_midi_clip"] }) },
];

// Tier B — build-from-scratch curriculum (empty seed; the policy must build the whole beat).
// Mixed in only with --tier-b. Many rollouts here may render silent (no gradient for THOSE
// prompts), but per-prompt grouping means they never poison Tier-A's gradient.
const tierBTmpl: Tmpl[] = [
  { key: "b-trap", make: () => ({ utterance: "make an 8-bar trap beat with hard drums and a dark melody", startCommands: [], goldCommandNames: ["create_track", "add_midi_clip", "create_track", "add_midi_clip"] }) },
  { key: "b-lofi", make: () => ({ utterance: "build a lofi hip-hop loop with a kick pattern and mellow keys", startCommands: [], goldCommandNames: ["create_track", "add_midi_clip", "create_track", "add_midi_clip"] }) },
  { key: "b-boombap", make: () => ({ utterance: "lay down a boom-bap beat: drums plus a sampled-sounding bass tone", startCommands: [], goldCommandNames: ["create_track", "add_midi_clip", "create_track", "add_test_tone_clip"] }) },
];

// ---- expand templates into distinct prompts (deterministic; no RNG) -----------------------
function expand(tmpls: Tmpl[], reps: number): EvalExample[] {
  const out: EvalExample[] = [];
  for (const t of tmpls) {
    for (let v = 0; v < reps; v++) {
      const base = t.make(v);
      // For "add melody/drums" templates, transpose the ADDED layer per variant so prompts differ.
      const ex: EvalExample = { id: `audio:${t.key}#${v}`, utterance: base.utterance, startCommands: base.startCommands, goldCommandNames: base.goldCommandNames };
      // distinguish variant prompts by wording so the policy sees a genuinely different task
      if (reps > 1) ex.utterance = v === 0 ? base.utterance : `${base.utterance} (take ${v + 1})`;
      out.push(ex);
    }
  }
  return out;
}

const rlTrain = [...expand(tierA, variants), ...(tierB ? expand(tierBTmpl, variants) : [])];
const gate = expand(gateTmpl, 1);

// ---- dump (reuse the buildRlPrompts.mts shape: prompts via buildExamplePrompt) -------------
async function dumpPrompts(path: string, exs: EvalExample[]): Promise<void> {
  const fd = openSync(path, "w");
  for (const ex of exs) writeSync(fd, JSON.stringify({ id: ex.id, messages: await buildExamplePrompt(DEFAULT_RULES, ex) }) + "\n");
  closeSync(fd);
}
const dumpEval = (path: string, exs: EvalExample[]) =>
  writeFileSync(path, exs.map((e) => JSON.stringify({ id: e.id, utterance: e.utterance, startCommands: e.startCommands, goldCommandNames: e.goldCommandNames })).join("\n") + "\n");

mkdirSync(outDir, { recursive: true });
dumpEval(join(outDir, "rl_train.eval.jsonl"), rlTrain);
dumpEval(join(outDir, "gate.eval.jsonl"), gate);
await dumpPrompts(join(outDir, "rl_train.prompts.jsonl"), rlTrain);
await dumpPrompts(join(outDir, "gate.prompts.jsonl"), gate);

const manifest = {
  builtBy: "buildRlAudioPrompts.mts",
  strategy: "edit-on-top of a non-silent seed (trap/lofi); Tier-B build-from-scratch when --tier-b",
  counts: { rlTrain: rlTrain.length, gate: gate.length, tierB: tierB ? tierBTmpl.length * variants : 0 },
  variants, tierB,
};
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log(`▶ build-rl-audio-prompts → ${resolve(outDir)}`);
console.log(`  rl_train: ${rlTrain.length} (tierA=${tierA.length * variants}${tierB ? ` + tierB=${tierBTmpl.length * variants}` : ""}), gate: ${gate.length}, variants: ${variants}`);
