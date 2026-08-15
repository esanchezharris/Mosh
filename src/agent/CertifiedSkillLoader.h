// Skill Foundry Task 4 — the native SAFE LOADER for certified skill packages.
//
// Engine-free, bounded, read-only filesystem admission — juce_core + juce_data_structures
// (+ juce_cryptography for SHA-256) ONLY, no tracktion_engine. This is the same shape as
// src/moshops/AgentMemoryStore.h (see that file's own header for the precedent this one
// follows structurally: a pure, hermetically testable native helper that MoshOps-adjacent
// code wraps, never the other way around) — tests/test_certified_skill_loader.cpp exercises
// the whole contract without a Tracktion engine or a live packaged app.
//
// C++ performs NO semantic certification here — no manifest/report/approval/release
// hash-chain validation, no compatibility checking, no registry construction. Its ONE job is
// to prove a package/index/entry is SAFE TO READ (fixed root, no symlinks, no hard links,
// owner-only where that applies, bounded size, strict UTF-8) and hand back its EXACT stored
// bytes plus a SHA-256 digest of those bytes. Everything semantic — schema parsing,
// hash-chain binding, catalog/build-identity matching, registry publication — lives
// TypeScript-side (ui/src/agent/skillFoundry/{packageValidation,nativeIdentity,registry}.ts).
// See docs/superpowers/plans/2026-08-14-moshi-skill-foundry-slice-a-contract-registry.md,
// Task 4.
//
// Non-MoshOps: nothing here is reachable via execute_command / MoshOps::execute. The three
// bridge reads that call into this loader (src/webview/WebBridge.cpp) are independent
// top-level `.withNativeFunction` registrations that never touch `commandHandler` — see
// ui/src/agent/skillFoundry/nativeBridgeBoundary.test.ts for the durable guard.
//
// Directory shapes — DESIGN DECISION (not given exact filenames anywhere in the plan or
// spec; documented here because two other modules must agree with this C++ on where things
// live: ui/src/agent/skillFoundry/nativeReads.ts's wrappers, and later Task 9's
// loadCertifiedSkills.ts):
//
//   OWNER packages, rooted at $MOSH_AGENT_DIR (resolveAgentRoot() — the SAME env var and
//   SAME default root as AgentMemoryStore.h's resolveGlobalRoot(), a different subtree of it):
//     <agentRoot>/skills/certified/active.json                        -> read()'s activeIndex
//     <agentRoot>/skills/source-status.json                           -> statusIndex (both
//                                                                        read() and
//                                                                        readSourceStatus()
//                                                                        return THIS SAME
//                                                                        file's bytes — read()
//                                                                        as part of a full
//                                                                        startup load,
//                                                                        readSourceStatus() as
//                                                                        a narrow per-invocation
//                                                                        staleness re-check
//                                                                        that must stay cheap)
//     <agentRoot>/skills/certified/<id>@<version>/skill.json          -> files.skill
//     <agentRoot>/skills/certified/<id>@<version>/certification.json  -> files.certification
//     <agentRoot>/skills/certified/<id>@<version>/approval.json       -> files.approval
//     <agentRoot>/skills/certified/<id>@<version>/release.json        -> files.release
//
//   BUNDLED NATIVE packages, rooted at the app's own staged resources
//   (readBundledNativeFromApplication() -> Contents/Resources/skills/native, mirroring
//   WebBridge.cpp's getUiDir() for Contents/Resources/ui — NEVER resolved through
//   $MOSH_AGENT_DIR):
//     <resourcesRoot>/index.json                                      -> resourceIndex
//     <resourcesRoot>/<id>@<version>/payload.json                     -> files.payload
//     <resourcesRoot>/<id>@<version>/certification.json               -> files.certification
//     <resourcesRoot>/<id>@<version>/approval.json                    -> files.approval
//     <resourcesRoot>/<id>@<version>/bundle-entry.json                -> files.bundleEntry
//
// Safety admission (POSIX only for now — see the .cpp; Windows fails closed, see below):
//   * the OWNER root ($MOSH_AGENT_DIR) and <agentRoot>/skills/certified must each, if they
//     exist at all: be a real directory (not a symlink, checked with O_NOFOLLOW at EVERY path
//     component, not just the leaf), be owned by the CURRENT uid, and be group/world-UNwritable.
//     A MISSING root or MISSING skills/certified is treated as the benign "nothing installed
//     yet" case (ok:true, zero packages) — only an EXISTING-but-UNSAFE root is a hard failure
//     (ok:false, zero packages, one diagnostic). This split is itself a DESIGN DECISION, chosen
//     to match AgentMemoryStore.h's "a missing file is an empty store, not an error" posture.
//   * every leaf file must be reachable via O_NOFOLLOW (not itself a symlink), a REGULAR file
//     (S_ISREG — this alone rejects a FIFO/socket/device, and the open itself uses O_NONBLOCK
//     so a maliciously-planted FIFO can never hang the loader waiting for a writer), with
//     st_nlink == 1 (rejects a hard link — indistinguishable from "the real file" at the
//     syscall level, so a second name for the same inode is refused same as a symlink), no
//     larger than its type's exact byte cap (checked via fstat BEFORE any read — no unbounded
//     allocation), and valid UTF-8 with no embedded NUL (checked after the read).
//   * an fstat before AND after the read is compared by (device, inode, size) on the SAME open
//     fd to catch a TOCTOU swap mid-read — never re-stat by path.
//   * exactly the four expected leaf names are accepted per package directory — a missing OR
//     an extra entry quarantines the whole package (one bounded diagnostic; the read as a whole
//     still succeeds, the package is simply omitted from `packages`).
//   * package directories are traversed exactly ONE level deep, ASCII-sorted by directory
//     name, capped at 64 admitted packages and 8 MiB of admitted package bytes (mirrors
//     ui/src/agent/skillFoundry/limits.ts's SKILL_LIMITS_V1.maxLoadedLocalSkills /
//     .startupPackageBytes — duplicated BY HAND here; see the .cpp's own note on why there is
//     no shared codegen step across this boundary). Anything beyond either cap is omitted with
//     a diagnostic, never silently dropped without a trace.
//   * the bundled-native resourcesRoot is NOT owner/writability-checked (an installed app
//     bundle is not necessarily owned by the running user — e.g. a system-wide install can be
//     root-owned) but IS symlink/hardlink/regular-file/size/UTF-8 checked exactly like an owner
//     package, and a MISSING/relative resourcesRoot is a hard failure (unlike the owner root):
//     this path is a build-time-staged, compile-known location, not something that legitimately
//     starts out absent on a real install.
//
// Windows: every function below fails closed (ok:false or ok:true-with-zero-packages,
// diagnostic code "platform_unsupported") until a Windows port has an equivalent
// reparse-point-safe, handle-relative admission implementation — same posture as
// src/engine/SessionOwnership.h's own `#if JUCE_WINDOWS` branches. Not exercised by any
// preset this plan's own build commands touch (all macos-arm64-*).
#pragma once

