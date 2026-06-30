// ── Prove the RL gradient is restored by the beat-build fix ───────────────────
// The delta-reward smoke (memory line-152) found the OLD free-form policy produced a
// FLAT-ZERO reward field — rollouts were no-ops / empty skeletons / deferrals → every
// reward ≈ 0 → GRPO advantage (reward − group_mean) ≈ 0 → NO GRADIENT. That was the
// policy/audio blocker, independent of whether the reward is valid.
//
// This harness shows the fix removes that blocker: for ONE prompt it generates K
// rollouts TWO ways — (A) the OLD free-form single reply (persona prompt → parseReply →
// commands), and (B) the NEW beat-build slot protocol (decomposed + validated + forced) —
// drives BOTH through the same mock (id-remap) into native run-script programs, scores
// every rollout with the SAME composite reward the RL loop uses (score_audio_cli.py
// --reward musical), and reports each method's reward DISTRIBUTION. The claim is proven
// if beat-build's rewards have real variance (std > 0, non-deferred) where free-form's
// collapse to the flat-zero field. (This proves the gradient EXISTS; it does NOT claim
// the composite reward is a VALID taste target — that's the separate, still-open blocker.)
//
//   AUDITION_CLOUD=1 npm run tsx scripts/proveGradient.mts -- --spec dark_trap --k 6
//
// RESULT (2026-06-29, dark_trap, k=6, Gemini-2.5-flash, composite reward):
//   FREE-FORM   composite std 0.0000 (4/6 deferred + 2/6 render-fail on invented ids) — the flat-zero field.
//   BEAT-BUILD  composite mean 0.5135 std 0.0121 [0.496–0.530]; pull mean 0.563 std 0.030 [0.518–0.603].
//   → beat-build std > 0 ⇒ non-zero GRPO advantages ⇒ THE GRADIENT IS RESTORED (the policy/audio blocker is gone).
// ⚠ CROSS-BRANCH: the composite reward lives in the sleepy-euler teardown (grpo_bridge.make_reward +
//   composite_reward.pt); funny-mendel's score_audio_cli falls back to floor-only and its older Oracle
//   can't resolve ${VAR} captures. The numbers above came from re-scoring batch.jsonl via the sleepy-euler
//   probe path (probe_score.render_and_score). Merge both branches to score in one place.
// ⚠ This proves the gradient EXISTS, not that it's USEFUL: pq was constant (7.21) and clean constant (0.8),
//   so ALL the variance is `pull` — and the probe showed pull doesn't track the owner's taste. Reward = next gate.

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { __resetMockForTests, mockExecute, mockSnapshot } from "../src/bridge.mock";
import { buildBeat, type BeatSink, type BrainFn, type AgentCommandCall } from "../src/agent/beatBuilder";
import { beatSpecById } from "../src/agent/beatSpecs";
import { systemPrompt, parseReply } from "../src/agent/brainCore";
import type { CommandResult, Snapshot } from "../src/types";

type Line = { command: string; args: Record<string, unknown>; capture?: Record<string, string> };

const arg = (k: string, d = "") => { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SPEC = arg("spec", "dark_trap");
const K = parseInt(arg("k", "6"), 10) || 6;
const OUT = arg("out", "/private/tmp/claude-501/mosh-gradient");
const CLOUD = process.argv.includes("--cloud") || process.env.AUDITION_CLOUD === "1";
const PORT = process.env.AUDITION_PORT ?? "8081";
const GKEY = process.env.GEMINI_API_KEY ?? "";
const CLOUD_MODEL = process.env.MOSH_AGENT_MODEL ?? "gemini-2.5-flash";
const ENDPOINT = CLOUD ? "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions" : `http://127.0.0.1:${PORT}/v1/chat/completions`;
const REPO = resolve(process.cwd(), "..");
const SERVICE = join(REPO, "service");
const TEARDOWN_PY = process.env.TEARDOWN_PY ?? (() => {
  const m = existsSync(join(SERVICE, "teardown", ".teardown.env")) && readFileSync(join(SERVICE, "teardown", ".teardown.env"), "utf8").match(/TEARDOWN_PY="?([^"\n]+)"?/);
  return m ? m[1] : "python3";
})();

// temperature 1.0 → diverse rollouts (we WANT spread; that's the gradient)
const brain: BrainFn = async (messages, opts) => {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const body: Record<string, unknown> = { messages, max_tokens: 2048, temperature: 1.0 };
  if (CLOUD) {
    headers["Authorization"] = `Bearer ${GKEY}`;
    body.model = CLOUD_MODEL;
    body.extra_body = { google: { thinking_config: { thinking_budget: 0 } } };
    if (opts.json) body.response_format = { type: "json_object" };
  }
  const r = await fetch(ENDPOINT, { method: "POST", headers, body: JSON.stringify(body) });
  const j = await r.json();
  return j.choices?.[0]?.message?.content ?? "";
};

