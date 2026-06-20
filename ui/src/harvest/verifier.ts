// Headless deterministic replayer — the Phase-0 verifier substrate.
//
// Given an ordered command sequence, replay it through the JS mock backend
// (the same execute_command + snapshot contract the native engine exposes) and
// report: clean-validate (every command passes the agent allowlist + arg-type
// check), clean-apply (every applied command returns ok), per-command detail,
// the final snapshot, and an optional structural diff vs a target.
//
// This is audio-free, Python-free, native-build-free and deterministic — the
// designated cheap RL-rollout / eval environment. It reuses the mock seam and
// the single-source allowlist; it does NOT build a new simulator, and it does
// NOT go through the React store (so it stays store-free and side-effect-light).

import type { Snapshot, CommandResult } from "../types";
import { __resetMockForTests, mockExecute, mockSnapshot } from "../bridge.mock";
import { validateCommand } from "../agent/commands";
import type { CommandCall } from "./tupleSchema";

// Structural delimiters are emitted around agent turns but are not agent-callable
// edits — they bypass the allowlist check yet still apply through the seam.
const STRUCTURAL = new Set(["batch_begin", "batch_end"]);

// Keys whose values are engine-assigned or runtime-volatile. Ignored by the
// structural diff so re-runs (and mock-vs-native) don't produce false changes.
export const DEFAULT_IGNORE_KEYS = ["id", "logicalId", "ts", "peaks", "levels"];

export type PerCommand = {
  idx: number;
  command: string;
  validate: "ok" | string;
  apply: "ok" | "error" | "skipped";
  error?: string;
};

export type DiffChange = { path: string; a: unknown; b: unknown };
export type SnapshotDiff = { equal: boolean; changes: DiffChange[] };

export type ReplayOptions = {
  /** Commands applied to seed state before the verified sequence (not scored). */
  startCommands?: CommandCall[];
  /** When set, the result carries a structural diff of finalSnapshot vs target. */
  target?: Snapshot;
  /** Override the volatile-key ignore-list used by the diff. */
  ignoreKeys?: string[];
};

export type ReplayResult = {
  cleanValidate: boolean;
  cleanApply: boolean;
  perCommand: PerCommand[];
  finalSnapshot: Snapshot;
  diff?: SnapshotDiff;
};

function validateCall(c: CommandCall): "ok" | string {
  if (STRUCTURAL.has(c.command)) return "ok";
  return validateCommand(c.command, c.args ?? {}) ?? "ok";
}

/** Replay `commands` through a freshly-seeded mock backend and report the verdict. */
export async function replay(commands: CommandCall[], opts: ReplayOptions = {}): Promise<ReplayResult> {
  __resetMockForTests();
  // Trusted, unscored setup: applied as-is to seed state before the verified
  // sequence. It may legitimately include non-agent setup commands, so it is NOT
  // run through the agent allowlist and its results are not folded into the verdict.
  for (const c of opts.startCommands ?? []) {
    await mockExecute<CommandResult>({ command: c.command, args: c.args ?? {} });
  }

  const perCommand: PerCommand[] = [];
  let cleanValidate = true;
  let cleanApply = true;

  for (let idx = 0; idx < commands.length; idx++) {
    const c = commands[idx];
    const v = validateCall(c);
    if (v !== "ok") {
      cleanValidate = false;
      cleanApply = false;
      perCommand.push({ idx, command: c.command, validate: v, apply: "skipped" });
      continue; // invalid commands never reach the seam (mirrors runAgentBatch)
    }
    const res = await mockExecute<CommandResult>({ command: c.command, args: c.args ?? {} });
    if (res.ok) {
      perCommand.push({ idx, command: c.command, validate: "ok", apply: "ok" });
    } else {
      cleanApply = false;
      perCommand.push({ idx, command: c.command, validate: "ok", apply: "error", error: res.error });
    }
  }

  const finalSnapshot = await mockSnapshot<Snapshot>();
  const result: ReplayResult = { cleanValidate, cleanApply, perCommand, finalSnapshot };
  if (opts.target) result.diff = snapshotDiff(finalSnapshot, opts.target, opts.ignoreKeys);
  return result;
}

/** Structural JSON diff with a volatile-key ignore-list. equal === no changes. */
export function snapshotDiff(a: Snapshot, b: Snapshot, ignoreKeys: string[] = DEFAULT_IGNORE_KEYS): SnapshotDiff {
  const ignore = new Set(ignoreKeys);
  const changes: DiffChange[] = [];
  walk(a as unknown, b as unknown, "", ignore, changes);
  return { equal: changes.length === 0, changes };
}

function walk(a: unknown, b: unknown, path: string, ignore: Set<string>, changes: DiffChange[]): void {
  if (a === b) return;

  const aObj = a !== null && typeof a === "object";
  const bObj = b !== null && typeof b === "object";
  if (!aObj || !bObj) {
    changes.push({ path, a, b });
    return;
  }

  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) {
    changes.push({ path, a, b });
    return;
  }

  if (aArr && bArr) {
    if (a.length !== b.length) changes.push({ path: `${path}.length`, a: a.length, b: b.length });
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) walk(a[i], b[i], `${path}[${i}]`, ignore, changes);
    return;
  }

  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
    if (ignore.has(k)) continue;
    walk(ao[k], bo[k], path ? `${path}.${k}` : k, ignore, changes);
  }
}
