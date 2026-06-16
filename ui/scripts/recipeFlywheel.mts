// The IN-THE-BOX knowledge flywheel: validate technique RECIPE cards (command sequences)
// by SYMBOLIC conformance — apply the card on a fixed base arrangement, read the resulting
// SNAPSHOT, and check the move took effect (notes on the swung grid, an automation curve,
// a routed send), reproduced across ≥2 arrangements, without breaking the mix. No audio,
// no DSP, no SA3 — conformance is exact. Validated (`conformant`) cards bake into the
// product KB and inject at inference exactly like the generative flywheel's prompt cards.
//
//   npm run recipe-flywheel
//
// Phase 1 hand-seeds the cards (a drum PATTERN + swing/humanize/automation/send) to prove
// the loop; a future YouTube miner emits the SAME $token recipe-card shape into the SAME
// loop. Quality ("does it sound better") is the deferred audio layer, NOT this bar.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { MOSH_BIN } from "./agentEngine.mts";
import { type RecipeCommand } from "../src/agent/knowledge/recipe";
import { type PatternSpec } from "../src/agent/knowledge/conformance";
import { type CandidateCard } from "../src/agent/knowledge/distill";
import { upsertCards, writeCardsData } from "./knowledgeStore.mts";
import { type BaseSpec } from "./recipeBase.mts";
import { runCandidateThroughLoop, type Outcome } from "./recipeLoop.mts";

const UI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(UI_ROOT, "..");
const OUT_DIR = resolve(REPO, "eval/recipe-flywheel");

// ≥2 arrangements (different tempo + key) so "reproduced across ≥2 arrangements" means the
// technique lands regardless of the surrounding session — a stronger claim than a re-render.
const ARRANGEMENTS: BaseSpec[] = [
  { baseId: "lofi-85-Am", tempo: 85, key: "A minor" },
  { baseId: "dark-70-Cm", tempo: 70, key: "C minor" },
];

const env = (): Record<string, string> => ({ MOSH_NO_AUDIO: "1" });

const DRUM_PATTERN: PatternSpec = { hits: [
  { pitch: 36, beats: [0, 2.5] },                          // kick: the 1 and the "and" of 3
  { pitch: 38, beats: [1, 3] },                            // snare: the backbeats
  { pitch: 42, beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5] },  // hats: every 8th
] };
const drumCommands: RecipeCommand[] = DRUM_PATTERN.hits.flatMap((h) =>
  h.beats.map((b) => ({ command: "add_note", args: { clipId: "$drumClipId", pitch: h.pitch, start: b, length: 0.25, velocity: h.pitch === 36 ? 110 : h.pitch === 38 ? 100 : 80 } })),
);

// A hand-seeded technique card = a CandidateCard (meta + commands + a declarative check),
// the SAME shape the LLM distiller + the YouTube miner emit and run through the same loop.
const SEED_CARDS: CandidateCard[] = [
  {
    meta: { skill_name: "Boom-bap drum pattern (kick/snare/8th-hats)", task_type: "drum_programming",
      genre_context: ["boom-bap", "lo-fi hip-hop", "hip-hop"],
      producer_intent: "the classic boom-bap skeleton — kick on the 1 and the 'and' of 3, snare on the 2 & 4, hats on every 8th",
      when: "programming a boom-bap or lo-fi hip-hop drum pattern from scratch" },
    commands: drumCommands,
    check: { kind: "pattern", clip: "$drumClipId", pattern: DRUM_PATTERN },
  },
  {
    meta: { skill_name: "MPC swing on the hats (~0.58)", task_type: "drum_programming",
      genre_context: ["boom-bap", "lo-fi hip-hop", "hip-hop", "neo-soul"],
      producer_intent: "push the off-beat 8ths late for that drunk MPC/boom-bap swing instead of a stiff straight grid",
      when: "the hats/drums feel too straight and need a swung, off-grid groove" },
    commands: [{ command: "quantize_notes", args: { clipId: "$hatsClipId", division: 0.5, strength: 1, swing: 0.58 } }],
    check: { kind: "swing", clip: "$hatsClipId", division: 0.5, swing: 0.58 },
  },
  {
    meta: { skill_name: "Humanize the keys (subtle timing + velocity)", task_type: "arrangement",
      genre_context: ["lo-fi hip-hop", "neo-soul", "boom-bap"],
      producer_intent: "a small seeded timing + velocity jitter so a programmed Rhodes/keys part breathes instead of sounding robotic",
      when: "a programmed keys/chord part sounds too quantized / robotic" },
    commands: [{ command: "humanize_notes", args: { clipId: "$keysClipId", timing: 0.2, velocity: 0.3, seed: 42 } }],
    check: { kind: "humanize", clip: "$keysClipId", maxOffsetBeats: 0.125 },
  },
  {
    meta: { skill_name: "Filter-open automation over the intro", task_type: "mixing",
      genre_context: ["lo-fi hip-hop", "house", "electronic"],
      producer_intent: "automate the EQ/filter opening up over the bars for movement, instead of a single static setting",
      when: "an intro/build needs movement — open the filter up over time" },
    commands: [
      { command: "add_automation_point", args: { trackId: "$keysTrackId", pluginIndex: "$keysFilterPluginIndex", paramIndex: "$keysFilterParamIndex", time: 0, value: 0.2 } },
      { command: "add_automation_point", args: { trackId: "$keysTrackId", pluginIndex: "$keysFilterPluginIndex", paramIndex: "$keysFilterParamIndex", time: 4, value: 0.9 } },
    ],
    check: { kind: "automation", track: "$keysTrackId", pluginIndex: "$keysFilterPluginIndex", paramIndex: "$keysFilterParamIndex", direction: "up" },
  },
  {
    meta: { skill_name: "Shared reverb on a send bus", task_type: "mixing",
      genre_context: ["lo-fi hip-hop", "neo-soul", "ambient"],
      producer_intent: "send the keys to ONE shared reverb return for depth, instead of a reverb inserted on every track",
      when: "the mix needs depth / space — a shared reverb the tracks send to" },
    commands: [
      { command: "create_bus", args: { name: "Reverb" } },
      { command: "add_send", args: { trackId: "$keysTrackId", bus: "$busNumber", db: -12 } },
    ],
    check: { kind: "send", track: "$keysTrackId", bus: "$busNumber", db: -12 },
  },
];

