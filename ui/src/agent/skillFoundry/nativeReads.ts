// Task 4 — typed wrappers for the three non-MoshOps native reads.
//
// SCOPE: this module ONLY wraps the three dedicated bridge functions
// (readCertifiedSkillPackages/readSkillSourceStatus/readCertifiedNativeSkills, defined in
// ui/src/bridge.ts) into the exact V1 wire-typed shape their callers expect. It does NO
// registry adaptation, NO validation, NO hash-chain checking — that is `packageValidation.ts`
// (Task 3), `registry.ts`/`nativeAdapter.ts` (Task 5), and `loadCertifiedSkills.ts` (Task 9).
//
// A bare `as` cast is used rather than a runtime shape check: the native side (C++'s
// CertifiedSkillLoader) and the mock/dev side (bridge.ts's EMPTY_* envelopes) both already
// produce exactly the CertifiedSkillLoadV1/SkillSourceStatusReadV1/CertifiedNativeSkillLoadV1
// shape contracts.ts defines — re-validating that shape here would be a second, redundant
// parser for data this module does not otherwise interpret. Every BYTE this loader reports
// (manifest/certification/approval/release/payload/bundleEntry content) still goes through
// Task 2/3's real `parse*V1`/`validate*V1` functions downstream, which reject a malformed or
// tampered envelope on their own terms rather than trusting this cast.
//
// Non-MoshOps: none of the three reads below is reachable via execute_command / MoshOps —
// see nativeBridgeBoundary.test.ts for the durable guard (both the TS catalog side and the
// native WebBridge.cpp registration side).

import {
  readCertifiedSkillPackages,
  readSkillSourceStatus,
  readCertifiedNativeSkills,
} from "../../bridge";
import type {
  CertifiedSkillLoadV1,
  SkillSourceStatusReadV1,
  CertifiedNativeSkillLoadV1,
} from "./contracts";

/** The full owner-local certified-skill package load (activation index + source-status
 *  index + every admitted package under $MOSH_AGENT_DIR/skills/certified). */
export function readCertifiedSkillPackagesV1(): Promise<CertifiedSkillLoadV1> {
  return readCertifiedSkillPackages() as Promise<CertifiedSkillLoadV1>;
}

/** A narrow, cheap re-read of just the source-status index — the per-invocation staleness
 *  check `validateSourceStatusForInvocationV1` (packageValidation.ts) compares against. */
export function readSkillSourceStatusV1(): Promise<SkillSourceStatusReadV1> {
  return readSkillSourceStatus() as Promise<SkillSourceStatusReadV1>;
}

/** The full bundled native-skill package load (resource index + every admitted package
 *  under the app's staged resources, plus the compiled-in build identity). */
export function readBundledNativeSkillsV1(): Promise<CertifiedNativeSkillLoadV1> {
  return readCertifiedNativeSkills() as Promise<CertifiedNativeSkillLoadV1>;
}
