// Task 2 — the closed owner-local primitive/predicate catalogs and the native-skill ID
// universe (spec Section 8.4's "V1 owner-local allowlist" table).
//
// Everything here is DATA, not behavior: no primitive/predicate is ever executed from this
// module. `validate.ts` consults these catalogs to type-check a candidate manifest before
// any execution seam (Task 8) ever sees it; the closed key sets below are the exact
// vocabulary a v1 owner-local manifest may reference. Adding an entry requires a normal
// code review, a catalog-version bump, and recertification of dependent skills (spec 8.4) —
// nothing about this module makes that easier or automatic, on purpose.

import { canonicalJsonBytes, sha256Bytes } from "./hash";
import type { CatalogFingerprintV1, NativeSkillPayloadV1 } from "./contracts";

// ---------------------------------------------------------------------------------------
// Native skill ID universe
// ---------------------------------------------------------------------------------------

/** Pinned order per the plan's Task 2 Step 3 instruction ("Pin native IDs ..."). */
export const NATIVE_SKILL_IDS_V1: readonly NativeSkillPayloadV1["id"][] = [
  "session-control",
  "capture-review-choose-take",
  "explicit-balance",
  "load-named-plugin",
] as const;

/** The one legacy input/log alias (spec 8.1): `load_named_plugin` still resolves to the
 *  canonical hyphenated ID. The other three canonical IDs have no legacy aliases. */
export const NATIVE_SKILL_LEGACY_ALIASES_V1: Readonly<Record<string, NativeSkillPayloadV1["id"]>> = {
  load_named_plugin: "load-named-plugin",
};

// ---------------------------------------------------------------------------------------
// Owner-local primitive/predicate descriptors
//
// DESIGN DECISION: neither `OwnerPrimitiveCatalogV1` nor `OwnerPredicateCatalogV1` is given
// an exact shape anywhere in the plan or spec — only the exported CONST names and (via the
// RED test literals) the exact KEY SETS they must expose. Spec 8.4 does say each catalog
// entry "declares argument types, permitted ValueRefV1 sources, transaction class, and
// result schema, so the candidate is fully type-checked before execution" — the descriptor
// shape below is built directly from that sentence: `args` maps each argument name to its
// value type, the ValueRefV1 discriminant kinds it may be bound from (`allowedSources`), an
// optional numeric range, an optional fixed literal-string enum (spec 8.4: "literal strings
// are permitted only where a catalog entry declares a fixed enum"), and — for
// entity-ID-shaped arguments — the closed set of resolver names whose binding may supply it
// (spec 8.4: "Entity-ID arguments accept only a resolver binding or the selected-track
// context; pluginId accepts only the current plugin_by_name binding"). `transactionClass`
// is the coarse read/mutate split validate.ts uses to keep observations and resolvers out
// of a mutation manifest (spec 8.5: "Observation and resolver operations never appear in
// the engine mutation manifest").
// ---------------------------------------------------------------------------------------

/** The `ValueRefV1` discriminant kinds (contracts.ts) an argument may be bound from. */
export type OwnerValueSourceKindV1 = "literal" | "slot" | "context" | "binding" | "each";

export type OwnerArgSpecV1 = {
  readonly type: "string" | "number" | "boolean";
  readonly allowedSources: readonly OwnerValueSourceKindV1[];
  /** Fixed literal-string enum — the ONLY case a `literal` source is permitted for a
   *  string argument (spec 8.4). */
  readonly literalEnum?: readonly string[];
  /** Inclusive numeric bound, both finite. */
  readonly minimum?: number;
  readonly maximum?: number;
  /** For an entity-ID-shaped argument bound via `{binding}`, the closed set of resolver
   *  names whose bind name may supply it. */
  readonly boundResolvers?: readonly string[];
  /** For an entity-ID-shaped argument bound via `{context}`, the one permitted context key. */
  readonly allowedContext?: "selectedTrackId" | "projectEpoch";
};

export type OwnerPrimitiveDescriptorV1 = {
  readonly name: string;
  readonly args: Readonly<Record<string, OwnerArgSpecV1>>;
  readonly transactionClass: "read_only" | "mutation";
};

export type OwnerPrimitiveCatalogV1 = {
  readonly observations: Readonly<Record<string, OwnerPrimitiveDescriptorV1>>;
  readonly resolvers: Readonly<Record<string, OwnerPrimitiveDescriptorV1>>;
  readonly mutations: Readonly<Record<string, OwnerPrimitiveDescriptorV1>>;
};

export type OwnerPredicateDescriptorV1 = {
  readonly name: string;
  readonly args: Readonly<Record<string, OwnerArgSpecV1>>;
};

export type OwnerPredicateCatalogV1 = Readonly<Record<string, OwnerPredicateDescriptorV1>>;

const TRACK_ID_ARG: OwnerArgSpecV1 = {
  type: "string",
  allowedSources: ["binding", "context"],
  boundResolvers: ["selected_track", "track_by_unique_name"],
  allowedContext: "selectedTrackId",
};

const VOLUME_DB_ARG: OwnerArgSpecV1 = {
  type: "number",
  allowedSources: ["literal", "slot"],
  minimum: -60,
  maximum: 6,
};

const BOOLEAN_TOGGLE_ARG: OwnerArgSpecV1 = { type: "boolean", allowedSources: ["literal", "slot"] };

const PLUGIN_ID_ARG: OwnerArgSpecV1 = {
  type: "string",
  allowedSources: ["binding"],
  boundResolvers: ["plugin_by_name"],
};

