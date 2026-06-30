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

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { __resetMockForTests, mockExecute, mockSnapshot } from "../../src/bridge.mock";
import { buildSystemPrompt } from "../../src/agent/brainCore";
import { buildRecipe, type BrainFn } from "../../src/agent/beatBuilder";
import { BEAT_SPECS } from "../../src/agent/beatSpecs";
import { verifyRecipe, type Recipe } from "../../src/agent/recipeVerifier";
import { OPTIMIZED_DIRECTIVE } from "../../src/agent/beatDirective";
import type { Snapshot, CommandResult } from "../../src/types";

const arg = (k: string, d = "") => { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const OUT = arg("out", join(process.cwd(), "..", "service", "sft", ".sft-data", "beat-v0"));
const PER = parseInt(arg("per", "24"), 10);     // attempts per genre
const THR = parseFloat(arg("thr", "0.9"));      // keep beats scoring ≥ this on the verifier
const CONC = parseInt(arg("conc", "5"), 10);

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
const newId = (res: any): string | undefined => res?.data?.trackId ?? res?.trackId ?? res?.data?.clipId ?? res?.clipId ?? res?.data?.id ?? res?.id;

/** Replay a built recipe into a fresh mock, capturing the engine's real ids → a self-consistent,
 *  executable MoshOps program (the SFT assistant target). */
async function serialize(recipe: Recipe): Promise<{ command: string; args: Record<string, unknown> }[]> {
  __resetMockForTests();
  await mockExecute<CommandResult>({ command: "new_project", args: {} });
  await mockExecute<CommandResult>({ command: "set_tempo", args: { bpm: recipe.tempo } });
  const prog: { command: string; args: Record<string, unknown> }[] = [{ command: "set_tempo", args: { bpm: recipe.tempo } }];
  for (const t of recipe.tracks) {
    if (!t.notes.length) continue;
    const tr: any = await mockExecute<CommandResult>({ command: "create_track", args: { name: t.name, type: t.role === "drums" ? "drum" : "instrument" } });
    const tid = newId(tr);
    prog.push({ command: "create_track", args: { name: t.name, type: t.role === "drums" ? "drum" : "instrument" } });
    const len = Math.max(...t.notes.map((n) => n.start + n.length));
    const cl: any = await mockExecute<CommandResult>({ command: "add_midi_clip", args: { trackId: tid, start: 0, length: Math.ceil(len) } });
    const cid = newId(cl);
    prog.push({ command: "add_midi_clip", args: { trackId: tid, start: 0, length: Math.ceil(len) } });
    for (const n of t.notes) {
      await mockExecute<CommandResult>({ command: "add_note", args: { clipId: cid, pitch: n.pitch, start: n.start, length: n.length, velocity: n.velocity } });
      prog.push({ command: "add_note", args: { clipId: cid, pitch: n.pitch, start: n.start, length: n.length, velocity: n.velocity } });
    }
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
      const r = await buildRecipe(spec, makeBrain(0.7, teacher), { maxRetries: 1, refineTempo: false, extraSystem: OPTIMIZED_DIRECTIVE });
      const recipe: Recipe = { tempo: r.tempo, key: r.key, bars: r.bars, tracks: r.tracks };
      return { spec, seed, recipe, score: verifyRecipe(recipe).total, teacher: teacher.model };
    } catch { return null; }
  });

  const examples: string[] = [];
  const perTeacher: Record<string, number> = {};
  const seen = new Set<string>();  // dedup near-identical beats (diversity is the whole point)
  for (const b of builts) {
    tried++;
    if (!b || b.score < THR) continue;
    const prog = await serialize(b.recipe);
    if (prog.filter((c) => c.command === "add_note").length < 8) continue;  // require real note content
    const sig = b.recipe.tracks.flatMap((t) => t.notes.map((n) => `${n.pitch}:${Math.round(n.start * 4)}:${n.velocity}`)).sort().join(",");
    if (seen.has(sig)) continue;
    seen.add(sig);
    const user = USER_TEMPLATES[(examples.length) % USER_TEMPLATES.length](b.spec.id.replace(/_/g, " "));
    const assistant = JSON.stringify({ intent: "ACK_GOT_IT", commands: prog });
    // keep training lines pure {messages} (mlx_lm schema); teacher mix tracked in the manifest
    examples.push(JSON.stringify({ messages: [{ role: "system", content: system }, { role: "user", content: user }, { role: "assistant", content: assistant }] }));
    perTeacher[b.teacher] = (perTeacher[b.teacher] ?? 0) + 1;
    kept++; sumKept += b.score;
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
