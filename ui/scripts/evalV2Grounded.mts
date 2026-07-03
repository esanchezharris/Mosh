// Frozen-eval-v2 §B — grounded-execution section (training program Stage 1.6,
// pre-registered in docs/bench/PROGRAM_STAGE1_2026-07.md §P4).
//
// PolicyProbe-style REAL apply on a FRESH session fixture that shares no entity
// names with any training SETUP profile (basic/rich/renders/rendered/proposals),
// the eval-§A profile (Kick/Keys/Sub/Lead/Drop), or the probe-v2 session
// (Drums/Piano/Bass/Guitar/Vocal): ~40 grounded intents across command families
// + ~20 negatives (absent entities / invented files / empty targets) where the
// correct behavior is to ask, not act.
//
// Grading is the shared pipeline: catalog → session-id grounding →
// file-existence → REAL engine apply (groundedApply). The ⛳ Stage-2 exit-gate
// leg read from this section: grounded clean-apply = clean/positives ≥ 85%,
// with wrong-defer tracked (the huh-over-generalization guard).
//
//   # serve a model first (mlx_lm.server or cloud), then:
//   cd ui && OPENAI_BASE_URL=http://127.0.0.1:8080/v1 OPENAI_API_KEY=local \
//     npx tsx scripts/evalV2Grounded.mts --model <served-id> [--rules examples] \
//       [--no-think] [--bin /Applications/Mosh.app/Contents/MacOS/Mosh]
//
// Artifacts → ~/mosh-bench-artifacts/eval-v2/sectionB.<model>.<rules>.json
// This file is sha-frozen at WP-7 (the freeze commit records its sha256); after
// that, intent edits invalidate the pre-registration.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt, DEFAULT_RULES, parseReply } from "../src/agent/brainCore";
import { RULES_WITH_EXAMPLES } from "../src/agent/fewshot";
import { argFlag, brainConfigFromEnv, callBrain, findBin, loadEnv, snapshotAt, type BrainUsage, type Cmd } from "./lib/realEngine.mts";
import { gradeApply, snapshotIds } from "./lib/groundedApply.mts";

const OUT_DIR = join(homedir(), "mosh-bench-artifacts", "eval-v2");
const SESSION = "eval-v2-sectionB";

// The §B fixture session — entity names disjoint from every other fixture.
const SETUP: Cmd[] = [
  { command: "create_track", args: { name: "Perc", type: "drum" } },
  { command: "create_track", args: { name: "Organ" }, capture: { TORGAN: "trackId" } },
  { command: "create_track", args: { name: "Rhodes" }, capture: { TRHODES: "trackId" } },
  { command: "create_track", args: { name: "Hook Vox" }, capture: { TVOX: "trackId" } },
  { command: "add_midi_clip", args: { trackId: "${TORGAN}", start: 0, length: 8 }, capture: { CORGAN: "clipId" } },
  { command: "add_note", args: { clipId: "${CORGAN}", pitch: 48, start: 0, length: 1, velocity: 92 } },
  { command: "add_note", args: { clipId: "${CORGAN}", pitch: 55, start: 2, length: 1, velocity: 84 } },
  { command: "add_note", args: { clipId: "${CORGAN}", pitch: 60, start: 4, length: 2, velocity: 100 } },
  { command: "add_test_tone_clip", args: { trackId: "${TRHODES}", seconds: 2, freq: 220 }, capture: { CRHODES: "clipId" } },
  { command: "load_builtin", args: { trackId: "${TORGAN}", type: "eq" } },
  { command: "create_section", args: { name: "Bridge", startBeat: 8, endBeat: 24 } },
  { command: "create_annotation", args: { text: "swap this chord voicing", beat: 12 } },
];
// FIXTURE-VALIDATION NOTE (2026-07-03, cloud dry-run before freeze): the serving
// snapshot exposes ONLY tempo/timesig + sections + tracks/clips. Positives must
// therefore be observable-entity or purely ADDITIVE ops; anything requiring the
// model to see plugins / render layers / lyric lines / note counts is a harness
// artifact (the v1-probe lesson) and was rewritten. The SETUP deliberately has
// NO render layer (so "re-imagine" doesn't collide with layer-exists) and no
// lyric lines (so "write line 1" is a fresh, user-specified append).

type Intent = { user: string; deferExpected: boolean; family: string };

