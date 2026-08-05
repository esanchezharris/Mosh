#pragma once

#include <juce_core/juce_core.h>
#include <vector>

// PRJ-NAME — the project FILE identity: what a saved Mosh project is called on disk,
// and what extension it wears.
//
// Two concerns that used to be scattered literals:
//
//  1. The extension. Projects were saved as ".tracktionedit" — the raw Tracktion Engine
//     format name leaking through a product seam. Mosh files are ".mosh". This is safe
//     because Tracktion's own save/load path is extension-agnostic: `editFileSuffix`
//     appears only in the LEGACY Project/ProjectItem system (which Mosh does not use)
//     and in the no-arg `EditFileOperations::saveAs()` chooser. Mosh calls
//     `saveAs (file, true)` and `te::loadEditFromFile (engine, file)`, both of which
//     take the path verbatim. Old .tracktionedit files therefore keep opening unchanged
//     — nothing on disk is migrated or rewritten.
//
//  2. The auto-generated name. A new project used to be "untitled-1722693847234" — a
//     millisecond timestamp, unreadable and un-sayable, so two unsaved sessions were
//     indistinguishable at a glance. Now it is "untitled - bearcat": still obviously
//     unnamed, but memorable and speakable.
//
// Header-only + engine-free (juce_core only) so it unit-tests in MoshTests with zero
// engine dependency — same posture as state/Migrations.h and state/RenderLayer.h.
namespace mosh::projectname
{
    /** The Mosh project container extension, WITHOUT a leading dot — matching what
        `snapshot.session.projectExtension` already reports to the UI. Single source of
        truth: every `withFileExtension` / picker-filter site reads this. */
    inline constexpr const char* kProjectExtension = "mosh";

    /** The pre-.mosh extension. Still accepted on open (and still saved in place when a
        legacy project is opened and re-saved) — back-compat, never auto-migrated. */
    inline constexpr const char* kLegacyProjectExtension = "tracktionedit";

    /** The prefix that marks a project as never having been deliberately named. Kept
        separate from the word so callers (and tests) can assert the "still untitled"
        property without pattern-matching the whole string. */
    inline constexpr const char* kUntitledPrefix = "untitled - ";

    /** Short, speakable, unambiguous creature nouns. Constraints every entry must meet
        (all four are asserted in tests/test_project_name.cpp):
          - lowercase ASCII letters only — so File::createLegalFileName is a no-op and
            the generated name survives to disk byte-identical;
          - no duplicates — a duplicate silently halves that word's collision odds and
            makes the "distinct seeds give distinct words" guarantee a lie;
          - one word, no spaces/hyphens — the " - " separator stays unambiguous;
          - pronounceable in one go, because the whole point is that a producer can say
            "open bearcat" out loud.
        Deliberately a vector, not a sized std::array: a hardcoded size is a footgun that
        breaks (or silently zero-pads) every time a word is added. The tests assert the
        size floor instead. */
    inline const std::vector<const char*>& words()
    {
        static const std::vector<const char*> w {
            "bearcat",  "pangolin", "kestrel",  "axolotl",  "narwhal",  "capybara",
            "ocelot",   "lemur",    "marmot",   "gecko",    "puffin",   "wombat",
            "tapir",    "ibex",     "caracal",  "serval",   "fossa",    "quokka",
            "dingo",    "civet",    "meerkat",  "badger",   "otter",    "heron",
            "osprey",   "falcon",   "condor",   "kiwi",     "toucan",   "hoopoe",
            "magpie",   "raven",    "swift",    "wren",     "finch",    "grouse",
            "curlew",   "avocet",   "godwit",   "dunlin",   "gannet",   "shearwater",
            "albatross","petrel",   "skua",     "tern",     "auklet",   "murre",
            "manatee",  "dugong",   "beluga",   "orca",     "porpoise", "marlin",
            "tarpon",   "wrasse",   "grouper",  "barracuda","sturgeon", "pike",
            "tench",    "roach",    "chub",     "burbot",   "grayling", "char",
            "cuttlefish","nautilus","limpet",   "cockle",   "whelk",    "abalone",
            "urchin",   "anemone",  "krill",    "copepod",  "isopod",   "amphipod",
            "mantis",   "cicada",   "weevil",   "firefly",  "damselfly","mayfly",
            "lacewing", "hornet",   "bumblebee","carpenter","leafcutter","harvester",
            "jackal",   "coyote",   "vicuna",   "guanaco",  "saiga",    "oryx",
            "eland",    "kudu",     "nyala",    "bongo",    "sitatunga","duiker",
            "klipspringer","dikdik","gerenuk",  "topi",     "bontebok", "blesbok",
            "markhor",  "argali",   "urial",    "tahr",     "chamois",  "goral",
            "takin",    "banteng",  "gaur",     "anoa",     "babirusa", "peccary",
            "coati",    "kinkajou", "olingo",   "tayra",    "grison",   "zorilla",
            "genet",    "linsang",  "binturong","aardwolf", "aardvark", "numbat",
            "bilby",    "bettong",  "potoroo",  "pademelon","quoll",    "dunnart",
            "planigale","antechinus","cuscus",  "colugo",   "tarsier",  "loris",
            "galago",   "indri",    "sifaka",   "aye",      "douc",     "langur",
            "saki",     "uakari",   "titi",     "marmoset", "tamarin",  "howler",
            "salamander","newt",    "caecilian","skink",    "tegu",     "monitor",
        };
        return w;
    }

