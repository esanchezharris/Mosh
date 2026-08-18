// Task 2 — non-throwing structural/grammar validation for owner-local declarative skill
// manifests (spec Section 8.1-8.4) and the three native artifact schemas (payload,
// bundle entry, external release verification).
//
// SCOPE: this module validates the SHAPE and GRAMMAR of an already-parsed JS value against
// the closed v1 owner-local catalog (catalogs.ts) — unknown fields, ID/SemVer formats,
// every Section 8.1 collection/string cap that is meaningful on one already-decoded
// manifest, closed primitive/predicate/resolver references, typed-value-reference source
// rules, and the "every referenced slot is required-or-defaulted" rule. It does NOT: read
// or hash raw bytes (Task 3's packageValidation.ts owns exact-byte caps like
// `manifestBytes`, enforced BEFORE JSON.parse), cross-validate a hash chain (also Task 3),
// or expand `each`/`forEach` against live state (Task 8's declarativeExecutor — the
// `expandedPreflightCalls`/`expandedMutationCommands` caps are therefore also Task 8's to
// enforce, since they only have meaning post-expansion). Nothing here throws: every
// rejection is an accumulated `ParseIssueV1`.

import {
  NATIVE_SKILL_IDS_V1,
  OWNER_PREDICATES_V1,
  OWNER_PRIMITIVES_V1,
  type OwnerArgSpecV1,
} from "./catalogs";
import { FOUNDRY_LIMITS_V1 } from "./limits";
import type {
  NativeReleaseVerificationV1,
  NativeSkillBundleEntryV1,
  NativeSkillPayloadV1,
  ParseIssueV1,
  ParseResult,
  SkillManifestV1,
  SkillSlotV1,
} from "./contracts";

// ---------------------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unicodeLength(text: string): number {
  return [...text].length;
}

function fail(issues: ParseIssueV1[], code: string, path: string, message: string): void {
  issues.push({ code, path, message });
}

function checkKnownKeys(issues: ParseIssueV1[], path: string, obj: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) fail(issues, "unknown_field", path ? `${path}.${key}` : key, `unexpected field: ${key}`);
  }
}

/** Skill/native ID slugs: `[a-z0-9]+(?:-[a-z0-9]+)*`, at most 64 ASCII characters. */
const SKILL_ID_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Slot/bind/tag/source/claim IDs (plan Task 2 Step 4). */
const IDENTIFIER_REGEX = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** SemVer core + optional prerelease, deliberately excluding build metadata (no `+...`). */
const SEMVER_NO_BUILD_REGEX = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const HEX64_REGEX = /^[0-9a-f]{64}$/;

function checkSkillId(issues: ParseIssueV1[], path: string, value: unknown): void {
  if (typeof value !== "string") {
    fail(issues, "invalid_type", path, "id must be a string");
    return;
  }
  if (value.length > FOUNDRY_LIMITS_V1.skillIdChars || !SKILL_ID_REGEX.test(value)) {
    fail(issues, "invalid_id", path, `id must match ${SKILL_ID_REGEX} and be at most ${FOUNDRY_LIMITS_V1.skillIdChars} characters`);
  }
}

function checkVersion(issues: ParseIssueV1[], path: string, value: unknown): void {
  if (typeof value !== "string" || !SEMVER_NO_BUILD_REGEX.test(value)) {
    fail(issues, "invalid_version", path, "version must be SemVer without build metadata");
  }
}

function checkIdentifier(issues: ParseIssueV1[], path: string, value: unknown, label: string): void {
  if (typeof value !== "string" || !IDENTIFIER_REGEX.test(value)) {
    fail(issues, "invalid_id", path, `${label} must match ${IDENTIFIER_REGEX}`);
  }
}

function checkStringCap(issues: ParseIssueV1[], path: string, value: unknown, maxChars: number, label: string): value is string {
  if (typeof value !== "string") {
    fail(issues, "invalid_type", path, `${label} must be a string`);
    return false;
  }
  if (unicodeLength(value) > maxChars) {
    fail(issues, "too_long", path, `${label} exceeds ${maxChars} Unicode scalar values`);
    return false;
  }
  return true;
}

function checkArrayCap(issues: ParseIssueV1[], path: string, value: unknown, maxItems: number, label: string): value is unknown[] {
  if (!Array.isArray(value)) {
    fail(issues, "invalid_type", path, `${label} must be an array`);
    return false;
  }
  if (value.length > maxItems) {
    fail(issues, "too_many", path, `${label} exceeds ${maxItems} entries`);
    return false;
  }
  return true;
}

function checkFiniteNumber(issues: ParseIssueV1[], path: string, value: unknown, label: string): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(issues, "non_finite_bounds", path, `${label} must be a finite number`);
    return false;
  }
  return true;
}

/**
 * `minimum`/`maximum` (and `minItems`/`maxItems`) are OPTIONAL on `SkillSlotV1` — only
 * validate a bound that is actually present, but when both are present, both must be
 * finite AND ordered (spec 8.2: "minimum and maximum must be finite and ordered").
 */
function checkFiniteOrderedBounds(
  issues: ParseIssueV1[],
  path: string,
  minimum: unknown,
  maximum: unknown,
  minLabel: string,
  maxLabel: string,
): void {
  const hasMin = minimum !== undefined;
  const hasMax = maximum !== undefined;
  const minOk = !hasMin || checkFiniteNumber(issues, `${path}.${minLabel}`, minimum, minLabel);
  const maxOk = !hasMax || checkFiniteNumber(issues, `${path}.${maxLabel}`, maximum, maxLabel);
  if (hasMin && hasMax && minOk && maxOk && (minimum as number) > (maximum as number)) {
    fail(issues, "invalid_bounds_order", path, `${minLabel} must not exceed ${maxLabel}`);
  }
}

