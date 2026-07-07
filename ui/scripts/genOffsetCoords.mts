// Emit engine-validated offset-clip coordinate training rows (Cycle-3 data fix —
// r3 diagnostic). DETERMINISTIC + FREE (no cloud): the gold answers are mechanical
// (absolute coordinates), so we generate them from ui/src/sft/offsetCoords.ts and
// keep ONLY the ones that clean-apply on the real engine (gradeApply), shaped
// EXACTLY like the synthesis driver's rows ({messages:[system,user,assistant]}).
//
//   cd ui && npx tsx scripts/genOffsetCoords.mts --bin <MoshBinary> --out ../service/sft/.sft-data/synth/offset-coords.jsonl
//
// Each SETUP places clips at NON-ZERO offsets; the request's time is absolute, so
// the only clean-applying gold is the absolute pass-through — teaching the
// coordinate convention the clips-at-0 corpus could not.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { snapshotAt, findBin, type Cmd } from "./lib/realEngine.mts";
import { gradeApply, snapshotIds } from "./lib/groundedApply.mts";
import { systemPrompt } from "../src/agent/brainCore";
import { coordTasks, splitTimeIsInterior, type ClipDef } from "../src/sft/offsetCoords";

const flag = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };

// SETUP variants — clips at assorted non-zero offsets on distinct tracks, so the
// batch covers a range of offsets and never a clip-at-0 (the whole point).
type Setup = { name: string; setup: Cmd[]; clips: ClipDef[] };
// MIDI-clip offset setups spanning starts 2..8 and assorted lengths, plus a
// wave-clip offset (via move_clip). Each distinct offset is a distinct lesson.
function midiSetup(name: string, start: number, length: number): Setup {
  return {
    name: `midi-${name}-${start}-${length}`,
    setup: [
      { command: "create_track", args: { name }, capture: { T: "trackId" } },
      { command: "add_midi_clip", args: { trackId: "${T}", start, length }, capture: { C: "clipId" } },
    ],
    clips: [{ name, start, length }],
  };
}
const SETUPS: Setup[] = [
  midiSetup("Keys", 4, 8),
  midiSetup("Lead", 6, 6),
  midiSetup("Pad", 3, 9),
  midiSetup("Arp", 2, 10),
  midiSetup("Stab", 8, 6),
  midiSetup("Pluck", 5, 7),
  midiSetup("Chord", 7, 5),
  {
    name: "wave-offset",
    setup: [
      { command: "create_track", args: { name: "Bass" }, capture: { TB: "trackId" } },
      { command: "add_test_tone_clip", args: { trackId: "${TB}", seconds: 6, freq: 110 }, capture: { CB: "clipId" } },
      { command: "move_clip", args: { clipId: "${CB}", start: 5 } },
    ],
    clips: [{ name: "Bass", start: 5, length: 6 }],
  },
];

// clipName → the setup capture var that holds its clipId (so we can resolve the
// real engine id from the snapshot).
function clipIdFor(clipName: string, snap: { tracks?: Array<{ clips?: Array<{ id: string; start: number; name?: string }> }> }, clip: ClipDef): string | null {
  for (const t of snap.tracks ?? [])
    for (const c of t.clips ?? [])
      if (Math.abs((c.start ?? -1) - clip.start) < 0.01) return c.id;
  return null;
}

async function main() {
  const bin = flag("bin") || findBin();
  const out = resolve(flag("out") || "../service/sft/.sft-data/synth/offset-coords.jsonl");
  const seed0 = Number(flag("seed") || "20260706");
  const nSeeds = Number(flag("seeds") || "12"); // seeds multiply phrasing/split-point coverage
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, "");

  let kept = 0, tried = 0;
  const perOp: Record<string, number> = {};
  const drops: Record<string, number> = {};
  const seen = new Set<string>(); // dedupe by (request + gold)

  for (let si = 0; si < SETUPS.length; si++) {
    const s = SETUPS[si];
    const { snap } = snapshotAt(bin, s.setup, `offcoord-${s.name}`);
    const ids = snapshotIds(snap as never);
    const system = systemPrompt(snap as never);

    for (let k = 0; k < nSeeds; k++) {
      const tasks = coordTasks(s.clips, seed0 + si * 7919 + k * 104729);
      for (const task of tasks) {
        const clipDef = s.clips.find((c) => c.name === task.clipName)!;
        if (task.op === "split_clip" && !splitTimeIsInterior(clipDef, task.args.time)) { drops["non-interior"] = (drops["non-interior"] ?? 0) + 1; continue; }
        const clipId = clipIdFor(task.clipName, snap as never, clipDef);
        if (!clipId) { drops["no-clipid"] = (drops["no-clipid"] ?? 0) + 1; continue; }
        const gold: Cmd = { command: task.op, args: { clipId, ...task.args } };
        const dedupeKey = task.request + "|" + JSON.stringify(gold.args);
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        tried++;
        const g = gradeApply(bin, s.setup, ids, [gold], `offcoord-${s.name}-grade`, snap as never);
        if (g.applied === 1 && !g.classes.length) {
          const assistant = JSON.stringify({ intent: "ACK_GOT_IT", commands: [gold] });
          appendFileSync(out, JSON.stringify({ messages: [
            { role: "system", content: system },
            { role: "user", content: task.request },
            { role: "assistant", content: assistant },
          ] }) + "\n");
          kept++; perOp[task.op] = (perOp[task.op] ?? 0) + 1;
        } else {
          drops[g.classes[0] ?? "apply-fail"] = (drops[g.classes[0] ?? "apply-fail"] ?? 0) + 1;
        }
      }
    }
  }

  const manifest = { out, seed: seed0, seeds: nSeeds, tried, kept, perOp, drops, generatedFrom: "ui/src/sft/offsetCoords.ts" };
  writeFileSync(out.replace(/\.jsonl$/, ".manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
