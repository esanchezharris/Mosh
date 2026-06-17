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
import { parseDistilledCards } from "../src/agent/knowledge/distill";
import { IN_THE_BOX_COMMANDS, BASE_TOKENS, DISTILL_SYS, recipeCardRules } from "../src/agent/knowledge/distillPrompt";
import { runCandidateThroughLoop, type Outcome } from "./recipeLoop.mts";
import { upsertCards, writeCardsData, loadCards } from "./knowledgeStore.mts";
import { moveSignature, isShippable } from "../src/agent/knowledge/card";
import { type BaseSpec } from "./recipeBase.mts";

const UI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(UI_ROOT, "..");
const OUT_DIR = resolve(REPO, "eval/recipe-distill");

const env = (): Record<string, string> => ({ MOSH_NO_AUDIO: "1" });

// ≥2 arrangements (different tempo/key) so "reproduced" is a real claim — same as the flywheel.
const ARRANGEMENTS: BaseSpec[] = [
  { baseId: "lofi-85-Am", tempo: 85, key: "A minor" },
  { baseId: "dark-70-Cm", tempo: 70, key: "C minor" },
];

function buildPrompt(brief: string, n: number): { sys: string; user: string } {
  const user = [
    `Brief: ${brief}.`,
    `Propose ${n} distinct, concrete in-the-box "recipe cards" a producer would actually use for this brief.`,
    ``,
    ...recipeCardRules(),
  ].join("\n");
  return { sys: DISTILL_SYS, user };
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
    if (parseDistilledCards(reply, { commands: IN_THE_BOX_COMMANDS, tokens: BASE_TOKENS }).cards.length) break;
    console.error(`  ${usedModel} yielded no runnable cards — falling back to the next provider…`);
  }
  writeFileSync(resolve(OUT_DIR, "last-reply.txt"), reply); // raw reply, for inspecting parse misses
  const { cards: candidates, rejects } = parseDistilledCards(reply, { commands: IN_THE_BOX_COMMANDS, tokens: BASE_TOKENS });
  console.error(`\nmodel=${usedModel} · parsed ${candidates.length} candidate(s); ${rejects.length} rejected at the shape gate (raw reply: ${reply.length} chars → ${resolve(OUT_DIR, "last-reply.txt")})`);
  for (const r of rejects) console.error(`  ✗ shape: ${r.reason}`);
  if (!candidates.length) { console.error("\nno runnable candidates — nothing to validate."); process.exit(0); }

  // ── stage 2: run each through the conformance loop (the CONFORMANCE gate) ─────────
  const outcomes: Outcome[] = [];
  for (const cand of candidates) {
    outcomes.push(await runCandidateThroughLoop(cand, ARRANGEMENTS, {
      source: "distill", env: env(),
      onResult: (baseId, res) =>
        console.error(`  ${cand.meta.skill_name.slice(0, 42).padEnd(42)} · ${baseId.padEnd(11)} · ${res.conformant ? "✓" : res.inconclusive ? "?" : "✗"} ${res.detail}`),
    }));
  }

  // NOVELTY GATE: only bake candidates whose MOVE isn't already in the corpus (a re-derivation
  // of an existing move under a new label is not new technique). Same gate as the YouTube miner.
  const seenMoves = new Set(loadCards().filter(isShippable).map(moveSignature));
  const conformant = outcomes.filter((o) => o.card.status === "conformant").map((o) => o.card);
  const novel: typeof conformant = [];
  let dupes = 0;
  for (const c of conformant) {
    const sig = moveSignature(c);
    if (seenMoves.has(sig)) { dupes++; console.error(`  ↺ dup move (already in corpus): ${c.skill_name.slice(0, 44)}`); continue; }
    seenMoves.add(sig);
    novel.push(c);
  }
  let baked = 0;
  if (novel.length) { upsertCards(novel); baked = writeCardsData(); }

  console.error(`\n${conformant.length} conformant candidate(s) → ${novel.length} NEW distinct move(s) · ${dupes} duplicate-of-existing skipped · ${baked} shippable baked`);
  for (const c of novel) console.error(`  ★ NEW conformant card: ${c.skill_name}`);

  const md = report(brief, usedModel, outcomes, rejects, novel, dupes);
  writeFileSync(resolve(OUT_DIR, "report.md"), md);
  console.error(`Full report: ${resolve(OUT_DIR, "report.md")}`);
}

function report(brief: string, model: string, outcomes: Outcome[], rejects: { reason: string }[], novel: { id: string; skill_name: string }[], dupes = 0): string {
  const L: string[] = [];
  const nConf = outcomes.filter((o) => o.card.status === "conformant").length;
  L.push(`# Recipe distiller — LLM in-the-box cards, validated by conformance\n`);
  L.push(`Brief: **${brief}**  ·  model: \`${model}\`  ·  ${outcomes.length} candidate(s) reached the loop, ${rejects.length} rejected at the shape gate.`);
  L.push(`\n**${nConf} conformant candidate(s) → ${novel.length} NEW DISTINCT move(s) baked · ${dupes} duplicate-of-existing skipped.**\n`);
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