function checkIntegerRange(issues: ParseIssueV1[], path: string, value: unknown, min: number, max: number, label: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(issues, "out_of_range", path, `${label} must be an integer from ${min} through ${max}`);
  }
}

function checkHex64(issues: ParseIssueV1[], path: string, value: unknown, label: string): void {
  if (typeof value !== "string" || !HEX64_REGEX.test(value)) {
    fail(issues, "invalid_hash", path, `${label} must be a lowercase 64-character hex SHA-256`);
  }
}

function checkNonEmptyString(issues: ParseIssueV1[], path: string, value: unknown, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    fail(issues, "invalid_type", path, `${label} must be a non-empty string`);
  }
}

// ---------------------------------------------------------------------------------------
// Value references
// ---------------------------------------------------------------------------------------

type BindOriginV1 =
  | { readonly kind: "observe"; readonly command: string }
  | { readonly kind: "resolve"; readonly resolver: string };

type ManifestValidationCtxV1 = {
  readonly issues: ParseIssueV1[];
  readonly slotsByName: ReadonlyMap<string, SkillSlotV1>;
  readonly bindsByName: ReadonlyMap<string, BindOriginV1>;
};

function slotTypeMatchesArg(slotType: SkillSlotV1["type"], argType: OwnerArgSpecV1["type"]): boolean {
  if (argType === "string") return slotType === "string" || slotType === "enum";
  if (argType === "number") return slotType === "number";
  if (argType === "boolean") return slotType === "boolean";
  return false;
}

/**
 * Validate one `ValueRefV1` against the argument spec that will consume it.
 *
 * DESIGN DECISION: the `each` discriminant is accepted structurally (a manifest using it
 * never gets a bogus "unknown discriminant" error) but is not deep-validated against a
 * target slot's type here. Spec 8.3 says `each` is permitted only for bounded list slots,
 * but NONE of the four V1 owner-local mutations (catalogs.ts) declare `"each"` in any
 * argument's `allowedSources` — none takes a natural per-item target, since none of the
 * three V1 resolvers is list-producing. So the "target must be a `string[]` slot" rule has
 * no reachable path through today's closed catalog to exercise honestly; it is deferred to
 * whichever future task adds a primitive whose argument spec actually permits `each`. The
 * `allowedSources` gate below still rejects `each` everywhere it is not explicitly
 * permitted, which is every argument in the current catalog.
 */
function checkValueRef(ctx: ManifestValidationCtxV1, path: string, ref: unknown, spec: OwnerArgSpecV1): void {
  if (!isRecord(ref)) {
    fail(ctx.issues, "invalid_type", path, "argument value must be a typed reference object");
    return;
  }
  const discriminantKeys = Object.keys(ref).filter((k) => k === "literal" || k === "slot" || k === "context" || k === "binding" || k === "each");
  if (discriminantKeys.length !== 1) {
    fail(ctx.issues, "invalid_type", path, "a value reference must have exactly one discriminant key");
    return;
  }
  const kind = discriminantKeys[0] as "literal" | "slot" | "context" | "binding" | "each";

  if (!spec.allowedSources.includes(kind)) {
    fail(ctx.issues, "disallowed_source", path, `"${kind}" is not a permitted source for this argument`);
    return;
  }

  if (kind === "literal") {
    const value = (ref as { literal: unknown }).literal;
    if (spec.type === "string") {
      if (typeof value !== "string") {
        fail(ctx.issues, "type_mismatch", path, "literal must be a string");
        return;
      }
      if (!spec.literalEnum || !spec.literalEnum.includes(value)) {
        fail(ctx.issues, "unsafe_literal", path, "literal strings are only permitted where a fixed enum is declared");
      }
    } else if (spec.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        fail(ctx.issues, "type_mismatch", path, "literal must be a finite number");
        return;
      }
      if ((spec.minimum !== undefined && value < spec.minimum) || (spec.maximum !== undefined && value > spec.maximum)) {
        fail(ctx.issues, "out_of_range", path, `literal ${value} is outside [${spec.minimum ?? "-inf"},${spec.maximum ?? "+inf"}]`);
      }
    } else if (spec.type === "boolean" && typeof value !== "boolean") {
      fail(ctx.issues, "type_mismatch", path, "literal must be a boolean");
    }
    return;
  }

  if (kind === "slot") {
    const name = (ref as { slot: unknown }).slot;
    if (typeof name !== "string") {
      fail(ctx.issues, "invalid_type", path, "slot reference must name a string slot");
      return;
    }
    const slot = ctx.slotsByName.get(name);
    if (!slot) {
      fail(ctx.issues, "unknown_slot", path, `no slot named "${name}"`);
      return;
    }
    if (!slot.required && slot.default === undefined) {
      fail(ctx.issues, "optional_referenced_slot", path, `slot "${name}" is referenced but is neither required nor defaulted`);
    }
    if (!slotTypeMatchesArg(slot.type, spec.type)) {
      fail(ctx.issues, "type_mismatch", path, `slot "${name}" (${slot.type}) does not satisfy argument type ${spec.type}`);
    }
    return;
  }

  if (kind === "context") {
    const value = (ref as { context: unknown }).context;
    if (value !== "selectedTrackId" && value !== "projectEpoch") {
      fail(ctx.issues, "invalid_context", path, "unknown context key");
      return;
    }
    if (spec.allowedContext !== value) {
      fail(ctx.issues, "invalid_context", path, `context "${value}" is not permitted for this argument`);
    }
    return;
  }

  if (kind === "binding") {
    const name = (ref as { binding: unknown }).binding;
    if (typeof name !== "string") {
      fail(ctx.issues, "invalid_type", path, "binding reference must name a string bind");
      return;
    }
    const origin = ctx.bindsByName.get(name);
    if (!origin) {
      fail(ctx.issues, "unknown_binding", path, `no bind named "${name}"`);
      return;
    }
    if (spec.boundResolvers && (origin.kind !== "resolve" || !spec.boundResolvers.includes(origin.resolver))) {
      fail(ctx.issues, "invalid_binding_origin", path, `binding "${name}" is not produced by one of: ${spec.boundResolvers.join(", ")}`);
    }
    return;
  }

  // kind === "each" — see the DESIGN DECISION note above this function.
  const eachName = (ref as { each: unknown }).each;
  if (typeof eachName !== "string" || eachName.length === 0) {
    fail(ctx.issues, "invalid_type", path, "each must name a non-empty string");
  }
  const field = (ref as { field?: unknown }).field;
  if (field !== undefined && typeof field !== "string") {
    fail(ctx.issues, "invalid_type", `${path}.field`, "field must be a string");
  }
}