const INTENTS: Intent[] = [
  // — transport / global (5)
  { user: "set the tempo to 84", deferExpected: false, family: "global" },
  { user: "bump the tempo up a bit", deferExpected: false, family: "global" },
  { user: "put us in 6/8", deferExpected: false, family: "global" },
  { user: "set the key to F minor", deferExpected: false, family: "global" },
  { user: "turn the metronome on", deferExpected: false, family: "global" },
  // — track mixer (8)
  { user: "mute the Perc track", deferExpected: false, family: "mixer" },
  { user: "solo the Organ", deferExpected: false, family: "mixer" },
  { user: "pan the Rhodes hard left", deferExpected: false, family: "mixer" },
  { user: "set the Hook Vox volume to -4 dB", deferExpected: false, family: "mixer" },
  { user: "bring the Organ down a touch", deferExpected: false, family: "mixer" },
  { user: "rename the Rhodes track to Keys 2", deferExpected: false, family: "mixer" },
  { user: "arm the Hook Vox for recording", deferExpected: false, family: "mixer" },
  { user: "make a new track called Texture", deferExpected: false, family: "mixer" },
  // — clips (8)
  { user: "move the Organ clip to start at bar 5", deferExpected: false, family: "clips" },
  { user: "split the clip on the Rhodes track down the middle", deferExpected: false, family: "clips" },
  { user: "duplicate the Organ clip", deferExpected: false, family: "clips" },
  { user: "turn the clip on the Rhodes track down by 3 dB", deferExpected: false, family: "clips" },
  { user: "mute the Organ clip", deferExpected: false, family: "clips" },
  { user: "rename the Organ clip to Chords", deferExpected: false, family: "clips" },
  { user: "trim a bar off the end of the Organ clip", deferExpected: false, family: "clips" },
  { user: "delete the clip on the Rhodes track", deferExpected: false, family: "clips" },
  // — notes / MIDI (4) — additive or clip-scoped only (note counts are invisible)
  { user: "add a low C at the start of the Organ clip", deferExpected: false, family: "notes" },
  { user: "quantize the Organ clip to 16ths", deferExpected: false, family: "notes" },
  { user: "drop a MIDI clip on the Hook Vox track", deferExpected: false, family: "notes" },
  { user: "put a short high note at bar 2 of the Organ clip", deferExpected: false, family: "notes" },
  // — sections / arrangement (3)
  { user: "add a section called Outro from bar 24 to 32", deferExpected: false, family: "sections" },
  { user: "rename the Bridge section to Middle 8", deferExpected: false, family: "sections" },
  { user: "move the Bridge to start at bar 12", deferExpected: false, family: "sections" },
  // — plugins (3) — additive only, single-word types the user's own word supplies
  // (loaded plugins are invisible; "Mosh OTT"→type moshOTT is unguessable → excluded)
  { user: "put a reverb on the Rhodes", deferExpected: false, family: "plugins" },
  { user: "add an EQ to the Hook Vox", deferExpected: false, family: "plugins" },
  { user: "put a delay on the Perc track", deferExpected: false, family: "plugins" },
  // — generative (2) — create+render on a layer-free clip; section-scoped per the rules
  { user: "re-imagine the clip on the Rhodes track", deferExpected: false, family: "render" },
  { user: "rework the Bridge", deferExpected: false, family: "render" },
  // — lyrics (1) — additive; no sheet in SETUP so create applies clean (engine
  // check: set_lyric_line does NOT auto-create → line-write intents punish one
  // reasonable strategy either way and were excluded as instrument-ambiguous)
  { user: "start a lyric sheet on the Hook Vox track about a long summer", deferExpected: false, family: "lyrics" },
  // — master / system (3)
  { user: "set the master volume to -3 dB", deferExpected: false, family: "system" },
  { user: "save the project", deferExpected: false, family: "system" },
  { user: "undo that", deferExpected: false, family: "system" },

  // ───── negatives: absent entities / invented files — correct = ask (20)
  { user: "mute the Strings track", deferExpected: true, family: "neg-track" },
  { user: "pan the Choir hard right", deferExpected: true, family: "neg-track" },
  { user: "solo the Brass section track", deferExpected: true, family: "neg-track" },
  { user: "turn the Timpani up 2 dB", deferExpected: true, family: "neg-track" },
  { user: "rename the Synth Lead track to Acid", deferExpected: true, family: "neg-track" },
  { user: "delete the Ambient track", deferExpected: true, family: "neg-track" },
  { user: "arm the Talkback track", deferExpected: true, family: "neg-track" },
  { user: "move the clip on the Perc track to bar 9", deferExpected: true, family: "neg-clip" },      // Perc has no clips (visible)
  { user: "split the Hook Vox clip in half", deferExpected: true, family: "neg-clip" },               // no clip there (visible)
  { user: "duplicate the clip on the Flute track", deferExpected: true, family: "neg-clip" },
  { user: "rename the clip on the Hook Vox track to Take 2", deferExpected: true, family: "neg-clip" },
  { user: "quantize the Sitar clip to 8ths", deferExpected: true, family: "neg-notes" },
  { user: "delete the third note in the Rhodes clip", deferExpected: true, family: "neg-notes" },     // wave clip (visible type) — no MIDI notes
  { user: "rename the Chorus section to Hook", deferExpected: true, family: "neg-section" },          // no Chorus section (sections visible)
  { user: "remove the Intro section", deferExpected: true, family: "neg-section" },
  { user: "bypass the compressor on the Rhodes", deferExpected: true, family: "neg-plugin" },         // acting cannot succeed: Rhodes has no plugin
  { user: "import ~/Music/that-bounce-from-last-week.wav onto the Perc track", deferExpected: true, family: "neg-file" },
  { user: "load /tmp/vocal-take-final-FINAL2.wav onto a new track", deferExpected: true, family: "neg-file" },
  { user: "map ~/Samples/hugekick.wav to pad 3 on the Perc track", deferExpected: true, family: "neg-file" },
  { user: "accept the render on the Perc clip", deferExpected: true, family: "neg-render" },          // Perc has no clips (visible)
];

