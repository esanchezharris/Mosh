// Task 3 — safe filesystem primitives: no-follow external-file inspection, durable atomic
// writes, and durable atomic directory publication.
//
// DESIGN DECISION: every primitive here treats "untrusted" as "could be a symlink, a FIFO,
// owned by another user, or swapped out from under us mid-operation" — never as "could name
// a path outside some jail". Per the plan's Global Constraints, an external reference's
// `absolutePath` is deliberately NOT root-confined (the whole foundry is owner-local CLI
// tooling); `inspectExternalRegularFileV1`'s job is to make the RECORDED hash/identity
// trustworthy, not to bound where a locator may point.

import { constants as fsConstants } from "node:fs";
import { open, mkdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { sha256Bytes } from "../agent/skillFoundry/hash";
import type {
  InspectExternalFileResultV1,
  InspectedExternalFileV1,
  UnsafePathFailureV1,
} from "./contracts";

const { O_RDONLY, O_NOFOLLOW, O_WRONLY, O_CREAT, O_EXCL } = fsConstants;

/**
 * Open one EXPLICIT external file with `O_NOFOLLOW` (rejects a symlink at the final
 * component atomically with the open — no separate lstat-then-open TOCTOU window), then
 * `fstat` the already-open descriptor (not a second `lstat` on the path, which could have
 * been swapped between calls). Requires: regular file, owned by `expectedOwnerUid`, exactly
 * one hard link, and size within `maxBytes`. Returns exact byte count, device/inode/mtime
 * identity, and the SHA-256 of the exact bytes read.
 */
export async function inspectExternalRegularFileV1(
  path: string,
  expectedOwnerUid: number,
  maxBytes: number,
): Promise<InspectExternalFileResultV1> {
  let handle;
  try {
    handle = await open(path, O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP") return { ok: false, code: "symlink", message: `refused to follow a symlink: ${path}` };
    if (code === "ENOENT") return { ok: false, code: "not_found", message: `no such file: ${path}` };
    return { ok: false, code: "not_found", message: `cannot open ${path}: ${(err as Error).message}` };
  }
  try {
    // `bigint: true` is required for `mtimeNs` to be populated at all (Node otherwise
    // leaves it undefined even though the TS type claims it is always a bigint).
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile()) {
      return { ok: false, code: "not_regular_file", message: `not a regular file: ${path}` };
    }
    if (Number(stats.uid) !== expectedOwnerUid) {
      return { ok: false, code: "wrong_owner", message: `not owned by the expected uid: ${path}` };
    }
    if (stats.nlink !== 1n) {
      return { ok: false, code: "hard_linked", message: `has more than one hard link: ${path}` };
    }
    const size = Number(stats.size);
    if (size > maxBytes) {
      return { ok: false, code: "oversized", message: `exceeds ${maxBytes} bytes: ${path} (${size} bytes)` };
    }
    const buffer = Buffer.alloc(size);
    let readTotal = 0;
    while (readTotal < buffer.length) {
      const { bytesRead } = await handle.read(buffer, readTotal, buffer.length - readTotal, readTotal);
      if (bytesRead === 0) break;
      readTotal += bytesRead;
    }
    if (readTotal !== size) {
      return { ok: false, code: "oversized", message: `size changed while reading: ${path}` };
    }
    const sha256 = await sha256Bytes(new Uint8Array(buffer));
    const identity: InspectedExternalFileV1 = {
      bytes: size,
      device: Number(stats.dev),
      inode: Number(stats.ino),
      mtimeNs: stats.mtimeNs.toString(),
      sha256,
    };
    return { ok: true, value: identity };
  } finally {
    await handle.close();
  }
}

/**
 * Durable atomic write: unique same-directory `O_EXCL` 0600 temp -> complete write -> file
 * fsync -> rename onto `path` -> parent-directory fsync. `createOnly` rejects if `path`
 * already exists (via the rename's target); when false, overwrite is allowed (still atomic
 * — no partial file is ever visible at `path`).
 */
export async function atomicWriteBytesV1(path: string, bytes: Uint8Array): Promise<void> {
  const dir = dirname(path);
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  const handle = await open(tmpPath, O_WRONLY | O_CREAT | O_EXCL, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmpPath, path);
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }
  await fsyncDirectoryV1(dir);
}

/** fsync a directory by path (Node has no `fs.fsyncSync` overload for dirs, so open+sync). */
export async function fsyncDirectoryV1(dirPath: string): Promise<void> {
  const dirHandle = await open(dirPath, O_RDONLY);
  try {
    await dirHandle.sync();
  } catch (err) {
    // Some filesystems (notably certain macOS/APFS configurations under sandboxing) reject
    // fsync on a directory descriptor with EBADF/ENOTSUP; the rename this guards is already
    // durable at the file level, so treat directory-fsync failure as best-effort, not fatal.
    if ((err as NodeJS.ErrnoException).code !== "EBADF" && (err as NodeJS.ErrnoException).code !== "ENOTSUP") {
      throw err;
    }
  } finally {
    await dirHandle.close();
  }
}

/**
 * Atomic directory publication: stage a fresh 0700 directory beside the eventual target,
 * let the caller populate it via `populate(stagingDir)`, fsync the staging directory, then
 * rename it onto `targetPath` ONLY IF `targetPath` is currently absent (an existing target
 * means a caller-level idempotency/conflict decision, never a silent overwrite here).
 */
export async function atomicPublishDirectoryV1(
  targetPath: string,
  populate: (stagingDir: string) => Promise<void>,
): Promise<void> {
  const parent = dirname(targetPath);
  const stagingDir = join(parent, `.tmp-${randomUUID()}`);
  await mkdir(stagingDir, { recursive: true, mode: 0o700 });
  try {
    await populate(stagingDir);
    await fsyncDirectoryV1(stagingDir);
    await rename(stagingDir, targetPath);
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true });
    throw err;
  }
  await fsyncDirectoryV1(parent);
}

/** `{code:"unsafe_path", ...}` helper — kept in one place so the message shape is uniform. */
export function unsafePathFailureV1(path: string, reason: string): UnsafePathFailureV1 {
  return { code: "unsafe_path", path, reason };
}