// ---------------------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------------------

const SLOT_KEYS = ["name", "type", "required", "source", "default", "enumValues", "minimum", "maximum", "minItems", "maxItems", "description"] as const;
const SLOT_TYPES = new Set(["string", "number", "boolean", "enum", "string[]"]);
const SLOT_SOURCES = new Set(["utterance", "context", "observation"]);

function checkSlotDefault(issues: ParseIssueV1[], path: string, slot: Record<string, unknown>): void {
  if (!("default" in slot) || slot.default === undefined) return;
  const type = slot.type;
  const value = slot.default;
  if (type === "string") {
    if (typeof value !== "string" || unicodeLength(value) > FOUNDRY_LIMITS_V1.stringSlotChars) {
      fail(issues, "invalid_default", `${path}.default`, "string default must respect the string-slot character cap");
    }
  } else if (type === "number") {
    if (!checkFiniteNumber(issues, `${path}.default`, value, "default")) return;
    const min = slot.minimum;
    const max = slot.maximum;
    if (typeof min === "number" && (value as number) < min) fail(issues, "invalid_default", `${path}.default`, "default is below minimum");
    if (typeof max === "number" && (value as number) > max) fail(issues, "invalid_default", `${path}.default`, "default is above maximum");
  } else if (type === "boolean") {
    if (typeof value !== "boolean") fail(issues, "invalid_default", `${path}.default`, "boolean default must be a boolean");
  } else if (type === "enum") {
    const enumValues = Array.isArray(slot.enumValues) ? (slot.enumValues as unknown[]) : [];
    if (typeof value !== "string" || !enumValues.includes(value)) {
      fail(issues, "invalid_default", `${path}.default`, "enum default must be one of enumValues");
    }
  } else if (type === "string[]") {
    if (!Array.isArray(value) || value.length > FOUNDRY_LIMITS_V1.listSlotItems || !value.every((item) => typeof item === "string" && unicodeLength(item) <= FOUNDRY_LIMITS_V1.stringSlotChars)) {
      fail(issues, "invalid_default", `${path}.default`, "list default must respect the list-slot item cap and per-item character cap");
    }
  }
}

function checkSlot(issues: ParseIssueV1[], path: string, raw: unknown): SkillSlotV1 | null {
  if (!isRecord(raw)) {
    fail(issues, "invalid_type", path, "slot must be an object");
    return null;
  }
  checkKnownKeys(issues, path, raw, SLOT_KEYS);
  checkIdentifier(issues, `${path}.name`, raw.name, "slot name");
  if (typeof raw.type !== "string" || !SLOT_TYPES.has(raw.type)) {
    fail(issues, "invalid_enum", `${path}.type`, "slot type must be one of string|number|boolean|enum|string[]");
  }
  if (typeof raw.required !== "boolean") fail(issues, "invalid_type", `${path}.required`, "required must be a boolean");
  if (typeof raw.source !== "string" || !SLOT_SOURCES.has(raw.source)) {
    fail(issues, "invalid_enum", `${path}.source`, "source must be one of utterance|context|observation");
  }
  checkStringCap(issues, `${path}.description`, raw.description, FOUNDRY_LIMITS_V1.descriptionChars, "slot description");

  if (raw.type === "enum") {
    if (!checkArrayCap(issues, `${path}.enumValues`, raw.enumValues, FOUNDRY_LIMITS_V1.enumValues, "enumValues")) {
      // already reported
    } else if (!(raw.enumValues as unknown[]).every((v) => typeof v === "string")) {
      fail(issues, "invalid_type", `${path}.enumValues`, "enumValues must all be strings");
    }
  } else if ("enumValues" in raw && raw.enumValues !== undefined) {
    fail(issues, "unknown_field", `${path}.enumValues`, "enumValues only applies to type=enum");
  }

  checkFiniteOrderedBounds(issues, path, raw.minimum, raw.maximum, "minimum", "maximum");
  checkFiniteOrderedBounds(issues, path, raw.minItems, raw.maxItems, "minItems", "maxItems");

  checkSlotDefault(issues, path, raw);

  return raw as unknown as SkillSlotV1;
}

