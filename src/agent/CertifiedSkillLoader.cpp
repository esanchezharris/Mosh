#include "CertifiedSkillLoader.h"

#include <juce_cryptography/juce_cryptography.h>

#if ! JUCE_WINDOWS
 #include <array>
 #include <fcntl.h>
 #include <sys/stat.h>
 #include <unistd.h>
 #include <utility>
#endif

namespace mosh
{
namespace
{
    // ---- limits -------------------------------------------------------------------
    // Mirrors ui/src/agent/skillFoundry/limits.ts SKILL_LIMITS_V1. Kept in sync BY HAND:
    // there is no shared codegen step across the TS/C++ boundary in this repo, so a change
    // to one side needs a matching, REVIEWED edit here — it is not caught by the type
    // checker on either side. If you touch SKILL_LIMITS_V1, touch these too.
    constexpr juce::int64 kManifestBytes = 65536;
    constexpr juce::int64 kCertificationBytes = 262144;
    constexpr juce::int64 kApprovalBytes = 16384;
    constexpr juce::int64 kReleaseBytes = 4096;              // also: native bundleEntry cap
    constexpr juce::int64 kActivationIndexBytes = 65536;     // also: native resourceIndex cap
    constexpr juce::int64 kSourceStatusBytes = 262144;
    constexpr int kMaxLoadedLocalSkills = 64;
    constexpr juce::int64 kStartupPackageBytes = 8388608;

    // ---- small JSON-object builders -------------------------------------------------

    juce::var makeDiagnostic (const juce::String& path, const juce::String& code, const juce::String& message)
    {
        auto* o = new juce::DynamicObject();
        o->setProperty ("path", path);
        o->setProperty ("code", code);
        o->setProperty ("message", message);
        return juce::var (o);
    }

    juce::var makeCertifiedSkillLoadResult (bool ok, const juce::var& activeIndex,
                                            const juce::var& sourceStatusIndex,
                                            const juce::Array<juce::var>& packages,
                                            const juce::Array<juce::var>& diagnostics,
                                            juce::int64 totalBytes)
    {
        auto* o = new juce::DynamicObject();
        o->setProperty ("schemaVersion", 1);
        o->setProperty ("ok", ok);
        o->setProperty ("activeIndex", activeIndex);
        o->setProperty ("sourceStatusIndex", sourceStatusIndex);
        o->setProperty ("packages", packages);
        o->setProperty ("diagnostics", diagnostics);
        o->setProperty ("totalBytes", (double) totalBytes);
        return juce::var (o);
    }

    juce::var makeSourceStatusResult (bool ok, const juce::var& statusIndex,
                                      const juce::Array<juce::var>& diagnostics)
    {
        auto* o = new juce::DynamicObject();
        o->setProperty ("schemaVersion", 1);
        o->setProperty ("ok", ok);
        o->setProperty ("statusIndex", statusIndex);
        o->setProperty ("diagnostics", diagnostics);
        return juce::var (o);
    }

    /** The compiled-in build identity (app version, git commit/state, target/configuration/
        architecture folded into ONE canonical string). Every value below is optional at
        compile time — an undefined macro degrades to "unknown" rather than a compile error,
        so this loader still builds correctly in a context (e.g. a future test target) that
        never wires the CMake block that defines them. */
    juce::var buildIdentityVar()
    {
       #if defined (MOSH_VERSION_STRING)
        const juce::String appVersion (MOSH_VERSION_STRING);
       #else
        const juce::String appVersion ("unknown");
       #endif
       #if defined (MOSH_GIT_COMMIT_STRING)
        const juce::String gitCommit (MOSH_GIT_COMMIT_STRING);
       #else
        const juce::String gitCommit ("unknown");
       #endif
       #if defined (MOSH_GIT_STATE_STRING)
        const juce::String gitState (MOSH_GIT_STATE_STRING);
       #else
        const juce::String gitState ("unknown");
       #endif
       #if defined (MOSH_BUILD_CONFIGURATION_STRING)
        const juce::String configuration (MOSH_BUILD_CONFIGURATION_STRING);
       #else
        const juce::String configuration ("unknown");
       #endif
       #if defined (MOSH_BUILD_ARCHITECTURE_STRING)
        const juce::String architecture (MOSH_BUILD_ARCHITECTURE_STRING);
       #else
        const juce::String architecture ("unknown");
       #endif

        // Exact accepted shape per Task 3's nativeIdentity.ts:
        //   git=<40-lower-hex>|version=<SemVer>|target=Mosh|configuration=Release|architecture=arm64
        const auto identity = juce::String ("git=") + gitCommit + "|version=" + appVersion
            + "|target=Mosh|configuration=" + configuration + "|architecture=" + architecture;

        auto* o = new juce::DynamicObject();
        o->setProperty ("appVersion", appVersion);
        o->setProperty ("gitCommit", gitCommit);
        o->setProperty ("gitState", gitState);
        o->setProperty ("moshBuildIdentity", identity);
        return juce::var (o);
    }

