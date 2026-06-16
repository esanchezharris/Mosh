// The LLM RECIPE-card distiller: ask a producer-LLM for in-the-box technique cards
// (a MoshOps command sequence + a declarative CheckSpec) for a brief, then VALIDATE each
// by symbolic conformance through the SAME loop the hand-seeded flywheel uses. Conformant
// cards bake into the product KB. Hallucinated / non-conformant candidates are LOGGED, not
// hidden — the honest, two-stage gate (shape gate → conformance gate). The YouTube miner
// reuses this exact pipeline, transcript-fed.
//
//   npm run recipe-distill
//   DISTILL_BRIEF="hard techno, driving 909" DISTILL_N=6 npm run recipe-distill
//
// Scope: the distillable command subset is the commands that have a matching conformance
// reader (add_note→pattern, quantize_notes→swing, humanize_notes→humanize,
// add_automation_point→automation, create_bus+add_send→send). A static param set
// (set_plugin_param_by_name) has no value-reader yet, so it's out of the distillable set
// for now — the agent can still reach it at inference; it's just not a discoverable card.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { MOSH_BIN } from "./agentEngine.mts";
import { loadEnvFiles, resolveProviders, callLLM } from "./llm.mts";
import { AGENT_COMMANDS } from "../src/agent/commands";
import { parseDistilledCards } from "../src/agent/knowledge/distill";
import { runCandidateThroughLoop, type Outcome } from "./recipeLoop.mts";
import { upsertCards, writeCardsData, loadCards } from "./knowledgeStore.mts";
import { type BaseSpec } from "./recipeBase.mts";

const UI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(UI_ROOT, "..");
const OUT_DIR = resolve(REPO, "eval/recipe-distill");

const env = (): Record<string, string> => ({ MOSH_NO_AUDIO: "1" });

// The base arrangement's $token vocabulary (recipeBase.BaseBindings) + the runtime capture.
const TOKENS = ["drumTrackId", "drumClipId", "hatsTrackId", "hatsClipId", "keysTrackId", "keysClipId", "keysFilterPluginIndex", "keysFilterParamIndex", "busNumber"];
// The in-the-box command subset a recipe card may use (each maps to a conformance reader).
const COMMANDS = ["add_note", "quantize_notes", "humanize_notes", "add_automation_point", "create_bus", "add_send"];

// ≥2 arrangements (different tempo/key) so "reproduced" is a real claim — same as the flywheel.
const ARRANGEMENTS: BaseSpec[] = [
  { baseId: "lofi-85-Am", tempo: 85, key: "A minor" },
  { baseId: "dark-70-Cm", tempo: 70, key: "C minor" },
];

function commandSubsetPrompt(): string {
  const map = new Map(AGENT_COMMANDS.map((c) => [c.command, c]));
  return COMMANDS.map((name) => {
    const c = map.get(name);
    if (!c) return `- ${name}`;
    const a = c.args.map((x) => `${x.name}${x.required ? "" : "?"}`).join(", ");
    return `- ${name}(${a}) — ${c.desc}`;
  }).join("\n");
}

