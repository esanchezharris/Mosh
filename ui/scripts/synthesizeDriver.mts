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
//     --per 5 [--setup rich] [--out ../service/sft/.sft-data/synth/synth.chat.jsonl] \
//     [--bin /Applications/Mosh.app/Contents/MacOS/Mosh]
//
// --setup <basic|rich|renders|rendered|proposals|eval> picks the SETUP profile
//   (src/sft/synthProfiles.ts): richer profiles carry the prerequisite state the
//   calibration round showed missing (notes, wave clip, builtin, annotation,
//   lyric sheet, render layer). `eval` is RESERVED for frozen-eval-v2 §A — its
//   rows must never enter a training mix (pre-registered, §P4).
//
// --negatives [--twins] switches to grounding-negative synthesis (Stage 1.4,
//   §P3): task-gen writes absent-entity requests + a short clarifying ask
//   (gold = the HUH/defer convention, no engine apply needed) and, with
//   --twins, a grounded twin that flows through the normal answer→grade→keep
//   path. A local filter drops any "absent" request that names a real session
//   entity (over-rejection is the safe direction).
//
// Needs a brain endpoint (OPENAI_BASE_URL/KEY/MODEL via env or ui/.env.local).

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildSystemPrompt, DEFAULT_RULES, parseReply } from "../src/agent/brainCore";
import { AGENT_COMMAND_MAP } from "../src/agent/commands";
import { extractSessionNames, mentionsRealEntity, negativeRow, parseNegativePairs } from "../src/sft/negatives";
import { NEG_TASKGEN_SYS, SETUP_PROFILES, taskgenHint } from "../src/sft/synthProfiles";
import { argFlag, brainConfigFromEnv, callBrain, findBin, loadEnv, snapshotAt, type BrainUsage, type Cmd } from "./lib/realEngine.mts";
import { gradeApply, snapshotIds } from "./lib/groundedApply.mts";
import { ensureSynthAssets } from "./lib/synthAssets.mts";

