// The knowledge flywheel. Acquire producer knowledge → execute it in the REAL DAW →
// SCORE the audio → keep only what measurably helps. No ASR/video: the sources are the
// LLM's own producer knowledge (distill) + a self-play variation off a scorecard. Each
// candidate "technique card" is A/B-tested through the product's generate_audio seam
// (agent-server) against the audio scorer (CLAP brief-match + hygiene/PQ); a card EARNS
// "validated" only if it lifts brief-match by ≥margin reproduced over ≥2 render seeds
// without breaking hygiene. Validated cards persist to the KB + bake into the product.
//
//   npm run flywheel                                  # FakeAdapter — proves the loop end-to-end
//   FLYWHEEL_REAL_SA3=1 SA3_MLX_DIR=… MOSH_JUDGES_PY=… MOSH_CLAP_CKPT=… npm run flywheel   # real deltas
//   FLYWHEEL_CARDS=6 FLYWHEEL_PROVIDER=xai FLYWHEEL_BASE_PROMPT="drill beat, 140 BPM" … npm run flywheel
//
// v1 notes: reproducibility is over ≥2 SEEDS of one brief (render stochasticity is the
// real noise, not genre) — run again with a different brief env for a second genre.
// PROMPT cards drive validation (no runtime-id binding needed); RECIPE cards are recorded
// as candidates and feed the capability-gap log (the empirical "capability-first" list).
import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { loadEnvFiles, resolveProvider, callLLM, type Provider } from "./llm.mts";
import { scoreWavs, type WavScore } from "./audioScore.mts";
import { Engine, MOSH_BIN } from "./agentEngine.mts";
import { commandCatalogPrompt, validateCommand } from "../src/agent/commands";
import {
  type TechniqueCard, type CardEvidence, type CardRecipe,
  stableId, judgeAcceptance, deltaConfidence, ACCEPT_MARGIN,
} from "../src/agent/knowledge/card";
import { upsertCards, writeCardsData, loadCards } from "./knowledgeStore.mts";

const UI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(UI_ROOT, "..");
const OUT_DIR = resolve(REPO, "eval/flywheel");
loadEnvFiles(UI_ROOT);

const SA3 = process.env.FLYWHEEL_REAL_SA3 === "1";
const N_CARDS = Number(process.env.FLYWHEEL_CARDS || 4);
const MARGIN = Number(process.env.FLYWHEEL_MARGIN || ACCEPT_MARGIN);
const SELFPLAY = process.env.FLYWHEEL_SELFPLAY !== "0";
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

// The brief: a NAIVE base prompt (so a good card has room to help) + the rich target
// description CLAP scores against (the intended result), tested across 2 render seeds.
type Brief = { id: string; basePrompt: string; briefText: string; bpm: number; key: string; seeds: number[] };
const BRIEF: Brief = {
  id: slug(process.env.FLYWHEEL_BRIEF_ID || "lo-fi-hip-hop"),
  basePrompt: process.env.FLYWHEEL_BASE_PROMPT || "lo-fi hip-hop beat, 85 BPM",
  briefText: process.env.FLYWHEEL_BRIEF_TEXT || "lo-fi hip-hop beat, dusty boom-bap drums, warm Rhodes chords, mellow sub bass, vinyl crackle",
  bpm: Number(process.env.FLYWHEEL_BPM || 85),
  key: process.env.FLYWHEEL_KEY || "A minor",
  seeds: (process.env.FLYWHEEL_SEEDS || "42,7").split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n)),
};

const briefDir = resolve(OUT_DIR, BRIEF.id);
const wavDir = resolve(briefDir, "wav");

function engineEnv(): Record<string, string> {
  const env: Record<string, string> = {
    MOSH_NO_AUDIO: "1",
    MOSH_ENABLE_SA3: SA3 ? "1" : "0",
    // npm runs us with cwd=ui/, so the engine's cwd/service/server.py probe misses —
    // point it at the repo's service explicitly (works for Fake and real SA3 alike).
    MOSH_SERVICE_SCRIPT: resolve(REPO, "service/server.py"),
  };
  if (SA3 && process.env.SA3_MLX_DIR) env.SA3_MLX_DIR = process.env.SA3_MLX_DIR;
  if (SA3 && process.env.MOSH_JUDGES_PY) env.MOSH_JUDGES_PY = process.env.MOSH_JUDGES_PY;
  return env;
}

