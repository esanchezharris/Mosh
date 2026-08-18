// Slice D — `teach-moshi` argument parsing and command dispatch.
//
// Task 1: `parseTeachMoshiArgsV1` (pure, table-driven flag parser) and `runTeachMoshiV1`
// (dispatches a parsed command through injected `TeachMoshiDepsV1`, producing a
// `CliExecutionV1`). `createStubTeachMoshiDepsV1` gives `cli.ts` something typecheckable to
// run before real services exist; Task 10 replaces it with real service wiring so every
// command in the acceptance matrix has a durable effect.

import type {
  CliArgsParseResultV1,
  CliExecutionV1,
  CommandHandlerResultV1,
  TeachMoshiCommandNameV1,
  TeachMoshiCommandV1,
  TeachMoshiDepsV1,
} from "./contracts";

type FlagKindV1 = "string" | "boolean";

type FlagSpecV1 = { flag: string; kind: FlagKindV1; required: boolean; field: string };

const COMMAND_FLAGS_V1: Readonly<Record<TeachMoshiCommandNameV1, readonly FlagSpecV1[]>> = Object.freeze({
  init: [
    { flag: "--goal", kind: "string", required: true, field: "goal" },
    { flag: "--id", kind: "string", required: false, field: "id" },
  ],
  "add-source": [
    { flag: "--draft", kind: "string", required: true, field: "draftId" },
    { flag: "--card", kind: "string", required: true, field: "cardPath" },
  ],
  "add-reference": [
    { flag: "--draft", kind: "string", required: true, field: "draftId" },
    { flag: "--file", kind: "string", required: true, field: "filePath" },
  ],
  validate: [{ flag: "--draft", kind: "string", required: true, field: "draftId" }],
  certify: [
    { flag: "--draft", kind: "string", required: true, field: "draftId" },
    { flag: "--bin", kind: "string", required: true, field: "bin" },
  ],
  "record-evidence": [
    { flag: "--draft", kind: "string", required: true, field: "draftId" },
    { flag: "--case", kind: "string", required: true, field: "caseId" },
    { flag: "--evidence", kind: "string", required: true, field: "evidencePath" },
  ],
  review: [{ flag: "--draft", kind: "string", required: true, field: "draftId" }],
  approve: [
    { flag: "--draft", kind: "string", required: true, field: "draftId" },
    { flag: "--review-sha", kind: "string", required: true, field: "reviewSha" },
    { flag: "--attestation", kind: "string", required: true, field: "attestationPath" },
  ],
  install: [{ flag: "--draft", kind: "string", required: true, field: "draftId" }],
  rollback: [
    { flag: "--id", kind: "string", required: true, field: "skillId" },
    { flag: "--version", kind: "string", required: true, field: "version" },
  ],
  revoke: [{ flag: "--id", kind: "string", required: true, field: "skillId" }],
  "refresh-source": [{ flag: "--card", kind: "string", required: true, field: "cardPath" }],
  "revoke-source": [{ flag: "--id", kind: "string", required: true, field: "sourceCardId" }],
  gc: [{ flag: "--apply", kind: "boolean", required: false, field: "apply" }],
  status: [{ flag: "--draft", kind: "string", required: true, field: "draftId" }],
});

const KNOWN_COMMANDS_V1: readonly TeachMoshiCommandNameV1[] = Object.keys(COMMAND_FLAGS_V1) as TeachMoshiCommandNameV1[];

function isKnownCommand(value: string): value is TeachMoshiCommandNameV1 {
  return (KNOWN_COMMANDS_V1 as readonly string[]).includes(value);
}

