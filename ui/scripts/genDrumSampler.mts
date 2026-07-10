// assign_sample + load_drum_kit corrective rows (r5 — from the r4-cuda gate rerun).
//
// After the harness fixes (P0 #275, P1 #283, mock length fidelity #286), the
// 2026-07-09 floor re-read against the archived a3b-r4-cuda adapter left exactly
// two model-caused floor misses on the evalA core:
//   assign_sample 0.333 — DEFERRALS on fully-explicit asks ("map kick.wav to
//     track 1010 on note 38"): under-confidence, not a knowledge gap.
//   load_drum_kit 0.333 — deferrals + PARTIAL recall (emitted set_track_type but
//     dropped the paired load_drum_kit) + one load_builtin{unknown type} misroute.
// This batch teaches: explicit sample/kit asks get COMMANDS (never a deferral),
// "make it drums with the kit" pairs set_track_type + load_drum_kit, and the
// built-in KIT is load_drum_kit, not load_builtin. Deterministic + FREE, every
// row engine-validated via gradeApply.
//
//   cd ui && npx tsx scripts/genDrumSampler.mts --bin <MoshBinary> --out ../service/sft/.sft-data/synth/drum-sampler.jsonl

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { snapshotAt, findBin, type Cmd } from "./lib/realEngine.mts";
import { gradeApply, snapshotIds } from "./lib/groundedApply.mts";
import { systemPrompt } from "../src/agent/brainCore";

const flag = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };

const ASSETS = `${homedir()}/Music/mosh-sft-assets`;
const FILES = [
  { file: `${ASSETS}/kick.wav`, what: "kick" },
  { file: `${ASSETS}/loop.wav`, what: "loop" },
  { file: `${ASSETS}/beatbox-90bpm.wav`, what: "beatbox take" },
];

// {f}=file path, {t}=track ref (name or numeric id), {n}=note. Mode is explicit
// in the phrasing wherever the gold uses "melodic" (drum is the engine default).
const ASSIGN_PHRASINGS: { text: (f: string, t: string, n: number) => string; mode: "drum" | "melodic" }[] = [
  { text: (f, t, n) => `Map ${f} to ${t} on note ${n} so I can trigger it from the kit.`, mode: "drum" },
  { text: (f, t, n) => `Put ${f} on ${t} at note ${n}.`, mode: "drum" },
  { text: (f, t, n) => `Assign ${f} to note ${n} on ${t}.`, mode: "drum" },
  { text: (f, t, n) => `Drop ${f} onto pad ${n} of ${t}.`, mode: "drum" },
  { text: (f, t, n) => `Load ${f} onto ${t} on note ${n} and make it melodic so it follows the keyboard.`, mode: "melodic" },
  { text: (f, t, n) => `I want ${f} on ${t}, note ${n}, in melodic mode.`, mode: "melodic" },
  { text: (f, t, n) => `Put ${f} on ${t} at note ${n} as a pitched melodic sample.`, mode: "melodic" },
  { text: (f, t, n) => `Sample ${f} onto ${t}, note ${n} — one-shot pad is fine.`, mode: "drum" },
];

const KIT_SOLO_PHRASINGS: ((t: string) => string)[] = [
  (t) => `Put a built-in drum kit on ${t}.`,
  (t) => `Load the built-in kit on ${t}.`,
  (t) => `I want ${t} to have the built-in kit loaded.`,
  (t) => `Give ${t} the stock drum kit.`,
  (t) => `Set up the bundled kit on ${t}.`,
  (t) => `Load up the default drum kit sampler on ${t}.`,
];

const KIT_PAIRED_PHRASINGS: ((t: string) => string)[] = [
  (t) => `Turn ${t} into a drum track with the kit.`,
  (t) => `Make ${t} drums and load the kit.`,
  (t) => `I want ${t} to use the drum sampler and kit.`,
  (t) => `Set ${t} up for drums — type and kit both.`,
  (t) => `Convert ${t} to a drum track and put the built-in kit on it.`,
  (t) => `Switch ${t} over to drums with the stock kit loaded.`,
];

const NOTES = [36, 38, 42, 45, 48, 52, 60];
const TRACKS = ["Drums", "Percs", "Beat", "Bounce", "Groove", "Chops"];

type Snap = { tracks?: Array<{ id: string; name?: string; clips?: Array<{ id: string }> }> };

