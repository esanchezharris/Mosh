// Task 4 — the fail-closed, hash-chained `state.jsonl` ledger.
//
// Every record's `recordSha256` covers the CANONICAL JSON of the record WITHOUT that field;
// each record's `previousRecordSha256` must equal the prior record's `recordSha256` (genesis
// is 64 zeroes). `readStateLedgerV1` re-verifies the ENTIRE chain on every read — sequence
// gaps, hash mismatches, truncation, and malformed/blank lines all throw, so a corrupted or
// tampered ledger can never be silently trusted. `appendStateTransitionV1` rewrites the
// whole file through `atomicWriteBytesV1` (never an in-place O_APPEND) so a crash mid-write
// leaves either the old complete file or the new complete file, never a truncated last line.

import { readFile } from "node:fs/promises";
import {
  FOUNDRY_STORAGE_LIMITS_V1,
  type AppendStateTransitionInputV1,
  type DraftArtifactKindV1,
  type DraftLifecycleStateV1,
  type FoundryStateRecordV1,
} from "./contracts";
import { canonicalJsonBytes, sha256Bytes } from "../agent/skillFoundry/hash";
import { atomicWriteBytesV1 } from "./safeFs";

export const GENESIS_PREVIOUS_HASH_V1 = "0".repeat(64);

const DECLARATIVE_FORWARD_CHAIN: readonly DraftLifecycleStateV1[] = [
  "draft",
  "source_reviewed",
  "schema_valid",
  "mock_green",
  "native_green",
  "packaged_green",
  "acceptance_green",
  "owner_approved",
  "certified",
];

const NATIVE_FORWARD_CHAIN: readonly DraftLifecycleStateV1[] = [
  "draft",
  "source_reviewed",
  "schema_valid",
  "mock_green",
  "native_green",
  "packaged_green",
  "acceptance_green",
  "owner_approved",
  "release_packaged_green",
  "certified",
];

const TERMINAL_STATES = new Set<DraftLifecycleStateV1>(["rejected", "superseded", "revoked", "certified"]);
const BLOCKABLE_STATES = new Set<DraftLifecycleStateV1>([
  "draft",
  "source_reviewed",
  "schema_valid",
  "mock_green",
  "native_green",
  "packaged_green",
  "acceptance_green",
  "owner_approved",
  "release_packaged_green",
]);

export type StateTransitionLegalityV1 = { ok: true } | { ok: false; reason: string };

function findLastProvenStateV1(history: readonly FoundryStateRecordV1[]): DraftLifecycleStateV1 | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].state !== "blocked") return history[i].state;
  }
  return null;
}

/** Pure legality check against the current history tail — no I/O. */
export function isLegalStateTransitionV1(
  history: readonly FoundryStateRecordV1[],
  to: DraftLifecycleStateV1,
  artifactKind: DraftArtifactKindV1,
): StateTransitionLegalityV1 {
  if (history.length === 0) {
    return to === "draft" ? { ok: true } : { ok: false, reason: 'the first record must be "draft"' };
  }
  const last = history[history.length - 1].state;

  if (TERMINAL_STATES.has(last)) {
    return { ok: false, reason: `"${last}" is terminal; no further transitions are legal` };
  }
  // Abandonment ("rejected"/"superseded"/"revoked") is an OWNER DECISION legal from any
  // non-terminal state — including "blocked" and "stale" — independent of proven progress.
  if (to === "rejected" || to === "superseded" || to === "revoked") {
    return { ok: true };
  }
  if (last === "stale") {
    return to === "source_reviewed" ? { ok: true } : { ok: false, reason: '"stale" may only resume to "source_reviewed"' };
  }
  if (last === "blocked") {
    const lastProven = findLastProvenStateV1(history);
    return to === lastProven
      ? { ok: true }
      : { ok: false, reason: `"blocked" may only resume to its last proven stage ("${String(lastProven)}")` };
  }
  if (to === "blocked" || to === "stale") {
    return BLOCKABLE_STATES.has(last) ? { ok: true } : { ok: false, reason: `"${last}" cannot transition to "${to}"` };
  }

  const chain = artifactKind === "native" ? NATIVE_FORWARD_CHAIN : DECLARATIVE_FORWARD_CHAIN;
  const idx = chain.indexOf(last);
  const expectedNext = idx >= 0 && idx + 1 < chain.length ? chain[idx + 1] : undefined;
  if (to !== expectedNext) {
    return { ok: false, reason: `illegal transition "${last}" -> "${to}" for ${artifactKind} artifacts` };
  }
  return { ok: true };
}

function assertNonEmptyExecutionIdentityV1(record: FoundryStateRecordV1, lineNumber: number): void {
  const identity = record.executionIdentity;
  if (
    identity === null ||
    typeof identity !== "object" ||
    typeof identity.gitCommit !== "string" ||
    identity.gitCommit.length === 0 ||
    typeof identity.appVersion !== "string" ||
    identity.appVersion.length === 0 ||
    identity.build === null ||
    typeof identity.build !== "object"
  ) {
    throw new Error(`state ledger line ${lineNumber}: missing or empty executionIdentity`);
  }
  if (identity.build.kind === "offline") {
    if (identity.build.toolVersion !== "teach-moshi-v1") {
      throw new Error(`state ledger line ${lineNumber}: invalid offline build identity`);
    }
  } else if (identity.build.kind === "mosh") {
    if (typeof identity.build.moshBuildIdentity !== "string" || identity.build.moshBuildIdentity.length === 0) {
      throw new Error(`state ledger line ${lineNumber}: missing moshBuildIdentity`);
    }
  } else {
    throw new Error(`state ledger line ${lineNumber}: unknown build kind`);
  }
}