    /** Generate the default name for a brand-new project.

        PURE and DETERMINISTIC in `seed` — the caller supplies the randomness
        (`juce::Random::getSystemRandom().nextInt()`). That split is deliberate: a
        function that reaches for a global RNG itself cannot be RED-proven, and this
        repo's recurring failure mode is a guard that cannot fail. With the seed as a
        parameter the word-selection, the prefix, and the filename-legality property are
        all directly assertable in a unit test.

        Callers are still responsible for collision handling (the word space is finite):
        see cmdNewProject, which re-rolls on an existing file before falling back to
        numeric suffixing. */
    inline juce::String generateName (juce::uint32 seed)
    {
        const auto& w = words();
        return juce::String (kUntitledPrefix) + w[seed % (juce::uint32) w.size()];
    }

    /** PRJ-NAME — the unnamed default session file inside a session directory.

        Returns "<sessionDir>/session.mosh", EXCEPT when that file does not exist and a
        pre-rename "session.tracktionedit" does — then the legacy file, opened in place
        and never rewritten or migrated.

        Without the fallback, changing the extension would strand every existing session:
        the work would still be on disk, but the app would cold-start blank next to it,
        which reads as data loss rather than a rename. Pure (sessionDir + two existence
        checks) so the fallback itself is unit-testable against a temp directory. */
    inline juce::File resolveSessionEditFile (const juce::File& sessionDir)
    {
        const auto current = sessionDir.getChildFile (juce::String ("session.") + kProjectExtension);
        if (current.existsAsFile())
            return current;

        const auto legacy = sessionDir.getChildFile (juce::String ("session.") + kLegacyProjectExtension);
        if (legacy.existsAsFile())
            return legacy;

        return current;   // neither exists ⇒ a fresh session is created as .mosh
    }

    /** True for a path this app claims: .mosh, or the legacy .tracktionedit. */
    inline bool isProjectFile (const juce::File& f)
    {
        return f.hasFileExtension (kProjectExtension) || f.hasFileExtension (kLegacyProjectExtension);
    }

    /** PRJ-NAME — extract the project to open from a launch/open-file argument string.

        macOS routes BOTH "double-clicked a .mosh while Mosh was closed" and "…while it
        was already running" through JUCEApplication::anotherInstanceStarted, as a
        space-joined, shell-quoted argument string. The same entry point also sees this
        app's own CLI (`--selftest`, `--run-script`, plugin-scan child args), so the
        matching has to be positively-scoped rather than "take the first token":

          - tokens are split respecting quotes, so a path with spaces survives (every
            generated name has two: "untitled - bearcat.mosh");
          - a token must be an ABSOLUTE path. This is the load-bearing filter, and not
            merely for tidiness: juce::File's constructor jassert-fails on a relative
            path, so feeding it "--selftest" would fire an assertion on every headless
            launch in a Debug build. It also stops a relative "song.mosh" from resolving
            against whatever the process's working directory happens to be;
          - and it must carry a project extension AND name a file that exists.

        Returns an empty String when the arguments name no project, which is the common
        case and must be a silent no-op — never a guess. */
    inline juce::String projectPathFromOpenArgs (const juce::String& args)
    {
        // Whole-string first. JUCE's macOS path quotes any filename containing spaces
        // (quotedIfContainsSpaces, juce_MessageManager_mac.mm), so the tokenizer below
        // handles the real Finder case — but an UNquoted spaced path (a direct CLI
        // invocation, or a future JUCE that stops quoting) would otherwise be shredded
        // into "…/untitled", "-", "bearcat.mosh" and silently resolve to nothing. Every
        // generated name has spaces, so that is the common name, not an edge case.
        if (const auto whole = args.trim().unquoted(); juce::File::isAbsolutePath (whole))
            if (const juce::File f (whole); isProjectFile (f) && f.existsAsFile())
                return f.getFullPathName();

        juce::StringArray tokens;
        tokens.addTokens (args, true);   // true ⇒ honour quotes around spaced paths
        tokens.trim();

        for (const auto& raw : tokens)
        {
            const auto token = raw.unquoted();
            if (! juce::File::isAbsolutePath (token))   // flags, relative paths, empties
                continue;

            const juce::File f (token);
            if (isProjectFile (f) && f.existsAsFile())
                return f.getFullPathName();
        }

        return {};
    }
}
