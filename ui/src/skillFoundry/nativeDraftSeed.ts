// Task 6 — trusted native-core draft seeding. Native drafts use one of the FOUR bare
// canonical IDs directly (never the "owner-" namespace), so `createDraft`'s public path
// (always "owner-*") can never collide with or overwrite a native draft. Both the native
// payload and its frozen evals publish ATOMICALLY together — neither can become "current"
// alone, satisfying "there is no native-eval-only authoring mode".

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { NATIVE_SKILL_IDS_V1 } from "../agent/skillFoundry/catalogs";
import { parseNativeSkillPayloadV1 } from "../agent/skillFoundry/validate";
import { sha256Bytes, canonicalJsonBytes } from "../agent/skillFoundry/hash";
import type { ClockV1, DraftStoreV1, FoundryPathsV1, SeedNativeCoreDraftInputV1, SeedNativeCoreDraftResultV1 } from "./contracts";
import { atomicPublishDirectoryV1, atomicWriteBytesV1 } from "./safeFs";
import { assertQuotaMutationV1, measureFoundryQuotaV1 } from "./quota";
import { appendStateTransitionV1 } from "./stateLedger";
import { resolveOfflineExecutionIdentityV1, type ExecutionIdentityDepsV1 } from "./draftStore";
import { parseEvalCasesV1 } from "./evals";

export type NativeDraftSeedDepsV1 = { store: DraftStoreV1; paths: FoundryPathsV1; clock: ClockV1; identityDeps?: ExecutionIdentityDepsV1 };

function decodeUtf8Strict(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function seedNativeCoreDraftV1(
  input: SeedNativeCoreDraftInputV1,
  deps: NativeDraftSeedDepsV1,
): Promise<SeedNativeCoreDraftResultV1> {
  let payloadJson: unknown;
  try {
    payloadJson = JSON.parse(decodeUtf8Strict(input.nativePayloadBytes));
  } catch (err) {
    throw new Error(`native payload is not valid UTF-8 JSON: ${(err as Error).message}`);
  }
  const payloadResult = parseNativeSkillPayloadV1(payloadJson);
  if (!payloadResult.ok) {
    throw new Error(`invalid native payload: ${payloadResult.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  }
  const payload = payloadResult.value;
  if (!(NATIVE_SKILL_IDS_V1 as readonly string[]).includes(payload.id)) {
    throw new Error(`native payload id is not one of the four canonical ids: ${payload.id}`);
  }

  const evalsResult = parseEvalCasesV1(input.evalsJsonlBytes);
  if (!evalsResult.ok) {
    throw new Error(`invalid native evals: ${evalsResult.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  }
  if (evalsResult.value.length === 0) {
    throw new Error("native evals must contain at least one case");
  }
  const mismatched = evalsResult.value.find((c) => c.selected.journeyId !== payload.id);
  if (mismatched !== undefined) {
    throw new Error(
      `eval case "${mismatched.id}" targets journey "${mismatched.selected.journeyId}", but the payload id is "${payload.id}" (mixed-journey evals are rejected)`,
    );
  }

  const draftDir = join(deps.paths.draftsRoot, payload.id);

  const snapshot = await measureFoundryQuotaV1(deps.paths);
  assertQuotaMutationV1(snapshot, { newDraft: true });

  const nativePayloadSha256 = await sha256Bytes(input.nativePayloadBytes);
  const evalSha256 = await sha256Bytes(input.evalsJsonlBytes);

  try {
    await atomicPublishDirectoryV1(draftDir, async (stagingDir) => {
      await mkdir(join(stagingDir, "sources"), { recursive: true, mode: 0o700 });
      await mkdir(join(stagingDir, "references"), { recursive: true, mode: 0o700 });

      const requestPayload = { schemaVersion: 1, skillId: payload.id, goal: input.goal, createdAt: deps.clock.now().toISOString() };
      await atomicWriteBytesV1(join(stagingDir, "request.json"), canonicalJsonBytes(requestPayload));

      // The native payload occupies the SAME "candidate.skill.json" artifact slot a
      // declarative candidate would — `SkillArtifactRefV1.kind` (not the filename)
      // discriminates declarative_manifest vs native_payload downstream.
      await atomicWriteBytesV1(join(stagingDir, "candidate.skill.json"), input.nativePayloadBytes);
      await atomicWriteBytesV1(join(stagingDir, "evals.jsonl"), input.evalsJsonlBytes);

      const executionIdentity = await resolveOfflineExecutionIdentityV1(deps.identityDeps);
      const nowIso = deps.clock.now().toISOString();
      await appendStateTransitionV1(join(stagingDir, "state.jsonl"), {
        state: "draft",
        artifactKind: "native",
        artifactHashes: { nativePayload: nativePayloadSha256, evals: evalSha256 },
        executionIdentity,
        testCommand: "teach-moshi (internal) seed-native-core-draft",
        startedAt: nowIso,
        finishedAt: nowIso,
        result: "passed",
      });
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST" || (err as NodeJS.ErrnoException).code === "ENOTEMPTY") {
      throw new Error(`draft id collision: native core "${payload.id}" is already seeded`);
    }
    throw err;
  }

  const draft = await deps.store.loadDraft(payload.id);
  return { draft, artifact: { kind: "native_payload", sha256: nativePayloadSha256 }, evalSha256 };
}
