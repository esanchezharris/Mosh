// The production arena. Runs ONE brief through the full spectrum of strategies
// (strategies.ts), each as an autonomous agent driving the REAL engine over the
// `Mosh --agent-server` stdin seam — plan commands → execute on the real DAW →
// iterate → export a WAV → score it. Writes a ranked scorecard + listening index.
//
//   npm run arena                         # FakeAdapter (stage 1: plumbing + the agentic rung is real)
//   ARENA_REAL_SA3=1 SA3_MLX_DIR=... npm run arena   # stage 2: real generative audio
//   ARENA_BRIEF="..." ARENA_BPM=90 ARENA_KEY="C minor" ARENA_PROVIDER=xai npm run arena
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { loadEnvFiles, resolveProvider, callLLM, type Provider } from "./llm.mts";
import { scoreWavs, type WavScore } from "./audioScore.mts";
import { RUNGS, buildSystemPrompt, type Rung } from "../src/agent/strategies";
import { validateCommand, coerceArgs } from "../src/agent/commands";

const UI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(UI_ROOT, "..");
const BIN = resolve(REPO, "build/Mosh_artefacts/Release/Mosh.app/Contents/MacOS/Mosh");
const OUT_DIR = resolve(REPO, "eval/arena");

loadEnvFiles(UI_ROOT);

const BRIEF = process.env.ARENA_BRIEF || "lo-fi hip-hop beat, dusty boom-bap drums, warm Rhodes chords, mellow sub bass";
const BPM = Number(process.env.ARENA_BPM || 85);
const KEY = process.env.ARENA_KEY || "A minor";
const MAX_STEPS = Number(process.env.ARENA_MAX_STEPS || 12);
const REAL_SA3 = process.env.ARENA_REAL_SA3 === "1";
const SAMPLES_DIR = process.env.MOSH_SAMPLES_DIR || `${homedir()}/Music/MonsterSamples`;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

type Plan = { commands: { command: string; args?: Record<string, unknown> }[]; done?: boolean; note?: string };

function parsePlan(content: string): Plan {
  let s = String(content || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try {
    const o = JSON.parse(s) as Plan;
    return {
      commands: Array.isArray(o.commands) ? o.commands.filter((c) => c && typeof c.command === "string") : [],
      done: !!o.done,
      note: typeof o.note === "string" ? o.note : undefined,
    };
  } catch { return { commands: [] }; }
}

function compactSnap(snap: any): string {
  const tracks = (snap?.tracks || []).map((t: any) => {
    const clips = (t.clips || []).map((c: any) => `${c.type || "clip"}@${c.start}s`).join(",");
    const plugs = (t.plugins || []).map((p: any) => p.name).join(",");
    return `  ${t.id} "${t.name}" ${t.volumeDb ?? 0}dB clips[${clips}]${plugs ? ` fx[${plugs}]` : ""}`;
  }).join("\n");
  return `tempo ${snap?.session?.tempo ?? BPM}\n${tracks || "  (empty session)"}`;
}

// One synchronous request/response per line over the agent-server's stdio.
class Engine {
  private proc: ChildProcessWithoutNullStreams;
  private buf = "";
  private waiters: ((v: any) => void)[] = [];
  dead = false;

  constructor(env: Record<string, string>) {
    this.proc = spawn(BIN, ["--agent-server"], { env: { ...process.env, ...env } });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        const m = line.indexOf("@@MOSH@@");
        if (m < 0) continue;
        let parsed: any;
        try { parsed = JSON.parse(line.slice(m + 8)); } catch { continue; }
        this.waiters.shift()?.(parsed);
      }
    });
    this.proc.on("exit", () => { this.dead = true; while (this.waiters.length) this.waiters.shift()?.({ ok: false, error: "engine exited" }); });
  }

  send(obj: any, timeoutMs = 300_000): Promise<any> {
    if (this.dead) return Promise.resolve({ ok: false, error: "engine dead" });
    return new Promise((res) => {
      const t = setTimeout(() => { this.dead = true; res({ ok: false, error: "timeout" }); try { this.proc.kill(); } catch { /* */ } }, timeoutMs);
      this.waiters.push((v) => { clearTimeout(t); res(v); });
      try { this.proc.stdin.write(JSON.stringify(obj) + "\n"); } catch { clearTimeout(t); res({ ok: false, error: "write failed" }); }
    });
  }
  exec(command: string, args: Record<string, unknown>) { return this.send({ command, args }); }
  snapshot() { return this.send({ op: "snapshot" }); }
  close() { try { this.proc.stdin.write('{"op":"quit"}\n'); } catch { /* */ } setTimeout(() => { try { this.proc.kill(); } catch { /* */ } }, 500); }
}