#include <juce_core/juce_core.h>
#include <juce_data_structures/juce_data_structures.h>

namespace mosh
{

struct CertifiedSkillLoader
{
    // ---- owner-local packages ($MOSH_AGENT_DIR) ----

    /** Pure: the agent root for a given override string (empty => the real default,
        ~/Library/Mosh/agent — identical to AgentMemoryStore::resolveGlobalRoot(), a
        SIBLING subtree of the same root, not a competing one). Does NOT itself validate
        absoluteness or safety — an unsafe override is still returned here verbatim;
        read()/readSourceStatus() are what fail it closed on unsafe roots (wrong owner,
        group/world-writable, symlink). NOTE: relativeness specifically canNOT be caught
        this way, because juce::File's constructor (parseAbsolutePath) silently resolves a
        relative string against the process's CWD before this function — or read() — ever
        sees it; by the time a juce::File exists, it is always absolute. That is why
        readFromEnvironment()/readSourceStatusFromEnvironment() check
        juce::File::isAbsolutePath() on the raw environment STRING before constructing a
        juce::File at all — the only seam where a relative override is still observable. */
    static juce::File resolveAgentRoot (const juce::String& overrideDir);

    /** Full owner-package load: activeIndex + sourceStatusIndex + every admitted package
        under <agentRoot>/skills/certified, ASCII-sorted, capped. Returns a
        CertifiedSkillLoadV1-shaped juce::var (see contracts.ts). Root-safety failure =>
        {ok:false, packages:[]}; a missing (never-installed) root/subtree => {ok:true,
        packages:[]}; a single unsafe/oversized/malformed PACKAGE is omitted with a
        diagnostic while safe siblings still load. */
    static juce::var read (const juce::File& agentRoot);

    /** read(resolveAgentRoot($MOSH_AGENT_DIR)). */
    static juce::var readFromEnvironment();

    /** Narrow, cheap re-read of JUST <agentRoot>/skills/source-status.json (the SAME file
        read()'s sourceStatusIndex reads), for a per-invocation staleness check that must
        not re-walk the whole package tree. Returns a SkillSourceStatusReadV1-shaped var. */
    static juce::var readSourceStatus (const juce::File& agentRoot);

    /** readSourceStatus(resolveAgentRoot($MOSH_AGENT_DIR)). */
    static juce::var readSourceStatusFromEnvironment();

    // ---- bundled native packages (app resources; NEVER $MOSH_AGENT_DIR) ----

    /** Full bundled-native-package load: resourceIndex + every admitted package under
        <resourcesRoot>, ASCII-sorted, capped, plus the compiled-in build identity (app
        version, git commit, git state, and the canonical `moshBuildIdentity` string).
        Returns a CertifiedNativeSkillLoadV1-shaped juce::var. A missing/relative
        resourcesRoot is a HARD failure (unlike the owner root — see the header note above). */
    static juce::var readBundledNative (const juce::File& resourcesRoot);

    /** readBundledNative(the app's staged Contents/Resources/skills/native — mirrors
        WebBridge.cpp's getUiDir() resolution for Contents/Resources/ui). */
    static juce::var readBundledNativeFromApplication();
};

} // namespace mosh
