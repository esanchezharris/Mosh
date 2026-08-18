// Skill Foundry Slice B, Task 6 — the four canonical native payloads and the certification
// factory that turns a committed native-source byte set into signed-payload artifacts.
//
// This module owns DATA (the four `NativeSkillPayloadV1` objects, byte-for-byte the source
// of truth `native/index.ts` pairs with their handlers) plus one PURE function
// (`materializeNativePayloadArtifactsV1`) that builds the exact stored bytes/hashes Slice E
// stages into a bundled package. It does not read the filesystem, does not know about
// `readCertifiedNativeSkills`/the bridge, and does not decide whether a build is acceptable
// for registration (that policy lives in `packageValidation.ts`'s
// `validateNativeArtifactGraphV1`) — it only computes identity and serializes bytes.

import { canonicalJsonBytes, sha256Bytes, utf8Bytes } from "../hash";
import { canonicalMoshBuildIdentityV1, nativeSourceByteSetSha256V1 } from "../nativeIdentity";
import type {
  CatalogFingerprintV1,
  CertifiedSkillFileV1,
  MoshBuildIdentityInputV1,
  NativeSkillPayloadV1,
  NativeSourceByteSetV1,
} from "../contracts";

// ---------------------------------------------------------------------------------------
// NATIVE_SOURCE_PATHS_V1 — the exact, lexicographically sorted committed-source byte set
// every one of the four native handlers is built from (spec's own literal list).
// ---------------------------------------------------------------------------------------

export const NATIVE_SOURCE_PATHS_V1 = [
  "src/engine/MoshEngine.cpp", "src/moshops/MoshOps.Tracks.cpp",
  "src/moshops/MoshOps.cpp", "src/moshops/MoshOpsInternal.h",
  "src/plugins/hosting/PluginHost.cpp", "src/plugins/hosting/PluginHost.h",
  "src/state/Ids.h", "src/state/TakeIdentity.h",
  "ui/src/agent/commands.ts", "ui/src/agent/skillFoundry/atomicPlan.ts",
  "ui/src/agent/skillFoundry/contracts.ts", "ui/src/agent/skillFoundry/native/explicitBalance.ts",
  "ui/src/agent/skillFoundry/native/index.ts", "ui/src/agent/skillFoundry/native/loadNamedPlugin.ts",
  "ui/src/agent/skillFoundry/native/payloads.ts", "ui/src/agent/skillFoundry/native/sessionControl.ts",
  "ui/src/agent/skillFoundry/native/takeCycle.ts", "ui/src/agent/skillFoundry/runtime.ts",
  "ui/src/agent/skills.ts", "ui/src/agent/studioSkills.ts",
  "ui/src/recordingLifecycle.ts", "ui/src/store.ts", "ui/src/types.ts",
  "ui/src/ui/pluginBrowserUtil.ts",
] as const;

// ---------------------------------------------------------------------------------------
// The four canonical payloads. `compatibility.commandCatalogSha256`/
// `predicateCatalogVersion`/`resolverCatalogVersion` and `compatibility.nativeSourceSha256`
// are placeholders here (this module has no build-time catalog/source access) — the real
// values are stamped in by `materializeNativePayloadArtifactsV1` at materialization time
// (Slice E), matching `NativeSkillPayloadV1.compatibility`'s own note that a manifest's
// compatibility block is bound at build/certification time, not authored by hand. Runtime
// tests and the default boot both go through `packageValidation.ts`'s real chain checks
// before any payload here is ever registered, so a stale placeholder can never reach a live
// registry — see runtime.ts.
// ---------------------------------------------------------------------------------------

const PLACEHOLDER_CATALOG_SHA256 = "0".repeat(64);
const PLACEHOLDER_NATIVE_SOURCE_SHA256 = "0".repeat(64);

const BASE_COMPATIBILITY = {
  minMoshVersion: "0.1.0",
  commandCatalogSha256: PLACEHOLDER_CATALOG_SHA256,
  predicateCatalogVersion: 1,
  resolverCatalogVersion: 1,
  nativeSourceSha256: PLACEHOLDER_NATIVE_SOURCE_SHA256,
} as const;

