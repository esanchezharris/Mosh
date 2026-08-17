// Task 4 — draft creation and the durable `DraftStoreV1` artifact seam every later task
// (Task 5 onward) reads and writes through, plus Slice E per the plan's stability contract.
//
// DESIGN DECISION (locking): store methods assume the CALLER already holds the foundry lock
// (Task 10 wraps every CLI mutation in `withFoundryLockV1`) — a store method taking its own
// nested lock would either deadlock (same-process reentrant `mkdir`/`rename` on the lock
// path is not reentrant here) or require a reentrancy protocol the plan never asks for.
// Tests call these methods directly without a surrounding lock, which is fine for isolated
// single-writer tests; production callers must wrap every mutating call site.

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ArtifactWriteResultV1,
  type ClockV1,
  type CreateDraftInputV1,
  type CreateDraftResultV1,
  type DraftArtifactNameV1,
  type DraftSnapshotV1,
  type DraftStoreV1,
  type ExecutionIdentityV1,
  type FoundryPathsV1,
} from "./contracts";
import { atomicPublishDirectoryV1, atomicWriteBytesV1, isSafePathComponentV1, unsafePathFailureV1 } from "./safeFs";
import { appendStateTransitionV1, readStateLedgerV1 } from "./stateLedger";
import { canonicalJsonBytes, sha256Bytes } from "../agent/skillFoundry/hash";
import { measureFoundryQuotaV1, assertQuotaMutationV1 } from "./quota";

const ARTIFACT_FILE_NAMES: Readonly<Record<DraftArtifactNameV1, string>> = Object.freeze({
  request: "request.json",
  candidate: "candidate.skill.json",
  evals: "evals.jsonl",
  state: "state.jsonl",
  manualEvidence: "manual-evidence.jsonl",
  certification: "certification.json",
  approval: "approval.json",
  releaseVerification: "release-verification.json",
});

export type ExecutionIdentityDepsV1 = {
  resolveGitCommit?: () => Promise<string>;
  resolveAppVersion?: () => Promise<string>;
};

async function defaultResolveGitCommitV1(): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"]);
  return stdout.trim();
}

