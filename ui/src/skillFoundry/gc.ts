// Task 9 — reachability-safe dry-run/apply garbage collection.
//
// DESIGN DECISION (candidate scope, spec §5.4 + Global Constraints): "temporary directories"
// and "unreferenced run artifacts" are ALWAYS GC-eligible once genuinely orphaned (they are
// crash leftovers or nothing points at them) — no age requirement. Only "rejected/completed
// drafts" carry the strict 90-day floor. A draft counts as GC-eligible ONLY when its current
// ledger state is exactly `rejected`, `superseded`, or `revoked` (the unambiguous
// "abandoned, never certified" terminal states) — every other state (including `blocked`,
// which the plan calls out explicitly as retained) is retained regardless of age. This
// module NEVER lists a path under `certifiedRoot` (packages) or an external reference's
// `absolutePath` — those are outside its candidate universe entirely, not merely excluded
// by a filter.

import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ClockV1, FoundryGcApplyResultV1, FoundryGcEntryV1, FoundryGcPlanV1, FoundryPathsV1 } from "./contracts";
import { canonicalJsonBytes, sha256Bytes } from "../agent/skillFoundry/hash";
import { withFoundryLockV1 } from "./lock";

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export type FoundryGcDepsV1 = { paths: FoundryPathsV1; clock: ClockV1; uid: number };

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function draftIsGcEligibleV1(draftDir: string): Promise<boolean> {
  const statePath = join(draftDir, "state.jsonl");
  let raw: string;
  try {
    raw = await readFile(statePath, "utf8");
  } catch {
    return false; // unreadable ledger — never a GC candidate, fail closed toward retention
  }
  const lines = raw.trimEnd().split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return false;
  let last: { state?: string };
  try {
    last = JSON.parse(lines[lines.length - 1]) as { state?: string };
  } catch {
    return false;
  }
  return last.state === "rejected" || last.state === "superseded" || last.state === "revoked";
}

/** Every runId referenced by any draft's ledger `testCommand`/marker, so a run artifact
 * still tied to an active draft is never listed even if it happens to be old. */
async function collectReferencedRunArtifactDirsV1(paths: FoundryPathsV1): Promise<Set<string>> {
  const referenced = new Set<string>();
  const draftIds = await safeReaddir(paths.draftsRoot);
  for (const draftId of draftIds) {
    if (draftId.startsWith(".")) continue; // stray .tmp-* entries, not real drafts
    const eligible = await draftIsGcEligibleV1(join(paths.draftsRoot, draftId));
    if (eligible) continue; // a GC-eligible draft's own run artifacts are handled by draft removal itself, not retained
    // Any run artifact directory literally named after this draft id is treated as
    // referenced (a conservative, name-based linkage — the exact runId<->draft mapping
    // isn't tracked elsewhere in v1).
    referenced.add(draftId);
  }
  return referenced;
}

export async function planFoundryGcV1(input: { apply?: boolean }, deps: FoundryGcDepsV1): Promise<FoundryGcPlanV1> {
  void input; // dry-run vs apply is decided by the CALLER (status/gc command); planning itself never mutates
  const now = deps.clock.now();
  const entries: FoundryGcEntryV1[] = [];

  const ageDaysOf = (mtimeMs: number): number => (now.getTime() - mtimeMs) / (24 * 60 * 60 * 1000);

  // 1. Stray `.tmp-*` / `.lock.tmp-*` entries directly under teachRoot or draftsRoot — crash
  //    leftovers from an interrupted atomicPublishDirectoryV1/lock acquire. No age floor.
  for (const root of [deps.paths.teachRoot, deps.paths.draftsRoot]) {
    for (const name of await safeReaddir(root)) {
      if (!name.startsWith(".tmp-") && !name.startsWith(".lock.tmp-")) continue;
      const fullPath = join(root, name);
      let st;
      try {
        st = await lstat(fullPath);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue; // never follow, never list a link itself as a tmp candidate
      entries.push({ path: fullPath, kind: "tmp", ageDays: ageDaysOf(st.mtimeMs) });
    }
  }

  // 2. Unreferenced run-artifact directories under artifactsRoot — no age floor.
  const referencedRunDirs = await collectReferencedRunArtifactDirsV1(deps.paths);
  for (const name of await safeReaddir(deps.paths.artifactsRoot)) {
    if (referencedRunDirs.has(name)) continue;
    const fullPath = join(deps.paths.artifactsRoot, name);
    let st;
    try {
      st = await lstat(fullPath);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    entries.push({ path: fullPath, kind: "run_artifact", ageDays: ageDaysOf(st.mtimeMs) });
  }

  // 3. Rejected/superseded/revoked drafts strictly older than 90 days.
  for (const draftId of await safeReaddir(deps.paths.draftsRoot)) {
    if (draftId.startsWith(".")) continue;
    const draftDir = join(deps.paths.draftsRoot, draftId);
    let st;
    try {
      st = await lstat(draftDir);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (!(await draftIsGcEligibleV1(draftDir))) continue;
    const ageDays = ageDaysOf(st.mtimeMs);
    if (now.getTime() - st.mtimeMs <= NINETY_DAYS_MS) continue; // strictly older than 90 days — equality retains
    entries.push({ path: draftDir, kind: "draft", ageDays });
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  const planSha256 = await sha256Bytes(canonicalJsonBytes({ entries }));
  return { entries, planSha256, generatedAt: now.toISOString() };
}

/** Re-validate EVERY entry immediately before removal; a changed entry is skipped, not force-removed. */
export async function applyFoundryGcV1(plan: FoundryGcPlanV1, deps: FoundryGcDepsV1): Promise<FoundryGcApplyResultV1> {
  return withFoundryLockV1(deps.paths.lockPath, "gc", async () => {
    const removed: string[] = [];
    const skipped: { path: string; reason: "gc_revalidation_failed" }[] = [];

    // Recompute the plan fresh under the lock; only entries that are ALSO in the fresh plan
    // (same path, same kind) are eligible — anything the caller's stale `plan` claims but the
    // fresh recomputation does not is skipped rather than trusted.
    const freshPlan = await planFoundryGcV1({}, deps);
    const freshByPath = new Map(freshPlan.entries.map((e) => [e.path, e]));

    for (const entry of plan.entries) {
      const fresh = freshByPath.get(entry.path);
      if (fresh === undefined || fresh.kind !== entry.kind) {
        skipped.push({ path: entry.path, reason: "gc_revalidation_failed" });
        continue;
      }
      // Contained within a root this module actually manages (never a package or an
      // external reference path — those are never emitted by planFoundryGcV1 at all, but a
      // maliciously hand-edited plan object must still be rejected here).
      const contained =
        entry.path.startsWith(`${deps.paths.teachRoot}/`) &&
        !entry.path.startsWith(`${deps.paths.certifiedRoot}/`);
      if (!contained) {
        skipped.push({ path: entry.path, reason: "gc_revalidation_failed" });
        continue;
      }
      let st;
      try {
        st = await lstat(entry.path);
      } catch {
        skipped.push({ path: entry.path, reason: "gc_revalidation_failed" });
        continue;
      }
      if (st.isSymbolicLink() || st.uid !== deps.uid) {
        skipped.push({ path: entry.path, reason: "gc_revalidation_failed" });
        continue;
      }
      if (entry.kind === "draft" && deps.clock.now().getTime() - st.mtimeMs <= NINETY_DAYS_MS) {
        skipped.push({ path: entry.path, reason: "gc_revalidation_failed" });
        continue;
      }
      await rm(entry.path, { recursive: true, force: false });
      removed.push(entry.path);
    }

    return { removed, skipped };
  });
}