// ---------------------------------------------------------------------------------------
// Steps and predicates
// ---------------------------------------------------------------------------------------

function checkArgsRecord(
  ctx: ManifestValidationCtxV1,
  path: string,
  raw: unknown,
  argSpecs: Readonly<Record<string, OwnerArgSpecV1>>,
): void {
  if (!isRecord(raw)) {
    fail(ctx.issues, "invalid_type", path, "args must be an object");
    return;
  }
  for (const key of Object.keys(raw)) {
    if (!(key in argSpecs)) fail(ctx.issues, "unknown_argument", `${path}.${key}`, `unknown argument: ${key}`);
  }
  for (const [name, spec] of Object.entries(argSpecs)) {
    if (!(name in raw)) {
      fail(ctx.issues, "missing_argument", `${path}.${name}`, `missing required argument: ${name}`);
      continue;
    }
    checkValueRef(ctx, `${path}.${name}`, raw[name], spec);
  }
}

function checkPredicate(ctx: ManifestValidationCtxV1, path: string, raw: unknown): void {
  if (!isRecord(raw)) {
    fail(ctx.issues, "invalid_type", path, "predicate must be an object");
    return;
  }
  checkKnownKeys(ctx.issues, path, raw, ["name", "args"]);
  const name = raw.name;
  if (typeof name !== "string" || !(name in OWNER_PREDICATES_V1)) {
    fail(ctx.issues, "unknown_predicate", `${path}.name`, `predicate "${String(name)}" is not in the closed catalog`);
    return;
  }
  checkArgsRecord(ctx, `${path}.args`, raw.args, OWNER_PREDICATES_V1[name].args);
}

const OBSERVE_KEYS = ["kind", "command", "args", "bind"] as const;
const RESOLVE_KEYS = ["kind", "resolver", "input", "bind", "maxChoices"] as const;
const MUTATE_KEYS = ["kind", "command", "args", "forEach"] as const;

function collectBindOrigins(issues: ParseIssueV1[], steps: readonly unknown[]): Map<string, BindOriginV1> {
  const binds = new Map<string, BindOriginV1>();
  for (const raw of steps) {
    if (!isRecord(raw)) continue;
    if (raw.kind === "observe" && typeof raw.bind === "string") {
      if (binds.has(raw.bind)) fail(issues, "duplicate_binding", "steps", `duplicate bind name: ${raw.bind}`);
      else binds.set(raw.bind, { kind: "observe", command: typeof raw.command === "string" ? raw.command : "" });
    } else if (raw.kind === "resolve" && typeof raw.bind === "string") {
      if (binds.has(raw.bind)) fail(issues, "duplicate_binding", "steps", `duplicate bind name: ${raw.bind}`);
      else binds.set(raw.bind, { kind: "resolve", resolver: typeof raw.resolver === "string" ? raw.resolver : "" });
    }
  }
  return binds;
}

function checkStep(ctx: ManifestValidationCtxV1, path: string, raw: unknown): void {
  if (!isRecord(raw)) {
    fail(ctx.issues, "invalid_type", path, "step must be an object");
    return;
  }
  if (raw.kind === "observe") {
    checkKnownKeys(ctx.issues, path, raw, OBSERVE_KEYS);
    checkIdentifier(ctx.issues, `${path}.bind`, raw.bind, "bind name");
    const command = raw.command;
    if (typeof command !== "string" || !(command in OWNER_PRIMITIVES_V1.observations)) {
      fail(ctx.issues, "unknown_primitive", `${path}.command`, `observation "${String(command)}" is not in the closed catalog`);
      return;
    }
    checkArgsRecord(ctx, `${path}.args`, raw.args, OWNER_PRIMITIVES_V1.observations[command].args);
    return;
  }
  if (raw.kind === "resolve") {
    checkKnownKeys(ctx.issues, path, raw, RESOLVE_KEYS);
    checkIdentifier(ctx.issues, `${path}.bind`, raw.bind, "bind name");
    checkIntegerRange(ctx.issues, `${path}.maxChoices`, raw.maxChoices, 1, FOUNDRY_LIMITS_V1.maxChoices, "maxChoices");
    const resolver = raw.resolver;
    if (typeof resolver !== "string" || !(resolver in OWNER_PRIMITIVES_V1.resolvers)) {
      fail(ctx.issues, "unknown_primitive", `${path}.resolver`, `resolver "${String(resolver)}" is not in the closed catalog`);
      return;
    }
    const descriptor = OWNER_PRIMITIVES_V1.resolvers[resolver];
    const argNames = Object.keys(descriptor.args);
    const hasInput = "input" in raw && raw.input !== undefined;
    if (argNames.length === 0) {
      if (hasInput) fail(ctx.issues, "unexpected_input", `${path}.input`, `resolver "${resolver}" takes no input`);
    } else {
      if (!hasInput) {
        fail(ctx.issues, "missing_argument", `${path}.input`, `resolver "${resolver}" requires input`);
      } else {
        checkValueRef(ctx, `${path}.input`, raw.input, descriptor.args[argNames[0]]);
      }
    }
    return;
  }
  if (raw.kind === "mutate") {
    checkKnownKeys(ctx.issues, path, raw, MUTATE_KEYS);
    if ("forEach" in raw && raw.forEach !== undefined) {
      checkIdentifier(ctx.issues, `${path}.forEach`, raw.forEach, "forEach reference");
    }
    const command = raw.command;
    if (typeof command !== "string" || !(command in OWNER_PRIMITIVES_V1.mutations)) {
      fail(ctx.issues, "unknown_primitive", `${path}.command`, `mutation "${String(command)}" is not in the closed catalog`);
      return;
    }
    checkArgsRecord(ctx, `${path}.args`, raw.args, OWNER_PRIMITIVES_V1.mutations[command].args);
    return;
  }
  fail(ctx.issues, "invalid_enum", `${path}.kind`, "step kind must be observe|resolve|mutate");
}

