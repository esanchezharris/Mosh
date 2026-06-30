// Distillation corpus for training v0 — teach the LOCAL model to write full beats.
//
// The weight loop is gradient-starved because the local 4B policy DEFERS on full-beat asks
// (smoke: baseline gate 4/4 defer, GRPO reward μ≈0.03). The fix: distill from a strong teacher.
// Generate beats with GPT 5.4 mini + the structured beatBuilder + the GEPA-optimized directive,
// keep only the ones the deterministic verifier rates highly (>= --thr), and serialize each to
// an (instruction → full MoshOps program) SFT example. SFT the local model on these so it learns
// to emit complete, in-key, dynamic, developing beats — THEN GRPO-refine against the recipe reward.
//
//   AUDITION_CLOUD=1 npx tsx scripts/rl/buildBeatSft.mts --out ../service/sft/.sft-data/beat-v0 --per 24 --thr 0.9

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { __resetMockForTests, mockExecute, mockSnapshot } from "../../src/bridge.mock";
import { buildSystemPrompt } from "../../src/agent/brainCore";
import { buildRecipe, monophonicize, type BrainFn, type BuiltRecipe } from "../../src/agent/beatBuilder";
import { BEAT_SPECS } from "../../src/agent/beatSpecs";
import { verifyRecipe, recipeFromProgram } from "../../src/agent/recipeVerifier";
import { makePalette, type BeatPalette } from "../../src/agent/palette";
import { OPTIMIZED_DIRECTIVE } from "../../src/agent/beatDirective";
import type { Snapshot, CommandResult } from "../../src/types";