async function main() {
  if (!existsSync(MOSH_BIN)) { console.error("Mosh not built:", MOSH_BIN); process.exit(2); }
  try { execSync("pkill -f server.py", { stdio: "ignore" }); } catch { /* none */ }
  mkdirSync(OUT_DIR, { recursive: true });
  console.error(`\nIn-the-box flywheel · ${SEED_CARDS.length} seed cards × ${ARRANGEMENTS.length} arrangements · SYMBOLIC conformance (no audio)\n`);

  const outcomes: Outcome[] = [];
  for (const seed of SEED_CARDS) {
    outcomes.push(await runCandidateThroughLoop(seed, ARRANGEMENTS, {
      source: "distill",
      env: env(),
      onResult: (baseId, res) =>
        console.error(`  ${seed.meta.skill_name.slice(0, 42).padEnd(42)} · ${baseId.padEnd(11)} · ${res.conformant ? "✓" : res.inconclusive ? "?" : "✗"} ${res.detail}`),
    }));
  }

  const conformant = outcomes.filter((o) => o.card.status === "conformant").map((o) => o.card);
  let baked = 0;
  if (conformant.length) { upsertCards(conformant); baked = writeCardsData(); }
  console.error(`\n${conformant.length}/${outcomes.length} cards conformant → KB + baked (${baked} shippable in product)`);

  const md = report(outcomes, baked);
  writeFileSync(resolve(OUT_DIR, "report.md"), md);
  console.error(`Full report: ${resolve(OUT_DIR, "report.md")}`);
}

function report(outcomes: Outcome[], baked: number): string {
  const L: string[] = [];
  L.push(`# In-the-box flywheel — symbolic conformance`);
  L.push(`\n${ARRANGEMENTS.length} arrangements [${ARRANGEMENTS.map((a) => a.baseId).join(", ")}] · a card is **conformant** iff the move took effect on EVERY arrangement (read from the snapshot), with no broken state. ${outcomes.filter((o) => o.card.status === "conformant").length}/${outcomes.length} conformant → ${baked} shippable in the product KB.\n`);
  L.push(`| card | task | ${ARRANGEMENTS.map((a) => a.baseId).join(" | ")} | verdict |`);
  L.push(`|------|------|${ARRANGEMENTS.map(() => "----").join("|")}|---------|`);
  for (const o of outcomes) {
    const cells = ARRANGEMENTS.map((a) => { const p = o.perArr.find((x) => x.baseId === a.baseId); return p ? (p.res.conformant ? "✓" : p.res.inconclusive ? "?" : "✗") + (p.res.measured != null ? ` ${p.res.measured.toFixed(2)}` : "") : "–"; });
    const mark = o.card.status === "conformant" ? "✅" : "—";
    L.push(`| ${o.card.skill_name} | ${o.card.task_type} | ${cells.join(" | ")} | ${mark} ${o.card.status} |`);
  }
  L.push(`\n## What got baked (retrieved + injected at inference)\n`);
  const conf = outcomes.filter((o) => o.card.status === "conformant");
  if (conf.length) for (const o of conf) L.push(`- **${o.card.skill_name}** — _${o.card.when}_  ·  ${(o.card.recipe as { kind: "recipe"; commands: unknown[] }).commands.length} command(s)`);
  else L.push(`_None this run._`);
  L.push(`\n_Conformance proves the move was APPLIED + REPRODUCED, not that it sounds better — quality is the deferred audio-quality layer (Audiobox guard + ears → a future MERT-probe)._\n`);
  return L.join("\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