const SESSION = "synth-driver";

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
  const setupName = argFlag("setup", "basic")!;
  const SETUP = SETUP_PROFILES[setupName] as Cmd[] | undefined;
  if (!SETUP) throw new Error(`unknown --setup ${setupName} (have: ${Object.keys(SETUP_PROFILES).join(", ")})`);
  const negatives = process.argv.includes("--negatives");
  const twins = process.argv.includes("--twins");
  const outPath = resolve(argFlag("out") ?? join("..", "service", "sft", ".sft-data", "synth", "synth.chat.jsonl"));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, ""); // fresh file per run — rows are cheap to regenerate
  // Assets live under ~/Music (a natural user location with a SHORT path): the
  // smoke showed the answering model defers on 100-char worktree paths inside
  // requests, while realistic ~/Music paths read like something a user would say.
  const assets = ensureSynthAssets(join(homedir(), "Music", "mosh-sft-assets"));

  const { snap } = snapshotAt(bin, SETUP, SESSION + (setupName === "basic" ? "" : `-${setupName}`));
  const ids = snapshotIds(snap);
  const names = extractSessionNames(snap);
  const system = buildSystemPrompt(DEFAULT_RULES, snap);
  const sessionBrief = system.slice(system.indexOf("Current session:"));

  const cfg = brainConfigFromEnv(env, argFlag("model"));
  // ── RFT split-provider (program §5 Stage-2.2): task-gen stays on the cloud
  // brain; ANSWERS go to a local mlx_lm server (base + round-N adapter) when
  // --answer-base is given. The answer model is pinned by PATH and verified
  // with a one-token identity probe before any sampling (permanent-harness
  // rule — the /v1/models data[0] trap has fired three times).
  const answerBase = argFlag("answer-base");
  const answerNoThink = process.argv.includes("--answer-no-think");
  let answerCfg = cfg;
  if (answerBase) {
    const answerModel = argFlag("answer-model");
    if (!answerModel) throw new Error("--answer-base requires --answer-model <served model PATH>");
    answerCfg = { base: answerBase, key: argFlag("answer-key", "local")!, model: answerModel };
    const probe = await callBrain(answerCfg, [{ role: "user", content: 'Reply with the word "json": {}' }], undefined, { noThink: answerNoThink });
    if (!probe.content.length) throw new Error(`identity probe FAILED against ${answerBase} for ${answerModel}`);
    console.log(`answer endpoint: ${answerBase} model=${answerModel} (identity probe ok, ${probe.ms}ms)`);
  }
  const usage: BrainUsage = { promptTokens: 0, completionTokens: 0, calls: 0 };
  const report: Record<string, unknown> = { model: cfg.model, answerModel: answerCfg.model, answerBase: answerCfg.base, out: outPath, setup: setupName, negatives, twins, perCommand: {} };
  let kept = 0;

  // Answer one request through the serving prompt and grade it; append + return
  // true iff clean-apply and on-target.
  async function answerAndKeep(target: string, request: string): Promise<{ outcome: string; classes: string[] }> {
    const { content } = await callBrain(answerCfg, [{ role: "system", content: system }, { role: "user", content: request }], usage, { noThink: answerNoThink });
    const reply = parseReply(content);
    const cmds = reply.commands ?? [];
    if (!cmds.length) return { outcome: "deferred", classes: [] };
    const g = gradeApply(bin, SETUP!, ids, cmds, SESSION + "-grade", snap);
    const onTarget = cmds.some((c) => c.command === target);
    if (g.applied === cmds.length && !g.classes.length && onTarget) {
      const assistant = JSON.stringify({ intent: reply.intent ?? "ACK_GOT_IT", commands: cmds });
      appendFileSync(outPath, JSON.stringify({ messages: [
        { role: "system", content: system },
        { role: "user", content: request },
        { role: "assistant", content: assistant },
      ] }) + "\n");
      kept++;
      return { outcome: "kept", classes: [] };
    }
    return { outcome: !onTarget ? "off-target" : "failed-apply", classes: g.classes };
  }

  for (const target of targets) {
    const spec = commandSpec(target);
    const rows: Array<{ request: string; outcome: string; classes: string[] }> = [];

    if (negatives) {
      // ── grounding-negative mode (§P3) ──────────────────────────────────
      try {
        const gen = await callBrain(cfg, [
          { role: "system", content: NEG_TASKGEN_SYS },
          { role: "user", content: `${sessionBrief}\n\nCommand spec: ${spec}\n\nWrite ${per} pairs.` },
        ], usage);
        const pairs = parseNegativePairs(gen.content).slice(0, per);
        for (const pair of pairs) {
          if (mentionsRealEntity(pair.absent, names)) {
            rows.push({ request: pair.absent, outcome: "neg-mentions-real-entity", classes: [] });
          } else {
            appendFileSync(outPath, JSON.stringify(negativeRow(system, pair.absent, pair.ask)) + "\n");
            kept++;
            rows.push({ request: pair.absent, outcome: "kept-negative", classes: [] });
          }
          if (twins && pair.grounded) {
            try {
              const r = await answerAndKeep(target, pair.grounded);
              rows.push({ request: pair.grounded, outcome: r.outcome === "kept" ? "kept-twin" : `twin-${r.outcome}`, classes: r.classes });
            } catch (e) {
              rows.push({ request: pair.grounded, outcome: "twin-brain-error", classes: [String((e as Error).message).slice(0, 80)] });
            }
          }
        }
      } catch (e) {
        (report.perCommand as any)[target] = { error: `neg task-gen failed: ${String((e as Error).message).slice(0, 120)}` };
        continue;
      }
    } else {
      // ── normal coverage mode (§P2) ─────────────────────────────────────
      let requests: string[] = [];
      try {
        const hint = taskgenHint(target, assets, setupName);
        const gen = await callBrain(cfg, [
          { role: "system", content: TASKGEN_SYS },
          { role: "user", content: `${sessionBrief}\n\nCommand spec: ${spec}${hint ? `\n\nContext: ${hint}` : ""}\n\nWrite ${per} distinct requests.` },
        ], usage);
        const parsed = JSON.parse(gen.content.trim().replace(/^```(?:json)?/i, "").replace(/```$/, ""));
        requests = (Array.isArray(parsed?.requests) ? parsed.requests : []).filter((r: unknown) => typeof r === "string").slice(0, per);
      } catch (e) {
        (report.perCommand as any)[target] = { error: `task-gen failed: ${String((e as Error).message).slice(0, 120)}` };
        continue;
      }
      for (const request of requests) {
        try {
          const r = await answerAndKeep(target, request);
          rows.push({ request, ...r });
        } catch (e) {
          rows.push({ request, outcome: "brain-error", classes: [String((e as Error).message).slice(0, 80)] });
        }
      }
    }

    const keptN = rows.filter((r) => r.outcome.startsWith("kept")).length;
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
