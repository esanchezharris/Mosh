// Task 9 — Assemble Active-Only Startup Loading and Quarantine.
//
// SCOPE: this module is the STARTUP ASSEMBLY POINT for Slice A. It does not implement any
// new validation, adaptation, or registry logic — it wires together, in order:
//
//   1. Task 4's non-MoshOps native reads (`nativeReads.ts`, injected here as `readPackages`/
//      `readBundledNative` so this module never imports the bridge directly and stays trivially
//      testable with an in-memory fixture);
//   2. Task 3's hash-chain/compatibility validators (`validateCertifiedSkillPackageV1`,
//      `validateNativeArtifactGraphV1`, `validateSourceStatusForInvocationV1`);
//   3. Task 5's adapters and collision checks (`adaptDeclarativeSkillV1`, `adaptNativeSkillV1`,
//      `validateRegistryCandidateV1`, `validateReleaseIdentityUniverseV1`).
//
// It selects, for each `owner-*` id named in the OWNER active index, the EXACT `<id>@<version>`
// package the index names — never an older/newer sibling that happens to also be on disk (spec:
// "owner packages load only at app startup"; the plan's own Task 9 Step 3: "Never fall back to
// an older/code-only candidate"). A package that fails ANY check is quarantined with a typed
// diagnostic; its accepted siblings are unaffected — that per-package independence is the whole
// point of this task (see the CLAUDE.md "quarantine is the point" discipline note).
//
// Two independent loaders are exported, matching the plan's Cross-Slice "Interfaces" line
// exactly: `loadCertifiedOwnerSkillsV1` (owner-local declarative packages under
// `$MOSH_AGENT_DIR`) and `loadBundledNativeSkillsV1` (native packages staged into the app's own
// resources). Neither constructs the final runtime registry — Slice B combines both loaders'
// `accepted` candidates (plus any bundled-declarative candidates) into one
// `buildStudioSkillRegistryV1` call. Slice A ships zero bundled native/declarative resources
// (Task 5's own constraints: `resources/skills/native/` and `resources/skills/declarative/` are
// never created in the source tree), so `loadBundledNativeSkillsV1`'s real production result is
// always empty today; its RED tests inject an in-memory fixture, exactly like Slice B will once
// Slice E stages real approved native resources.
//
// UNTRUSTED INPUT DISCIPLINE: every path through both loaders returns a discriminated result.
// Nothing here throws across the startup boundary — a native read that rejects, a malformed
// index, a tampered package, or a cross-origin identity collision all degrade to FEWER accepted
// skills, never to an unhandled exception or a partial/inconsistent registry.

import { SKILL_LIMITS_V1 } from "./limits";
import { sha256Bytes, utf8Bytes } from "./hash";
import { adaptDeclarativeSkillV1 } from "./declarativeAdapter";
import { adaptNativeSkillV1, type NativeAdapterFailureCodeV1 } from "./nativeAdapter";
import {
  validateCertifiedSkillPackageV1,
  validateNativeArtifactGraphV1,
  validateSourceStatusForInvocationV1,
  type PackageValidationFailureCodeV1,
  type SourceStatusCheckFailureCodeV1,
} from "./packageValidation";
import {
  validateRegistryCandidateV1,
  validateReleaseIdentityUniverseV1,
  type RegistryCandidateFailureCodeV1,
  type ReleaseIdentityUniverseEntryV1,
} from "./registry";
import type {
  CertifiedNativeSkillLoadV1,
  CertifiedSkillFileV1,
  CertifiedSkillLoadDiagnosticV1,
  CertifiedSkillLoadV1,
  RegisteredSkillV1,
  SkillActivationIndexV1,
  SkillCompatibilityContextV1,
} from "./contracts";

// ---------------------------------------------------------------------------------------
// Shared: exact-byte re-verification for the two "index" files this task owns (the owner
// active/source-status indexes and the native resource index). This is the SAME "cap, then
// hash, then parse" pattern `packageValidation.ts`'s (unexported) `verifyFileBytes` uses for
// the four-file chain — duplicated here at ~10 lines rather than exported from that module,
// because an index file is not part of Task 3's chain (it has no sibling artifacts to bind
// against); it is this task's own untrusted-JSON boundary.
// ---------------------------------------------------------------------------------------