async function defaultResolveAppVersionV1(): Promise<string> {
  try {
    const raw = await readFile(join(process.cwd(), "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** The one entrypoint for a "runs `teach-moshi` locally, no live Mosh build" execution identity. */
export async function resolveOfflineExecutionIdentityV1(deps: ExecutionIdentityDepsV1 = {}): Promise<ExecutionIdentityV1> {
  const gitCommit = await (deps.resolveGitCommit ?? defaultResolveGitCommitV1)();
  const appVersion = await (deps.resolveAppVersion ?? defaultResolveAppVersionV1)();
  return { gitCommit, appVersion, build: { kind: "offline", toolVersion: "teach-moshi-v1" } };
}

function slugifyV1(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type DeriveOwnerSkillIdResultV1 = { ok: true; id: string } | { ok: false; reason: string };

/** `--id` is accepted verbatim if it already has the `owner-` prefix; otherwise it (or the
 * slugified goal, when no `--id` is given) is prefixed with `owner-`. Never silently drops
 * or mutates a caller-supplied ID beyond that one prefix rule. */
export function deriveOwnerSkillIdV1(input: CreateDraftInputV1): DeriveOwnerSkillIdResultV1 {
  const raw = input.id !== undefined && input.id.length > 0 ? input.id : slugifyV1(input.goal);
  if (raw.length === 0) {
    return { ok: false, reason: "goal produced an empty slug; supply an explicit --id" };
  }
  const withPrefix = raw.startsWith("owner-") ? raw : `owner-${raw}`;
  const slugPart = withPrefix.slice("owner-".length);
  if (!isSafePathComponentV1(slugPart, 58) || !isSafePathComponentV1(withPrefix, 64)) {
    return { ok: false, reason: `"${withPrefix}" is not a valid owner-* skill id` };
  }
  return { ok: true, id: withPrefix };
}

export function createDraftStoreV1(
  paths: FoundryPathsV1,
  clock: ClockV1,
  identityDeps: ExecutionIdentityDepsV1 = {},
): DraftStoreV1 {
  function draftDirFor(draftId: string): string {
    if (!isSafePathComponentV1(draftId)) {
      throw Object.assign(new Error(`unsafe draft id: ${draftId}`), unsafePathFailureV1(draftId, "unsafe draft id"));
    }
    return join(paths.draftsRoot, draftId);
  }

  async function createDraft(input: CreateDraftInputV1): Promise<CreateDraftResultV1> {
    const derived = deriveOwnerSkillIdV1(input);
    if (!derived.ok) {
      throw new Error(`cannot derive a draft id: ${derived.reason}`);
    }
    const skillId = derived.id;
    const draftDir = draftDirFor(skillId);

    const snapshot = await measureFoundryQuotaV1(paths);
    assertQuotaMutationV1(snapshot, { newDraft: true });

    const statePathFinal = join(draftDir, "state.jsonl");
    const requestPathFinal = join(draftDir, "request.json");

    try {
      await atomicPublishDirectoryV1(draftDir, async (stagingDir) => {
        await mkdir(join(stagingDir, "sources"), { recursive: true, mode: 0o700 });
        await mkdir(join(stagingDir, "references"), { recursive: true, mode: 0o700 });

        const requestPayload = { schemaVersion: 1, skillId, goal: input.goal, createdAt: clock.now().toISOString() };
        await atomicWriteBytesV1(join(stagingDir, "request.json"), canonicalJsonBytes(requestPayload));

        const executionIdentity = await resolveOfflineExecutionIdentityV1(identityDeps);
        const nowIso = clock.now().toISOString();
        await appendStateTransitionV1(join(stagingDir, "state.jsonl"), {
          state: "draft",
          artifactKind: "declarative",
          artifactHashes: {},
          executionIdentity,
          testCommand: "teach-moshi init",
          startedAt: nowIso,
          finishedAt: nowIso,
          result: "passed",
        });
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST" || (err as NodeJS.ErrnoException).code === "ENOTEMPTY") {
        throw new Error(`draft id collision: "${skillId}" already exists`);
      }
      throw err;
    }

    return { skillId, draftDir, statePath: statePathFinal, requestPath: requestPathFinal };
  }

  async function loadDraft(draftId: string): Promise<DraftSnapshotV1> {
    const draftDir = draftDirFor(draftId);
    const statePath = join(draftDir, "state.jsonl");
    const state = await readStateLedgerV1(statePath);
    if (state.length === 0) {
      throw new Error(`draft not found: ${draftId}`);
    }
    let markerExists = true;
    try {
      await readFile(join(draftDir, ".authoring-v1.json"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      markerExists = false;
    }
    if (markerExists) {
      throw Object.assign(new Error(`draft_update_incomplete: ${draftId} has an interrupted authoring transaction`), {
        code: "draft_update_incomplete",
      });
    }
    return {
      draftId,
      draftDir,
      statePath,
      requestPath: join(draftDir, "request.json"),
      sourcesDir: join(draftDir, "sources"),
      referencesDir: join(draftDir, "references"),
      state,
      currentState: state.length > 0 ? state[state.length - 1].state : null,
    };
  }

  async function readArtifactBytes(
    draftId: string,
    name: DraftArtifactNameV1,
    options?: { missing?: "throw" | "null" },
  ): Promise<Uint8Array | null> {
    const draftDir = draftDirFor(draftId);
    const filePath = join(draftDir, ARTIFACT_FILE_NAMES[name]);
    try {
      const buffer = await readFile(filePath);
      return new Uint8Array(buffer);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && options?.missing === "null") {
        return null;
      }
      throw err;
    }
  }

  async function writeArtifactBytes(
    draftId: string,
    name: DraftArtifactNameV1,
    bytes: Uint8Array,
    options: { createOnly: boolean; expectedSha256?: string },
  ): Promise<ArtifactWriteResultV1> {
    const draftDir = draftDirFor(draftId);
    const filePath = join(draftDir, ARTIFACT_FILE_NAMES[name]);

    let existing: Uint8Array | null = null;
    try {
      existing = new Uint8Array(await readFile(filePath));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    if (options.createOnly && existing !== null) {
      return { ok: false, code: "already_exists", message: `${name} already exists for draft ${draftId}` };
    }
    if (!options.createOnly) {
      if (existing === null) {
        return { ok: false, code: "not_found", message: `${name} does not exist for draft ${draftId}` };
      }
      if (options.expectedSha256 !== undefined) {
        const currentSha256 = await sha256Bytes(existing);
        if (currentSha256 !== options.expectedSha256) {
          return { ok: false, code: "hash_mismatch", message: `${name} changed since it was last read` };
        }
      }
    }

    await atomicWriteBytesV1(filePath, bytes);
    const sha256 = await sha256Bytes(bytes);
    return { ok: true, sha256, bytes: bytes.length };
  }

  async function createRunArtifactRoot(runId: string): Promise<string> {
    if (!isSafePathComponentV1(runId)) {
      throw new Error(`unsafe run id: ${runId}`);
    }
    const runDir = join(paths.artifactsRoot, runId);
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    return runDir;
  }

  return { createDraft, loadDraft, readArtifactBytes, writeArtifactBytes, createRunArtifactRoot } as DraftStoreV1;
}
