// Task 7 — the plain-language review contract and its binding owner attestation.
//
// `reviewSha256 = SHA256(UTF8("mosh-skill-review-v1\n" + artifactSha256 + "\n" +
// certificationReportSha256 + "\n"))` exactly, per spec §5.3 — both inputs are EXACT stored
// bytes, never canonicalized. `buildReviewV1` re-reads and re-hashes both files after
// rendering, so a mutation racing the render is caught rather than silently reviewed against
// stale bytes. A review that omits or paraphrases away `execution.confirmation` is invalid —
// enforced by rendering it as a required, verbatim-value section.

import type { ApprovalAttestationV1, ApproveDraftInputV1, ClockV1, DraftStoreV1, SkillApprovalV1, SkillReviewV1 } from "./contracts";
import { parseSkillManifestV1 } from "../agent/skillFoundry/validate";
import type { SkillManifestV1 } from "../agent/skillFoundry/contracts";
import { sha256Bytes, utf8Bytes, canonicalJsonBytes } from "../agent/skillFoundry/hash";
import { SKILL_LIMITS_V1 } from "../agent/skillFoundry/limits";
import { appendStateTransitionV1 } from "./stateLedger";
import { resolveOfflineExecutionIdentityV1, type ExecutionIdentityDepsV1 } from "./draftStore";

export type ReviewDepsV1 = { store: DraftStoreV1 };

function computeReviewSha256V1(artifactSha256: string, certificationReportSha256: string): Promise<string> {
  return sha256Bytes(utf8Bytes(`mosh-skill-review-v1\n${artifactSha256}\n${certificationReportSha256}\n`));
}

function renderMarkdownV1(manifest: SkillManifestV1): string {
  const slotsLines = manifest.slots
    .map((slot) => {
      const bounds: string[] = [];
      if (slot.minimum !== undefined) bounds.push(`min=${slot.minimum}`);
      if (slot.maximum !== undefined) bounds.push(`max=${slot.maximum}`);
      const defaultText = slot.default !== undefined ? `default=${JSON.stringify(slot.default)}` : "no default";
      return `- \`${slot.name}\` (${slot.type}, ${slot.required ? "required" : "optional"}): ${defaultText}${bounds.length > 0 ? `, ${bounds.join(", ")}` : ""}`;
    })
    .join("\n");
  const readsLines = manifest.steps.filter((s) => s.kind === "observe" || s.kind === "resolve").map((s) => (s.kind === "observe" ? `- observe \`${s.command}\`` : `- resolve \`${s.resolver}\``)).join("\n");
  const changesLines = manifest.steps.filter((s) => s.kind === "mutate").map((s) => `- mutate \`${s.command}\``).join("\n");

  return [
    `# ${manifest.title}`,
    "",
    "## When it runs",
    ...manifest.intents.positiveExamples.map((e) => `- "${e}"`),
    "",
    "## What it reads",
    readsLines || "- (none)",
    "",
    "## What it changes",
    changesLines || "- (none)",
    "",
    "## Variables",
    slotsLines || "- (none)",
    "",
    "## When it asks",
    `- confirmation: \`${manifest.execution.confirmation}\``,
    ...manifest.steps.filter((s) => s.kind === "resolve").map((s) => (s.kind === "resolve" ? `- choice \`${s.resolver}\`: up to ${s.maxChoices} option(s)` : "")),
    "",
    "## Success",
    manifest.responses.completed,
    "",
    "## Failure",
    manifest.responses.blocked,
    "",
    "## Undo posture",
    `- execution mode: \`${manifest.execution.mode}\` (${manifest.execution.mode === "atomic" ? "one identified rollback on failure" : "no atomic rollback claimed"})`,
    "",
  ].join("\n");
}

export async function buildReviewV1(input: { draftId: string }, deps: ReviewDepsV1): Promise<SkillReviewV1> {
  const snapshot = await deps.store.loadDraft(input.draftId);
  if (snapshot.currentState !== "acceptance_green") {
    throw new Error(`draft must be "acceptance_green" to review, is "${String(snapshot.currentState)}"`);
  }

  const candidateBytes = await deps.store.readArtifactBytes(input.draftId, "candidate");
  const certificationBytes = await deps.store.readArtifactBytes(input.draftId, "certification");

  const candidateJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(candidateBytes));
  const manifestResult = parseSkillManifestV1(candidateJson);
  if (!manifestResult.ok) {
    throw new Error(`candidate.skill.json is not a valid manifest: ${manifestResult.issues.map((i) => i.message).join("; ")}`);
  }

  const artifactSha256 = await sha256Bytes(candidateBytes);
  const certificationReportSha256 = await sha256Bytes(certificationBytes);
  const markdown = renderMarkdownV1(manifestResult.value);
  const reviewSha256 = await computeReviewSha256V1(artifactSha256, certificationReportSha256);

  // Re-read/re-hash before returning: a mutation racing the render must be caught, not
  // silently reviewed against bytes that are already stale by the time this returns.
  const recheckCandidate = await deps.store.readArtifactBytes(input.draftId, "candidate");
  const recheckCertification = await deps.store.readArtifactBytes(input.draftId, "certification");
  const recheckArtifactSha256 = await sha256Bytes(recheckCandidate);
  const recheckCertSha256 = await sha256Bytes(recheckCertification);
  if (recheckArtifactSha256 !== artifactSha256 || recheckCertSha256 !== certificationReportSha256) {
    throw new Error("candidate or certification report changed while building the review");
  }

  return { reviewSha256, markdown, artifactSha256, certificationReportSha256 };
}

