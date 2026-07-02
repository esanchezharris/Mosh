// Corrective-pair PILOT — one degradation class (gain staging), invariant-graded.
//
//   cd ui && npx tsx scripts/correctivePairs.mts [--n 20] [--render 6] [--out <dir>]
//
// Mechanism (audit Stage 1, piloted before any scaling):
//   1. Build a varied seeded session on the REAL engine (track names/levels vary
//      deterministically per pair — no RNG).
//   2. DEGRADE it: one track gets a gain-staging fault (drowning +8..+12 dB, or
//      buried −14..−20 dB), applied as a manual (unbracketed) command.
//   3. Pair a natural corrective utterance with a GOLD INVARIANT — direction +
//      tolerance band back toward the pre-degradation level — never exact args
//      (the v2 db:0 defect is the standing warning against exact gold).
//   4. Emit pairs.jsonl {utterance, snapshotBefore(real, degraded), invariant};
//      render before/after WAVs for the owner's blind spot-check ("a real producer
//      ask + a respectable fix?"). Pairs feed TRAINING only after that check.
//
// Guard against restore-to-original bias: the invariant accepts any level within
// ±4 dB of the original — "fix the balance" has many valid answers; we grade the
// class of fix, not the inverse operation.

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { argFlag, findBin, runScript, snapshotAt, type Cmd } from "./lib/realEngine.mts";

const BIN = findBin(argFlag("bin"));
const N = Number(argFlag("n", "20"));
const RENDER_N = Number(argFlag("render", "6"));
const OUT_DIR = argFlag("out", join(process.cwd(), "..", "service", "sft", ".sft-data", "corrective-pilot"))!;
const ART = join(homedir(), "mosh-bench-artifacts", "corrective-pilot");
mkdirSync(OUT_DIR, { recursive: true });

const NAMES = [
  ["Drums", "808", "Keys", "Vox"],
  ["Kick", "Bass", "Pads", "Lead Vox"],
  ["Percs", "Sub", "Chords", "Hook"],
  ["Beat", "Low End", "Synth", "Adlibs"],
];
const BASE_LEVELS = [0, -2, -4, -6];

const DROWN_UTTS = [
  (t: string) => `the ${t} is drowning everything, fix the balance`,
  (t: string) => `${t} is way too loud in this mix, sort it out`,
  (t: string) => `pull the ${t} back, it's stepping on everything else`,
  (t: string) => `the ${t} is blowing out the mix, tame it`,
];
const BURIED_UTTS = [
  (t: string) => `I can barely hear the ${t}, bring it back`,
  (t: string) => `the ${t} is completely buried, fix that`,
  (t: string) => `where did the ${t} go? get it back in the mix`,
  (t: string) => `the ${t} is getting lost, give it some presence`,
];

type Pair = {
  id: string;
  class: "gain-staging";
  mode: "drowning" | "buried";
  utterance: string;
  track: string;
  originalDb: number;
  degradedDb: number;
  invariant: { kind: "trackVolumeBand"; track: string; minDb: number; maxDb: number };
  snapshotBefore: unknown;
  renders?: { before: string; after: string };
};

function sessionSeed(i: number): { cmds: Cmd[]; names: string[]; levels: number[] } {
  const names = NAMES[i % NAMES.length];
  const levels = names.map((_, k) => BASE_LEVELS[(i + k) % BASE_LEVELS.length]);
  const cmds: Cmd[] = [{ command: "set_tempo", args: { bpm: 110 + (i % 6) * 10 } }];
  names.forEach((n, k) => {
    cmds.push({ command: "create_track", args: { name: n }, capture: { [`T${k}`]: "trackId" } });
    cmds.push({ command: "add_test_tone_clip", args: { trackId: `\${T${k}}`, seconds: 4, freq: 110 * (k + 1) } });
    cmds.push({ command: "set_track_volume", args: { trackId: `\${T${k}}`, db: levels[k] } });
  });
  return { cmds, names, levels };
}

async function main() {
  const pairs: Pair[] = [];
  for (let i = 0; i < N; i++) {
    const { cmds, names, levels } = sessionSeed(i);
    const ti = i % names.length;
    const mode: Pair["mode"] = i % 2 === 0 ? "drowning" : "buried";
    const delta = mode === "drowning" ? 8 + (i % 5) : -(14 + (i % 7));
    const degradedDb = levels[ti] + delta;
    const utt = (mode === "drowning" ? DROWN_UTTS : BURIED_UTTS)[i % 4](names[ti].toLowerCase());
    const degrade: Cmd = { command: "set_track_volume", args: { trackId: `\${T${ti}}`, db: degradedDb } };
    const session = `cp-${i}`;
    const { snap } = snapshotAt(BIN, [...cmds, degrade], session);
    const pair: Pair = {
      id: `gain-${mode}-${String(i).padStart(3, "0")}`,
      class: "gain-staging",
      mode,
      utterance: utt,
      track: names[ti],
      originalDb: levels[ti],
      degradedDb,
      invariant: { kind: "trackVolumeBand", track: names[ti], minDb: levels[ti] - 4, maxDb: levels[ti] + 4 },
      snapshotBefore: snap,
    };
    if (i < RENDER_N) {
      mkdirSync(ART, { recursive: true });
      const wavB = join(ART, `${pair.id}.degraded.wav`);
      const wavA = join(ART, `${pair.id}.fixed.wav`);
      runScript(BIN, [...cmds, degrade, { command: "export_audio", args: { file: wavB } }], `${session}-rb`);
      // reference "respectable fix" = restore to the original level (one valid fix of many)
      runScript(BIN, [...cmds, degrade, { command: "set_track_volume", args: { trackId: `\${T${ti}}`, db: levels[ti] } }, { command: "export_audio", args: { file: wavA } }], `${session}-ra`);
      if (existsSync(wavB) && existsSync(wavA)) pair.renders = { before: wavB, after: wavA };
    }
    pairs.push(pair);
    process.stderr.write(`  ${pair.id} "${utt}" (${levels[ti]} → ${degradedDb} dB)\n`);
  }
  const outPath = join(OUT_DIR, "pairs.jsonl");
  writeFileSync(outPath, pairs.map((p) => JSON.stringify(p)).join("\n") + "\n");
  writeFileSync(
    join(OUT_DIR, "manifest.json"),
    JSON.stringify({ class: "gain-staging", n: pairs.length, rendered: pairs.filter((p) => p.renders).length, createdAt: new Date().toISOString(), note: "PILOT — owner blind spot-check required before these feed training (audit Stage 1)." }, null, 2),
  );
  console.log(`corrective-pilot: ${pairs.length} pair(s) → ${outPath}; ${pairs.filter((p) => p.renders).length} rendered pair(s) → ${ART}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
