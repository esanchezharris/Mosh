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

import { NATIVE_SKILL_LEGACY_ALIASES_V1 } from "./catalogs";
import type { RegisteredSkillV1 } from "./contracts";
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