const arg = (k: string, d = "") => { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const OUT = arg("out", join(process.cwd(), "..", "service", "sft", ".sft-data", "beat-v0"));
const PER = parseInt(arg("per", "24"), 10);     // attempts per genre
const THR = parseFloat(arg("thr", "0.9"));      // keep beats scoring ≥ this on the (production-aware) verifier
const CONC = parseInt(arg("conc", "5"), 10);

// --palette <dir>: distill PRODUCTION-bearing beats — every example assigns real sounds
// (kit + melodic 808) so SFT teaches the model to emit production, not MIDI outlines. The
// emitted program is scored by the production-aware verifier (recipeFromProgram), so the
// kept corpus is real-sound beats. Omitted → MIDI-only corpus (legacy).
const PALETTE_DIR = arg("palette", "");
let PALETTE: BeatPalette | undefined;
if (PALETTE_DIR && existsSync(join(PALETTE_DIR, "manifest.json"))) {
  PALETTE = makePalette(JSON.parse(readFileSync(join(PALETTE_DIR, "manifest.json"), "utf8")));
  console.log(`palette: ${PALETTE_DIR} (kicks ${PALETTE.size("kick")}, snares ${PALETTE.size("snare")}, hats ${PALETTE.size("hat")}, 808s ${PALETTE.size("808")})`);
}

// MULTI-TEACHER distillation. The teacher is a one-time, amortized cost (the student runs
// forever, local + free), so distill from a MIX of strong models for diversity — different
// verifier-satisfying solutions → a student that generalizes, not one that clones one teacher.
// --teachers gpt-5.4,gpt-5.2-pro,gemini-2.5-pro,gpt-5.4-mini  (provider inferred from the name).
// Default = the single env brain (gpt-5.4-mini when OPENAI_API_KEY is set, else gemini-2.5-flash).
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "", GKEY = process.env.GEMINI_API_KEY ?? "";
const envProvider = (process.env.MOSH_BRAIN_PROVIDER || (OPENAI_KEY ? "openai" : "gemini")).toLowerCase();
const envModel = envProvider === "openai" ? (process.env.OPENAI_MODEL || "gpt-5.4-mini") : (process.env.MOSH_AGENT_MODEL || "gemini-2.5-flash");
const TEACHERS = (arg("teachers", "") ? arg("teachers", "").split(",").map((s) => s.trim()).filter(Boolean) : [envModel]);

type Teacher = { model: string; provider: string; endpoint: string; key: string; reasoning: boolean };
function resolveTeacher(model: string): Teacher {
  const provider = /gemini/i.test(model) ? "gemini" : "openai";
  return {
    model, provider,
    endpoint: provider === "openai" ? `${process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"}/chat/completions` : "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    key: provider === "openai" ? OPENAI_KEY : GKEY,
    reasoning: provider === "openai" && /^(gpt-5|gpt-6|o[0-9])/.test(model),
  };
}
console.log(`distill teachers: ${TEACHERS.join(", ")}`);
function makeBrain(temp: number, t: Teacher): BrainFn {
  return async (messages, opts) => {
    const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${t.key}` };
    const body: Record<string, unknown> = { model: t.model, messages };
    if (t.provider === "openai") { if (t.reasoning) { body.max_completion_tokens = 2048; body.reasoning_effort = process.env.OPENAI_REASONING_EFFORT || "low"; } else { body.max_tokens = 2048; body.temperature = temp; } }
    else { body.max_tokens = 2048; body.temperature = temp; body.extra_body = { google: { thinking_config: { thinking_budget: 0 } } }; }
    if (opts.json) body.response_format = { type: "json_object" };
    const r = await fetch(t.endpoint, { method: "POST", headers, body: JSON.stringify(body) });
    return (await r.json())?.choices?.[0]?.message?.content ?? "";
  };
}

const USER_TEMPLATES = [
  (g: string) => `make me a ${g} beat`,
  (g: string) => `cook up a ${g} beat with drums, bass and a melody`,
  (g: string) => `build a ${g} groove — full beat, write the notes`,
  (g: string) => `I want a ${g} type beat`,
];
type ProgLine = { command: string; args: Record<string, unknown>; capture?: Record<string, string> };

/** Serialize a built recipe to a self-consistent, EXECUTABLE MoshOps run-script (capture vars
 *  + ${var} refs — the shape the engine's --run-script AND recipeFromProgram both resolve).
 *  Emits PRODUCTION commands (real kit + melodic 808) from the palette picks — the melodic 808
 *  is assigned BEFORE the clip (so the engine doesn't double it with 4OSC) and the 808 bass MIDI
 *  is monophonicized so it never overlaps itself. */
function serialize(built: BuiltRecipe): ProgLine[] {
  const prog: ProgLine[] = [{ command: "set_tempo", args: { bpm: built.tempo } }];
  let v = 0;
  for (const t of built.tracks) {
    if (!t.notes.length) continue;
    const tv = `v${v++}`;
    const type = t.role === "drums" ? "drum" : "audio";
    prog.push({ command: "create_track", args: { name: t.name, type }, capture: { [tv]: "trackId" } });
    const gainDb = t.role === "drums" ? -3 : t.role === "bass" ? -5 : -9;   // gain-staging (no clipping) + mix presence
    prog.push({ command: "set_track_volume", args: { trackId: `\${${tv}}`, db: gainDb } });
    const prod = t.production;
    if (prod?.kind === "drum") for (const p of prod.pads) prog.push({ command: "assign_sample", args: { trackId: `\${${tv}}`, note: p.note, file: p.path, name: p.role } });
    else if (prod?.kind === "melodic808") prog.push({ command: "assign_sample", args: { trackId: `\${${tv}}`, note: prod.note, file: prod.path, name: "808", mode: "melodic" } });
    const len = Math.max(...t.notes.map((n) => n.start + n.length));
    const cv = `v${v++}`;
    prog.push({ command: "add_midi_clip", args: { trackId: `\${${tv}}`, start: 0, length: Math.ceil(len) }, capture: { [cv]: "clipId" } });
    const notes = prod?.kind === "melodic808" ? monophonicize(t.notes) : t.notes;
    for (const n of notes) prog.push({ command: "add_note", args: { clipId: `\${${cv}}`, pitch: n.pitch, start: n.start, length: n.length, velocity: n.velocity } });
  }
  return prog;
}

async function pool<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (true) { const i = next++; if (i >= items.length) break; out[i] = await fn(items[i], i); } }));
  return out;
}

async function main() {
  // system prompt the policy will see at train+infer (empty session — it must CREATE the parts)
  __resetMockForTests();
  await mockExecute<CommandResult>({ command: "new_project", args: {} });
  const system = buildSystemPrompt(await mockSnapshot<Snapshot>());

  const teacherObjs = TEACHERS.map(resolveTeacher);
  const jobs = teacherObjs.flatMap((t) => BEAT_SPECS.flatMap((s) => Array.from({ length: PER }, (_, i) => ({ spec: s, seed: i, teacher: t }))));
  let kept = 0, tried = 0, sumKept = 0;
  // generation is parallel (independent), but each serialize() touches the shared mock → do
  // generation concurrently, then serialize sequentially.
  const builts = await pool(jobs, CONC, async ({ spec, seed, teacher }) => {
    try {
      const r = await buildRecipe(spec, makeBrain(0.7, teacher), { maxRetries: 1, refineTempo: false, extraSystem: OPTIMIZED_DIRECTIVE, palette: PALETTE, productionSeed: seed });
      return { spec, seed, built: r, teacher: teacher.model };
    } catch { return null; }
  });

  const examples: string[] = [];
  const perTeacher: Record<string, number> = {};
  const seen = new Set<string>();  // dedup near-identical beats (diversity is the whole point)
  for (const b of builts) {
    tried++;
    if (!b) continue;
    const prog = serialize(b.built);  // run-script-shaped; includes production commands when --palette
    if (prog.filter((c) => c.command === "add_note").length < 8) continue;  // require real note content
    // score the EMITTED program (production-aware) — keeps real-sound beats, not stock outlines
    const score = verifyRecipe(recipeFromProgram(prog)).total;
    if (score < THR) continue;
    const sig = b.built.tracks.flatMap((t) => t.notes.map((n) => `${n.pitch}:${Math.round(n.start * 4)}:${n.velocity}`)).sort().join(",");
    if (seen.has(sig)) continue;
    seen.add(sig);
    const user = USER_TEMPLATES[(examples.length) % USER_TEMPLATES.length](b.spec.id.replace(/_/g, " "));
    const assistant = JSON.stringify({ intent: "ACK_GOT_IT", commands: prog });
    // keep training lines pure {messages} (mlx_lm schema); teacher mix tracked in the manifest
    examples.push(JSON.stringify({ messages: [{ role: "system", content: system }, { role: "user", content: user }, { role: "assistant", content: assistant }] }));
    perTeacher[b.teacher] = (perTeacher[b.teacher] ?? 0) + 1;
    kept++; sumKept += score;
  }

  // shuffle-free deterministic split 80/10/10
  const n = examples.length, nVal = Math.max(1, Math.floor(n * 0.1)), nTest = Math.max(1, Math.floor(n * 0.1));
  const test = examples.slice(0, nTest), valid = examples.slice(nTest, nTest + nVal), train = examples.slice(nTest + nVal);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "train.jsonl"), train.join("\n") + "\n");
  writeFileSync(join(OUT, "valid.jsonl"), valid.join("\n") + "\n");
  writeFileSync(join(OUT, "test.jsonl"), test.join("\n") + "\n");
  writeFileSync(join(OUT, "manifest.json"), JSON.stringify({ kept, tried, thr: THR, avg_kept_score: kept ? +(sumKept / kept).toFixed(4) : 0, teachers: TEACHERS, per_teacher: perTeacher, dedup_dropped: tried - kept - (tried - builts.filter(Boolean).length), splits: { train: train.length, valid: valid.length, test: test.length } }, null, 1));
  console.log(`distilled ${kept}/${tried} beats (avg verifier ${kept ? (sumKept / kept).toFixed(3) : 0}) from ${TEACHERS.length} teacher(s) → ${OUT}  [train ${train.length} / valid ${valid.length} / test ${test.length}]`);
  console.log(`per-teacher kept: ${JSON.stringify(perTeacher)}`);
}
main();
