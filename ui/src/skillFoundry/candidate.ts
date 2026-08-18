// Task 6 — `validate` command core: binds exact manifest/eval/source/catalog hashes and
// appends `schema_valid`, or a stable blocker. Grammar/allowlist enforcement (owner
// primitives/predicates, typed refs, caps) is Slice A's job (`parseSkillManifestV1`); this
// module adds the draft-specific checks Slice A cannot know about: draft lifecycle state,
// atomic-only execution mode for owner-local skills, current source freshness, and catalog
// compatibility against the RUNNING catalog fingerprint.

import { parseSkillManifestV1 } from "../agent/skillFoundry/validate";
import { catalogFingerprintV1, NATIVE_SKILL_IDS_V1 } from "../agent/skillFoundry/catalogs";
import { validateSourceStatusForInvocationV1 } from "../agent/skillFoundry/packageValidation";
import { sha256Bytes } from "../agent/skillFoundry/hash";
import type { ClockV1, DraftStoreV1, FoundryPathsV1 } from "./contracts";
import { parseEvalCasesV1 } from "./evals";
import { readSourceStatusV1 } from "./sourceStatus";
import { appendStateTransitionV1 } from "./stateLedger";
import { resolveOfflineExecutionIdentityV1, type ExecutionIdentityDepsV1 } from "./draftStore";

export type ValidateDraftCandidateDepsV1 = {
  store: DraftStoreV1;
  paths: FoundryPathsV1;
  clock: ClockV1;
  identityDeps?: ExecutionIdentityDepsV1;
};

export type ValidateDraftCandidateResultV1 =
  | { ok: true; state: "schema_valid"; manifestSha256: string; evalSha256: string }
  | { ok: false; code: "invalid_artifact" | "blocked_missing_primitive" | "source_stale" | "wrong_state"; message: string };

export async function validateDraftCandidateV1(
  input: { draftId: string },
  deps: ValidateDraftCandidateDepsV1,
): Promise<ValidateDraftCandidateResultV1> {
  const snapshot = await deps.store.loadDraft(input.draftId);
  if (snapshot.currentState !== "source_reviewed") {
    return { ok: false, code: "wrong_state", message: `draft must be "source_reviewed" to validate, is "${String(snapshot.currentState)}"` };
  }

  const candidateBytes = await deps.store.readArtifactBytes(input.draftId, "candidate", { missing: "null" });
  if (candidateBytes === null) return { ok: false, code: "invalid_artifact", message: "candidate.skill.json is missing" };
  const evalsBytes = await deps.store.readArtifactBytes(input.draftId, "evals", { missing: "null" });
  if (evalsBytes === null) return { ok: false, code: "invalid_artifact", message: "evals.jsonl is missing" };

  let candidateJson: unknown;
  try {
    candidateJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(candidateBytes));
  } catch (err) {
    return { ok: false, code: "invalid_artifact", message: `candidate.skill.json is not valid UTF-8 JSON: ${(err as Error).message}` };
  }

  const manifestResult = parseSkillManifestV1(candidateJson);
  if (!manifestResult.ok) {
    const hasMissingPrimitive = manifestResult.issues.some((issue) => issue.code === "unknown_primitive" || issue.code === "unknown_predicate");
    return {
      ok: false,
      code: hasMissingPrimitive ? "blocked_missing_primitive" : "invalid_artifact",
      message: manifestResult.issues.map((i) => `${i.path}: ${i.message}`).join("; "),
    };
  }
  const manifest = manifestResult.value;

  if (!manifest.id.startsWith("owner-")) {
    return { ok: false, code: "invalid_artifact", message: `candidate id must use the owner- namespace, got "${manifest.id}"` };
  }
  if ((NATIVE_SKILL_IDS_V1 as readonly string[]).includes(manifest.id)) {
    return { ok: false, code: "invalid_artifact", message: `candidate id collides with a reserved native id: ${manifest.id}` };
  }
  if (manifest.execution.mode !== "atomic") {
    return { ok: false, code: "invalid_artifact", message: `owner-local skills must use execution.mode "atomic", got "${manifest.execution.mode}"` };
  }

  const evalsResult = parseEvalCasesV1(evalsBytes);
  if (!evalsResult.ok) {
    return { ok: false, code: "invalid_artifact", message: evalsResult.issues.map((i) => `${i.path}: ${i.message}`).join("; ") };
  }

  const freshIndex = await readSourceStatusV1(deps.paths.sourceStatusPath);
  const nowMs = deps.clock.now().getTime();
  for (const ref of manifest.provenance) {
    const check = validateSourceStatusForInvocationV1({ provenance: [ref], freshIndex, nowMs });
    if (!check.ok) {
      return { ok: false, code: "source_stale", message: `${check.code}: ${check.message}` };
    }
  }

  const fingerprint = await catalogFingerprintV1();
  if (
    manifest.compatibility.commandCatalogSha256 !== fingerprint.commandCatalogSha256 ||
    manifest.compatibility.predicateCatalogVersion !== fingerprint.predicateCatalogVersion ||
    manifest.compatibility.resolverCatalogVersion !== fingerprint.resolverCatalogVersion
  ) {
    return { ok: false, code: "invalid_artifact", message: "manifest compatibility does not match the running catalog fingerprint" };
  }

  const manifestSha256 = await sha256Bytes(candidateBytes);
  const evalSha256 = await sha256Bytes(evalsBytes);

  const executionIdentity = await resolveOfflineExecutionIdentityV1(deps.identityDeps);
  const nowIso = deps.clock.now().toISOString();
  await appendStateTransitionV1(snapshot.statePath, {
    state: "schema_valid",
    artifactKind: "declarative",
    artifactHashes: { manifest: manifestSha256, evals: evalSha256 },
    executionIdentity,
    testCommand: "teach-moshi validate",
    startedAt: nowIso,
    finishedAt: nowIso,
    result: "passed",
  });

  return { ok: true, state: "schema_valid", manifestSha256, evalSha256 };
}
