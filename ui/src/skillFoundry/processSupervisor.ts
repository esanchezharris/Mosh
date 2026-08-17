// Task 6 — the finite, ownership-verified process port. Every certification/repair child
// runs detached in its OWN process group (so termination targets the whole group, not a
// single leaf), with a fixed deadline selected by `ProcessSpecV1.kind`, and is terminated
// only after re-verifying its PID/start-identity immediately before each signal — a PID that
// was reused by an unrelated process after our child exited must never be killed.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ProcessKindV1, ProcessResultV1, ProcessSpecV1, ProcessSupervisorV1 } from "./contracts";
import { readProcessStartIdentityV1 } from "./lock";

const DEFAULT_DEADLINES_MS: Readonly<Record<ProcessKindV1, number>> = Object.freeze({
  mock: 30_000,
  native_or_packaged: 120_000,
  native_or_packaged_gate: 30 * 60_000,
  repair_cycle: 60 * 60_000,
});

const GRACE_MS = 10_000;

export type ProcessSupervisorDepsV1 = {
  readProcessStartIdentity?: (pid: number) => Promise<string | null>;
  /** Test-only: shrink real deadlines so a timeout scenario doesn't need a real 30s wait. */
  deadlinesMsOverride?: Partial<Record<ProcessKindV1, number>>;
  /** Test-only: shrink the real 10s SIGTERM grace period. */
  graceMsOverride?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createProcessSupervisorV1(deps: ProcessSupervisorDepsV1 = {}): ProcessSupervisorV1 {
  const readIdentity = deps.readProcessStartIdentity ?? readProcessStartIdentityV1;
  const graceMs = deps.graceMsOverride ?? GRACE_MS;

  async function run(spec: ProcessSpecV1): Promise<ProcessResultV1> {
    await mkdir(spec.logDirectory, { recursive: true, mode: 0o700 });
    // A unique suffix per run() call, not a fixed "stdout.log": production callers give each
    // certification run its OWN logDirectory, but reusing one directory across retries (as
    // tests sometimes do for convenience) must never collide on an exclusive-create.
    const runSuffix = randomUUID();
    const stdoutPath = join(spec.logDirectory, `stdout-${runSuffix}.log`);
    const stderrPath = join(spec.logDirectory, `stderr-${runSuffix}.log`);
    const stdoutStream = createWriteStream(stdoutPath, { flags: "wx" });
    const stderrStream = createWriteStream(stderrPath, { flags: "wx" });

    const startedAt = new Date().toISOString();
    const child = spawn(spec.executable, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      detached: true, // own process group: child.pid === child's own pgid on POSIX
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.pipe(stdoutStream);
    child.stderr?.pipe(stderrStream);

    const pid = child.pid;
    if (pid === undefined) {
      throw new Error(`failed to spawn: ${spec.executable}`);
    }
    const ownStartIdentity = await readIdentity(pid);

    const deadlineMs = deps.deadlinesMsOverride?.[spec.kind] ?? DEFAULT_DEADLINES_MS[spec.kind];

    let timedOut = false;
    const exitResult = await Promise.race([
      new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
      }),
      sleep(deadlineMs).then(() => {
        timedOut = true;
        return { exitCode: null, signal: null };
      }),
    ]);

    let finalExit = exitResult;
    if (timedOut) {
      finalExit = await terminateVerifiedV1(pid, ownStartIdentity, child, readIdentity, graceMs);
    }

    stdoutStream.close();
    stderrStream.close();
    const finishedAt = new Date().toISOString();

    return {
      exitCode: finalExit.exitCode,
      signal: finalExit.signal,
      timedOut,
      stdoutPath,
      stderrPath,
      pid,
      startedAt,
      finishedAt,
    };
  }

  return { run };
}

async function terminateVerifiedV1(
  pid: number,
  ownStartIdentity: string | null,
  child: ReturnType<typeof spawn>,
  readIdentity: (pid: number) => Promise<string | null>,
  graceMs: number,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  const exited = () =>
    new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null } | null>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve({ exitCode: child.exitCode, signal: child.signalCode });
        return;
      }
      const onExit = (exitCode: number | null, signal: NodeJS.Signals | null): void => resolve({ exitCode, signal });
      child.once("exit", onExit);
      setTimeout(() => {
        child.removeListener("exit", onExit);
        resolve(null);
      }, 0);
    });

  const currentIdentity = await readIdentity(pid);
  if (currentIdentity !== null && currentIdentity === ownStartIdentity) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // Process group already gone.
    }
  }

  await sleep(graceMs);
  const afterGrace = await exited();
  if (afterGrace !== null) return afterGrace;

  const identityAfterGrace = await readIdentity(pid);
  if (identityAfterGrace !== null && identityAfterGrace === ownStartIdentity) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Process group already gone.
    }
  }

  await sleep(50);
  const afterKill = await exited();
  return afterKill ?? { exitCode: null, signal: "SIGKILL" };
}
