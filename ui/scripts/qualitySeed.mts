// The QUALITY SEED SET — the deferred audio-quality layer's data-collection half (Phase E).
// For a conformant recipe card, render the base arrangement WITHOUT the technique vs WITH
// it, run the Audiobox cleanliness GUARD (did the move break the mix?), and stage a BLIND
// A/B (which slot is the technique is hidden). The owner's ear pick becomes a human_pref
// label → bumps the card to "preferred" (the schema's existing path) AND a row in
// mert-seed.jsonl — the training seed for a future MERT-probe. This is DATA + a guard, NOT
// a judge; research found no off-the-shelf model judges "musically better".
//
//   npm run quality-seed                                   # render + guard + blind-stage pairs
//   npm run quality-seed -- --label <cardId> <A|B|equal>   # record the owner's blind pick
//
// Caveat: the base uses a 4osc synth as a stand-in for drums/hats (no sampler builtin), so
// the owner judges GROOVE/arrangement, not drum timbre — honest for seeding a rhythm-aware
// probe, not a final mix verdict.
import { mkdirSync, writeFileSync, appendFileSync, copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { Engine, MOSH_BIN } from "./agentEngine.mts";
import { applyRecipe } from "./recipeLoop.mts";
import { buildBase, type BaseSpec, type BaseBindings } from "./recipeBase.mts";
import { loadCards, upsertCards, writeCardsData } from "./knowledgeStore.mts";
import { scoreWavs, type WavScore } from "./audioScore.mts";
import { resolvePref, applyHumanPref, mertSeedRow, type AbLabel, type BlindManifest } from "../src/agent/knowledge/qualitySeed";
import type { TechniqueCard } from "../src/agent/knowledge/card";

const UI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(UI_ROOT, "..");
const OUT_DIR = resolve(REPO, "eval/quality-seed");
const SEED_JSONL = resolve(OUT_DIR, "mert-seed.jsonl");
const ARR: BaseSpec = { baseId: "lofi-85-Am", tempo: 85, key: "A minor" };
const env = (): Record<string, string> => ({ MOSH_NO_AUDIO: "1" });

function djb2(s: string): number { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h; }
// Deterministic but card-dependent blind order (no Math.random) so it varies + re-stages stably.
const techniqueSlot = (cardId: string): "A" | "B" => (djb2(cardId) % 2 === 0 ? "A" : "B");

function conformantRecipeCards(): TechniqueCard[] {
  return loadCards()
    .filter((c) => c.recipe.kind === "recipe" && (c.status === "conformant" || c.status === "preferred"))
    .sort((a, b) => Number(b.task_type === "drum_programming") - Number(a.task_type === "drum_programming")); // most-audible first
}

// Make the drum/hat MIDI audible (a 4osc stand-in) so before/after differ for any card type.
async function augment(eng: Engine, base: BaseBindings): Promise<void> {
  await eng.exec("load_builtin", { trackId: base.drumTrackId, type: "4osc" });
  await eng.exec("load_builtin", { trackId: base.hatsTrackId, type: "4osc" });
}

async function renderTo(file: string, withTechnique: TechniqueCard | null): Promise<boolean> {
  const eng = new Engine(env());
  try {
    const base = await buildBase(eng, ARR);
    await augment(eng, base);
    if (withTechnique) await applyRecipe(eng, (withTechnique.recipe as { commands: any[] }).commands, base as unknown as Record<string, unknown>);
    const r = await eng.exec("export_audio", { file, format: "wav" });
    return !!r?.ok && existsSync(file);
  } catch (e) { console.error(`     render error: ${(e as Error).message}`); return false; }
  finally { eng.close(); }
}

const kb = (p: string): number => { try { return Math.round(statSync(p).size / 1024); } catch { return 0; } };

function guardLine(scores: WavScore[]): string {
  const [b, a] = scores;
  if (!a) return "guard: unavailable";
  const broke = a.verdict === "flag" || (b?.pq_hygiene != null && a.pq_hygiene != null && a.pq_hygiene < b.pq_hygiene - 1);
  const pq = a.pq_perceptual != null ? `pq ${a.pq_perceptual.toFixed(2)}` : "pq —";
  return broke ? `⚠ technique may have broken the mix (${a.flags.join(",") || "hygiene"}) · ${pq}` : `ok · ${pq}`;
}

async function stage(limit: number): Promise<void> {
  // limit <= 0 → stage EVERY conformant recipe card; a positive limit caps it for a demo.
  const all = conformantRecipeCards();
  const cards = limit > 0 ? all.slice(0, limit) : all;
  if (!cards.length) { console.error("no conformant recipe cards in the KB to seed."); return; }
  // HONEST GUARD (deferred 2026-06-17): these renders use a bare 4osc as a drum/hat stand-in
  // (no sampler/sample/VST), on ~2s / one-bar clips. Measured before/after differences are
  // BELOW the threshold of hearing (RMS Δ <1.2%), so a blind A/B here is NOT a valid taste
  // signal — labeling it manufactures noise. The MERT taste-probe is deferred until the
  // stimuli are real: a real drum sample (import_clip) + ≥8–16-bar looped renders + a bass/
  // keys production context. Until then, symbolic conformance is the only honest gate.
  console.error(`\n⚠ DEFERRED: quality-seed renders a 4osc STAND-IN (no real drums), one bar, ~2s.`);
  console.error(`  Before/after differences are sub-threshold (RMS Δ <1.2%) → blind A/B is NOT a`);
  console.error(`  valid taste signal yet. Do NOT label these. Real stimuli (samples + long loops)`);
  console.error(`  are needed first. Staging anyway for inspection only.\n`);
  console.error(`Quality seed · staging ${cards.length} card(s) on ${ARR.baseId} · render → guard → blind A/B\n`);
  for (const card of cards) {
    const dir = resolve(OUT_DIR, card.id); mkdirSync(dir, { recursive: true });
    const before = resolve(dir, "before.wav"), after = resolve(dir, "after.wav");
    const okB = await renderTo(before, null);
    const okA = await renderTo(after, card);
    if (!okB || !okA) { console.error(`  ✗ ${card.skill_name.slice(0, 40)} — render failed, skipped`); continue; }
    const scores = scoreWavs([before, after]);
    const slot = techniqueSlot(card.id);
    const A = resolve(dir, "A.wav"), B = resolve(dir, "B.wav");
    copyFileSync(after, slot === "A" ? A : B);   // technique → its hidden slot
    copyFileSync(before, slot === "A" ? B : A);  // baseline → the other
    const manifest: BlindManifest = { cardId: card.id, brief: ARR.baseId, a: A, b: B, techniqueSlot: slot };
    writeFileSync(resolve(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    console.error(`  ◆ ${card.skill_name.slice(0, 44).padEnd(44)} [${before.endsWith("before.wav") ? kb(before) : 0}/${kb(after)}KB]`);
    console.error(`     ${guardLine(scores)}`);
    console.error(`     LISTEN blind → ${A}  vs  ${B}`);
    console.error(`     then: npm run quality-seed -- --label ${card.id} <A|B|equal>\n`);
  }
  console.error(`Staged in ${OUT_DIR}. Labels seed ${SEED_JSONL}.`);
}

function label(cardId: string, pick: AbLabel): void {
  const manPath = resolve(OUT_DIR, cardId, "manifest.json");
  if (!existsSync(manPath)) { console.error(`no staged pair for ${cardId} — run \`npm run quality-seed\` first.`); process.exit(2); }
  const m: BlindManifest = JSON.parse(readFileSync(manPath, "utf8"));
  const card = loadCards().find((c) => c.id === cardId);
  if (!card) { console.error(`card ${cardId} not in the KB.`); process.exit(2); }
  const pref = resolvePref(m, pick);
  const updated = applyHumanPref(card, m.brief, pref);
  upsertCards([updated]);
  const baked = writeCardsData();
  mkdirSync(OUT_DIR, { recursive: true });
  appendFileSync(SEED_JSONL, JSON.stringify(mertSeedRow(updated, m, pick, Date.now())) + "\n");
  console.error(`labeled "${card.skill_name}": pick=${pick} → ${pref} → status=${updated.status} · MERT-seed row appended · ${baked} shippable`);
}

async function main() {
  if (!existsSync(MOSH_BIN)) { console.error("Mosh not built:", MOSH_BIN); process.exit(2); }
  const argv = process.argv.slice(2);
  const li = argv.indexOf("--label");
  if (li >= 0) { label(argv[li + 1], (argv[li + 2] || "equal") as AbLabel); return; }
  try { execSync("pkill -f server.py", { stdio: "ignore" }); } catch { /* none */ }
  await stage(Number(process.env.QUALITY_SEED_LIMIT || 0)); // 0 → stage all conformant cards
}

main().catch((e) => { console.error(e); process.exit(1); });