/**
 * Read and FULLY RE-VERIFY the state ledger. A missing file reads as `[]` (a not-yet-created
 * draft is not corruption); any other malformed condition throws. Never returns a partially
 * verified chain.
 */
export async function readStateLedgerV1(path: string): Promise<FoundryStateRecordV1[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  if (raw.length === 0) return [];
  if (!raw.endsWith("\n")) {
    throw new Error("state ledger is truncated: missing trailing newline");
  }

  const lines = raw.slice(0, -1).split("\n");
  const records: FoundryStateRecordV1[] = [];
  let previousHash = GENESIS_PREVIOUS_HASH_V1;

  for (let i = 0; i < lines.length; i += 1) {
    const lineNumber = i + 1;
    const line = lines[i];
    if (line.length === 0) {
      throw new Error(`state ledger line ${lineNumber} is blank`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`state ledger line ${lineNumber} is not valid JSON`);
    }
    if (parsed === null || typeof parsed !== "object") {
      throw new Error(`state ledger line ${lineNumber} is not an object`);
    }
    const record = parsed as FoundryStateRecordV1;
    if (typeof record.sequence !== "number" || typeof record.recordSha256 !== "string" || typeof record.state !== "string") {
      throw new Error(`state ledger line ${lineNumber} is missing required fields`);
    }
    if (record.sequence !== lineNumber) {
      throw new Error(`state ledger line ${lineNumber}: sequence gap (expected ${lineNumber}, got ${record.sequence})`);
    }
    if (record.previousRecordSha256 !== previousHash) {
      throw new Error(`state ledger line ${lineNumber}: previousRecordSha256 does not match the prior record`);
    }
    assertNonEmptyExecutionIdentityV1(record, lineNumber);

    const { recordSha256, ...withoutHash } = record;
    const expectedHash = await sha256Bytes(canonicalJsonBytes(withoutHash));
    if (expectedHash !== recordSha256) {
      throw new Error(`state ledger line ${lineNumber}: recordSha256 does not match its content (tampered or corrupt)`);
    }

    records.push(record);
    previousHash = recordSha256;
  }

  if (records.length > FOUNDRY_STORAGE_LIMITS_V1.maxStateRecords) {
    throw new Error(`state ledger exceeds ${FOUNDRY_STORAGE_LIMITS_V1.maxStateRecords} records`);
  }

  return records;
}

/**
 * Append one transition, rewriting the whole file atomically. Throws on an illegal
 * transition, an existing-chain read failure, or a cap violation — never partially writes.
 */
export async function appendStateTransitionV1(
  statePath: string,
  input: AppendStateTransitionInputV1,
): Promise<FoundryStateRecordV1> {
  const history = await readStateLedgerV1(statePath);

  const legality = isLegalStateTransitionV1(history, input.state, input.artifactKind);
  if (!legality.ok) {
    throw new Error(`illegal state transition: ${legality.reason}`);
  }
  if (history.length + 1 > FOUNDRY_STORAGE_LIMITS_V1.maxStateRecords) {
    throw new Error(`quota exceeded: state ledger would exceed ${FOUNDRY_STORAGE_LIMITS_V1.maxStateRecords} records`);
  }

  const previous = history.length > 0 ? history[history.length - 1] : null;
  const withoutHash: Omit<FoundryStateRecordV1, "recordSha256"> = {
    schemaVersion: 1,
    sequence: history.length + 1,
    previousRecordSha256: previous?.recordSha256 ?? GENESIS_PREVIOUS_HASH_V1,
    state: input.state,
    artifactHashes: input.artifactHashes,
    executionIdentity: input.executionIdentity,
    testCommand: input.testCommand,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    result: input.result,
  };
  const recordSha256 = await sha256Bytes(canonicalJsonBytes(withoutHash));
  const record: FoundryStateRecordV1 = { ...withoutHash, recordSha256 };

  const existingBytes = new TextEncoder().encode(history.map((r) => `${JSON.stringify(canonicalizeForLine(r))}\n`).join(""));
  const newLineBytes = new TextEncoder().encode(`${JSON.stringify(canonicalizeForLine(record))}\n`);
  const nextTotal = existingBytes.length + newLineBytes.length;
  if (nextTotal > FOUNDRY_STORAGE_LIMITS_V1.maxStateLedgerBytes) {
    throw new Error(`quota exceeded: state ledger would exceed ${FOUNDRY_STORAGE_LIMITS_V1.maxStateLedgerBytes} bytes`);
  }

  const combined = new Uint8Array(nextTotal);
  combined.set(existingBytes, 0);
  combined.set(newLineBytes, existingBytes.length);
  await atomicWriteBytesV1(statePath, combined);

  return record;
}

// Canonical JSON key ordering keeps every stored line byte-stable regardless of the
// property insertion order used to build the in-memory object.
function canonicalizeForLine(record: FoundryStateRecordV1): unknown {
  return JSON.parse(new TextDecoder().decode(canonicalJsonBytes(record)));
}