async function main() {
  const bin = flag("bin") || findBin();
  const out = resolve(flag("out") || "../service/sft/.sft-data/synth/drum-sampler.jsonl");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, "");

  let kept = 0, tried = 0;
  const drops: Record<string, number> = {};
  const seen = new Set<string>();
  const keep = (system: string, request: string, gold: Cmd[]) => {
    appendFileSync(out, JSON.stringify({ messages: [
      { role: "system", content: system },
      { role: "user", content: request },
      { role: "assistant", content: JSON.stringify({ intent: "ACK_GOT_IT", commands: gold }) },
    ] }) + "\n");
    kept++;
  };

  for (let ti = 0; ti < TRACKS.length; ti++) {
    const trackName = TRACKS[ti];
    // A multi-track session so numeric ids aren't trivially guessable, plus a
    // second plain track — the eval fixtures' shape.
    const setup: Cmd[] = [
      { command: "create_track", args: { name: "Keys" } },
      { command: "create_track", args: { name: trackName } },
      { command: "create_track", args: { name: "Sub" } },
    ];
    const { snap } = snapshotAt(bin, setup, `drumsampler-${trackName}`);
    const ids = snapshotIds(snap as never);
    const system = systemPrompt(snap as never);
    const track = (snap as Snap).tracks?.find((t) => t.name === trackName);
    if (!track) { drops["no-track"] = (drops["no-track"] ?? 0) + 1; continue; }
    // Alternate name-reference and numeric-id-reference — the eval asks both ways.
    const refs = [`the ${trackName} track`, `track ${track.id}`];

    for (let pi = 0; pi < ASSIGN_PHRASINGS.length; pi++) {
      const { text, mode } = ASSIGN_PHRASINGS[pi];
      const { file } = FILES[(ti + pi) % FILES.length];
      const note = NOTES[(ti + pi) % NOTES.length];
      const ref = refs[(ti + pi) % refs.length];
      const request = text(file, ref, note);
      if (seen.has(request)) continue;
      seen.add(request);
      tried++;
      const gold: Cmd[] = [{ command: "assign_sample", args: { trackId: track.id, note, file, mode } }];
      const g = gradeApply(bin, setup, ids, gold, `drumsampler-${trackName}-a${pi}`, snap as never);
      if (g.applied === gold.length && !g.classes.length) keep(system, request, gold);
      else drops[g.classes[0] ?? "apply-fail"] = (drops[g.classes[0] ?? "apply-fail"] ?? 0) + 1;
    }

    for (let pi = 0; pi < KIT_SOLO_PHRASINGS.length; pi++) {
      const ref = refs[pi % refs.length];
      const request = KIT_SOLO_PHRASINGS[pi](ref);
      if (seen.has(request)) continue;
      seen.add(request);
      tried++;
      const gold: Cmd[] = [{ command: "load_drum_kit", args: { trackId: track.id } }];
      const g = gradeApply(bin, setup, ids, gold, `drumsampler-${trackName}-k${pi}`, snap as never);
      if (g.applied === gold.length && !g.classes.length) keep(system, request, gold);
      else drops[g.classes[0] ?? "apply-fail"] = (drops[g.classes[0] ?? "apply-fail"] ?? 0) + 1;
    }

    for (let pi = 0; pi < KIT_PAIRED_PHRASINGS.length; pi++) {
      const ref = refs[(pi + 1) % refs.length];
      const request = KIT_PAIRED_PHRASINGS[pi](ref);
      if (seen.has(request)) continue;
      seen.add(request);
      tried++;
      const gold: Cmd[] = [
        { command: "set_track_type", args: { trackId: track.id, type: "drum" } },
        { command: "load_drum_kit", args: { trackId: track.id } },
      ];
      const g = gradeApply(bin, setup, ids, gold, `drumsampler-${trackName}-p${pi}`, snap as never);
      if (g.applied === gold.length && !g.classes.length) keep(system, request, gold);
      else drops[g.classes[0] ?? "apply-fail"] = (drops[g.classes[0] ?? "apply-fail"] ?? 0) + 1;
    }
  }

  const manifest = { out, tried, kept, drops, note: "assign_sample deferral-suppression + load_drum_kit solo/paired routing (r5)" };
  writeFileSync(out.replace(/\.jsonl$/, ".manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