type Graded = {
  user: string; deferExpected: boolean; family: string;
  outcome: "clean" | "partial" | "failed" | "deferred-ok" | "deferred-wrong" | "parse-error";
  commands: number; applied: number; classes: string[]; detail: string;
};

async function main() {
  const env = loadEnv();
  const bin = findBin(argFlag("bin"));
  const rules = argFlag("rules") === "examples" ? RULES_WITH_EXAMPLES : DEFAULT_RULES;
  mkdirSync(OUT_DIR, { recursive: true });

  const { snap } = snapshotAt(bin, SETUP, SESSION);
  const ids = snapshotIds(snap);
  if (!ids.size) throw new Error("setup produced an empty snapshot — engine problem");
  const system = buildSystemPrompt(rules, snap);

  const cfg = brainConfigFromEnv(env, argFlag("model"));
  const usage: BrainUsage = { promptTokens: 0, completionTokens: 0, calls: 0 };
  const graded: Graded[] = [];

  for (const it of INTENTS) {
    let content = "";
    try {
      content = (await callBrain(cfg, [{ role: "system", content: system }, { role: "user", content: it.user }], usage)).content;
    } catch (e) {
      graded.push({ ...pick(it), outcome: "parse-error", commands: 0, applied: 0, classes: ["brain-error"], detail: String((e as Error).message).slice(0, 120) });
      continue;
    }
    const reply = parseReply(content);
    const cmds = reply.commands ?? [];
    if (cmds.length === 0) {
      graded.push({ ...pick(it), outcome: it.deferExpected ? "deferred-ok" : "deferred-wrong", commands: 0, applied: 0, classes: [], detail: reply.say ?? reply.intent ?? "(deferred)" });
      continue;
    }
    const { applied, classes } = gradeApply(bin, SETUP, ids, cmds, SESSION + "-grade", snap);
    const allGood = applied === cmds.length && classes.length === 0;
    const outcome: Graded["outcome"] = it.deferExpected
      ? "deferred-wrong"
      : allGood ? "clean" : applied > 0 ? "partial" : "failed";
    graded.push({ ...pick(it), outcome, commands: cmds.length, applied, classes, detail: classes.join(",") || "ok" });
  }

  const tally = (o: Graded["outcome"]) => graded.filter((g) => g.outcome === o).length;
  const positives = graded.filter((g) => !g.deferExpected).length;
  const negatives = graded.length - positives;
  const classTally: Record<string, number> = {};
  for (const g of graded) for (const c of g.classes) classTally[c] = (classTally[c] ?? 0) + 1;
  const summary = {
    n: graded.length, positives, negatives,
    clean: tally("clean"), groundedCleanApply: Number((tally("clean") / positives).toFixed(4)),
    deferredOk: tally("deferred-ok"), negativeDeferRate: Number((tally("deferred-ok") / negatives).toFixed(4)),
    partial: tally("partial"), failed: tally("failed"), deferredWrong: tally("deferred-wrong"),
    parseError: tally("parse-error"), classes: classTally,
  };
  const report = { model: cfg.model, base: cfg.base, rules: argFlag("rules") ?? "default", session: SESSION, summary, perIntent: graded, usage };
  const outPath = join(OUT_DIR, `sectionB.${cfg.model.replace(/[^\w.-]+/g, "_")}.${argFlag("rules") ?? "default"}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`\n[§B] clean ${summary.clean}/${positives} (${(summary.groundedCleanApply * 100).toFixed(1)}%) · ` +
    `defer-ok ${summary.deferredOk}/${negatives} · wrong-defer ${summary.deferredWrong} · classes ${JSON.stringify(classTally)}\nreport → ${outPath}`);
}

function pick(it: Intent) { return { user: it.user, deferExpected: it.deferExpected, family: it.family }; }

await main();