function buildPrompt(brief: string, n: number): { sys: string; user: string } {
  const sys =
    "You are a senior music producer teaching an AI DAW agent IN-THE-BOX technique (MIDI " +
    "programming, groove, automation, routing). Return ONLY JSON, no prose.";
  const user = [
    `Brief: ${brief}.`,
    `Propose ${n} distinct, concrete in-the-box "recipe cards" a producer would actually use for this brief.`,
    ``,
    `Each card is a SEQUENCE of MoshOps commands applied to a fixed BASE session, plus a declarative CHECK that proves the move took effect (read symbolically from the session — no audio).`,
    ``,
    `The BASE session already has these tracks/clips. Refer to them ONLY by these $tokens:`,
    `- Drums track ($drumTrackId) with an EMPTY midi clip $drumClipId — fill it with a drum PATTERN (kick=36, snare=38, closed-hat=42, open-hat=46, clap=39, rim=37).`,
    `- Hats track ($hatsTrackId) with straight 8th-note hats in clip $hatsClipId — reprogram or swing them.`,
    `- Keys track ($keysTrackId): a synth + a 3-note arp in clip $keysClipId, and a 4-band EQ at plugin index $keysFilterPluginIndex whose frequency param index is $keysFilterParamIndex.`,
    `After a create_bus command, refer to the new bus as $busNumber.`,
    `Use NO other ids. start/length are in BEATS; 1 bar = 4 beats.`,
    ``,
    `You may ONLY use these commands:`,
    commandSubsetPrompt(),
    ``,
    `The CHECK is exactly one of these (its refs MUST be the same $tokens your commands touch, and MUST match what your commands do):`,
    `- {"kind":"pattern","clip":"$drumClipId","pattern":{"hits":[{"pitch":36,"beats":[0,2]},{"pitch":38,"beats":[1,3]}]}}  — list every (pitch,beat) you add_note'd`,
    `- {"kind":"swing","clip":"$hatsClipId","division":0.5,"swing":0.58}  — after a quantize_notes with that division+swing`,
    `- {"kind":"humanize","clip":"$keysClipId","maxOffsetBeats":0.125}  — after a humanize_notes`,
    `- {"kind":"automation","track":"$keysTrackId","pluginIndex":"$keysFilterPluginIndex","paramIndex":"$keysFilterParamIndex","direction":"up"}  — after 2+ add_automation_point (up=rising, down=falling)`,
    `- {"kind":"send","track":"$keysTrackId","bus":"$busNumber","db":-12}  — after create_bus + add_send`,
    ``,
    `STRONGLY prefer multi-step PATTERN cards (a full drum or melodic grid of add_note commands) — those are the valuable, mineable ones. A single-knob card is weak.`,
    ``,
    `Output EXACTLY: {"cards":[{"skill_name":string,"task_type":"drum_programming"|"bass"|"melody"|"arrangement"|"mixing"|"sound_design"|"other","genre_context":[string],"producer_intent":string,"when":string,"commands":[{"command":string,"args":object}],"check":object}]}`,
  ].join("\n");
  return { sys, user };
}

