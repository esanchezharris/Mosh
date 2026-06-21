// Resolve an import program's logical refs and replay it through the mock
// backend (the Phase-0 verifier substrate), reporting clean-validate/clean-apply.
//
// The program starts from a clean slate (new_project — an unscored setup, like a
// human starting an empty session), then runs the agent-callable commands. As
// each create_track / add_*_clip returns its engine-assigned id, the binder maps
// the command's `bind` ref → that id and substitutes "$ref" args in later commands.

import type { Snapshot, CommandResult } from "../types";
import { __resetMockForTests, mockExecute, mockSnapshot } from "../bridge.mock";
import { validateCommand } from "../agent/commands";
import type { ImportProgram } from "./emit";

export type PerProgramCommand = {
  idx: number;
  command: string;
  validate: "ok" | string;
  apply: "ok" | "error" | "skipped";
  error?: string;
};

export type ProgramResult = {
  cleanValidate: boolean;
  cleanApply: boolean;
  total: number;
  applied: number;
  perCommand: PerProgramCommand[];
  finalSnapshot: Snapshot;
  unbound: string[]; // logical refs that never resolved
};

function resolveArgs(
  args: Record<string, unknown>,
  env: Map<string, string>,
): { resolved: Record<string, unknown>; missing: string[] } {
  const resolved: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && v.startsWith("$")) {
      const real = env.get(v.slice(1));
      if (real === undefined) missing.push(v);
      else resolved[k] = real;
    } else {
      resolved[k] = v;
    }
  }
  return { resolved, missing };
}

export async function replayProgram(program: ImportProgram): Promise<ProgramResult> {
  __resetMockForTests();
  await mockExecute<CommandResult>({ command: "new_project", args: {} }); // clean slate (unscored setup)

  const env = new Map<string, string>();
  const perCommand: PerProgramCommand[] = [];
  const unbound: string[] = [];
  let cleanValidate = true;
  let cleanApply = true;
  let applied = 0;

  for (let idx = 0; idx < program.commands.length; idx++) {
    const bc = program.commands[idx];
    const { resolved, missing } = resolveArgs(bc.args, env);

    if (missing.length) {
      cleanValidate = false;
      cleanApply = false;
      unbound.push(...missing);
      perCommand.push({ idx, command: bc.command, validate: `unbound ref ${missing.join(", ")}`, apply: "skipped" });
      continue;
    }

    const verr = validateCommand(bc.command, resolved);
    if (verr) {
      cleanValidate = false;
      cleanApply = false;
      perCommand.push({ idx, command: bc.command, validate: verr, apply: "skipped" });
      continue;
    }

    const res = await mockExecute<CommandResult>({ command: bc.command, args: resolved });
    if (res.ok) {
      applied++;
      perCommand.push({ idx, command: bc.command, validate: "ok", apply: "ok" });
      if (bc.bind) {
        const data = (res.data ?? {}) as Record<string, unknown>;
        const id = data.trackId ?? data.clipId;
        if (typeof id === "string") env.set(bc.bind, id);
      }
    } else {
      cleanApply = false;
      perCommand.push({ idx, command: bc.command, validate: "ok", apply: "error", error: res.error });
    }
  }

  const finalSnapshot = await mockSnapshot<Snapshot>();
  return { cleanValidate, cleanApply, total: program.commands.length, applied, perCommand, finalSnapshot, unbound };
}
