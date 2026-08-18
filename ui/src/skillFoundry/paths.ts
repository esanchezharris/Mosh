// Task 3 — resolve every foundry path once per invocation, validating every EXISTING root
// component within the foundry's OWN managed subtree and creating any missing directory as
// owner-only (0700).
//
// DESIGN DECISION: mirrors the native `CertifiedSkillLoader::resolveAgentRoot` convention
// exactly (see the Slice A research this task started from) so the TypeScript CLI and the
// native app agree on where things live: `MOSH_AGENT_DIR` overrides the runtime root and
// MUST be an absolute path (checked on the raw string before any `path`/`fs` call, so a
// relative override can never be silently resolved against `process.cwd()`); the draft root
// has no separate env override — tests isolate it by injecting a fake `homeDir` instead,
// which is what the plan's "tests inject both roots" means in practice (agentRoot via env,
// teachRoot via homeDir).
//
// DESIGN DECISION (trust anchor, not full ancestor walk): symlink/ownership validation
// walks from an ANCHOR downward — `homeDir` for teach-root paths and for the default
// agent root, or the override `agentRoot` itself when `MOSH_AGENT_DIR` names a path outside
// `homeDir`. It deliberately does NOT walk system ancestors above the anchor: on macOS,
// `/tmp` and `/var` are themselves symlinks to `/private/...`, a normal system convention,
// not tampering. Rejecting symlinks up there would break every isolated test homeDir (and
// any real user on a distro that symlinks a system directory). The actual tampering surface
// this guards is someone replacing a directory the FOUNDRY itself creates and owns
// (`homeDir/Library/Mosh/...` and below, or the override agent root and below) with a
// symlink — that subtree is exactly what gets walked and checked.

import { lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { FoundryPathsV1, UnsafePathFailureV1 } from "./contracts";
import { unsafePathFailureV1 } from "./safeFs";

export type ResolveFoundryPathsResultV1 = { ok: true; value: FoundryPathsV1 } | { ok: false; error: UnsafePathFailureV1 };

/** Resolve, VALIDATING, and create-if-missing every foundry path. Never throws. */
export async function resolveFoundryPathsV1(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
  uid: number = typeof process.getuid === "function" ? process.getuid() : 0,
): Promise<ResolveFoundryPathsResultV1> {
  if (!isAbsolute(homeDir)) {
    return { ok: false, error: unsafePathFailureV1(homeDir, "homeDir must be an absolute path") };
  }

  const teachRoot = join(homeDir, "Library", "Mosh", "teach");

  const rawAgentOverride = env.MOSH_AGENT_DIR;
  const hasOverride = rawAgentOverride !== undefined && rawAgentOverride.length > 0;
  if (hasOverride && !isAbsolute(rawAgentOverride as string)) {
    // Checked on the RAW STRING before any path/fs call: a relative override must never be
    // silently resolved against process.cwd() (matches the native pre-construction check).
    return { ok: false, error: unsafePathFailureV1(rawAgentOverride as string, "MOSH_AGENT_DIR override must be an absolute path") };
  }
  const agentRoot = hasOverride ? (rawAgentOverride as string) : join(homeDir, "Library", "Mosh", "agent");
  const agentAnchor = hasOverride ? agentRoot : homeDir;

  const homeCheck = await ensureSafeOwnedRootV1(homeDir, homeDir, uid);
  if (!homeCheck.ok) return homeCheck;

  const draftsRoot = join(teachRoot, "drafts");
  const artifactsRoot = join(teachRoot, "artifacts");
  const sourceCardsRoot = join(teachRoot, "source-cards");
  const certifiedRoot = join(agentRoot, "skills", "certified");
  const skillsRoot = join(agentRoot, "skills");

  for (const dir of [teachRoot, draftsRoot, artifactsRoot, sourceCardsRoot]) {
    const check = await ensureSafeOwnedRootV1(homeDir, dir, uid);
    if (!check.ok) return check;
  }
  for (const dir of [agentRoot, skillsRoot, certifiedRoot]) {
    const check = await ensureSafeOwnedRootV1(agentAnchor, dir, uid);
    if (!check.ok) return check;
  }

  return {
    ok: true,
    value: {
      homeDir,
      uid,
      teachRoot,
      draftsRoot,
      artifactsRoot,
      sourceCardsRoot,
      lockPath: join(teachRoot, ".lock"),
      agentRoot,
      certifiedRoot,
      activePath: join(certifiedRoot, "active.json"),
      sourceStatusPath: join(skillsRoot, "source-status.json"),
    },
  };
}

type EnsureRootResultV1 = { ok: true } | { ok: false; error: UnsafePathFailureV1 };

/** Validate-or-create exactly one directory leaf: not a symlink; owner-uid; not g/o-writable. */
async function ensureSafeLeafV1(targetDir: string, uid: number): Promise<EnsureRootResultV1> {
  let lst;
  try {
    lst = await lstat(targetDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      await mkdir(targetDir, { recursive: true, mode: 0o700 });
      return { ok: true };
    }
    return { ok: false, error: unsafePathFailureV1(targetDir, `cannot stat: ${(err as Error).message}`) };
  }
  if (lst.isSymbolicLink()) {
    return { ok: false, error: unsafePathFailureV1(targetDir, "path component is a symlink") };
  }
  if (!lst.isDirectory()) {
    return { ok: false, error: unsafePathFailureV1(targetDir, "target exists and is not a directory") };
  }
  if (lst.uid !== uid) {
    return { ok: false, error: unsafePathFailureV1(targetDir, "target is not owned by the expected uid") };
  }
  if ((lst.mode & 0o022) !== 0) {
    return { ok: false, error: unsafePathFailureV1(targetDir, "target is group- or world-writable") };
  }
  return { ok: true };
}

/**
 * Validate every EXISTING path component strictly between `anchor` (already trusted) and
 * `targetDir` is not a symlink, then validate-or-create `targetDir` itself as a safe leaf.
 * `targetDir` must equal `anchor` or be a descendant of it.
 */
async function ensureSafeOwnedRootV1(anchor: string, targetDir: string, uid: number): Promise<EnsureRootResultV1> {
  const anchorCheck = await ensureSafeLeafV1(anchor, uid);
  if (!anchorCheck.ok) return anchorCheck;
  if (targetDir === anchor) return anchorCheck;

  const rel = relative(anchor, targetDir);
  if (rel.length === 0 || rel === "." || rel.startsWith(`..${sep}`) || rel === "..") {
    return { ok: false, error: unsafePathFailureV1(targetDir, "target is not a descendant of the anchor") };
  }

  let current = anchor;
  for (const segment of rel.split(sep).filter((part) => part.length > 0)) {
    current = join(current, segment);
    if (current === targetDir) break;
    let lst;
    try {
      lst = await lstat(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") break;
      return { ok: false, error: unsafePathFailureV1(current, `cannot stat: ${(err as Error).message}`) };
    }
    if (lst.isSymbolicLink()) {
      return { ok: false, error: unsafePathFailureV1(current, "path component is a symlink") };
    }
  }

  return ensureSafeLeafV1(targetDir, uid);
}