type RunResult = { rung: Rung; wav: string | null; cmdsOk: number; cmdsTotal: number; gaps: string[]; transcript: any[]; note?: string };

async function runRung(rung: Rung, provider: Provider): Promise<RunResult> {
  const briefDir = resolve(OUT_DIR, slug(BRIEF));
  mkdirSync(briefDir, { recursive: true });
  const wav = resolve(briefDir, `${rung.id}.wav`);

  const env: Record<string, string> = { MOSH_NO_AUDIO: "1", MOSH_SAMPLES_DIR: SAMPLES_DIR };
  if (rung.usesSA3) {
    env.MOSH_ENABLE_SA3 = REAL_SA3 ? "1" : "0";
    if (REAL_SA3 && process.env.SA3_MLX_DIR) env.SA3_MLX_DIR = process.env.SA3_MLX_DIR;
    if (REAL_SA3 && process.env.MOSH_JUDGES_PY) env.MOSH_JUDGES_PY = process.env.MOSH_JUDGES_PY;
  }
  const eng = new Engine(env);
  const transcript: any[] = [];
  const gaps: string[] = [];
  let cmdsOk = 0, cmdsTotal = 0, note: string | undefined;

  try {
    const bi = await eng.exec("list_builtins", {});
    const pl = await eng.exec("list_plugins", {});
    const builtins = ((bi?.data?.plugins) || (bi?.data?.builtins) || []).map((b: any) => b.type || b.id || b.name).filter(Boolean);
    const plugins = (pl?.data?.plugins || []).map((p: any) => p.name).filter(Boolean);
    const sys = buildSystemPrompt(rung, { builtins, plugins, bpm: BPM, key: KEY });
    const messages = [{ role: "system", content: sys }, { role: "user", content: `Brief: ${BRIEF}\nBuild it now, step by step.` }];

    for (let step = 0; step < MAX_STEPS && !eng.dead; step++) {
      const plan = parsePlan(await callLLM(provider, messages));
      note = plan.note ?? note;
      messages.push({ role: "assistant", content: JSON.stringify(plan) });
      const results: string[] = [];
      for (const c of plan.commands) {
        const args = coerceArgs(c.command, c.args ?? {});
        const err = validateCommand(c.command, args);
        if (err) { gaps.push(`${c.command}: ${err}`); results.push(`${c.command}: REJECTED (${err})`); continue; }
        cmdsTotal++;
        const res = await eng.exec(c.command, args);
        if (res?.ok) cmdsOk++;
        else if (/no such|unknown|not allowed|missing|unsupported/i.test(String(res?.error || ""))) gaps.push(`${c.command}: ${res?.error}`);
        transcript.push({ command: c.command, args, ok: !!res?.ok, error: res?.error });
        results.push(`${c.command}: ${res?.ok ? "ok" : "FAIL " + (res?.error || "")}`);
      }
      const snap = await eng.snapshot();
      messages.push({ role: "user", content: `Results:\n${results.join("\n") || "(no commands)"}\n\nSession now:\n${compactSnap(snap)}\n\nContinue, or reply {"commands":[],"done":true} when the brief is realised and mixed.` });
      if (plan.done || plan.commands.length === 0) break;
    }

    const ex = await eng.exec("export_audio", { file: wav, format: "wav" });
    if (!ex?.ok) transcript.push({ command: "export_audio", ok: false, error: ex?.error });
  } finally { eng.close(); }

  return { rung, wav: existsSync(wav) ? wav : null, cmdsOk, cmdsTotal, gaps, transcript, note };
}

