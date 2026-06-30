// ── Audition the structured beat-build loop (Option A) → rendered WAV ─────────
// Drives a real model (cloud Gemini, or a local mlx server) through buildBeat's
// decomposed/validated/forced pipeline (src/agent/beatBuilder.ts), records the
// resulting commands as a native --run-script (with id-remap across the build), renders
// each beat to a WAV, and analyses it for non-silence. Reports HONEST per-beat stats:
// how many slots the model actually filled vs the forced fallback, and whether the
// rendered audio is non-silent. This is the test of whether the agent loop now works.
//
//   cloud:  AUDITION_CLOUD=1 npm run tsx scripts/auditionBeats.mts -- --tag gemini --out ~/mosh-beats
//   local:  AUDITION_PORT=8081 npm run tsx scripts/auditionBeats.mts -- --tag owner-v1
//   floor:  npm run tsx scripts/auditionBeats.mts -- --no-model --tag fallback   (deterministic baseline)

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { __resetMockForTests, mockExecute } from "../src/bridge.mock";
import { buildBeat, type BeatSink, type BrainFn, type AgentCommandCall, type BuildResult } from "../src/agent/beatBuilder";
import { BEAT_SPECS, beatSpecById } from "../src/agent/beatSpecs";
import { OPTIMIZED_DIRECTIVE } from "../src/agent/beatDirective";
import type { CommandResult } from "../src/types";

type Line = { command: string; args: Record<string, unknown>; capture?: Record<string, string> };

const arg = (k: string, d = "") => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const has = (k: string) => process.argv.includes(`--${k}`);

const TAG = arg("tag", "model");
const OUT = arg("out", join(process.env.HOME!, "mosh-beats"));
const PORT = process.env.AUDITION_PORT ?? "8081";
const MOSH_BIN = process.env.MOSH_BIN ?? "/Applications/Mosh.app/Contents/MacOS/Mosh";
const CLOUD = has("cloud") || process.env.AUDITION_CLOUD === "1";
const NO_MODEL = has("no-model"); // skip the brain entirely → pure deterministic fallback floor
const REFINE_TEMPO = !has("no-refine-tempo");
const DIRECTIVE = has("optimized") ? OPTIMIZED_DIRECTIVE : ""; // --optimized appends the GEPA-evolved directive
const MAX_RETRIES = parseInt(arg("retries", "2"), 10);
const GKEY = process.env.GEMINI_API_KEY ?? "";
const CLOUD_MODEL = process.env.MOSH_AGENT_MODEL ?? "gemini-2.5-flash";
const ENDPOINT = CLOUD
  ? "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
  : `http://127.0.0.1:${PORT}/v1/chat/completions`;
const SPEC_IDS = (arg("specs", "") || BEAT_SPECS.map((s) => s.id).join(",")).split(",").map((s) => s.trim()).filter(Boolean);

const isIdKey = (k: string) => /id$/i.test(k);
const CREATES = new Set(["create_track", "add_midi_clip", "import_clip", "add_test_tone_clip", "duplicate_clip", "split_clip"]);

// ── brain ─────────────────────────────────────────────────────────────────────

const brain: BrainFn = async (messages, opts) => {
  if (NO_MODEL) throw new Error("no-model"); // forces the fallback path in beatBuilder
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // max_tokens headroom matters: Gemini 2.5 Flash is a THINKING model and its reasoning
  // tokens count toward the budget — 900 truncated the JSON mid-array (finish_reason
  // "length") → unparseable → needless fallback. We also DISABLE thinking outright
  // (thinking_budget 0) so the whole budget goes to the JSON: reliable, cheap, fast.
  const body: Record<string, unknown> = { messages, max_tokens: 2048, temperature: 0.8 };
  if (CLOUD) {
    headers["Authorization"] = `Bearer ${GKEY}`;
    body.model = CLOUD_MODEL; // cloud requires a model field; local mlx 404s on one
    body.extra_body = { google: { thinking_config: { thinking_budget: 0 } } }; // no thinking → no truncation
    if (opts.json) body.response_format = { type: "json_object" }; // structured output at the source
  }
  const r = await fetch(ENDPOINT, { method: "POST", headers, body: JSON.stringify(body) });
  if (!r.ok) {
    // response_format unsupported on this backend? retry once without it (extractJson still saves us)
    if (opts.json && CLOUD) {
      delete body.response_format;
      const r2 = await fetch(ENDPOINT, { method: "POST", headers, body: JSON.stringify(body) });
      const j2 = await r2.json();
      return j2.choices?.[0]?.message?.content ?? "";
    }
    throw new Error(`brain HTTP ${r.status}`);
  }
  const j = await r.json();
  return j.choices?.[0]?.message?.content ?? "";
};

