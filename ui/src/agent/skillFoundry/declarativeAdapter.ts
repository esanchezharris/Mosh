// Task 5 — the declarative registry adapter: maps one Task-3-validated owner-local manifest
// (`ValidatedDeclarativeSkillV1`) into a `RegisteredSkillV1` registry candidate.
//
// SCOPE: pure mapping only. Task 3's `validateCertifiedSkillPackageV1` has already verified
// the hash chain, state machine, directory identity, and compatibility context by the time a
// `ValidatedDeclarativeSkillV1` exists — there is nothing left for this adapter to validate.
// "Closes over its exact artifact" (Task 5 Step 3) means the returned candidate's `manifest`
// IS `validated.manifest` — the same parsed object, not a re-serialized or partially-copied
// one. Declarative manifests never carry legacy aliases (spec 8.1's `legacyAliases` field
// exists only on `NativeSkillPayloadV1`), so `aliases` is always empty here. Every owner-local
// v1 manifest's `id` is already prefixed `owner-` (Task 2's `parseSkillManifestV1` grammar) —
// `registry.ts`'s `validateRegistryCandidateV1` re-checks that prefix at registry-construction
// time regardless, so this adapter does not duplicate that check.

import type { RegisteredSkillV1 } from "./contracts";
import type { ValidatedDeclarativeSkillV1 } from "./packageValidation";

export function adaptDeclarativeSkillV1(validated: ValidatedDeclarativeSkillV1): RegisteredSkillV1 {
  return {
    id: validated.id,
    origin: "owner",
    aliases: [],
    manifest: validated.manifest,
  };
}