/** Table-driven, pure argv parser. No I/O, no defaults beyond `gc --apply` -> false. */
export function parseTeachMoshiArgsV1(argv: readonly string[]): CliArgsParseResultV1 {
  const commandName = argv[0];
  if (commandName === undefined || commandName.length === 0) {
    return {
      ok: false,
      issues: [{ code: "missing_command", path: "0", message: "a command is required" }],
    };
  }
  if (!isKnownCommand(commandName)) {
    return {
      ok: false,
      issues: [{ code: "unknown_command", path: "0", message: `unknown command "${commandName}"` }],
    };
  }

  const specs = COMMAND_FLAGS_V1[commandName];
  const specByFlag = new Map(specs.map((spec) => [spec.flag, spec] as const));
  const values: Record<string, string | boolean> = {};
  const seen = new Set<string>();
  const rest = argv.slice(1);

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    const spec = specByFlag.get(token);
    if (spec === undefined) {
      return {
        ok: false,
        issues: [{ code: "unknown_flag", path: token, message: `unknown flag "${token}" for command "${commandName}"` }],
      };
    }
    if (seen.has(spec.field)) {
      return {
        ok: false,
        issues: [{ code: "duplicate_flag", path: spec.flag, message: `flag "${spec.flag}" was supplied more than once` }],
      };
    }
    seen.add(spec.field);
    if (spec.kind === "boolean") {
      values[spec.field] = true;
      continue;
    }
    const next = rest[i + 1];
    if (next === undefined) {
      return {
        ok: false,
        issues: [{ code: "missing_value", path: spec.flag, message: `flag "${spec.flag}" requires a value` }],
      };
    }
    values[spec.field] = next;
    i += 1;
  }

  for (const spec of specs) {
    if (spec.required && !seen.has(spec.field)) {
      return {
        ok: false,
        issues: [{ code: "missing_required_flag", path: spec.flag, message: `flag "${spec.flag}" is required` }],
      };
    }
  }
  if (specByFlag.has("--apply") && values.apply === undefined) {
    values.apply = false;
  }

  return { ok: true, value: { command: commandName, ...values } as TeachMoshiCommandV1 };
}

const NOT_IMPLEMENTED = async (): Promise<CommandHandlerResultV1> => ({
  ok: false,
  code: "io_error",
  message: "not implemented",
});

/**
 * Stub deps so `cli.ts` typechecks and runs before Task 10 wires real services. Every
 * command fails closed with `io_error` rather than silently succeeding.
 */
export function createStubTeachMoshiDepsV1(): TeachMoshiDepsV1 {
  return {
    init: NOT_IMPLEMENTED,
    "add-source": NOT_IMPLEMENTED,
    "add-reference": NOT_IMPLEMENTED,
    validate: NOT_IMPLEMENTED,
    certify: NOT_IMPLEMENTED,
    "record-evidence": NOT_IMPLEMENTED,
    review: NOT_IMPLEMENTED,
    approve: NOT_IMPLEMENTED,
    install: NOT_IMPLEMENTED,
    rollback: NOT_IMPLEMENTED,
    revoke: NOT_IMPLEMENTED,
    "refresh-source": NOT_IMPLEMENTED,
    "revoke-source": NOT_IMPLEMENTED,
    gc: NOT_IMPLEMENTED,
    status: NOT_IMPLEMENTED,
  };
}

// ---------------------------------------------------------------------------------------
// Task 10 — real service wiring. Every command below produces the durable effect its row in
// the plan's Command Acceptance Matrix requires. The foundry lock wraps every MUTATING
// command except `gc` (whose `applyFoundryGcV1` already takes the lock itself — nesting
// would deadlock against our non-reentrant lock) and the two read-only commands (`review`,
// `status`), which the plan states explicitly perform no mutation.
// ---------------------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FoundryPathsV1 } from "./contracts";
import { resolveFoundryPathsV1 } from "./paths";
import { createDraftStoreV1, resolveOfflineExecutionIdentityV1 } from "./draftStore";
import { withFoundryLockV1 } from "./lock";
import { addSourceCardV1, parseSourceCardV1, sourceSnapshotSha256V1 } from "./sourceCards";
import { refreshSourceStatusV1, revokeSourceStatusV1, readSourceStatusV1 } from "./sourceStatus";
import { addReferenceV1 } from "./references";
import { validateDraftCandidateV1 } from "./candidate";
import { certifyDraftV1, createDefaultCertificationRunnerV1 } from "./certify";
import { createProcessSupervisorV1 } from "./processSupervisor";
import { recordManualEvidenceV1 } from "./evidence";
import { buildReviewV1, approveDraftV1 } from "./reviewApproval";
import { installDraftV1, rollbackSkillV1, revokeSkillV1 } from "./packageLifecycle";
import { planFoundryGcV1, applyFoundryGcV1 } from "./gc";
import { readBoundedNoFollowV1, isSafePathComponentV1 } from "./safeFs";
import { readStateLedgerV1 } from "./stateLedger";
import { FOUNDRY_STORAGE_LIMITS_V1 } from "./contracts";
import { catalogFingerprintV1 } from "../agent/skillFoundry/catalogs";
import { sha256Bytes } from "../agent/skillFoundry/hash";
import { SKILL_LIMITS_V1 } from "../agent/skillFoundry/limits";
import type { SkillCompatibilityContextV1 } from "../agent/skillFoundry/contracts";

