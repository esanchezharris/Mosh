#include <catch2/catch_test_macros.hpp>
#include "state/ProjectName.h"

#include <set>
#include <string>

using namespace mosh::projectname;

// PRJ-NAME — the generated default project name and the project file extension.
//
// generateName is pure and deterministic in its seed precisely so these properties are
// directly assertable. Every REQUIRE below was RED-proven against a deliberately broken
// word list (a duplicate entry, an entry containing a space, an entry with a capital)
// and against a generateName that dropped the prefix — each failed the intended check
// and only that check.

TEST_CASE ("generateName is untitled-prefixed and seed-deterministic", "[projectname]")
{
    // Shape: the "still unnamed" marker plus exactly one word from the list.
    const auto n = generateName (0);
    REQUIRE (n.startsWith (kUntitledPrefix));
    REQUIRE (n == juce::String (kUntitledPrefix) + words()[0]);

    // Deterministic: same seed ⇒ same name, every time. This is what lets the caller own
    // the randomness (and what lets a collision re-roll be a plain loop).
    REQUIRE (generateName (12345) == generateName (12345));

    // The seed indexes the list modulo its size, so it wraps rather than reading OOB.
    const auto size = (juce::uint32) words().size();
    REQUIRE (generateName (size) == generateName (0));
    REQUIRE (generateName (size * 7 + 3) == generateName (3));
}

TEST_CASE ("consecutive seeds walk distinct words across the whole list", "[projectname]")
{
    // Not just "two seeds differ" — every seed in one full cycle must yield a DISTINCT
    // name. A duplicate anywhere in the word list breaks this, which is the point: a dup
    // silently halves that word's odds and makes the distinctness guarantee a lie.
    std::set<std::string> seen;
    const auto size = (juce::uint32) words().size();
    for (juce::uint32 s = 0; s < size; ++s)
        seen.insert (generateName (s).toStdString());

    REQUIRE (seen.size() == (size_t) size);
}

TEST_CASE ("the word list meets its stated constraints", "[projectname]")
{
    const auto& w = words();

    // Size floor. The name space has to be big enough that a re-roll on collision
    // usually succeeds on the first try; well under 100 it would collide constantly.
    REQUIRE (w.size() >= 100);

    std::set<std::string> unique;
    for (auto* raw : w)
    {
        const std::string word (raw);
        INFO ("word: " << word);

        // One word, no separators — the " - " between prefix and word stays unambiguous.
        REQUIRE (! word.empty());
        REQUIRE (word.find (' ') == std::string::npos);
        REQUIRE (word.find ('-') == std::string::npos);

        // Lowercase ASCII letters only ⇒ createLegalFileName is a no-op (asserted below).
        for (char c : word)
            REQUIRE ((c >= 'a' && c <= 'z'));

        unique.insert (word);
    }

    REQUIRE (unique.size() == w.size());   // no duplicates
}

TEST_CASE ("every generated name survives createLegalFileName unchanged", "[projectname]")
{
    // The generated name is passed straight to File::createLegalFileName in
    // cmdNewProject. If any word (or the prefix's spaces/hyphen) were rewritten there,
    // the name shown in the UI and the name on disk would silently diverge.
    const auto size = (juce::uint32) words().size();
    for (juce::uint32 s = 0; s < size; ++s)
    {
        const auto n = generateName (s);
        INFO ("name: " << n);
        REQUIRE (juce::File::createLegalFileName (n) == n);
    }
}

TEST_CASE ("the project extensions are the expected literals", "[projectname]")
{
    // No leading dot — these feed juce::File::withFileExtension and the snapshot's
    // session.projectExtension, both of which expect the bare form.
    REQUIRE (juce::String (kProjectExtension) == "mosh");
    REQUIRE (juce::String (kLegacyProjectExtension) == "tracktionedit");
    REQUIRE (juce::String (kProjectExtension).startsWithChar ('.') == false);
    REQUIRE (juce::String (kLegacyProjectExtension).startsWithChar ('.') == false);

    // The round-trip that actually matters at the call sites.
    REQUIRE (juce::File ("/tmp/song").withFileExtension (kProjectExtension).getFileName()
             == "song.mosh");
}

// ── projectPathFromOpenArgs — double-click / open-file argument parsing ──────────
//
// The same JUCE entry point (anotherInstanceStarted) sees BOTH a double-clicked .mosh
// and this app's own CLI, so "take the first token" would happily try to open
// "--selftest" as a project.
//
// RED-proven: dropping the existsAsFile guard, the isProjectFile guard, the quote-aware
// tokenizer, or the legacy extension each fails exactly one case below. The
// absolute-path guard needed a test built for it specifically — a bare "--selftest" is
// already rejected by the extension and existence checks, so an earlier version of this
// file "covered" that guard with assertions that passed with it deleted.

namespace
{
    // A real temp file, because the parser deliberately requires the path to exist —
    // a stale path from a deleted project must NOT resolve.
    struct TempProject
    {
        explicit TempProject (const juce::String& name)
            : file (juce::File::getSpecialLocation (juce::File::tempDirectory)
                        .getChildFile ("mosh-projectname-test")
                        .getChildFile (name))
        {
            file.getParentDirectory().createDirectory();
            file.replaceWithText ("<EDIT/>");
        }
        ~TempProject() { file.deleteFile(); }
        juce::File file;
    };
}