export const SESSION_CONTROL_PAYLOAD_V1: NativeSkillPayloadV1 = {
  schemaVersion: 1,
  id: "session-control",
  version: "1.0.0",
  implementation: "native",
  handlerKey: "sessionControlV1",
  title: "Session control and safety",
  description: "Play, stop, return to the start, save, undo, and redo — no creative interpretation.",
  intents: {
    positiveExamples: ["play", "stop", "back to the start", "save the project", "undo", "redo that"],
    negativeExamples: ["mix this", "make it sound professional", "load Serum 2"],
    tags: ["transport", "session", "undo", "save"],
  },
  slots: [],
  execution: { mode: "lifecycle", confirmation: "never" },
  responses: {
    completed: "Done.",
    needsChoice: "Which one?",
    blocked: "I couldn't do that.",
  },
  provenance: [],
  legacyAliases: [],
  compatibility: BASE_COMPATIBILITY,
};

export const CAPTURE_REVIEW_CHOOSE_TAKE_PAYLOAD_V1: NativeSkillPayloadV1 = {
  schemaVersion: 1,
  id: "capture-review-choose-take",
  version: "1.0.0",
  implementation: "native",
  handlerKey: "takeCycleV1",
  title: "Capture, review, and choose a take",
  description: "Start or stop a recording, audition a take, try again, and keep the chosen take.",
  intents: {
    positiveExamples: ["record a take", "stop recording", "try that again", "next take", "previous take", "keep it"],
    negativeExamples: ["play", "save the project"],
    tags: ["recording", "takes"],
  },
  slots: [],
  execution: { mode: "lifecycle", confirmation: "never" },
  responses: {
    completed: "Done.",
    needsChoice: "Which one?",
    blocked: "I couldn't do that.",
  },
  provenance: [],
  legacyAliases: [],
  compatibility: BASE_COMPATIBILITY,
};

export const EXPLICIT_BALANCE_PAYLOAD_V1: NativeSkillPayloadV1 = {
  schemaVersion: 1,
  id: "explicit-balance",
  version: "1.0.0",
  implementation: "native",
  handlerKey: "explicitBalanceV1",
  title: "Focus and basic explicit balance",
  description: "Mute, unmute, or solo a uniquely resolved track, or set it to an explicit dB level.",
  intents: {
    positiveExamples: ["set drums to -6 dB", "mute the vocals", "solo the bass", "unmute the guitar"],
    negativeExamples: ["mix this", "make it sound professional", "master this"],
    tags: ["mixing", "levels"],
  },
  slots: [],
  execution: { mode: "atomic", confirmation: "never" },
  responses: {
    completed: "Done.",
    needsChoice: "Which track did you mean?",
    blocked: "I couldn't do that.",
  },
  provenance: [],
  legacyAliases: [],
  compatibility: BASE_COMPATIBILITY,
};

export const LOAD_NAMED_PLUGIN_PAYLOAD_V1: NativeSkillPayloadV1 = {
  schemaVersion: 1,
  id: "load-named-plugin",
  version: "1.0.0",
  implementation: "native",
  handlerKey: "loadNamedPluginV1",
  title: "Resolve and load a named plug-in",
  description: "Inspect the installed catalog, resolve an exact name or bounded choice, and load it once on the selected track.",
  intents: {
    positiveExamples: ["load Serum 2", "add OTT to the selected track", "insert a compressor"],
    negativeExamples: ["mute the drums", "play"],
    tags: ["plugins"],
  },
  slots: [],
  execution: { mode: "atomic", confirmation: "never" },
  responses: {
    completed: "Done.",
    needsChoice: "Which plug-in did you mean?",
    blocked: "I couldn't do that.",
  },
  provenance: [],
  legacyAliases: ["load_named_plugin"],
  compatibility: BASE_COMPATIBILITY,
};

export const NATIVE_PAYLOADS_V1: readonly NativeSkillPayloadV1[] = [
  SESSION_CONTROL_PAYLOAD_V1,
  CAPTURE_REVIEW_CHOOSE_TAKE_PAYLOAD_V1,
  EXPLICIT_BALANCE_PAYLOAD_V1,
  LOAD_NAMED_PLUGIN_PAYLOAD_V1,
];

// ---------------------------------------------------------------------------------------
// materializeNativePayloadArtifactsV1 — Slice E's certification factory. Builds the exact
// stored payload bytes/hashes for all four canonical payloads from a committed native
// source-byte-set, a validated build identity, and the current catalog fingerprint. Never
// invoked by the default runtime boot (Slice B ships zero bundled resources); Task 6/8's
// own tests call it directly with fixture bytes.
// ---------------------------------------------------------------------------------------