export const OWNER_PRIMITIVES_V1: OwnerPrimitiveCatalogV1 = Object.freeze({
  observations: Object.freeze({
    current_snapshot: Object.freeze({ name: "current_snapshot", args: Object.freeze({}), transactionClass: "read_only" }),
    list_plugins: Object.freeze({ name: "list_plugins", args: Object.freeze({}), transactionClass: "read_only" }),
  }),
  resolvers: Object.freeze({
    selected_track: Object.freeze({ name: "selected_track", args: Object.freeze({}), transactionClass: "read_only" }),
    track_by_unique_name: Object.freeze({
      name: "track_by_unique_name",
      args: Object.freeze({ name: Object.freeze({ type: "string", allowedSources: ["slot"] } as OwnerArgSpecV1) }),
      transactionClass: "read_only",
    }),
    plugin_by_name: Object.freeze({
      name: "plugin_by_name",
      args: Object.freeze({ name: Object.freeze({ type: "string", allowedSources: ["slot"] } as OwnerArgSpecV1) }),
      transactionClass: "read_only",
    }),
  }),
  mutations: Object.freeze({
    set_track_volume: Object.freeze({
      name: "set_track_volume",
      args: Object.freeze({ trackId: TRACK_ID_ARG, db: VOLUME_DB_ARG }),
      transactionClass: "mutation",
    }),
    set_track_mute: Object.freeze({
      name: "set_track_mute",
      args: Object.freeze({ trackId: TRACK_ID_ARG, mute: BOOLEAN_TOGGLE_ARG }),
      transactionClass: "mutation",
    }),
    set_track_solo: Object.freeze({
      name: "set_track_solo",
      args: Object.freeze({ trackId: TRACK_ID_ARG, solo: BOOLEAN_TOGGLE_ARG }),
      transactionClass: "mutation",
    }),
    load_plugin: Object.freeze({
      name: "load_plugin",
      args: Object.freeze({ trackId: TRACK_ID_ARG, pluginId: PLUGIN_ID_ARG }),
      transactionClass: "mutation",
    }),
  }),
});

export const OWNER_PREDICATES_V1: OwnerPredicateCatalogV1 = Object.freeze({
  not_recording: Object.freeze({ name: "not_recording", args: Object.freeze({}) }),
  project_epoch_unchanged: Object.freeze({
    name: "project_epoch_unchanged",
    args: Object.freeze({
      epoch: Object.freeze({ type: "number", allowedSources: ["context"], allowedContext: "projectEpoch" } as OwnerArgSpecV1),
    }),
  }),
  selected_track_is: Object.freeze({ name: "selected_track_is", args: Object.freeze({ trackId: TRACK_ID_ARG }) }),
  track_exists: Object.freeze({ name: "track_exists", args: Object.freeze({ trackId: TRACK_ID_ARG }) }),
  track_volume_equals: Object.freeze({
    name: "track_volume_equals",
    args: Object.freeze({ trackId: TRACK_ID_ARG, db: VOLUME_DB_ARG }),
  }),
  track_mute_equals: Object.freeze({
    name: "track_mute_equals",
    args: Object.freeze({ trackId: TRACK_ID_ARG, mute: BOOLEAN_TOGGLE_ARG }),
  }),
  track_solo_equals: Object.freeze({
    name: "track_solo_equals",
    args: Object.freeze({ trackId: TRACK_ID_ARG, solo: BOOLEAN_TOGGLE_ARG }),
  }),
  plugin_instance_added_once: Object.freeze({
    name: "plugin_instance_added_once",
    args: Object.freeze({ trackId: TRACK_ID_ARG, pluginId: PLUGIN_ID_ARG }),
  }),
});

// ---------------------------------------------------------------------------------------
// Catalog fingerprint
// ---------------------------------------------------------------------------------------

/** Hand-bumped: bump only alongside a reviewed, additive-or-breaking change to the exact
 *  key set of `OWNER_PREDICATES_V1`. */
export const PREDICATE_CATALOG_VERSION_V1 = 1;

/** Hand-bumped: bump only alongside a reviewed, additive-or-breaking change to the exact
 *  key set of `OWNER_PRIMITIVES_V1.resolvers`. */
export const RESOLVER_CATALOG_VERSION_V1 = 1;

/**
 * `commandCatalogSha256` is `sha256Bytes(canonicalJsonBytes(...))` over the closed
 * `OWNER_PRIMITIVES_V1.observations` and `OWNER_PRIMITIVES_V1.mutations` descriptors,
 * merged into one object keyed by primitive name (`canonicalJsonBytes` recursively sorts
 * keys, so the merge order below does not matter — the digest is deterministic).
 * `predicateCatalogVersion`/`resolverCatalogVersion` are the hand-bumped constants above,
 * pinned to the OWNER_PREDICATES_V1 / OWNER_PRIMITIVES_V1.resolvers key sets respectively.
 */
export async function catalogFingerprintV1(): Promise<CatalogFingerprintV1> {
  const keyedByName: Record<string, OwnerPrimitiveDescriptorV1> = {
    ...OWNER_PRIMITIVES_V1.observations,
    ...OWNER_PRIMITIVES_V1.mutations,
  };
  const commandCatalogSha256 = await sha256Bytes(canonicalJsonBytes(keyedByName));
  return {
    schemaVersion: 1,
    commandCatalogSha256,
    predicateCatalogVersion: PREDICATE_CATALOG_VERSION_V1,
    resolverCatalogVersion: RESOLVER_CATALOG_VERSION_V1,
  };
}
