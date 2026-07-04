// Policy probe v2 — the HONEST grounded clean-apply baseline (training program
// docs/plans/MOSHI_TRAINING_PROGRAM_2026-07.md, Stage 0.2).
//
// The v1 probe (2026-07-02, scratch) was structurally incoherent: its prompts said
// "tracks: (none)", its intents referenced training-set track names ("the Piano
// track"), and execution ran against a third, unrelated session — so its 10/8/5
// split measured the harness, not the model. v2 mirrors SERVING exactly:
//   • ONE deterministic session, built through the real engine (`--run-script`);
//   • the prompt is buildSystemPrompt(DEFAULT_RULES, <live __snapshot>) — the
//     byte-identical serving prompt (brain.ts sends the same thing);
//   • generated commands are graded catalog→grounding→file-existence→REAL apply.
//
// Two arms:
//   grounded — 30 intents whose targets exist in the live session (+6 negatives
//              where the CORRECT behavior is to defer, not invent);
//   prior    — the v1 probe's 30 intents verbatim (fixture): with a live session in
//              the prompt almost every one references an absent track, so this arm
//              measures negative handling at scale + keeps v1 comparability.
//
//   # serve a model first (mlx_lm.server or cloud), then:
//   cd ui && OPENAI_BASE_URL=http://127.0.0.1:8080/v1 OPENAI_API_KEY=local \
//     npm run policy-probe -- --model <served-id> [--arm grounded|prior|both] \
//       [--rules examples] [--bin /Applications/Mosh.app/Contents/MacOS/Mosh]
//
// Artifacts → ~/mosh-bench-artifacts/policy-probe-v2/ (report.json + replies).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt, DEFAULT_RULES, parseReply } from "../src/agent/brainCore";
import { RULES_WITH_EXAMPLES } from "../src/agent/fewshot";
import { fileURLToPath } from "node:url";
import { argFlag, brainConfigFromEnv, callBrain, findBin, loadEnv, snapshotAt, type BrainUsage, type Cmd } from "./lib/realEngine.mts";
import { gradeApply, snapshotIds } from "./lib/groundedApply.mts";

const HERE = fileURLToPath(new URL(".", import.meta.url));

const OUT_DIR = join(homedir(), "mosh-bench-artifacts", "policy-probe-v2");
const SESSION = "policy-probe-v2";

// Deterministic session (engine ids are deterministic for the same command prefix —
// the bench cases rely on this; the grade phase re-runs SETUP and asserts the
// snapshot matches the dump-phase one before applying generated commands).
const SETUP: Cmd[] = [
  { command: "create_track", args: { name: "Drums", type: "drum" } },
  { command: "create_track", args: { name: "Piano" } },
  { command: "create_track", args: { name: "Bass" } },
  { command: "create_track", args: { name: "Guitar" } },
  { command: "create_track", args: { name: "Vocal" } },
  { command: "add_midi_clip", args: { trackId: "${TPIANO}", start: 0, length: 4 } },
  { command: "add_midi_clip", args: { trackId: "${TGUITAR}", start: 0, length: 4 } },
];
// capture syntax: bind ids as they are created (verify-harness ${VAR} convention)
SETUP[1].capture = { TPIANO: "trackId" };
SETUP[3].capture = { TGUITAR: "trackId" };

type Intent = { user: string; deferExpected: boolean; note?: string };

// 30 grounded intents — same intent FAMILIES as the v1 probe, rebound to tracks
// that actually exist in the live session; 6 negatives where deferring is correct.
const GROUNDED: Intent[] = [
  { user: "set the tempo to 92", deferExpected: false },
  { user: "crank the tempo up to 150", deferExpected: false },
  { user: "Push the Piano track to the middle.", deferExpected: false },
  { user: "Push the Bass track to the middle.", deferExpected: false },
  { user: "Push the Guitar track to the middle.", deferExpected: false },
  { user: "turn the Vocal track down a little", deferExpected: false },
  { user: "bring the Bass up a bit", deferExpected: false },
  { user: "set the Drums track volume to -6 dB", deferExpected: false },
  { user: "Can you put a MIDI clip on the Piano track?", deferExpected: false },
  { user: "Can you put a MIDI clip on the Bass track?", deferExpected: false },
  { user: "Can you put a MIDI clip on the Guitar track?", deferExpected: false },
  { user: "Can you put a MIDI clip on the Vocal track?", deferExpected: false },
  { user: "Can you put a MIDI clip on the Drums track?", deferExpected: false },
  { user: "drop an empty MIDI clip on the Piano track at bar 3", deferExpected: false },
  { user: "Sketch a short pattern in the clip on the Piano track.", deferExpected: false },
  { user: "Sketch a short pattern in the clip on the Guitar track.", deferExpected: false },
  { user: "write a short pattern into the clip on the Piano track", deferExpected: false },
  { user: "put some notes in the Guitar clip", deferExpected: false },
  { user: "add a simple melody to the clip on the Piano track", deferExpected: false },
  { user: "fill the Guitar track's clip with a riff", deferExpected: false },
  { user: "mute the Guitar track", deferExpected: false },
  { user: "solo the Drums", deferExpected: false },
  { user: "rename the Vocal track to Lead Vox", deferExpected: false },
  { user: "call the Bass track 808 from now on", deferExpected: false },
  // negatives — the referenced track/file does not exist; correct = defer/ask
  { user: "Can you put a MIDI clip on the Flute track?", deferExpected: true },
  { user: "Sketch a short pattern in the clip on the Trumpet track.", deferExpected: true },
  { user: "Push the Strings track to the middle.", deferExpected: true },
  { user: "delete the Horns track", deferExpected: true },
  { user: "import ~/Music/nonexistent-loop-xyz.wav onto the Piano track", deferExpected: true },
  { user: "import /tmp/definitely-not-here-9932.wav", deferExpected: true },
];

