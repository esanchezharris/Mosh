// Task 5 — the native registry adapter: maps one Task-3-validated native artifact graph
// result into a `RegisteredSkillV1` registry candidate, WITHOUT re-implementing any part of
// Task 3's hash-chain/compatibility/build-identity checking (`validateNativeArtifactGraphV1`,
// packageValidation.ts). A failing graph result is forwarded UNCHANGED (Task 5 Step 3: "it
// does not implement a second graph checker") — this adapter adds exactly the two things a
// registry candidate needs on top of an already-validated graph:
//
//   1. the origin/manifest mapping (spec 9.1's "presents native built-ins ... through the
//      same interface" as a validated declarative manifest);
//   2. legacy-alias PINNING — `validateNativeArtifactGraphV1`/`parseNativeSkillPayloadV1`
//      (Task 2/3) only check that `legacyAliases` is well-FORMED (an array of lowercase
//      snake_case strings); neither checks it against the closed
//      `NATIVE_SKILL_LEGACY_ALIASES_V1` mapping. A payload could otherwise declare an
//      alias that belongs to nothing (or, worse, belongs to a DIFFERENT native id) and pass
//      Task 3 cleanly. Task 5 Step 1 pins this explicitly ("Pin `load_named_plugin ->
//      load-named-plugin`; similar examples/titles never create precedence") — this is the
//      one place that pin is actually enforced.

import { NATIVE_SKILL_IDS_V1, NATIVE_SKILL_LEGACY_ALIASES_V1 } from "./catalogs";
import { NATIVE_HANDLERS_V1 } from "./native/index";
import { parseNativeSkillPayloadV1 } from "./validate";
import type { NativeSkillPayloadV1, RegisteredSkillV1 } from "./contracts";
import type { NativeArtifactGraphValidationResultV1 } from "./packageValidation";

export type NativeAdapterFailureCodeV1 = "unpinned_native_alias";

export type NativeAdapterFailureV1 = {
  readonly ok: false;
  readonly code: NativeAdapterFailureCodeV1;
  readonly path: string;
  readonly message: string;
};

// DESIGN DECISION: not given an exact shape. The success arm is a plain `RegisteredSkillV1`
// (this adapter's whole job); the first failure arm is Task 3's OWN failure shape, extracted
// structurally from the exported `NativeArtifactGraphValidationResultV1` union rather than
// re-declaring (or importing by name — it is not exported) `packageValidation.ts`'s private
// `FailureV1` type, so a forwarded Task-3 failure is provably the SAME value, not a
// re-encoded lookalike. The second failure arm is this adapter's own alias-pinning check.
export type AdaptNativeSkillResultV1 =
  | { readonly ok: true; readonly value: RegisteredSkillV1 }
  | Extract<NativeArtifactGraphValidationResultV1, { readonly ok: false }>
  | NativeAdapterFailureV1;

export function adaptNativeSkillV1(graph: NativeArtifactGraphValidationResultV1): AdaptNativeSkillResultV1 {
  if (!graph.ok) return graph;

  const validated = graph.value;
  for (const alias of validated.payload.legacyAliases) {
    const canonical = NATIVE_SKILL_LEGACY_ALIASES_V1[alias];
    if (canonical !== validated.id) {
      return {
        ok: false,
        code: "unpinned_native_alias",
        path: "payload.legacyAliases",
        message: `legacy alias "${alias}" is not pinned to id "${validated.id}"`,
      };
    }
  }

  return {
    ok: true,
    value: {
      id: validated.id,
      origin: "native",
      aliases: validated.payload.legacyAliases,
      manifest: validated.payload,
    },
  };
}