// ---------------------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------------------

function checkSourceRef(issues: ParseIssueV1[], path: string, raw: unknown): void {
  if (!isRecord(raw)) {
    fail(issues, "invalid_type", path, "provenance entry must be an object");
    return;
  }
  checkKnownKeys(issues, path, raw, ["sourceCardId", "claimIds", "sourceSnapshotSha256"]);
  checkIdentifier(issues, `${path}.sourceCardId`, raw.sourceCardId, "sourceCardId");
  if (checkArrayCap(issues, `${path}.claimIds`, raw.claimIds, FOUNDRY_LIMITS_V1.claimIdsPerReference, "claimIds")) {
    (raw.claimIds as unknown[]).forEach((claimId, i) => checkIdentifier(issues, `${path}.claimIds[${i}]`, claimId, "claimId"));
  }
  checkHex64(issues, `${path}.sourceSnapshotSha256`, raw.sourceSnapshotSha256, "sourceSnapshotSha256");
}

// ---------------------------------------------------------------------------------------
// parseSkillManifestV1
// ---------------------------------------------------------------------------------------

const MANIFEST_TOP_KEYS = [
  "schemaVersion", "id", "version", "title", "description", "implementation", "intents",
  "slots", "preconditions", "steps", "postconditions", "execution", "responses",
  "provenance", "compatibility",
] as const;

const INTENTS_KEYS = ["positiveExamples", "negativeExamples", "tags"] as const;
const EXECUTION_KEYS = ["mode", "confirmation", "maxMutations", "timeoutMs"] as const;
const RESPONSES_KEYS = ["completed", "needsChoice", "blocked"] as const;
const COMPATIBILITY_KEYS = ["minMoshVersion", "commandCatalogSha256", "predicateCatalogVersion", "resolverCatalogVersion"] as const;

function checkExamples(issues: ParseIssueV1[], path: string, raw: unknown, maxCount: number): void {
  if (!checkArrayCap(issues, path, raw, maxCount, path)) return;
  (raw as unknown[]).forEach((example, i) => checkStringCap(issues, `${path}[${i}]`, example, FOUNDRY_LIMITS_V1.exampleChars, "example"));
}