type IndexBytesFailureV1 = { readonly ok: false; readonly code: string; readonly message: string };
type IndexBytesResultV1 = { readonly ok: true; readonly parsed: unknown } | IndexBytesFailureV1;

async function verifyIndexBytes(file: CertifiedSkillFileV1, capBytes: number, label: string): Promise<IndexBytesResultV1> {
  const bytes = utf8Bytes(file.utf8);
  if (bytes.length > capBytes) {
    return { ok: false, code: "oversized", message: `${label} exceeds the ${capBytes}-byte cap` };
  }
  if (bytes.length !== file.bytes) {
    return { ok: false, code: "hash_mismatch", message: `${label} claimed byte count does not match its exact stored bytes` };
  }
  const sha256 = await sha256Bytes(bytes);
  if (sha256 !== file.sha256) {
    return { ok: false, code: "hash_mismatch", message: `${label} claimed sha256 does not match its exact stored bytes` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.utf8);
  } catch {
    return { ok: false, code: "invalid_json", message: `${label} is not valid JSON` };
  }
  return { ok: true, parsed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------------------
// Owner active index shape (contracts.ts already defines `SkillActivationIndexV1` — this is
// its own untrusted-JSON parse, distinct from Task 2's manifest grammar, because the active
// index is not a manifest and has no Task-2 parser).
// ---------------------------------------------------------------------------------------

function parseOwnerActiveIndexShape(parsed: unknown): { ok: true; value: SkillActivationIndexV1 } | { ok: false; message: string } {
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || typeof parsed.generation !== "number" || !isRecord(parsed.skills)) {
    return { ok: false, message: "active index must be {schemaVersion:1, generation:number, skills:{...}}" };
  }
  const skills: Record<string, { version: string; manifestSha256: string; releaseSha256: string }> = {};
  for (const [id, raw] of Object.entries(parsed.skills)) {
    if (!isRecord(raw) || typeof raw.version !== "string" || typeof raw.manifestSha256 !== "string" || typeof raw.releaseSha256 !== "string") {
      return { ok: false, message: `active index entry "${id}" is malformed` };
    }
    skills[id] = { version: raw.version, manifestSha256: raw.manifestSha256, releaseSha256: raw.releaseSha256 };
  }
  return { ok: true, value: { schemaVersion: 1, generation: parsed.generation, skills } };
}

// ---------------------------------------------------------------------------------------
// loadCertifiedOwnerSkillsV1
// ---------------------------------------------------------------------------------------

export type OwnerSkillQuarantineCodeV1 =
  | PackageValidationFailureCodeV1
  | SourceStatusCheckFailureCodeV1
  | RegistryCandidateFailureCodeV1
  | "missing_package"
  | "duplicate_package"
  | "active_index_hash_mismatch";

export type OwnerSkillQuarantineEntryV1 = {
  readonly id: string;
  readonly version: string;
  readonly code: OwnerSkillQuarantineCodeV1;
  readonly message: string;
};

export type CertifiedOwnerSkillLoadResultV1 = {
  readonly accepted: readonly RegisteredSkillV1[];
  readonly quarantined: readonly OwnerSkillQuarantineEntryV1[];
  readonly diagnostics: readonly CertifiedSkillLoadDiagnosticV1[];
  readonly activationGeneration: number | null;
  readonly activationIndexSha256: string | null;
  readonly sourceStatusGeneration: number | null;
  readonly sourceStatusIndexSha256: string | null;
};

// DESIGN DECISION: `nativeIdentityUniverse`/`declarativeIdentityUniverse` are not named in the
// plan's Cross-Slice APIs (only the two-key example `{readPackages, compatibility}` is shown).
// They exist so this loader can run Task 5's `validateReleaseIdentityUniverseV1` — which the
// plan's Task 9 Step 3 explicitly requires ("run validateReleaseIdentityUniverseV1 over native
// IDs/aliases, bundled-declarative IDs, and the actual parsed owner active index before
// returning candidates") — without hard-importing a native/declarative bundled-index reader
// Slice A never ships real content for. Both default to `[]`: in production, Slice A has zero
// bundled native/declarative resources, so the universe check degenerates to "are the owner
// active IDs internally collision-free" (always true — they are object keys); Slice B (and this
// task's own RED tests) inject real fixtures to exercise the cross-origin collision path.
export type CertifiedOwnerSkillLoadInputV1 = {
  readonly readPackages: () => Promise<CertifiedSkillLoadV1>;
  readonly compatibility: SkillCompatibilityContextV1;
  readonly nowMs?: number;
  readonly nativeIdentityUniverse?: readonly ReleaseIdentityUniverseEntryV1[];
  readonly declarativeIdentityUniverse?: readonly ReleaseIdentityUniverseEntryV1[];
};

const EMPTY_ACCEPTED: readonly RegisteredSkillV1[] = Object.freeze([]);
const EMPTY_OWNER_QUARANTINE: readonly OwnerSkillQuarantineEntryV1[] = Object.freeze([]);

function ownerEmptyResult(diagnostics: readonly CertifiedSkillLoadDiagnosticV1[]): CertifiedOwnerSkillLoadResultV1 {
  return {
    accepted: EMPTY_ACCEPTED,
    quarantined: EMPTY_OWNER_QUARANTINE,
    diagnostics,
    activationGeneration: null,
    activationIndexSha256: null,
    sourceStatusGeneration: null,
    sourceStatusIndexSha256: null,
  };
}

export async function loadCertifiedOwnerSkillsV1(input: CertifiedOwnerSkillLoadInputV1): Promise<CertifiedOwnerSkillLoadResultV1> {
  try {
    let load: CertifiedSkillLoadV1;
    try {
      load = await input.readPackages();
    } catch (error) {
      return ownerEmptyResult([{ path: "$root", code: "read_failed", message: String(error) }]);
    }

    if (!load.ok) return ownerEmptyResult(load.diagnostics);

    // Structural byte-budget check runs before anything else is even parsed: a native layer
    // that reports more bytes than the startup budget allows is refused wholesale, regardless
    // of whether an active index is even present.
    if (load.totalBytes > SKILL_LIMITS_V1.startupPackageBytes) {
      return ownerEmptyResult([
        ...load.diagnostics,
        { path: "$root.totalBytes", code: "oversized_load", message: "startup package bytes exceed the cap" },
      ]);
    }

    if (load.activeIndex === null) return ownerEmptyResult(load.diagnostics);

    const activeVerified = await verifyIndexBytes(load.activeIndex, SKILL_LIMITS_V1.activationIndexBytes, "activeIndex");
    if (!activeVerified.ok) {
      return ownerEmptyResult([...load.diagnostics, { path: "activeIndex", code: activeVerified.code, message: activeVerified.message }]);
    }
    const activeShape = parseOwnerActiveIndexShape(activeVerified.parsed);
    if (!activeShape.ok) {
      return ownerEmptyResult([...load.diagnostics, { path: "activeIndex", code: "invalid_active_index", message: activeShape.message }]);
    }
    const activeIndex = activeShape.value;

    // Sorted for deterministic processing/output regardless of the fixture's own key order —
    // `Object.keys` order over string keys IS insertion order in practice, but this task does
    // not rely on that.
    const activeIds = Object.keys(activeIndex.skills).sort();
    if (activeIds.length > SKILL_LIMITS_V1.activationEntries) {
      return ownerEmptyResult([
        ...load.diagnostics,
        { path: "activeIndex.skills", code: "too_many_entries", message: `active index exceeds ${SKILL_LIMITS_V1.activationEntries} entries` },
      ]);
    }

    // Cheap, pre-package-read identity-universe gate (Task 9 Step 3): if any active id
    // collides with a native canonical id/alias or a bundled-declarative id, the WHOLE owner
    // load is rejected — never a partial registry, and never a "replace the prior registry
    // with a subset" outcome (there is no prior registry here; this loader simply returns
    // nothing, which is what "publish zero replacement registry entries" means at this layer).
    const universe = validateReleaseIdentityUniverseV1({
      native: input.nativeIdentityUniverse ?? [],
      declarative: input.declarativeIdentityUniverse ?? [],
      owner: activeIds.map((id) => ({ id })),
    });
    if (!universe.ok) {
      return ownerEmptyResult([
        ...load.diagnostics,
        {
          path: "activeIndex.skills",
          code: "duplicate_identity",
          message: `identity "${universe.identity}" collides across the native/declarative/owner universe`,
        },
      ]);
    }

    let sourceStatusParsed: unknown = null;
    let sourceStatusGeneration: number | null = null;
    const diagnostics: CertifiedSkillLoadDiagnosticV1[] = [...load.diagnostics];
    if (load.sourceStatusIndex !== null) {
      const sourceVerified = await verifyIndexBytes(load.sourceStatusIndex, SKILL_LIMITS_V1.sourceStatusBytes, "sourceStatusIndex");
      if (sourceVerified.ok) {
        sourceStatusParsed = sourceVerified.parsed;
        if (isRecord(sourceVerified.parsed) && typeof sourceVerified.parsed.generation === "number") {
          sourceStatusGeneration = sourceVerified.parsed.generation;
        }
      } else {
        // A tampered/oversized source-status index is not fatal to the whole load: it
        // degrades to "no fresh index available" for every package that HAS provenance (each
        // quarantines individually below with `missing_index`), while provenance-less
        // packages are unaffected — `validateSourceStatusForInvocationV1` short-circuits
        // `ok:true` for empty provenance.
        diagnostics.push({ path: "sourceStatusIndex", code: sourceVerified.code, message: sourceVerified.message });
      }
    }

    const nowMs = input.nowMs ?? Date.now();
    const accepted: RegisteredSkillV1[] = [];
    const quarantined: OwnerSkillQuarantineEntryV1[] = [];
    const occupied = new Set<string>();

    for (const id of activeIds) {
      const entry = activeIndex.skills[id];
      const version = entry.version;

      if (!id.startsWith("owner-")) {
        quarantined.push({ id, version, code: "invalid_owner_prefix", message: `active id "${id}" is not owner-prefixed` });
        continue;
      }

      const matches = load.packages.filter((p) => p.skillIdFromDirectory === id && p.versionFromDirectory === version);
      if (matches.length === 0) {
        quarantined.push({ id, version, code: "missing_package", message: `no package on disk for active ${id}@${version}` });
        continue;
      }
      if (matches.length > 1) {
        quarantined.push({ id, version, code: "duplicate_package", message: `more than one package on disk claims ${id}@${version}` });
        continue;
      }

      const validated = await validateCertifiedSkillPackageV1(matches[0], input.compatibility);
      if (!validated.ok) {
        quarantined.push({ id, version, code: validated.code, message: validated.message });
        continue;
      }

      if (validated.value.manifestSha256 !== entry.manifestSha256 || validated.value.releaseSha256 !== entry.releaseSha256) {
        quarantined.push({
          id,
          version,
          code: "active_index_hash_mismatch",
          message: `active index hashes for ${id}@${version} do not match the validated package`,
        });
        continue;
      }

      const sourceCheck = validateSourceStatusForInvocationV1({
        provenance: validated.value.manifest.provenance,
        freshIndex: sourceStatusParsed,
        nowMs,
      });
      if (!sourceCheck.ok) {
        quarantined.push({ id, version, code: sourceCheck.code, message: sourceCheck.message });
        continue;
      }

      const candidate = adaptDeclarativeSkillV1(validated.value);
      const registryCheck = validateRegistryCandidateV1(candidate, occupied);
      if (!registryCheck.ok) {
        quarantined.push({ id, version, code: registryCheck.code, message: `registry candidate rejected: ${registryCheck.code}` });
        continue;
      }
      for (const identity of [candidate.id, ...candidate.aliases]) occupied.add(identity.toLowerCase());
      accepted.push(candidate);
    }

    accepted.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    return {
      accepted,
      quarantined,
      diagnostics,
      activationGeneration: activeIndex.generation,
      activationIndexSha256: load.activeIndex.sha256,
      sourceStatusGeneration,
      sourceStatusIndexSha256: load.sourceStatusIndex?.sha256 ?? null,
    };
  } catch (error) {
    // Defense in depth against a bug anywhere above: startup degrades to zero owner skills,
    // never to an unhandled exception (this task's own "no thrown untrusted error" case).
    return ownerEmptyResult([{ path: "$root", code: "unexpected_error", message: String(error) }]);
  }
}

// ---------------------------------------------------------------------------------------
// loadBundledNativeSkillsV1
// ---------------------------------------------------------------------------------------

// DESIGN DECISION: neither the native resource index's content shape nor its byte cap is
// given anywhere in the plan or spec (`CertifiedNativeSkillLoadV1.resourceIndex` is typed only
// as an opaque `CertifiedSkillFileV1` in contracts.ts). Modeled as the native analogue of the
// bundled-index shape `verifySkillIdentityUniverse.mts` already reads for its own collision
// gate (`{schemaVersion:1, skills:[{id, ...}]}`), narrowed to exactly what THIS loader needs to
// locate each indexed package on disk: `id` + `version` (the alias/collision concern that
// script's `skills[].aliases` field exists for is a Slice-B/identity-universe concern, not
// this loader's — `adaptNativeSkillV1` already derives aliases from the validated PAYLOAD
// itself, never from an index). "a valid sorted index" (Task 9 Step 1) is enforced as strict
// ascending order by `id` with no duplicates. The byte cap reuses `SKILL_LIMITS_V1.
// activationIndexBytes` — the same order-of-magnitude "one small index file" budget the owner
// active index uses; there is no dedicated native-resource-index limit to reuse instead.
type NativeResourceIndexEntryV1 = { readonly id: string; readonly version: string };
type NativeResourceIndexV1 = { readonly schemaVersion: 1; readonly skills: readonly NativeResourceIndexEntryV1[] };

function parseNativeResourceIndexShape(parsed: unknown): { ok: true; value: NativeResourceIndexV1 } | { ok: false; message: string } {
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.skills)) {
    return { ok: false, message: "resource index must be {schemaVersion:1, skills:[...]}" };
  }
  const skills: NativeResourceIndexEntryV1[] = [];
  for (let i = 0; i < parsed.skills.length; i++) {
    const raw: unknown = parsed.skills[i];
    if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.version !== "string") {
      return { ok: false, message: `resource index entry [${i}] must have string id/version` };
    }
    skills.push({ id: raw.id, version: raw.version });
  }
  for (let i = 1; i < skills.length; i++) {
    if (skills[i - 1].id >= skills[i].id) {
      return { ok: false, message: "resource index skills must be sorted ascending by id with no duplicates" };
    }
  }
  return { ok: true, value: { schemaVersion: 1, skills } };
}

