// Task 5 — Construct a Collision-Free Registry and Adapters.
//
// SCOPE: this module owns two related but distinct collision-freedom checks:
//
//   - `buildStudioSkillRegistryV1` / `validateRegistryCandidateV1` — construct the ACTUAL
//     runtime `StudioSkillRegistryV1` from already-adapted `RegisteredSkillV1` candidates
//     (native/builtin/owner), atomically: either every candidate is admitted and one frozen
//     registry is returned, or the first collision/shape violation rejects the WHOLE proposed
//     generation and the caller keeps its previous registry (Task 5 Step 3: "Any unexpected
//     cross-source collision rejects the proposed generation; the caller retains its previous
//     registry").
//
//   - `validateReleaseIdentityUniverseV1` — a cheaper, ID/alias-only collision check over
//     three raw index enumerations (native bundled index IDs+aliases, bundled-declarative
//     index IDs, and the owner active index IDs), used both by the CMake-driven build-time
//     gate (`verifySkillIdentityUniverse.mts`) and by real startup loading (a later task)
//     BEFORE a single package is even read off disk. It does not construct a registry or
//     accept `RegisteredSkillV1` values — it works over bare identity strings, so it can run
//     before any manifest/payload has been parsed.
//
// Neither function performs Task 3's hash-chain/compatibility validation, and neither reaches
// into the filesystem — this module is pure identity/collision logic over already-produced
// values. `nativeAdapter.ts`/`declarativeAdapter.ts` are the only producers of the
// `RegistryCandidateV1` values this module's registry-construction half consumes.

import { NATIVE_SKILL_IDS_V1 } from "./catalogs";
import type { RegisteredSkillOriginV1, RegisteredSkillV1, StudioSkillRegistryV1 } from "./contracts";

// ---------------------------------------------------------------------------------------
// validateRegistryCandidateV1 / buildStudioSkillRegistryV1
// ---------------------------------------------------------------------------------------

// DESIGN DECISION: `RegistryCandidateV1` is named in the plan's Cross-Slice APIs
// (`validateRegistryCandidateV1(candidate:RegistryCandidateV1, ...)`) but never given an
// exact shape. A registry candidate IS a `RegisteredSkillV1` — `nativeAdapter.ts` and
// `declarativeAdapter.ts` already produce exactly that shape (contracts.ts) — so this is an
// alias rather than a second parallel type a caller would need to convert between.
export type RegistryCandidateV1 = RegisteredSkillV1;

// DESIGN DECISION: `RegistryIdentitySetV1` is named but not shaped. Modeled as the flat set
// of already-claimed identities — every admitted candidate's `id` PLUS every one of its
// `aliases`, ASCII-lowercased — the exact vocabulary `get(idOrAlias)` resolves against, so
// "is this identity free" is a single `Set.has` lookup with no origin-specific branching.
export type RegistryIdentitySetV1 = ReadonlySet<string>;

export type RegistryCandidateFailureCodeV1 =
  | "invalid_owner_prefix"
  | "invalid_builtin_prefix"
  | "invalid_native_id"
  | "duplicate_identity";

export type RegistryCandidateValidationV1 =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: RegistryCandidateFailureCodeV1; readonly identity: string };

/** ASCII lowercase — matches `get(idOrAlias)`'s own resolution rule (Task 5 Step 3: "get
 *  lowercases ASCII"). Every ID/alias this slice accepts is already ASCII (Task 2's
 *  `[a-z0-9]+(?:-[a-z0-9]+)*` / `[a-z0-9_]+` grammars), so `String.prototype.toLowerCase`'s
 *  locale-independent ASCII behavior is exactly what is needed — no Unicode case-folding. */
function lower(value: string): string {
  return value.toLowerCase();
}

function candidateIdentities(candidate: RegistryCandidateV1): readonly string[] {
  return [candidate.id, ...candidate.aliases].map(lower);
}

/**
 * Validate ONE candidate's ID-shape-by-origin rule, then its identities (id + aliases)
 * against the already-occupied set. Does not mutate `occupied` — the caller decides when to
 * commit an admitted candidate's identities into it.
 */
export function validateRegistryCandidateV1(
  candidate: RegistryCandidateV1,
  occupied: RegistryIdentitySetV1,
): RegistryCandidateValidationV1 {
  if (candidate.origin === "owner" && !candidate.id.startsWith("owner-")) {
    return { ok: false, code: "invalid_owner_prefix", identity: candidate.id };
  }
  if (candidate.origin === "builtin" && !candidate.id.startsWith("builtin-")) {
    return { ok: false, code: "invalid_builtin_prefix", identity: candidate.id };
  }
  if (candidate.origin === "native" && !(NATIVE_SKILL_IDS_V1 as readonly string[]).includes(candidate.id)) {
    return { ok: false, code: "invalid_native_id", identity: candidate.id };
  }

  for (const identity of candidateIdentities(candidate)) {
    if (occupied.has(identity)) return { ok: false, code: "duplicate_identity", identity };
  }
  return { ok: true };
}