    juce::var makeNativeLoadResult (bool ok, const juce::var& resourceIndex,
                                    const juce::Array<juce::var>& packages,
                                    const juce::Array<juce::var>& diagnostics,
                                    juce::int64 totalBytes)
    {
        auto* o = new juce::DynamicObject();
        o->setProperty ("schemaVersion", 1);
        o->setProperty ("ok", ok);
        o->setProperty ("build", buildIdentityVar());
        o->setProperty ("resourceIndex", resourceIndex);
        o->setProperty ("packages", packages);
        o->setProperty ("diagnostics", diagnostics);
        o->setProperty ("totalBytes", (double) totalBytes);
        return juce::var (o);
    }

    /** One (name, byte cap, JSON key) triple for a package's four expected leaf files.
        The SAME shape serves owner packages (skill/certification/approval/release) and
        native packages (payload/certification/approval/bundleEntry) — only the table
        passed to readPackagesTree() differs. */
    struct LeafSpec
    {
        const char* fileName;
        juce::int64 byteCap;
        const char* jsonKey;
    };

#if ! JUCE_WINDOWS
    // ---- POSIX admission primitives --------------------------------------------------

    /** Manual UTF-8 validity check (deliberately no external dependency): every byte
        sequence must be a MINIMAL, non-overlong encoding of a scalar <= U+10FFFF, excluding
        the surrogate range. Additionally rejects any embedded NUL byte: a NUL is technically
        valid UTF-8 for U+0000, but every artifact this loader reads is JSON text (an
        embedded NUL can never appear in valid JSON), and juce::var/juce::JSON round-trip
        badly through embedded NULs — so this loader treats one as a hard rejection up front,
        before any JSON parsing (which is TypeScript's job, not this loader's). Kept INSIDE
        this platform guard because it is currently only called from the POSIX read path —
        Windows fails every read closed before ever reaching a byte-content check. */
    bool isStrictUtf8NoNul (const void* data, size_t size)
    {
        const auto* bytes = static_cast<const unsigned char*> (data);
        size_t i = 0;
        while (i < size)
        {
            const unsigned char b0 = bytes[i];
            if (b0 == 0x00)
                return false;
            if (b0 < 0x80) { ++i; continue; }

            size_t extra = 0;
            unsigned int minCodepoint = 0;
            unsigned int codepoint = 0;
            if ((b0 & 0xE0) == 0xC0)      { extra = 1; minCodepoint = 0x80;    codepoint = b0 & 0x1F; }
            else if ((b0 & 0xF0) == 0xE0) { extra = 2; minCodepoint = 0x800;   codepoint = b0 & 0x0F; }
            else if ((b0 & 0xF8) == 0xF0) { extra = 3; minCodepoint = 0x10000; codepoint = b0 & 0x07; }
            else return false;

            if (i + extra >= size)
                return false;
            for (size_t k = 1; k <= extra; ++k)
            {
                const unsigned char b = bytes[i + k];
                if ((b & 0xC0) != 0x80)
                    return false;
                codepoint = (codepoint << 6) | (b & 0x3F);
            }
            if (codepoint < minCodepoint) return false;                     // overlong encoding
            if (codepoint > 0x10FFFFu) return false;                        // out of Unicode range
            if (codepoint >= 0xD800u && codepoint <= 0xDFFFu) return false; // surrogate half
            i += extra + 1;
        }
        return true;
    }

    /** Minimal RAII fd wrapper, LOCAL to this file on purpose: CertifiedSkillLoader is its
        own self-contained, engine-free admission path (see the header), so it does not
        reach into src/engine/SessionOwnershipPosix.h even though that file's OwnedFd would
        serve just as well — a deliberate non-dependency, not an oversight. */
    class OwnedFd
    {
    public:
        OwnedFd() = default;
        explicit OwnedFd (int descriptor) : fd (descriptor) {}
        ~OwnedFd() { reset(); }

