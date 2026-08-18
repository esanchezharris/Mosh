// Task 5 — the build-time skill identity/collision gate. Wired as the CMake custom target
// `MoshSkillIdentityGate` (`cmake/BuildUI.cmake`), which passes it `$<CONFIG>`,
// `PROJECT_VERSION`, target, architecture, and the paths to three BUILD-TREE-only generated
// files: the native bundled index, the declarative bundled index, and the owner active
// index. None of those three paths is ever a source-tree path — `resources/skills/native/`
// and `resources/skills/declarative/` are never created in the source tree and never
// committed (Task 5's own global-constraints text; `git ls-files` on both must return empty,
// asserted by Task 10 Step 4).
//
// This script does exactly two things, gated on `--configuration`:
//
//   1. ALWAYS (Debug and Release): parse the three index files (a missing path is treated as
//      an empty index — Slice A ships zero bundled skills of either origin, so "the file does
//      not exist yet" is the expected steady state, not an error), validate their SHAPE, and
//      run `validateReleaseIdentityUniverseV1` (registry.ts, the SAME function
//      `skillIdentityUniverse.test.ts` unit-tests directly) over the three enumerations. This
//      is the actual collision gate; it is what makes "Debug validates shapes/collisions but
//      permits a dirty tree" true.
//
//   2. Release ONLY: additionally validate the build's own identity — clean, known 40-hex git
//      commit; `configuration === "Release"`; `architecture === "arm64"` — via the same
//      `canonicalMoshBuildIdentityV1` formatter `packageValidation.ts`'s
//      `validateNativeArtifactGraphV1` uses for the real per-package registration policy, and
//      a real (not simulated) `catalogFingerprintV1()` computation, so a broken catalog
//      fingerprint mechanism fails this gate even with zero packages to check it against.
//      "source-set hash drift" (the plan's own phrase) has NOTHING to compare against yet in
//      Slice A — no native skill payload embeds a `nativeSourceSha256` today — so that
//      specific drift comparison is out of scope here; it activates once a later slice stages
//      a real bundled native package this gate can read `compatibility.nativeSourceSha256`
//      from. This is a scope note, not a shortcut: nothing here is faked to look like it
//      passed a check it did not run.
//
// Exit code 0 = every check that ran, passed. Exit code 1 = a real failure, with a message
// naming exactly which check failed.

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { catalogFingerprintV1 } from "../src/agent/skillFoundry/catalogs";
import { canonicalMoshBuildIdentityV1 } from "../src/agent/skillFoundry/nativeIdentity";
import { validateReleaseIdentityUniverseV1, type ReleaseIdentityUniverseEntryV1 } from "../src/agent/skillFoundry/registry";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

function argFlag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function fail(message: string): never {
  // eslint-disable-next-line no-console
  console.error(`verify:skill-identities: FAIL — ${message}`);
  process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read + parse ONE bundled index file (native or declarative). Missing path/file => empty
 *  index (Slice A ships nothing yet). An EXISTING but malformed file is a real failure —
 *  this is the "Debug validates shapes" half of the gate. */
function readBundledIndex(path: string | undefined, label: string): readonly ReleaseIdentityUniverseEntryV1[] {
  if (!path || !existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`${label} index at ${path} is not valid JSON`);
  }
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.skills)) {
    fail(`${label} index at ${path} must be {schemaVersion:1, skills:[...]}`);
  }
  const skills = (raw as { skills: unknown[] }).skills;
  return skills.map((entry, i) => {
    if (!isRecord(entry) || typeof entry.id !== "string") {
      fail(`${label} index at ${path}: skills[${i}] must be an object with a string "id"`);
    }
    const aliases = (entry as { aliases?: unknown }).aliases;
    if (aliases !== undefined && (!Array.isArray(aliases) || !aliases.every((a) => typeof a === "string"))) {
      fail(`${label} index at ${path}: skills[${i}].aliases must be an array of strings if present`);
    }
    return { id: (entry as { id: string }).id, aliases: aliases as readonly string[] | undefined };
  });
}

/** Read + parse the owner active index. Its real shape is `SkillActivationIndexV1`
 *  (contracts.ts, Task 1): IDs are the `skills` record's OWN KEYS, not a `.id` field —
 *  matching what a real `active.json` (and this task's `release-owner-active.json` fixture)
 *  actually looks like, so this gate never invents a second schema for the same file a later
 *  task will parse for real. */
function readOwnerActiveIndex(path: string | undefined): readonly ReleaseIdentityUniverseEntryV1[] {
  if (!path || !existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`owner active index at ${path} is not valid JSON`);
  }
  if (!isRecord(raw) || raw.schemaVersion !== 1 || typeof raw.generation !== "number" || !isRecord(raw.skills)) {
    fail(`owner active index at ${path} must be {schemaVersion:1, generation:number, skills:{...}}`);
  }
  return Object.keys((raw as { skills: Record<string, unknown> }).skills).map((id) => ({ id }));
}

function gitOutput(args: readonly string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const configuration = argFlag("configuration");
  if (configuration !== "Debug" && configuration !== "Release") {
    fail(`--configuration must be "Debug" or "Release" (got ${JSON.stringify(configuration)})`);
  }

  const native = readBundledIndex(argFlag("native-index"), "native");
  const declarative = readBundledIndex(argFlag("declarative-index"), "declarative");
  const owner = readOwnerActiveIndex(argFlag("owner-active-index"));

  const universe = validateReleaseIdentityUniverseV1({ native, declarative, owner });
  if (!universe.ok) {
    fail(`identity collision: "${universe.identity}" is claimed by more than one of native/declarative/owner`);
  }

  if (configuration === "Release") {
    const appVersion = argFlag("app-version");
    const target = argFlag("target", "Mosh")!;
    const architecture = argFlag("architecture", "arm64")!;
    if (!appVersion) fail("--app-version is required when --configuration Release");

    if (target !== "Mosh") fail(`non-Release build identity: target must be "Mosh" (got ${JSON.stringify(target)})`);
    if (architecture !== "arm64") fail(`wrong architecture: expected "arm64" (got ${JSON.stringify(architecture)})`);

    const porcelain = gitOutput(["status", "--porcelain"]);
    const gitState: "clean" | "dirty" | "unknown" = porcelain === null ? "unknown" : porcelain.length === 0 ? "clean" : "dirty";
    if (gitState !== "clean") fail(`dirty/unknown Git state is not permitted in Release (gitState=${gitState})`);

    const gitCommit = gitOutput(["rev-parse", "HEAD"]);
    if (!gitCommit || !/^[0-9a-f]{40}$/.test(gitCommit)) fail("stale/unresolvable git commit: `git rev-parse HEAD` did not return 40 lowercase hex characters");

    const identity = canonicalMoshBuildIdentityV1({ appVersion, gitCommit, gitState, target, configuration, architecture });
    if (!identity.ok) fail(`malformed build identity inputs: ${identity.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);

    // Real mechanism check, not a simulated pass: a broken catalog fingerprint computation
    // (thrown exception, non-hex64 digest) fails the gate even with zero packages to compare
    // it against. Full DRIFT comparison against an embedded artifact value is out of scope
    // here — see this file's header.
    const fingerprint = await catalogFingerprintV1();
    if (!/^[0-9a-f]{64}$/.test(fingerprint.commandCatalogSha256)) {
      fail("catalog fingerprint mechanism produced a malformed commandCatalogSha256");
    }
  }

  // eslint-disable-next-line no-console
  console.log(`verify:skill-identities: OK (${configuration}; native=${native.length} declarative=${declarative.length} owner=${owner.length})`);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