TEST_CASE ("projectPathFromOpenArgs finds a real project among launch args", "[projectname]")
{
    TempProject p ("untitled - bearcat.mosh");
    const auto path = p.file.getFullPathName();

    // Bare, and quoted — a generated name always contains spaces, so the quoted form is
    // the one that actually arrives from Finder.
    REQUIRE (projectPathFromOpenArgs (path) == path);
    REQUIRE (projectPathFromOpenArgs ("\"" + path + "\"") == path);

    // Legacy projects open by double-click too.
    TempProject legacy ("old song.tracktionedit");
    REQUIRE (projectPathFromOpenArgs ("\"" + legacy.file.getFullPathName() + "\"")
             == legacy.file.getFullPathName());
}

TEST_CASE ("projectPathFromOpenArgs ignores this app's own CLI", "[projectname]")
{
    // The headless/harness modes must never be mistaken for a path to open.
    REQUIRE (projectPathFromOpenArgs ("--selftest").isEmpty());
    REQUIRE (projectPathFromOpenArgs ("--selftest-undo --golden-selftest").isEmpty());
    REQUIRE (projectPathFromOpenArgs ("--run-script /tmp/script.json").isEmpty());
    REQUIRE (projectPathFromOpenArgs ("").isEmpty());

    // A flag that merely LOOKS like a project is still a flag.
    REQUIRE (projectPathFromOpenArgs ("--open=thing.mosh").isEmpty());
}

TEST_CASE ("projectPathFromOpenArgs requires an ABSOLUTE path", "[projectname]")
{
    // This case exists to make the absolute-path guard falsifiable. Every other
    // non-path argument is ALSO rejected by the extension/existence checks, so those
    // assertions pass whether or not the guard is there. Here the file genuinely exists
    // and genuinely is a .mosh — the ONLY thing standing between the relative token and
    // a match is the guard. A relative path must be refused rather than resolved
    // against whatever the process's working directory happens to be (and juce::File's
    // ctor jassert-fails on one in a Debug build).
    const auto cwd = juce::File::getCurrentWorkingDirectory();
    const juce::File relTarget = cwd.getChildFile ("mosh-relpath-probe.mosh");
    relTarget.replaceWithText ("<EDIT/>");

    REQUIRE (relTarget.existsAsFile());                                   // the file is real…
    REQUIRE (projectPathFromOpenArgs (relTarget.getFullPathName())        // …absolute resolves…
             == relTarget.getFullPathName());
    REQUIRE (projectPathFromOpenArgs ("mosh-relpath-probe.mosh").isEmpty());       // …relative does not
    REQUIRE (projectPathFromOpenArgs ("./mosh-relpath-probe.mosh").isEmpty());

    relTarget.deleteFile();
}

TEST_CASE ("projectPathFromOpenArgs rejects non-projects and missing files", "[projectname]")
{
    TempProject p ("real.mosh");

    // Right extension, but nothing on disk — a stale Finder alias must not resolve.
    REQUIRE (projectPathFromOpenArgs ("/no/such/place/ghost.mosh").isEmpty());

    // Exists, wrong extension — Mosh only claims project files here.
    TempProject wav ("loop.wav");
    REQUIRE (projectPathFromOpenArgs (wav.file.getFullPathName()).isEmpty());

    // Mixed: the project wins over the flags and the non-project around it.
    const auto args = "--selftest " + wav.file.getFullPathName()
                    + " \"" + p.file.getFullPathName() + "\"";
    REQUIRE (projectPathFromOpenArgs (args) == p.file.getFullPathName());
}

// ── resolveSessionEditFile — the unnamed default session, across the rename ──────
//
// The riskiest part of changing the extension: a user who already has a session must
// not cold-start into a blank app sitting next to their work. Pure over a temp dir, so
// each branch is actually reachable in a test (MoshEngine's own session dir always has
// a live session.mosh, which would make the legacy branch unreachable there).

namespace
{
    struct TempSessionDir
    {
        TempSessionDir()
            : dir (juce::File::getSpecialLocation (juce::File::tempDirectory)
                       .getChildFile ("mosh-session-resolve-test")
                       .getNonexistentSibling())
        {
            dir.createDirectory();
        }
        ~TempSessionDir() { dir.deleteRecursively(); }
        juce::File mosh()   const { return dir.getChildFile ("session.mosh"); }
        juce::File legacy() const { return dir.getChildFile ("session.tracktionedit"); }
        juce::File dir;
    };
}

TEST_CASE ("resolveSessionEditFile prefers .mosh, falls back to legacy", "[projectname]")
{
    SECTION ("an empty session dir gets a NEW .mosh")
    {
        TempSessionDir s;
        REQUIRE (resolveSessionEditFile (s.dir) == s.mosh());
    }

    SECTION ("an existing .mosh session is used")
    {
        TempSessionDir s;
        s.mosh().replaceWithText ("<EDIT/>");
        REQUIRE (resolveSessionEditFile (s.dir) == s.mosh());
    }

    SECTION ("a PRE-RENAME session is opened in place, not stranded")
    {
        // This is the case the fallback exists for. Without it the caller would get
        // session.mosh, find nothing there, and start blank — the user's tracks still on
        // disk but invisible, which reads as data loss rather than a rename.
        TempSessionDir s;
        s.legacy().replaceWithText ("<EDIT/>");
        REQUIRE (! s.mosh().existsAsFile());
        REQUIRE (resolveSessionEditFile (s.dir) == s.legacy());
    }

    SECTION ("once BOTH exist, .mosh wins")
    {
        TempSessionDir s;
        s.legacy().replaceWithText ("<EDIT/>");
        s.mosh().replaceWithText ("<EDIT/>");
        REQUIRE (resolveSessionEditFile (s.dir) == s.mosh());
    }
}