// ── recording sink: mock-execute (for ids) + emit a native run-script line ────

class RecordingSink implements BeatSink {
  lines: Line[] = [];
  private idToVar = new Map<string, string>();
  private counter = 0;
  async execute(call: AgentCommandCall) {
    const raw = { command: call.command, args: (call.args ?? {}) as Record<string, unknown> };
    let res: any = null;
    try { res = await mockExecute<CommandResult>(raw); } catch { res = { ok: false }; }
    // remap id-valued args that point at an entity we created → ${var}
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw.args)) {
      args[k] = isIdKey(k) && typeof v === "string" && this.idToVar.has(v) ? `\${${this.idToVar.get(v)}}` : v;
    }
    const line: Line = { command: raw.command, args };
    // mockExecute returns the FLATTENED envelope (ok(cmd,{trackId}) → {ok,command,trackId})
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

// ── WAV analysis (non-silence) — stdlib, supports PCM16/24 + float32 ──────────

function analyzeWav(path: string): { ok: boolean; peak: number; rms: number; seconds: number; reason?: string } {
  let buf: Buffer;
  try { buf = readFileSync(path); } catch (e) { return { ok: false, peak: 0, rms: 0, seconds: 0, reason: `no file: ${(e as Error).message}` }; }
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") return { ok: false, peak: 0, rms: 0, seconds: 0, reason: "not a RIFF/WAV" };
  let fmt = 1, ch = 2, bits = 16, rate = 44100, dataOff = -1, dataLen = 0;
  let p = 12;
  while (p + 8 <= buf.length) {
    const id = buf.toString("ascii", p, p + 4);
    const sz = buf.readUInt32LE(p + 4);
    if (id === "fmt ") { fmt = buf.readUInt16LE(p + 8); ch = buf.readUInt16LE(p + 10); rate = buf.readUInt32LE(p + 12); bits = buf.readUInt16LE(p + 22); }
    else if (id === "data") { dataOff = p + 8; dataLen = Math.min(sz, buf.length - dataOff); break; }
    p += 8 + sz + (sz & 1);
  }
  if (dataOff < 0) return { ok: false, peak: 0, rms: 0, seconds: 0, reason: "no data chunk" };
  const bytesPer = bits / 8;
  const n = Math.floor(dataLen / bytesPer);
  let peak = 0, sumsq = 0;
  for (let i = 0; i < n; i++) {
    const off = dataOff + i * bytesPer;
    let s = 0;
    if (fmt === 3 && bits === 32) s = buf.readFloatLE(off);
    else if (bits === 16) s = buf.readInt16LE(off) / 32768;
    else if (bits === 24) { let v = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16); if (v & 0x800000) v -= 0x1000000; s = v / 8388608; }
    else if (bits === 32) s = buf.readInt32LE(off) / 2147483648;
    const a = Math.abs(s);
    if (a > peak) peak = a;
    sumsq += s * s;
  }
  const rms = n ? Math.sqrt(sumsq / n) : 0;
  const seconds = n / Math.max(1, ch) / Math.max(1, rate);
  return { ok: rms > 1e-4, peak, rms, seconds };
}

// ── render via Mosh --run-script ─────────────────────────────────────────────