export type RegistryBuildInputV1 = {
  readonly generation: number;
  readonly native: readonly RegistryCandidateV1[];
  readonly builtin: readonly RegistryCandidateV1[];
  readonly owner: readonly RegistryCandidateV1[];
};

export type RegistryBuildResultV1 =
  | { readonly ok: true; readonly registry: StudioSkillRegistryV1 }
  | {
      readonly ok: false;
      readonly code: RegistryCandidateFailureCodeV1;
      readonly identity: string;
      readonly origin: RegisteredSkillOriginV1;
    };

/**
 * Build one atomic, immutable `StudioSkillRegistryV1` from native/builtin/owner candidates.
 * Native is admitted first, then builtin, then owner, so a builtin or owner candidate that
 * collides with a native canonical ID or its legacy alias is rejected exactly like a
 * same-origin duplicate — processing order only changes which side of a collision is
 * reported as "already occupied", never which candidates are considered occupants.
 *
 * On the FIRST collision or shape failure, the whole proposed generation is rejected — no
 * partial registry is ever returned (Task 5 Step 3: "the caller retains its previous
 * registry").
 */
export async function buildStudioSkillRegistryV1(input: RegistryBuildInputV1): Promise<RegistryBuildResultV1> {
  const occupied = new Set<string>();
  const byIdentity = new Map<string, RegisteredSkillV1>();
  const admitted: RegisteredSkillV1[] = [];

  const groups: readonly (readonly RegistryCandidateV1[])[] = [input.native, input.builtin, input.owner];

  for (const group of groups) {
    for (const candidate of group) {
      const validation = validateRegistryCandidateV1(candidate, occupied);
      if (!validation.ok) {
        return { ok: false, code: validation.code, identity: validation.identity, origin: candidate.origin };
      }
      for (const identity of candidateIdentities(candidate)) {
        occupied.add(identity);
        byIdentity.set(identity, candidate);
      }
      admitted.push(candidate);
    }
  }

  const frozenList = Object.freeze(admitted.slice());
  const registry: StudioSkillRegistryV1 = Object.freeze({
    generation: input.generation,
    get: (idOrAlias: string): RegisteredSkillV1 | null => byIdentity.get(lower(idOrAlias)) ?? null,
    list: (): readonly RegisteredSkillV1[] => frozenList,
  });
  return { ok: true, registry };
}

// ---------------------------------------------------------------------------------------
// validateReleaseIdentityUniverseV1 — pure ID/alias collision check across the three
// enumerations that make up one shipped release: native bundled index, bundled-declarative
// index, and the owner active index. No `RegisteredSkillV1`, no filesystem, no hashing —
// this is deliberately cheaper and earlier than registry construction (Task 5's own text:
// "Feed validateReleaseIdentityUniverseV1 a native bundled index (canonical IDs plus
// aliases), bundled-declarative index, and owner active.json; every cross-set ID/alias
// collision must fail").
// ---------------------------------------------------------------------------------------

// DESIGN DECISION: neither `ReleaseIdentityUniverseInputV1` nor its entry shape is given
// explicitly. Modeled as the minimal "what a bare index enumerates" shape: an ID plus its
// aliases for native (the only origin with legacy aliases in this slice — spec 8.1's
// `legacyAliases` field is native-payload-only), and a bare ID (no aliases) for
// declarative/owner, matching this task's own two bundled-index schemas
// (`verifySkillIdentityUniverse.mts`'s generated `{schemaVersion:1,skills:[...]}`) and the
// real `SkillActivationIndexV1` shape (contracts.ts, Task 1) an owner active index parses
// into, whose entries are keyed by ID with no alias concept.
export type ReleaseIdentityUniverseEntryV1 = { readonly id: string; readonly aliases?: readonly string[] };

export type ReleaseIdentityUniverseInputV1 = {
  readonly native: readonly ReleaseIdentityUniverseEntryV1[];
  readonly declarative: readonly ReleaseIdentityUniverseEntryV1[];
  readonly owner: readonly ReleaseIdentityUniverseEntryV1[];
};

export type ReleaseIdentityUniverseResultV1 =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "duplicate_identity"; readonly identity: string };

export function validateReleaseIdentityUniverseV1(input: ReleaseIdentityUniverseInputV1): ReleaseIdentityUniverseResultV1 {
  const occupied = new Set<string>();
  const groups: readonly (readonly ReleaseIdentityUniverseEntryV1[])[] = [input.native, input.declarative, input.owner];
  for (const group of groups) {
    for (const entry of group) {
      const identities = [entry.id, ...(entry.aliases ?? [])].map(lower);
      for (const identity of identities) {
        if (occupied.has(identity)) return { ok: false, code: "duplicate_identity", identity };
        occupied.add(identity);
      }
    }
  }
  return { ok: true };
}
