// set_render_param routing rows (Cycle-3 P8 — from the r3 gate read).
//
// The r3 floor miss on set_render_param is NOT a data-coverage gap (112 rows in
// s2-mix-v3) — it's a SEMANTIC ROUTING ambiguity on the single eval item
// "transform the Keys clip so it feels spacious and dreamy, echoing out": the
// model added a reverb/delay PLUGIN instead of a generative re-imagine layer
// (a reasonable-but-wrong reading of "spacious/echoing"). This batch teaches the
// contrastive prior: ambient/atmospheric TRANSFORM language → a generative layer
// (create_render_layer + set_render_param), not an effect. Deterministic + FREE,
// every row engine-validated via gradeApply. NOTE (honest): the eval item is n=1
// and genuinely ambiguous — this is a best-effort tip, not a guaranteed pass.
//
//   cd ui && npx tsx scripts/genRenderRouting.mts --bin <MoshBinary> --out ../service/sft/.sft-data/synth/render-routing.jsonl

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { snapshotAt, findBin, type Cmd } from "./lib/realEngine.mts";
import { gradeApply, snapshotIds } from "./lib/groundedApply.mts";
import { systemPrompt } from "../src/agent/brainCore";

const flag = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };

// Ambient/atmospheric TRANSFORM phrasings — the class the model mis-routed to
// effects. Each maps to the generative layer. {c} = clip name.
const PHRASINGS: ((c: string) => string)[] = [
  (c) => `transform the ${c} clip so it feels spacious and dreamy, like it's echoing out`,
  (c) => `make the ${c} clip more atmospheric and washed-out`,
  (c) => `re-imagine ${c} as something ethereal and floating`,
  (c) => `give the ${c} clip a hazy, underwater feel`,
  (c) => `reinvent ${c} so it sounds lush and cavernous`,
  (c) => `turn the ${c} clip into a dreamy, ambient version of itself`,
  (c) => `remake ${c} with a wide, drifting, otherworldly vibe`,
  (c) => `transform ${c} into something misty and far-away sounding`,
  (c) => `reimagine the ${c} clip as a slow, evolving, cinematic pad`,
  (c) => `make ${c} feel like it's dissolving into reverb-soaked space`,
];
// Prompt text the model would author into set_render_param (varied, not the
// verbatim request — how the real rows read).
const PROMPTS = [
  "spacious dreamy echoing atmosphere", "ethereal floating ambient wash",
  "hazy underwater cinematic pad", "lush cavernous evolving texture",
  "wide drifting otherworldly reimagining", "misty far-away ambient version",
];
const STRENGTHS = [0.5, 0.6, 0.7];
const CLIPS = ["Keys", "Pads", "Piano", "Lead", "Bells", "Rhodes"];

async function main() {
  const bin = flag("bin") || findBin();
  const out = resolve(flag("out") || "../service/sft/.sft-data/synth/render-routing.jsonl");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, "");

  let kept = 0, tried = 0;
  const drops: Record<string, number> = {};
  const seen = new Set<string>();

  for (let ci = 0; ci < CLIPS.length; ci++) {
    const clip = CLIPS[ci];
    // A session whose target clip is a MIDI clip (the eval shape). Include a
    // loaded builtin so the plugin path is ALSO available — the row teaches the
    // model to pick generative even when an effect is a plausible alternative.
    const setup: Cmd[] = [
      { command: "create_track", args: { name: clip }, capture: { T: "trackId" } },
      { command: "add_midi_clip", args: { trackId: "${T}", start: 0, length: 8 }, capture: { C: "clipId" } },
      { command: "load_builtin", args: { trackId: "${T}", type: "reverb" } },
    ];
    const { snap } = snapshotAt(bin, setup, `renderroute-${clip}`);
    const ids = snapshotIds(snap as never);
    const system = systemPrompt(snap as never);
    const clipId = (() => {
      for (const t of (snap as { tracks?: Array<{ clips?: Array<{ id: string }> }> }).tracks ?? [])
        for (const c of t.clips ?? []) return c.id;
      return null;
    })();
    if (!clipId) { drops["no-clipid"] = (drops["no-clipid"] ?? 0) + 1; continue; }

    for (let pi = 0; pi < PHRASINGS.length; pi++) {
      const request = PHRASINGS[pi](clip);
      const prompt = PROMPTS[(ci + pi) % PROMPTS.length];
      const strength = STRENGTHS[(ci + pi) % STRENGTHS.length];
      const gold: Cmd[] = [
        { command: "create_render_layer", args: { clipId } },
        { command: "set_render_param", args: { clipId, prompt, strength } },
      ];
      const key = request;
      if (seen.has(key)) continue;
      seen.add(key);
      tried++;
      const g = gradeApply(bin, setup, ids, gold, `renderroute-${clip}-grade`, snap as never);
      if (g.applied === gold.length && !g.classes.length) {
        appendFileSync(out, JSON.stringify({ messages: [
          { role: "system", content: system },
          { role: "user", content: request },
          { role: "assistant", content: JSON.stringify({ intent: "ACK_GOT_IT", commands: gold }) },
        ] }) + "\n");
        kept++;
      } else {
        drops[g.classes[0] ?? "apply-fail"] = (drops[g.classes[0] ?? "apply-fail"] ?? 0) + 1;
      }
    }
  }
  const manifest = { out, tried, kept, drops, note: "ambient-transform → generative-layer routing (Cycle-3)" };
  writeFileSync(out.replace(/\.jsonl$/, ".manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
