// Task 6 — validate and durably promote ONLY in D. Slice E's runner/graders are pure over
// supplied bytes/data and write disposable run-root outputs only; `certifyDraftV1` and
// `promoteNativeReleaseVerificationV1` are the sole places that parse a report/verification
// and atomically store it as current — the driver's own result value is never trusted enough
// to write approval, which the plan states explicitly must never happen here.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseNativeReleaseVerificationV1 } from "../agent/skillFoundry/validate";
import { canonicalJsonBytes, sha256Bytes } from "../agent/skillFoundry/hash";
import type {
  CertificationDriverResultV1,
  CertificationInvocationV1,
  ClockV1,
  DraftLifecycleStateV1,
  DraftStoreV1,
  ExecutionIdentityV1,
  FoundryPathsV1,
  FoundryStateRecordV1,
  ProcessSpecV1,
  ProcessSupervisorV1,
} from "./contracts";
import { atomicWriteBytesV1 } from "./safeFs";
import { appendStateTransitionV1 } from "./stateLedger";
import { resolveOfflineExecutionIdentityV1, type ExecutionIdentityDepsV1 } from "./draftStore";

export type CertificationCommandDepsV1 = {
  store: DraftStoreV1;
  paths: FoundryPathsV1;
  clock: ClockV1;
  identityDeps?: ExecutionIdentityDepsV1;
  runner: { run(input: CertificationInvocationV1, supervisor: ProcessSupervisorV1): Promise<CertificationDriverResultV1> };
  supervisor: ProcessSupervisorV1;
};

