// Generative techniques bench — the orchestrator half.
//
// Holds the DAW constant and varies ONLY the SA3 generation technique, so we can hear
// (and score) how much the *generation itself* moves: prompt phrasing (4 styles),
// text-to-audio vs audio-to-audio re-imagine of a REAL loop, ColorRack steering, a
// seed sweep with best-of-N selection, and step count. Renders real 8s SA3 WAVs via
// service/scripts/genbench_render.py (MLX), then scores every WAV in one pass
// (hygiene + Audiobox perceptual + CLAP brief-match) and writes a listening index.
//
// Usage:
//   SA3_MLX_DIR=~/AI/stable-audio-3/optimized/mlx \
//   MOSH_JUDGES_PY=~/AI/judges_venv/bin/python \
//   npm run genbench
//   GENBENCH_ONLY=P2-tag,C-grit npm run genbench        # subset, fast iteration
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { scoreWavs, type WavScore } from "./audioScore.mts";
import { craftPrompt, type Brief } from "../src/agent/promptcraft";

const UI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(UI_ROOT, "..");
const RENDER_PY = resolve(REPO, "service/scripts/genbench_render.py");
const SA3_MLX_DIR = process.env.SA3_MLX_DIR || `${homedir()}/AI/stable-audio-3/optimized/mlx`;
const MLX_PY = `${SA3_MLX_DIR}/.venv/bin/python`;
const OUT_DIR = resolve(REPO, "eval/genbench");
const SRC_DIR = resolve(OUT_DIR, "sources");
const DESKTOP = `${homedir()}/Desktop/mosh-genbench`;

// The brief, structured for promptcraft (mirrors the arena's lo-fi default).
const BRIEF: Brief = {
  genre: "lo-fi hip-hop",
  bpm: 85,
  key: "A minor",
  instruments: ["dusty boom-bap drums", "warm Rhodes chords", "mellow sub bass"],
  mood: ["nostalgic", "mellow", "hazy"],
  production: ["vinyl crackle", "tape saturation", "MPC swing"],
  era: "90s",
  refs: ["J Dilla", "SP-1200", "Madlib"],
};
const BRIEF_TEXT = "lo-fi hip-hop beat, dusty boom-bap drums, warm Rhodes chords, mellow sub bass";
const SEED = 42;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
const briefDir = resolve(OUT_DIR, slug(BRIEF_TEXT));
const wavDir = resolve(briefDir, "wav");

type Tech = {
  id: string;
  group: string;        // for the report: which "knob" this technique exercises
  blurb: string;        // human description of the technique
  prompt: string;
  seed: number;
  method?: "t2a" | "a2a";
  source?: string;      // a2a source WAV (real audio in)
  nl?: number;          // a2a strength
  colors?: { name: string; value: number }[];
  steps?: number;       // non-default step count → its own render process
};

// The tag style is our prompt baseline for the non-prompt knobs (a2a / colour / seed / steps),
// so any movement there is attributable to the knob, not the phrasing.
const P_TAG = craftPrompt(BRIEF, "tag");

const TECHS: Tech[] = [
  // ── knob 1: PROMPT ENGINEERING — same seed, four phrasings of the same brief ──
  { id: "P0-terse", group: "prompt", blurb: "Terse control prompt (what the agent writes off-the-cuff)", prompt: craftPrompt(BRIEF, "terse"), seed: SEED },
  { id: "P1-descriptive", group: "prompt", blurb: "Flowing natural-language description", prompt: craftPrompt(BRIEF, "descriptive"), seed: SEED },
  { id: "P2-tag", group: "prompt", blurb: "Stable-Audio metadata/tag style (comma descriptors + BPM/key)", prompt: P_TAG, seed: SEED },
  { id: "P3-reference", group: "prompt", blurb: "Era + gear/artist reference style", prompt: craftPrompt(BRIEF, "reference"), seed: SEED },

  // ── knob 2: AUDIO→AUDIO — start from REAL audio (a loop), not noise/sine ──
  { id: "A2A-melody", group: "audio2audio", blurb: "Re-imagine a real 85 BPM soul melody loop (nl 0.4)", prompt: P_TAG, seed: SEED, method: "a2a", source: resolve(SRC_DIR, "src_melody_85_amin.wav"), nl: 0.4 },
  { id: "A2A-drums", group: "audio2audio", blurb: "Re-imagine a real neo-soul drum loop (nl 0.35)", prompt: P_TAG, seed: SEED, method: "a2a", source: resolve(SRC_DIR, "src_drums_neosoul_87.wav"), nl: 0.35 },

  // ── knob 3: COLORRACK STEERING — push timbre with validated steering vectors ──
  { id: "C-grit", group: "color", blurb: "Tag prompt + grit steering (dusty/saturated)", prompt: P_TAG, seed: SEED, colors: [{ name: "grit", value: 82 }] },
  { id: "C-air", group: "color", blurb: "Tag prompt + air steering (ASTD-capped at 0.08)", prompt: P_TAG, seed: SEED, colors: [{ name: "air", value: 85 }] },

  // ── knob 4: SEED SWEEP — same prompt, 4 seeds; best-of-N by brief-match ──
  ...[7, 101, 256, 512].map((s) => ({ id: `BoN-s${s}`, group: "seed", blurb: `Tag prompt, seed ${s} (best-of-N candidate)`, prompt: P_TAG, seed: s })),

  // ── knob 5: STEP COUNT — quality/time tradeoff (16 vs the default 8) ──
  { id: "HiSteps-16", group: "steps", blurb: "Tag prompt at 16 sampling steps (vs 8)", prompt: P_TAG, seed: SEED, steps: 16 },
];

