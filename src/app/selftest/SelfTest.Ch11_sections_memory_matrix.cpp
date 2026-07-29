// ── SelfTest.Ch11_sections_memory_matrix.cpp — runSelfTest chapter 11 (RFC 002 A-PR6) ──
// Sections moved VERBATIM from src/app/SelfTest.cpp (pre-split lines 3600-4365), in
// exact pre-split order. The ONLY in-section edits are the identifier adaptations
// forced by promoting compiler-enumerated cross-chapter locals into SelfTestCtx.

#include "app/SelfTest.h"
#include "SelfTestChapters.h"
#include "SelfTestSupport.h"
#include "engine/MoshEngine.h"
#include "engine/SessionPaths.h"
#include "moshops/MoshOps.h"
#include "moshops/AgentMemoryStore.h"
#include "plugins/spectral/MasterSpectralTapPlugin.h"
#include "state/Migrations.h"
#include "multiplayer/MultiplayerClient.h"
#include "multiplayer/MultiplayerSession.h"
#include "brain/BrainProxy.h"
#include "voice/NativeSpeech.h"
#include "util/Env.h"
#include <juce_cryptography/juce_cryptography.h>
#include <atomic>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <map>
#include <thread>
#include <vector>

namespace mosh
{
namespace
{
    // Thin forwarders keeping the exact pre-split free-function names/signatures,
    // bound to the shared harness state (same instance as SelfTest.cpp's shims).
    selftest::SelfTestCtx& gCtx = selftest::globalCtx();
    [[maybe_unused]] int& failures = gCtx.failures;
    [[maybe_unused]] int& checks   = gCtx.checks;

    [[maybe_unused]] inline void finishSection()                             { selftest::finishSection (gCtx); }
    [[maybe_unused]] inline void resetSections()                             { selftest::resetSections (gCtx); }
    [[maybe_unused]] inline void section (const juce::String& name)          { selftest::section (gCtx, name); }
    [[maybe_unused]] inline void section (const char* name)                  { selftest::section (gCtx, name); }
    [[maybe_unused]] inline void check (bool cond, const juce::String& what) { selftest::check (gCtx, cond, what); }
    [[maybe_unused]] inline void check (bool cond, const char* what)         { selftest::check (gCtx, cond, what); }