const isIdKey = (k: string) => /id$/i.test(k);
const CREATES = new Set(["create_track", "add_midi_clip", "import_clip", "add_test_tone_clip", "duplicate_clip", "split_clip"]);

class RecordingSink implements BeatSink {
  lines: Line[] = [];
  private idToVar = new Map<string, string>();
  private counter = 0;
  async execute(call: AgentCommandCall) {
    const raw = { command: call.command, args: (call.args ?? {}) as Record<string, unknown> };
    let res: any = null;
    try { res = await mockExecute<CommandResult>(raw); } catch { res = { ok: false }; }
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw.args)) args[k] = isIdKey(k) && typeof v === "string" && this.idToVar.has(v) ? `\${${this.idToVar.get(v)}}` : v;
    const line: Line = { command: raw.command, args };
    const newId = res?.ok ? (res?.trackId ?? res?.clipId ?? res?.data?.trackId ?? res?.data?.clipId ?? res?.id) : undefined;
    if (newId != null && CREATES.has(raw.command)) {
      const v = `v${this.counter++}`;
      this.idToVar.set(String(newId), v);
      line.capture = { [v]: raw.command === "create_track" ? "trackId" : "clipId" };
    }
    this.lines.push(line);
    return { ok: !!res?.ok, id: newId != null ? String(newId) : undefined, error: res?.error };
  }
}

const EXPORT = (wav: string): Line => ({ command: "export_audio", args: { file: wav, format: "wav", bitDepth: 16 } });

// (A) OLD free-form: one persona-prompted reply for the whole beat → mock+remap → program.
async function freeformRollout(genre: string, wav: string): Promise<{ program: Line[]; deferred: boolean; nCmds: number }> {
  __resetMockForTests();
  await mockExecute<CommandResult>({ command: "new_project", args: {} });
  const snap = await mockSnapshot<Snapshot>();
  const utt = `Make a ${genre} beat: a drum track with kick, snare and hi-hats, an 808 bassline, and a dark lead melody. Set the tempo and WRITE THE ACTUAL NOTES into each clip.`;
  const content = await brain([{ role: "system", content: systemPrompt(snap) }, { role: "user", content: utt }], { json: false });
  const cmds = parseReply(content).commands ?? [];
  if (cmds.length === 0) return { program: [], deferred: true, nCmds: 0 };
  const sink = new RecordingSink();
  for (const c of cmds) await sink.execute({ command: c.command, args: c.args ?? {} });
  return { program: [...sink.lines, EXPORT(wav)], deferred: false, nCmds: cmds.length };
}

// (B) NEW beat-build: decomposed + validated + forced slot-filling → program.
async function beatbuildRollout(specId: string, wav: string): Promise<{ program: Line[]; deferred: boolean; modelSlots: number; notes: number }> {
  const spec = beatSpecById(specId)!;
  __resetMockForTests();
  await mockExecute<CommandResult>({ command: "new_project", args: {} });
  const sink = new RecordingSink();
  const b = await buildBeat(spec, brain, sink, { maxRetries: 2, refineTempo: true });
  return { program: [...sink.lines, EXPORT(wav)], deferred: false, modelSlots: b.modelSlots, notes: b.totalNotes };
}

function scoreBatch(batch: { sampleId: string; program: Line[]; wav: string }[], work: string): Map<string, { reward: number; deferred: boolean; feedback: string }> {
  const batchPath = join(work, "batch.jsonl");
  const outPath = join(work, "rewards.jsonl");
  writeFileSync(batchPath, batch.map((b) => JSON.stringify(b)).join("\n") + "\n");
  execFileSync(TEARDOWN_PY, [join(SERVICE, "rl", "score_audio_cli.py"), "--batch", batchPath, "--out", outPath, "--reward", "musical", "--cache", join(work, "cache.json"), "--range-s", "10"],
    { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, PYTHONPATH: SERVICE } });
  const m = new Map<string, { reward: number; deferred: boolean; feedback: string }>();
  for (const l of readFileSync(outPath, "utf8").split("\n")) { const s = l.trim(); if (!s) continue; const r = JSON.parse(s); m.set(r.sampleId, r); }
  return m;
}

