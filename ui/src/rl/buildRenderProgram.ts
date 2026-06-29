// Rung-2 render-program builder — the id-correct half of the missing middle.
//
// The policy's reply references CONCRETE ids from the mock snapshot it saw ("1","2",…,
// sequential — bridge.mock `nextTrackId`). The native render session assigns its OWN ids
// (Tracktion `EditItemID`, "allocator-dependent, differs per process" — src/state/Ids.h),
// so the reply's ids would dangle if rendered verbatim. We bridge it with the native
// `--run-script` capture mechanism ({"capture":{"VAR":"trackId"}} → later `"${VAR}"`):
//
//   1. Replay the task's startCommands through the SAME mock path that built the policy's
//      prompt (reset → new_project → runBound), capturing each `bind` → mock id into `env`.
//   2. Emit those startCommands as native lines: `bind` → `capture`, `$ref` → `${ref}`.
//   3. Remap the reply: any id-typed arg whose value is one of those mock ids → `${bindVar}`
//      (by the env inversion). Refs we can't resolve (e.g. a clip the reply itself created)
//      are left verbatim — they fail at render = honest low reward, never a crash.
//   4. Append `export_audio` → the reward's WAV.
//
// Pure-ish: it drives the in-memory mock (deterministic, no engine, no audio), so it stays
// unit-testable. The actual native render + audio scoring happen downstream in Python.

import { __resetMockForTests, mockExecute } from "../bridge.mock";
import { runBound } from "../gepa/metric";
import { parseReply } from "../agent/brainCore";
import type { CommandResult } from "../types";
import type { EvalExample } from "../gepa/evalset";
import type { BoundCommand } from "../import/emit";

/** A native `--run-script` line: a command, args, and an optional result-capture. */
export type RunScriptLine = {
  command: string;
  args: Record<string, unknown>;
  capture?: Record<string, string>;
};

export type RenderProgram = {
  /** native run-script lines: resolved startCommands + remapped reply + export_audio */
  lines: RunScriptLine[];
  /** the SEED-alone program: resolved startCommands + export_audio, WITHOUT the policy's edit.
   *  For delta-reward (composite(seed+edit) − composite(seed)) so banking the seed scores ~0 and
   *  only a genuine improvement (or breakage) moves the reward. Identical across a prompt's rollouts
   *  (same startCommands) → the scorer's program-fingerprint cache renders it once per prompt. */
  seedLines: RunScriptLine[];
  /** true when the policy emitted no commands (the "acts-shy" failure → reward 0, no render) */
  deferred: boolean;
  /** non-fatal notes (unresolved id refs left verbatim) — surfaced in the reward feedback */
  warnings: string[];
};

/** The result field a creating command binds (mirrors runBound: trackId ?? clipId). */
function captureField(command: string): "trackId" | "clipId" {
  return command === "create_track" || command === "create_group" ? "trackId" : "clipId";
}

const REF_RE = /^\$([A-Za-z_]\w*)$/;

/** Translate a BoundCommand (logical `$ref` args + `bind`) into a native run-script line. */
function startToLine(bc: BoundCommand): RunScriptLine {
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bc.args)) {
    const m = typeof v === "string" ? v.match(REF_RE) : null;
    args[k] = m ? `\${${m[1]}}` : v;
  }
  const line: RunScriptLine = { command: bc.command, args };
  if (bc.bind) line.capture = { [bc.bind]: captureField(bc.command) };
  return line;
}

const isIdKey = (k: string) => /id$/i.test(k);

/** Build the native render program for one (task, policy reply). Empty reply → deferred. */
export async function buildRenderProgram(
  ex: EvalExample,
  replyContent: string,
  outWav: string,
  format = "wav",
): Promise<RenderProgram> {
  const reply = (parseReply(replyContent).commands ?? []).map(
    (c): BoundCommand => ({ command: c.command, args: c.args ?? {} }),
  );
  if (reply.length === 0) return { lines: [], seedLines: [], deferred: true, warnings: [] };

  // 1) replay startCommands through the mock exactly as the prompt was built → env: bind→mockId
  __resetMockForTests();
  await mockExecute<CommandResult>({ command: "new_project", args: {} });
  const env = new Map<string, string>();
  await runBound(ex.startCommands, env);
  const mockIdToVar = new Map<string, string>([...env].map(([bindVar, id]) => [id, bindVar]));

  // 2) startCommands → native lines (bind→capture, $ref→${ref})
  const lines: RunScriptLine[] = ex.startCommands.map(startToLine);
  // the seed-alone program (startCommands + export, no edit) for delta-reward; exports to a
  // sibling .seed.wav. The program-fingerprint cache (export path stripped) renders it once/prompt.
  const seedWav = outWav.replace(/\.wav$/i, ".seed.wav");
  const seedLines: RunScriptLine[] = [...lines, { command: "export_audio", args: { file: seedWav, format } }];

  // 3) reply → native lines, remapping id-typed args that point at a startCommand-created id
  const warnings: string[] = [];
  for (const bc of reply) {
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(bc.args)) {
      if (isIdKey(k) && typeof v === "string" && mockIdToVar.has(v)) {
        args[k] = `\${${mockIdToVar.get(v)}}`;
      } else {
        args[k] = v;
        if (isIdKey(k) && typeof v === "string" && /^\d+$/.test(v)) {
          warnings.push(`${bc.command}.${k}=${v} unresolved (not a setup id) — left verbatim`);
        }
      }
    }
    lines.push({ command: bc.command, args });
  }

  lines.push({ command: "export_audio", args: { file: outWav, format } });
  return { lines, seedLines, deferred: false, warnings };
}