    using selftest::cmd;
    using selftest::args1;
    using selftest::objN;
    using selftest::ok;
    using selftest::tracks;
    using selftest::firstTrack;
    using selftest::trackClips;
    using selftest::trackSnapshotByLogicalId;
    using selftest::selftestTempPath;
}

void runChapter11_sections_memory_matrix (selftest::SelfTestCtx& ctx)
{
    using namespace juce;
    auto& eng = *ctx.eng;
    auto& ops = *ctx.ops;

    // ── SEC-001 — named song sections (MOSH_SECTIONS) end-to-end ─────────────
    {
        section ("Song sections (MOSH_SECTIONS)");
        auto sectionsArr = [&] { return ops.snapshot().getProperty ("sections", var()); };
        auto findSec = [&] (const juce::String& id) -> juce::var
        {
            auto arr = sectionsArr();
            for (int i = 0; i < arr.size(); ++i)
                if (arr[i].getProperty ("id", var()).toString() == id) return arr[i];
            return {};
        };
        const int before = sectionsArr().size();

        auto created = cmd (ops, "create_section",
                            objN ({ { "name", "Hook" }, { "startBeat", 24.0 }, { "endBeat", 40.0 }, { "color", "#f4c0d1" } }));
        check (ok (created), "create_section ok");
        const auto secId = created.getProperty ("data", var()).getProperty ("sectionId", var()).toString();
        check (secId.isNotEmpty(), "create_section returns a sectionId");
        check (sectionsArr().size() == before + 1, "snapshot.sections grew by one");
        check (findSec (secId).getProperty ("name", var()).toString() == "Hook", "new section name is Hook");
        check (std::abs ((double) findSec (secId).getProperty ("startBeat", -1.0) - 24.0) < 1e-6, "section startBeat is 24");

        check (ok (cmd (ops, "rename_section", objN ({ { "sectionId", secId }, { "name", "Chorus" } }))), "rename_section ok");
        check (findSec (secId).getProperty ("name", var()).toString() == "Chorus", "rename reflected in snapshot");

        check (ok (cmd (ops, "move_section", objN ({ { "sectionId", secId }, { "startBeat", 32.0 }, { "endBeat", 48.0 } }))), "move_section ok");
        check (std::abs ((double) findSec (secId).getProperty ("endBeat", -1.0) - 48.0) < 1e-6, "move reflected in snapshot");

        // Undo reverts only the last edit (the move), before save/reload resets history.
        check (ok (cmd (ops, "undo")), "undo (move_section) ok");
        check (std::abs ((double) findSec (secId).getProperty ("endBeat", -1.0) - 40.0) < 1e-6, "undo restores the prior range");
        check (findSec (secId).getProperty ("name", var()).toString() == "Chorus", "undo leaves the rename intact");

        // Persists across save/reload (a plain child of the Edit's own ValueTree).
        check (ok (cmd (ops, "save")),   "save (sections) ok");
        check (ok (cmd (ops, "reload")), "reload (sections) ok");
        check (findSec (secId).getProperty ("name", var()).toString() == "Chorus", "section persists across save/reload");
        check (std::abs ((double) findSec (secId).getProperty ("endBeat", -1.0) - 40.0) < 1e-6, "section range persists across save/reload");

        check (ok (cmd (ops, "remove_section", objN ({ { "sectionId", secId } }))), "remove_section ok");
        check (! findSec (secId).isObject(), "section gone from snapshot after remove");
        check (! ok (cmd (ops, "rename_section", objN ({ { "sectionId", secId }, { "name", "Ghost" } }))), "rename of a removed section fails cleanly");
    }

    // ─── ANN-001: authored timeline annotations (MOSH_ANNOTATIONS) ───
    {
        section ("Timeline annotations (MOSH_ANNOTATIONS)");
        auto annsArr = [&] { return ops.snapshot().getProperty ("annotations", var()); };
        auto findAnn = [&] (const juce::String& id) -> juce::var
        {
            auto arr = annsArr();
            for (int i = 0; i < arr.size(); ++i)
                if (arr[i].getProperty ("id", var()).toString() == id) return arr[i];
            return {};
        };
        const int before = annsArr().size();

        auto created = cmd (ops, "create_annotation",
                            objN ({ { "text", "fix this transition" }, { "beat", 24.0 }, { "color", "#ffd166" }, { "author", "alice" } }));
        check (ok (created), "create_annotation ok");
        const auto annId = created.getProperty ("data", var()).getProperty ("annotationId", var()).toString();
        check (annId.isNotEmpty(), "create_annotation returns an annotationId");
        check (annsArr().size() == before + 1, "snapshot.annotations grew by one");
        check (findAnn (annId).getProperty ("text", var()).toString() == "fix this transition", "annotation text round-trips");
        check (findAnn (annId).getProperty ("author", var()).toString() == "alice", "annotation carries its author");
        check (std::abs ((double) findAnn (annId).getProperty ("beat", -1.0) - 24.0) < 1e-6, "annotation beat is 24");

        check (ok (cmd (ops, "edit_annotation", objN ({ { "annotationId", annId }, { "text", "smooth the drop" } }))), "edit_annotation ok");
        check (findAnn (annId).getProperty ("text", var()).toString() == "smooth the drop", "edit reflected in snapshot");

        check (ok (cmd (ops, "move_annotation", objN ({ { "annotationId", annId }, { "beat", 32.0 } }))), "move_annotation ok");
        check (std::abs ((double) findAnn (annId).getProperty ("beat", -1.0) - 32.0) < 1e-6, "move reflected in snapshot");

        // Undo reverts only the last edit (the move), before save/reload resets history.
        check (ok (cmd (ops, "undo")), "undo (move_annotation) ok");
        check (std::abs ((double) findAnn (annId).getProperty ("beat", -1.0) - 24.0) < 1e-6, "undo restores the prior beat");
        check (findAnn (annId).getProperty ("text", var()).toString() == "smooth the drop", "undo leaves the edit intact");

        // Persists across save/reload (a plain child of the Edit's own ValueTree).
        check (ok (cmd (ops, "save")),   "save (annotations) ok");
        check (ok (cmd (ops, "reload")), "reload (annotations) ok");
        check (findAnn (annId).getProperty ("text", var()).toString() == "smooth the drop", "annotation persists across save/reload");
        check (findAnn (annId).getProperty ("author", var()).toString() == "alice", "annotation author persists across save/reload");

        // Caller-supplied id is honoured (this is how the MP broadcast keeps ids stable).
        check (ok (cmd (ops, "create_annotation", objN ({ { "annotationId", "ann-fixed" }, { "text", "shared note" }, { "beat", 4.0 } }))), "create_annotation with an explicit id ok");
        check (findAnn ("ann-fixed").getProperty ("text", var()).toString() == "shared note", "explicit-id annotation lands with that id");

        check (ok (cmd (ops, "remove_annotation", objN ({ { "annotationId", annId } }))), "remove_annotation ok");
        check (! findAnn (annId).isObject(), "annotation gone from snapshot after remove");
        check (! ok (cmd (ops, "edit_annotation", objN ({ { "annotationId", annId }, { "text", "ghost" } }))), "edit of a removed annotation fails cleanly");
    }

    // ─── LYR-001: Finish-My-Song lyric sheet (MOSH_LYRICSHEET, per-track) ───
    // State spine only (in-process, deterministic). get_rhymes is a SERVICE path
    // (covered by the Python golden test + an HTTP smoke); exercising it here would
    // spawn the generative service and break selftest isolation, so it's omitted.
    {
        section ("Lyric sheet (MOSH_LYRICSHEET)");
        auto trk = cmd (ops, "create_track", objN ({ { "name", "Vocals" } }));
        check (ok (trk), "create_track (vocals) ok");
        const auto trackId = trk.getProperty ("data", var()).getProperty ("trackId", var()).toString();

        auto sheetOf = [&] (const juce::String& tid) -> juce::var
        {
            auto tracks = ops.snapshot().getProperty ("tracks", var());
            for (int i = 0; i < tracks.size(); ++i)
                if (tracks[i].getProperty ("id", var()).toString() == tid)
                    return tracks[i].getProperty ("lyricSheet", var());
            return {};
        };
        auto linesOf = [&] (const juce::String& tid) { return sheetOf (tid).getProperty ("lines", var()); };

        check (! sheetOf (trackId).isObject(), "track starts with no lyric sheet");

        auto created = cmd (ops, "create_lyric_sheet",
                            objN ({ { "trackId", trackId }, { "grid", "1/16" }, { "topic", "comeback" } }));
        check (ok (created), "create_lyric_sheet ok");
        check (created.getProperty ("data", var()).getProperty ("sheetId", var()).toString().isNotEmpty(),
               "create_lyric_sheet returns a sheetId");
        check (sheetOf (trackId).isObject(), "snapshot.track.lyricSheet present");
        check (sheetOf (trackId).getProperty ("grid", var()).toString() == "1/16", "sheet grid is 1/16");
        check (sheetOf (trackId).getProperty ("topic", var()).toString() == "comeback", "sheet topic round-trips");
        check (sheetOf (trackId).getProperty ("rhymeStrictness", var()).toString() == "slant",
               "default rhyme strictness is slant (rap)");
        check (! ok (cmd (ops, "create_lyric_sheet", objN ({ { "trackId", trackId } }))),
               "double create_lyric_sheet fails cleanly");

        // Append a line carrying the constraint spec (seed with ___ gaps).
        check (ok (cmd (ops, "set_lyric_line", objN ({ { "trackId", trackId }, { "lineIndex", 0 },
                                                       { "role", "hook" }, { "seedText", "yeah I came back ___ ___ the ___" },
                                                       { "syllableTarget", 9 }, { "rhymeGroup", "A" } }))),
               "set_lyric_line (append line 0) ok");
        check (linesOf (trackId).size() == 1, "sheet has one line");
        check (linesOf (trackId)[0].getProperty ("seedText", var()).toString() == "yeah I came back ___ ___ the ___",
               "line seedText round-trips WITH gaps");
        check ((int) linesOf (trackId)[0].getProperty ("syllableTarget", -1) == 9, "line syllableTarget is 9");
        check (linesOf (trackId)[0].getProperty ("role", var()).toString() == "hook", "line role is hook");

        check (ok (cmd (ops, "set_lyric_line", objN ({ { "trackId", trackId }, { "lineIndex", 1 },
                                                       { "role", "verse" }, { "seedText", "___ on the grind" } }))),
               "set_lyric_line (append line 1) ok");
        check (linesOf (trackId).size() == 2, "sheet has two lines");
        check (! ok (cmd (ops, "set_lyric_line", objN ({ { "trackId", trackId }, { "lineIndex", 9 } }))),
               "set_lyric_line out-of-range fails (lines stay dense)");

        // Finalize line 0's text → status flips off "empty".
        check (ok (cmd (ops, "set_lyric_line", objN ({ { "trackId", trackId }, { "lineIndex", 0 },
                                                       { "text", "yeah I came back lit the flame" } }))),
               "set_lyric_line (edit text) ok");
        check (linesOf (trackId)[0].getProperty ("text", var()).toString() == "yeah I came back lit the flame",
               "line text updated");
        check (linesOf (trackId)[0].getProperty ("status", var()).toString() == "seed",
               "a line carrying text is no longer empty");

        // Sheet-level constraint + undo.
        check (ok (cmd (ops, "set_lyric_constraint", objN ({ { "trackId", trackId }, { "mood", "defiant" }, { "rhymeStrictness", "perfect" } }))),
               "set_lyric_constraint ok");
        check (sheetOf (trackId).getProperty ("mood", var()).toString() == "defiant", "sheet mood updated");
        check (sheetOf (trackId).getProperty ("rhymeStrictness", var()).toString() == "perfect", "sheet strictness updated");
        check (ok (cmd (ops, "undo")), "undo (set_lyric_constraint) ok");
        check (sheetOf (trackId).getProperty ("rhymeStrictness", var()).toString() == "slant",
               "undo restores the prior strictness");

        // Persists across save/reload (a plain child of the track's own ValueTree).
        check (ok (cmd (ops, "save")),   "save (lyrics) ok");
        check (ok (cmd (ops, "reload")), "reload (lyrics) ok");
        check (sheetOf (trackId).isObject(), "lyric sheet persists across save/reload");
        check (linesOf (trackId).size() == 2, "lines persist across save/reload");
        check (linesOf (trackId)[0].getProperty ("text", var()).toString() == "yeah I came back lit the flame",
               "line text persists across save/reload");

        // confirm_skeleton (Phase-2 grid gate): with no `proposed` lines it's a clean no-op
        // (confirmed:0). The proposed→seed flip itself is covered by test_lyrics.cpp (state) +
        // the --run-script skeleton end-to-end — build_skeleton_from_clip spawns the service, so
        // the full mumble→skeleton path is OUT of the hermetic selftest (mirrors build_lyrics).
        {
            auto cs = cmd (ops, "confirm_skeleton", objN ({ { "trackId", trackId } }));
            check (ok (cs), "confirm_skeleton ok (no proposed lines)");
            check ((int) cs.getProperty ("data", var()).getProperty ("confirmed", -1) == 0,
                   "confirm_skeleton confirms 0 when nothing is proposed");
        }

        // remove_lyric_line keeps indices dense.
        check (ok (cmd (ops, "remove_lyric_line", objN ({ { "trackId", trackId }, { "lineIndex", 0 } }))),
               "remove_lyric_line ok");
        check (linesOf (trackId).size() == 1, "one line after remove");
        check ((int) linesOf (trackId)[0].getProperty ("index", -1) == 0, "remaining line re-indexed to 0");

        check (ok (cmd (ops, "remove_lyric_sheet", objN ({ { "trackId", trackId } }))), "remove_lyric_sheet ok");
        check (! sheetOf (trackId).isObject(), "lyric sheet gone from snapshot after remove");
        check (! ok (cmd (ops, "set_lyric_line", objN ({ { "trackId", trackId }, { "lineIndex", 0 }, { "text", "ghost" } }))),
               "set_lyric_line on a sheetless track fails cleanly");
        check (! ok (cmd (ops, "confirm_skeleton", objN ({ { "trackId", trackId } }))),
               "confirm_skeleton on a sheetless track fails cleanly");
    }

    // ─── AGT-MEM (Phase-B memory lane, M1): the native agent-memory store ───
    // Pure file I/O (src/moshops/AgentMemoryStore.h) — no ValueTree/Edit mutation, no
    // snapshot change, no undo transaction. MOSH_AGENT_DIR is already pinned (above)
    // to a dir inside THIS run's isolated session, so this section is hermetic against
    // both the owner's real ~/Library/Mosh/agent and any concurrent selftest run.
    {
        section ("Agent memory store (AGT-MEM)");

        // ── validation: missing/invalid scope, kind, item ──
        check (! ok (cmd (ops, "agent_memory_write", objN ({ { "kind", "preference" }, { "item", "x" } }))),
               "agent_memory_write missing scope fails cleanly");
        check (! ok (cmd (ops, "agent_memory_write",
                          objN ({ { "scope", "nonsense" }, { "kind", "preference" }, { "item", "x" } }))),
               "agent_memory_write invalid scope fails cleanly");
        check (! ok (cmd (ops, "agent_memory_write", objN ({ { "scope", "global" }, { "item", "x" } }))),
               "agent_memory_write global scope missing kind fails cleanly");
        check (! ok (cmd (ops, "agent_memory_write",
                          objN ({ { "scope", "global" }, { "kind", "nonsense" }, { "item", "x" } }))),
               "agent_memory_write global scope invalid kind fails cleanly");
        check (! ok (cmd (ops, "agent_memory_write", objN ({ { "scope", "global" }, { "kind", "preference" } }))),
               "agent_memory_write missing item fails cleanly");
        check (! ok (cmd (ops, "agent_memory_read", objN ({ { "scope", "nonsense" } }))),
               "agent_memory_read invalid scope fails cleanly");

        // ── global write -> read round-trip + kind filtering ──
        check (ok (cmd (ops, "agent_memory_write",
                        objN ({ { "scope", "global" }, { "kind", "preference" }, { "explicit", true },
                                { "item", "always keep the low end wide" } }))),
               "agent_memory_write global/preference (explicit) ok");
        auto prefWrite2 = cmd (ops, "agent_memory_write",
                               objN ({ { "scope", "global" }, { "kind", "preference" },
                                       { "item", objN ({ { "note", "leans on triplet hats" } }) } }));
        check (ok (prefWrite2), "agent_memory_write global/preference (derived, object item) ok");
        check ((int) prefWrite2.getProperty ("data", var()).getProperty ("count", -1) == 2,
               "agent_memory_write returns the post-write count");

        auto prefRead = cmd (ops, "agent_memory_read", objN ({ { "scope", "global" }, { "kind", "preference" } }));
        check (ok (prefRead), "agent_memory_read global/preference ok");
        auto prefItems = prefRead.getProperty ("data", var()).getProperty ("items", var());
        check (prefItems.size() == 2, "agent_memory_read returns both preference items");
        check (prefItems[0].getProperty ("item", var()).getProperty ("note", var()).toString() == "leans on triplet hats",
               "agent_memory_read is newest-first");
        check (prefItems[1].getProperty ("item", var()).toString() == "always keep the low end wide",
               "agent_memory_read's oldest item sorts last");
        check ((bool) prefItems[1].getProperty ("explicit", false), "the explicit flag round-trips");

        check (ok (cmd (ops, "agent_memory_write",
                        objN ({ { "scope", "global" }, { "kind", "drum_pattern" },
                                { "item", "four on the floor, ghost snares" } }))),
               "agent_memory_write global/drum_pattern ok");
        auto drumRead = cmd (ops, "agent_memory_read", objN ({ { "scope", "global" }, { "kind", "drum_pattern" } }));
        check ((int) drumRead.getProperty ("data", var()).getProperty ("items", var()).size() == 1,
               "kind filtering isolates drum_pattern from preference");

        auto allRead = cmd (ops, "agent_memory_read", args1 ("scope", "global"));
        check (ok (allRead), "agent_memory_read global with no kind filter ok");
        check ((int) allRead.getProperty ("data", var()).getProperty ("items", var()).size() >= 3,
               "unfiltered global read merges every kind's store");

        // ── write survives undo (non-undoable by construction: no Tracktion txn opened) ──
        check (ok (cmd (ops, "create_track", args1 ("name", "AgtMemUndoProbe"))), "undo-probe create_track ok");
        const int tAfterCreate = tracks (ops);
        check (ok (cmd (ops, "agent_memory_write",
                        objN ({ { "scope", "global" }, { "kind", "preference" }, { "item", "undo-probe item" } }))),
               "agent_memory_write between the probe create_track and undo, ok");
        check (ok (cmd (ops, "undo")), "undo after agent_memory_write ok");
        check (tracks (ops) == tAfterCreate - 1,
               "undo reverted the REAL prior transaction (create_track) -- agent_memory_write left no stray empty txn");
        auto afterUndoRead = cmd (ops, "agent_memory_read", objN ({ { "scope", "global" }, { "kind", "preference" } }));
        bool undoProbeStillThere = false;
        {
            auto items = afterUndoRead.getProperty ("data", var()).getProperty ("items", var());
            for (int i = 0; i < items.size(); ++i)
                if (items[i].getProperty ("item", var()).toString() == "undo-probe item") undoProbeStillThere = true;
        }
        check (undoProbeStillThere, "agent_memory_write is NOT on the undo stack -- undo cannot remove a stored item");

        // ── mosh-log.jsonl: writes logged undoable:false; reads not logged at all ──
        {
            auto slog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
            bool writeLogged = false, writeUndoableFalse = false, readLogged = false;
            for (auto& ln : StringArray::fromLines (slog))
            {
                if (ln.contains ("\"command\": \"agent_memory_write\""))
                {
                    writeLogged = true;
                    if (ln.contains ("\"undoable\": false")) writeUndoableFalse = true;
                }
                if (ln.contains ("\"command\": \"agent_memory_read\"")) readLogged = true;
            }
            check (writeLogged, "mosh-log.jsonl records agent_memory_write");
            check (writeUndoableFalse, "agent_memory_write logged undoable:false");
            check (! readLogged, "mosh-log.jsonl records NO agent_memory_read lines (reads are unlogged)");
        }

        // ── cap eviction: an all-derived store at cap evicts the OLDEST item ──
        {
            auto root = AgentMemoryStore::globalRoot();
            auto file = AgentMemoryStore::globalStoreFile (root, "lyric_framework");
            Array<var> seeded;
            for (int i = 0; i < AgentMemoryStore::kMaxItemsPerStore; ++i)
            {
                auto* o = new DynamicObject();
                o->setProperty ("ts", (int64) i);
                o->setProperty ("kind", "lyric_framework");
                o->setProperty ("explicit", false);
                o->setProperty ("item", "seed-" + String (i));
                seeded.add (var (o));
            }
            check (AgentMemoryStore::writeJsonlFile (file, seeded),
                   "seeded lyric_framework store to the cap (500 derived items)");

            auto atCap = cmd (ops, "agent_memory_write",
                              objN ({ { "scope", "global" }, { "kind", "lyric_framework" }, { "item", "seed-500" } }));
            check (ok (atCap), "agent_memory_write at cap (all-derived store) still succeeds");
            check ((int) atCap.getProperty ("data", var()).getProperty ("count", -1) == AgentMemoryStore::kMaxItemsPerStore,
                   "count stays at the cap after eviction");

            auto onDisk = AgentMemoryStore::readJsonlFile (file);
            check (onDisk.size() == AgentMemoryStore::kMaxItemsPerStore, "on-disk store stays at the cap");
            check (onDisk[0].getProperty ("item", var()).toString() == "seed-1",
                   "the OLDEST item (seed-0) was evicted, not an arbitrary one");
            check (onDisk[onDisk.size() - 1].getProperty ("item", var()).toString() == "seed-500",
                   "the new item was appended at the end");
        }

        // ── cap eviction: an all-EXPLICIT store rejects a derived write, but accepts
        //    (and evicts the oldest explicit item for) another explicit write ──
        {
            auto root = AgentMemoryStore::globalRoot();
            auto file = AgentMemoryStore::globalStoreFile (root, "drum_pattern");
            Array<var> seeded;
            for (int i = 0; i < AgentMemoryStore::kMaxItemsPerStore; ++i)
            {
                auto* o = new DynamicObject();
                o->setProperty ("ts", (int64) i);
                o->setProperty ("kind", "drum_pattern");
                o->setProperty ("explicit", true);
                o->setProperty ("item", "explicit-" + String (i));
                seeded.add (var (o));
            }
            check (AgentMemoryStore::writeJsonlFile (file, seeded),
                   "seeded drum_pattern store to the cap (500 explicit items)");

            auto rejected = cmd (ops, "agent_memory_write",
                                 objN ({ { "scope", "global" }, { "kind", "drum_pattern" }, { "item", "should be rejected" } }));
            check (! ok (rejected), "a derived write against an all-explicit, at-cap store is rejected");
            check (rejected.getProperty ("error", var()).toString().contains ("explicit"),
                   "the rejection error is self-describing");
            check (AgentMemoryStore::readJsonlFile (file).size() == AgentMemoryStore::kMaxItemsPerStore,
                   "the rejected write did not change the on-disk store");

            auto explicitAtCap = cmd (ops, "agent_memory_write",
                                      objN ({ { "scope", "global" }, { "kind", "drum_pattern" }, { "explicit", true },
                                              { "item", "explicit-500" } }));
            check (ok (explicitAtCap), "an EXPLICIT write against an all-explicit, at-cap store still succeeds");
            auto onDisk2 = AgentMemoryStore::readJsonlFile (file);
            check (onDisk2.size() == AgentMemoryStore::kMaxItemsPerStore, "count stays at the cap");
            check (onDisk2[0].getProperty ("item", var()).toString() == "explicit-1",
                   "the OLDEST explicit item (explicit-0) was the only valid eviction victim");
        }

        // ── meta.json stamped on first global write ──
        check (AgentMemoryStore::globalRoot().getChildFile ("meta.json").existsAsFile(),
               "meta.json exists after the first global write");
        check ((int) JSON::fromString (AgentMemoryStore::globalRoot().getChildFile ("meta.json").loadFileAsString())
                        .getProperty ("v", -1) == 1,
               "meta.json carries v:1");

        // ── project scope: write -> read, kind default, Save-As sidecar copy ──
        check (ok (cmd (ops, "agent_memory_write",
                        objN ({ { "scope", "project" }, { "item", "the bridge needs a bigger lift" } }))),
               "agent_memory_write project (kind defaults to \"note\") ok");
        check (ok (cmd (ops, "agent_memory_write",
                        objN ({ { "scope", "project" }, { "kind", "mood" }, { "explicit", true },
                                { "item", objN ({ { "mood", "triumphant" } }) } }))),
               "agent_memory_write project (explicit, custom kind) ok");

        auto projRead = cmd (ops, "agent_memory_read", args1 ("scope", "project"));
        check (ok (projRead), "agent_memory_read project ok");
        auto projItems = projRead.getProperty ("data", var()).getProperty ("items", var());
        check (projItems.size() == 2, "project sidecar carries both notes");
        check (projItems[0].getProperty ("kind", var()).toString() == "mood", "newest project note reads first");
        check (projItems[1].getProperty ("kind", var()).toString() == "note", "kind defaulted to \"note\" when omitted");

        const auto sidecarBefore = AgentMemoryStore::sidecarFileFor (eng.editFile());
        check (sidecarBefore.existsAsFile(), "the project sidecar file exists next to the edit file");

        auto agtSaFile = eng.sessionDir().getChildFile ("projects").getChildFile ("selftest-agtmem-saveas.tracktionedit");
        agtSaFile.deleteFile();
        AgentMemoryStore::sidecarFileFor (agtSaFile).deleteFile();
        check (ok (cmd (ops, "save_as", args1 ("file", agtSaFile.getFullPathName()))), "save_as (agent-memory sidecar) ok");
        check (AgentMemoryStore::sidecarFileFor (agtSaFile).existsAsFile(),
               "save_as copied the project-scope sidecar to the new location");

        auto projReadAfterSaveAs = cmd (ops, "agent_memory_read", args1 ("scope", "project"));
        check ((int) projReadAfterSaveAs.getProperty ("data", var()).getProperty ("items", var()).size() == 2,
               "both project notes survive Save-As via the copied sidecar");

        check (! ok (cmd (ops, "agent_memory_write", objN ({ { "scope", "project" } }))),
               "agent_memory_write project missing item fails cleanly");

        // ── delete / clear (M3): validation ──
        check (! ok (cmd (ops, "agent_memory_delete", objN ({ { "kind", "preference" }, { "ts", (int64) 1 } }))),
               "agent_memory_delete missing scope fails cleanly");
        check (! ok (cmd (ops, "agent_memory_delete", objN ({ { "scope", "global" }, { "kind", "preference" } }))),
               "agent_memory_delete missing ts fails cleanly");
        check (! ok (cmd (ops, "agent_memory_delete",
                          objN ({ { "scope", "global" }, { "kind", "nonsense" }, { "ts", (int64) 1 } }))),
               "agent_memory_delete global invalid kind fails cleanly");
        check (! ok (cmd (ops, "agent_memory_clear", objN ({ { "kind", "preference" } }))),
               "agent_memory_clear missing scope fails cleanly");
        check (! ok (cmd (ops, "agent_memory_clear",
                          objN ({ { "scope", "global" }, { "kind", "nonsense" } }))),
               "agent_memory_clear global invalid kind fails cleanly");

        // ── global delete: by ts with kind given, and with kind OMITTED (search all 3) ──
        {
            auto tsOfLastWrite = [&] (const juce::String& scope, const juce::String& kind) -> int64
            {
                auto r = cmd (ops, "agent_memory_read", objN ({ { "scope", scope }, { "kind", kind }, { "limit", 1 } }));
                return (int64) r.getProperty ("data", var()).getProperty ("items", var())[0].getProperty ("ts", var ((int64) 0));
            };

            check (ok (cmd (ops, "agent_memory_write",
                            objN ({ { "scope", "global" }, { "kind", "preference" }, { "item", "delete-target-1" } }))),
                   "seed for delete test 1 ok");
            const int64 ts1 = tsOfLastWrite ("global", "preference");
            check (ts1 != 0, "captured a real ts for the seeded item");

            check (! ok (cmd (ops, "agent_memory_delete",
                              objN ({ { "scope", "global" }, { "kind", "preference" }, { "ts", (int64) 999999 } }))),
                   "agent_memory_delete with a missing ts fails cleanly");

            auto beforeCount = cmd (ops, "agent_memory_read", objN ({ { "scope", "global" }, { "kind", "preference" }, { "limit", 1000 } }))
                                   .getProperty ("data", var()).getProperty ("items", var()).size();
            check (ok (cmd (ops, "agent_memory_delete",
                            objN ({ { "scope", "global" }, { "kind", "preference" }, { "ts", ts1 } }))),
                   "agent_memory_delete global (kind given) ok");
            auto afterCount = cmd (ops, "agent_memory_read", objN ({ { "scope", "global" }, { "kind", "preference" }, { "limit", 1000 } }))
                                  .getProperty ("data", var()).getProperty ("items", var()).size();
            check (afterCount == beforeCount - 1, "delete removed exactly one item from the preference store");

            // A second delete of the SAME ts now fails (already gone).
            check (! ok (cmd (ops, "agent_memory_delete",
                              objN ({ { "scope", "global" }, { "kind", "preference" }, { "ts", ts1 } }))),
                   "deleting an already-deleted ts fails cleanly");

            // kind OMITTED: search across all three global kind files. explicit:true
            // here because the earlier "cap eviction: an all-EXPLICIT store" checks
            // above left drum_pattern AT CAP with every item explicit — a non-explicit
            // write there would be correctly REJECTED (that's the whole point of that
            // policy); explicit:true evicts the oldest explicit one instead, same as
            // it would against a fresh/non-full store.
            check (ok (cmd (ops, "agent_memory_write",
                            objN ({ { "scope", "global" }, { "kind", "drum_pattern" }, { "explicit", true },
                                    { "item", "delete-target-2" } }))),
                   "seed for delete test 2 (drum_pattern) ok");
            const int64 ts2 = tsOfLastWrite ("global", "drum_pattern");
            check (ok (cmd (ops, "agent_memory_delete", objN ({ { "scope", "global" }, { "ts", ts2 } }))),
                   "agent_memory_delete global with NO kind finds the right file by searching all three");
            auto drumAfter = cmd (ops, "agent_memory_read", objN ({ { "scope", "global" }, { "kind", "drum_pattern" }, { "limit", 1000 } }))
                                 .getProperty ("data", var()).getProperty ("items", var());
            bool stillThere = false;
            for (int i = 0; i < drumAfter.size(); ++i)
                if (drumAfter[i].getProperty ("item", var()).toString() == "delete-target-2") stillThere = true;
            check (! stillThere, "the kind-omitted delete actually removed it from drum_pattern");
        }

        // ── global clear: per-kind vs whole-scope ──
        {
            check (ok (cmd (ops, "agent_memory_write",
                            objN ({ { "scope", "global" }, { "kind", "preference" }, { "item", "clear-pref-1" } }))),
                   "seed clear-pref-1 ok");
            check (ok (cmd (ops, "agent_memory_write",
                            objN ({ { "scope", "global" }, { "kind", "lyric_framework" }, { "item", "clear-lyric-1" } }))),
                   "seed clear-lyric-1 ok");

            auto clearPref = cmd (ops, "agent_memory_clear", objN ({ { "scope", "global" }, { "kind", "preference" } }));
            check (ok (clearPref), "agent_memory_clear global (kind given) ok");
            check ((int) clearPref.getProperty ("data", var()).getProperty ("cleared", -1) > 0,
                   "clear reports how many it removed");
            check ((int) cmd (ops, "agent_memory_read", objN ({ { "scope", "global" }, { "kind", "preference" } }))
                          .getProperty ("data", var()).getProperty ("items", var()).size() == 0,
                   "preference store is empty after a kind-scoped clear");
            check ((int) cmd (ops, "agent_memory_read", objN ({ { "scope", "global" }, { "kind", "lyric_framework" } }))
                          .getProperty ("data", var()).getProperty ("items", var()).size() > 0,
                   "a kind-scoped clear does NOT touch other kinds");

            check (ok (cmd (ops, "agent_memory_clear", args1 ("scope", "global"))),
                   "agent_memory_clear global with NO kind (whole-scope) ok");
            check ((int) cmd (ops, "agent_memory_read", objN ({ { "scope", "global" }, { "kind", "lyric_framework" } }))
                          .getProperty ("data", var()).getProperty ("items", var()).size() == 0,
                   "whole-scope clear also emptied lyric_framework");
            check ((int) cmd (ops, "agent_memory_read", objN ({ { "scope", "global" }, { "kind", "drum_pattern" } }))
                          .getProperty ("data", var()).getProperty ("items", var()).size() == 0,
                   "whole-scope clear also emptied drum_pattern (incl. the earlier undo-probe item)");
        }

        // ── project delete / clear: per-kind vs whole-scope, using the note field ──
        {
            check (ok (cmd (ops, "agent_memory_write",
                            objN ({ { "scope", "project" }, { "item", "project-delete-note" } }))),
                   "seed project note (kind=note) ok");
            check (ok (cmd (ops, "agent_memory_write",
                            objN ({ { "scope", "project" }, { "kind", "mood" }, { "item", "project-mood-x" } }))),
                   "seed project note (kind=mood) ok");

            auto projSnapshot = cmd (ops, "agent_memory_read", objN ({ { "scope", "project" }, { "limit", 1000 } }))
                                     .getProperty ("data", var()).getProperty ("items", var());
            int64 noteTs = 0;
            for (int i = 0; i < projSnapshot.size(); ++i)
                if (projSnapshot[i].getProperty ("item", var()).toString() == "project-delete-note")
                    noteTs = (int64) projSnapshot[i].getProperty ("ts", var ((int64) 0));
            check (noteTs != 0, "captured the project note's ts");

            // Wrong-kind filter refuses even with the right ts.
            check (! ok (cmd (ops, "agent_memory_delete",
                              objN ({ { "scope", "project" }, { "kind", "mood" }, { "ts", noteTs } }))),
                   "project delete with a kind filter that doesn't match the item's own kind fails cleanly");
            check (ok (cmd (ops, "agent_memory_delete", objN ({ { "scope", "project" }, { "ts", noteTs } }))),
                   "project delete by ts (no kind filter) ok");

            auto afterProjDelete = cmd (ops, "agent_memory_read", objN ({ { "scope", "project" }, { "limit", 1000 } }))
                                        .getProperty ("data", var()).getProperty ("items", var());
            bool moodStillThere = false;
            for (int i = 0; i < afterProjDelete.size(); ++i)
                if (afterProjDelete[i].getProperty ("item", var()).toString() == "project-mood-x") moodStillThere = true;
            check (moodStillThere, "deleting the \"note\"-kind item left the \"mood\"-kind item alone");

            auto clearMood = cmd (ops, "agent_memory_clear", objN ({ { "scope", "project" }, { "kind", "mood" } }));
            check (ok (clearMood), "project clear (kind=mood) ok");
            auto afterMoodClear = cmd (ops, "agent_memory_read", objN ({ { "scope", "project" }, { "limit", 1000 } }))
                                       .getProperty ("data", var()).getProperty ("items", var());
            bool anyMoodLeft = false;
            for (int i = 0; i < afterMoodClear.size(); ++i)
                if (afterMoodClear[i].getProperty ("kind", var()).toString() == "mood") anyMoodLeft = true;
            check (! anyMoodLeft, "project kind-scoped clear removed every \"mood\" item");

            check (ok (cmd (ops, "agent_memory_write",
                            objN ({ { "scope", "project" }, { "item", "one-more-project-note" } }))),
                   "seed one more project note before the whole-scope clear");
            check (ok (cmd (ops, "agent_memory_clear", args1 ("scope", "project"))),
                   "project clear with NO kind (whole-scope) ok");
            check ((int) cmd (ops, "agent_memory_read", objN ({ { "scope", "project" }, { "limit", 1000 } }))
                          .getProperty ("data", var()).getProperty ("items", var()).size() == 0,
                   "whole-scope project clear leaves the sidecar's notes empty");
        }

        // ── delete/clear mosh-log.jsonl posture: logged, undoable:false (they ARE mutations) ──
        {
            auto slog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
            bool deleteLogged = false, deleteUndoableFalse = false, clearLogged = false, clearUndoableFalse = false;
            for (auto& ln : StringArray::fromLines (slog))
            {
                if (ln.contains ("\"command\": \"agent_memory_delete\""))
                {
                    deleteLogged = true;
                    if (ln.contains ("\"undoable\": false")) deleteUndoableFalse = true;
                }
                if (ln.contains ("\"command\": \"agent_memory_clear\""))
                {
                    clearLogged = true;
                    if (ln.contains ("\"undoable\": false")) clearUndoableFalse = true;
                }
            }
            check (deleteLogged, "mosh-log.jsonl records agent_memory_delete");
            check (deleteUndoableFalse, "agent_memory_delete logged undoable:false");
            check (clearLogged, "mosh-log.jsonl records agent_memory_clear");
            check (clearUndoableFalse, "agent_memory_clear logged undoable:false");
        }
    }

    // ── DAW-parity P6: table-driven undo + persist matrices ──────────────────────
    // The G14 bug class (a setter that applies but bypasses the UndoManager) has now
    // recurred twice (set_track_volume, set_plugin_param) — exactly when hand-written
    // per-command checks should become a TABLE. Every declared mutating command is run
    // against a shared fixture and must (a) change the canonical snapshot, (b) restore
    // it EXACTLY on one undo; then the whole mutated state must survive save/reload
    // byte-for-byte (catches non-serialized CachedValues — fade/warp/loop-region fields
    // are the fresh risk surface). NOT in the table (each deliberately): composite/async
    // commands (add_drum_pattern, render_layer — own sections), service-spawning
    // commands (lyrics/generative — hermeticity), non-undoable preferences
    // (set_key/set_count_in/set_metronome — documented posture), read-only commands,
    // and MP lock behavior (LockManager::classify fails CLOSED to SessionGlobal by
    // design; per-command lock conduct is test_multiplayer_locks' lane).
    {
        section ("matrix: undo — every declared mutating command restores on ONE undo");

        // Canonical snapshot: strip the volatile subtrees so string equality means
        // STATE equality (transport rides its own rail; dirty flips on save/undo), and
        // round every numeric leaf to 1e-6 — the fader's dB↔position curve round-trips
        // with float epsilon (undo lands at -2.4e-07, not 0.0), which is restoration,
        // not drift. (v == 0.0 assignment also normalizes negative zero.)
        std::function<void (var&)> normNums = [&normNums] (var& v)
        {
            if (v.isDouble())
            {
                double d = std::round ((double) v * 1e6) / 1e6;
                if (d == 0.0) d = 0.0;
                v = d;
            }
            else if (v.isArray())
            {
                for (auto& e : *v.getArray()) normNums (e);
            }
            else if (auto* o = v.getDynamicObject())
            {
                for (auto& p : o->getProperties())
                {
                    var e = p.value;
                    normNums (e);
                    o->setProperty (p.name, e);
                }
            }
        };
        auto canon = [&]() -> String
        {
            auto s = ops.snapshot();
            if (auto* o = s.getDynamicObject())
            {
                o->removeProperty ("transport");
                o->removeProperty ("controller");
                if (auto* sess = o->getProperty ("session").getDynamicObject())
                {
                    sess->removeProperty ("dirty");
                    sess->removeProperty ("recentProjects");
                    sess->removeProperty ("recoveryAvailable");
                    sess->removeProperty ("recoverableCount");
                }
            }
            // An AUTOMATED parameter's live `value` is DERIVED, not persisted: it is the
            // curve evaluated at the playhead. The matrix sets param 0 to 0.7 and then adds
            // a single automation point of 0.5 — one point means the curve is constant 0.5
            // everywhere, so 0.7 is merely a stale live value that automation had not yet
            // overwritten, and a reload correctly re-derives 0.5. Comparing it across
            // save/reload compares a transient, exactly like `transport`/`dirty` above.
            // The `points` array IS the persisted truth and stays in the comparison.
            std::function<void (var&)> dropAutomatedValues = [&dropAutomatedValues] (var& v)
            {
                if (auto* arr = v.getArray())
                    for (auto& e : *arr) dropAutomatedValues (e);
                else if (auto* o = v.getDynamicObject())
                {
                    if (o->hasProperty ("automated") && (bool) o->getProperty ("automated"))
                        o->removeProperty ("value");
                    for (auto& p : o->getProperties())
                    {
                        auto child = p.value;
                        dropAutomatedValues (child);
                    }
                }
            };
            dropAutomatedValues (s);
            normNums (s);
            return JSON::toString (s, false);
        };
        auto rid = [] (const var& r, const char* k) {
            return r.getProperty ("data", var()).getProperty (k, var()).toString(); };

        // Fixture: a wave track with an EQ, a MIDI track with one OFF-GRID note (so
        // quantize genuinely mutates), a disposable track+clip for the remove cases,
        // and a bus for add_send.
        const auto mt   = rid (cmd (ops, "create_track", args1 ("name", "MxWave")), "trackId");
        const auto mwc  = rid (cmd (ops, "add_test_tone_clip",
                                    objN ({ { "trackId", mt }, { "seconds", 2.0 }, { "freq", 220.0 } })), "clipId");
        const auto eqR  = cmd (ops, "load_builtin", objN ({ { "trackId", mt }, { "type", "4bandEq" } }));
        const int  eqIx = (int) eqR.getProperty ("data", var()).getProperty ("index", -1);
        const auto mmt  = rid (cmd (ops, "create_track", args1 ("name", "MxMidi")), "trackId");
        const auto mmc  = rid (cmd (ops, "add_midi_clip",
                                    objN ({ { "trackId", mmt }, { "start", 0.0 }, { "length", 4.0 } })), "clipId");
        cmd (ops, "add_note", objN ({ { "clipId", mmc }, { "pitch", 60 }, { "start", 0.13 }, { "length", 0.5 } }));
        const auto dt   = rid (cmd (ops, "create_track", args1 ("name", "MxDisposable")), "trackId");
        const auto dc   = rid (cmd (ops, "add_test_tone_clip",
                                    objN ({ { "trackId", dt }, { "seconds", 1.0 }, { "freq", 330.0 } })), "clipId");
        const int  mbus = (int) cmd (ops, "create_bus", args1 ("name", "MxBus"))
                              .getProperty ("data", var()).getProperty ("busNumber", -1);
        check (mt.isNotEmpty() && mwc.isNotEmpty() && eqIx >= 0 && mmc.isNotEmpty()
               && dc.isNotEmpty() && mbus >= 0, "matrix fixture built");

        Array<var> rippleTracks; rippleTracks.add (var (mt));
        struct MatrixCase { String name; var args; };
        const MatrixCase table[] = {
            { "rename_track",         objN ({ { "trackId", mt }, { "name", "MxRenamed" } }) },
            { "set_track_volume",     objN ({ { "trackId", mt }, { "db", -7.0 } }) },
            { "set_track_pan",        objN ({ { "trackId", mt }, { "pan", 0.4 } }) },
            { "set_track_mute",       objN ({ { "trackId", mt }, { "mute", true } }) },
            { "set_track_solo",       objN ({ { "trackId", mt }, { "solo", true } }) },
            { "move_clip",            objN ({ { "clipId", mwc }, { "start", 5.0 } }) },
            { "rename_clip",          objN ({ { "clipId", mwc }, { "name", "MxClip" } }) },
            { "set_clip_gain",        objN ({ { "clipId", mwc }, { "gainDb", -5.0 } }) },
            { "set_clip_mute",        objN ({ { "clipId", mwc }, { "mute", true } }) },
            { "set_clip_fade",        objN ({ { "clipId", mwc }, { "fadeInSec", 0.3 }, { "fadeOutSec", 0.4 } }) },
            { "set_clip_crossfade",   objN ({ { "clipId", mwc }, { "enabled", true } }) },
            // stretch_clip BEFORE set_clip_reverse, deliberately. Reversing installs an
            // async proxy render; headless never pumps it, so the reversed clip's
            // getAudioFile().getLength() stays 0 and stretch_clip fails its
            // "source has no length" guard. Proven with --run-script: stretch→ok,
            // reverse→ok, stretch→"source has no length". That is a headless artifact of
            // the un-rendered proxy, not a persist bug — the undo matrix never saw it
            // because it undoes each mutation before applying the next, so stretch_clip
            // there always ran on an unreversed clip. (Whether stretch_clip should read
            // the SOURCE length instead of the proxy's is a real product question —
            // filed as G15 in docs/auto-loop/backlog.jsonl rather than changed here.)
            { "stretch_clip",         objN ({ { "clipId", mwc }, { "bars", 1 } }) },
            { "set_clip_reverse",     objN ({ { "clipId", mwc }, { "reversed", true } }) },
            { "set_clip_loop",        objN ({ { "clipId", mwc }, { "enabled", true }, { "start", 0.0 }, { "length", 1.0 } }) },
            { "set_clip_warp",        objN ({ { "clipId", mwc }, { "autoTempo", true } }) },
            { "normalize_clip",       objN ({ { "clipId", mwc }, { "targetDb", 0.0 } }) },
            { "duplicate_clip",       objN ({ { "clipId", mwc } }) },
            { "add_note",             objN ({ { "clipId", mmc }, { "pitch", 64 }, { "start", 1.0 }, { "length", 0.5 } }) },
            { "set_note",             objN ({ { "clipId", mmc }, { "noteIndex", 0 }, { "velocity", 70 } }) },
            { "quantize_notes",       objN ({ { "clipId", mmc }, { "division", 0.25 }, { "strength", 1.0 } }) },
            { "remove_note",          objN ({ { "clipId", mmc }, { "noteIndex", 0 } }) },
            { "load_builtin",         objN ({ { "trackId", mt }, { "type", "compressor" } }) },
            { "bypass_plugin",        objN ({ { "trackId", mt }, { "index", eqIx }, { "bypassed", true } }) },
            { "set_plugin_param",     objN ({ { "trackId", mt }, { "index", eqIx }, { "paramIndex", 0 }, { "value", 0.7 } }) },
            { "add_automation_point", objN ({ { "trackId", mt }, { "pluginIndex", eqIx }, { "paramIndex", 0 },
                                              { "time", 1.0 }, { "value", 0.5 } }) },
            { "set_master_volume",    objN ({ { "db", -5.0 } }) },
            { "set_master_pan",       objN ({ { "pan", -0.3 } }) },
            { "load_master_builtin",  objN ({ { "type", "delay" } }) },
            { "set_tempo",            objN ({ { "bpm", 100.0 } }) },
            { "insert_tempo_change",  objN ({ { "time", 4.0 }, { "bpm", 140.0 } }) },
            { "set_time_signature",   objN ({ { "numerator", 3 }, { "denominator", 4 } }) },
            { "insert_time_sig_change", objN ({ { "time", 8.0 }, { "numerator", 6 }, { "denominator", 8 } }) },
            { "create_track",         objN ({ { "name", "MxNew" } }) },
            { "remove_clip",          objN ({ { "clipId", dc } }) },
            { "remove_track",         objN ({ { "trackId", dt } }) },
            { "create_bus",           objN ({ { "name", "MxBus2" } }) },
            { "add_send",             objN ({ { "trackId", mt }, { "bus", mbus }, { "db", -3.0 } }) },
            { "delete_time_range",    objN ({ { "start", 0.5 }, { "end", 1.0 },
                                              { "trackIds", var (rippleTracks) }, { "ripple", true } }) },
        };

        for (const auto& mc : table)
        {
            const auto s0 = canon();
            check (ok (cmd (ops, mc.name, mc.args)), (mc.name + " ok").toRawUTF8());
            const auto s1 = canon();
            check (s1 != s0, (mc.name + " mutates the canonical snapshot").toRawUTF8());
            check (ok (cmd (ops, "undo")), (mc.name + " undo ok").toRawUTF8());
            check (canon() == s0, (mc.name + " ONE undo restores the canonical snapshot").toRawUTF8());
        }

        section ("matrix: persist — the fully-mutated state survives save/reload");
        // Re-apply the whole table cumulatively (no undo), then save → reload and demand
        // canonical equality: ANY non-serialized property among the mutated fields fails.
        for (const auto& mc : table)
            check (ok (cmd (ops, mc.name, mc.args)), (mc.name + " re-applied for persist").toRawUTF8());
        const auto preSave = canon();
        check (ok (cmd (ops, "save")), "matrix save ok");
        check (ok (cmd (ops, "reload")), "matrix reload ok");
        const auto postLoad = canon();
        // A bare equality failure here is opaque — the same problem the golden-audio gate
        // solved with a feature vector. Print the first divergence (with a little context)
        // so a red run names the non-serialized field instead of just asserting inequality.
        if (postLoad != preSave)
        {
            int i = 0;
            const int n = juce::jmin (preSave.length(), postLoad.length());
            while (i < n && preSave[i] == postLoad[i]) ++i;
            const int from = juce::jmax (0, i - 90);
            std::cerr << "  persist-diff @char " << i << "\n"
                      << "    saved:  ..." << preSave.substring (from, i + 90) << "\n"
                      << "    loaded: ..." << postLoad.substring (from, i + 90) << "\n";
        }
        check (postLoad == preSave, "matrix: save/reload round-trips EVERY mutated field (canonical snapshot equal)");
    }
}

} // namespace mosh