function render(lines: Line[], wav: string, session: string): { ok: boolean; err: string } {
  const script = lines
    .map((l) => JSON.stringify(l))
    .concat(JSON.stringify({ command: "export_audio", args: { file: wav, format: "wav", bitDepth: 16 } }))
    .join("\n");
  const sf = wav.replace(/\.wav$/, ".script.jsonl");
  writeFileSync(sf, script + "\n");
  const r = spawnSync(MOSH_BIN, ["--run-script"], {
    env: { ...process.env, MOSH_RUN_SCRIPT: sf, MOSH_SELFTEST_SESSION: session },
    encoding: "utf8", timeout: 180000,
  });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const fail = out.match(/(\d+) failure\(s\)/);
  const ok = r.status === 0 && (!fail || fail[1] === "0");
  return { ok, err: out.slice(-240) };
}

// ── main ───────────────────────────────────────────────────────────────────────

async function main() {
  const dir = join(OUT, TAG);
  mkdirSync(dir, { recursive: true });
  console.log(`mode: ${NO_MODEL ? "NO-MODEL (deterministic fallback floor)" : CLOUD ? `cloud ${CLOUD_MODEL}` : `local :${PORT}`}  retries=${MAX_RETRIES}`);
  const N = parseInt(arg("n", "1"), 10) || 1; // repeats per spec (variety + reliability rate)
  const manifest: any[] = [];
  for (let rep = 0; rep < N; rep++) {
   for (const id of SPEC_IDS) {
    const spec = beatSpecById(id);
    if (!spec) { console.log(`  ?? unknown spec "${id}" — skipping`); continue; }
    const tagId = N > 1 ? `${id}-r${rep + 1}` : id;
    __resetMockForTests();
    await mockExecute<CommandResult>({ command: "new_project", args: {} });
    const sink = new RecordingSink();
    let build: BuildResult;
    try {
      build = await buildBeat(spec, brain, sink, { maxRetries: MAX_RETRIES, refineTempo: REFINE_TEMPO, extraSystem: DIRECTIVE, log: (m) => console.log(`    ${m}`) });
    } catch (e) {
      console.log(`  ${tagId}: build threw ${(e as Error).message}`);
      continue;
    }
    const wav = join(dir, `${tagId}.wav`);
    const r = render(sink.lines, wav, `beat_${TAG}_${tagId}`);
    const a = r.ok ? analyzeWav(wav) : { ok: false, peak: 0, rms: 0, seconds: 0, reason: r.err };
    const verdict = a.ok ? "AUDIBLE" : "SILENT/FAIL";
    console.log(`  ${tagId}: ${build.modelSlots}/${build.totalSlots} slots model-filled, ${build.totalNotes} notes, tempo ${build.tempo}${build.tempoFromModel ? "*" : ""} → render ${r.ok ? "OK" : "FAIL"} → ${verdict} (rms ${a.rms.toFixed(4)}, peak ${a.peak.toFixed(3)}, ${a.seconds.toFixed(1)}s)`);
    if (!r.ok || !a.ok) console.log(`       ${a.reason ?? r.err}`);
    manifest.push({
      spec: id, tagId, genre: spec.genre, wav,
      tempo: build.tempo, tempoFromModel: build.tempoFromModel,
      modelSlots: build.modelSlots, totalSlots: build.totalSlots, modelNotePct: build.modelNotePct,
      totalNotes: build.totalNotes, buildOk: build.ok,
      renderOk: r.ok, audible: a.ok, rms: a.rms, peak: a.peak, seconds: a.seconds,
      steps: build.steps,
    });
   }
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 1));
  const audible = manifest.filter((m) => m.audible).length;
  const modelPct = manifest.length ? manifest.reduce((s, m) => s + m.modelNotePct, 0) / manifest.length : 0;
  console.log(`\n${audible}/${manifest.length} beats AUDIBLE · avg model-filled slots ${(modelPct * 100).toFixed(0)}% → ${dir}`);
}

main();