export type NativeSkillQuarantineCodeV1 =
  | PackageValidationFailureCodeV1
  | NativeAdapterFailureCodeV1
  | RegistryCandidateFailureCodeV1
  | "missing_package"
  | "duplicate_package";

export type NativeSkillQuarantineEntryV1 = {
  readonly id: string;
  readonly version: string;
  readonly code: NativeSkillQuarantineCodeV1;
  readonly message: string;
};

export type CertifiedNativeSkillLoadResultV1 = {
  readonly accepted: readonly RegisteredSkillV1[];
  readonly quarantined: readonly NativeSkillQuarantineEntryV1[];
  readonly diagnostics: readonly CertifiedSkillLoadDiagnosticV1[];
  readonly resourceIndexSha256: string | null;
  readonly build: CertifiedNativeSkillLoadV1["build"] | null;
};

export type CertifiedNativeSkillLoadInputV1 = {
  readonly readBundledNative: () => Promise<CertifiedNativeSkillLoadV1>;
  readonly compatibility: SkillCompatibilityContextV1;
};

const EMPTY_NATIVE_QUARANTINE: readonly NativeSkillQuarantineEntryV1[] = Object.freeze([]);

function nativeEmptyResult(
  diagnostics: readonly CertifiedSkillLoadDiagnosticV1[],
  build: CertifiedNativeSkillLoadV1["build"] | null,
): CertifiedNativeSkillLoadResultV1 {
  return { accepted: EMPTY_ACCEPTED, quarantined: EMPTY_NATIVE_QUARANTINE, diagnostics, resourceIndexSha256: null, build };
}

