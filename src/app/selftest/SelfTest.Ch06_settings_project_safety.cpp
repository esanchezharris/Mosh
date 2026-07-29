// ── SelfTest.Ch06_settings_project_safety.cpp — runSelfTest chapter 6 (RFC 002 A-PR6) ──
// Sections moved VERBATIM from src/app/SelfTest.cpp (pre-split lines 108-1034), in
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

void runChapter06_settings_project_safety (selftest::SelfTestCtx& ctx)
{
    using namespace juce;
    auto& eng = *ctx.eng;
    auto& ops = *ctx.ops;
    auto& eventTypes = ctx.eventTypes;
    auto& trackById = ctx.trackById;

    // ─── Wave: settings — audio device gate + project lifecycle ───
    // Headless (--selftest, no audio) eng.hasAudio()==false: the audio-engine gate
    // reports honestly, device commands return graceful errors (never crash), and
    // device enumeration content + a successful device round-trip + the FileChooser
    // dialog are hardware/GUI-gated (verified manually in the GUI — see the plan).
    section ("Wave: settings (audio gate / device / project lifecycle)");
    {
        auto sess = [&] { return ops.snapshot().getProperty ("session", var()); };

        // Audio-engine gate (MON-007 / FLY-004): honest false with no device.
        check (sess().hasProperty ("audioEnabled"), "snapshot session has audioEnabled gate field");
        check (! (bool) sess().getProperty ("audioEnabled", true), "audioEnabled is false headless (no device)");
        check (sess().hasProperty ("bitDepth"), "snapshot session has bitDepth readout");
        check (sess().hasProperty ("bufferSize"), "snapshot session has bufferSize readout");
        check (sess().hasProperty ("outputLatencyMs"), "snapshot session has outputLatencyMs readout");
        check (sess().hasProperty ("audioDeviceName"), "snapshot session has audioDeviceName readout");
        check (ops.snapshot().getProperty ("audio", var()).isObject(), "snapshot exposes the audio selection block");

        // list_audio_devices: read-only, ok + audioEnabled:false + well-formed types array.
        auto ld = cmd (ops, "list_audio_devices");
        check (ok (ld), "list_audio_devices ok");
        check (! (bool) ld["data"].getProperty ("audioEnabled", true), "list_audio_devices audioEnabled:false headless");
        {
            auto typesVar = ld["data"].getProperty ("types", var());   // bind temporary before getArray
            check (typesVar.isArray(), "list_audio_devices types is an array (shape, possibly empty headless)");
            auto srVar = ld["data"].getProperty ("sampleRates", var());
            check (srVar.isArray(), "list_audio_devices sampleRates is an array (empty with no open device)");
        }

        // set_audio_device / set_buffer_size: graceful no-device errResult, not a crash.
        auto sd = cmd (ops, "set_audio_device", objN ({{ "bufferSize", 256 }}));
        check (! ok (sd), "set_audio_device returns graceful error with no device");
        check (sd.getProperty ("error", var()).toString().contains ("no audio device"), "set_audio_device error mentions no audio device");
        auto sb = cmd (ops, "set_buffer_size", args1 ("bufferSize", 512));
        check (! ok (sb), "set_buffer_size returns graceful error with no device");

        // AUD-017 — retry_audio_device is the recovery half of the bounded startup open.
        // In a headless run audio was never REQUESTED, so it must refuse without going
        // anywhere near the HAL: that guard is what keeps --selftest hermetic (a retry
        // that opened a device here would make the harness depend on this machine's
        // audio hardware, and could hang exactly the way the ticket describes).
        check (! eng.audioRequested(), "headless selftest never requests audio (hermeticity precondition)");
        check (! eng.hasAudio(), "headless selftest has no open audio device");
        auto rad = cmd (ops, "retry_audio_device");
        check (! ok (rad), "retry_audio_device refuses when the session never wanted audio");
        check (rad.getProperty ("error", var()).toString().contains ("no audio device"),
               "retry_audio_device error mentions no audio device");
        check (eng.audioDeviceError().isEmpty(),
               "a refused retry leaves no phantom device error behind");

        // Project lifecycle — run entirely on TEMP files so the persistent session
        // the prior checks rely on is never corrupted. Restore it at the end.
        const auto sessionEdit = eng.editFile();
        const int tracksBefore = tracks (ops);
        check (tracksBefore > 0, "session has tracks before new_project (sanity)");

        // new_project -> ok, empty tracks, editFile path changed, fresh file on disk.
        auto npFile = eng.sessionDir().getChildFile ("projects").getChildFile ("selftest-new.tracktionedit");
        npFile.deleteFile();
        auto np = cmd (ops, "new_project", args1 ("name", "selftest-new"));
        check (ok (np), "new_project ok");
        check (tracks (ops) == 0, "new_project starts with zero tracks");
        const auto newEdit = sess().getProperty ("editFile", var()).toString();
        check (newEdit != sessionEdit.getFullPathName(), "new_project changed session.editFile path");
        check (File (newEdit).existsAsFile() && File (newEdit).getSize() > 0, "new_project wrote a fresh non-empty .tracktionedit");

        // create_track + save + open_project round-trips the track count.
        check (ok (cmd (ops, "create_track", args1 ("name", "RoundTrip"))), "create_track in new project ok");
        check (tracks (ops) == 1, "new project has 1 track after create_track");
        check (ok (cmd (ops, "save")), "save new project ok");
        // Swap to ANOTHER project, then open the saved one back.
        auto npFile2 = eng.sessionDir().getChildFile ("projects").getChildFile ("selftest-new2.tracktionedit");
        npFile2.deleteFile();
        check (ok (cmd (ops, "new_project", args1 ("name", "selftest-new2"))), "second new_project ok");
        check (tracks (ops) == 0, "second new project is empty");
        auto op = cmd (ops, "open_project", args1 ("file", newEdit));
        check (ok (op), "open_project ok");
        check (tracks (ops) == 1, "open_project round-trips the saved track count");

        // save_as(tmp) -> ok, file exists non-empty, subsequent save targets the new path.
        auto saFile = eng.sessionDir().getChildFile ("projects").getChildFile ("selftest-saveas.tracktionedit");
        saFile.deleteFile();
        auto sa = cmd (ops, "save_as", args1 ("file", saFile.getFullPathName()));
        check (ok (sa), "save_as ok");
        check (saFile.existsAsFile() && saFile.getSize() > 0, "save_as wrote a non-empty file");
        check (sess().getProperty ("editFile", var()).toString() == saFile.getFullPathName(), "save_as re-points session.editFile to the new path");
        check (ok (cmd (ops, "save")), "subsequent save (after save_as) ok");

        // open_project / new_project with bad args -> graceful validation errors.
        check (! ok (cmd (ops, "open_project", args1 ("file", "/no/such/file.tracktionedit"))), "open_project missing file errors");

        // Undo correctness + isolation. editFile is engine state (never on the Edit undo
        // stack), so we do NOT use it as the probe — that would pass even if undo were
        // broken. Instead: (1) prove undo genuinely works — a create_track is a real
        // transaction, so an undo must drop the track count by exactly one; (2) prove the
        // whole-Edit project commands leave NO stray transaction — immediately after
        // open_project (a fresh Edit with an empty undo stack) an undo must be a no-op
        // (count unchanged). A leaked empty transaction would instead walk back into the
        // freshly-opened Edit and the count check would fail.
        const int nBefore = tracks (ops);
        check (ok (cmd (ops, "create_track", args1 ("name", "UndoProbe"))), "create_track undo probe ok");
        check (tracks (ops) == nBefore + 1, "create_track added a track");
        check (ok (cmd (ops, "undo")), "undo ok");
        check (tracks (ops) == nBefore, "undo reverted the create_track (count dropped by 1)");
        // Re-open the saved project: its undo stack is empty, so an immediate undo must be
        // a no-op, proving new/open/save_as pushed no stray transaction.
        check (ok (cmd (ops, "open_project", args1 ("file", newEdit))), "re-open saved project ok");
        const int nFresh = tracks (ops);
        check (ok (cmd (ops, "undo")), "undo on freshly-opened project ok");
        check (tracks (ops) == nFresh, "undo is a no-op after open_project (no stray transaction leaked)");
        check (ops.snapshot().hasProperty ("tracks"), "snapshot still well-formed after project-undo isolation");

        // JSONL: device + project commands logged undoable:false.
        auto slog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        check (slog.contains ("set_audio_device"), "JSONL records set_audio_device");
        check (slog.contains ("new_project"), "JSONL records new_project");
        check (slog.contains ("save_as"), "JSONL records save_as");
        bool devPref = false, newPref = false, saPref = false;
        for (auto& ln : juce::StringArray::fromLines (slog))
        {
            if (ln.contains ("\"command\": \"set_audio_device\"") && ln.contains ("\"undoable\": false")) devPref = true;
            if (ln.contains ("\"command\": \"new_project\"") && ln.contains ("\"undoable\": false")) newPref = true;
            if (ln.contains ("\"command\": \"save_as\"") && ln.contains ("\"undoable\": false")) saPref = true;
        }
        check (devPref, "set_audio_device logged undoable:false (machine preference)");
        check (newPref, "new_project logged undoable:false (whole-Edit replacement)");
        check (saPref, "save_as logged undoable:false (whole-Edit persist)");

        // Restore the in-memory Edit to the harness session edit so in-process state is
        // consistent after the temp-file project swaps. (The session-selftest dir is wiped
        // at startup, so idempotency across runs does not depend on this.)
        check (ok (cmd (ops, "open_project", args1 ("file", sessionEdit.getFullPathName()))), "restored the session edit (clean teardown)");
        npFile.deleteFile(); npFile2.deleteFile(); saFile.deleteFile();
    }

    // ─── Project safety: auto-save / dirty flag (DATA-LOSS gap 1) ───
    // Closing the window with unsaved changes used to lose work (no save-on-quit, no
    // auto-save). The fix is a dirty flag every mutation sets, cleared on save; the GUI
    // app drives a periodic auto-save + save-on-quit off it. The timer itself is GUI-only
    // (no message loop headless), so we test the underlying mechanism directly.
    section ("Project safety: auto-save / dirty flag (gap 1)");
    {
        auto sess = [&] { return ops.snapshot().getProperty ("session", var()); };
        const int n0 = tracks (ops);

        // A clean save zeroes the flag; the snapshot mirrors it.
        check (ok (cmd (ops, "save")), "save establishes a clean baseline");
        check (! eng.isDirty(), "engine clean immediately after save");
        check (! (bool) sess().getProperty ("dirty", true), "snapshot.session.dirty false when clean");

        // A mutating command marks the Edit dirty (so auto-save / quit will persist it).
        check (ok (cmd (ops, "create_track", args1 ("name", "DirtyProbe"))), "create_track ok");
        check (eng.isDirty(), "mutating command marks the engine dirty");
        check ((bool) sess().getProperty ("dirty", false), "snapshot.session.dirty true when dirty");

        // saveIfDirty persists + clears; a second call is a no-op (nothing to save).
        check (eng.saveIfDirty(), "saveIfDirty saves when dirty (returns true)");
        check (! eng.isDirty(), "engine clean after saveIfDirty");
        check (! eng.saveIfDirty(), "saveIfDirty is a no-op when clean (returns false)");

        // The plain save command also clears the flag.
        check (ok (cmd (ops, "create_track", args1 ("name", "DirtyProbe2"))), "second mutation ok");
        check (eng.isDirty(), "dirty again after another mutation");
        check (ok (cmd (ops, "save")), "save command ok");
        check (! eng.isDirty(), "save command clears the dirty flag");

        // Teardown: revert the two probe tracks (each its own transaction) + persist clean.
        check (ok (cmd (ops, "undo")), "undo probe 2"); check (ok (cmd (ops, "undo")), "undo probe 1");
        check (tracks (ops) == n0, "probe tracks reverted (clean teardown)");
        cmd (ops, "save");
    }

    // ─── Project safety: reopen last project on relaunch (gap 2) ───
    // Relaunch always loaded the fixed session.tracktionedit, never the project the user
    // last worked in (no Recent list either). The fix persists session/last-project.json
    // on every new/open/save-as; the ctor resolves the startup edit via startupEditFile().
    // The app-restart path itself went untested (why this gap was undetected), so we test
    // the decision method directly here.
    section ("Project safety: reopen last project on relaunch (gap 2)");
    {
        const auto sessionEdit = eng.editFile();
        const auto defaultEdit = eng.sessionDir().getChildFile ("session.tracktionedit");
        const auto lastJson    = eng.sessionDir().getChildFile ("last-project.json");

        // (a) rememberProject persists the path; startupEditFile resolves to it — i.e. a
        // relaunch would reopen it (this is the previously-untested app-restart decision).
        auto probe = eng.sessionDir().getChildFile ("projects").getChildFile ("relaunch-probe.tracktionedit");
        probe.getParentDirectory().createDirectory();
        probe.replaceWithText ("<EDIT/>");   // a real file so existsAsFile() passes
        eng.rememberProject (probe);
        check (lastJson.existsAsFile(), "rememberProject writes last-project.json");
        check (eng.startupEditFile() == probe, "startupEditFile resolves to the remembered project (relaunch reopens it)");

        // (b) a missing remembered project falls back to the default session file.
        eng.rememberProject (eng.sessionDir().getChildFile ("projects").getChildFile ("does-not-exist.tracktionedit"));
        check (eng.startupEditFile() == defaultEdit, "startupEditFile falls back to session.tracktionedit when the last project is missing");

        // (c) new_project records itself as last + appears in the snapshot Recent list,
        // newest-first; open_project updates it too.
        check (ok (cmd (ops, "new_project", args1 ("name", "relaunch-A"))), "new_project relaunch-A ok");
        const auto editA = eng.editFile();
        check (eng.startupEditFile() == editA, "new_project updates the remembered last project");
        check (ok (cmd (ops, "new_project", args1 ("name", "relaunch-B"))), "new_project relaunch-B ok");
        const auto editB = eng.editFile();
        auto recents = ops.snapshot().getProperty ("session", var()).getProperty ("recentProjects", var());
        check (recents.isArray() && recents.size() >= 2, "snapshot.session.recentProjects lists projects");
        check (recents[0].getProperty ("path", var()).toString() == editB.getFullPathName(), "recentProjects is newest-first (relaunch-B first)");
        check (ok (cmd (ops, "open_project", args1 ("file", editA.getFullPathName()))), "open_project relaunch-A ok");
        check (eng.startupEditFile() == editA, "open_project updates the remembered last project");

        // teardown: restore the harness session edit for later sections.
        check (ok (cmd (ops, "open_project", args1 ("file", sessionEdit.getFullPathName()))), "restored the session edit (gap2 teardown)");
        probe.deleteFile();
    }

    // ─── Project safety: open_recent by index (AL-007) ───
    // The Recent list (snapshot.session.recentProjects) needs a first-class "open the
    // Nth recent project" command so the UI / agent reopen by position without
    // round-tripping a path that may have been pruned. open_recent resolves the index
    // against the SAME existing-file Recent list the snapshot exposes; out-of-range and
    // already-deleted entries degrade to clean error results. It is NOT undoable (it
    // replaces the whole Edit, like open_project).
    section ("Project safety: open_recent by index (AL-007)");
    {
        const auto sessionEdit = eng.editFile();

        // Seed two distinct projects so the Recent list has a stable newest-first order:
        // open A then B → recent[0]=B (current, newest), recent[1]=A.
        check (ok (cmd (ops, "new_project", args1 ("name", "recent-A"))), "new_project recent-A ok");
        const auto editA = eng.editFile();
        check (ok (cmd (ops, "new_project", args1 ("name", "recent-B"))), "new_project recent-B ok");
        const auto editB = eng.editFile();

        auto recents = ops.snapshot().getProperty ("session", var()).getProperty ("recentProjects", var());
        check (recents.isArray() && recents.size() >= 2, "recentProjects has >= 2 entries for the index test");
        check (recents[0].getProperty ("path", var()).toString() == editB.getFullPathName(), "recent[0] is the newest project (B)");

        // (a) open_recent index 1 reopens the OLDER project (A) — proves index→path resolution.
        check (ok (cmd (ops, "open_recent", args1 ("index", 1))), "open_recent index 1 ok");
        check (eng.editFile() == editA, "open_recent index 1 opened the older project (A)");
        check (eng.startupEditFile() == editA, "open_recent updates the remembered last project");

        // (b) index 0 reopens the most-recent. After (a), opening A bumped it to recent[0],
        //     so index 0 now re-resolves to A (the live list, not a stale snapshot).
        check (ok (cmd (ops, "open_recent", args1 ("index", 0))), "open_recent index 0 ok");
        check (eng.editFile() == editA, "open_recent index 0 opened the most-recent project");

        // (c) validation: missing / negative / out-of-range index → clean error, no swap.
        const auto before = eng.editFile();
        check (! ok (cmd (ops, "open_recent", var (new DynamicObject()))), "open_recent without an index errors");
        check (! ok (cmd (ops, "open_recent", args1 ("index", -1))), "open_recent with a negative index errors");
        check (! ok (cmd (ops, "open_recent", args1 ("index", 999))), "open_recent with an out-of-range index errors");
        check (eng.editFile() == before, "a rejected open_recent leaves the current Edit untouched");

        // (d) a pruned (no-longer-on-disk) recent entry is skipped by recentProjects, so an
        //     index that pointed at it now resolves past it or errors — never opens a ghost.
        editB.deleteFile();
        auto pruned = ops.snapshot().getProperty ("session", var()).getProperty ("recentProjects", var());
        bool ghostListed = false;
        for (int i = 0; i < pruned.size(); ++i)
            if (pruned[i].getProperty ("path", var()).toString() == editB.getFullPathName())
                ghostListed = true;
        check (! ghostListed, "a deleted project is dropped from recentProjects (no ghost index)");

        // (e) leaving a project and coming straight back by index. The "outgoing project
        //     stays in Recent" invariant itself is pinned at the harness's FIRST project
        //     op (see the G1 export section) — by this point every project here has
        //     already been remembered as some earlier command's INCOMING file, so a check
        //     placed here would pass with or without that fix. What this adds is the
        //     round trip: leave, then reopen the one you left, by position.
        {
            const auto leaving = eng.editFile();
            check (ok (cmd (ops, "new_project", args1 ("name", "recent-C"))), "new_project recent-C ok");
            auto rc = ops.snapshot().getProperty ("session", var()).getProperty ("recentProjects", var());
            check (rc.size() > 1 && rc[1].getProperty ("path", var()).toString() == leaving.getFullPathName(),
                   "the project we left sits directly behind the new one in Recent");
            check (ok (cmd (ops, "open_recent", args1 ("index", 1))), "open_recent index 1 reopens the project we left");
            check (eng.editFile() == leaving, "the left-behind project reopened by index");
        }

        // teardown: restore the harness session edit for later sections.
        check (ok (cmd (ops, "open_project", args1 ("file", sessionEdit.getFullPathName()))), "restored the session edit (AL-007 teardown)");
    }

    // ─── Project safety: portable projects + relink (gap 3) ───
    // Projects shared one absolute-path audio pool (~/Library/Mosh/session), so a saved/
    // copied .tracktionedit pointed back at the pool and broke when moved. The fix sets a
    // filePathResolver and consolidates referenced audio into a project-local audio/ dir on
    // Save As (relative refs → portable), plus a relink_clip command + a sourceMissing flag.
    section ("Project safety: portable projects + relink (gap 3)");
    {
        const auto sessionEdit = eng.editFile();
        const auto poolAudio   = eng.sessionDir().getChildFile ("audio");

        // local snapshot helpers (the trackById/clip helpers elsewhere are out of scope here)
        auto trackVar = [&] (const String& tid) -> var {
            auto trks = ops.snapshot().getProperty ("tracks", var());
            for (int i = 0; i < trks.size(); ++i)
                if (trks[i].getProperty ("id", var()).toString() == tid) return trks[i];
            return var();
        };
        auto clipById = [&] (const String& cid) -> var {
            auto trks = ops.snapshot().getProperty ("tracks", var());
            for (int i = 0; i < trks.size(); ++i) {
                auto cl = trks[i].getProperty ("clips", var());
                for (int j = 0; j < cl.size(); ++j)
                    if (cl[j].getProperty ("id", var()).toString() == cid) return cl[j];
            }
            return var();
        };

        // A project with one wave clip whose audio lives in the shared session pool.
        check (ok (cmd (ops, "new_project", args1 ("name", "portable-src"))), "new_project portable-src ok");
        auto trk = cmd (ops, "create_track", args1 ("name", "Aud"));
        const auto trackId = trk["data"].getProperty ("trackId", var()).toString();
        check (trackId.isNotEmpty(), "create_track returned a trackId");
        check (ok (cmd (ops, "add_test_tone_clip", objN ({ { "trackId", trackId }, { "seconds", 1 }, { "freq", 330 } }))), "add_test_tone_clip ok");
        const auto poolSrc = File (firstTrack (ops)["clips"][0].getProperty ("sourceFile", var()).toString());
        check (poolSrc.isAChildOf (poolAudio), "clip audio starts in the shared session pool");

        // DRM-001 — a drum track's sampler sounds (the bundled kit, stored as ABSOLUTE
        // bundle paths) must ALSO consolidate into the portable project, or the project
        // breaks when moved to another machine/install.
        check (ok (cmd (ops, "create_track", objN ({ { "name", "Kit" }, { "type", "drum" } }))), "drum track for portability ok");

        // Save As to a standalone dir OUTSIDE the pool → consolidation copies audio local.
        auto destDir  = selftestTempPath (eng, "portable-src");
        destDir.deleteRecursively(); destDir.createDirectory();
        auto destEdit = destDir.getChildFile ("portable.tracktionedit");
        check (ok (cmd (ops, "save_as", args1 ("file", destEdit.getFullPathName()))), "save_as ok");
        check (destDir.getChildFile ("audio").isDirectory(), "save_as created a project-local audio/ dir");
        check (destDir.getChildFile ("audio").getNumberOfChildFiles (File::findFiles) >= 1, "save_as consolidated audio into the project");
        // The drum kit's sample (e.g. kick.wav) must be copied into the project audio/ too.
        check (destDir.getChildFile ("audio").getChildFile ("kick.wav").existsAsFile(),
               "save_as consolidated the drum-kit sampler sounds into the project");

        // On-disk edit must reference audio RELATIVELY (portable), never the shared pool.
        const auto xml = destEdit.loadFileAsString();
        check (! xml.contains (poolAudio.getFullPathName()), "saved edit has no shared-pool absolute audio path");
        check (! xml.contains ("Resources/drumkits"),
               "saved edit references the kit by a relative path, not the absolute app-bundle path");
        check (xml.contains ("audio/") && ! xml.contains ("../audio"), "saved edit references audio by a co-located relative path (no ../)");

        // PROVE portability: copy the whole project elsewhere, hide the ORIGINAL pool source
        // so resolution can ONLY succeed via the co-located copy, then open the copy.
        auto moved = selftestTempPath (eng, "portable-moved");
        moved.deleteRecursively();
        check (destDir.copyDirectoryTo (moved), "copied the project dir to a new location");
        auto poolBak = poolSrc.getSiblingFile (poolSrc.getFileName() + ".gap3bak");
        poolBak.deleteFile(); poolSrc.moveFileTo (poolBak);     // hide the original
        check (ok (cmd (ops, "open_project", args1 ("file", moved.getChildFile ("portable.tracktionedit").getFullPathName()))), "open the moved project ok");
        auto movedClip = firstTrack (ops)["clips"][0];
        check (! (bool) movedClip.getProperty ("sourceMissing", true), "moved project's clip resolves to co-located audio (portable)");
        check (File (movedClip.getProperty ("sourceFile", var()).toString()).isAChildOf (moved), "resolved source is inside the moved project dir");
        poolBak.moveFileTo (poolSrc);                            // restore the pool original

        // relink: a clip whose source goes missing reports sourceMissing; relink_clip fixes it.
        check (ok (cmd (ops, "open_project", args1 ("file", sessionEdit.getFullPathName()))), "reopened session edit");
        auto rtrk = cmd (ops, "create_track", args1 ("name", "Relink"));
        const auto rtid = rtrk["data"].getProperty ("trackId", var()).toString();
        check (ok (cmd (ops, "add_test_tone_clip", objN ({ { "trackId", rtid }, { "seconds", 1 }, { "freq", 440 }, { "name", "relinkme" } }))), "add relink probe clip ok");
        auto rClip = trackVar (rtid).getProperty ("clips", var())[0];
        const auto rClipId = rClip.getProperty ("id", var()).toString();
        File rSrc (rClip.getProperty ("sourceFile", var()).toString());
        check (! (bool) rClip.getProperty ("sourceMissing", true), "relink probe clip initially present");
        // copy to a relink target, then delete the original source
        auto relinkTarget = eng.sessionDir().getChildFile ("audio").getChildFile ("relink-target.wav");
        relinkTarget.deleteFile(); rSrc.copyFileTo (relinkTarget); rSrc.deleteFile();
        check ((bool) clipById (rClipId).getProperty ("sourceMissing", false), "deleted source reports sourceMissing");
        check (ok (cmd (ops, "relink_clip", objN ({ { "clipId", rClipId }, { "file", relinkTarget.getFullPathName() } }))), "relink_clip ok");
        check (! (bool) clipById (rClipId).getProperty ("sourceMissing", true), "relink_clip clears sourceMissing");

        // teardown
        check (ok (cmd (ops, "open_project", args1 ("file", sessionEdit.getFullPathName()))), "restored the session edit (gap3 teardown)");
        destDir.deleteRecursively(); moved.deleteRecursively();
    }

    // ─── AL-009 — Save-As render-artifact consolidation + portability ───
    // A Tier-B render layer's cacheArtifact (the file freeze_layer / re-accept_render
    // depend on) is written by finalizeRender as an ABSOLUTE path into the shared session
    // pool, NOT the project dir — so before AL-009 a Save-As'd + moved project's render
    // either pointed back at a pool that no longer exists (freeze/accept failed) or simply
    // wasn't portable. The fix consolidates each render artifact into the project's
    // audio/renders/ on Save-As, re-points cacheArtifact RELATIVE, and resolves it
    // move-aware at every read. This proves the rendered audio survives a project move.
    section ("AL-009: Save-As render-artifact consolidation + portability");
    {
        const auto sessionEdit = eng.editFile();
        const auto poolDir     = eng.sessionDir();

        auto trackById2 = [&] (const String& tid) -> var {
            auto trks = ops.snapshot().getProperty ("tracks", var());
            for (int i = 0; i < trks.size(); ++i)
                if (trks[i].getProperty ("id", var()).toString() == tid) return trks[i];
            return var();
        };
        auto renderLayerOf = [&] (const String& tid, const String& cid) -> var {
            auto trk = trackById2 (tid);
            if (auto* arr = trk.getProperty ("clips", var()).getArray())
                for (auto& c : *arr)
                    if (c.getProperty ("id", var()).toString() == cid)
                        return c.getProperty ("renderLayer", var());
            return {};
        };
        // Find the (only) clip carrying a render layer, by scanning the live snapshot — robust
        // to any clip-id reassignment a reload might do (the open-the-moved-project step below).
        auto clipWithRenderLayer = [&] () -> String {
            auto trks = ops.snapshot().getProperty ("tracks", var());
            for (int i = 0; i < trks.size(); ++i)
                if (auto* arr = trks[i].getProperty ("clips", var()).getArray())
                    for (auto& c : *arr)
                        if ((bool) c.getProperty ("hasRenderLayer", false))
                            return c.getProperty ("id", var()).toString();
            return {};
        };

        // Fresh project with a clip that carries a rendered layer (fake adapter, deterministic).
        check (ok (cmd (ops, "new_project", args1 ("name", "renders-portable"))), "new_project renders-portable ok");
        const auto rt  = cmd (ops, "create_track", args1 ("name", "Gen"))["data"].getProperty ("trackId", var()).toString();
        const auto rcid = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", rt }, { "seconds", 1.0 }, { "freq", 196.0 }}))["data"]
                              .getProperty ("clipId", var()).toString();
        check (ok (cmd (ops, "create_render_layer", objN ({{ "clipId", rcid }, { "adapter", "fake" }}))), "create_render_layer (fake) ok");
        cmd (ops, "set_render_param", objN ({{ "clipId", rcid }, { "seed", 7 }}));
        auto rr = cmd (ops, "render_layer", objN ({{ "clipId", rcid }, { "wait", true }}));
        check (ok (rr), "render_layer ok (artifact produced in the session pool)");
        check ((bool) renderLayerOf (rt, rcid).getProperty ("hasArtifact", false), "render produced a cached artifact");

        // Save As to a standalone dir OUTSIDE the pool → render artifacts consolidate local.
        auto destDir  = selftestTempPath (eng, "renders-portable");
        destDir.deleteRecursively(); destDir.createDirectory();
        auto destEdit = destDir.getChildFile ("renders.tracktionedit");
        check (ok (cmd (ops, "save_as", args1 ("file", destEdit.getFullPathName()))), "save_as ok");
        auto rendersDir = destDir.getChildFile ("audio").getChildFile ("renders");
        check (rendersDir.isDirectory(), "save_as created a project-local audio/renders/ dir");
        check (rendersDir.getNumberOfChildFiles (File::findFiles) >= 1, "save_as consolidated the render artifact into the project");
        check ((bool) renderLayerOf (rt, rcid).getProperty ("hasArtifact", false), "render artifact still resolves after consolidation (relative)");

        // The on-disk edit must reference the render artifact RELATIVELY (portable), never
        // the absolute session pool — otherwise the move below would break.
        const auto xml = destEdit.loadFileAsString();
        check (! xml.contains (poolDir.getFullPathName()), "saved edit has no absolute session-pool render path");
        check (xml.contains ("audio/renders/") && ! xml.contains ("../audio/renders/"),
               "saved edit references the render artifact by a co-located relative path (no ../)");

        // PROVE portability: copy the whole project elsewhere, DELETE the original pool
        // render so resolution can ONLY succeed via the co-located copy, then open the copy
        // and prove freeze/accept (the artifact-gated ops) still work — the AL-009 payoff.
        auto moved = selftestTempPath (eng, "renders-moved");
        moved.deleteRecursively();
        check (destDir.copyDirectoryTo (moved), "copied the render project to a new location");
        poolDir.getChildFile ("renders").deleteRecursively();   // hide the original pool artifact
        check (ok (cmd (ops, "open_project", args1 ("file", moved.getChildFile ("renders.tracktionedit").getFullPathName()))), "open the moved render project ok");
        const auto mcid = clipWithRenderLayer();   // re-derive from the reloaded project (id-reassign safe)
        check (mcid.isNotEmpty(), "moved project restored the clip + its render layer");
        bool movedHasArtifact = false;
        { auto trks = ops.snapshot().getProperty ("tracks", var());
          for (int i = 0; i < trks.size() && ! movedHasArtifact; ++i)
            if (auto* arr = trks[i].getProperty ("clips", var()).getArray())
                for (auto& c : *arr)
                    if (c.getProperty ("id", var()).toString() == mcid)
                        movedHasArtifact = (bool) c.getProperty ("renderLayer", var()).getProperty ("hasArtifact", false); }
        check (movedHasArtifact, "moved project's render artifact resolves to the co-located copy (portable)");
        check (ok (cmd (ops, "freeze_layer", args1 ("clipId", mcid))),
               "freeze_layer succeeds on the moved project (artifact survived the move)");
        // The in-place render survived the move: accept is a no-op for the wave clip (no lane),
        // and the layer is still applied in place (the clip plays the consolidated render).
        const int tracksBeforeAccept = tracks (ops);
        check (ok (cmd (ops, "accept_render", args1 ("clipId", mcid))), "accept_render ok on the moved project (no-op for wave)");
        check (tracks (ops) == tracksBeforeAccept, "wave accept creates no lane on the moved project");

        // teardown — restore the session edit for later sections.
        check (ok (cmd (ops, "open_project", args1 ("file", sessionEdit.getFullPathName()))), "restored the session edit (AL-009 teardown)");
        destDir.deleteRecursively(); moved.deleteRecursively();
    }

    // ─── PRF-001 — multicore audio thread preference + readout ───
    // A GENUINE, load-bearing knob (drives EngineBehaviour::getNumberOfCPUsToUseForAudio()
    // -> setNumThreads(N-1) on the parallel graph), valid headless (no audio device).
    // Only the command path / clamping / readout / JSONL are headless-testable; the
    // audible single- vs multi-thread A/B and the live thread-pool-resize gap are
    // hardware-gated (need an open device + real DSP load).
    section ("PRF-001 (multicore audio threads)");
    {
        auto sess = [&] { return ops.snapshot().getProperty ("session", var()); };

        // Snapshot readout: availableCores >= 1, audioThreads present + in [1..cores].
        check (sess().hasProperty ("availableCores"), "snapshot session has availableCores readout");
        const int cores = (int) sess().getProperty ("availableCores", 0);
        check (cores >= 1, "availableCores >= 1");
        check (sess().hasProperty ("audioThreads"), "snapshot session has audioThreads readout");
        const int threads0 = (int) sess().getProperty ("audioThreads", 0);
        check (threads0 >= 1 && threads0 <= cores, "audioThreads within [1..availableCores]");
        check ((bool) sess().getProperty ("audioThreadsAuto", false), "audioThreads defaults to auto (resolved core count)");

        // set_audio_threads applies WITHOUT an audio device (proves it is not device-gated,
        // unlike set_buffer_size) and echoes availableCores + audioThreads in the result.
        const int want = cores >= 2 ? 2 : 1;
        auto st = cmd (ops, "set_audio_threads", args1 ("threads", want));
        check (ok (st), "set_audio_threads ok with no audio device (not device-gated)");
        check ((int) st["data"].getProperty ("availableCores", -1) == cores, "set_audio_threads echoes availableCores");
        check ((int) st["data"].getProperty ("audioThreads", -1) == want, "set_audio_threads echoes the resolved audioThreads");

        // Fresh snapshot reflects the new value (round-trip) and is no longer 'auto'.
        check ((int) sess().getProperty ("audioThreads", -1) == want, "snapshot reflects new audioThreads after set");
        check (! (bool) sess().getProperty ("audioThreadsAuto", true), "audioThreadsAuto is false after an explicit set");

        // Out-of-range -> graceful errResult, never a crash. Above-cores clamps to cores.
        check (! ok (cmd (ops, "set_audio_threads", args1 ("threads", 0))), "set_audio_threads threads=0 errors gracefully");
        check (! ok (cmd (ops, "set_audio_threads", args1 ("threads", 99999))), "set_audio_threads threads=99999 errors gracefully");
        auto clampHigh = cmd (ops, "set_audio_threads", args1 ("threads", cores + 1));
        check (ok (clampHigh), "set_audio_threads cores+1 ok (clamps)");
        check ((int) clampHigh["data"].getProperty ("audioThreads", -1) == cores, "set_audio_threads clamps cores+1 down to availableCores");

        // Missing arg -> errResult.
        check (! ok (cmd (ops, "set_audio_threads", var())), "set_audio_threads missing threads errors");

        // JSONL: logged undoable:false (machine preference) — mirror the devPref check.
        auto tlog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        check (tlog.contains ("set_audio_threads"), "JSONL records set_audio_threads");
        bool thrPref = false;
        for (auto& ln : juce::StringArray::fromLines (tlog))
            if (ln.contains ("\"command\": \"set_audio_threads\"") && ln.contains ("\"undoable\": false")) thrPref = true;
        check (thrPref, "set_audio_threads logged undoable:false (machine preference)");

        // Read-only: snapshot() must not append a set_audio_threads log line (the
        // readout-only path never writes). Count occurrences before/after a snapshot.
        const auto countLines = [&] (const String& needle) {
            int n = 0;
            for (auto& ln : juce::StringArray::fromLines (
                     eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString()))
                if (ln.contains (needle)) ++n;
            return n;
        };
        const int before = countLines ("\"command\": \"set_audio_threads\"");
        ops.snapshot(); ops.snapshot();
        check (countLines ("\"command\": \"set_audio_threads\"") == before, "snapshot does not log set_audio_threads (read-only readout)");

        // Restore auto so later blocks see the default. (threads=cores then... there is
        // no 'set to auto' arg; leaving an explicit pref is harmless — it resolves to a
        // real value. We simply assert the restored value is valid.)
        check (ok (cmd (ops, "set_audio_threads", args1 ("threads", cores))), "restore set_audio_threads to all cores ok");
    }

    // ─── BRW-001 — content/file browser (read-only list_directory + import reuse) ───
    // list_directory is STRICTLY READ-ONLY (no log / transaction / event), never
    // recurses, never writes, and is graceful on missing / denied / relative paths.
    // Import reuses the existing import_clip command (no new mutation path). The GUI
    // browsing experience (popover, folder descent, breadcrumb) is hardware/GUI-gated;
    // the command shape, filtering, navigation, safety + the import seam are headless.
    section ("BRW-001 (content browser / list_directory)");
    {
        // Seed a known dir under the session: one audio file + one non-audio file +
        // one sub-directory. The session-selftest dir is wiped each run, so seed fresh.
        auto browseDir = eng.sessionDir().getChildFile ("browse-test");
        browseDir.deleteRecursively();
        browseDir.createDirectory();
        auto wav = browseDir.getChildFile ("probe-tone.wav");
        // Reuse the engine's deterministic test-tone WAV generator (writes to the audio
        // dir), then copy it into browseDir so we control the listing contents exactly.
        auto srcTone = eng.generateTestTone (0.25, 330.0, "browse-probe");
        check (srcTone.existsAsFile() && srcTone.copyFileTo (wav), "seeded a real .wav into the browse dir");
        auto txt = browseDir.getChildFile ("notes.txt");
        txt.replaceWithText ("not audio");
        auto childDir = browseDir.getChildFile ("subfolder");
        childDir.createDirectory();

        // Capture log-line + event counts to prove read-only.
        const auto logCount = [&] (const String& needle) {
            int n = 0;
            for (auto& ln : juce::StringArray::fromLines (
                     eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString()))
                if (ln.contains (needle)) ++n;
            return n;
        };
        const int ldLogBefore = logCount ("list_directory");
        eventTypes.clear();

        auto ld = cmd (ops, "list_directory", args1 ("path", browseDir.getFullPathName()));
        check (ok (ld), "list_directory ok");
        auto data = ld["data"];
        check ((bool) data.getProperty ("exists", false), "list_directory exists:true for a real dir");
        check (data.getProperty ("path", var()).toString() == browseDir.getFullPathName(), "list_directory path round-trips (normalized)");

        // roots is a non-empty array containing a Home entry pointing at a real dir.
        {
            auto rootsVar = data.getProperty ("roots", var());
            check (rootsVar.isArray() && rootsVar.size() > 0, "list_directory roots is a non-empty array");
            bool homeOk = false;
            if (auto* ra = rootsVar.getArray())
                for (auto& r : *ra)
                    if (r.getProperty ("name", var()).toString() == "Home"
                        && File (r.getProperty ("path", var()).toString()).isDirectory())
                        homeOk = true;
            check (homeOk, "list_directory roots includes a Home pointing at a real directory");
        }

        // entries: the seeded .wav is present (isDir:false, size>0); the .txt is filtered
        // out; the subfolder is present (isDir:true).
        bool sawWav = false, sawTxt = false, sawDir = false;
        {
            auto entriesVar = data.getProperty ("entries", var());
            check (entriesVar.isArray(), "list_directory entries is an array");
            if (auto* ea = entriesVar.getArray())
                for (auto& e : *ea)
                {
                    const auto nm = e.getProperty ("name", var()).toString();
                    const bool isDir = (bool) e.getProperty ("isDir", false);
                    if (nm == "probe-tone.wav") { sawWav = true;
                        check (! isDir, "wav entry isDir:false");
                        check ((double) e.getProperty ("size", 0.0) > 0.0, "wav entry size > 0"); }
                    if (nm == "notes.txt")  sawTxt = true;
                    if (nm == "subfolder" && isDir) sawDir = true;
                }
        }
        check (sawWav, "list_directory lists the seeded .wav (extension filter passes audio)");
        check (! sawTxt, "list_directory filters out the .txt (extension filter excludes non-audio)");
        check (sawDir, "list_directory lists the subfolder (isDir:true)");

        // Folder navigation: descend into the child, parent points back at browseDir.
        auto into = cmd (ops, "list_directory", args1 ("path", childDir.getFullPathName()));
        check (ok (into) && (bool) into["data"].getProperty ("exists", false), "list_directory into subfolder exists:true");
        check (into["data"].getProperty ("parent", var()).toString() == browseDir.getFullPathName(),
               "list_directory subfolder parent points back to the parent dir");

        // Graceful failures: missing path -> ok:true, exists:false, error set, roots present.
        auto missing = cmd (ops, "list_directory", args1 ("path", "/no/such/dir/xyz123"));
        check (ok (missing), "list_directory missing path still ok (graceful shape)");
        check (! (bool) missing["data"].getProperty ("exists", true), "list_directory missing path exists:false");
        check (missing["data"].getProperty ("error", var()).toString().isNotEmpty(), "list_directory missing path has an error string");
        {
            auto mr = missing["data"].getProperty ("roots", var());
            check (mr.isArray() && mr.size() > 0, "list_directory still returns roots on a missing path");
            auto me = missing["data"].getProperty ("entries", var());
            check (me.isArray() && me.size() == 0, "list_directory missing path has empty entries");
        }

        // Relative path -> invalid (never resolved against cwd, never builds a File()).
        auto rel = cmd (ops, "list_directory", args1 ("path", "relative/path"));
        check (ok (rel), "list_directory relative path returns ok (graceful)");
        check (! (bool) rel["data"].getProperty ("exists", true), "list_directory relative path exists:false (not resolved against cwd)");

        // Empty path defaults to Home (a real dir).
        auto home = cmd (ops, "list_directory", var());
        check (ok (home) && (bool) home["data"].getProperty ("exists", false), "list_directory with no path defaults to a real Home dir");

        // READ-ONLY: no JSONL line written, no snapshot_invalidated emitted.
        check (logCount ("list_directory") == ldLogBefore, "list_directory is READ-ONLY (not logged)");
        bool sawInvalidate = false;
        for (auto& t : eventTypes) if (t == "snapshot_invalidated") sawInvalidate = true;
        check (! sawInvalidate, "list_directory emits no snapshot_invalidated (read-only)");

        // End-to-end seam: a path from entries feeds import_clip and a clip lands
        // (proves the browser -> import path headlessly, no new mutation path).
        auto trk = cmd (ops, "create_track", args1 ("name", "BrowseImport"));
        const auto trkId = trk["data"].getProperty ("trackId", var()).toString();
        check (ok (trk), "create track for browse import ok");
        // Clip count on the freshly-created (empty) BrowseImport track, found by id.
        const auto clipsOn = [&] (const String& id) {
            auto tracksVar = ops.snapshot().getProperty ("tracks", var());
            if (auto* ta = tracksVar.getArray())
                for (auto& t : *ta)
                    if (t.getProperty ("id", var()).toString() == id)
                        return (int) t.getProperty ("clips", var()).size();
            return -1;
        };
        const int clipsBefore = clipsOn (trkId);
        auto imp = cmd (ops, "import_clip", objN ({{ "file", wav.getFullPathName() }, { "trackId", trkId }}));
        check (ok (imp), "import_clip on a browsed file ok (reuses existing import path)");
        check (clipsOn (trkId) > clipsBefore, "browsed file imported as a real clip (browser -> import_clip seam)");

        // ── file_peaks + audition (sample-browser thumbnail + preview seam) ──
        // file_peaks: waveform peaks for an un-imported file (read-only, like
        // get_clip_peaks but path-addressed). Drives the browser thumbnails.
        auto fp = cmd (ops, "file_peaks", objN ({{ "path", wav.getFullPathName() }, { "buckets", 64 }}));
        check (ok (fp), "file_peaks ok for a real wav");
        check (fp["data"].getProperty ("peaks", var()).isArray()
               && fp["data"].getProperty ("peaks", var()).size() > 0, "file_peaks returns a non-empty peak array");
        check (! ok (cmd (ops, "file_peaks", objN ({{ "path", "/no/such/file.wav" }}))),
               "file_peaks errors on a missing file");

        // audition_file / stop_audition: a transient preview (no undo txn, no log).
        // Headless has no device so it can't sound; the contract + clean start/stop
        // (and graceful missing-file error) are what's asserted.
        check (ok (cmd (ops, "audition_file", objN ({{ "path", wav.getFullPathName() }}))),
               "audition_file ok for a real wav");
        check (ok (cmd (ops, "stop_audition")), "stop_audition ok");
        check (! ok (cmd (ops, "audition_file", objN ({{ "path", "/no/such/file.wav" }}))),
               "audition_file errors on a missing file");

        browseDir.deleteRecursively();
        cmd (ops, "remove_track", args1 ("trackId", trkId));   // tidy up the probe track
    }

    // ─── Wave: keyboard shortcuts + clip clipboard (CTL-002 / AED-001) ───
    // The keyboard layer is window 'keydown' handlers in the React UI (App mounts
    // useKeyboardShortcuts) — pure view code, NOT headless-testable, so it is NOT
    // asserted here (no synthetic key events). What IS headless-verifiable, and is
    // proven below, is the one backend half: paste_clip reconstructs a clip from a
    // clipToVar-shaped descriptor (the UI clipboard's payload) on a target track.
    section ("Wave: clip clipboard / paste_clip (AED-001)");
    {
        // Track A with a wave clip; read A's clip descriptor from the snapshot
        // (this is exactly the object the UI clipboard captures via clipToVar).
        auto a = cmd (ops, "create_track", args1 ("name", "PasteSrc"));
        const auto trackA = a["data"].getProperty ("trackId", var()).toString();
        check (ok (a), "create track A ok");
        auto toneA = cmd (ops, "add_test_tone_clip",
                          objN ({{ "trackId", trackA }, { "seconds", 1.5 }, { "freq", 196.0 }}));
        check (ok (toneA), "add_test_tone_clip on A ok");

        // Locate track A in the snapshot + grab its first clip descriptor. Bind the
        // snapshot var to a local before getArray() (a pointer into a temporary var
        // dangles — has bitten prior waves).
        const auto snapA = ops.snapshot();
        var clipDesc;
        String sourceName;
        if (auto* trackArr = snapA.getProperty ("tracks", var()).getArray())
            for (auto& t : *trackArr)
                if (t.getProperty ("id", var()).toString() == trackA)
                    if (auto* clipArr = t.getProperty ("clips", var()).getArray())
                        if (! clipArr->isEmpty())
                        {
                            clipDesc = clipArr->getReference (0);
                            sourceName = clipDesc.getProperty ("name", var()).toString();
                        }
        check (clipDesc.isObject(), "captured A's clip descriptor from the snapshot");
        check (clipDesc.getProperty ("type", var()).toString() == "wave", "captured descriptor is a wave clip");
        const double srcLen = (double) clipDesc.getProperty ("length", 0.0);

        // Track B; paste the descriptor onto B at start S.
        auto b = cmd (ops, "create_track", args1 ("name", "PasteDst"));
        const auto trackB = b["data"].getProperty ("trackId", var()).toString();
        check (ok (b), "create track B ok");

        const double pasteStart = 3.0;
        auto pasted = cmd (ops, "paste_clip",
                           objN ({{ "trackId", trackB }, { "start", pasteStart }, { "clip", clipDesc }}));
        check (ok (pasted), "paste_clip onto B ok");

        // B now has one clip; its length matches the source and it has a name.
        auto findTrackVar = [&] (const String& id) -> var {
            const auto snap = ops.snapshot();
            if (auto* arr = snap.getProperty ("tracks", var()).getArray())
                for (auto& t : *arr)
                    if (t.getProperty ("id", var()).toString() == id) return t;
            return {};
        };
        const auto bTrack = findTrackVar (trackB);
        const auto bClips = bTrack.getProperty ("clips", var());
        check (bClips.size() == 1, "B has exactly one clip after paste_clip");
        const auto bClip = bClips[0];
        check (std::abs ((double) bClip.getProperty ("length", 0.0) - srcLen) < 1.0e-6,
               "pasted clip length matches the source clip");
        check (bClip.getProperty ("name", var()).toString().isNotEmpty(), "pasted clip has a name");
        check (std::abs ((double) bClip.getProperty ("start", 0.0) - pasteStart) < 1.0e-6,
               "pasted clip starts at the requested time");

        // Copy/paste, not move: the source clip on A is untouched.
        const auto aTrack = findTrackVar (trackA);
        check (aTrack.getProperty ("clips", var()).size() == 1, "source clip on A untouched (copy, not move)");

        // paste_clip is genuinely undoable: undo removes the pasted clip from B.
        check (ok (cmd (ops, "undo")), "undo after paste_clip ok");
        check (findTrackVar (trackB).getProperty ("clips", var()).size() == 0,
               "undo removed the pasted clip from B (paste_clip is undoable)");

        // MIDI: paste carries the notes across.
        auto mt = cmd (ops, "create_track", args1 ("name", "MidiSrc"));
        const auto midiTrack = mt["data"].getProperty ("trackId", var()).toString();
        // Pass an EMPTY notes array so cmdAddMidiClip does NOT seed its default
        // 4-note arpeggio — we add exactly 2 notes below so the count is known.
        auto mClip = cmd (ops, "add_midi_clip", objN ({{ "trackId", midiTrack }, { "notes", var (Array<var>()) }}));
        const auto midiClipId = mClip["data"].getProperty ("clipId", var()).toString();
        check (ok (mClip), "add_midi_clip ok");
        check (ok (cmd (ops, "add_note", objN ({{ "clipId", midiClipId }, { "pitch", 64 }, { "start", 0.0 }, { "length", 1.0 }, { "velocity", 100 }}))), "add_note 1 ok");
        check (ok (cmd (ops, "add_note", objN ({{ "clipId", midiClipId }, { "pitch", 67 }, { "start", 1.0 }, { "length", 1.0 }, { "velocity", 90 }}))), "add_note 2 ok");

        // Read the MIDI clip's descriptor (with its notes[]) from the snapshot.
        var midiDesc;
        int srcNoteCount = 0;
        {
            const auto mTrackVar = findTrackVar (midiTrack);
            if (auto* clipArr = mTrackVar.getProperty ("clips", var()).getArray())
                if (! clipArr->isEmpty())
                {
                    midiDesc = clipArr->getReference (0);
                    auto notesVar = midiDesc.getProperty ("notes", var());  // bind before getArray
                    srcNoteCount = notesVar.isArray() ? notesVar.size() : 0;
                }
        }
        check (midiDesc.isObject(), "captured the MIDI clip descriptor");
        check (srcNoteCount == 2, "source MIDI clip carries 2 notes");

        auto mDst = cmd (ops, "create_track", args1 ("name", "MidiDst"));
        const auto midiDst = mDst["data"].getProperty ("trackId", var()).toString();
        auto mPaste = cmd (ops, "paste_clip", objN ({{ "trackId", midiDst }, { "start", 0.0 }, { "clip", midiDesc }}));
        check (ok (mPaste), "paste_clip (midi) onto another track ok");
        {
            const auto dstTrackVar = findTrackVar (midiDst);
            const auto dstClips = dstTrackVar.getProperty ("clips", var());
            check (dstClips.size() == 1, "MIDI destination has one pasted clip");
            auto notesVar = dstClips[0].getProperty ("notes", var());  // bind before size
            check (notesVar.isArray() && notesVar.size() == srcNoteCount,
                   "pasted MIDI clip carries the same note count");
        }

        // Bad args -> graceful errResult (no crash).
        check (! ok (cmd (ops, "paste_clip", objN ({{ "start", 0.0 }, { "clip", clipDesc }}))),
               "paste_clip with missing trackId errors");
        check (! ok (cmd (ops, "paste_clip", objN ({{ "trackId", trackB }, { "start", 0.0 }}))),
               "paste_clip with missing clip errors");
        check (! ok (cmd (ops, "paste_clip", objN ({{ "trackId", trackB }, { "start", 0.0 },
                                                    { "clip", objN ({{ "type", "bogus" }, { "length", 1.0 }}) }}))),
               "paste_clip with unknown clip type errors");

        // Zero-side-effect validation: a wave descriptor with a non-existent sourceFile
        // on a VALID track must error WITHOUT creating an orphan clip (the source check
        // is hoisted above the transaction / track auto-create).
        auto bBefore = trackById (trackB);
        auto bBeforeClips = bBefore.getProperty ("clips", var());
        const int bCountBefore = bBeforeClips.isArray() ? bBeforeClips.getArray()->size() : 0;
        check (! ok (cmd (ops, "paste_clip", objN ({{ "trackId", trackB }, { "start", 0.0 },
                   { "clip", objN ({{ "type", "wave" }, { "length", 1.0 }, { "sourceFile", "/no/such/file.wav" }}) }}))),
               "paste_clip wave with missing source errors");
        auto bAfter = trackById (trackB);
        auto bAfterClips = bAfter.getProperty ("clips", var());
        const int bCountAfter = bAfterClips.isArray() ? bAfterClips.getArray()->size() : 0;
        check (bCountAfter == bCountBefore, "failed wave paste left no orphan clip (zero side effects)");

        // JSONL records paste_clip with undoable:true.
        auto plog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        check (plog.contains ("paste_clip"), "JSONL records paste_clip");
        bool pasteUndoable = false;
        for (auto& ln : juce::StringArray::fromLines (plog))
            if (ln.contains ("\"command\": \"paste_clip\"") && ln.contains ("\"undoable\": true"))
                pasteUndoable = true;
        check (pasteUndoable, "paste_clip logged undoable:true (genuine edit)");
    }

    // ─── Wave: command-log inspector (AGT-001) ───
    // get_command_log is a READ-ONLY window over the canonical command log
    // (mosh-log.jsonl). It must NOT log/transact/emit (doing so would pollute the
    // very file it returns and make it appear in its own results). Fully headless:
    // run a couple of known commands, then read them back most-recent-first.
    // (The UI-scale control is pure UI-local view state -- like theme -- and is NOT
    //  a command, so it is documented, not asserted here.)
    section ("Wave: command-log inspector (AGT-001)");
    {
        // Fresh, known commands so the log tail is predictable. The LAST undoable
        // edit we issue before reading is rename_track, so it must be entry[0].
        // Capture the total first so we can assert it grows by EXACTLY the 2 commands
        // we issue (create_track + rename_track) -- get_command_log itself never logs.
        const int totalBefore = (int) cmd (ops, "get_command_log", args1 ("limit", 1))["data"].getProperty ("total", -1);
        check (ok (cmd (ops, "create_track", args1 ("name", "LogProbe"))), "create_track LogProbe ok");
        auto lpSnap = ops.snapshot();
        juce::String logProbeId;
        if (auto* trackArr = lpSnap.getProperty ("tracks", var()).getArray())
            for (auto& t : *trackArr)
                if (t.getProperty ("name", var()).toString() == "LogProbe")
                    logProbeId = t.getProperty ("id", var()).toString();
        check (logProbeId.isNotEmpty(), "found the LogProbe track id");
        check (ok (cmd (ops, "rename_track", objN ({{ "trackId", logProbeId }, { "name", "LogProbe2" }}))),
               "rename_track LogProbe2 ok (this is the most-recent command before get_command_log)");

        // get_command_log { limit: 5 } -> ok, well-formed bounded array.
        auto gl = cmd (ops, "get_command_log", args1 ("limit", 5));
        check (ok (gl), "get_command_log ok");
        auto entriesVar = gl["data"].getProperty ("entries", var());   // bind before getArray
        check (entriesVar.isArray(), "get_command_log entries is an array");
        const int total = (int) gl["data"].getProperty ("total", -1);
        // >= (not ==): the 2 commands we issued definitely logged; late async generative-
        // service callbacks (cancelled HTTP jobs from earlier stages) may append more lines
        // between the two reads, so an exact count is non-deterministic. The meaningful
        // assertion is that `total` tracks real appended commands (not a vacuous >= 0).
        check (total >= totalBefore + 2, "get_command_log total grew by at least the 2 commands issued (create_track + rename_track)");
        if (auto* entries = entriesVar.getArray())
        {
            check (entries->size() <= 5, "get_command_log honours limit (<= 5 entries)");
            check (entries->size() > 0, "get_command_log returned at least one entry");

            // Most-recent-first: entry[0] is the LAST command issued before the read
            // (rename_track) -- NOT get_command_log itself (it is not logged).
            auto first = entries->getReference (0);
            check (first.getProperty ("command", var()).toString() == "rename_track",
                   "most-recent-first: entry[0].command == rename_track (the last command issued)");

            // Every entry is well-formed: non-empty command + bool ok + bool undoable.
            bool allShaped = true;
            bool sawGetCommandLog = false;
            for (auto& e : *entries)
            {
                if (e.getProperty ("command", var()).toString().isEmpty()) allShaped = false;
                if (! e.getProperty ("ok", var()).isBool()) allShaped = false;
                if (! e.getProperty ("undoable", var()).isBool()) allShaped = false;
                if (e.getProperty ("command", var()).toString() == "get_command_log") sawGetCommandLog = true;
            }
            check (allShaped, "every entry has command (non-empty), ok (bool), undoable (bool)");
            // READ-ONLY proof: get_command_log never logs itself.
            check (! sawGetCommandLog, "get_command_log is READ-ONLY: it does NOT appear in the log it returns");
        }

        // Zero / no limit still returns ok with a well-formed entries array (default
        // applies; clamp never crashes), and still does not log itself.
        auto gl0 = cmd (ops, "get_command_log", args1 ("limit", 0));
        check (ok (gl0), "get_command_log with zero limit still ok (default applies)");
        auto entries0Var = gl0["data"].getProperty ("entries", var());
        check (entries0Var.isArray(), "get_command_log zero-limit entries is a well-formed array");

        // Malformed / non-object JSONL lines must be skipped, never crash the inspector.
        // Inject a corrupt line + a valid-but-non-object line, then restore the file.
        auto logFile = eng.sessionDir().getChildFile ("mosh-log.jsonl");
        const auto logBackup = logFile.loadFileAsString();
        const int totalClean = (int) cmd (ops, "get_command_log", args1 ("limit", 1))["data"].getProperty ("total", -1);
        logFile.appendText ("{ this is not valid json\n");   // malformed
        logFile.appendText ("12345\n");                        // valid JSON, but not an object
        auto glBad = cmd (ops, "get_command_log", args1 ("limit", 5));
        check (ok (glBad), "get_command_log tolerates malformed/partial lines (no crash)");
        check ((int) glBad["data"].getProperty ("total", -1) == totalClean,
               "malformed / non-object lines are skipped (total unchanged)");
        logFile.replaceWithText (logBackup);                   // restore: drop the injected garbage

        // Cross-check against the raw JSONL: get_command_log was issued several times
        // above yet the log must contain ZERO occurrences of it (it is never written).
        auto rawLog = logFile.loadFileAsString();
        check (! rawLog.contains ("get_command_log"),
               "mosh-log.jsonl contains NO get_command_log token (read-only confirmed at the file)");
    }
}

} // namespace mosh