// ---------------------------------------------------------------------------------------
// adaptCodeBoundNativeSkillV1 — owner decision, CODE-BOUND SEEDING.
// ---------------------------------------------------------------------------------------
//
// DESIGN DECISION: TRUST ROOT. `adaptNativeSkillV1` above only ever sees a graph that has
// already survived Task 3's `validateNativeArtifactGraphV1` — the full hash-chain /
// compatibility / build-identity / approval chain over bytes that arrived from
// $MOSH_AGENT_DIR or the app's staged native resources (loadCertifiedOwnerSkillsV1 /
// loadBundledNativeSkillsV1). Both of those sources are EXTERNAL artifact graphs: they are
// admitted because a separate approval/certification/release record vouches for the exact
// bytes on disk. Outside a real WebView/native bridge — and in any shipped app before Slice
// E's bundled-index staging lands — both are empty (bridge.ts's `realNative()` check;
// nativeReads.ts's own note on the EMPTY_* envelopes), so the default runtime's registry was
// empty and the four core skills, including `load_named_plugin` (which works in production
// today via the legacy `studioSkills.ts` path), were INACTIVE. That is a regression, not a
// feature of the artifact-graph design — flagged in 0e860fea's own commit message.
//
// The owner's fix: admit the four canonical payloads (`NATIVE_PAYLOADS_V1`, native/payloads.ts)
// directly, with a DIFFERENT trust root — the app's own code signature. These payload
// literals are compiled into the TypeScript bundle and ship inside the SAME signed artifact
// as every native handler that executes them; there is no separate byte blob on disk for an
// attacker to substitute independently of the app binary itself. Because the trust root is
// different, the external checks that justify `adaptNativeSkillV1` — build-identity binding,
// external SHA-256 hashes, a recorded owner-approval artifact — do NOT apply here and are
// deliberately NOT re-implemented: there is nothing external to check. What DOES still apply,
// because it is intrinsic to the payload's own shape rather than to how it arrived, is:
//   1. Slice A schema-level validation (`parseNativeSkillPayloadV1`) — the same parser every
//      disk/resource-sourced payload goes through, run here as cheap insurance against a
//      payload literal that drifted out of schema shape (e.g. a bad hand-edit to payloads.ts)
//      without anyone noticing.
//   2. Legacy-alias PINNING against the closed `NATIVE_SKILL_LEGACY_ALIASES_V1` table —
//      IDENTICAL rule to `adaptNativeSkillV1`'s own check above (Task 5 Step 1's "Pin
//      `load_named_plugin -> load-named-plugin`; similar examples/titles never create
//      precedence"). A payload's alias claim is a claim about SHAPE, not about provenance —
//      the trust-root difference does not exempt it.
//   3. `id` membership in the closed `NATIVE_SKILL_IDS_V1` universe. `registry.ts`'s
//      `validateRegistryCandidateV1` (registry.ts:83) already enforces this again at
//      admission time — this is DELIBERATE defense in depth, not redundancy to be trimmed:
//      a bug in this adapter must never be able to depend on the registry layer alone to
//      catch a bad id.
//   4. `handlerKey` resolving through the closed, compile-time `NATIVE_HANDLERS_V1` map
//      (spec 8.1: "data cannot add native code"). `parseNativeSkillPayloadV1` already pins
//      `handlerKey` to the one correct value for `id` via its own closed
//      `NATIVE_ID_TO_HANDLER_KEY` table, so this too is defense in depth.
//
// REACHABILITY: this function must NEVER be called with a payload that was parsed from disk,
// a network response, or ANY other runtime-supplied bytes — its whole legitimacy rests on the
// caller passing ONLY an element of the compiled-in `NATIVE_PAYLOADS_V1` constant, which ships
// inside the app's own signed bundle. Its signature takes an already-typed
// `NativeSkillPayloadV1`, never `unknown`/raw bytes/JSON — a disk-sourced value only reaches
// this parameter type through a deliberate, greppable unsafe cast, unlike
// `parseNativeSkillPayloadV1(raw: unknown)`, which is the boundary every byte-sourced payload
// must cross first. In production the ONLY call site is runtime.ts's
// `buildCodeBoundNativeSkillCandidatesV1()`, which takes NO parameters and maps this function
// directly over `NATIVE_PAYLOADS_V1` — there is no route from there to a byte a user, a
// plugin, or a resource on disk supplied. See codeBoundNativeBoundary.test.ts for the durable
// guard that keeps it that way. The external bundled-index path (`adaptNativeSkillV1` /
// `loadBundledNativeSkillsV1`) REMAINS the route for any FUTURE post-ship native addition —
// this function only ever admits the four payloads already compiled into this build.

export type AdaptCodeBoundNativeSkillFailureCodeV1 =
  | "invalid_code_bound_payload_schema"
  | "invalid_native_id"
  | "unpinned_native_alias"
  | "unknown_native_handler_key";

export type AdaptCodeBoundNativeSkillFailureV1 = {
  readonly ok: false;
  readonly code: AdaptCodeBoundNativeSkillFailureCodeV1;
  readonly id: string;
  readonly path: string;
  readonly message: string;
};

export type AdaptCodeBoundNativeSkillResultV1 =
  | { readonly ok: true; readonly value: RegisteredSkillV1 }
  | AdaptCodeBoundNativeSkillFailureV1;

export function adaptCodeBoundNativeSkillV1(payload: NativeSkillPayloadV1): AdaptCodeBoundNativeSkillResultV1 {
  const parsed = parseNativeSkillPayloadV1(payload);
  if (!parsed.ok) {
    return {
      ok: false,
      code: "invalid_code_bound_payload_schema",
      id: typeof (payload as { id?: unknown }).id === "string" ? (payload as { id: string }).id : "",
      path: parsed.issues[0]?.path ?? "",
      message: parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
    };
  }
  const validated = parsed.value;

  // Defense in depth #1 — see module note above.
  if (!(NATIVE_SKILL_IDS_V1 as readonly string[]).includes(validated.id)) {
    return {
      ok: false,
      code: "invalid_native_id",
      id: validated.id,
      path: "id",
      message: `id "${validated.id}" is not in NATIVE_SKILL_IDS_V1`,
    };
  }

  // Legacy-alias pinning — identical rule to adaptNativeSkillV1's own check above.
  for (const alias of validated.legacyAliases) {
    const canonical = NATIVE_SKILL_LEGACY_ALIASES_V1[alias];
    if (canonical !== validated.id) {
      return {
        ok: false,
        code: "unpinned_native_alias",
        id: validated.id,
        path: "legacyAliases",
        message: `legacy alias "${alias}" is not pinned to id "${validated.id}"`,
      };
    }
  }

  // Defense in depth #2 — see module note above.
  if (!(validated.handlerKey in NATIVE_HANDLERS_V1)) {
    return {
      ok: false,
      code: "unknown_native_handler_key",
      id: validated.id,
      path: "handlerKey",
      message: `handlerKey "${validated.handlerKey}" has no registered handler`,
    };
  }

  return {
    ok: true,
    value: {
      id: validated.id,
      origin: "native",
      aliases: validated.legacyAliases,
      manifest: validated,
    },
  };
}