export function parseSkillManifestV1(raw: unknown): ParseResult<SkillManifestV1> {
  const issues: ParseIssueV1[] = [];

  if (!isRecord(raw)) {
    fail(issues, "invalid_type", "", "manifest must be a JSON object");
    return { ok: false, issues };
  }

  checkKnownKeys(issues, "", raw, MANIFEST_TOP_KEYS);

  if (raw.schemaVersion !== 1) fail(issues, "invalid_schema_version", "schemaVersion", "schemaVersion must be 1");
  checkSkillId(issues, "id", raw.id);
  checkVersion(issues, "version", raw.version);
  checkStringCap(issues, "title", raw.title, FOUNDRY_LIMITS_V1.titleChars, "title");
  checkStringCap(issues, "description", raw.description, FOUNDRY_LIMITS_V1.descriptionChars, "description");
  if (raw.implementation !== "declarative") fail(issues, "invalid_enum", "implementation", 'implementation must be "declarative"');

  if (!isRecord(raw.intents)) {
    fail(issues, "invalid_type", "intents", "intents must be an object");
  } else {
    checkKnownKeys(issues, "intents", raw.intents, INTENTS_KEYS);
    checkExamples(issues, "intents.positiveExamples", raw.intents.positiveExamples, FOUNDRY_LIMITS_V1.positiveExamples);
    checkExamples(issues, "intents.negativeExamples", raw.intents.negativeExamples, FOUNDRY_LIMITS_V1.negativeExamples);
    if (checkArrayCap(issues, "intents.tags", raw.intents.tags, FOUNDRY_LIMITS_V1.tags, "tags")) {
      (raw.intents.tags as unknown[]).forEach((tag, i) => checkIdentifier(issues, `intents.tags[${i}]`, tag, "tag"));
    }
  }

  const slots: SkillSlotV1[] = [];
  const slotNamesSeen = new Set<string>();
  if (checkArrayCap(issues, "slots", raw.slots, FOUNDRY_LIMITS_V1.slots, "slots")) {
    (raw.slots as unknown[]).forEach((rawSlot, i) => {
      const slot = checkSlot(issues, `slots[${i}]`, rawSlot);
      if (slot) {
        if (typeof slot.name === "string") {
          if (slotNamesSeen.has(slot.name)) fail(issues, "duplicate_slot", `slots[${i}].name`, `duplicate slot name: ${slot.name}`);
          else slotNamesSeen.add(slot.name);
        }
        slots.push(slot);
      }
    });
  }
  const slotsByName = new Map(slots.filter((s) => typeof s.name === "string").map((s) => [s.name, s] as const));

  const stepsRaw = Array.isArray(raw.steps) ? raw.steps : [];
  checkArrayCap(issues, "steps", raw.steps, FOUNDRY_LIMITS_V1.declaredStepNodes, "steps");
  const bindsByName = collectBindOrigins(issues, stepsRaw);
  const ctx: ManifestValidationCtxV1 = { issues, slotsByName, bindsByName };

  stepsRaw.forEach((step, i) => checkStep(ctx, `steps[${i}]`, step));

  if (checkArrayCap(issues, "preconditions", raw.preconditions, FOUNDRY_LIMITS_V1.preconditions, "preconditions")) {
    (raw.preconditions as unknown[]).forEach((p, i) => checkPredicate(ctx, `preconditions[${i}]`, p));
  }
  if (checkArrayCap(issues, "postconditions", raw.postconditions, FOUNDRY_LIMITS_V1.postconditions, "postconditions")) {
    (raw.postconditions as unknown[]).forEach((p, i) => checkPredicate(ctx, `postconditions[${i}]`, p));
  }

  if (!isRecord(raw.execution)) {
    fail(issues, "invalid_type", "execution", "execution must be an object");
  } else {
    checkKnownKeys(issues, "execution", raw.execution, EXECUTION_KEYS);
    if (raw.execution.mode !== "atomic") {
      fail(issues, "non_atomic_mode", "execution.mode", 'owner-local v1 manifests must use execution.mode "atomic"');
    }
    if (!["never", "on_ambiguity", "always"].includes(raw.execution.confirmation as string)) {
      fail(issues, "invalid_enum", "execution.confirmation", "confirmation must be never|on_ambiguity|always");
    }
    checkIntegerRange(issues, "execution.maxMutations", raw.execution.maxMutations, FOUNDRY_LIMITS_V1.maxMutationsMin, FOUNDRY_LIMITS_V1.maxMutationsMax, "maxMutations");
    checkIntegerRange(issues, "execution.timeoutMs", raw.execution.timeoutMs, FOUNDRY_LIMITS_V1.timeoutMsMin, FOUNDRY_LIMITS_V1.timeoutMsMax, "timeoutMs");
  }

  if (!isRecord(raw.responses)) {
    fail(issues, "invalid_type", "responses", "responses must be an object");
  } else {
    checkKnownKeys(issues, "responses", raw.responses, RESPONSES_KEYS);
    checkStringCap(issues, "responses.completed", raw.responses.completed, FOUNDRY_LIMITS_V1.descriptionChars, "responses.completed");
    checkStringCap(issues, "responses.needsChoice", raw.responses.needsChoice, FOUNDRY_LIMITS_V1.descriptionChars, "responses.needsChoice");
    checkStringCap(issues, "responses.blocked", raw.responses.blocked, FOUNDRY_LIMITS_V1.descriptionChars, "responses.blocked");
  }

  if (checkArrayCap(issues, "provenance", raw.provenance, FOUNDRY_LIMITS_V1.provenanceReferences, "provenance")) {
    (raw.provenance as unknown[]).forEach((p, i) => checkSourceRef(issues, `provenance[${i}]`, p));
  }

  if (!isRecord(raw.compatibility)) {
    fail(issues, "invalid_type", "compatibility", "compatibility must be an object");
  } else {
    checkKnownKeys(issues, "compatibility", raw.compatibility, COMPATIBILITY_KEYS);
    checkNonEmptyString(issues, "compatibility.minMoshVersion", raw.compatibility.minMoshVersion, "minMoshVersion");
    checkHex64(issues, "compatibility.commandCatalogSha256", raw.compatibility.commandCatalogSha256, "commandCatalogSha256");
    if (typeof raw.compatibility.predicateCatalogVersion !== "number" || !Number.isInteger(raw.compatibility.predicateCatalogVersion)) {
      fail(issues, "invalid_type", "compatibility.predicateCatalogVersion", "predicateCatalogVersion must be an integer");
    }
    if (typeof raw.compatibility.resolverCatalogVersion !== "number" || !Number.isInteger(raw.compatibility.resolverCatalogVersion)) {
      fail(issues, "invalid_type", "compatibility.resolverCatalogVersion", "resolverCatalogVersion must be an integer");
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: raw as unknown as SkillManifestV1 };
}

// ---------------------------------------------------------------------------------------
// Native artifact parsers
// ---------------------------------------------------------------------------------------

const NATIVE_ID_TO_HANDLER_KEY: Readonly<Record<NativeSkillPayloadV1["id"], NativeSkillPayloadV1["handlerKey"]>> = {
  "session-control": "sessionControlV1",
  "capture-review-choose-take": "takeCycleV1",
  "explicit-balance": "explicitBalanceV1",
  "load-named-plugin": "loadNamedPluginV1",
};

const NATIVE_PAYLOAD_KEYS = [
  "schemaVersion", "id", "version", "implementation", "handlerKey", "title", "description",
  "intents", "slots", "execution", "responses", "provenance", "legacyAliases", "compatibility",
] as const;

export function parseNativeSkillPayloadV1(raw: unknown): ParseResult<NativeSkillPayloadV1> {
  const issues: ParseIssueV1[] = [];
  if (!isRecord(raw)) {
    fail(issues, "invalid_type", "", "native payload must be a JSON object");
    return { ok: false, issues };
  }
  checkKnownKeys(issues, "", raw, NATIVE_PAYLOAD_KEYS);

  if (raw.schemaVersion !== 1) fail(issues, "invalid_schema_version", "schemaVersion", "schemaVersion must be 1");
  const id = raw.id;
  if (typeof id !== "string" || !(NATIVE_SKILL_IDS_V1 as readonly string[]).includes(id)) {
    fail(issues, "unknown_native_id", "id", `id must be one of: ${NATIVE_SKILL_IDS_V1.join(", ")}`);
  }
  checkVersion(issues, "version", raw.version);
  if (raw.implementation !== "native") fail(issues, "invalid_enum", "implementation", 'implementation must be "native"');
  const handlerKey = raw.handlerKey;
  const validHandlerKeys = new Set(Object.values(NATIVE_ID_TO_HANDLER_KEY));
  if (typeof handlerKey !== "string" || !validHandlerKeys.has(handlerKey as NativeSkillPayloadV1["handlerKey"])) {
    fail(issues, "invalid_enum", "handlerKey", "handlerKey must be one of the four closed handler keys");
  } else if (typeof id === "string" && (NATIVE_SKILL_IDS_V1 as readonly string[]).includes(id) && NATIVE_ID_TO_HANDLER_KEY[id as NativeSkillPayloadV1["id"]] !== handlerKey) {
    fail(issues, "handler_id_mismatch", "handlerKey", `handlerKey does not match the pinned handler for id "${id}"`);
  }
  checkStringCap(issues, "title", raw.title, FOUNDRY_LIMITS_V1.titleChars, "title");
  checkStringCap(issues, "description", raw.description, FOUNDRY_LIMITS_V1.descriptionChars, "description");

  if (!isRecord(raw.intents)) {
    fail(issues, "invalid_type", "intents", "intents must be an object");
  } else {
    checkKnownKeys(issues, "intents", raw.intents, INTENTS_KEYS);
    checkExamples(issues, "intents.positiveExamples", raw.intents.positiveExamples, FOUNDRY_LIMITS_V1.positiveExamples);
    checkExamples(issues, "intents.negativeExamples", raw.intents.negativeExamples, FOUNDRY_LIMITS_V1.negativeExamples);
    checkArrayCap(issues, "intents.tags", raw.intents.tags, FOUNDRY_LIMITS_V1.tags, "tags");
  }

  if (checkArrayCap(issues, "slots", raw.slots, FOUNDRY_LIMITS_V1.slots, "slots")) {
    (raw.slots as unknown[]).forEach((s, i) => checkSlot(issues, `slots[${i}]`, s));
  }

  if (!isRecord(raw.execution)) {
    fail(issues, "invalid_type", "execution", "execution must be an object");
  } else {
    checkKnownKeys(issues, "execution", raw.execution, ["mode", "confirmation"]);
    if (!["atomic", "lifecycle", "best_effort"].includes(raw.execution.mode as string)) {
      fail(issues, "invalid_enum", "execution.mode", "mode must be atomic|lifecycle|best_effort");
    }
    if (!["never", "on_ambiguity", "always"].includes(raw.execution.confirmation as string)) {
      fail(issues, "invalid_enum", "execution.confirmation", "confirmation must be never|on_ambiguity|always");
    }
  }

  if (!isRecord(raw.responses)) {
    fail(issues, "invalid_type", "responses", "responses must be an object");
  } else {
    checkKnownKeys(issues, "responses", raw.responses, RESPONSES_KEYS);
    checkStringCap(issues, "responses.completed", raw.responses.completed, FOUNDRY_LIMITS_V1.descriptionChars, "responses.completed");
    checkStringCap(issues, "responses.needsChoice", raw.responses.needsChoice, FOUNDRY_LIMITS_V1.descriptionChars, "responses.needsChoice");
    checkStringCap(issues, "responses.blocked", raw.responses.blocked, FOUNDRY_LIMITS_V1.descriptionChars, "responses.blocked");
  }

  if (checkArrayCap(issues, "provenance", raw.provenance, FOUNDRY_LIMITS_V1.provenanceReferences, "provenance")) {
    (raw.provenance as unknown[]).forEach((p, i) => checkSourceRef(issues, `provenance[${i}]`, p));
  }

  if (!Array.isArray(raw.legacyAliases) || !raw.legacyAliases.every((a) => typeof a === "string" && /^[a-z0-9_]+$/.test(a))) {
    fail(issues, "invalid_type", "legacyAliases", "legacyAliases must be an array of lowercase snake_case strings");
  }

  if (!isRecord(raw.compatibility)) {
    fail(issues, "invalid_type", "compatibility", "compatibility must be an object");
  } else {
    checkKnownKeys(issues, "compatibility", raw.compatibility, [...COMPATIBILITY_KEYS, "nativeSourceSha256"]);
    checkNonEmptyString(issues, "compatibility.minMoshVersion", raw.compatibility.minMoshVersion, "minMoshVersion");
    checkHex64(issues, "compatibility.commandCatalogSha256", raw.compatibility.commandCatalogSha256, "commandCatalogSha256");
    if (typeof raw.compatibility.predicateCatalogVersion !== "number" || !Number.isInteger(raw.compatibility.predicateCatalogVersion)) {
      fail(issues, "invalid_type", "compatibility.predicateCatalogVersion", "predicateCatalogVersion must be an integer");
    }
    if (typeof raw.compatibility.resolverCatalogVersion !== "number" || !Number.isInteger(raw.compatibility.resolverCatalogVersion)) {
      fail(issues, "invalid_type", "compatibility.resolverCatalogVersion", "resolverCatalogVersion must be an integer");
    }
    checkHex64(issues, "compatibility.nativeSourceSha256", raw.compatibility.nativeSourceSha256, "nativeSourceSha256");
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: raw as unknown as NativeSkillPayloadV1 };
}

const BUNDLE_ENTRY_KEYS = [
  "schemaVersion", "state", "skillId", "version", "nativePayloadSha256",
  "certificationReportSha256", "approvalSha256", "moshBuildIdentity", "bundledAt",
] as const;

export function parseNativeSkillBundleEntryV1(raw: unknown): ParseResult<NativeSkillBundleEntryV1> {
  const issues: ParseIssueV1[] = [];
  if (!isRecord(raw)) {
    fail(issues, "invalid_type", "", "native bundle entry must be a JSON object");
    return { ok: false, issues };
  }
  checkKnownKeys(issues, "", raw, BUNDLE_ENTRY_KEYS);
  if (raw.schemaVersion !== 1) fail(issues, "invalid_schema_version", "schemaVersion", "schemaVersion must be 1");
  if (raw.state !== "owner_approved") fail(issues, "invalid_enum", "state", 'state must be "owner_approved"');
  if (typeof raw.skillId !== "string" || !(NATIVE_SKILL_IDS_V1 as readonly string[]).includes(raw.skillId)) {
    fail(issues, "unknown_native_id", "skillId", `skillId must be one of: ${NATIVE_SKILL_IDS_V1.join(", ")}`);
  }
  checkVersion(issues, "version", raw.version);
  checkHex64(issues, "nativePayloadSha256", raw.nativePayloadSha256, "nativePayloadSha256");
  checkHex64(issues, "certificationReportSha256", raw.certificationReportSha256, "certificationReportSha256");
  checkHex64(issues, "approvalSha256", raw.approvalSha256, "approvalSha256");
  checkNonEmptyString(issues, "moshBuildIdentity", raw.moshBuildIdentity, "moshBuildIdentity");
  checkNonEmptyString(issues, "bundledAt", raw.bundledAt, "bundledAt");
  if (typeof raw.bundledAt === "string" && Number.isNaN(Date.parse(raw.bundledAt))) {
    fail(issues, "invalid_date", "bundledAt", "bundledAt must be a parseable date");
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: raw as unknown as NativeSkillBundleEntryV1 };
}

const RELEASE_VERIFICATION_KEYS = [
  "schemaVersion", "state", "nativePayloadSha256", "certificationReportSha256", "approvalSha256",
  "bundleEntrySha256", "moshBuildIdentity", "bundleSha256", "codeSignatureCDHash", "checks", "verifiedAt",
] as const;

const RELEASE_VERIFICATION_CHECK_NAMES = new Set([
  "native_selftest", "live_shell", "protools_shell", "resource_index", "candidate_loader_absent",
]);

export function parseNativeReleaseVerificationV1(raw: unknown): ParseResult<NativeReleaseVerificationV1> {
  const issues: ParseIssueV1[] = [];
  if (!isRecord(raw)) {
    fail(issues, "invalid_type", "", "native release verification must be a JSON object");
    return { ok: false, issues };
  }
  checkKnownKeys(issues, "", raw, RELEASE_VERIFICATION_KEYS);
  if (raw.schemaVersion !== 1) fail(issues, "invalid_schema_version", "schemaVersion", "schemaVersion must be 1");
  if (raw.state !== "release_packaged_green") fail(issues, "invalid_enum", "state", 'state must be "release_packaged_green"');
  checkHex64(issues, "nativePayloadSha256", raw.nativePayloadSha256, "nativePayloadSha256");
  checkHex64(issues, "certificationReportSha256", raw.certificationReportSha256, "certificationReportSha256");
  checkHex64(issues, "approvalSha256", raw.approvalSha256, "approvalSha256");
  checkHex64(issues, "bundleEntrySha256", raw.bundleEntrySha256, "bundleEntrySha256");
  checkNonEmptyString(issues, "moshBuildIdentity", raw.moshBuildIdentity, "moshBuildIdentity");
  checkHex64(issues, "bundleSha256", raw.bundleSha256, "bundleSha256");
  checkNonEmptyString(issues, "codeSignatureCDHash", raw.codeSignatureCDHash, "codeSignatureCDHash");

  if (!Array.isArray(raw.checks) || raw.checks.length === 0) {
    fail(issues, "invalid_type", "checks", "checks must be a non-empty array");
  } else {
    raw.checks.forEach((check, i) => {
      const path = `checks[${i}]`;
      if (!isRecord(check)) {
        fail(issues, "invalid_type", path, "check must be an object");
        return;
      }
      checkKnownKeys(issues, path, check, ["name", "status", "artifactHashes"]);
      if (typeof check.name !== "string" || !RELEASE_VERIFICATION_CHECK_NAMES.has(check.name)) {
        fail(issues, "invalid_enum", `${path}.name`, "unknown release-verification check name");
      }
      if (check.status !== "passed") fail(issues, "invalid_enum", `${path}.status`, 'status must be "passed"');
      if (!Array.isArray(check.artifactHashes) || !check.artifactHashes.every((h) => typeof h === "string" && HEX64_REGEX.test(h))) {
        fail(issues, "invalid_hash", `${path}.artifactHashes`, "artifactHashes must all be 64-hex SHA-256 strings");
      }
    });
  }

  checkNonEmptyString(issues, "verifiedAt", raw.verifiedAt, "verifiedAt");
  if (typeof raw.verifiedAt === "string" && Number.isNaN(Date.parse(raw.verifiedAt))) {
    fail(issues, "invalid_date", "verifiedAt", "verifiedAt must be a parseable date");
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: raw as unknown as NativeReleaseVerificationV1 };
}
