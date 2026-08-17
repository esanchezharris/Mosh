// Task 3 — the ownership-bound foundry lock. One lock guards every mutation across the
// whole slice; `withFoundryLockV1` is the only place that acquires or releases it.
//
// DESIGN DECISION (mutual exclusion primitive): the plan says the lock is "in an atomically
// renamed directory". Our lock directory is NEVER left empty once staged — it always
// contains `metadata.json` before the rename — so `fs.rename(staging, lockPath)` gives real
// exclusivity for free: POSIX rename onto an existing NON-empty directory fails with
// ENOTEMPTY rather than silently replacing it, so a second acquirer's rename genuinely fails
// closed instead of racing an rmdir+mkdir pair. `fs.rename` onto a not-yet-existing lockPath
// succeeds atomically as the single OS-level acquire step.
//
// Stale-lock reclaim uses `/bin/ps -o lstart= -p PID` (per plan) to distinguish a dead
// holder / PID reuse from a live one, exactly as CLAUDE.md's existing convention for this
// repo describes.

import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { FoundryLockMetadataV1 } from "./contracts";
import { atomicWriteBytesV1, fsyncDirectoryV1 } from "./safeFs";
import { canonicalJsonBytes } from "../agent/skillFoundry/hash";

const execFileAsync = promisify(execFile);

export class FoundryLockContentionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FoundryLockContentionError";
  }
}

export type FoundryLockDepsV1 = {
  now?: () => Date;
  readProcessStartIdentity?: (pid: number) => Promise<string | null>;
  pid?: number;
};

/** `/bin/ps -o lstart= -p PID` -> trimmed start-time string, or `null` if the pid is dead. */
export async function readProcessStartIdentityV1(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-o", "lstart=", "-p", String(pid)]);
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

async function readLockMetadataV1(lockPath: string): Promise<FoundryLockMetadataV1 | null> {
  try {
    const raw = await readFile(join(lockPath, "metadata.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "nonce" in parsed &&
      "pid" in parsed &&
      "processStartIdentity" in parsed
    ) {
      return parsed as FoundryLockMetadataV1;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Acquire the exclusive foundry lock, run `fn`, always release in `finally`. Retries once
 * after reclaiming a provably stale lock (dead PID or mismatched process-start identity);
 * a live contender's lock throws `FoundryLockContentionError`.
 */
export async function withFoundryLockV1<T>(
  lockPath: string,
  command: string,
  fn: () => Promise<T>,
  deps: FoundryLockDepsV1 = {},
): Promise<T> {
  const now = deps.now ?? (() => new Date());
  const readIdentity = deps.readProcessStartIdentity ?? readProcessStartIdentityV1;
  const pid = deps.pid ?? process.pid;

  const ownIdentity = await readIdentity(pid);
  const nonce = randomUUID();
  const metadata: FoundryLockMetadataV1 = {
    schemaVersion: 1,
    nonce,
    pid,
    processStartIdentity: ownIdentity ?? "unknown",
    command,
    acquiredAt: now().toISOString(),
  };

  await acquireV1(lockPath, metadata, readIdentity);
  try {
    return await fn();
  } finally {
    await releaseV1(lockPath, nonce);
  }
}

async function acquireV1(
  lockPath: string,
  metadata: FoundryLockMetadataV1,
  readIdentity: (pid: number) => Promise<string | null>,
  alreadyReclaimed = false,
): Promise<void> {
  const teachRoot = dirname(lockPath);
  const stagingDir = join(teachRoot, `.lock.tmp-${metadata.nonce}`);
  await mkdir(stagingDir, { recursive: true, mode: 0o700 });
  try {
    await atomicWriteBytesV1(join(stagingDir, "metadata.json"), canonicalJsonBytes(metadata));
    await fsyncDirectoryV1(stagingDir);
    await rename(stagingDir, lockPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTEMPTY" || code === "EEXIST") {
      await rm(stagingDir, { recursive: true, force: true });
      if (alreadyReclaimed) {
        throw new FoundryLockContentionError("foundry lock is held by a live process");
      }
      const existing = await readLockMetadataV1(lockPath);
      if (existing === null) {
        // Unreadable/malformed lock metadata is treated as reclaimable — a healthy lock is
        // always readable, since it was written by this same code path.
        await rm(lockPath, { recursive: true, force: true });
        return acquireV1(lockPath, metadata, readIdentity, true);
      }
      const currentIdentity = await readIdentity(existing.pid);
      const isStale = currentIdentity === null || currentIdentity !== existing.processStartIdentity;
      if (!isStale) {
        throw new FoundryLockContentionError(`foundry lock is held by pid ${existing.pid} (${existing.command})`);
      }
      await rm(lockPath, { recursive: true, force: true });
      return acquireV1(lockPath, metadata, readIdentity, true);
    }
    await rm(stagingDir, { recursive: true, force: true });
    throw err;
  }
}

async function releaseV1(lockPath: string, ownNonce: string): Promise<void> {
  const existing = await readLockMetadataV1(lockPath);
  if (existing !== null && existing.nonce !== ownNonce) {
    // Someone else's (reclaimed) lock now occupies the path — never remove another holder's
    // lock. This should only happen after our own stale-reclaim raced with another acquirer,
    // which the lock protocol already treats as contention; leave it for its true owner.
    return;
  }
  await rm(lockPath, { recursive: true, force: true });
}