type RenderResult = { id: string; out: string; ok: boolean; manifest?: any; error?: string };

function runRender(specPath: string, extraEnv: Record<string, string>): Promise<RenderResult[]> {
  return new Promise((resolveP, reject) => {
    const env = { ...process.env, MOSH_SA3_QA: "0", SA3_MLX_DIR, ...extraEnv } as NodeJS.ProcessEnv;
    const proc = spawn(MLX_PY, [RENDER_PY, specPath], { env });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => process.stderr.write(d)); // live @@GB@@ progress
    proc.on("error", reject);
    proc.on("close", (code) => {
      const last = out.trim().split("\n").pop() || "";
      try { resolveP(JSON.parse(last)); }
      catch { reject(new Error(`render exited ${code}; could not parse result: ${out.slice(-400)}`)); }
    });
  });
}

async function main() {
  if (!existsSync(MLX_PY)) {
    console.error(`✗ MLX venv python not found at ${MLX_PY}\n  set SA3_MLX_DIR to your MLX SA3 port.`);
    process.exit(1);
  }
  const only = (process.env.GENBENCH_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
  const techs = only.length ? TECHS.filter((t) => only.includes(t.id)) : TECHS;
  mkdirSync(wavDir, { recursive: true });

  console.error(`\nGenerative bench · brief="${BRIEF_TEXT}" · ${BRIEF.bpm}BPM ${BRIEF.key} · ${techs.length} techniques\n`);

  // Group by step count: each distinct SA3_STEPS needs its own engine load (process).
  const bySteps = new Map<number, Tech[]>();
  for (const t of techs) { const k = t.steps || 8; (bySteps.get(k) || bySteps.set(k, []).get(k)!).push(t); }

  const results: RenderResult[] = [];
  for (const [steps, group] of [...bySteps.entries()].sort((a, b) => a[0] - b[0])) {
    const spec = group.map((t) => ({
      id: t.id, out: resolve(wavDir, `${t.id}.wav`), prompt: t.prompt, seed: t.seed,
      method: t.method || "t2a", source: t.source, nl: t.nl, colors: t.colors || [],
    }));
    const specPath = resolve(briefDir, `_spec_${steps}.json`);
    writeFileSync(specPath, JSON.stringify(spec, null, 2));
    console.error(`→ rendering ${group.length} technique(s) at ${steps} steps…`);
    results.push(...(await runRender(specPath, { SA3_STEPS: String(steps) })));
  }

  // Score every successful render in ONE pass (judges + CLAP load once).
  const okWavs = results.filter((r) => r.ok && existsSync(r.out)).map((r) => r.out);
  const scores = scoreWavs(okWavs, BRIEF_TEXT);
  const byWav = new Map(scores.map((s) => [s.file, s]));

  // Best-of-N: among the seed-sweep renders, pick the highest brief-match (tie → perceptual).
  const bon = results.filter((r) => r.id.startsWith("BoN-")).map((r) => ({ r, s: byWav.get(r.out) }))
    .filter((x) => x.s) as { r: RenderResult; s: WavScore }[];
  const bonWinner = bon.sort((a, b) =>
    (b.s.clap_brief ?? -1) - (a.s.clap_brief ?? -1) || (b.s.pq_perceptual ?? -1) - (a.s.pq_perceptual ?? -1))[0];

  writeReport(techs, results, byWav, bonWinner?.r.id);
  stageForListening(techs, results, byWav, bonWinner?.r.id);
}

function fmt(n: number | null | undefined, d = 2) { return n == null ? "–" : n.toFixed(d); }

function writeReport(techs: Tech[], results: RenderResult[], byWav: Map<string, WavScore>, bonWinnerId?: string) {
  const byId = new Map(results.map((r) => [r.id, r]));
  const L: string[] = [];
  L.push(`# Generative techniques bench`);
  L.push(`\n**Brief:** ${BRIEF_TEXT}  ·  ${BRIEF.bpm} BPM · ${BRIEF.key}  ·  model: **real SA3 (MLX)**  ·  seed ${SEED} unless noted\n`);
  L.push(`Same brief, DAW held constant — only the generation technique changes. Every WAV is peak-normalized to −1 dBFS so loudness isn't a confound (you judge timbre, not level). Higher \`brief-match\` (CLAP) = sounds more like the brief; \`sine\` is the anti-reference (should stay below brief). \`perceptual\` = Audiobox production quality.\n`);
  L.push(`| technique | knob | perceptual | brief-match | sine | flags |`);
  L.push(`|-----------|------|------------|-------------|------|-------|`);
  for (const t of techs) {
    const r = byId.get(t.id); const s = r && r.ok ? byWav.get(r.out) : undefined;
    if (!r?.ok) { L.push(`| \`${t.id}\` | ${t.group} | — | — | — | ⚠️ ${r?.error || "render failed"} |`); continue; }
    const win = t.id === bonWinnerId ? " 🏆" : "";
    const off = s && s.clap_brief != null && s.clap_sine != null && s.clap_sine > s.clap_brief ? " ⚠️sine" : "";
    L.push(`| \`${t.id}\`${win} | ${t.group} | ${fmt(s?.pq_perceptual)} | ${fmt(s?.clap_brief, 3)}${off} | ${fmt(s?.clap_sine, 3)} | ${(s?.flags || []).slice(0, 2).join("; ") || "—"} |`);
  }
  if (bonWinnerId) L.push(`\n🏆 **Best-of-N** (seed sweep): \`${bonWinnerId}\` — highest brief-match of the four seeds.`);

  L.push(`\n## The exact prompts (this is the prompt-engineering surface)\n`);
  for (const t of techs) L.push(`- **${t.id}** _(${t.blurb})_\n  \`${t.prompt}\``);

  L.push(`\n## Listening index\n`);
  L.push(`Staged to \`~/Desktop/mosh-genbench/${slug(BRIEF_TEXT)}/\` for A/B. Sources (the real audio fed to the a2a renders) are in \`eval/genbench/sources/\`.\n`);
  for (const g of ["prompt", "audio2audio", "color", "seed", "steps"]) {
    const ts = techs.filter((t) => t.group === g); if (!ts.length) continue;
    L.push(`- **${g}**: ${ts.map((t) => `\`${t.id}\``).join(", ")}`);
  }

  mkdirSync(briefDir, { recursive: true });
  writeFileSync(resolve(briefDir, "report.md"), L.join("\n") + "\n");
  console.error(`\n${L.join("\n")}\n`);
  console.error(`\n✓ report → eval/genbench/${slug(BRIEF_TEXT)}/report.md`);
}

function stageForListening(techs: Tech[], results: RenderResult[], byWav: Map<string, WavScore>, bonWinnerId?: string) {
  const dst = resolve(DESKTOP, slug(BRIEF_TEXT));
  mkdirSync(dst, { recursive: true });
  const byId = new Map(results.map((r) => [r.id, r]));
  let n = 0;
  for (const r of results) if (r.ok && existsSync(r.out)) { copyFileSync(r.out, resolve(dst, `${r.id}.wav`)); n++; }

  // Copy the REAL source loops the a2a renders started from, so input→output is hearable.
  for (const t of techs) if (t.method === "a2a" && t.source && existsSync(t.source))
    copyFileSync(t.source, resolve(dst, `_SOURCE_for_${t.id}.wav`));

  // A self-documenting README: what each render's GOAL was + provenance (the recurring
  // "I'm not sure what the agent was going for / what the source was" question).
  const R: string[] = [];
  R.push(`GENERATIVE TECHNIQUES BENCH — listening guide`);
  R.push(`Brief: ${BRIEF_TEXT}  (${BRIEF.bpm} BPM, ${BRIEF.key}, real Stable Audio 3)`);
  R.push(`Every file is peak-normalized to -1 dBFS so loudness isn't a confound — judge timbre.`);
  R.push(`"brief-match" = how much it sounds like the brief (CLAP, higher better). All distinct seeds/prompts.\n`);
  for (const g of ["prompt", "audio2audio", "color", "seed", "steps"]) {
    const ts = techs.filter((t) => t.group === g); if (!ts.length) continue;
    R.push(`── ${g.toUpperCase()} ──`);
    for (const t of ts) {
      const s = byId.get(t.id)?.out ? byWav.get(byId.get(t.id)!.out) : undefined;
      const bm = s?.clap_brief != null ? `brief-match ${s.clap_brief.toFixed(3)}` : "";
      const win = t.id === bonWinnerId ? "  [best-of-N winner]" : "";
      R.push(`  ${t.id}.wav — ${t.blurb}${bm ? `  (${bm})` : ""}${win}`);
      if (t.method === "a2a" && t.source)
        R.push(`     ↳ started from REAL audio: _SOURCE_for_${t.id}.wav  (${t.source.split("/").pop()})`);
    }
    R.push("");
  }
  R.push(`The GOAL of this bench: audition how the GENERATION itself sounds across techniques —`);
  R.push(`prompt phrasing, generating outright vs re-imagining a real loop, steering, seeds —`);
  R.push(`so you can pick what to bake into the product. a2a "sounds cool but off-brief" is expected:`);
  R.push(`it follows the SOURCE loop more than the brief (great for "flip this loop", not "realize this brief").`);
  writeFileSync(resolve(dst, "README.txt"), R.join("\n") + "\n");

  console.error(`✓ staged ${n} WAVs + sources + README → ${dst}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