function report(runs: RunResult[], scores: Map<string, WavScore>, stamp: string): string {
  const L: string[] = [];
  L.push(`# Production arena — ${stamp}`);
  L.push("");
  L.push(`**Brief:** ${BRIEF}  ·  ${BPM} BPM · ${KEY}  ·  generative: **${REAL_SA3 ? "real SA3" : "FakeAdapter"}**`);
  L.push("");
  L.push("| rung | approach | wav | cmds ok | hygiene | perceptual | verdict | flags |");
  L.push("|------|----------|-----|---------|---------|------------|---------|-------|");
  for (const r of runs) {
    const s = r.wav ? scores.get(r.wav) : undefined;
    const kb = r.wav ? `${Math.round(statSize(r.wav) / 1024)}KB` : "—";
    L.push(`| \`${r.rung.id}\` | ${r.rung.label} | ${kb} | ${r.cmdsOk}/${r.cmdsTotal} | ${s?.pq_hygiene ?? "—"} | ${s?.pq_perceptual?.toFixed?.(2) ?? "—"} | ${s?.verdict ?? (r.wav ? "?" : "no-wav")} | ${(s?.flags || []).slice(0, 2).join("; ")} |`);
  }
  L.push("");
  L.push("## Listening index");
  L.push("");
  for (const r of runs) L.push(`- **${r.rung.label}** — ${r.wav ? `\`${r.wav}\`` : "_(no audio produced)_"}${r.note ? ` — _"${r.note}"_` : ""}`);
  L.push("");

  const allGaps = [...new Set(runs.flatMap((r) => r.gaps))];
  L.push("## DAW gaps the agent hit (commands it wanted but couldn't run)");
  L.push("");
  L.push(allGaps.length ? allGaps.map((g) => `- ${g}`).join("\n") : "_None — the agent stayed within the catalog._");
  L.push("");

  L.push("## Per-rung command transcripts");
  for (const r of runs) {
    L.push("");
    L.push(`### ${r.rung.id}`);
    for (const t of r.transcript) L.push(`- ${t.ok ? "✓" : "✗"} \`${t.command}\`${t.error ? ` — ${t.error}` : ""}`);
  }
  return L.join("\n");
}

function statSize(p: string): number { try { return statSync(p).size; } catch { return 0; } }

const provider = resolveProvider(process.env.ARENA_PROVIDER);
if (!provider) { console.error("No provider configured — put keys in ui/.env.local."); process.exit(2); }
if (!existsSync(BIN)) { console.error("Mosh binary not built:", BIN); process.exit(2); }

console.error(`Arena · brief="${BRIEF}" · ${BPM}BPM ${KEY} · model=${provider.id}/${provider.model} · generative=${REAL_SA3 ? "real SA3" : "Fake"}\n`);
const runs: RunResult[] = [];
for (const rung of RUNGS) {
  console.error(`=== ${rung.id} (${rung.label}) ===`);
  const r = await runRung(rung, provider);
  console.error(`  -> ${r.wav ? `${Math.round(statSize(r.wav) / 1024)}KB` : "NO WAV"} · ${r.cmdsOk}/${r.cmdsTotal} cmds ok · gaps:${r.gaps.length}${r.note ? ` · "${r.note}"` : ""}\n`);
  runs.push(r);
}

const wavs = runs.map((r) => r.wav).filter(Boolean) as string[];
console.error(`Scoring ${wavs.length} renders (judge cold-loads once)...`);
const scoreList = scoreWavs(wavs);
const scores = new Map(scoreList.map((s) => [s.file, s]));

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const briefDir = resolve(OUT_DIR, slug(BRIEF));
const md = report(runs, scores, stamp);
writeFileSync(resolve(briefDir, "report.md"), md);
console.log("\n" + md.split("## Per-rung")[0]);
console.error(`\nFull report + WAVs: ${briefDir}`);
