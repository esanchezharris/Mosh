// Task 6 — the non-public Codex/developer entrypoint for `authorCandidateArtifactsV1`.
//
// Deliberately absent from `TeachMoshiCommandV1`, `commands.ts`, and `ui/package.json` — the
// plan requires there be NO public `teach-moshi author` command. Accepts ONLY
// `--draft <safe-id> --candidate <absolute-file> --evals <absolute-file>`: no network, no
// arbitrary output path. Every input is no-follow, owner-checked, and bounded (64 KiB
// candidate / 4 MiB evals) before it is ever read.
//
// Invoke as:
//   (cd ui && npx tsx scripts/teachMoshi/authorCandidate.ts --draft "$DRAFT_ID" \
//     --candidate "$CANDIDATE_FILE" --evals "$EVAL_FILE")

import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseSkillManifestV1 } from "../../src/agent/skillFoundry/validate";
import { parseEvalCasesV1 } from "../../src/skillFoundry/evals";
import { authorCandidateArtifactsV1 } from "../../src/skillFoundry/compilerAuthoring";
import { resolveFoundryPathsV1 } from "../../src/skillFoundry/paths";
import { createDraftStoreV1 } from "../../src/skillFoundry/draftStore";
import { isSafePathComponentV1 } from "../../src/skillFoundry/safeFs";
import type { AuthorCandidateArtifactsResultV1, FoundryPathsV1 } from "../../src/skillFoundry/contracts";

export const MAX_CANDIDATE_BYTES = 65536; // 64 KiB
export const MAX_EVALS_BYTES = 4 * 1024 * 1024; // 4 MiB

const { O_RDONLY, O_NOFOLLOW } = fsConstants;

function readFlag(flag: string, argv: readonly string[]): string | undefined {
  const idx = argv.indexOf(flag);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

/** No-follow, owner-checked, bounded read — no relative path, symlink, FIFO, or oversized input is ever accepted. */
export function readBoundedNoFollowSyncV1(path: string, maxBytes: number, expectedOwnerUid: number): Buffer {
  if (!isAbsolute(path)) {
    throw new Error(`must be an absolute path: ${path}`);
  }
  const fd = openSync(path, O_RDONLY | O_NOFOLLOW);
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new Error(`not a regular file: ${path}`);
    if (stats.uid !== expectedOwnerUid) throw new Error(`not owned by the current user: ${path}`);
    if (stats.size > maxBytes) throw new Error(`exceeds ${maxBytes} bytes: ${path} (${stats.size} bytes)`);
    const buffer = Buffer.alloc(stats.size);
    let readTotal = 0;
    while (readTotal < buffer.length) {
      const bytesRead = readSync(fd, buffer, readTotal, buffer.length - readTotal, readTotal);
      if (bytesRead === 0) break;
      readTotal += bytesRead;
    }
    if (readTotal !== stats.size) throw new Error(`size changed while reading: ${path}`);
    return buffer;
  } finally {
    closeSync(fd);
  }
}

export type AuthorCandidateCliResultV1 =
  | { ok: true; result: AuthorCandidateArtifactsResultV1 }
  | { ok: false; error: string };

/**
 * `pathsOverride` exists ONLY so tests can inject an isolated `FoundryPathsV1` instead of
 * this function resolving the OWNER'S REAL home directory — never set by the real CLI
 * entrypoint at the bottom of this file, and there is no `--*` flag that reaches it.
 */
export async function runAuthorCandidateV1(argv: readonly string[], pathsOverride?: FoundryPathsV1): Promise<AuthorCandidateCliResultV1> {
  try {
    const knownFlags = new Set(["--draft", "--candidate", "--evals"]);
    for (let i = 0; i < argv.length; i += 2) {
      if (!knownFlags.has(argv[i])) {
        return { ok: false, error: `unknown flag: ${argv[i]}` };
      }
    }
    const draftId = readFlag("--draft", argv);
    const candidatePath = readFlag("--candidate", argv);
    const evalsPath = readFlag("--evals", argv);
    if (draftId === undefined || candidatePath === undefined || evalsPath === undefined) {
      return { ok: false, error: "usage: --draft <safe-id> --candidate <absolute-file> --evals <absolute-file>" };
    }
    if (!isSafePathComponentV1(draftId)) {
      return { ok: false, error: `unsafe --draft id: ${draftId}` };
    }

    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const candidateBytes = readBoundedNoFollowSyncV1(candidatePath, MAX_CANDIDATE_BYTES, uid);
    const evalsBytes = readBoundedNoFollowSyncV1(evalsPath, MAX_EVALS_BYTES, uid);

    const candidateJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(candidateBytes));
    const manifestResult = parseSkillManifestV1(candidateJson);
    if (!manifestResult.ok) {
      return { ok: false, error: `invalid candidate: ${manifestResult.issues.map((i) => i.message).join("; ")}` };
    }
    const evalsResult = parseEvalCasesV1(new Uint8Array(evalsBytes));
    if (!evalsResult.ok) {
      return { ok: false, error: `invalid evals: ${evalsResult.issues.map((i) => i.message).join("; ")}` };
    }

    let paths: FoundryPathsV1;
    if (pathsOverride !== undefined) {
      paths = pathsOverride;
    } else {
      const pathsResult = await resolveFoundryPathsV1();
      if (!pathsResult.ok) {
        return { ok: false, error: `unsafe foundry paths: ${pathsResult.error.reason}` };
      }
      paths = pathsResult.value;
    }
    const clock = { now: () => new Date() };
    const store = createDraftStoreV1(paths, clock);

    const result = await authorCandidateArtifactsV1(
      { draftId, candidateBytes: new Uint8Array(candidateBytes), evalsBytes: new Uint8Array(evalsBytes) },
      { store, paths, clock },
    );
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const isEntrypoint =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (isEntrypoint) {
  runAuthorCandidateV1(process.argv.slice(2)).then((outcome) => {
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
    process.exitCode = outcome.ok ? 0 : 1;
  });
}