async function main() {
  if (!existsSync(MOSH_BIN)) { console.error("Mosh not built:", MOSH_BIN); process.exit(2); }
  loadEnvFiles(UI_ROOT);
  const providers = resolveProviders(process.env.DISTILL_PROVIDER);
  if (!providers.length) { console.error("no LLM provider — set keys in ui/.env.local"); process.exit(2); }
  try { execSync("pkill -f server.py", { stdio: "ignore" }); } catch { /* none */ }
  mkdirSync(OUT_DIR, { recursive: true });

  const brief = process.env.DISTILL_BRIEF || "trap beat — booming 808 sub, fast triplet hi-hat rolls, sparse menacing keys, 140 BPM";
  const n = Number(process.env.DISTILL_N || 6);
  console.error(`\nRecipe distiller · brief="${brief}" · providers=[${providers.map((p) => p.id).join(", ")}] · asking for ${n} cards (keys read by reference, never printed)\n`);

  // ── stage 1: distill → parse (the SHAPE gate) ─ try each provider until one yields ─
  const { sys, user } = buildPrompt(brief, n);
  let reply = "", usedModel = providers[0].id + "/" + providers[0].model;
  for (const provider of providers) {
    reply = await callLLM(provider, [{ role: "system", content: sys }, { role: "user", content: user }], { maxTokens: 4000 });
    usedModel = `${provider.id}/${provider.model}`;
    if (parseDistilledCards(reply, { commands: COMMANDS, tokens: TOKENS }).cards.length) break;
    console.error(`  ${usedModel} yielded no runnable cards — falling back to the next provider…`);
  }
  writeFileSync(resolve(OUT_DIR, "last-reply.txt"), reply); // raw reply, for inspecting parse misses
  const { cards: candidates, rejects } = parseDistilledCards(reply, { commands: COMMANDS, tokens: TOKENS });
  console.error(`\nmodel=${usedModel} · parsed ${candidates.length} candidate(s); ${rejects.length} rejected at the shape gate (raw reply: ${reply.length} chars → ${resolve(OUT_DIR, "last-reply.txt")})`);
  for (const r of rejects) console.error(`  ✗ shape: ${r.reason}`);
  if (!candidates.length) { console.error("\nno runnable candidates — nothing to validate."); process.exit(0); }

  // ── stage 2: run each through the conformance loop (the CONFORMANCE gate) ─────────
  const before = new Set(loadCards().map((c) => c.id));
  const outcomes: Outcome[] = [];
  for (const cand of candidates) {
    outcomes.push(await runCandidateThroughLoop(cand, ARRANGEMENTS, {
      source: "distill", env: env(),
      onResult: (baseId, res) =>
        console.error(`  ${cand.meta.skill_name.slice(0, 42).padEnd(42)} · ${baseId.padEnd(11)} · ${res.conformant ? "✓" : res.inconclusive ? "?" : "✗"} ${res.detail}`),
    }));
  }

  const conformant = outcomes.filter((o) => o.card.status === "conformant").map((o) => o.card);
  const novel = conformant.filter((c) => !before.has(c.id));
  let baked = 0;
  if (conformant.length) { upsertCards(conformant); baked = writeCardsData(); }

  console.error(`\n${conformant.length}/${outcomes.length} candidate(s) conformant · ${novel.length} NEW (not already in the KB) · ${baked} shippable baked`);
  for (const c of novel) console.error(`  ★ NEW conformant card: ${c.skill_name}`);

  const md = report(brief, usedModel, outcomes, rejects, novel);
  writeFileSync(resolve(OUT_DIR, "report.md"), md);
  console.error(`Full report: ${resolve(OUT_DIR, "report.md")}`);
}

function report(brief: string, model: string, outcomes: Outcome[], rejects: { reason: string }[], novel: { id: string; skill_name: string }[]): string {
  const L: string[] = [];
  const nConf = outcomes.filter((o) => o.card.status === "conformant").length;
  L.push(`# Recipe distiller — LLM in-the-box cards, validated by conformance\n`);
  L.push(`Brief: **${brief}**  ·  model: \`${model}\`  ·  ${outcomes.length} candidate(s) reached the loop, ${rejects.length} rejected at the shape gate.`);
  L.push(`\n**${nConf}/${outcomes.length} conformant · ${novel.length} NEW · baked into the KB.**\n`);
  L.push(`| card | task | ${ARRANGEMENTS.map((a) => a.baseId).join(" | ")} | verdict | new |`);
  L.push(`|------|------|${ARRANGEMENTS.map(() => "----").join("|")}|---------|-----|`);
  const novelIds = new Set(novel.map((c) => c.id));
  for (const o of outcomes) {
    const cells = ARRANGEMENTS.map((a) => { const p = o.perArr.find((x) => x.baseId === a.baseId); return p ? (p.res.conformant ? "✓" : p.res.inconclusive ? "?" : "✗") + (p.res.measured != null ? ` ${p.res.measured.toFixed(2)}` : "") : "–"; });
    L.push(`| ${o.card.skill_name} | ${o.card.task_type} | ${cells.join(" | ")} | ${o.card.status} | ${novelIds.has(o.card.id) ? "★" : ""} |`);
  }
  if (rejects.length) {
    L.push(`\n## Rejected at the shape gate (hallucinated command / token / check)\n`);
    for (const r of rejects) L.push(`- ${r.reason}`);
  }
  L.push(`\n_Conformance proves the LLM's card APPLIES + REPRODUCES across arrangements, not that it sounds better — quality is the deferred audio layer._\n`);
  return L.join("\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