// ── stage 0: tolerant JSON extraction ─────────────────────────────────────────
function extractJson<T>(content: string): T | null {
  let s = String(content || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try { return JSON.parse(s) as T; } catch { return null; }
}

// Peak-normalize WAVs to −1 dBFS in place before scoring, so loudness isn't a CLAP
// confound (the genbench proved level shifts brief-match) — the A/B compares timbre,
// not gain. Best-effort: needs soundfile+numpy (the judges venv); skipped if absent.
function normalizePeak(wavs: string[]): void {
  const real = wavs.filter((w) => existsSync(w));
  if (!real.length) return;
  const py = process.env.MOSH_JUDGES_PY || `${homedir()}/AI/judges_venv/bin/python`;
  const script =
    "import sys,soundfile as sf,numpy as np\n" +
    "for f in sys.argv[1:]:\n" +
    "    try:\n" +
    "        x,sr=sf.read(f); p=float(np.max(np.abs(x))) if x.size else 0.0\n" +
    "        if p>1e-6: sf.write(f, x*(10**(-1/20)/p), sr)\n" +
    "    except Exception as e: print('norm-skip',f,e,file=sys.stderr)\n";
  try { spawnSync(py, ["-c", script, ...real], { stdio: "ignore", timeout: 120_000 }); } catch { /* best-effort */ }
}

// ── render through the product seam: generate_audio → export_audio → WAV ───────
async function render(prompt: string, seed: number, tag: string): Promise<{ wav: string | null; error?: string }> {
  const wav = resolve(wavDir, `${tag}_s${seed}.wav`);
  const eng = new Engine(engineEnv());
  try {
    const g = await eng.exec("generate_audio", { prompt, seed });
    if (!g?.ok) return { wav: null, error: `generate_audio: ${g?.error || "failed"}` };
    const ex = await eng.exec("export_audio", { file: wav, format: "wav" });
    if (!ex?.ok) return { wav: null, error: `export_audio: ${ex?.error || "failed"}` };
    return { wav: existsSync(wav) ? wav : null, error: existsSync(wav) ? undefined : "no wav produced" };
  } finally { eng.close(); }
}

// ── stage 1: distill candidate cards from the LLM (given the REAL catalog) ─────
type RawCard = { skill_name: string; task_type?: string; genre_context?: string[]; producer_intent?: string; when?: string; recipe: CardRecipe };

async function distill(provider: Provider, n: number): Promise<{ cards: TechniqueCard[]; gaps: string[] }> {
  const sys =
    "You are a senior music producer teaching an AI music agent. The agent makes a loop by calling generate_audio " +
    "with a TEXT PROMPT (Stable Audio, text-to-audio), and can also run in-the-box commands. Return ONLY JSON.";
  const user = [
    `Brief: ${BRIEF.briefText}  (${BRIEF.bpm} BPM, ${BRIEF.key}).`,
    `The agent's NAIVE base prompt is: "${BRIEF.basePrompt}".`,
    `Propose ${n} distinct "technique cards" that would make a generate_audio render of this brief sound MORE like it.`,
    `Strongly prefer kind:"prompt" cards: a short comma-tag fragment to APPEND to the base prompt (name specific instruments, era, gear, mood, production character). Do NOT repeat the base prompt text.`,
    `The agent's available in-the-box commands are below; a kind:"recipe" card may ONLY use these commands. If a technique needs a capability NOT listed, put it in "gaps" instead of inventing a command.`,
    commandCatalogPrompt(),
    `Output exactly: {"cards":[{"skill_name":string,"task_type":"prompt_craft"|"sound_design"|"mixing"|"drum_programming"|"bass"|"melody"|"arrangement"|"plugin_chain"|"other","genre_context":[string],"producer_intent":string,"when":string,"recipe":{"kind":"prompt","guidance":string} | {"kind":"recipe","commands":[{"command":string,"args":object}]}}],"gaps":[string]}`,
  ].join("\n");
  // Small models occasionally return prose / truncated JSON — give the multi-card reply
  // a bigger token budget (so the JSON array isn't cut mid-stream) and retry once.
  let parsed: { cards?: RawCard[]; gaps?: string[] } = {};
  for (let attempt = 0; attempt < 2 && !(parsed.cards?.length); attempt++) {
    const reply = await callLLM(provider, [{ role: "system", content: sys }, { role: "user", content: user }], { maxTokens: 2800 });
    parsed = extractJson<{ cards?: RawCard[]; gaps?: string[] }>(reply) || {};
  }
  const cards = (parsed.cards || []).filter((c) => c?.skill_name && c?.recipe).map((c): TechniqueCard => ({
    id: stableId({ skill_name: c.skill_name, recipe: c.recipe }),
    source: "distill",
    skill_name: c.skill_name,
    task_type: (c.task_type as TechniqueCard["task_type"]) || "prompt_craft",
    genre_context: Array.isArray(c.genre_context) && c.genre_context.length ? c.genre_context : [BRIEF.id.replace(/-/g, " ")],
    producer_intent: c.producer_intent || "",
    when: c.when || `Generating a ${BRIEF.id.replace(/-/g, " ")} loop from a prompt.`,
    recipe: c.recipe,
    evidence: [],
    confidence: 0.5,
    status: "candidate",
  }));
  return { cards, gaps: parsed.gaps || [] };
}

// A self-play variation: look at the baseline's weaknesses (flags) and ask for ONE
// prompt card that addresses them. Grounded in what actually scored, not pure priors.
async function selfPlayCard(provider: Provider, baseline: WavScore | undefined): Promise<TechniqueCard | null> {
  if (!baseline) return null;
  const sys = "You are a mixing/production critic. Return ONLY JSON for one prompt card.";
  const user = [
    `Brief: ${BRIEF.briefText}.`,
    `A generate_audio render of "${BRIEF.basePrompt}" scored: brief-match ${baseline.clap_brief ?? "n/a"}, perceptual ${baseline.pq_perceptual ?? "n/a"}, flags [${(baseline.flags || []).join(", ") || "none"}].`,
    `Propose ONE kind:"prompt" card (a comma-tag fragment to append) most likely to fix the weakest aspect and raise brief-match.`,
    `Output: {"skill_name":string,"genre_context":[string],"producer_intent":string,"when":string,"recipe":{"kind":"prompt","guidance":string}}`,
  ].join("\n");
  const raw = extractJson<RawCard>(await callLLM(provider, [{ role: "system", content: sys }, { role: "user", content: user }]));
  if (!raw?.skill_name || raw.recipe?.kind !== "prompt") return null;
  return {
    id: stableId({ skill_name: raw.skill_name, recipe: raw.recipe }),
    source: "selfplay", skill_name: raw.skill_name, task_type: "prompt_craft",
    genre_context: raw.genre_context?.length ? raw.genre_context : [BRIEF.id.replace(/-/g, " ")],
    producer_intent: raw.producer_intent || "", when: raw.when || `Generating a ${BRIEF.id.replace(/-/g, " ")} loop.`,
    recipe: raw.recipe, evidence: [], confidence: 0.5, status: "candidate",
  };
}

// ── main ───────────────────────────────────────────────────────────────────────
type CardOutcome = { card: TechniqueCard; perSeed: { seed: number; delta: number | null; withScore: WavScore | undefined; baseScore: WavScore | undefined }[]; reason: string; renderErrors: string[] };

async function main() {
  const provider = resolveProvider(process.env.FLYWHEEL_PROVIDER);
  if (!provider) { console.error("No LLM provider — put keys in ui/.env.local."); process.exit(2); }
  if (!existsSync(MOSH_BIN)) { console.error("Mosh not built:", MOSH_BIN); process.exit(2); }
  // Clear any orphaned generative service on 8770 (the documented port trap).
  try { execSync("pkill -f server.py", { stdio: "ignore" }); } catch { /* none running */ }
  mkdirSync(wavDir, { recursive: true });

  console.error(`\nKnowledge flywheel · brief="${BRIEF.briefText}" · seeds=[${BRIEF.seeds}] · model=${provider!.id}/${provider!.model} · generative=${SA3 ? "real SA3" : "Fake"}\n`);

  // 1. DISTILL candidates (+ gaps).
  console.error(`→ distilling ${N_CARDS} candidate cards…`);
  const { cards: distilled, gaps } = await distill(provider!, N_CARDS);
  console.error(`  got ${distilled.length} cards, ${gaps.length} capability gaps`);

  // 2. BASELINE renders (one per seed, cached) + collect WITH renders for prompt cards.
  const baselineWav = new Map<number, string | null>();
  for (const seed of BRIEF.seeds) {
    const r = await render(BRIEF.basePrompt, seed, "baseline");
    baselineWav.set(seed, r.wav);
    console.error(`  baseline s${seed}: ${r.wav ? `${kb(r.wav)}KB` : `FAIL (${r.error})`}`);
  }

  const promptCards = distilled.filter((c) => c.recipe.kind === "prompt");
  const recipeCards = distilled.filter((c) => c.recipe.kind === "recipe");

  // Render every prompt card on every seed (sequential — service/port safety).
  const withWav = new Map<string, string | null>(); // `${cardId}#${seed}` -> wav
  const renderErrors = new Map<string, string[]>();
  for (const card of promptCards) {
    for (const seed of BRIEF.seeds) {
      const prompt = `${BRIEF.basePrompt}, ${(card.recipe as { kind: "prompt"; guidance: string }).guidance}`;
      const r = await render(prompt, seed, card.id);
      withWav.set(`${card.id}#${seed}`, r.wav);
      if (r.error) (renderErrors.get(card.id) ?? renderErrors.set(card.id, []).get(card.id)!).push(`s${seed}: ${r.error}`);
    }
    console.error(`  rendered card "${card.skill_name.slice(0, 40)}" on ${BRIEF.seeds.length} seed(s)`);
  }

  // 3. SCORE every wav in one pass (judge + CLAP cold-load once), keyed by the brief.
  const allWavs = [...baselineWav.values(), ...withWav.values()].filter(Boolean) as string[];
  normalizePeak(allWavs); // level out before scoring so the A/B is timbre, not gain
  console.error(`→ scoring ${allWavs.length} renders against the brief (judge loads once)…`);
  const score = new Map(scoreWavs(allWavs, BRIEF.briefText).map((s) => [s.file, s]));

  // 3b. self-play: one variation off the primary baseline's scorecard, tested too.
  let selfCard: TechniqueCard | null = null;
  if (SELFPLAY) {
    const baseS = score.get(baselineWav.get(BRIEF.seeds[0]) || "");
    selfCard = await selfPlayCard(provider!, baseS);
    if (selfCard) {
      console.error(`→ self-play card: "${selfCard.skill_name.slice(0, 48)}"`);
      const newWavs: string[] = [];
      for (const seed of BRIEF.seeds) {
        const prompt = `${BRIEF.basePrompt}, ${(selfCard.recipe as { kind: "prompt"; guidance: string }).guidance}`;
        const r = await render(prompt, seed, selfCard.id);
        withWav.set(`${selfCard.id}#${seed}`, r.wav);
        if (r.wav) newWavs.push(r.wav);
        if (r.error) (renderErrors.get(selfCard.id) ?? renderErrors.set(selfCard.id, []).get(selfCard.id)!).push(`s${seed}: ${r.error}`);
      }
      normalizePeak(newWavs);
      for (const [f, s] of scoreWavs(newWavs, BRIEF.briefText).map((s) => [s.file, s] as const)) score.set(f, s);
      promptCards.push(selfCard);
    }
  }

  // 4. JUDGE each prompt card: per-seed delta vs the cached baseline → acceptance.
  const outcomes: CardOutcome[] = [];
  for (const card of promptCards) {
    const evidence: CardEvidence[] = [];
    let regressedHygiene = false;
    const perSeed = BRIEF.seeds.map((seed) => {
      const baseScore = score.get(baselineWav.get(seed) || "");
      const withScore = score.get(withWav.get(`${card.id}#${seed}`) || "");
      let delta: number | null = null;
      if (baseScore?.clap_brief != null && withScore?.clap_brief != null) {
        delta = withScore.clap_brief - baseScore.clap_brief;
        evidence.push({ brief: `${BRIEF.id} seed${seed}`, metric: "clap_brief", withScore: withScore.clap_brief, withoutScore: baseScore.clap_brief, delta });
      }
      if (withScore?.verdict === "flag" && baseScore?.verdict !== "flag") regressedHygiene = true;
      return { seed, delta, withScore, baseScore };
    });
    const verdict = judgeAcceptance(evidence, { margin: MARGIN, regressedHygiene });
    card.evidence = evidence;
    card.status = verdict.pass ? "validated" : "rejected";
    card.confidence = verdict.pass ? deltaConfidence(evidence) : 0.3;
    outcomes.push({ card, perSeed, reason: verdict.reason, renderErrors: renderErrors.get(card.id) || [] });
  }

  // recipe cards: feasibility-check their commands → capability gaps (don't A/B in v1).
  const recipeGaps: string[] = [];
  for (const card of recipeCards) {
    const cmds = (card.recipe as { kind: "recipe"; commands: { command: string; args: Record<string, unknown> }[] }).commands || [];
    for (const c of cmds) {
      const err = validateCommand(c.command, c.args || {});
      if (err) recipeGaps.push(`${card.skill_name}: "${c.command}" not executable — ${err}`);
    }
  }

  // 5. PERSIST validated cards → store + bake into the product; always write the report.
  const validated = outcomes.filter((o) => o.card.status === "validated").map((o) => o.card);
  let baked = 0;
  if (validated.length) {
    upsertCards(validated);
    baked = writeCardsData();
    console.error(`✓ ${validated.length} card(s) validated → KB + baked (${baked} total in product)`);
  } else {
    console.error("  no card cleared the bar this run (expected on Fake / without CLAP).");
  }

  const md = report(outcomes, [...gaps, ...recipeGaps], validated.length, baked);
  writeFileSync(resolve(briefDir, "report.md"), md);
  console.log("\n" + md.split("## Capability gaps")[0]);
  console.error(`\nFull report + WAVs: ${briefDir}`);
}

function kb(p: string): number { try { return Math.round(statSync(p).size / 1024); } catch { return 0; } }
function fmt(n: number | null | undefined, d = 3) { return n == null ? "–" : n.toFixed(d); }

function report(outcomes: CardOutcome[], gaps: string[], nValidated: number, baked: number): string {
  const L: string[] = [];
  L.push(`# Knowledge flywheel — ${BRIEF.id}`);
  L.push(`\n**Brief:** ${BRIEF.briefText}  ·  ${BRIEF.bpm} BPM · ${BRIEF.key}  ·  generative: **${SA3 ? "real SA3" : "FakeAdapter"}**  ·  seeds [${BRIEF.seeds}]  ·  margin ${MARGIN}`);
  L.push(`\nBase prompt (naive): \`${BRIEF.basePrompt}\``);
  L.push(`\nEach card appends a fragment to the base prompt; a card is **validated** iff it raises CLAP brief-match by ≥${MARGIN}, reproduced over ≥2 seeds, no hygiene regression. ${nValidated} validated → ${baked} in the product KB.\n`);
  L.push(`| card | kind | ${BRIEF.seeds.map((s) => `Δs${s}`).join(" | ")} | verdict | why |`);
  L.push(`|------|------|${BRIEF.seeds.map(() => "----").join("|")}|---------|-----|`);
  for (const o of outcomes) {
    const deltas = BRIEF.seeds.map((s) => { const p = o.perSeed.find((x) => x.seed === s); return p?.delta == null ? "–" : (p.delta >= 0 ? "+" : "") + fmt(p.delta); });
    const mark = o.card.status === "validated" ? "✅" : "—";
    L.push(`| ${o.card.skill_name} (${o.card.source}) | ${o.card.recipe.kind} | ${deltas.join(" | ")} | ${mark} ${o.card.status} | ${o.reason}${o.renderErrors.length ? ` · ⚠️${o.renderErrors.length} render err` : ""} |`);
  }
  L.push(`\n## The validated guidance (what got baked)\n`);
  const val = outcomes.filter((o) => o.card.status === "validated");
  if (val.length) for (const o of val) L.push(`- **${o.card.skill_name}** — _${o.card.when}_\n  \`${o.card.recipe.kind === "prompt" ? o.card.recipe.guidance : "(recipe)"}\``);
  else L.push(`_None this run._ ${SA3 ? "" : "(FakeAdapter ignores prompt meaning + has no CLAP — run with FLYWHEEL_REAL_SA3=1 + judges/CLAP for real deltas.)"}`);
  L.push(`\n## Capability gaps the producer wanted but the agent can't execute\n`);
  L.push(gaps.length ? [...new Set(gaps)].map((g) => `- ${g}`).join("\n") : "_None surfaced this run._");
  L.push(`\n_These are the empirical priority list for the deferred "capability-first" work (automation, named plugin params, sends/sidechain, bounce, swing)._\n`);
  return L.join("\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