const REAL_CLOCK = { now: () => new Date() };

async function buildCompatibilityContextV1(): Promise<SkillCompatibilityContextV1> {
  const identity = await resolveOfflineExecutionIdentityV1();
  const catalogFingerprint = await catalogFingerprintV1();
  return {
    appVersion: identity.appVersion,
    gitCommit: identity.gitCommit,
    gitState: "unknown",
    moshBuildIdentity: `git=${identity.gitCommit}|version=${identity.appVersion}|target=Mosh|configuration=Release|architecture=arm64`,
    catalogFingerprint,
    nativeSourceSha256ByHandler: {
      sessionControlV1: "0".repeat(64),
      takeCycleV1: "0".repeat(64),
      explicitBalanceV1: "0".repeat(64),
      loadNamedPluginV1: "0".repeat(64),
    },
  };
}

/**
 * Real service wiring for `cli.ts`. `pathsOverride` exists ONLY for tests — the real CLI
 * entrypoint always resolves the owner's actual foundry paths.
 */
export async function createRealTeachMoshiDepsV1(pathsOverride?: FoundryPathsV1): Promise<TeachMoshiDepsV1> {
  const paths = pathsOverride ?? (await (async () => {
    const result = await resolveFoundryPathsV1();
    if (!result.ok) throw new Error(`unsafe foundry paths: ${result.error.reason}`);
    return result.value;
  })());
  const store = createDraftStoreV1(paths, REAL_CLOCK);
  const uid = paths.uid;

  const withLock = <T>(command: string, fn: () => Promise<T>): Promise<T> => withFoundryLockV1(paths.lockPath, command, fn);

  return {
    async init(command) {
      try {
        const created = await withLock("init", () => store.createDraft({ goal: command.goal, id: command.id }));
        return { ok: true, result: created };
      } catch (err) {
        return { ok: false, code: "id_collision", message: (err as Error).message };
      }
    },

    async "add-source"(command) {
      return withLock("add-source", async () => {
        const added = await addSourceCardV1({ draftDir: join(paths.draftsRoot, command.draftId), teachRoot: paths.teachRoot, cardPath: command.cardPath });
        if (!added.ok) return { ok: false, code: added.code, message: added.message };
        const snapshotSha256 = await sourceSnapshotSha256V1(added.card);
        const statusResult = await refreshSourceStatusV1({
          sourceStatusPath: paths.sourceStatusPath,
          sourceCardsRoot: paths.sourceCardsRoot,
          card: added.card,
          snapshotSha256,
          clock: REAL_CLOCK,
        });
        if (!statusResult.ok) return { ok: false, code: "invalid_source_card", message: statusResult.code };

        // A draft's FIRST successful add-source is what legally advances it out of "draft"
        // (the declarative forward chain requires "source_reviewed" before "schema_valid",
        // and reviewing/attaching a source card is exactly what that state represents).
        const snapshot = await store.loadDraft(command.draftId);
        if (snapshot.currentState === "draft") {
          const executionIdentity = await resolveOfflineExecutionIdentityV1();
          const { appendStateTransitionV1 } = await import("./stateLedger");
          const nowIso = REAL_CLOCK.now().toISOString();
          await appendStateTransitionV1(snapshot.statePath, {
            state: "source_reviewed",
            artifactKind: "declarative",
            artifactHashes: { sourceCard: snapshotSha256 },
            executionIdentity,
            testCommand: "teach-moshi add-source",
            startedAt: nowIso,
            finishedAt: nowIso,
            result: "passed",
          });
        }

        return { ok: true, result: { card: added.card, changed: added.changed, generation: statusResult.index.generation } };
      });
    },

    async "add-reference"(command) {
      return withLock("add-reference", async () => {
        let json: unknown = null;
        try {
          const bytes = await readBoundedNoFollowV1(command.filePath, FOUNDRY_STORAGE_LIMITS_V1.maxSourceCardBytes);
          json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch {
          json = null;
        }
        const looksLikeAbletonReference = json !== null && typeof json === "object" && (json as Record<string, unknown>).journeyId !== undefined;
        if (looksLikeAbletonReference) {
          const { parseAbletonReferenceV1 } = await import("./references");
          const parsed = parseAbletonReferenceV1(json);
          if (!parsed.ok) {
            return { ok: false, code: "invalid_reference", message: parsed.issues.map((i) => `${i.path}: ${i.message}`).join("; ") };
          }
          const draftDir = join(paths.draftsRoot, command.draftId);
          for (const setRef of [parsed.value.beforeSet, parsed.value.afterSet]) {
            if (setRef === undefined) continue;
            const locatorResult = await addReferenceV1({ draftDir, filePath: setRef.path, uid, clock: REAL_CLOCK });
            if (!locatorResult.ok) return { ok: false, code: locatorResult.code, message: locatorResult.message };
          }
          const { atomicWriteBytesV1, isSafePathComponentV1: isSafe } = await import("./safeFs");
          const { canonicalJsonBytes } = await import("../agent/skillFoundry/hash");
          const referenceId = await sha256Bytes(canonicalJsonBytes({ journeyId: parsed.value.journeyId, startedAt: parsed.value.startedAt }));
          if (!isSafe(referenceId)) return { ok: false, code: "invalid_reference", message: "unsafe derived reference id" };
          await atomicWriteBytesV1(join(draftDir, "references", `ableton-${referenceId}.json`), canonicalJsonBytes(parsed.value));
          return { ok: true, result: { kind: "ableton_reference", journeyId: parsed.value.journeyId } };
        }

        const draftDir = join(paths.draftsRoot, command.draftId);
        const result = await addReferenceV1({ draftDir, filePath: command.filePath, uid, clock: REAL_CLOCK });
        if (!result.ok) return { ok: false, code: result.code, message: result.message };
        return { ok: true, result: { referenceId: result.locator.referenceId, changed: result.changed } };
      });
    },

    async validate(command) {
      return withLock("validate", async () => {
        const result = await validateDraftCandidateV1({ draftId: command.draftId }, { store, paths, clock: REAL_CLOCK });
        if (!result.ok) return { ok: false, code: result.code, message: result.message };
        return { ok: true, result };
      });
    },

    async certify(command) {
      return withLock("certify", async () => {
        const candidateBytes = await store.readArtifactBytes(command.draftId, "candidate");
        const evalsBytes = await store.readArtifactBytes(command.draftId, "evals");
        const [artifactSha256, evalSha256] = await Promise.all([sha256Bytes(candidateBytes), sha256Bytes(evalsBytes)]);
        const catalogFingerprint = await catalogFingerprintV1();
        const sourceStatusIndex = await readSourceStatusV1(paths.sourceStatusPath);
        const { canonicalJsonBytes } = await import("../agent/skillFoundry/hash");
        const sourceStatusIndexSha256 = await sha256Bytes(canonicalJsonBytes(sourceStatusIndex));
        const runId = `run-${randomUUID()}`;
        const runner = createDefaultCertificationRunnerV1(store);
        const supervisor = createProcessSupervisorV1();
        const result = await certifyDraftV1(
          {
            draftId: command.draftId,
            runId,
            bin: command.bin,
            artifact: { kind: "declarative_manifest", sha256: artifactSha256 },
            evalSha256,
            catalogFingerprint,
            sourceStatusIndexSha256,
          },
          { store, paths, clock: REAL_CLOCK, runner, supervisor },
        );
        return { ok: true, result };
      });
    },

    async "record-evidence"(command) {
      return withLock("record-evidence", async () => {
        const candidateBytes = await store.readArtifactBytes(command.draftId, "candidate");
        const evalsBytes = await store.readArtifactBytes(command.draftId, "evals");
        const [artifactSha256, evalSha256] = await Promise.all([sha256Bytes(candidateBytes), sha256Bytes(evalsBytes)]);
        let evidenceBytes: Uint8Array;
        try {
          evidenceBytes = await readBoundedNoFollowV1(command.evidencePath, FOUNDRY_STORAGE_LIMITS_V1.maxSourceCardBytes);
        } catch (err) {
          return { ok: false, code: "invalid_artifact", message: (err as Error).message };
        }
        let evidenceJson: Record<string, unknown> = {};
        try {
          evidenceJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(evidenceBytes));
        } catch (err) {
          return { ok: false, code: "invalid_artifact", message: (err as Error).message };
        }
        const pending = {
          runId: String(evidenceJson.runId ?? ""),
          caseId: command.caseId,
          expectedObservation: String(evidenceJson.expectedObservation ?? ""),
          artifact: { kind: "declarative_manifest" as const, sha256: artifactSha256 },
          evalSha256,
        };
        const result = await recordManualEvidenceV1(
          { draftId: command.draftId, evidenceBytes, pending },
          { draftDir: join(paths.draftsRoot, command.draftId), uid },
        );
        if (!result.ok) return { ok: false, code: result.code, message: result.message };
        return { ok: true, result: { changed: result.changed } };
      });
    },

    async review(command) {
      try {
        const review = await buildReviewV1({ draftId: command.draftId }, { store });
        return { ok: true, result: review };
      } catch (err) {
        return { ok: false, code: "wrong_state", message: (err as Error).message };
      }
    },

    async approve(command) {
      return withLock("approve", async () => {
        let attestationBytes: Uint8Array;
        try {
          attestationBytes = await readBoundedNoFollowV1(command.attestationPath, SKILL_LIMITS_V1.approvalBytes);
        } catch (err) {
          return { ok: false, code: "invalid_artifact", message: (err as Error).message };
        }
        const result = await approveDraftV1(
          { draftId: command.draftId, reviewSha256: command.reviewSha, attestationBytes },
          { store, clock: REAL_CLOCK },
        );
        if (!result.ok) return { ok: false, code: result.code, message: result.message };
        return { ok: true, result: result.approval };
      });
    },

    async install(command) {
      return withLock("install", async () => {
        const compatibilityContext = await buildCompatibilityContextV1();
        const result = await installDraftV1({ draftId: command.draftId }, { store, paths, clock: REAL_CLOCK, compatibilityContext });
        if (!result.ok) return { ok: false, code: result.code, message: result.message };
        return { ok: true, result };
      });
    },

    async rollback(command) {
      return withLock("rollback", async () => {
        const compatibilityContext = await buildCompatibilityContextV1();
        const result = await rollbackSkillV1({ skillId: command.skillId, version: command.version }, { store, paths, clock: REAL_CLOCK, compatibilityContext });
        if (!result.ok) return { ok: false, code: result.code, message: result.message };
        return { ok: true, result };
      });
    },

    async revoke(command) {
      return withLock("revoke", async () => {
        const compatibilityContext = await buildCompatibilityContextV1();
        const result = await revokeSkillV1({ skillId: command.skillId }, { store, paths, clock: REAL_CLOCK, compatibilityContext });
        return { ok: true, result };
      });
    },

    async "refresh-source"(command) {
      return withLock("refresh-source", async () => {
        let bytes: Uint8Array;
        try {
          bytes = await readBoundedNoFollowV1(command.cardPath, FOUNDRY_STORAGE_LIMITS_V1.maxSourceCardBytes);
        } catch (err) {
          return { ok: false, code: "invalid_source_card", message: (err as Error).message };
        }
        let json: unknown;
        try {
          json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch (err) {
          return { ok: false, code: "invalid_source_card", message: (err as Error).message };
        }
        const parsed = parseSourceCardV1(json);
        if (!parsed.ok) return { ok: false, code: "invalid_source_card", message: parsed.issues.map((i) => `${i.path}: ${i.message}`).join("; ") };
        const snapshotSha256 = await sourceSnapshotSha256V1(parsed.value);
        if (snapshotSha256 !== parsed.value.sourceSnapshotSha256) {
          return { ok: false, code: "invalid_source_card", message: "sourceSnapshotSha256 does not match the card's own content" };
        }
        const result = await refreshSourceStatusV1({
          sourceStatusPath: paths.sourceStatusPath,
          sourceCardsRoot: paths.sourceCardsRoot,
          card: parsed.value,
          snapshotSha256,
          clock: REAL_CLOCK,
        });
        if (!result.ok) return { ok: false, code: "invalid_source_card", message: result.code };
        return { ok: true, result: { generation: result.index.generation, changed: result.changed } };
      });
    },

    async "revoke-source"(command) {
      return withLock("revoke-source", async () => {
        const result = await revokeSourceStatusV1(paths.sourceStatusPath, command.sourceCardId, REAL_CLOCK);
        if (!result.ok) return { ok: false, code: result.code, message: result.message };
        return { ok: true, result: { generation: result.index.generation, changed: result.changed } };
      });
    },

    async gc(command) {
      // applyFoundryGcV1 takes the lock itself; a dry-run plan needs no lock at all.
      const plan = await planFoundryGcV1({}, { paths, clock: REAL_CLOCK, uid });
      if (!command.apply) {
        return { ok: true, result: { dryRun: true, plan } };
      }
      const applied = await applyFoundryGcV1(plan, { paths, clock: REAL_CLOCK, uid });
      return { ok: true, result: { dryRun: false, ...applied } };
    },

    async status(command) {
      if (!isSafePathComponentV1(command.draftId)) {
        return { ok: false, code: "unsafe_path", message: `unsafe draft id: ${command.draftId}` };
      }
      const statePath = join(paths.draftsRoot, command.draftId, "state.jsonl");
      let ledger;
      try {
        ledger = await readStateLedgerV1(statePath);
      } catch (err) {
        return { ok: false, code: "draft_not_found", message: (err as Error).message };
      }
      if (ledger.length === 0) {
        return { ok: false, code: "draft_not_found", message: `no such draft: ${command.draftId}` };
      }
      let hasIncompleteMarker = false;
      try {
        await readFile(join(paths.draftsRoot, command.draftId, ".authoring-v1.json"));
        hasIncompleteMarker = true;
      } catch {
        hasIncompleteMarker = false;
      }
      return {
        ok: true,
        result: {
          draftId: command.draftId,
          currentState: ledger[ledger.length - 1].state,
          recordCount: ledger.length,
          draftUpdateIncomplete: hasIncompleteMarker,
        },
      };
    },
  };
}

/** Parses, dispatches through `deps`, and always returns — never throws. */
export async function runTeachMoshiV1(argv: readonly string[], deps: TeachMoshiDepsV1): Promise<CliExecutionV1> {
  const parsed = parseTeachMoshiArgsV1(argv);
  if (!parsed.ok) {
    return {
      exitCode: 2,
      envelope: {
        schemaVersion: 1,
        ok: false,
        command: argv[0] ?? "",
        error: {
          code: "usage_error",
          message: parsed.issues[0]?.message ?? "usage error",
          details: { issues: parsed.issues },
        },
      },
    };
  }

  const command = parsed.value;
  const handler = deps[command.command] as (c: TeachMoshiCommandV1) => Promise<CommandHandlerResultV1>;
  try {
    const outcome = await handler(command);
    if (outcome.ok) {
      return {
        exitCode: 0,
        envelope: { schemaVersion: 1, ok: true, command: command.command, result: outcome.result },
      };
    }
    return {
      exitCode: 1,
      envelope: {
        schemaVersion: 1,
        ok: false,
        command: command.command,
        error: { code: outcome.code, message: outcome.message, details: outcome.details ?? {} },
      },
    };
  } catch (err) {
    return {
      exitCode: 1,
      envelope: {
        schemaVersion: 1,
        ok: false,
        command: command.command,
        error: {
          code: "io_error",
          message: err instanceof Error ? err.message : String(err),
          details: {},
        },
      },
    };
  }
}