type Graded = {
  user: string;
  deferExpected: boolean;
  outcome: "clean" | "partial" | "failed" | "deferred-ok" | "deferred-wrong" | "parse-error";
  commands: number;
  applied: number;
  classes: string[]; // stale-id | invented-file | validation | apply-error
  detail: string;
};

async function main() {
  const env = loadEnv();
  const bin = findBin(argFlag("bin"));
  const rules = argFlag("rules") === "examples" ? RULES_WITH_EXAMPLES : DEFAULT_RULES;
  const armSel = argFlag("arm", "both") as "grounded" | "prior" | "both";
  mkdirSync(OUT_DIR, { recursive: true });

  // live snapshot through the real engine — THE fix over v1
  const { snap } = snapshotAt(bin, SETUP, SESSION);
  const ids = snapshotIds(snap);
  if (!ids.size) throw new Error("setup produced an empty snapshot — engine problem");
  const system = buildSystemPrompt(rules, snap);
  console.log(`session ids: ${[...ids].join(", ")}`);

  const prior: Intent[] = (JSON.parse(readFileSync(join(HERE, "fixtures", "policyProbePriorIntents.json"), "utf8")) as { user: string; groundable?: boolean }[])
    .map((p) => ({ user: p.user, deferExpected: !p.groundable, note: "v1-replay" }));
  const arms: Record<string, Intent[]> = {};
  if (armSel !== "prior") arms.grounded = GROUNDED;
  if (armSel !== "grounded") arms.prior = prior;

  const cfg = brainConfigFromEnv(env, argFlag("model"));
  const usage: BrainUsage = { promptTokens: 0, completionTokens: 0, calls: 0 };
  const report: Record<string, unknown> = { model: cfg.model, base: cfg.base, rules: argFlag("rules") ?? "default", session: SESSION };

  for (const [arm, intents] of Object.entries(arms)) {
    const graded: Graded[] = [];
    for (const it of intents) {
      let content = "";
      try {
        content = (await callBrain(cfg, [{ role: "system", content: system }, { role: "user", content: it.user }], usage)).content;
      } catch (e) {
        graded.push({ user: it.user, deferExpected: it.deferExpected, outcome: "parse-error", commands: 0, applied: 0, classes: ["brain-error"], detail: String((e as Error).message).slice(0, 120) });
        continue;
      }
      const reply = parseReply(content);
      const cmds = reply.commands ?? [];
      if (cmds.length === 0) {
        graded.push({ user: it.user, deferExpected: it.deferExpected, outcome: it.deferExpected ? "deferred-ok" : "deferred-wrong", commands: 0, applied: 0, classes: [], detail: reply.say ?? reply.intent ?? "(deferred)" });
        continue;
      }
      // pre-flight (catalog → grounding → file existence) + real apply, shared grader
      const { applied, classes } = gradeApply(bin, SETUP, ids, cmds, SESSION + "-grade", snap);
      const allGood = applied === cmds.length && classes.length === 0;
      const outcome: Graded["outcome"] = it.deferExpected
        ? "deferred-wrong" // emitted commands where deferring was correct — even if they apply
        : allGood ? "clean" : applied > 0 ? "partial" : "failed";
      graded.push({ user: it.user, deferExpected: it.deferExpected, outcome, commands: cmds.length, applied, classes, detail: classes.join(",") || "ok" });
    }
    const tally = (o: Graded["outcome"]) => graded.filter((g) => g.outcome === o).length;
    const classTally: Record<string, number> = {};
    for (const g of graded) for (const c of g.classes) classTally[c] = (classTally[c] ?? 0) + 1;
    const positives = graded.filter((g) => !g.deferExpected).length;
    const negatives = graded.length - positives;
    (report as any)[arm] = {
      n: graded.length, positives, negatives,
      clean: tally("clean"), partial: tally("partial"), failed: tally("failed"),
      deferredWrong: tally("deferred-wrong"), deferredOk: tally("deferred-ok"),
      parseError: tally("parse-error"), classes: classTally, perIntent: graded,
    };
    console.log(`\n[${arm}] n=${graded.length}  clean ${tally("clean")}/${positives} grounded-positives · ` +
      `deferred-ok ${tally("deferred-ok")}/${negatives} negatives · partial ${tally("partial")} · failed ${tally("failed")} · ` +
      `wrong-defer ${tally("deferred-wrong")} · classes ${JSON.stringify(classTally)}`);
  }
  (report as any).usage = usage;
  const outPath = join(OUT_DIR, `report.${cfg.model.replace(/[^\w.-]+/g, "_")}.${argFlag("rules") ?? "default"}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`\nreport → ${outPath}`);
}

await main();