function decodeUtf8Strict(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

const GATE_STATE_MAP: Readonly<Record<string, DraftLifecycleStateV1>> = Object.freeze({
  mock: "mock_green",
  native: "native_green",
  packaged: "packaged_green",
  acceptance: "acceptance_green",
});

const CERTIFIABLE_STATES = new Set(["schema_valid", "mock_green", "native_green", "packaged_green"]);

export async function certifyDraftV1(input: CertificationInvocationV1, deps: CertificationCommandDepsV1): Promise<CertificationDriverResultV1> {
  const snapshot = await deps.store.loadDraft(input.draftId);
  if (!CERTIFIABLE_STATES.has(snapshot.currentState as string)) {
    return { kind: "blocked", code: "wrong_state", message: `draft must be schema_valid or a later pre-acceptance gate to certify, is "${String(snapshot.currentState)}"` };
  }

  const result = await deps.runner.run(input, deps.supervisor);
  if (result.kind !== "completed") return result;

  const report = result.report;
  if (
    report.artifact.sha256 !== input.artifact.sha256 ||
    report.evalSha256 !== input.evalSha256 ||
    report.runId !== input.runId ||
    report.state !== "acceptance_green"
  ) {
    return { kind: "blocked", code: "report_mismatch", message: "certification report does not match the requested invocation" };
  }

  const reportBytes = canonicalJsonBytes(report);
  const writeResult = await deps.store.writeArtifactBytes(input.draftId, "certification", reportBytes, { createOnly: true });
  if (!writeResult.ok && writeResult.code !== "already_exists") {
    return { kind: "blocked", code: writeResult.code, message: writeResult.message };
  }

  const executionIdentity = await resolveOfflineExecutionIdentityV1(deps.identityDeps);
  const reportSha256 = await sha256Bytes(reportBytes);
  for (const gateName of ["mock", "native", "packaged", "acceptance"] as const) {
    const gate = report.gates.find((g) => g.name === gateName);
    if (gate === undefined || gate.status !== "passed") continue;
    const nowIso = deps.clock.now().toISOString();
    try {
      await appendStateTransitionV1(snapshot.statePath, {
        state: GATE_STATE_MAP[gateName],
        artifactKind: "declarative",
        artifactHashes: { report: reportSha256 },
        executionIdentity,
        testCommand: `teach-moshi certify (${gateName})`,
        startedAt: nowIso,
        finishedAt: nowIso,
        result: "passed",
      });
    } catch {
      // Already at or past this stage (idempotent re-certify against an unchanged report).
    }
  }

  return result;
}

export type PromoteNativeReleaseVerificationInputV1 = { draftId: string; verificationBytes: Uint8Array };

/** Native-only: `owner_approved -> release_packaged_green -> certified`. Never writes approval. */
export async function promoteNativeReleaseVerificationV1(
  input: PromoteNativeReleaseVerificationInputV1,
  deps: CertificationCommandDepsV1,
): Promise<FoundryStateRecordV1> {
  const snapshot = await deps.store.loadDraft(input.draftId);
  if (snapshot.currentState !== "owner_approved") {
    throw new Error(`draft must be "owner_approved" to promote a native release verification, is "${String(snapshot.currentState)}"`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(decodeUtf8Strict(input.verificationBytes));
  } catch (err) {
    throw new Error(`native release verification is not valid UTF-8 JSON: ${(err as Error).message}`);
  }
  const parsed = parseNativeReleaseVerificationV1(parsedJson);
  if (!parsed.ok) {
    throw new Error(`invalid native release verification: ${parsed.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  }
  const verification = parsed.value;

  const payloadBytes = await deps.store.readArtifactBytes(input.draftId, "candidate");
  const reportBytes = await deps.store.readArtifactBytes(input.draftId, "certification");
  const approvalBytes = await deps.store.readArtifactBytes(input.draftId, "approval");
  const [payloadSha256, reportSha256, approvalSha256] = await Promise.all([
    sha256Bytes(payloadBytes),
    sha256Bytes(reportBytes),
    sha256Bytes(approvalBytes),
  ]);
  if (
    verification.nativePayloadSha256 !== payloadSha256 ||
    verification.certificationReportSha256 !== reportSha256 ||
    verification.approvalSha256 !== approvalSha256
  ) {
    throw new Error("native release verification hashes do not match the stored payload/report/approval");
  }

  const verificationBytesCanonical = canonicalJsonBytes(verification);
  const writeResult = await deps.store.writeArtifactBytes(input.draftId, "releaseVerification", verificationBytesCanonical, { createOnly: true });
  if (!writeResult.ok && writeResult.code !== "already_exists") {
    throw new Error(writeResult.message);
  }

  const offlineIdentity = await resolveOfflineExecutionIdentityV1(deps.identityDeps);
  const moshExecutionIdentity: ExecutionIdentityV1 = {
    gitCommit: offlineIdentity.gitCommit,
    appVersion: offlineIdentity.appVersion,
    build: { kind: "mosh", moshBuildIdentity: verification.moshBuildIdentity },
  };
  const verificationSha256 = await sha256Bytes(verificationBytesCanonical);
  const nowIso = deps.clock.now().toISOString();

  await appendStateTransitionV1(snapshot.statePath, {
    state: "release_packaged_green",
    artifactKind: "native",
    artifactHashes: { releaseVerification: verificationSha256 },
    executionIdentity: moshExecutionIdentity,
    testCommand: "teach-moshi (internal) promote-native-release-verification",
    startedAt: nowIso,
    finishedAt: nowIso,
    result: "passed",
  });
  return appendStateTransitionV1(snapshot.statePath, {
    state: "certified",
    artifactKind: "native",
    artifactHashes: { releaseVerification: verificationSha256 },
    executionIdentity: moshExecutionIdentity,
    testCommand: "teach-moshi (internal) promote-native-release-verification",
    startedAt: nowIso,
    finishedAt: nowIso,
    result: "passed",
  });
}

/**
 * Default production adapter. Until Slice E adds `--skill-foundry-certify-driver-v1` support
 * to the Mosh binary, this ALWAYS returns `certification_driver_unavailable` — it never
 * fabricates a pass.
 */
export function createDefaultCertificationRunnerV1(
  store: DraftStoreV1,
): { run(input: CertificationInvocationV1, supervisor: ProcessSupervisorV1): Promise<CertificationDriverResultV1> } {
  return {
    async run(input, supervisor) {
      const runDir = await store.createRunArtifactRoot(input.runId);
      const requestPath = join(runDir, "request.json");
      const resultPath = join(runDir, "result.json");
      await atomicWriteBytesV1(requestPath, canonicalJsonBytes(input));

      const spec: ProcessSpecV1 = {
        kind: "native_or_packaged",
        executable: input.bin,
        args: ["--skill-foundry-certify-driver-v1", "--request", requestPath, "--result", resultPath],
        cwd: runDir,
        env: {},
        logDirectory: runDir,
      };

      try {
        await supervisor.run(spec);
      } catch {
        return { kind: "blocked", code: "certification_driver_unavailable", message: "the Mosh binary could not be spawned" };
      }

      let resultBytes: Uint8Array;
      try {
        resultBytes = new Uint8Array(await readFile(resultPath));
      } catch {
        return { kind: "blocked", code: "certification_driver_unavailable", message: "no result.json was produced; --skill-foundry-certify-driver-v1 is not yet supported" };
      }
      return JSON.parse(decodeUtf8Strict(resultBytes)) as CertificationDriverResultV1;
    },
  };
}