function stats(xs: number[]) {
  if (!xs.length) return { n: 0, min: 0, max: 0, mean: 0, std: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const std = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return { n: xs.length, min: Math.min(...xs), max: Math.max(...xs), mean, std };
}

async function main() {
  const work = join(OUT, SPEC);
  mkdirSync(work, { recursive: true });
  console.log(`prove-gradient: spec=${SPEC} k=${K} model=${CLOUD ? CLOUD_MODEL : `local:${PORT}`} reward=musical(composite)\n`);
  const genre = beatSpecById(SPEC)!.genre;

  const batch: { sampleId: string; program: Line[]; wav: string; deferred?: boolean }[] = [];
  const meta: Record<string, any> = {};
  for (let i = 0; i < K; i++) {
    const wav = join(work, `ff-${i}.wav`);
    try { const r = await freeformRollout(genre, wav); meta[`ff-${i}`] = { nCmds: r.nCmds, deferred: r.deferred }; if (!r.deferred) batch.push({ sampleId: `ff-${i}`, program: r.program, wav }); else batch.push({ sampleId: `ff-${i}`, program: [], wav, deferred: true }); }
    catch (e) { meta[`ff-${i}`] = { error: (e as Error).message }; batch.push({ sampleId: `ff-${i}`, program: [], wav, deferred: true }); }
    process.stdout.write(`  freeform ${i + 1}/${K}: ${meta[`ff-${i}`].deferred ? "DEFERRED" : meta[`ff-${i}`].nCmds + " cmds"}\n`);
  }
  for (let i = 0; i < K; i++) {
    const wav = join(work, `bb-${i}.wav`);
    const r = await beatbuildRollout(SPEC, wav);
    meta[`bb-${i}`] = { modelSlots: r.modelSlots, notes: r.notes };
    batch.push({ sampleId: `bb-${i}`, program: r.program, wav });
    process.stdout.write(`  beatbuild ${i + 1}/${K}: ${r.modelSlots}/5 model-slots, ${r.notes} notes\n`);
  }

  // score everything that isn't a known deferral (deferrals = reward 0, no render)
  const renderable = batch.filter((b) => !b.deferred);
  console.log(`\nscoring ${renderable.length} renderable rollouts with the composite reward…`);
  const scored = scoreBatch(renderable.map(({ sampleId, program, wav }) => ({ sampleId, program, wav })), work);
  for (const b of batch) if (b.deferred && !scored.has(b.sampleId)) scored.set(b.sampleId, { reward: 0, deferred: true, feedback: "deferred (no commands)" });

  const ff = Array.from({ length: K }, (_, i) => scored.get(`ff-${i}`)!).filter(Boolean);
  const bb = Array.from({ length: K }, (_, i) => scored.get(`bb-${i}`)!).filter(Boolean);
  const ffR = stats(ff.map((r) => r.reward));
  const bbR = stats(bb.map((r) => r.reward));
  const fmt = (s: ReturnType<typeof stats>) => `n=${s.n} mean=${s.mean.toFixed(4)} std=${s.std.toFixed(4)} min=${s.min.toFixed(4)} max=${s.max.toFixed(4)}`;
  console.log(`\n── REWARD DISTRIBUTION (composite/musical) ──`);
  console.log(`FREE-FORM (old policy shape): ${fmt(ffR)}  deferred=${ff.filter((r) => r.deferred).length}/${ff.length}`);
  console.log(`  rewards: [${ff.map((r) => r.reward.toFixed(3)).join(", ")}]`);
  console.log(`BEAT-BUILD (decomposed+forced): ${fmt(bbR)}  deferred=${bb.filter((r) => r.deferred).length}/${bb.length}`);
  console.log(`  rewards: [${bb.map((r) => r.reward.toFixed(3)).join(", ")}]`);
  const gradient = bbR.std > 1e-4 && bbR.n >= 2;
  console.log(`\nGRPO gradient (needs reward variance within a group): beat-build std=${bbR.std.toFixed(4)} → ${gradient ? "✅ NON-ZERO advantages — gradient flows" : "❌ flat — no gradient"}`);
  console.log(`(free-form std=${ffR.std.toFixed(4)}; the old flat-zero field is what blocked the loop)`);
  writeFileSync(join(work, "summary.json"), JSON.stringify({ spec: SPEC, k: K, freeform: { ...ffR, rewards: ff.map((r) => r.reward), deferred: ff.filter((r) => r.deferred).length }, beatbuild: { ...bbR, rewards: bb.map((r) => r.reward) }, meta }, null, 1));
  console.log(`\n→ ${work}/summary.json`);
}

main();