export async function loadBundledNativeSkillsV1(input: CertifiedNativeSkillLoadInputV1): Promise<CertifiedNativeSkillLoadResultV1> {
  try {
    let load: CertifiedNativeSkillLoadV1;
    try {
      load = await input.readBundledNative();
    } catch (error) {
      return nativeEmptyResult([{ path: "$root", code: "read_failed", message: String(error) }], null);
    }

    if (!load.ok) return nativeEmptyResult(load.diagnostics, null);

    if (load.totalBytes > SKILL_LIMITS_V1.startupPackageBytes) {
      return nativeEmptyResult(
        [...load.diagnostics, { path: "$root.totalBytes", code: "oversized_load", message: "startup package bytes exceed the cap" }],
        load.build,
      );
    }

    // Zero registration when the index is absent — this is the expected Slice A steady state
    // (no bundled native resources ship yet), not an error (Task 9 Step 3's own text).
    if (load.resourceIndex === null) return nativeEmptyResult(load.diagnostics, load.build);

    const indexVerified = await verifyIndexBytes(load.resourceIndex, SKILL_LIMITS_V1.activationIndexBytes, "resourceIndex");
    if (!indexVerified.ok) {
      return nativeEmptyResult([...load.diagnostics, { path: "resourceIndex", code: indexVerified.code, message: indexVerified.message }], load.build);
    }
    const shape = parseNativeResourceIndexShape(indexVerified.parsed);
    if (!shape.ok) {
      return nativeEmptyResult([...load.diagnostics, { path: "resourceIndex", code: "invalid_resource_index", message: shape.message }], load.build);
    }

    const diagnostics: CertifiedSkillLoadDiagnosticV1[] = [...load.diagnostics];
    const accepted: RegisteredSkillV1[] = [];
    const quarantined: NativeSkillQuarantineEntryV1[] = [];
    const occupied = new Set<string>();

    for (const entry of shape.value.skills) {
      const { id, version } = entry;
      const matches = load.packages.filter((p) => p.skillIdFromDirectory === id && p.versionFromDirectory === version);
      if (matches.length === 0) {
        quarantined.push({ id, version, code: "missing_package", message: `no bundled package for native ${id}@${version}` });
        continue;
      }
      if (matches.length > 1) {
        quarantined.push({ id, version, code: "duplicate_package", message: `more than one bundled package claims ${id}@${version}` });
        continue;
      }

      const pkg = matches[0];
      const graph = await validateNativeArtifactGraphV1(
        { payload: pkg.files.payload, certification: pkg.files.certification, approval: pkg.files.approval, bundleEntry: pkg.files.bundleEntry },
        input.compatibility,
      );
      if (!graph.ok) {
        quarantined.push({ id, version, code: graph.code, message: graph.message });
        continue;
      }

      const adapted = adaptNativeSkillV1(graph);
      if (!adapted.ok) {
        quarantined.push({ id, version, code: adapted.code, message: adapted.message });
        continue;
      }

      const registryCheck = validateRegistryCandidateV1(adapted.value, occupied);
      if (!registryCheck.ok) {
        quarantined.push({ id, version, code: registryCheck.code, message: `registry candidate rejected: ${registryCheck.code}` });
        continue;
      }
      for (const identity of [adapted.value.id, ...adapted.value.aliases]) occupied.add(identity.toLowerCase());
      accepted.push(adapted.value);
    }

    accepted.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    return { accepted, quarantined, diagnostics, resourceIndexSha256: load.resourceIndex.sha256, build: load.build };
  } catch (error) {
    return nativeEmptyResult([{ path: "$root", code: "unexpected_error", message: String(error) }], null);
  }
}