        OwnedFd (OwnedFd&& other) noexcept : fd (other.releaseInternal()) {}
        OwnedFd& operator= (OwnedFd&& other) noexcept
        {
            if (this != &other) { reset(); fd = other.releaseInternal(); }
            return *this;
        }
        OwnedFd (const OwnedFd&) = delete;
        OwnedFd& operator= (const OwnedFd&) = delete;

        explicit operator bool() const { return fd >= 0; }
        int get() const { return fd; }

        /** Relinquishes ownership WITHOUT closing — for handing the descriptor to an API
            that takes ownership itself (this file has no such use today, kept for parity
            with the pattern; every close happens through this object's own destructor). */
        int release() { return releaseInternal(); }

    private:
        int releaseInternal() { const auto r = fd; fd = -1; return r; }
        void reset() { if (fd >= 0) ::close (fd); fd = -1; }
        int fd = -1;
    };

    bool fstatOk (int fd, struct stat& out) { return ::fstat (fd, &out) == 0; }
    bool isSafeDirectoryStat (const struct stat& st) { return S_ISDIR (st.st_mode); }
    bool ownedByCurrentUser (const struct stat& st) { return st.st_uid == ::geteuid(); }
    bool isGroupOrWorldWritable (const struct stat& st) { return (st.st_mode & (S_IWGRP | S_IWOTH)) != 0; }
    bool sameIdentity (const struct stat& a, const struct stat& b)
    {
        return a.st_dev == b.st_dev && a.st_ino == b.st_ino;
    }