const RFC3339_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export type ParseIssueV1 = { path: string; message: string };
export type ParseApprovalAttestationResultV1 = { ok: true; value: ApprovalAttestationV1 } | { ok: false; issues: readonly ParseIssueV1[] };

export function parseApprovalAttestationV1(value: unknown): ParseApprovalAttestationResultV1 {
  const issues: ParseIssueV1[] = [];
  if (value === null || typeof value !== "object") return { ok: false, issues: [{ path: "$", message: "not an object" }] };
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== 1) issues.push({ path: "schemaVersion", message: "must be 1" });
  if (typeof v.reviewSha256 !== "string" || !/^[0-9a-f]{64}$/.test(v.reviewSha256)) issues.push({ path: "reviewSha256", message: "must be 64 lowercase hex characters" });
  if (typeof v.exactStatement !== "string" || v.exactStatement.length === 0 || [...v.exactStatement].length > 4096) {
    issues.push({ path: "exactStatement", message: "must be a non-empty string of at most 4096 scalar values" });
  }
  if (typeof v.actor !== "string" || v.actor.length === 0 || [...v.actor].length > 256) issues.push({ path: "actor", message: "must be a non-empty string of at most 256 scalar values" });
  if (typeof v.channel !== "string" || v.channel.length === 0 || [...v.channel].length > 256) issues.push({ path: "channel", message: "must be a non-empty string of at most 256 scalar values" });
  if (v.conversationLocator !== undefined && (typeof v.conversationLocator !== "string" || [...v.conversationLocator].length > 2048)) {
    issues.push({ path: "conversationLocator", message: "must be a string of at most 2048 scalar values" });
  }
  if (typeof v.approvedAt !== "string" || !RFC3339_REGEX.test(v.approvedAt)) issues.push({ path: "approvedAt", message: "must be an RFC 3339 timestamp" });

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      reviewSha256: v.reviewSha256 as string,
      exactStatement: v.exactStatement as string,
      actor: v.actor as string,
      channel: v.channel as string,
      conversationLocator: v.conversationLocator as string | undefined,
      approvedAt: v.approvedAt as string,
    },
  };
}

export type ApprovalDepsV1 = { store: DraftStoreV1; clock: ClockV1; identityDeps?: ExecutionIdentityDepsV1 };
export type ApproveDraftResultV1 = { ok: true; approval: SkillApprovalV1 } | { ok: false; code: "review_sha_mismatch" | "invalid_artifact" | "wrong_state"; message: string };

export async function approveDraftV1(input: ApproveDraftInputV1, deps: ApprovalDepsV1): Promise<ApproveDraftResultV1> {
  let currentReview: SkillReviewV1;
  try {
    currentReview = await buildReviewV1({ draftId: input.draftId }, { store: deps.store });
  } catch (err) {
    return { ok: false, code: "wrong_state", message: (err as Error).message };
  }

  let attestationJson: unknown;
  try {
    attestationJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.attestationBytes));
  } catch (err) {
    return { ok: false, code: "invalid_artifact", message: `attestation is not valid UTF-8 JSON: ${(err as Error).message}` };
  }
  const parsed = parseApprovalAttestationV1(attestationJson);
  if (!parsed.ok) {
    return { ok: false, code: "invalid_artifact", message: parsed.issues.map((i) => `${i.path}: ${i.message}`).join("; ") };
  }
  const attestation = parsed.value;

  if (input.reviewSha256 !== attestation.reviewSha256 || attestation.reviewSha256 !== currentReview.reviewSha256) {
    return { ok: false, code: "review_sha_mismatch", message: "the CLI --review-sha, the attestation's reviewSha256, and the CURRENT review hash must all match exactly" };
  }

  const approval: SkillApprovalV1 = {
    schemaVersion: 1,
    state: "owner_approved",
    reviewSha256: currentReview.reviewSha256,
    artifact: { kind: "declarative_manifest", sha256: currentReview.artifactSha256 },
    certificationReportSha256: currentReview.certificationReportSha256,
    exactStatement: attestation.exactStatement,
    actor: attestation.actor,
    channel: attestation.channel,
    approvedAt: attestation.approvedAt,
    // Omit the key entirely when absent — `canonicalJsonBytes` rejects `undefined` values,
    // and an omitted optional field is not the same shape as one explicitly set to undefined.
    ...(attestation.conversationLocator !== undefined ? { conversationLocator: attestation.conversationLocator } : {}),
  };
  const approvalBytes = canonicalJsonBytes(approval);
  if (approvalBytes.length > SKILL_LIMITS_V1.approvalBytes) {
    return { ok: false, code: "invalid_artifact", message: `approval exceeds ${SKILL_LIMITS_V1.approvalBytes} bytes` };
  }

  const writeResult = await deps.store.writeArtifactBytes(input.draftId, "approval", approvalBytes, { createOnly: true });
  if (!writeResult.ok && writeResult.code !== "already_exists") {
    return { ok: false, code: "invalid_artifact", message: writeResult.message };
  }

  const snapshot = await deps.store.loadDraft(input.draftId);
  if (snapshot.currentState !== "owner_approved") {
    const executionIdentity = await resolveOfflineExecutionIdentityV1(deps.identityDeps);
    const nowIso = deps.clock.now().toISOString();
    await appendStateTransitionV1(snapshot.statePath, {
      state: "owner_approved",
      artifactKind: "declarative",
      artifactHashes: { approval: await sha256Bytes(approvalBytes) },
      executionIdentity,
      testCommand: "teach-moshi approve",
      startedAt: nowIso,
      finishedAt: nowIso,
      result: "passed",
    });
  }

  return { ok: true, approval };
}