export type MaterializedNativePayloadV1 = {
  readonly id: NativeSkillPayloadV1["id"];
  readonly payload: NativeSkillPayloadV1;
  readonly utf8: string;
  readonly bytes: number;
  readonly sha256: string;
};

export type MaterializeNativePayloadArtifactsInputV1 = {
  readonly nativeSource: NativeSourceByteSetV1;
  readonly buildIdentity: MoshBuildIdentityInputV1;
  readonly catalogFingerprint: CatalogFingerprintV1;
};

export type MaterializeNativePayloadArtifactsResultV1 =
  | {
      readonly ok: true;
      readonly moshBuildIdentity: string;
      readonly payloads: readonly MaterializedNativePayloadV1[];
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Sorted, de-duplicated comparison of two path lists — order-independent, but every path
 *  must appear EXACTLY once on both sides (spec: "Missing ... or extra paths fail
 *  materialization"). */
function pathsMatchExactly(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  return sortedActual.every((path, index) => path === sortedExpected[index]);
}

export async function materializeNativePayloadArtifactsV1(
  input: MaterializeNativePayloadArtifactsInputV1,
): Promise<MaterializeNativePayloadArtifactsResultV1> {
  if (input.buildIdentity.gitState !== "clean") {
    return { ok: false, code: "dirty_tree", message: "materialization requires a clean git tree" };
  }
  if (input.buildIdentity.configuration !== "Release") {
    return { ok: false, code: "wrong_configuration", message: "materialization requires a Release configuration" };
  }
  if (input.buildIdentity.architecture !== "arm64") {
    return { ok: false, code: "wrong_architecture", message: "materialization requires arm64" };
  }

  const actualPaths = input.nativeSource.files.map((file) => file.path);
  const seen = new Set<string>();
  for (const path of actualPaths) {
    if (seen.has(path)) return { ok: false, code: "duplicate_path", message: `duplicate source path: ${path}` };
    seen.add(path);
  }
  if (!pathsMatchExactly(actualPaths, NATIVE_SOURCE_PATHS_V1)) {
    return { ok: false, code: "path_set_mismatch", message: "native source byte set does not match NATIVE_SOURCE_PATHS_V1 exactly" };
  }

  const identity = canonicalMoshBuildIdentityV1(input.buildIdentity);
  if (!identity.ok) {
    return { ok: false, code: "invalid_build_identity", message: identity.issues.map((issue) => issue.message).join("; ") };
  }

  let nativeSourceSha256: string;
  try {
    nativeSourceSha256 = await nativeSourceByteSetSha256V1(input.nativeSource);
  } catch (error) {
    return { ok: false, code: "invalid_native_source", message: error instanceof Error ? error.message : String(error) };
  }

  const compatibility = {
    minMoshVersion: "0.1.0",
    commandCatalogSha256: input.catalogFingerprint.commandCatalogSha256,
    predicateCatalogVersion: input.catalogFingerprint.predicateCatalogVersion,
    resolverCatalogVersion: input.catalogFingerprint.resolverCatalogVersion,
    nativeSourceSha256,
  };

  const payloads: MaterializedNativePayloadV1[] = [];
  for (const base of NATIVE_PAYLOADS_V1) {
    const payload: NativeSkillPayloadV1 = {
      ...base,
      version: input.buildIdentity.appVersion,
      compatibility,
    };
    // Deterministic stored bytes: canonicalJsonBytes so a re-serialization with the same
    // logical content always yields the same bytes (this factory OWNS the payload's exact
    // stored form — there is no separate "author-typed JSON file" for a native payload the
    // way there is for a declarative manifest).
    const utf8 = new TextDecoder().decode(canonicalJsonBytes(payload));
    const bytes = utf8Bytes(utf8);
    const sha256 = await sha256Bytes(bytes);
    payloads.push({ id: payload.id, payload, utf8, bytes: bytes.length, sha256 });
  }

  return { ok: true, moshBuildIdentity: identity.value, payloads };
}

/** Type-only re-export so a caller that only needs the file shape does not have to import
 *  `contracts.ts` directly for it. */
export type { CertifiedSkillFileV1 };