    /** Opens ONE path component below @p parentFd, following NO symlink at that component. */
    OwnedFd openChildDir (int parentFd, const juce::String& name)
    {
        return OwnedFd (::openat (parentFd, name.toRawUTF8(),
                                  O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
    }

    /** Opens an ABSOLUTE directory path one component at a time from "/", refusing to
        follow a symlink at ANY level (root, an intermediate ancestor, or the leaf) and
        refusing any ".." component outright (fail closed rather than resolve it) — a
        LOCAL reimplementation of the same idea as
        src/engine/SessionOwnershipPosix.h::openAbsoluteDirectory(), see the class comment
        above for why this file does not simply reuse that one. */
    OwnedFd openAbsoluteDir (const juce::File& directory)
    {
        const auto full = directory.getFullPathName();
        if (! juce::File::isAbsolutePath (full))
            return {};

        OwnedFd current (::open ("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC));
        if (! current)
            return {};

        juce::StringArray parts;
        parts.addTokens (full, "/", "");
        for (auto& part : parts)
        {
            if (part.isEmpty() || part == ".") continue;
            if (part == "..") return {};   // fail closed — never resolve a ".." component
            auto next = openChildDir (current.get(), part);
            if (! next) return {};
            current = std::move (next);
        }
        return current;
    }

    struct LeafReadResult
    {
        bool ok = false;
        juce::var fileVar;          // a CertifiedSkillFileV1-shaped var, valid iff ok
        juce::String failCode;      // set iff !ok
        juce::String failMessage;   // set iff !ok
    };

    /** Safely reads ONE leaf file below @p parentDirFd: O_NOFOLLOW + O_NONBLOCK open (the
        NONBLOCK matters — without it, opening a maliciously-planted FIFO for read blocks
        forever waiting for a writer that will never arrive; a regular file is unaffected by
        the flag), regular-file + link-count-one check, a byte-cap check via fstat BEFORE any
        read, an exact read, a before/after identity+size recheck on the SAME fd (TOCTOU),
        and a strict UTF-8/no-NUL check on the bytes actually read. */
    LeafReadResult readGuardedLeafFile (int parentDirFd, const juce::String& name, juce::int64 byteCap)
    {
        LeafReadResult result;

        OwnedFd fd (::openat (parentDirFd, name.toRawUTF8(),
                              O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK));
        if (! fd)
        {
            result.failCode = "missing";
            result.failMessage = "not present, or is itself a symlink";
            return result;
        }

        struct stat before {};
        if (! fstatOk (fd.get(), before) || ! S_ISREG (before.st_mode))
        {
            result.failCode = "not_regular_file";
            result.failMessage = "not a plain regular file (e.g. a FIFO, socket, or device)";
            return result;
        }
        if (before.st_nlink != 1)
        {
            result.failCode = "hard_linked";
            result.failMessage = "has more than one directory entry (hard link)";
            return result;
        }
        if (before.st_size < 0 || (juce::int64) before.st_size > byteCap)
        {
            result.failCode = "too_large";
            result.failMessage = "exceeds its type's byte cap";
            return result;
        }

        const auto sizeToRead = (size_t) before.st_size;
        juce::MemoryBlock mb (sizeToRead, false);
        size_t readSoFar = 0;
        auto* buf = static_cast<char*> (mb.getData());
        while (readSoFar < sizeToRead)
        {
            const auto n = ::read (fd.get(), buf + readSoFar, sizeToRead - readSoFar);
            if (n <= 0)
            {
                result.failCode = "read_failed";
                result.failMessage = "short or failed read";
                return result;
            }
            readSoFar += (size_t) n;
        }

        struct stat after {};
        if (! fstatOk (fd.get(), after) || ! sameIdentity (before, after) || after.st_size != before.st_size)
        {
            result.failCode = "toctou";
            result.failMessage = "identity or size changed while reading";
            return result;
        }

        if (! isStrictUtf8NoNul (mb.getData(), mb.getSize()))
        {
            result.failCode = "invalid_utf8";
            result.failMessage = "not strict UTF-8, or contains an embedded NUL byte";
            return result;
        }

        const auto utf8 = juce::String::fromUTF8 (static_cast<const char*> (mb.getData()), (int) mb.getSize());

        auto* o = new juce::DynamicObject();
        o->setProperty ("name", name);
        o->setProperty ("bytes", (double) mb.getSize());
        o->setProperty ("sha256", juce::SHA256 (mb.getData(), mb.getSize()).toHexString());
        o->setProperty ("utf8", utf8);

        result.ok = true;
        result.fileVar = juce::var (o);
        return result;
    }

    /** Splits an "id@version" directory name into its two halves. Rejects a missing/leading/
        trailing '@', an empty half, or a SECOND '@' inside the version half (two different
        splits would disagree about the id, so refuse rather than pick one). A directory
        ENTRY name can never contain '/' at the syscall level — readdir() (used indirectly via
        the enumeration below) simply cannot return one — so there is no separate "contains a
        path separator" check to perform here. */
    bool splitIdVersion (const juce::String& directoryName, juce::String& id, juce::String& version)
    {
        const auto at = directoryName.indexOfChar ('@');
        if (at <= 0 || at >= directoryName.length() - 1)
            return false;
        id = directoryName.substring (0, at);
        version = directoryName.substring (at + 1);
        return ! version.containsChar ('@');
    }

    struct PackageReadResult
    {
        bool ok = false;
        juce::var packageVar;           // valid iff ok
        juce::int64 totalBytes = 0;
        juce::String diagnosticCode;    // set iff !ok
        juce::String diagnosticMessage; // set iff !ok
    };

    /** Reads ONE package directory: verifies it is a plain (non-symlink) directory, verifies
        it contains EXACTLY the four expected leaf names (an extra OR a missing entry
        quarantines the whole package — enumerated via a plain, non-security-critical
        juce::RangedDirectoryIterator over @p packageDirForEnumeration; every ACTUAL read
        below still goes through the O_NOFOLLOW-guarded fd path, so a TOCTOU between
        enumeration and read can at worst cause a spurious quarantine, never an unsafe read),
        then safely reads each of the four via @p certifiedFd (a directory fd already proven
        safe by the caller). */
    PackageReadResult readPackageDirectory (int certifiedFd, const juce::File& packageDirForEnumeration,
                                            const juce::String& directoryName,
                                            const std::array<LeafSpec, 4>& leafSpecs)
    {
        PackageReadResult result;

        juce::String id, version;
        if (! splitIdVersion (directoryName, id, version))
        {
            result.diagnosticCode = "invalid_directory_name";
            result.diagnosticMessage = "not a valid <id>@<version> directory name";
            return result;
        }

        OwnedFd dirFd (::openat (certifiedFd, directoryName.toRawUTF8(),
                                 O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
        struct stat dirStat {};
        if (! dirFd || ! fstatOk (dirFd.get(), dirStat) || ! isSafeDirectoryStat (dirStat))
        {
            result.diagnosticCode = "unsafe_package_directory";
            result.diagnosticMessage = "not a plain directory (or is a symlink)";
            return result;
        }

        // Enumeration-only pass (see the function comment): count EVERYTHING (including
        // dotfiles — a stray .DS_Store is treated the same as any other unexpected entry,
        // a deliberately strict default for a security-sensitive extension point).
        juce::StringArray seenNames;
        for (const auto& entry : juce::RangedDirectoryIterator (
                 packageDirForEnumeration, false, "*", juce::File::findFilesAndDirectories))
            seenNames.add (entry.getFile().getFileName());

        if (seenNames.size() != 4)
        {
            result.diagnosticCode = "unexpected_entry_count";
            result.diagnosticMessage = "package directory does not contain exactly 4 entries";
            return result;
        }
        for (const auto& spec : leafSpecs)
            if (! seenNames.contains (juce::String (spec.fileName)))
            {
                result.diagnosticCode = "missing_file";
                result.diagnosticMessage = juce::String ("missing ") + spec.fileName;
                return result;
            }

        auto* pkg = new juce::DynamicObject();
        pkg->setProperty ("directoryName", directoryName);
        pkg->setProperty ("skillIdFromDirectory", id);
        pkg->setProperty ("versionFromDirectory", version);
        auto* files = new juce::DynamicObject();
        juce::int64 totalBytes = 0;
        for (const auto& spec : leafSpecs)
        {
            auto leaf = readGuardedLeafFile (dirFd.get(), spec.fileName, spec.byteCap);
            if (! leaf.ok)
            {
                result.diagnosticCode = leaf.failCode;
                result.diagnosticMessage = juce::String (spec.fileName) + ": " + leaf.failMessage;
                return result;
            }
            files->setProperty (spec.jsonKey, leaf.fileVar);
            totalBytes += (juce::int64) leaf.fileVar.getProperty ("bytes", 0);
        }
        pkg->setProperty ("files", juce::var (files));

        result.ok = true;
        result.packageVar = juce::var (pkg);
        result.totalBytes = totalBytes;
        return result;
    }

    struct TreeReadResult
    {
        juce::Array<juce::var> packages;
        juce::Array<juce::var> diagnostics;
        juce::int64 totalBytes = 0;
    };

    /** Enumerates package directories ONE level deep under @p packagesRoot (ASCII-sorted,
        excluding the known sibling index files), then admits each in order up to the
        package-count and total-byte caps. @p packagesFd is the ALREADY-SAFETY-CHECKED
        directory fd (root symlink/owner/writability checks already passed by the caller);
        @p packagesRoot is the same directory as a plain juce::File, used ONLY for
        enumeration (see readPackageDirectory's comment on why that split is safe). */
    TreeReadResult readPackagesTree (int packagesFd, const juce::File& packagesRoot,
                                     const std::array<LeafSpec, 4>& leafSpecs,
                                     const juce::String& diagnosticPathPrefix,
                                     const juce::StringArray& siblingIndexNames)
    {
        TreeReadResult tree;

        juce::StringArray directoryNames;
        for (const auto& entry : juce::RangedDirectoryIterator (
                 packagesRoot, false, "*", juce::File::findDirectories))
        {
            const auto name = entry.getFile().getFileName();
            if (! siblingIndexNames.contains (name))
                directoryNames.add (name);
        }
        directoryNames.sort (false);   // ASCII, case-sensitive — deterministic admission order

        for (const auto& name : directoryNames)
        {
            if (tree.packages.size() >= kMaxLoadedLocalSkills)
            {
                tree.diagnostics.add (makeDiagnostic (diagnosticPathPrefix + "/" + name, "capacity_exceeded",
                    "package count cap reached; this and remaining entries were not read"));
                continue;
            }

            auto pkg = readPackageDirectory (packagesFd, packagesRoot.getChildFile (name), name, leafSpecs);
            if (! pkg.ok)
            {
                tree.diagnostics.add (makeDiagnostic (diagnosticPathPrefix + "/" + name,
                    pkg.diagnosticCode, pkg.diagnosticMessage));
                continue;
            }
            if (tree.totalBytes + pkg.totalBytes > kStartupPackageBytes)
            {
                tree.diagnostics.add (makeDiagnostic (diagnosticPathPrefix + "/" + name, "capacity_exceeded",
                    "startup package byte cap reached; this package was not admitted"));
                continue;
            }

            tree.packages.add (pkg.packageVar);
            tree.totalBytes += pkg.totalBytes;
        }

        return tree;
    }

    /** Reads <skillsFd>/source-status.json (shared by read()'s sourceStatusIndex and
        readSourceStatus()'s statusIndex — see the header note on why these are the same
        file under two envelopes). A missing file is silent (not a diagnostic — the common
        "no source-bound skills yet" case); any other failure adds a bounded diagnostic. */
    juce::var readSourceStatusFile (int skillsFd, const juce::String& diagnosticPath,
                                    juce::Array<juce::var>& diagnostics)
    {
        auto leaf = readGuardedLeafFile (skillsFd, "source-status.json", kSourceStatusBytes);
        if (leaf.ok)
            return leaf.fileVar;
        if (leaf.failCode != "missing")
            diagnostics.add (makeDiagnostic (diagnosticPath, leaf.failCode, leaf.failMessage));
        return juce::var();
    }

    /** True iff @p directory, as an ALREADY-OPENED fd, is a plain (non-symlink) directory,
        owned by the current user, and neither group- nor world-writable. Used for BOTH
        $MOSH_AGENT_DIR and <agentRoot>/skills/certified — the two owner-root checkpoints
        the header describes. */
    bool isSafeOwnedRootFd (const OwnedFd& fd)
    {
        struct stat st {};
        return (bool) fd && fstatOk (fd.get(), st) && isSafeDirectoryStat (st)
            && ownedByCurrentUser (st) && ! isGroupOrWorldWritable (st);
    }

    const std::array<LeafSpec, 4>& ownerLeafSpecs()
    {
        static const std::array<LeafSpec, 4> specs { {
            { "skill.json",         kManifestBytes,      "skill" },
            { "certification.json", kCertificationBytes, "certification" },
            { "approval.json",      kApprovalBytes,      "approval" },
            { "release.json",       kReleaseBytes,        "release" },
        } };
        return specs;
    }

    const std::array<LeafSpec, 4>& nativeLeafSpecs()
    {
        static const std::array<LeafSpec, 4> specs { {
            { "payload.json",       kManifestBytes,      "payload" },
            { "certification.json", kCertificationBytes, "certification" },
            { "approval.json",      kApprovalBytes,      "approval" },
            { "bundle-entry.json",  kReleaseBytes,        "bundleEntry" },
        } };
        return specs;
    }
#endif // ! JUCE_WINDOWS

    /** Mirrors WebBridge.cpp's getUiDir(): staged bundle resources -> exe-dir fallback. No
        env override (unlike getUiDir()'s MOSH_UI_DIR) — bundled native skills are never
        meant to be dev-server-swapped, only built and staged. */
    const juce::File& nativeSkillsResourcesDir()
    {
        static const auto dir = []
        {
            auto appFile = juce::File::getSpecialLocation (juce::File::currentApplicationFile);
            auto bundled = appFile.getChildFile ("Contents/Resources/skills/native");
            if (bundled.isDirectory())
                return bundled;

            auto exeDir = juce::File::getSpecialLocation (juce::File::currentExecutableFile)
                              .getParentDirectory();
            return exeDir.getChildFile ("skills").getChildFile ("native");
        }();
        return dir;
    }
} // namespace

juce::File CertifiedSkillLoader::resolveAgentRoot (const juce::String& overrideDir)
{
    if (overrideDir.isNotEmpty())
        return juce::File (overrideDir);
    return juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory)
               .getChildFile ("Mosh").getChildFile ("agent");
}

juce::var CertifiedSkillLoader::read (const juce::File& agentRoot)
{
   #if JUCE_WINDOWS
    juce::Array<juce::var> diagnostics;
    diagnostics.add (makeDiagnostic (agentRoot.getFullPathName(), "platform_unsupported",
        "CertifiedSkillLoader has no Windows admission path yet"));
    return makeCertifiedSkillLoadResult (false, {}, {}, {}, diagnostics, 0);
   #else
    juce::Array<juce::var> diagnostics;
    const auto rootPath = agentRoot.getFullPathName();

    if (! juce::File::isAbsolutePath (rootPath))
    {
        diagnostics.add (makeDiagnostic (rootPath, "root_not_absolute",
            "$MOSH_AGENT_DIR override must be an absolute path"));
        return makeCertifiedSkillLoadResult (false, {}, {}, {}, diagnostics, 0);
    }

    if (agentRoot.isSymbolicLink())
    {
        diagnostics.add (makeDiagnostic (rootPath, "unsafe_root", "$MOSH_AGENT_DIR is a symlink"));
        return makeCertifiedSkillLoadResult (false, {}, {}, {}, diagnostics, 0);
    }
    if (! agentRoot.exists())
        return makeCertifiedSkillLoadResult (true, {}, {}, {}, diagnostics, 0);   // never installed — benign

    auto rootFd = openAbsoluteDir (agentRoot);
    if (! isSafeOwnedRootFd (rootFd))
    {
        diagnostics.add (makeDiagnostic (rootPath, "unsafe_root",
            "$MOSH_AGENT_DIR is not a plain, owner-only directory (wrong owner, or group/world-writable)"));
        return makeCertifiedSkillLoadResult (false, {}, {}, {}, diagnostics, 0);
    }

    const auto skillsDir = agentRoot.getChildFile ("skills");
    auto skillsFd = openChildDir (rootFd.get(), "skills");
    if (! skillsFd)
        return makeCertifiedSkillLoadResult (true, {}, {}, {}, diagnostics, 0);   // no "skills" dir yet — benign

    const auto sourceStatusIndex = readSourceStatusFile (skillsFd.get(),
        rootPath + "/skills/source-status.json", diagnostics);

    // Symlink-ness must be checked BEFORE "does it exist" (a dangling symlink still
    // needs to be REJECTED, not treated as benignly-missing — see the analogous
    // agentRoot check above) and BEFORE the O_NOFOLLOW open below: an O_NOFOLLOW
    // failure on its own cannot distinguish "certified is a symlink" from "certified
    // does not exist at all", and those two cases have OPPOSITE outcomes here.
    const auto certifiedDir = skillsDir.getChildFile ("certified");
    if (certifiedDir.isSymbolicLink())
    {
        diagnostics.add (makeDiagnostic (rootPath + "/skills/certified", "unsafe_root",
            "skills/certified is a symlink"));
        return makeCertifiedSkillLoadResult (false, {}, {}, {}, diagnostics, 0);
    }
    if (! certifiedDir.exists())
        return makeCertifiedSkillLoadResult (true, {}, sourceStatusIndex, {}, diagnostics, 0);   // benign

    auto certifiedFd = openChildDir (skillsFd.get(), "certified");
    if (! isSafeOwnedRootFd (certifiedFd))
    {
        diagnostics.add (makeDiagnostic (rootPath + "/skills/certified", "unsafe_root",
            "skills/certified is not a plain, owner-only directory (wrong owner, or group/world-writable)"));
        return makeCertifiedSkillLoadResult (false, {}, {}, {}, diagnostics, 0);
    }

    auto activeLeaf = readGuardedLeafFile (certifiedFd.get(), "active.json", kActivationIndexBytes);
    juce::var activeIndex;
    if (activeLeaf.ok)
        activeIndex = activeLeaf.fileVar;
    else if (activeLeaf.failCode != "missing")
        diagnostics.add (makeDiagnostic (rootPath + "/skills/certified/active.json",
            activeLeaf.failCode, activeLeaf.failMessage));

    static const juce::StringArray siblingIndexNames { "active.json" };
    auto tree = readPackagesTree (certifiedFd.get(), certifiedDir, ownerLeafSpecs(),
                                  rootPath + "/skills/certified", siblingIndexNames);
    for (auto& d : tree.diagnostics) diagnostics.add (d);

    return makeCertifiedSkillLoadResult (true, activeIndex, sourceStatusIndex, tree.packages,
                                         diagnostics, tree.totalBytes);
   #endif
}

juce::var CertifiedSkillLoader::readFromEnvironment()
{
    const auto overrideDir = juce::SystemStats::getEnvironmentVariable ("MOSH_AGENT_DIR", {}).trim();
    return read (resolveAgentRoot (overrideDir));
}

juce::var CertifiedSkillLoader::readSourceStatus (const juce::File& agentRoot)
{
   #if JUCE_WINDOWS
    juce::Array<juce::var> diagnostics;
    diagnostics.add (makeDiagnostic (agentRoot.getFullPathName(), "platform_unsupported",
        "CertifiedSkillLoader has no Windows admission path yet"));
    return makeSourceStatusResult (false, {}, diagnostics);
   #else
    juce::Array<juce::var> diagnostics;
    const auto rootPath = agentRoot.getFullPathName();

    if (! juce::File::isAbsolutePath (rootPath))
    {
        diagnostics.add (makeDiagnostic (rootPath, "root_not_absolute",
            "$MOSH_AGENT_DIR override must be an absolute path"));
        return makeSourceStatusResult (false, {}, diagnostics);
    }
    if (agentRoot.isSymbolicLink())
    {
        diagnostics.add (makeDiagnostic (rootPath, "unsafe_root", "$MOSH_AGENT_DIR is a symlink"));
        return makeSourceStatusResult (false, {}, diagnostics);
    }
    if (! agentRoot.exists())
        return makeSourceStatusResult (true, {}, diagnostics);

    auto rootFd = openAbsoluteDir (agentRoot);
    if (! isSafeOwnedRootFd (rootFd))
    {
        diagnostics.add (makeDiagnostic (rootPath, "unsafe_root",
            "$MOSH_AGENT_DIR is not a plain, owner-only directory (wrong owner, or group/world-writable)"));
        return makeSourceStatusResult (false, {}, diagnostics);
    }

    auto skillsFd = openChildDir (rootFd.get(), "skills");
    if (! skillsFd)
        return makeSourceStatusResult (true, {}, diagnostics);

    const auto statusIndex = readSourceStatusFile (skillsFd.get(),
        rootPath + "/skills/source-status.json", diagnostics);
    return makeSourceStatusResult (true, statusIndex, diagnostics);
   #endif
}

juce::var CertifiedSkillLoader::readSourceStatusFromEnvironment()
{
    const auto overrideDir = juce::SystemStats::getEnvironmentVariable ("MOSH_AGENT_DIR", {}).trim();
    return readSourceStatus (resolveAgentRoot (overrideDir));
}

juce::var CertifiedSkillLoader::readBundledNative (const juce::File& resourcesRoot)
{
   #if JUCE_WINDOWS
    juce::Array<juce::var> diagnostics;
    diagnostics.add (makeDiagnostic (resourcesRoot.getFullPathName(), "platform_unsupported",
        "CertifiedSkillLoader has no Windows admission path yet"));
    return makeNativeLoadResult (false, {}, {}, diagnostics, 0);
   #else
    juce::Array<juce::var> diagnostics;
    const auto rootPath = resourcesRoot.getFullPathName();

    // Unlike the owner root, a missing/relative/symlinked bundled-resources root is a HARD
    // failure: this path is build-time-staged and compile-known, not something that
    // legitimately starts out absent on a real install (see the header note).
    if (! juce::File::isAbsolutePath (rootPath) || resourcesRoot.isSymbolicLink() || ! resourcesRoot.isDirectory())
    {
        diagnostics.add (makeDiagnostic (rootPath, "root_unreachable",
            "bundled native-skill resources root is missing, relative, a symlink, or not a directory"));
        return makeNativeLoadResult (false, {}, {}, diagnostics, 0);
    }

    // NOTE: no owner/writability check here — see the header's rationale.
    auto rootFd = openAbsoluteDir (resourcesRoot);
    struct stat rootStat {};
    if (! rootFd || ! fstatOk (rootFd.get(), rootStat) || ! isSafeDirectoryStat (rootStat))
    {
        diagnostics.add (makeDiagnostic (rootPath, "unsafe_root",
            "bundled native-skill resources root is not a plain directory"));
        return makeNativeLoadResult (false, {}, {}, diagnostics, 0);
    }

    auto indexLeaf = readGuardedLeafFile (rootFd.get(), "index.json", kActivationIndexBytes);
    if (! indexLeaf.ok)
    {
        // No index -> zero registration (Task 9: "zero registration when the index is
        // absent or invalid"), but the ROOT itself was safely read, so this is still
        // ok:true — it simply has nothing published in it yet.
        if (indexLeaf.failCode != "missing")
            diagnostics.add (makeDiagnostic (rootPath + "/index.json", indexLeaf.failCode, indexLeaf.failMessage));
        return makeNativeLoadResult (true, {}, {}, diagnostics, 0);
    }

    static const juce::StringArray siblingIndexNames { "index.json" };
    auto tree = readPackagesTree (rootFd.get(), resourcesRoot, nativeLeafSpecs(), rootPath, siblingIndexNames);
    for (auto& d : tree.diagnostics) diagnostics.add (d);

    return makeNativeLoadResult (true, indexLeaf.fileVar, tree.packages, diagnostics, tree.totalBytes);
   #endif
}

juce::var CertifiedSkillLoader::readBundledNativeFromApplication()
{
    return readBundledNative (nativeSkillsResourcesDir());
}

} // namespace mosh
