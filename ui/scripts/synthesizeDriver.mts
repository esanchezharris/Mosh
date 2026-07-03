// Execution-filtered synthesis driver — the coverage engine of the training
// program (docs/plans/MOSHI_TRAINING_PROGRAM_2026-07.md, Stage 1.3):
//   propose user requests per target command (cloud brain, task-gen call)
//   → answer each through the SERVING prompt (buildSystemPrompt + live snapshot)
//   → grade catalog→grounding→file-existence→REAL engine apply (groundedApply)
//   → keep ONLY clean-apply, on-target rows → chat-JSONL shaped exactly like
//     buildDataset.renderExample output ({messages:[system,user,assistant]}).
//
// Every kept row carries the live snapshot it was generated against (grounding
// data, Stage 1.4). Rejected proposals are logged with their failure class so
// acceptance-rate per command is a first-class output.
//
//   cd ui && npm run synthesize -- --commands set_track_pan,create_section \
//     --per 5 [--k 2] [--out ../service/sft/.sft-data/synth/synth.chat.jsonl] \
//     [--bin /Applications/Mosh.app/Contents/MacOS/Mosh]
//
// Needs a brain endpoint (OPENAI_BASE_URL/KEY/MODEL via env or ui/.env.local).

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildSystemPrompt, DEFAULT_RULES, parseReply } from "../src/agent/brainCore";
import { AGENT_COMMAND_MAP } from "../src/agent/commands";
import { argFlag, brainConfigFromEnv, callBrain, findBin, loadEnv, snapshotAt, type BrainUsage, type Cmd } from "./lib/realEngine.mts";
import { gradeApply, snapshotIds } from "./lib/groundedApply.mts";

const SESSION = "synth-driver";

// A session rich enough that most commands have a live target: named tracks, two
// MIDI clips, one section. (Deterministic — same ids every run.)
const SETUP: Cmd[] = [
  { command: "create_track", args: { name: "Drums", type: "drum" } },
  { command: "create_track", args: { name: "Piano" }, capture: { TPIANO: "trackId" } },
  { command: "create_track", args: { name: "Bass" } },
  { command: "create_track", args: { name: "Vocal" } },
  { command: "add_midi_clip", args: { trackId: "${TPIANO}", start: 0, length: 4 } },
  { command: "create_section", args: { name: "Verse", startBeat: 0, endBeat: 16 } },
];

function commandSpec(name: string): string {
  const c = AGENT_COMMAND_MAP.get(name);
  if (!c) throw new Error(`not an agent command: ${name}`);
  const args = c.args.map((a) => `${a.name}${a.required ? "" : "?"}${a.hint ? ` (${a.hint})` : ""}`).join(", ");
  return `${c.command}(${args}) — ${c.desc}`;
}

const TASKGEN_SYS =
  "You invent realistic user requests for a DAW assistant, for training-data synthesis. " +
  "Given the live session and one command spec, write requests a music producer might " +
  "actually type or say whose correct handling uses that command. Vary style (terse slang " +
  "↔ verbose beginner), refer ONLY to tracks/clips/sections that exist in the session, and " +
  'never mention command names or APIs. Respond ONLY as JSON: {"requests": ["...", "..."]}.';

async function main() {
  const env = loadEnv();
  const bin = findBin(argFlag("bin"));
  const targets = (argFlag("commands") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!targets.length) throw new Error("--commands a,b,c required");
  const per = Number(argFlag("per", "5")) || 5;      // proposals per target command
  const outPath = resolve(argFlag("out") ?? join("..", "service", "sft", ".sft-data", "synth", "synth.chat.jsonl"));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, ""); // fresh file per run — rows are cheap to regenerate

  const { snap } = snapshotAt(bin, SETUP, SESSION);
  const ids = snapshotIds(snap);
  const system = buildSystemPrompt(DEFAULT_RULES, snap);
  const sessionBrief = system.slice(system.indexOf("Current session:"));

  const cfg = brainConfigFromEnv(env, argFlag("model"));
  const usage: BrainUsage = { promptTokens: 0, completionTokens: 0, calls: 0 };
  const report: Record<string, unknown> = { model: cfg.model, out: outPath, perCommand: {} };
  let kept = 0;

  for (const target of targets) {
    const spec = commandSpec(target);
    let requests: string[] = [];
    try {
      const gen = await callBrain(cfg, [
        { role: "system", content: TASKGEN_SYS },
        { role: "user", content: `${sessionBrief}\n\nCommand spec: ${spec}\n\nWrite ${per} distinct requests.` },
      ], usage);
      const parsed = JSON.parse(gen.content.trim().replace(/^```(?:json)?/i, "").replace(/```$/, ""));
      requests = (Array.isArray(parsed?.requests) ? parsed.requests : []).filter((r: unknown) => typeof r === "string").slice(0, per);
    } catch (e) {
      (report.perCommand as any)[target] = { error: `task-gen failed: ${String((e as Error).message).slice(0, 120)}` };
      continue;
    }
    const rows: Array<{ request: string; outcome: string; classes: string[] }> = [];
    for (const request of requests) {
      let outcome = "kept";
      let classes: string[] = [];
      try {
        const { content } = await callBrain(cfg, [{ role: "system", content: system }, { role: "user", content: request }], usage);
        const reply = parseReply(content);
        const cmds = reply.commands ?? [];
        if (!cmds.length) outcome = "deferred";
        else {
          const g = gradeApply(bin, SETUP, ids, cmds, SESSION + "-grade", snap);
          classes = g.classes;
          const onTarget = cmds.some((c) => c.command === target);
          if (g.applied === cmds.length && !classes.length && onTarget) {
            // clean-apply + on-target → a training row, snapshot-grounded by construction
            const assistant = JSON.stringify({ intent: reply.intent ?? "ACK_GOT_IT", commands: cmds });
            appendFileSync(outPath, JSON.stringify({ messages: [
              { role: "system", content: system },
              { role: "user", content: request },
              { role: "assistant", content: assistant },
            ] }) + "\n");
            kept++;
          } else outcome = !onTarget ? "off-target" : "failed-apply";
        }
      } catch (e) {
        outcome = "brain-error";
        classes = [String((e as Error).message).slice(0, 80)];
      }
      rows.push({ request, outcome, classes });
    }
    const keptN = rows.filter((r) => r.outcome === "kept").length;
    (report.perCommand as any)[target] = {
      proposed: rows.length, kept: keptN,
      acceptance: rows.length ? Number((keptN / rows.length).toFixed(2)) : 0,
      detail: rows,
    };
    console.log(`[${target}] proposed ${rows.length} → kept ${keptN}`);
  }
  (report as any).kept = kept;
  (report as any).usage = usage;
  const reportPath = outPath.replace(/\.jsonl$/, ".report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`\nkept ${kept} rows → ${outPath}\nreport → ${reportPath}\n` +
    `tokens: ${usage.promptTokens} in / ${usage.completionTokens} out over ${usage.calls} calls`);
}

await main();
