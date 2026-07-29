#include "SelfTest.h"
#include "selftest/SelfTestChapters.h"
#include "selftest/SelfTestSupport.h"
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
    // RFC 002 scaffolding: the harness plumbing + its file-static state moved to
    // selftest/SelfTestSupport.* (shared with selftest/SelfTest.Modes.cpp and the
    // upcoming chapter TUs). These thin shims keep the exact pre-split
    // free-function names and signatures so runSelfTest's ~8,500-line body below
    // stays byte-identical to its pre-split form (the RFC's transcript oracle
    // depends on the section bodies staying verbatim).
    selftest::SelfTestCtx& gCtx = selftest::globalCtx();
    int& failures = gCtx.failures;
    int& checks   = gCtx.checks;

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

int runSelfTest (MoshEngine& eng, MoshOps& ops)
{
    using namespace juce;
    failures = 0; checks = 0;
    resetSections();
    // Pin the FAKE transform adapter for the deterministic selftest, regardless of whether
    // real RAVE models happen to be installed in RAVE_MODEL_DIR on this machine (the
    // spawned generative service inherits this env). The "Route B: transform (fake)"
    // section asserts the deterministic fake adapter; without this it would hit the real
    // RAVE backend if models are present and break. Mirrors how SA3 stays fake here. The
    // real transform path is covered separately by scripts/verify-hardware/verify.py --rave.
    mosh::setEnvVar ("MOSH_ENABLE_TRANSFORM", "0");
    // Same pin for the FMS sing adapter: a machine with MOSH_SOULX_SSH_HOST + an enrolled
    // voice configured must still run the deterministic fake legato-beep backend here.
    mosh::setEnvVar ("MOSH_ENABLE_SOULX", "0");
    // LoRA rack double lock: the fake path never consults the registry (names key the
    // fingerprint directly), but pin the kill switch AND an empty library dir anyway so
    // the user's real ~/Library/Mosh/loras can never leak into a hermetic run.
    mosh::setEnvVar ("MOSH_ENABLE_LORAS", "0");
    {
        auto emptyLoraDir = selftestTempPath (eng, "loras-empty");
        emptyLoraDir.createDirectory();
        mosh::setEnvVar ("MOSH_LORA_DIR", emptyLoraDir.getFullPathName().toRawUTF8());
    }
    if (SystemStats::getEnvironmentVariable ("MOSH_SELFTEST_SA3", "0") != "1")
        mosh::setEnvVar ("MOSH_ENABLE_SA3", "0");
    // AGT-MEM (Phase-B memory lane, M1) — pin the global agent-memory store INSIDE this
    // run's already-isolated session dir (SLF-CONC-001) so a plain `--selftest` never
    // touches the owner's real ~/Library/Mosh/agent, and two concurrent runs on this
    // host can't collide on the same JSONL files.
    mosh::setEnvVar ("MOSH_AGENT_DIR", eng.sessionDir().getChildFile ("agent").getFullPathName().toRawUTF8());
    std::cerr << "\n===== Mosh Stage 1 command-surface harness =====\n";
    // The session dir is now per-process by default, so name it: this run's exports,
    // saved edit and mosh-log.jsonl live HERE, not in a shared fixed path.
    std::cerr << "session dir: " << eng.sessionDir().getFullPathName() << "\n";
    // ── RFC 002 A-PR5: chapters 1-5 (Stage 1 .. MON-003 — the leading ~50% of the
    // section sequence) moved verbatim into TUs under src/app/selftest/. gCtx is
    // the same instance the shims above bind to, so counters and section timing
    // continue seamlessly across the seam.
    gCtx.eng = &eng;
    gCtx.ops = &ops;
    runChapter01_commands_arrangement (gCtx);
    runChapter02_hosting_session_editing (gCtx);
    runChapter03_automation_plugins_master (gCtx);
    runChapter04_generative_layer (gCtx);
    runChapter05_export_drums_recording (gCtx);
    // Rebind the promoted cross-cut locals under their pre-split names so the
    // inline remainder below stays byte-untouched (see SelfTestCtx).
    auto& eventTypes = gCtx.eventTypes;
    auto& lastEvent = gCtx.lastEvent;
    auto& trackById = gCtx.trackById;

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

    // ─── Wave A — PRJ-008 / PRE-001 / ARE-003 ───
    // PRJ-008: per-project format / time-base INTENT persisted on the Edit's own
    // ValueTree (MOSH_PROJECT child) — saves/reloads with the .tracktionedit, no new
    // storage format. set_project_settings is a NON-undoable preference (cmdSetMetronome
    // template). PRE-001: device-pref persistence (graceful-degradation headless;
    // full cross-restart is hardware-gated). ARE-003: latency-compensated recording —
    // verify the readout fields + the headless record graceful-degradation (the take
    // landing alignment rides Wave B + is hardware-gated).
    section ("Wave A: project format (PRJ-008) / device prefs (PRE-001) / record latency (ARE-003)");
    {
        auto sess = [&] { return ops.snapshot().getProperty ("session", var()); };
        auto proj = [&] { return sess().getProperty ("project", var()); };

        // Snapshot exposes session.project with the three fields (device-readout fallback
        // before any set_project_settings — never absent).
        check (proj().isObject(), "snapshot session.project block present");
        check (proj().hasProperty ("sampleRate"), "session.project has sampleRate");
        check (proj().hasProperty ("bitDepth"), "session.project has bitDepth");
        check (proj().hasProperty ("timeBase"), "session.project has timeBase");
        check (proj().getProperty ("timeBase", var()).toString() == "seconds", "session.project.timeBase defaults to seconds");

        // Validation: bad sampleRate / bitDepth / timeBase all error (storage untouched).
        check (! ok (cmd (ops, "set_project_settings", args1 ("sampleRate", 6000))), "set_project_settings rejects sampleRate < 7000");
        check (! ok (cmd (ops, "set_project_settings", args1 ("bitDepth", 20))), "set_project_settings rejects bitDepth not in {16,24,32}");
        check (! ok (cmd (ops, "set_project_settings", args1 ("timeBase", "ticks"))), "set_project_settings rejects unknown timeBase");

        // Set valid settings (all three at once), then assert the snapshot reflects them.
        check (ok (cmd (ops, "set_project_settings",
                        objN ({{ "sampleRate", 96000 }, { "bitDepth", 16 }, { "timeBase", "barsBeats" }}))),
               "set_project_settings ok");
        check ((double) proj().getProperty ("sampleRate", 0.0) == 96000.0, "session.project.sampleRate == 96000 after set");
        check ((int) proj().getProperty ("bitDepth", 0) == 16, "session.project.bitDepth == 16 after set");
        check (proj().getProperty ("timeBase", var()).toString() == "barsBeats", "session.project.timeBase == barsBeats after set");

        // Save -> reload -> the project settings round-trip with the .tracktionedit
        // (mirrors the existing save/reload checks — proves MOSH_PROJECT persists).
        check (ok (cmd (ops, "save")),   "save (project settings) ok");
        check (ok (cmd (ops, "reload")), "reload (project settings) ok");
        check ((double) proj().getProperty ("sampleRate", 0.0) == 96000.0, "session.project.sampleRate survived save+reload");
        check ((int) proj().getProperty ("bitDepth", 0) == 16, "session.project.bitDepth survived save+reload");
        check (proj().getProperty ("timeBase", var()).toString() == "barsBeats", "session.project.timeBase survived save+reload");

        // set_project_settings is NON-undoable (preference): logged undoable:false, and an
        // undo immediately after must NOT revert it (no transaction was pushed).
        auto plog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        bool projPref = false;
        for (auto& ln : juce::StringArray::fromLines (plog))
            if (ln.contains ("\"command\": \"set_project_settings\"") && ln.contains ("\"undoable\": false")) projPref = true;
        check (projPref, "set_project_settings logged undoable:false (preference)");

        // export_audio defaults its bit depth + rate from the stored project setting when
        // omitted (we set 96000/16 above). Seed a fresh renderable track + clip so the
        // render ALWAYS produces output -> the default-resolution asserts run
        // DETERMINISTICALLY (no render-state-dependent branch).
        {
            auto seed = cmd (ops, "create_track", args1 ("name", "ExportSeed"));
            check (ok (seed), "create renderable seed track for export-default ok");
            const auto seedId = seed["data"].getProperty ("trackId", var()).toString();
            check (ok (cmd (ops, "add_test_tone_clip", objN ({{ "trackId", seedId }, { "seconds", 0.5 }}))),
                   "seed a renderable clip for export-default ok");
            auto exFile = eng.sessionDir().getChildFile ("exports").getChildFile ("wavea-export.wav");
            exFile.deleteFile();
            auto ex = cmd (ops, "export_audio", args1 ("file", exFile.getFullPathName()));
            check (ok (ex), "export_audio (with a renderable seed clip) ok");
            check ((int) ex["data"].getProperty ("bitDepth", -1) == 16, "export_audio defaults bitDepth from project setting (16)");
            check ((double) ex["data"].getProperty ("sampleRate", 0.0) == 96000.0, "export_audio defaults sampleRate from project setting (96000)");
            exFile.deleteFile();
            cmd (ops, "remove_track", args1 ("trackId", seedId));   // tidy the seed track
        }

        // Restore defaults so later runs / blocks see a clean project (idempotent dir is
        // wiped each run, but keep in-process state tidy).
        check (ok (cmd (ops, "set_project_settings",
                        objN ({{ "sampleRate", 44100 }, { "bitDepth", 24 }, { "timeBase", "seconds" }}))),
               "set_project_settings restore defaults ok");

        // ── PRE-001 — device prefs (graceful degradation headless) ──
        // list_audio_devices is read-only ok with audioEnabled:false; set_audio_device
        // returns the no-device error shape (NOT a crash). Full cross-restart persistence
        // of the device setup (audio-device.xml round-trip) is HARDWARE-GATED — it needs
        // a real interface to open and is verified on a machine with one.
        auto ld = cmd (ops, "list_audio_devices");
        check (ok (ld), "PRE-001: list_audio_devices ok headless");
        check (! (bool) ld["data"].getProperty ("audioEnabled", true), "PRE-001: list_audio_devices audioEnabled:false headless");
        auto sd = cmd (ops, "set_audio_device", objN ({{ "outputDevice", "Nope" }}));
        check (! ok (sd), "PRE-001: set_audio_device returns graceful error with no device");
        check (sd.getProperty ("error", var()).toString().contains ("no audio device"), "PRE-001: set_audio_device error mentions no audio device");

        // ── ARE-003 — latency-compensated recording (verify-only) ──
        // The PDC readout fields are present (the take-landing alignment in Wave B rides
        // these). set_transport {action:"record"} degrades gracefully when !hasAudio()
        // (the record branch already guards on hasAudio) — it logs ok + does nothing,
        // never a crash. Landed-clip alignment is hardware-gated.
        check (sess().hasProperty ("totalLatencyMs"), "ARE-003: session has totalLatencyMs readout");
        check (sess().hasProperty ("latencyContextReady"), "ARE-003: session has latencyContextReady readout");
        check (! (bool) sess().getProperty ("latencyContextReady", true), "ARE-003: latencyContextReady false headless (no prepared graph)");
        auto rec = cmd (ops, "set_transport", args1 ("action", "record"));
        check (ok (rec), "ARE-003: set_transport record degrades gracefully headless (no crash)");
        check (! (bool) ops.snapshot().getProperty ("transport", var()).getProperty ("recording", false), "ARE-003: not recording headless (no audio device)");
    }

    // ─── PRJ-FMT — project FORMAT version + migration + newer-file refusal ───
    // The Mosh format version is stamped on the MOSH_PROJECT node on every save
    // (state/Migrations.h). On open, an OLDER (or unversioned) file migrates forward; a
    // NEWER file is REFUSED outright and the current project is kept loaded + saveable. This
    // section is self-contained and self-restoring (it ends by reopening the original edit)
    // so it does not disturb later sections.
    section ("PRJ-FMT: project format version + migration + newer-file refusal");
    {
        auto sess = [&] { return ops.snapshot().getProperty ("session", var()); };
        auto proj = [&] { return sess().getProperty ("project", var()); };
        auto fmtVersion = [&] { return (int) proj().getProperty ("formatVersion", var (-1)); };

        const auto origFile = eng.editFile();

        // Save → the stamp lands on disk and the snapshot reports the current version.
        check (ok (cmd (ops, "save")), "PRJ-FMT: save ok");
        check (fmtVersion() == kMoshFormatVersion, "PRJ-FMT: snapshot reports current formatVersion after save");

        // Save → reload → the version round-trips with the .tracktionedit.
        check (ok (cmd (ops, "reload")), "PRJ-FMT: reload ok");
        check (fmtVersion() == kMoshFormatVersion, "PRJ-FMT: formatVersion survived save+reload");

        // Fabricate a NEWER-format file (copy the saved edit, bump moshFormatVersion) →
        // open_project REFUSES it and keeps the current project loaded.
        auto bumpFile = eng.sessionDir().getChildFile ("prjfmt-newer.tracktionedit");
        if (auto xml = juce::XmlDocument::parse (origFile))
        {
            if (auto* mp = xml->getChildByName ("MOSH_PROJECT"))
                mp->setAttribute ("moshFormatVersion", kMoshFormatVersion + 1);
            bumpFile.replaceWithText (xml->toString());
        }
        auto refused = cmd (ops, "open_project", args1 ("file", bumpFile.getFullPathName()));
        check (! ok (refused), "PRJ-FMT: open_project REFUSES a newer-format file");
        check (refused.getProperty ("error", var()).toString().contains ("newer version of Mosh"),
               "PRJ-FMT: refusal error names a newer Mosh version");
        check (eng.editFile() == origFile, "PRJ-FMT: refused open kept the current project loaded");

        // Fabricate a LEGACY file (strip the stamp ⇒ v0) → open_project MIGRATES it forward.
        auto legacyFile = eng.sessionDir().getChildFile ("prjfmt-legacy.tracktionedit");
        if (auto xml = juce::XmlDocument::parse (origFile))
        {
            if (auto* mp = xml->getChildByName ("MOSH_PROJECT"))
                mp->removeAttribute ("moshFormatVersion");
            legacyFile.replaceWithText (xml->toString());
        }
        check (ok (cmd (ops, "open_project", args1 ("file", legacyFile.getFullPathName()))),
               "PRJ-FMT: open_project accepts a legacy (unversioned) file");
        check (fmtVersion() == kMoshFormatVersion, "PRJ-FMT: legacy file migrated forward to current version");

        // Restore the original session edit so later sections are undisturbed.
        check (ok (cmd (ops, "open_project", args1 ("file", origFile.getFullPathName()))),
               "PRJ-FMT: restore original project ok");
        bumpFile.deleteFile();
        legacyFile.deleteFile();
    }

    // ─── A2 — crash-recovery liveness sentinel ───
    // The GUI writes a session.running sentinel once the window is live and deletes it on a
    // clean quit; its presence at the next launch flags an unclean exit (a prior crash). The
    // headless harness uses a wiped freshSession dir + never marks it, so it always reads
    // clean. We exercise the mark/clear primitives + the clean-start read directly (the
    // ctor latch is GUI-only). Self-contained: leaves the sentinel cleared.
    section ("A2: crash-recovery liveness sentinel");
    {
        auto sentinel = eng.sessionDir().getChildFile ("session.running");
        check (! eng.wasUncleanShutdown(), "A2: fresh headless start reads clean (no prior sentinel)");
        check (! ops.snapshot().getProperty ("session", var()).hasProperty ("recoveryAvailable"),
               "A2: snapshot omits recoveryAvailable on a clean start");
        eng.markSessionRunning();
        check (sentinel.existsAsFile(), "A2: markSessionRunning writes the sentinel");
        eng.clearSessionRunning();
        check (! sentinel.existsAsFile(), "A2: clearSessionRunning removes the sentinel (clean-quit path)");
    }

    // ─── Scoped snapshot invalidation (D1-justified) ───
    // A track-local mutation (mixer volume/pan/mute, plugin param) emits snapshot_invalidated
    // carrying JUST that track's var, so the UI patches one track instead of re-pulling the
    // whole snapshot (measured 330 ms / 3.7 MiB at 100 tracks). Structural changes still emit
    // a payload-less FULL invalidation.
    section ("Scoped invalidation: track-local mutations emit a scoped patch");
    {
        auto t = cmd (ops, "create_track", args1 ("name", "ScopeT"));
        check (ok (t), "scoped: create track ok");
        const auto trackId = t["data"].getProperty ("trackId", var()).toString();

        // create_track is structural → FULL invalidation (no scope payload).
        check (lastEvent.getProperty ("type", var()).toString() == "snapshot_invalidated",
               "scoped: create_track emitted snapshot_invalidated");
        check (! lastEvent.getProperty ("payload", var()).getProperty ("scope", var()).isString(),
               "scoped: create_track is a FULL invalidation (no scope)");

        // set_track_volume is track-local → SCOPED patch carrying this track's var.
        check (ok (cmd (ops, "set_track_volume", objN ({{ "trackId", trackId }, { "db", -6.0 }}))),
               "scoped: set_track_volume ok");
        auto payload = lastEvent.getProperty ("payload", var());
        check (payload.getProperty ("scope", var()).toString() == "track", "scoped: set_track_volume emits scope=track");
        check (payload.getProperty ("trackId", var()).toString() == trackId, "scoped: patch carries the changed trackId");
        check (payload.getProperty ("track", var()).isObject(), "scoped: patch carries the track var");
        check (payload.getProperty ("track", var()).getProperty ("id", var()).toString() == trackId,
               "scoped: patch track var has the right id");

        cmd (ops, "remove_track", args1 ("trackId", trackId));   // tidy
    }

    // ─── A3 — recovery-journal mechanics (allowlist + truncate-on-save) ───
    // execute() journals only REPLAYABLE arrangement commands to recovery-journal.jsonl; every
    // save truncates it (the saved edit supersedes the unsaved tail). The full cross-restart
    // replay + id-rebinding is proven by verify.py's check_crash_recovery (KEEP_SESSION + __crash).
    section ("A3: recovery journal mechanics");
    {
        auto journal = eng.sessionDir().getChildFile ("recovery-journal.jsonl");
        auto journalLines = [&] {
            if (! journal.existsAsFile()) return 0;
            int n = 0;
            for (auto& l : juce::StringArray::fromLines (journal.loadFileAsString())) if (l.trim().isNotEmpty()) ++n;
            return n;
        };

        check (ok (cmd (ops, "save")), "A3: save ok");
        check (journalLines() == 0, "A3: journal empty after save");

        auto jt = cmd (ops, "create_track", args1 ("name", "JT"));
        const auto jid = jt["data"].getProperty ("trackId", var()).toString();
        check (journalLines() == 1, "A3: a replayable command (create_track) is journaled");

        cmd (ops, "set_transport", args1 ("action", "stop"));   // not in the replay allowlist
        check (journalLines() == 1, "A3: a non-replayable command (set_transport) is NOT journaled");

        check (ok (cmd (ops, "save")), "A3: save again ok");
        check (journalLines() == 0, "A3: save truncates the journal (saved edit supersedes the tail)");

        cmd (ops, "remove_track", args1 ("trackId", jid));   // tidy
    }

    // ─── KEY-001 — the project's musical key (tonic + mode) ───
    // Stored on the same MOSH_PROJECT node as the format/time-base prefs (saves/reloads
    // with the .tracktionedit). set_key is a NON-undoable preference (cmdSetProjectSettings
    // template). The tonic/mode domains mirror voice.js NOTE_PC / SCALES exactly, so the
    // host only accepts keys Moshi's in-key voice can sing. The key also feeds the
    // RenderLayer fingerprint (proven separately in the generative section); here we cover
    // the snapshot surface + validation + persistence + non-undoability.
    section ("KEY-001: musical key (set_key, snapshot.project.key, persistence)");
    {
        auto sess = [&] { return ops.snapshot().getProperty ("session", var()); };
        auto key  = [&] { return sess().getProperty ("project", var()).getProperty ("key", var()); };

        // Snapshot ALWAYS exposes session.project.key with the A/minor default (never absent).
        check (key().isObject(), "snapshot session.project.key block present");
        check (key().hasProperty ("tonic"), "session.project.key has tonic");
        check (key().hasProperty ("mode"), "session.project.key has mode");
        check (key().getProperty ("tonic", var()).toString() == "A", "session.project.key.tonic defaults to A");
        check (key().getProperty ("mode", var()).toString() == "minor", "session.project.key.mode defaults to minor");

        // Valid set (both fields) → ok + reflected in the snapshot.
        check (ok (cmd (ops, "set_key", objN ({{ "tonic", "F#" }, { "mode", "dorian" }}))), "set_key (F# dorian) ok");
        check (key().getProperty ("tonic", var()).toString() == "F#", "session.project.key.tonic == F# after set");
        check (key().getProperty ("mode", var()).toString() == "dorian", "session.project.key.mode == dorian after set");

        // Invalid tonic AND invalid mode each rejected; storage stays at the last good value.
        check (! ok (cmd (ops, "set_key", args1 ("tonic", "H"))), "set_key rejects a tonic outside NOTE_PC");
        check (key().getProperty ("tonic", var()).toString() == "F#", "rejected tonic left storage untouched (still F#)");
        check (! ok (cmd (ops, "set_key", args1 ("mode", "lydian"))), "set_key rejects a mode outside SCALES");
        check (key().getProperty ("mode", var()).toString() == "dorian", "rejected mode left storage untouched (still dorian)");

        // Save → reload → the key round-trips with the .tracktionedit.
        check (ok (cmd (ops, "save")),   "save (musical key) ok");
        check (ok (cmd (ops, "reload")), "reload (musical key) ok");
        check (key().getProperty ("tonic", var()).toString() == "F#", "session.project.key.tonic survived save+reload");
        check (key().getProperty ("mode", var()).toString() == "dorian", "session.project.key.mode survived save+reload");

        // NON-undoable preference: logged undoable:false, and an undo right after must NOT
        // revert it (no transaction was pushed).
        auto klog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        bool keyPref = false;
        for (auto& ln : juce::StringArray::fromLines (klog))
            if (ln.contains ("\"command\": \"set_key\"") && ln.contains ("\"undoable\": false")) keyPref = true;
        check (keyPref, "set_key logged undoable:false (preference)");
        cmd (ops, "undo");
        check (key().getProperty ("tonic", var()).toString() == "F#", "undo after set_key does NOT revert the key (non-undoable)");

        // Restore the default so later blocks see a clean project.
        check (ok (cmd (ops, "set_key", objN ({{ "tonic", "A" }, { "mode", "minor" }}))), "set_key restore default (A minor) ok");
    }

    // ─── G2b — count-in / pre-roll bars before recording ───
    // Stored on the same MOSH_PROJECT node as key/timeBase (saves/reloads with the
    // .tracktionedit); set_count_in is a NON-undoable preference (cmdSetKey template
    // exactly). ENGINE-WIRED, not just stored: MoshOps::applyCountInToEdit() pushes the
    // value into tracktion_engine's own pre-roll (te::Edit::setCountInMode), which
    // TransportControl's record-start logic already consults
    // (Edit::getNumCountInBeats()) to roll the playhead back N beats and play an audible
    // click before capture actually begins. bars is deliberately {0,1,2}, matching
    // te::Edit::CountIn::none/oneBar/twoBar (headless selftest can't exercise the
    // audible/timing behavior itself — that needs a real audio device — but proves the
    // command's validation/snapshot/persistence/non-undoable-preference contract).
    section ("G2b: count-in / pre-roll (set_count_in, snapshot.project.countInBars, persistence)");
    {
        auto sess = [&] { return ops.snapshot().getProperty ("session", var()); };
        auto proj = [&] { return sess().getProperty ("project", var()); };

        // Snapshot ALWAYS exposes session.project.countInBars with the 0 (off) default,
        // mirrored to session.countInBars (like session.key / session.project.key).
        check (proj().hasProperty ("countInBars"), "snapshot session.project.countInBars present");
        check ((int) proj().getProperty ("countInBars", -1) == 0, "session.project.countInBars defaults to 0 (off)");
        check ((int) sess().getProperty ("countInBars", -1) == 0, "session.countInBars mirror defaults to 0 (off)");

        // Required arg.
        check (! ok (cmd (ops, "set_count_in")), "set_count_in requires bars");

        // Valid sets → ok + reflected in both the nested + mirrored snapshot fields.
        check (ok (cmd (ops, "set_count_in", args1 ("bars", 1))), "set_count_in (1 bar) ok");
        check ((int) proj().getProperty ("countInBars", -1) == 1, "session.project.countInBars == 1 after set");
        check ((int) sess().getProperty ("countInBars", -1) == 1, "session.countInBars mirror == 1 after set");
        // ENGINE-WIRED, not just stored: the stored preference actually reaches the
        // live Edit's real pre-roll (applyCountInToEdit → te::Edit::setCountInMode).
        check (eng.edit().getCountInMode() == te::Edit::CountIn::oneBar,
               "set_count_in (1 bar) lands on the live engine (te::Edit::getCountInMode)");

        check (ok (cmd (ops, "set_count_in", args1 ("bars", 2))), "set_count_in (2 bars) ok");
        check ((int) proj().getProperty ("countInBars", -1) == 2, "session.project.countInBars == 2 after set");

        // Invalid bars rejected; storage stays at the last good value.
        check (! ok (cmd (ops, "set_count_in", args1 ("bars", 3))), "set_count_in rejects bars > 2");
        check ((int) proj().getProperty ("countInBars", -1) == 2, "rejected bars (3) left storage untouched (still 2)");
        check (! ok (cmd (ops, "set_count_in", args1 ("bars", -1))), "set_count_in rejects negative bars");
        check ((int) proj().getProperty ("countInBars", -1) == 2, "rejected negative bars left storage untouched (still 2)");

        // Save → reload → the setting round-trips with the .tracktionedit.
        check (ok (cmd (ops, "save")),   "save (count-in) ok");
        check (ok (cmd (ops, "reload")), "reload (count-in) ok");
        check ((int) proj().getProperty ("countInBars", -1) == 2, "session.project.countInBars survived save+reload");

        // NON-undoable preference: logged undoable:false, and an undo right after must NOT
        // revert it (no transaction was pushed) — mirrors the set_key check above.
        auto ciLog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        bool ciPref = false;
        for (auto& ln : juce::StringArray::fromLines (ciLog))
            if (ln.contains ("\"command\": \"set_count_in\"") && ln.contains ("\"undoable\": false")) ciPref = true;
        check (ciPref, "set_count_in logged undoable:false (preference)");
        cmd (ops, "undo");
        check ((int) proj().getProperty ("countInBars", -1) == 2, "undo after set_count_in does NOT revert it (non-undoable)");

        // Restore the default so later blocks/gates see a clean project.
        check (ok (cmd (ops, "set_count_in", args1 ("bars", 0))), "set_count_in restore default (0/off) ok");
    }

    // ─── itemID-allocator regression (engine patch: createNewItemID scans ALL caches) ───
    // Before the patch, this load -> save -> reload -> remove -> load sequence could hand
    // the second plugin an itemID still held by the first in automatableEditItemCache ->
    // EditItemCache::addItem jassert (and a silently overwritten itemID->item map in
    // release). The BINDING proof is the run-wide JUCE-Assertion count being 0
    // (Mosh --selftest 2>&1 | grep -c 'JUCE Assertion'); here we assert the sequence runs
    // clean as a regression guard.
    section ("itemID allocator regression (engine patch)");
    {
        auto findIdByName = [&] (const juce::String& nm) -> juce::String {
            auto snap = ops.snapshot();
            auto tv = snap.getProperty ("tracks", var());
            if (auto* arr = tv.getArray())
                for (auto& tr : *arr)
                    if (tr.getProperty ("name", var()).toString() == nm)
                        return tr.getProperty ("id", var()).toString();
            return {};
        };
        check (ok (cmd (ops, "create_track", args1 ("name", "IdProbe"))), "id-probe: create_track ok");
        const auto pid = findIdByName ("IdProbe");
        check (pid.isNotEmpty(), "id-probe: found the probe track");
        check (ok (cmd (ops, "load_builtin", objN ({{ "trackId", pid }, { "type", "4bandEq" }}))),
               "id-probe: load built-in effect ok");
        check (ok (cmd (ops, "save")),   "id-probe: save ok");
        check (ok (cmd (ops, "reload")), "id-probe: reload ok");
        const auto pid2 = findIdByName ("IdProbe");   // track itemID persists across reload
        check (pid2.isNotEmpty(), "id-probe: probe track survived reload");
        check (ok (cmd (ops, "remove_plugin", objN ({{ "trackId", pid2 }, { "index", 0 }}))),
               "id-probe: remove_plugin ok");
        check (ok (cmd (ops, "load_builtin", objN ({{ "trackId", pid2 }, { "type", "compressor" }}))),
               "id-probe: load a second plugin after remove (no duplicate-itemID assert)");
    }

    // ─── Wave C: ARR-010 time-range as a true delete target ───
    section ("Wave C: delete_time_range (ARR-010)");
    {
        // A single clip spanning 0..4s; delete [1,2] -> two clips with a 1..2s gap.
        auto dt = cmd (ops, "create_track", args1 ("name", "RangeDel"))["data"].getProperty ("trackId", var()).toString();
        check (dt.isNotEmpty(), "range: track created");
        auto rc = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", dt }, { "seconds", 4.0 }, { "freq", 217.0 }}));
        check (ok (rc), "range: 0..4s tone clip created");
        check (trackById (dt).getProperty ("clips", var()).size() == 1, "range: track has 1 clip before delete");

        // start >= end errors (graceful, no mutation).
        check (! ok (cmd (ops, "delete_time_range", objN ({{ "start", 2.0 }, { "end", 1.0 }}))), "range: start>end errors");
        check (! ok (cmd (ops, "delete_time_range", objN ({{ "start", 1.0 }, { "end", 1.0 }}))), "range: start==end errors");
        check (trackById (dt).getProperty ("clips", var()).size() == 1, "range: errored delete left the clip untouched");

        // The real delete: [1,2] on this track only.
        auto del = cmd (ops, "delete_time_range", objN ({{ "start", 1.0 }, { "end", 2.0 },
                                                         { "trackIds", var (juce::Array<var> { var (dt) }) }}));
        check (ok (del), "range: delete_time_range [1,2] ok");
        {
            auto trk = trackById (dt);
            check (trk.getProperty ("clips", var()).size() == 2, "range: clip split into 2 segments");
            // Collect the segment time spans and assert the 1..2s gap.
            double seg0Start = 1e9, seg0End = 0.0, seg1Start = 1e9, seg1End = 0.0;
            if (auto* clips = trk.getProperty ("clips", var()).getArray())
            {
                juce::Array<double> starts, ends;
                for (auto& c : *clips)
                {
                    const double s = (double) c.getProperty ("start", 0.0);
                    const double e = s + (double) c.getProperty ("length", 0.0);
                    starts.add (s); ends.add (e);
                }
                // sort by start
                if (starts.size() == 2)
                {
                    int lo = starts[0] <= starts[1] ? 0 : 1, hi = 1 - lo;
                    seg0Start = starts[lo]; seg0End = ends[lo];
                    seg1Start = starts[hi]; seg1End = ends[hi];
                }
            }
            check (std::abs (seg0Start - 0.0) < 0.05 && std::abs (seg0End - 1.0) < 0.05, "range: left segment is 0..1s");
            check (std::abs (seg1Start - 2.0) < 0.05 && std::abs (seg1End - 4.0) < 0.05, "range: right segment is 2..4s (1..2s gap)");
        }

        // Undo restores the single clip.
        check (ok (cmd (ops, "undo")), "range: undo ok");
        {
            auto trk = trackById (dt);
            check (trk.getProperty ("clips", var()).size() == 1, "range: undo restored a single clip");
            auto c0 = trk["clips"][0];
            check (std::abs ((double) c0.getProperty ("start", 1.0) - 0.0) < 0.05
                   && std::abs ((double) c0.getProperty ("length", 0.0) - 4.0) < 0.05,
                   "range: restored clip spans 0..4s");
        }

        // A no-overlap range is a graceful no-op (clip stays whole, command ok).
        auto noop = cmd (ops, "delete_time_range", objN ({{ "start", 10.0 }, { "end", 12.0 },
                                                          { "trackIds", var (juce::Array<var> { var (dt) }) }}));
        check (ok (noop), "range: no-overlap range is ok (no-op)");
        check ((int) noop["data"].getProperty ("removed", -1) == 0, "range: no-overlap removed nothing");
        check (trackById (dt).getProperty ("clips", var()).size() == 1, "range: no-overlap left the clip whole");

        // An empty track in the target set is a graceful no-op too.
        auto et2 = cmd (ops, "create_track", args1 ("name", "RangeEmpty"))["data"].getProperty ("trackId", var()).toString();
        auto emptyDel = cmd (ops, "delete_time_range", objN ({{ "start", 0.0 }, { "end", 4.0 },
                                                             { "trackIds", var (juce::Array<var> { var (et2) }) }}));
        check (ok (emptyDel), "range: empty-track delete is ok (no-op)");
        check ((int) emptyDel["data"].getProperty ("removed", -1) == 0, "range: empty track removed nothing");

        // Clip ENTIRELY inside the range is removed whole. Fresh track, single
        // 1s clip moved to start at 1.5s, then delete the enclosing [1,3].
        auto wt = cmd (ops, "create_track", args1 ("name", "RangeWhole"))["data"].getProperty ("trackId", var()).toString();
        auto wc = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", wt }, { "seconds", 1.0 }, { "freq", 213.0 }}));
        if (ok (wc))
        {
            const auto wcid = wc["data"].getProperty ("clipId", var()).toString();
            cmd (ops, "move_clip", objN ({{ "clipId", wcid }, { "start", 1.5 }}));
            check (trackById (wt).getProperty ("clips", var()).size() == 1, "range: enclosed clip present before delete");
            auto wholeDel = cmd (ops, "delete_time_range", objN ({{ "start", 1.0 }, { "end", 3.0 },
                                                                 { "trackIds", var (juce::Array<var> { var (wt) }) }}));
            check (ok (wholeDel), "range: enclosing-range delete ok");
            check ((int) wholeDel["data"].getProperty ("removed", 0) == 1, "range: clip fully inside was removed whole");
            check (trackById (wt).getProperty ("clips", var()).size() == 0, "range: track empty after enclosing delete");
        }
    }

    // ─── ARR-011: opt-in RIPPLE (delete_time_range + trim_clip) ───
    // The `ripple` arg defaults FALSE, so the pre-existing lift/cut behaviour must be
    // untouched when it is absent — that is check (a) below, and it is the reason the
    // default-path asserts here duplicate the Wave C ones on purpose.
    section ("ARR-011: ripple delete / ripple trim");
    {
        // Sorted clip starts on a track. `trk` and `clipsVar` are bound to NAMED locals
        // before getArray(): trackById() hands back a var BY VALUE, and reading through a
        // pointer into a destroyed temporary is undefined behaviour.
        auto startsOf = [&] (const String& tid) -> juce::Array<double> {
            juce::Array<double> starts;
            auto trk = trackById (tid);
            auto clipsVar = trk.getProperty ("clips", var());
            if (auto* clips = clipsVar.getArray())
                for (auto& c : *clips)
                    starts.add ((double) c.getProperty ("start", -1.0));
            starts.sort();
            return starts;
        };
        auto near = [] (double a, double b) { return std::abs (a - b) < 0.05; };

        // Lay out three clips: A 0..2, B 3..4, C 5..6. Deleting [1,2] splits A and
        // removes its inside half (A -> 0..1), leaving B and C downstream of the range.
        auto layout = [&] (const String& name) -> String {
            auto tid = cmd (ops, "create_track", args1 ("name", name))["data"].getProperty ("trackId", var()).toString();
            struct { double seconds, start, freq; } spec[] = { { 2.0, 0.0, 221.0 }, { 1.0, 3.0, 223.0 }, { 1.0, 5.0, 227.0 } };
            for (auto& s : spec)
            {
                auto made = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", tid }, { "seconds", s.seconds }, { "freq", s.freq }}));
                const auto madeId = made["data"].getProperty ("clipId", var()).toString();
                cmd (ops, "move_clip", objN ({{ "clipId", madeId }, { "start", s.start }}));
            }
            return tid;
        };

        // (a) DEFAULT (no `ripple` arg) — the gap stays open and downstream clips do NOT move.
        {
            auto tid = layout ("RippleOff");
            check (startsOf (tid).size() == 3, "ripple-off: three clips laid out");
            auto del = cmd (ops, "delete_time_range", objN ({{ "start", 1.0 }, { "end", 2.0 },
                                                             { "trackIds", var (juce::Array<var> { var (tid) }) }}));
            check (ok (del), "ripple-off: delete_time_range [1,2] ok");
            check (! (bool) del["data"].getProperty ("ripple", true), "ripple-off: result reports ripple:false by default");
            auto s = startsOf (tid);
            check (s.size() == 3, "ripple-off: still three clips (A split, inside half removed)");
            check (s.size() == 3 && near (s[0], 0.0) && near (s[1], 3.0) && near (s[2], 5.0),
                   "ripple-off: downstream clips UNMOVED at 3s/5s (the 1..3s gap stays open)");
        }

        // (a2) Explicit ripple:false is identical to omitting the arg.
        {
            auto tid = layout ("RippleFalse");
            check (ok (cmd (ops, "delete_time_range", objN ({{ "start", 1.0 }, { "end", 2.0 }, { "ripple", false },
                                                             { "trackIds", var (juce::Array<var> { var (tid) }) }}))),
                   "ripple-false: delete ok");
            auto s = startsOf (tid);
            check (s.size() == 3 && near (s[1], 3.0) && near (s[2], 5.0),
                   "ripple-false: explicit false leaves downstream clips unmoved");
        }

        // (b) ripple:true — the 1s range closes up: downstream clips slide LEFT by exactly 1s.
        String rippleTid;
        {
            rippleTid = layout ("RippleOn");
            auto del = cmd (ops, "delete_time_range", objN ({{ "start", 1.0 }, { "end", 2.0 }, { "ripple", true },
                                                             { "trackIds", var (juce::Array<var> { var (rippleTid) }) }}));
            check (ok (del), "ripple-on: delete_time_range [1,2] ripple:true ok");
            check ((bool) del["data"].getProperty ("ripple", false), "ripple-on: result reports ripple:true");
            auto s = startsOf (rippleTid);
            check (s.size() == 3, "ripple-on: still three clips");
            check (s.size() == 3 && near (s[0], 0.0) && near (s[1], 2.0) && near (s[2], 4.0),
                   "ripple-on: downstream clips moved LEFT by exactly the 1s range length (3->2, 5->4)");
        }

        // (c) ONE undo reverts BOTH the removal and the shift (single Tracktion transaction).
        {
            check (ok (cmd (ops, "undo")), "ripple-undo: one undo ok");
            auto s = startsOf (rippleTid);
            check (s.size() == 3 && near (s[0], 0.0) && near (s[1], 3.0) && near (s[2], 5.0),
                   "ripple-undo: original clip positions fully restored (0/3/5) by ONE undo");
            auto trk = trackById (rippleTid);
            auto clipsVar = trk.getProperty ("clips", var());
            double firstLen = 0.0;
            if (auto* clips = clipsVar.getArray())
                for (auto& c : *clips)
                    if (near ((double) c.getProperty ("start", -1.0), 0.0))
                        firstLen = (double) c.getProperty ("length", 0.0);
            check (near (firstLen, 2.0), "ripple-undo: the split/removed clip is whole again (0..2s)");
        }

        // A ripple that would push a clip before 0 clamps at 0 rather than going negative.
        {
            auto tid = cmd (ops, "create_track", args1 ("name", "RippleClamp"))["data"].getProperty ("trackId", var()).toString();
            auto made = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", tid }, { "seconds", 1.0 }, { "freq", 229.0 }}));
            cmd (ops, "move_clip", objN ({{ "clipId", made["data"].getProperty ("clipId", var()).toString() }, { "start", 1.0 }}));
            check (ok (cmd (ops, "delete_time_range", objN ({{ "start", 0.0 }, { "end", 0.5 }, { "ripple", true },
                                                             { "trackIds", var (juce::Array<var> { var (tid) }) }}))),
                   "ripple-clamp: delete ok");
            auto s = startsOf (tid);
            check (s.size() == 1 && s[0] >= -1.0e-9, "ripple-clamp: resulting start is never negative");
        }

        // trim_clip ripple — shortening a clip pulls the next one left by the trimmed amount.
        {
            auto tid = cmd (ops, "create_track", args1 ("name", "RippleTrim"))["data"].getProperty ("trackId", var()).toString();
            auto a = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", tid }, { "seconds", 2.0 }, { "freq", 231.0 }}));
            const auto aid = a["data"].getProperty ("clipId", var()).toString();
            auto b = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", tid }, { "seconds", 1.0 }, { "freq", 233.0 }}));
            cmd (ops, "move_clip", objN ({{ "clipId", b["data"].getProperty ("clipId", var()).toString() }, { "start", 2.0 }}));

            // Default trim (no ripple arg) leaves the follower where it is.
            check (ok (cmd (ops, "trim_clip", objN ({{ "clipId", aid }, { "length", 1.5 }}))), "ripple-trim: plain trim ok");
            {
                auto s = startsOf (tid);
                check (s.size() == 2 && near (s[1], 2.0), "ripple-trim: default trim does NOT move the follower");
            }

            // ripple:true — trimming 1.5 -> 1.0 pulls the follower from 2.0 to 1.5.
            check (ok (cmd (ops, "trim_clip", objN ({{ "clipId", aid }, { "length", 1.0 }, { "ripple", true }}))),
                   "ripple-trim: ripple trim ok");
            {
                auto s = startsOf (tid);
                check (s.size() == 2 && near (s[1], 1.5), "ripple-trim: follower pulled left by the trimmed 0.5s");
            }
            check (ok (cmd (ops, "undo")), "ripple-trim: undo ok");
            {
                auto s = startsOf (tid);
                check (s.size() == 2 && near (s[1], 2.0), "ripple-trim: one undo restores BOTH the length and the follower");
            }
        }
    }

    // ─── CLP-LOOP: clip loop region (reality-pack invariant 28) ───
    section ("CLP-LOOP: set_clip_loop");
    {
        auto clipById = [&] (const String& target) -> var {
            auto snap = ops.snapshot();               // bind: snapshot() returns a var BY VALUE
            auto tracksVar = snap.getProperty ("tracks", var());
            if (auto* tracks = tracksVar.getArray())
                for (auto& tr : *tracks)
                {
                    auto clipsVar = tr.getProperty ("clips", var());
                    if (auto* clips = clipsVar.getArray())
                        for (auto& c : *clips)
                            if (c.getProperty ("id", var()).toString() == target) return c;
                }
            return {};
        };
        auto near = [] (double a, double b) { return std::abs (a - b) < 0.05; };

        auto lt = cmd (ops, "create_track", args1 ("name", "ClipLoop"))["data"].getProperty ("trackId", var()).toString();
        auto lc = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", lt }, { "seconds", 4.0 }, { "freq", 241.0 }}));
        const auto lcid = lc["data"].getProperty ("clipId", var()).toString();
        check (lcid.isNotEmpty(), "loop: 0..4s tone clip created");

        // Defaults: a fresh clip does not loop, and the snapshot says so unconditionally.
        check (! (bool) clipById (lcid).getProperty ("loopEnabled", true), "loop: loopEnabled defaults to false");
        check (near ((double) clipById (lcid).getProperty ("loopLength", -1.0), 0.0), "loop: loopLength defaults to 0");

        // Enable a sub-region: loop 0.5..1.5s of the source.
        auto set = cmd (ops, "set_clip_loop", objN ({{ "clipId", lcid }, { "enabled", true },
                                                     { "start", 0.5 }, { "length", 1.0 }}));
        check (ok (set), "loop: set_clip_loop enabled ok");
        check ((bool) set["data"].getProperty ("loopEnabled", false), "loop: result echoes loopEnabled true");
        check (near ((double) set["data"].getProperty ("loopLength", -1.0), 1.0), "loop: result echoes the post-clamp loopLength");
        check ((bool) clipById (lcid).getProperty ("loopEnabled", false), "loop: loopEnabled round-trips through the snapshot");
        check (near ((double) clipById (lcid).getProperty ("loopStart", -1.0), 0.5), "loop: loopStart round-trips (0.5s)");
        check (near ((double) clipById (lcid).getProperty ("loopLength", -1.0), 1.0), "loop: loopLength round-trips (1.0s)");

        // Undo / redo.
        check (ok (cmd (ops, "undo")), "loop: undo set_clip_loop ok");
        check (! (bool) clipById (lcid).getProperty ("loopEnabled", true), "loop: undo restores the clip un-looped");
        check (ok (cmd (ops, "redo")), "loop: redo set_clip_loop ok");
        check ((bool) clipById (lcid).getProperty ("loopEnabled", false), "loop: redo re-applies the loop region");

        // Persistence — loopStart/loopLength are CachedValues on the clip's own
        // ValueTree, so save/reload is free (mirrors the reverse/crossfade proof).
        cmd (ops, "save"); cmd (ops, "reload");
        check ((bool) clipById (lcid).getProperty ("loopEnabled", false), "loop: loopEnabled persists across save/reload");
        check (near ((double) clipById (lcid).getProperty ("loopStart", -1.0), 0.5), "loop: loopStart persists across save/reload");
        check (near ((double) clipById (lcid).getProperty ("loopLength", -1.0), 1.0), "loop: loopLength persists across save/reload");

        // Disabling clears the loop WITHOUT moving/resizing the clip (we deliberately do
        // not call AudioClipBase::disableLooping(), which rewrites position + offset).
        const double preStart  = (double) clipById (lcid).getProperty ("start", -1.0);
        const double preLength = (double) clipById (lcid).getProperty ("length", -1.0);
        check (ok (cmd (ops, "set_clip_loop", objN ({{ "clipId", lcid }, { "enabled", false }}))), "loop: disable ok");
        check (! (bool) clipById (lcid).getProperty ("loopEnabled", true), "loop: disabled clip reports loopEnabled false");
        check (near ((double) clipById (lcid).getProperty ("start", -99.0), preStart)
               && near ((double) clipById (lcid).getProperty ("length", -99.0), preLength),
               "loop: disabling the loop does NOT move or resize the clip");

        // enabled:true with a zero length is rejected (and mutates nothing).
        check (! ok (cmd (ops, "set_clip_loop", objN ({{ "clipId", lcid }, { "enabled", true }, { "length", 0.0 }}))),
               "loop: enabled with length 0 rejected");
        check (! (bool) clipById (lcid).getProperty ("loopEnabled", true), "loop: rejected zero-length call left the clip un-looped");

        // Type rejection: audio-clip-only, mirrors set_clip_gain/set_clip_reverse.
        {
            auto midiLoop = cmd (ops, "add_midi_clip", objN ({{ "trackId", lt }, { "length", 1.0 }}));
            const auto midiLoopCid = midiLoop["data"].getProperty ("clipId", var()).toString();
            auto rej = cmd (ops, "set_clip_loop", objN ({{ "clipId", midiLoopCid }, { "enabled", true }, { "length", 1.0 }}));
            check (! ok (rej), "loop: set_clip_loop on a MIDI clip rejected");
            check (! (bool) clipById (midiLoopCid).getProperty ("loopEnabled", false),
                   "loop: rejected MIDI clip was not mutated");
            cmd (ops, "remove_clip", args1 ("clipId", midiLoopCid));   // tidy
        }
        check (! ok (cmd (ops, "set_clip_loop", objN ({{ "clipId", "nope" }, { "enabled", true }}))),
               "loop: unknown clipId rejected");

        // JSONL: logged undoable:true (mirrors the fade/reverse asserts).
        {
            auto llog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
            bool loopU = false;
            for (auto& ln : StringArray::fromLines (llog))
                if (ln.contains ("\"command\": \"set_clip_loop\"") && ln.contains ("\"undoable\": true")) loopU = true;
            check (loopU, "loop: set_clip_loop logged undoable:true");
        }
    }

    // ─── Wave D: MIX-008 group (submix) tracks ───
    // A FolderTrack created asSubmix=true genuinely sums its children (the graph
    // builder routes them through a SummingNode + the folder's plugin chain — the
    // engine's own nested-submix test proves the audio). Headless we verify the
    // command surface, the snapshot structure, the group fader, and undo/redo.
    section ("Wave D: group / submix tracks (MIX-008)");
    {
        auto ga = cmd (ops, "create_track", args1 ("name", "GrpA"))["data"].getProperty ("trackId", var()).toString();
        auto gb = cmd (ops, "create_track", args1 ("name", "GrpB"))["data"].getProperty ("trackId", var()).toString();
        check (ga.isNotEmpty() && gb.isNotEmpty(), "group: two member tracks created");

        // Create a group over both members (ONE undoable transaction).
        auto gr = cmd (ops, "create_group_track",
                       objN ({{ "name", "Drums" },
                              { "trackIds", var (juce::Array<var> { var (ga), var (gb) }) }}));
        check (ok (gr), "group: create_group_track ok");
        const auto gid = gr["data"].getProperty ("groupId", var()).toString();
        check (gid.isNotEmpty(), "group: returned a groupId");
        check ((int) gr["data"].getProperty ("moved", 0) == 2, "group: moved both member tracks");

        auto gv = trackById (gid);
        check (gv.getProperty ("type", var()).toString() == "group", "group: snapshot entry has type group");
        check ((bool) gv.getProperty ("isGroup", false), "group: snapshot entry flagged isGroup");
        check (gv.getProperty ("name", var()).toString() == "Drums", "group: snapshot entry carries the name");
        check (gv.hasProperty ("volumeDb"), "group: snapshot entry has a real fader (submix VolumeAndPan)");
        check (trackById (ga).getProperty ("parentId", var()).toString() == gid, "group: member A carries parentId");
        check (trackById (gb).getProperty ("parentId", var()).toString() == gid, "group: member B carries parentId");

        // The group fader + rename drive the FolderTrack via the EXISTING commands.
        check (ok (cmd (ops, "set_track_volume", objN ({{ "trackId", gid }, { "db", -6.0 }}))),
               "group: set_track_volume on the group ok");
        check (std::abs ((double) trackById (gid).getProperty ("volumeDb", 0.0) - (-6.0)) < 0.25,
               "group: group fader reflects -6 dB");
        check (ok (cmd (ops, "rename_track", objN ({{ "trackId", gid }, { "name", "DrumBus" }}))),
               "group: rename_track on the group ok");
        check (trackById (gid).getProperty ("name", var()).toString() == "DrumBus", "group: rename reflects");

        // One undo step per command: undo(rename) -> undo(volume) -> undo(create+move).
        cmd (ops, "undo"); cmd (ops, "undo");
        check (ok (cmd (ops, "undo")), "group: undo (create_group_track) ok");
        check (! trackById (gid).isObject() || trackById (gid).getProperty ("type", var()).toString() != "group",
               "group: undo removed the group entry");
        check (trackById (ga).getProperty ("parentId", var()).toString().isEmpty(), "group: undo restored A to top level");
        check (ok (cmd (ops, "redo")), "group: redo ok");
        check (trackById (ga).getProperty ("parentId", var()).toString() == gid, "group: redo re-grouped A");

        // Ungroup: hoists the members back to top level + deletes the group.
        auto ug = cmd (ops, "ungroup_track", args1 ("trackId", gid));
        check (ok (ug), "group: ungroup_track ok");
        check ((int) ug["data"].getProperty ("hoisted", 0) == 2, "group: ungroup hoisted both members");
        check (trackById (ga).getProperty ("parentId", var()).toString().isEmpty(), "group: A back at top level");
        check (trackById (ga).isObject() && trackById (gb).isObject(), "group: both members survived the ungroup");
        check (! trackById (gid).isObject(), "group: group entry gone after ungroup");
        check (ok (cmd (ops, "undo")), "group: undo (ungroup) ok");
        check (trackById (ga).getProperty ("parentId", var()).toString() == gid, "group: undo restored the grouping");
        cmd (ops, "redo");   // leave the edit flat (group removed) for hygiene

        // Graceful bad args.
        check (! ok (cmd (ops, "ungroup_track", args1 ("trackId", "no-such-group"))), "group: ungroup bad id errors");
        auto gunk = cmd (ops, "create_group_track",
                         objN ({{ "trackIds", var (juce::Array<var> { var ("bogus-id") }) }}));
        check (ok (gunk), "group: unknown member ids are skipped, not fatal");
        check ((int) gunk["data"].getProperty ("moved", -1) == 0, "group: nothing moved for unknown ids");
        check ((int) gunk["data"].getProperty ("unknownTrackIds", 0) == 1, "group: unknown ids reported");
        cmd (ops, "ungroup_track", args1 ("trackId", gunk["data"].getProperty ("groupId", var()).toString()));

        // JSONL records both commands as undoable Edit mutations.
        auto glog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        bool gUndoable = false, ugUndoable = false;
        for (auto& ln : juce::StringArray::fromLines (glog))
        {
            if (ln.contains ("\"command\": \"create_group_track\"") && ln.contains ("\"undoable\": true")) gUndoable = true;
            if (ln.contains ("\"command\": \"ungroup_track\"") && ln.contains ("\"undoable\": true")) ugUndoable = true;
        }
        check (gUndoable, "group: create_group_track logged undoable:true");
        check (ugUndoable, "group: ungroup_track logged undoable:true");
    }

    // ─── Wave R: RTG-001 input choice + RTG-002 output routing ───
    // Engine machinery exists fully (WaveInputDevice-per-pair; te::TrackOutput with
    // route-to-device AND route-to-track). Headless: enumeration shape, the stored
    // input CHOICE round-trip, and the track->track output routing (ValueTree-backed,
    // no hardware needed) incl. cycle rejection, undo, and persistence. Real capture
    // from a chosen pair / audible multi-out are hardware-gated (verified live).
    section ("Wave R: routing (RTG-001 inputs / RTG-002 outputs)");
    {
        // Read-only enumerations: ok + shape; not logged.
        auto lwiBefore = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        auto lwi = cmd (ops, "list_wave_inputs", var());
        check (ok (lwi), "routing: list_wave_inputs ok");
        auto lwiInputs = lwi["data"].getProperty ("inputs", var());
        check (lwiInputs.isArray(), "routing: list_wave_inputs inputs is an array (empty headless)");
        auto lto = cmd (ops, "list_track_outputs", var());
        check (ok (lto), "routing: list_track_outputs ok");
        auto ltoOuts = lto["data"].getProperty ("outputs", var());
        auto ltoTracks = lto["data"].getProperty ("tracks", var());
        check (ltoOuts.isArray(), "routing: list_track_outputs outputs is an array");
        check (ltoTracks.isArray() && ltoTracks.size() > 0, "routing: list_track_outputs lists candidate tracks");
        auto lwiAfter = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        check (lwiAfter == lwiBefore, "routing: list commands are READ-ONLY (not logged)");

        // RTG-001 — the input CHOICE: stored on the track, graceful headless, persists.
        auto ra = cmd (ops, "create_track", args1 ("name", "RouteA"))["data"].getProperty ("trackId", var()).toString();
        auto rb = cmd (ops, "create_track", args1 ("name", "RouteB"))["data"].getProperty ("trackId", var()).toString();
        check (ra.isNotEmpty() && rb.isNotEmpty(), "routing: two tracks created");
        auto sti = cmd (ops, "set_track_input", objN ({{ "trackId", ra }, { "deviceID", "in-3-4" }}));
        check (ok (sti), "routing: set_track_input ok (graceful headless)");
        check (! (bool) sti["data"].getProperty ("applied", true), "routing: applied:false headless (choice stored)");
        check (trackById (ra)["input"].getProperty ("deviceID", var()).toString() == "in-3-4",
               "routing: chosen input deviceID in the snapshot");
        check (! ok (cmd (ops, "set_track_input", args1 ("trackId", ra))), "routing: set_track_input missing deviceID errors");
        check (! ok (cmd (ops, "set_track_input", objN ({{ "trackId", "nope" }, { "deviceID", "x" }}))),
               "routing: set_track_input bad trackId errors");
        check (ok (cmd (ops, "save")) && ok (cmd (ops, "reload")), "routing: save+reload ok");
        check (trackById (ra)["input"].getProperty ("deviceID", var()).toString() == "in-3-4",
               "routing: input choice persists across save/reload");

        // RTG-002 — track->track routing (fully headless: ValueTree-backed).
        check (! trackById (ra).hasProperty ("output"), "routing: default output emits no output field");
        auto sto = cmd (ops, "set_track_output", objN ({{ "trackId", ra }, { "destTrackId", rb }}));
        check (ok (sto), "routing: set_track_output A->B ok");
        auto outv = trackById (ra)["output"];
        check ((bool) outv.getProperty ("isTrack", false), "routing: output isTrack");
        check (outv.getProperty ("destId", var()).toString() == rb, "routing: output destId == B");
        // Cycle + self rejection.
        check (! ok (cmd (ops, "set_track_output", objN ({{ "trackId", rb }, { "destTrackId", ra }}))),
               "routing: B->A rejected (cycle)");
        check (! ok (cmd (ops, "set_track_output", objN ({{ "trackId", ra }, { "destTrackId", ra }}))),
               "routing: A->A rejected (self)");
        // Persistence + undo.
        check (ok (cmd (ops, "save")) && ok (cmd (ops, "reload")), "routing: save+reload ok (output)");
        check (trackById (ra)["output"].getProperty ("destId", var()).toString() == rb,
               "routing: A->B routing persists across save/reload");
        check (ok (cmd (ops, "set_track_output", objN ({{ "trackId", ra }, { "output", "default" }}))),
               "routing: reset to default ok");
        check (! trackById (ra).hasProperty ("output"), "routing: reset removed the output field");
        check (ok (cmd (ops, "undo")), "routing: undo (reset) ok");
        check (trackById (ra)["output"].getProperty ("destId", var()).toString() == rb,
               "routing: undo restored the A->B routing");
        check (! ok (cmd (ops, "set_track_output", args1 ("trackId", ra))),
               "routing: set_track_output with no destination errors");

        // JSONL postures: input choice is a preference, output routing is undoable.
        auto rlog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        bool inPref = false, outUndo = false;
        for (auto& ln : juce::StringArray::fromLines (rlog))
        {
            if (ln.contains ("\"command\": \"set_track_input\"") && ln.contains ("\"undoable\": false")) inPref = true;
            if (ln.contains ("\"command\": \"set_track_output\"") && ln.contains ("\"undoable\": true")) outUndo = true;
        }
        check (inPref, "routing: set_track_input logged undoable:false (preference)");
        check (outUndo, "routing: set_track_output logged undoable:true (Edit mutation)");
    }

    // ─── Wave T: SES-001 tempo map (tempo / time-sig changes over time) ───
    // The engine's TempoSequence does the math + playback natively; Mosh inserts
    // STEP changes (curve=1.0 -> hold-then-jump; the ramp branch is gated on
    // curve != +-1). ENGINE TRUTH is asserted here via getBpmAt at probe times;
    // the UI's piecewise-constant mapping is exact by construction for steps.
    section ("Wave T: tempo map (SES-001)");
    {
        auto& seq = eng.edit().tempoSequence;
        // Normalize the base for deterministic probes.
        check (ok (cmd (ops, "set_tempo", args1 ("bpm", 120))), "tempo: base 120 ok");
        const int temposBefore = seq.getNumTempos();

        // Insert step changes: 140 @ 10s, 90 @ 20s.
        auto t1 = cmd (ops, "insert_tempo_change", objN ({{ "time", 10.0 }, { "bpm", 140 }}));
        check (ok (t1), "tempo: insert 140 at 10s ok");
        auto t2 = cmd (ops, "insert_tempo_change", objN ({{ "time", 20.0 }, { "bpm", 90 }}));
        check (ok (t2), "tempo: insert 90 at 20s ok");
        check (seq.getNumTempos() == temposBefore + 2, "tempo: two points added");

        // ENGINE truth — step semantics at the probes (exact, no ramp).
        auto bpmAt = [&] (double s) { return seq.getBpmAt (tracktion::TimePosition::fromSeconds (s)); };
        check (std::abs (bpmAt (5.0)  - 120.0) < 0.01, "tempo: engine bpm at 5s == 120");
        check (std::abs (bpmAt (15.0) - 140.0) < 0.01, "tempo: engine bpm at 15s == 140 (step, no ramp)");
        check (std::abs (bpmAt (25.0) -  90.0) < 0.01, "tempo: engine bpm at 25s == 90");
        check (std::abs (bpmAt (9.9)  - 120.0) < 0.01, "tempo: engine bpm just before the change == 120 (hold)");

        // Beats<->seconds round-trip across both boundaries (engine math).
        const auto probeBeats = seq.toBeats (tracktion::TimePosition::fromSeconds (25.0));
        const auto roundTrip  = seq.toTime (probeBeats).inSeconds();
        check (std::abs (roundTrip - 25.0) < 1.0e-6, "tempo: beats<->seconds round-trip across the map");

        // Snapshot serializes the ordered map (additive: session.tempo stays point 0).
        auto sess = ops.snapshot()["session"];
        auto tmv = sess.getProperty ("tempoMap", var());
        check (tmv.isArray() && tmv.size() == temposBefore + 2, "tempo: snapshot tempoMap has all points");
        check (std::abs ((double) tmv[tmv.size() - 1].getProperty ("bpm", 0.0) - 90.0) < 0.01,
               "tempo: snapshot last point is the 90 BPM change");
        check (std::abs ((double) sess.getProperty ("tempo", 0.0) - 120.0) < 0.01,
               "tempo: session.tempo still reports point 0 (back-compat)");

        // Time-sig change @ 30s -> 3/4; map serialized; engine agrees.
        const int sigsBefore = seq.getNumTimeSigs();
        check (ok (cmd (ops, "insert_time_sig_change", objN ({{ "time", 30.0 }, { "numerator", 3 }, { "denominator", 4 }}))),
               "tempo: insert 3/4 at 30s ok");
        check (seq.getNumTimeSigs() == sigsBefore + 1, "tempo: time-sig point added");
        auto sigv = ops.snapshot()["session"].getProperty ("timeSigMap", var());
        check (sigv.isArray() && sigv.size() == sigsBefore + 1, "tempo: snapshot timeSigMap serialized");
        check ((int) sigv[sigv.size() - 1].getProperty ("numerator", 0) == 3, "tempo: last sig point is 3/4");

        // Persistence: the map survives save/reload.
        check (ok (cmd (ops, "save")) && ok (cmd (ops, "reload")), "tempo: save+reload ok");
        auto& seq2 = eng.edit().tempoSequence;   // reload swapped the Edit
        check (std::abs (seq2.getBpmAt (tracktion::TimePosition::fromSeconds (15.0)) - 140.0) < 0.01,
               "tempo: map survives save/reload (140 at 15s)");

        // remove_tempo_change: drop the middle point -> bpm at 15s reverts to 120.
        check (ok (cmd (ops, "remove_tempo_change", args1 ("index", 1))), "tempo: remove middle point ok");
        check (std::abs (seq2.getBpmAt (tracktion::TimePosition::fromSeconds (15.0)) - 120.0) < 0.01,
               "tempo: bpm at 15s reverts after removal");
        check (ok (cmd (ops, "undo")), "tempo: undo (remove) ok");
        check (std::abs (eng.edit().tempoSequence.getBpmAt (tracktion::TimePosition::fromSeconds (15.0)) - 140.0) < 0.01,
               "tempo: undo restored the 140 change");

        // Guards: index 0 protected; bad args rejected.
        check (! ok (cmd (ops, "remove_tempo_change", args1 ("index", 0))), "tempo: removing point 0 rejected");
        check (! ok (cmd (ops, "remove_tempo_change", args1 ("index", 99))), "tempo: out-of-range index rejected");
        check (! ok (cmd (ops, "insert_tempo_change", objN ({{ "time", -1.0 }, { "bpm", 120 }}))), "tempo: negative time rejected");
        check (! ok (cmd (ops, "insert_tempo_change", objN ({{ "time", 5.0 }, { "bpm", 5000 }}))), "tempo: absurd bpm rejected");
        check (! ok (cmd (ops, "remove_time_sig_change", args1 ("index", 0))), "tempo: removing sig point 0 rejected");
        check (! ok (cmd (ops, "insert_time_sig_change", objN ({{ "time", 5.0 }, { "numerator", 4 }, { "denominator", 5 }}))),
               "tempo: non-power-of-two denominator rejected");

        // JSONL: all four commands undoable:true.
        auto tlog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        bool itU = false, rtU = false, isU = false;
        for (auto& ln : juce::StringArray::fromLines (tlog))
        {
            if (ln.contains ("\"command\": \"insert_tempo_change\"") && ln.contains ("\"undoable\": true")) itU = true;
            if (ln.contains ("\"command\": \"remove_tempo_change\"") && ln.contains ("\"undoable\": true")) rtU = true;
            if (ln.contains ("\"command\": \"insert_time_sig_change\"") && ln.contains ("\"undoable\": true")) isU = true;
        }
        check (itU, "tempo: insert_tempo_change logged undoable:true");
        check (rtU, "tempo: remove_tempo_change logged undoable:true");
        check (isU, "tempo: insert_time_sig_change logged undoable:true");
    }

    // ─── Wave V: tempo RAMPS (Bezier curves) ───
    // curve lives on the point that STARTS a span and shapes the glide TO the next
    // point: 1.0 = step (hold-then-jump), values in (-1,1) ramp. Engine truth via
    // getBpmAt mid-ramp; the snapshot emits the engine-faithful fine sections
    // (its own subdivision boundaries) so the UI mapping stays exact.
    section ("Wave V: tempo ramps (curves)");
    {
        auto& seq = eng.edit().tempoSequence;
        // Clean slate: drop any leftover points from earlier blocks, base 120.
        while (seq.getNumTempos() > 1) cmd (ops, "remove_tempo_change", args1 ("index", 1));
        while (seq.getNumTimeSigs() > 1) cmd (ops, "remove_time_sig_change", args1 ("index", 1));
        check (ok (cmd (ops, "set_tempo", args1 ("bpm", 120))), "ramp: base 120 ok");

        check (ok (cmd (ops, "insert_tempo_change", objN ({{ "time", 8.0 }, { "bpm", 60 }}))),
               "ramp: insert 60 at 8s ok (step by default)");
        auto bpmAt = [&] (double s) { return seq.getBpmAt (tracktion::TimePosition::fromSeconds (s)); };
        check (std::abs (bpmAt (4.0) - 120.0) < 0.01, "ramp: step span holds 120 mid-way");
        auto snapBefore = ops.snapshot()["session"];
        check (! snapBefore.hasProperty ("tempoSections"), "ramp: step-only map emits NO tempoSections (lean snapshot)");

        // Turn the base span into a LINEAR ramp: 120 glides to 60 across 0..8s.
        check (ok (cmd (ops, "set_tempo_curve", objN ({{ "index", 0 }, { "curve", 0.0 }}))),
               "ramp: set_tempo_curve index 0 -> linear ok");
        const double mid = bpmAt (4.0);
        check (mid < 119.0 && mid > 61.0, "ramp: engine bpm mid-ramp is strictly between 60 and 120");
        check (bpmAt (1.0) > bpmAt (7.0), "ramp: engine bpm decreases monotonically across the ramp");

        // The snapshot now carries the curve + the engine-faithful fine sections.
        auto sess = ops.snapshot()["session"];
        auto tm = sess.getProperty ("tempoMap", var());
        check (std::abs ((double) tm[0].getProperty ("curve", 1.0)) < 0.01, "ramp: tempoMap[0].curve == 0 serialized");
        auto secs = sess.getProperty ("tempoSections", var());
        check (secs.isArray() && secs.size() > seq.getNumTempos(), "ramp: fine tempoSections emitted (more than the points)");
        bool increasing = true;
        for (int i = 1; i < secs.size(); ++i)
            if ((double) secs[i].getProperty ("time", 0.0) <= (double) secs[i - 1].getProperty ("time", 0.0))
                increasing = false;
        check (increasing, "ramp: section times strictly increasing");

        // Undo restores the step (and the lean snapshot); redo restores the ramp.
        check (ok (cmd (ops, "undo")), "ramp: undo (set_tempo_curve) ok");
        check (std::abs (bpmAt (4.0) - 120.0) < 0.01, "ramp: undo restored the step (120 mid-way)");
        check (! ops.snapshot()["session"].hasProperty ("tempoSections"), "ramp: undo removed tempoSections");
        check (ok (cmd (ops, "redo")), "ramp: redo ok");
        check (bpmAt (4.0) < 119.0, "ramp: redo restored the ramp");

        // insert_tempo_change accepts a curve arg directly.
        check (ok (cmd (ops, "insert_tempo_change", objN ({{ "time", 16.0 }, { "bpm", 100 }, { "curve", 0.0 }}))),
               "ramp: insert with curve arg ok");
        auto tm2v = ops.snapshot()["session"].getProperty ("tempoMap", var());
        check (std::abs ((double) tm2v[tm2v.size() - 1].getProperty ("curve", 1.0)) < 0.01,
               "ramp: inserted point carries curve 0");

        // Guards + JSONL.
        check (! ok (cmd (ops, "set_tempo_curve", objN ({{ "index", 99 }, { "curve", 0.0 }}))), "ramp: bad index rejected");
        check (! ok (cmd (ops, "set_tempo_curve", args1 ("index", 0))), "ramp: missing curve rejected");
        auto rlog2 = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        bool curveU = false;
        for (auto& ln : juce::StringArray::fromLines (rlog2))
            if (ln.contains ("\"command\": \"set_tempo_curve\"") && ln.contains ("\"undoable\": true")) curveU = true;
        check (curveU, "ramp: set_tempo_curve logged undoable:true");

        // Clean up for the warp block: flat 120 map, step curve.
        cmd (ops, "set_tempo_curve", objN ({{ "index", 0 }, { "curve", 1.0 }}));
        while (seq.getNumTempos() > 1) cmd (ops, "remove_tempo_change", args1 ("index", 1));
        cmd (ops, "set_tempo", args1 ("bpm", 120));
    }

    // ─── Wave V: audio WARP (auto-tempo time-stretch) ───
    // setAutoTempo re-anchors the clip in BEATS: its seconds-length re-derives from
    // the live tempo map IMMEDIATELY (no proxy wait) — the headless contract is
    // that halving the tempo doubles the clip's seconds length. Stretching uses
    // the engine's vendored SoundTouch (enabled at build). Warp MARKERS deferred.
    section ("Wave V: audio warp (auto-tempo)");
    {
        auto wt = cmd (ops, "create_track", args1 ("name", "WarpTrack"))["data"].getProperty ("trackId", var()).toString();
        auto wc = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", wt }, { "seconds", 2.0 }, { "freq", 311.0 }}));
        check (ok (wc), "warp: 2s tone clip ok");
        const auto wcid = wc["data"].getProperty ("clipId", var()).toString();
        auto clipLen = [&]() -> double {
            auto tv = trackById (wt);
            auto cv = tv.getProperty ("clips", var());
            if (auto* arr = cv.getArray())
                for (auto& c : *arr)
                    if (c.getProperty ("id", var()).toString() == wcid)
                        return (double) c.getProperty ("length", 0.0);
            return -1.0;
        };
        check (std::abs (clipLen() - 2.0) < 0.05, "warp: clip starts at 2.0s");

        // Enable warp: 1:1 at the current tempo (sourceBpm defaults to the map).
        auto w1 = cmd (ops, "set_clip_warp", objN ({{ "clipId", wcid }, { "autoTempo", true }}));
        check (ok (w1), "warp: enable ok");
        check (w1["data"].getProperty ("stretchMode", var()).toString().containsIgnoreCase ("soundtouch"),
               "warp: stretch mode is SoundTouch (vendored stretcher compiled in)");
        check (std::abs (clipLen() - 2.0) < 0.05, "warp: enabling at the same tempo is a 1:1 no-op");
        {
            auto tv = trackById (wt);
            auto cv = tv.getProperty ("clips", var());
            bool autoT = false; double srcBpm = 0;
            if (auto* arr = cv.getArray())
                for (auto& c : *arr)
                    if (c.getProperty ("id", var()).toString() == wcid)
                    { autoT = (bool) c.getProperty ("autoTempo", false); srcBpm = (double) c.getProperty ("sourceBpm", 0.0); }
            check (autoT, "warp: snapshot clip carries autoTempo");
            check (std::abs (srcBpm - 120.0) < 0.5, "warp: sourceBpm defaulted to the map tempo (120)");
        }

        // THE CONTRACT: halve the tempo -> the warped clip's seconds-length doubles.
        check (ok (cmd (ops, "set_tempo", args1 ("bpm", 60))), "warp: tempo 120 -> 60 ok");
        check (std::abs (clipLen() - 4.0) < 0.1, "warp: half tempo DOUBLES the clip length (4.0s)");
        check (ok (cmd (ops, "set_tempo", args1 ("bpm", 120))), "warp: tempo back to 120 ok");
        check (std::abs (clipLen() - 2.0) < 0.1, "warp: restoring tempo restores the length (2.0s)");

        // Warp OFF: the clip is seconds-anchored again; tempo changes leave it alone.
        check (ok (cmd (ops, "set_clip_warp", objN ({{ "clipId", wcid }, { "autoTempo", false }}))), "warp: disable ok");
        cmd (ops, "set_tempo", args1 ("bpm", 60));
        check (std::abs (clipLen() - 2.0) < 0.1, "warp: unwarped clip ignores the tempo change");
        cmd (ops, "set_tempo", args1 ("bpm", 120));

        // Guards + posture.
        check (! ok (cmd (ops, "set_clip_warp", args1 ("clipId", wcid))), "warp: missing autoTempo rejected");
        check (! ok (cmd (ops, "set_clip_warp", objN ({{ "clipId", "no-such" }, { "autoTempo", true }}))), "warp: bad clipId rejected");
        auto wlog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        bool warpU = false;
        for (auto& ln : juce::StringArray::fromLines (wlog))
            if (ln.contains ("\"command\": \"set_clip_warp\"") && ln.contains ("\"undoable\": true")) warpU = true;
        check (warpU, "warp: set_clip_warp logged undoable:true");

        cmd (ops, "remove_track", args1 ("trackId", wt));   // tidy
    }

    // Ableton-style "easy warp": stretch a clip to a target length / bar count
    // (deriving sourceBpm) and detect a loop's BPM offline. stretch_clip drives the
    // drag-to-stretch gesture + the Inspector Fit/×2/÷2 helpers; detect_clip_bpm feeds
    // the auto-lock-to-grid path. Deterministic — the detector is pure C++ (no service).
    section ("Wave V2: stretch_clip + detect_clip_bpm (easy warp)");
    {
        auto st = cmd (ops, "create_track", args1 ("name", "StretchTrack"))["data"].getProperty ("trackId", var()).toString();
        auto sc = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", st }, { "seconds", 2.0 }, { "freq", 220.0 }}));
        check (ok (sc), "stretch: 2s tone clip ok");
        const auto scid = sc["data"].getProperty ("clipId", var()).toString();
        auto len = [&]() -> double {
            auto tv = trackById (st);
            auto cv = tv.getProperty ("clips", var());
            if (auto* arr = cv.getArray())
                for (auto& c : *arr)
                    if (c.getProperty ("id", var()).toString() == scid)
                        return (double) c.getProperty ("length", 0.0);
            return -1.0;
        };
        auto warpedOn = [&]() -> bool {
            auto tv = trackById (st);
            auto cv = tv.getProperty ("clips", var());
            if (auto* arr = cv.getArray())
                for (auto& c : *arr)
                    if (c.getProperty ("id", var()).toString() == scid)
                        return (bool) c.getProperty ("autoTempo", false);
            return false;
        };
        check (std::abs (len() - 2.0) < 0.05, "stretch: clip starts at 2.0s");

        // Stretch to a 3.0s warped length -> the clip fills 3.0s and warp turns on.
        auto s1 = cmd (ops, "stretch_clip", objN ({{ "clipId", scid }, { "length", 3.0 }}));
        check (ok (s1), "stretch: to 3.0s ok");
        check (std::abs (len() - 3.0) < 0.1, "stretch: clip is now 3.0s");
        check (warpedOn(), "stretch: enabling stretch turns auto-tempo on");
        check (std::abs ((double) s1["data"].getProperty ("length", 0.0) - 3.0) < 0.1, "stretch: result reports 3.0s length");

        // ÷2 (stretch to 1.5s), then fit-to-bars at 120bpm 4/4 (1 bar = 2.0s, 2 bars = 4.0s).
        check (ok (cmd (ops, "stretch_clip", objN ({{ "clipId", scid }, { "length", 1.5 }}))), "stretch: to 1.5s ok");
        check (std::abs (len() - 1.5) < 0.1, "stretch: halved to 1.5s");
        check (ok (cmd (ops, "stretch_clip", objN ({{ "clipId", scid }, { "bars", 1.0 }}))), "stretch: fit 1 bar ok");
        check (std::abs (len() - 2.0) < 0.1, "stretch: 1 bar == 2.0s at 120bpm 4/4");
        check (ok (cmd (ops, "stretch_clip", objN ({{ "clipId", scid }, { "bars", 2.0 }}))), "stretch: fit 2 bars ok");
        check (std::abs (len() - 4.0) < 0.1, "stretch: 2 bars == 4.0s at 120bpm 4/4");

        // Undo restores the 1-bar length; the command is logged undoable.
        check (ok (cmd (ops, "undo")), "stretch: undo ok");
        check (std::abs (len() - 2.0) < 0.1, "stretch: undo restores 1-bar length (2.0s)");
        {
            auto slog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
            bool stretchU = false;
            for (auto& ln : juce::StringArray::fromLines (slog))
                if (ln.contains ("\"command\": \"stretch_clip\"") && ln.contains ("\"undoable\": true")) stretchU = true;
            check (stretchU, "stretch: stretch_clip logged undoable:true");
        }

        // Guards.
        check (! ok (cmd (ops, "stretch_clip", args1 ("clipId", scid))), "stretch: missing length/bars rejected");
        check (! ok (cmd (ops, "stretch_clip", objN ({{ "clipId", "nope" }, { "length", 2.0 }}))), "stretch: bad clipId rejected");

        // detect_clip_bpm on a pure tone: read-only, no pulse -> either errors or low
        // confidence. Must not crash and must not spuriously claim a strong beat.
        auto dTone = cmd (ops, "detect_clip_bpm", args1 ("clipId", scid));
        if (ok (dTone))
            check ((double) dTone["data"].getProperty ("confidence", 1.0) < 0.5, "detect: pure tone -> low confidence");
        else
            check (true, "detect: pure tone reported no reliable pulse (ok)");

        // detect_clip_bpm on a synthesized 120bpm click track -> ~120 with confidence.
        auto makeClickWav = [&] (double bpm, double seconds, const juce::String& name) -> juce::File
        {
            const double sr = 44100.0;
            const juce::int64 n = (juce::int64) (sr * seconds);
            juce::AudioBuffer<float> buf (1, (int) n);
            buf.clear();
            const int clickLen = (int) (sr * 0.01);   // 10ms click
            const double period = 60.0 / bpm;         // seconds per beat
            for (double t = 0.0; t < seconds; t += period)
            {
                const juce::int64 s0 = (juce::int64) (t * sr);
                for (int i = 0; i < clickLen && (s0 + i) < n; ++i)
                {
                    const float env = 1.0f - (float) i / (float) clickLen;
                    buf.setSample (0, (int) (s0 + i), env * std::sin ((float) i * 0.9f));
                }
            }
            auto dir = eng.sessionDir().getChildFile ("stretch-test");
            dir.createDirectory();
            auto f = dir.getChildFile (name);
            f.deleteFile();
            juce::WavAudioFormat fmt;
            if (auto os = std::unique_ptr<juce::FileOutputStream> (f.createOutputStream()))
            {
                std::unique_ptr<juce::AudioFormatWriter> w (
                    fmt.createWriterFor (os.get(), sr, 1u, 16, {}, 0));
                if (w != nullptr) { os.release(); w->writeFromAudioSampleBuffer (buf, 0, (int) n); }
            }
            return f;
        };
        auto clickFile = makeClickWav (120.0, 4.0, "click120.wav");
        check (clickFile.existsAsFile(), "detect: synthesized a 120bpm click WAV");
        auto imp = cmd (ops, "import_clip", objN ({{ "trackId", st }, { "file", clickFile.getFullPathName() }}));
        check (ok (imp), "detect: import click track ok");
        const auto clickId = imp["data"].getProperty ("clipId", var()).toString();
        auto det = cmd (ops, "detect_clip_bpm", args1 ("clipId", clickId));
        check (ok (det), "detect: 120bpm click detected ok");
        const double dbpm = (double) det["data"].getProperty ("bpm", 0.0);
        check (std::abs (dbpm - 120.0) < 3.0, "detect: reported BPM ~120");
        check ((double) det["data"].getProperty ("confidence", 0.0) > 0.2, "detect: strong pulse -> good confidence");

        // Enabling warp with detect:true on the click locks sourceBpm to the detected
        // tempo (~120); the DEFAULT path (no detect) stays a 1:1 no-op (proven above).
        auto wd = cmd (ops, "set_clip_warp", objN ({{ "clipId", clickId }, { "autoTempo", true }, { "detect", true }}));
        check (ok (wd), "detect: set_clip_warp detect:true ok");
        {
            auto tv = trackById (st);
            auto cv = tv.getProperty ("clips", var());
            double srcBpm = 0.0;
            if (auto* arr = cv.getArray())
                for (auto& c : *arr)
                    if (c.getProperty ("id", var()).toString() == clickId)
                        srcBpm = (double) c.getProperty ("sourceBpm", 0.0);
            check (std::abs (srcBpm - 120.0) < 3.0, "detect: warp detect locked sourceBpm to ~120");
        }
        check (! ok (cmd (ops, "detect_clip_bpm", args1 ("clipId", "no-such"))), "detect: bad clipId rejected");

        cmd (ops, "remove_track", args1 ("trackId", st));   // tidy
    }

    section ("Moshi brain proxy + native voice (packaged-app pieces)");
    {
        // Deterministic provider resolution — set known env, no network calls.
        mosh::setEnvVar ("MOSH_IGNORE_BUNDLED_BRAIN_CONFIG", "1");
        mosh::setEnvVar ("DEEPSEEK_BASE_URL", "https://api.deepseek.test");
        mosh::setEnvVar ("DEEPSEEK_MODEL", "deepseek-test");
        mosh::setEnvVar ("DEEPSEEK_API_KEY", "sk-test-deepseek");
        mosh::setEnvVar ("XAI_BASE_URL", "https://api.x.test");
        mosh::setEnvVar ("XAI_MODEL", "grok-test");
        mosh::setEnvVar ("XAI_API_KEY", "sk-test-xai");
        mosh::unsetEnvVar ("OPENAI_API_KEY");          // leave openai incomplete
        mosh::setEnvVar ("MOSHI_BRAIN_PROVIDER", "xai");

        auto info  = BrainProxy::providersInfo();
        auto provs = info.getProperty ("providers", var());
        check (provs.isArray() && provs.getArray()->size() == 3,
               "brain: three providers enumerated (deepseek/openai/xai)");

        auto chosen = BrainProxy::resolve();    // honours MOSHI_BRAIN_PROVIDER=xai
        check (chosen.id == "xai", "brain: MOSHI_BRAIN_PROVIDER selects the default provider");
        check (chosen.url == "https://api.x.test" && chosen.model == "grok-test",
               "brain: resolved provider carries its env url/model");

        check (BrainProxy::resolve ("deepseek").id == "deepseek",
               "brain: an explicit complete provider is honoured over the default");

        auto fallback = BrainProxy::resolve ("openai");   // incomplete → fall back
        check (fallback.id != "openai" && fallback.isComplete(),
               "brain: an incomplete requested provider falls back to a configured one");

        auto badShape = BrainProxy::chat (var(), "deepseek");   // not an array → no HTTP
        check (! (bool) badShape.getProperty ("ok", true)
                   && badShape.getProperty ("error", var()).toString().isNotEmpty(),
               "brain: chat() rejects a non-array messages payload with an error shape");

        // Clear every key → no provider resolves and chat() errors cleanly (no network).
        mosh::unsetEnvVar ("DEEPSEEK_API_KEY"); mosh::unsetEnvVar ("XAI_API_KEY"); mosh::unsetEnvVar ("MOSHI_BRAIN_PROVIDER");
        check (! BrainProxy::resolve().isComplete(), "brain: nothing resolves when no key is set");
        auto noProv = BrainProxy::chat (var (Array<var>{}), juce::String());
        check (! (bool) noProv.getProperty ("ok", true),
               "brain: chat() with no provider returns { ok:false } (no crash, no network)");
        mosh::unsetEnvVar ("MOSH_IGNORE_BUNDLED_BRAIN_CONFIG");

        // Native speech: probe availability + lifecycle without requesting permission.
       #if JUCE_MAC
        check (NativeSpeech::isSupported(), "voice: macOS Speech available (SFSpeechRecognizer present)");
       #endif
        NativeSpeech sp;
        check (! sp.isListening(), "voice: a fresh NativeSpeech is idle");
        sp.stop();   // stop-while-idle must be a safe no-op
        check (! sp.isListening(), "voice: stop() while idle is a safe no-op");
    }

    section ("Multiplayer: stable logical track IDs (MP-001)");
    {
        // The load-bearing multiplayer prerequisite: every track carries a stable
        // cross-peer UUID (moshLogicalId) that is distinct, non-empty, and survives
        // a save/reload — Tracktion's own EditItemID is allocator-dependent and so
        // differs per peer, which is why we cannot address tracks across peers by it.
        const int before = tracks (ops);
        check (ok (cmd (ops, "create_track", args1 ("name", "MP One"))), "create_track MP One ok");
        check (ok (cmd (ops, "create_track", args1 ("name", "MP Two"))), "create_track MP Two ok");

        auto idByName = [] (MoshOps& o, const juce::String& name) -> juce::String
        {
            auto snap = o.snapshot();   // keep the temporary alive (no dangling array)
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("name", juce::var()).toString() == name)
                        return tv.getProperty ("logicalId", juce::var()).toString();
            return {};
        };

        check (tracks (ops) >= before + 2, "two MP tracks present in snapshot");
        const auto id1 = idByName (ops, "MP One");
        const auto id2 = idByName (ops, "MP Two");
        check (id1.isNotEmpty(), "track 'MP One' has a non-empty logicalId");
        check (id2.isNotEmpty(), "track 'MP Two' has a non-empty logicalId");
        check (id1 != id2, "the two tracks have distinct logicalIds");
        check (id1.length() >= 32, "logicalId looks like a juce::Uuid string");

        // Identity is stable across a session reload (persisted on the track tree).
        check (ok (cmd (ops, "save")),   "save ok (MP-001)");
        check (ok (cmd (ops, "reload")), "reload ok (MP-001)");
        check (idByName (ops, "MP One") == id1 && id1.isNotEmpty(), "logicalId of 'MP One' survives save/reload");
        check (idByName (ops, "MP Two") == id2 && id2.isNotEmpty(), "logicalId of 'MP Two' survives save/reload");
    }

    section ("Multiplayer: track serialize/apply round-trip (P1b)");
    {
        // The core commit/apply mechanism, proven entirely in-process (no network):
        // serialize a track -> mutate it -> apply the blob -> the track is restored
        // byte-faithfully, WITHOUT touching the undo stack and WITHOUT emitting (so
        // a remote apply never echoes back to the relay).

        // Resolve the engine itemID of a track by display name (for command args).
        auto trackIdByName = [] (MoshOps& o, const juce::String& name) -> juce::String
        {
            auto snap = o.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("name", juce::var()).toString() == name)
                        return tv.getProperty ("id", juce::var()).toString();
            return {};
        };
        // Fetch a whole track var by its stable logicalId (to read restored fields).
        auto trackByLogicalId = [] (MoshOps& o, const juce::String& lid) -> juce::var
        {
            auto snap = o.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("logicalId", juce::var()).toString() == lid)
                        return tv;
            return {};
        };

        check (ok (cmd (ops, "create_track", args1 ("name", "RT Src"))), "create RT Src");
        const auto srcId = trackIdByName (ops, "RT Src");
        check (srcId.isNotEmpty(), "RT Src engine id resolved");

        // Give it real content: a wave clip, a MIDI clip with a note, a set volume.
        cmd (ops, "add_test_tone_clip", objN ({ { "trackId", srcId }, { "seconds", 1.0 } }));
        cmd (ops, "set_track_volume",   objN ({ { "trackId", srcId }, { "db", -6.5 } }));
        auto midiRes = cmd (ops, "add_midi_clip", objN ({ { "trackId", srcId } }));
        const auto midiClipId = midiRes.getProperty ("data", juce::var()).getProperty ("clipId", juce::var()).toString();
        check (midiClipId.isNotEmpty(), "RT Src midi clip created");
        cmd (ops, "add_note", objN ({ { "clipId", midiClipId }, { "pitch", 60 },
                                      { "beat", 0.0 }, { "length", 1.0 }, { "velocity", 100 } }));

        // Capture the original shape (clip count) before we serialize.
        auto clipCountOf = [] (const juce::var& tv) -> int
        {
            if (auto* a = tv["clips"].getArray()) return a->size();
            return 0;
        };
        // Resolve the source track's stable logicalId (for restored-state lookups).
        juce::String srcLid;
        {
            auto snap = ops.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("name", juce::var()).toString() == "RT Src")
                        srcLid = tv.getProperty ("logicalId", juce::var()).toString();
        }
        const int origClipCount = clipCountOf (trackByLogicalId (ops, srcLid));
        check (origClipCount == 2, "RT Src has 2 clips (wave + midi) before serialize");
        const double srcVol = (double) trackByLogicalId (ops, srcLid).getProperty ("volumeDb", -99.0);
        check (std::abs (srcVol - (-6.5)) < 0.05, "RT Src volume is -6.5 pre-serialize (got " + juce::String (srcVol, 3) + ")");

        // 1) SERIALIZE
        auto serRes = cmd (ops, "mp_serialize_track", args1 ("trackId", srcId));
        check (ok (serRes), "mp_serialize_track ok");
        const auto blob = serRes.getProperty ("data", juce::var()).getProperty ("blob", juce::var()).toString();
        const auto lid  = serRes.getProperty ("data", juce::var()).getProperty ("logicalId", juce::var()).toString();
        check (blob.isNotEmpty(), "serialize produced a non-empty blob");
        check (lid == srcLid && lid.isNotEmpty(), "serialize reported the track's logicalId");

        // 2) MUTATE the live track away from the serialized state.
        cmd (ops, "rename_track",     objN ({ { "trackId", srcId }, { "name", "MUTATED" } }));
        cmd (ops, "set_track_volume", objN ({ { "trackId", srcId }, { "db", 0.0 } }));
        {   // remove every clip on RT Src
            auto snap = ops.snapshot();
            juce::StringArray clipIds;
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("id", juce::var()).toString() == srcId)
                        if (auto* cs = tv["clips"].getArray())
                            for (auto& cv : *cs)
                                clipIds.add (cv.getProperty ("id", juce::var()).toString());
            for (auto& cid : clipIds)
                cmd (ops, "remove_clip", args1 ("clipId", cid));
        }
        check (clipCountOf (trackByLogicalId (ops, lid)) == 0, "mutate removed all clips");

        // A sentinel: a freshly-created track is the TOP of the undo stack (create_
        // track is proven undoable). If apply does NOT push an undoable action, a
        // single undo after apply reverts THIS create, not the apply.
        cmd (ops, "create_track", args1 ("name", "RT Sentinel"));
        auto sentinelExists = [] (MoshOps& o) -> bool
        {
            auto snap = o.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("name", juce::var()).toString() == "RT Sentinel")
                        return true;
            return false;
        };
        check (sentinelExists (ops), "sentinel track present before apply");

        // 3) APPLY — zero-emit guard: clear captured events, apply, assert silence.
        eventTypes.clear();
        auto appRes = cmd (ops, "apply_remote_track", args1 ("blob", blob));
        check (ok (appRes), "apply_remote_track ok");
        check (appRes.getProperty ("data", juce::var()).getProperty ("mode", juce::var()).toString() == "replaced",
               "apply replaced the existing track (same logicalId)");
        juce::String evDump; for (auto& e : eventTypes) evDump << e << ",";
        bool emittedInvalidate = false;
        for (auto& e : eventTypes) if (e == "snapshot_invalidated") emittedInvalidate = true;
        check (! emittedInvalidate,
               "apply_remote_track does NOT emit snapshot_invalidated (no relay echo) [saw: " + evDump + "]");

        // 4) FIDELITY — the track is restored by logicalId.
        auto restored = trackByLogicalId (ops, lid);
        check (restored.isObject(), "restored track found by logicalId");
        check (restored.getProperty ("name", juce::var()).toString() == "RT Src", "name restored");
        const double rv = (double) restored.getProperty ("volumeDb", -99.0);
        check (std::abs (rv - (-6.5)) < 0.05, "volume restored (got " + juce::String (rv, 3) + ")");
        check (clipCountOf (restored) == origClipCount, "clip count restored (wave + midi)");
        int restoredMidiNotes = 0;
        if (auto* cs = restored["clips"].getArray())
            for (auto& cv : *cs)
                if (cv.getProperty ("type", juce::var()).toString() == "midi")
                    if (auto* notes = cv["notes"].getArray())
                        restoredMidiNotes = notes->size();
        check (restoredMidiNotes >= 1, "deep content survived: the MIDI note round-tripped");

        // 5) UNDO GUARD — apply was not undoable, so undo reverts the CONTROL track
        // (top of the stack), not the applied track; the applied track survives.
        check (ok (cmd (ops, "undo")), "undo ok");
        check (! sentinelExists (ops),
               "undo removed the sentinel track (apply was NOT on the undo stack)");
        check (trackByLogicalId (ops, lid).getProperty ("name", juce::var()).toString() == "RT Src",
               "applied track survives the undo (apply is outside the undo system)");
    }

    section ("Multiplayer: lock guard at the mutation path (MP-001 P3)");
    {
        // The guard sits at the single chokepoint MoshOps::execute(). When a session
        // is active, mutations to a track/clip/structure held by the OTHER peer are
        // rejected; reads always pass; deactivating restores single-player edits.
        cmd (ops, "create_track", args1 ("name", "Lock A"));
        cmd (ops, "create_track", args1 ("name", "Lock B"));
        juce::String aId, aLid, bId;
        {
            auto snap = ops.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                {
                    const auto nm = tv.getProperty ("name", juce::var()).toString();
                    if (nm == "Lock A") { aId = tv.getProperty ("id", juce::var()).toString();
                                          aLid = tv.getProperty ("logicalId", juce::var()).toString(); }
                    if (nm == "Lock B") { bId = tv.getProperty ("id", juce::var()).toString(); }
                }
        }
        check (aLid.isNotEmpty() && bId.isNotEmpty(), "lock-test tracks resolved (logicalId + engine ids)");

        // A clip on Lock A, added BEFORE locking, to exercise clip-scoped guarding.
        auto addc = cmd (ops, "add_test_tone_clip", objN ({ { "trackId", aId }, { "seconds", 1.0 } }));
        const auto aClipId = addc.getProperty ("data", juce::var()).getProperty ("clipId", juce::var()).toString();

        // Activate: the OTHER peer holds Lock A AND the session (structural) lock.
        auto* locks = new juce::DynamicObject();
        locks->setProperty (aLid, "other");
        locks->setProperty (LockManager::sessionKey(), "other");
        check (ok (cmd (ops, "mp_sync_locks",
                        objN ({ { "active", true }, { "selfPeer", "me" }, { "locks", juce::var (locks) } }))),
               "mp_sync_locks activates the guard with peer-held locks");

        check (! ok (cmd (ops, "rename_track", objN ({ { "trackId", aId }, { "name", "HAX" } }))),
               "track mutation on a peer-locked track is BLOCKED");
        check (ok (cmd (ops, "list_plugins")), "reads pass the guard");
        check (ok (cmd (ops, "get_clip_peaks", args1 ("clipId", aClipId))),
               "a clip read on a peer-locked track is allowed");
        check (ok (cmd (ops, "rename_track", objN ({ { "trackId", bId }, { "name", "Lock B2" } }))),
               "track mutation on a FREE track is allowed");
        if (aClipId.isNotEmpty())
            check (! ok (cmd (ops, "set_clip_gain", objN ({ { "clipId", aClipId }, { "gain", 0.5 } }))),
                   "clip mutation on a peer-locked track's clip is BLOCKED (clip->track->logicalId)");
        check (! ok (cmd (ops, "create_track", args1 ("name", "Nope"))),
               "session-global op BLOCKED while the session lock is peer-held");

        check (ok (cmd (ops, "mp_sync_locks", objN ({ { "active", false } }))), "mp_sync_locks deactivates");
        check (ok (cmd (ops, "rename_track", objN ({ { "trackId", aId }, { "name", "Free Again" } }))),
               "deactivating restores unguarded single-player track edits");
        check (ok (cmd (ops, "create_track", args1 ("name", "Free Track"))),
               "structural ops unblocked after deactivate (single-player regression safety)");
    }

    section ("Multiplayer: project bootstrap (P6)");
    {
        // A late-joiner adopts the host's whole project. Proven in-process: build a
        // known project -> serialize the bundle -> wipe -> apply -> it comes back
        // with the same logicalIds + content (the join handshake rides this).
        auto lidByName = [] (MoshOps& o, const juce::String& nm) -> juce::String
        {
            auto snap = o.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("name", juce::var()).toString() == nm)
                        return tv.getProperty ("logicalId", juce::var()).toString();
            return {};
        };

        check (ok (cmd (ops, "new_project", args1 ("name", "mp-boot-src"))), "new_project (bootstrap source) ok");
        check (tracks (ops) == 0, "fresh project is empty");
        cmd (ops, "create_track", args1 ("name", "Boot A"));
        cmd (ops, "create_track", args1 ("name", "Boot B"));
        juce::String aId;
        {
            auto snap = ops.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("name", juce::var()).toString() == "Boot A")
                        aId = tv.getProperty ("id", juce::var()).toString();
        }
        cmd (ops, "add_test_tone_clip", objN ({ { "trackId", aId }, { "seconds", 1.0 } }));
        const auto lidA = lidByName (ops, "Boot A");
        const auto lidB = lidByName (ops, "Boot B");
        // A pre-existing annotation on the host must travel in the bootstrap bundle (it's a
        // top-level Edit child, not inside a track blob) so a late-joiner sees it too.
        cmd (ops, "create_annotation", objN ({ { "annotationId", "boot-ann" }, { "text", "host note" }, { "beat", 12.0 }, { "author", "host" } }));

        auto ser = cmd (ops, "mp_serialize_project");
        check (ok (ser), "mp_serialize_project ok");
        auto bundle = ser.getProperty ("data", juce::var());
        check ((int) bundle.getProperty ("count", 0) == 2, "serialized a 2-track project bundle");
        check (bundle.getProperty ("annotations", juce::var()).toString().isNotEmpty(), "bundle carries the annotations subtree");

        // REGRESSION (bootstrap audio late-join): the bundle must carry per-track by-hash
        // audioRefs so a late-joiner can fetch PRE-EXISTING audio, not just structure/MIDI.
        // Before the fix mp_serialize_project never content-addressed/uploaded → the bundle
        // had no refs and the joiner's clip stayed sourceMissing until a host re-commit.
        juce::var bootAudioRefs;
        if (auto* tarr = bundle.getProperty ("tracks", juce::var()).getArray())
            for (auto& tv : *tarr)
                if (auto rr = tv.getProperty ("audioRefs", juce::var()); rr.isArray() && rr.size() > 0)
                    bootAudioRefs = rr;
        check (bootAudioRefs.isArray() && bootAudioRefs.size() >= 1, "bootstrap bundle carries per-track audioRefs (audio late-join)");
        check (bootAudioRefs.size() > 0 && bootAudioRefs[0].getProperty ("hash", juce::var()).toString().length() == 64,
               "bootstrap audioRef hash is a sha256");
        {
            // The host's Boot A clip was content-addressed + repointed to a by-hash stem at
            // serialize time (the by-hash form, no spurious "../" — inherits the PR #104 helper).
            juce::String hostRef;
            for (auto* tr : te::getAllTracks (eng.edit()))
                if (auto* at = dynamic_cast<te::AudioTrack*> (tr))
                    for (auto* c : at->getClips())
                        if (auto* w = dynamic_cast<te::WaveAudioClip*> (c))
                            hostRef = w->state.getProperty (juce::Identifier ("source")).toString();
            check (hostRef.contains ("by-hash"), "serialize content-addressed the host audio clip to a by-hash stem");
            check (! hostRef.startsWith ("../") && ! hostRef.contains ("/../"),
                   "bootstrap by-hash ref has no spurious '../' (" + hostRef + ")");
        }

        check (ok (cmd (ops, "new_project", args1 ("name", "mp-boot-dst"))), "new_project (joiner wipe) ok");
        check (tracks (ops) == 0, "joiner starts empty before bootstrap");

        auto app = cmd (ops, "mp_apply_bootstrap", objN ({ { "tracks", bundle.getProperty ("tracks", juce::var()) },
                                                           { "annotations", bundle.getProperty ("annotations", juce::var()) } }));
        check (ok (app), "mp_apply_bootstrap ok");
        // The joiner adopts the host's annotation (id + author + text preserved).
        bool joinerHasAnn = false;
        { auto arr = ops.snapshot().getProperty ("annotations", juce::var());
          for (int i = 0; i < arr.size(); ++i)
              if (arr[i].getProperty ("id", juce::var()).toString() == "boot-ann"
                  && arr[i].getProperty ("text", juce::var()).toString() == "host note"
                  && arr[i].getProperty ("author", juce::var()).toString() == "host")
                  joinerHasAnn = true; }
        check (joinerHasAnn, "joiner adopts the host's pre-existing annotation via bootstrap");
        check ((int) app.getProperty ("data", juce::var()).getProperty ("applied", 0) == 2, "bootstrap applied 2 tracks");
        check (tracks (ops) == 2, "joiner now holds the host's 2 tracks");
        check (lidByName (ops, "Boot A") == lidA && lidA.isNotEmpty(), "Boot A logicalId preserved across bootstrap");
        check (lidByName (ops, "Boot B") == lidB && lidB.isNotEmpty(), "Boot B logicalId preserved across bootstrap");
        int aClips = 0;
        {
            auto snap = ops.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("name", juce::var()).toString() == "Boot A")
                        if (auto* cs = tv["clips"].getArray()) aClips = cs->size();
        }
        check (aClips == 1, "Boot A's clip survived the bootstrap (deep content)");
        {
            // The repointed by-hash ref rode the bundle onto the joiner (proves the wire
            // round-trip of the audio ref). The bytes themselves ride the cloud relay's blob
            // store via the download loop that mirrors the proven commit-apply path; the
            // cloud-relay selftest branch exercises that fetch end-to-end.
            juce::String joinRef;
            for (auto* tr : te::getAllTracks (eng.edit()))
                if (auto* at = dynamic_cast<te::AudioTrack*> (tr))
                    for (auto* c : at->getClips())
                        if (auto* w = dynamic_cast<te::WaveAudioClip*> (c))
                            joinRef = w->state.getProperty (juce::Identifier ("source")).toString();
            check (joinRef.contains ("by-hash"), "joiner's bootstrapped clip references the by-hash stem");
        }
    }

    section ("Multiplayer: structural sync (scalar session-global ops)");
    {
        auto tempoNow = [] (MoshOps& o) { return (double) o.snapshot()["session"].getProperty ("tempo", 0.0); };
        cmd (ops, "set_tempo", objN ({ { "bpm", 120.0 } }));
        check (std::abs (tempoNow (ops) - 120.0) < 0.01, "baseline tempo is 120");

        // The peer holds the SESSION (structural) lock.
        auto* locks = new juce::DynamicObject();
        locks->setProperty (LockManager::sessionKey(), "other");
        check (ok (cmd (ops, "mp_sync_locks",
                        objN ({ { "active", true }, { "selfPeer", "me" }, { "locks", juce::var (locks) } }))),
               "session active, peer holds the session lock");

        // A LOCAL structural change is blocked by the guard.
        check (! ok (cmd (ops, "set_tempo", objN ({ { "bpm", 140.0 } }))),
               "local tempo change blocked while the peer holds the session lock");
        check (std::abs (tempoNow (ops) - 120.0) < 0.01, "tempo unchanged after the blocked local change");

        // Applying the PEER's structural op bypasses the guard and lands (echo-free).
        check (ok (cmd (ops, "mp_apply_structural",
                        objN ({ { "command", "set_tempo" }, { "args", objN ({ { "bpm", 145.0 } }) } }))),
               "mp_apply_structural ok");
        check (std::abs (tempoNow (ops) - 145.0) < 0.01, "peer's tempo change applied (guard bypassed)");

        check (ok (cmd (ops, "mp_sync_locks", objN ({ { "active", false } }))), "session deactivated");
    }

    // Regression: export after mp_commit_track. The commit content-addresses a wave clip's
    // audio to <session>/audio/by-hash/<sha>.wav and rewrites the clip to a RELATIVE ref.
    // The ref was previously computed relative to the edit FILE (setToDirectFileReference),
    // which produced a spurious leading "../" — but the filePathResolver resolves relative
    // to the edit file's PARENT dir, so the "../" escaped the session dir to a non-existent
    // path. The offline-render WaveNode could then never open the stem, so isReadyToProcess()
    // stayed false and export_audio spun FOREVER. Guards: the ref has no "../", resolves to an
    // existing file, export COMPLETES (the render loop is also bounded now), and renders
    // NON-SILENT audio. (mpSession_ exists unconditionally, so this needs no relay.)
    //
    // The "../" is only emitted when the edit file is NOT on disk at rewrite time: JUCE's
    // getRelativePathFrom strips to the base's parent only when the base existsAsFile(), else
    // it treats the edit file's own path as a directory and prepends "../". new_project
    // persists the edit, so we remove it here to model the unsaved state (a fresh arrangement
    // before its first save) deterministically — WITHOUT this the rewrite resolves fine and
    // the section passes even on the buggy code, i.e. it would not actually guard the fix.
    {
        section ("Multiplayer: export after commit (by-hash ref resolves — guards the export hang)");

        check (ok (cmd (ops, "new_project", args1 ("name", "mp-export-selftest"))), "new_project (mp export isolation) ok");

        auto mkt = cmd (ops, "create_track", objN ({ { "name", "Stem" } }));
        check (ok (mkt), "create_track (audio) ok");
        const auto st = mkt["data"].getProperty ("trackId", var()).toString();
        check (ok (cmd (ops, "add_test_tone_clip", objN ({ { "trackId", st }, { "seconds", 1.0 } }))),
               "add_test_tone_clip ok");

        // Force the bug's precondition: an edit not yet on disk at the rewrite (see above).
        const auto mpEditFile = eng.editFile();
        mpEditFile.deleteFile();
        check (! mpEditFile.existsAsFile(), "edit file is absent at commit time (the bug's precondition)");

        check (ok (cmd (ops, "mp_commit_track", args1 ("trackId", st))), "mp_commit_track (audio) ok");

        juce::String storedRef;
        bool resolvedExists = false;
        for (auto* tr : te::getAllTracks (eng.edit()))
            if (auto* at = dynamic_cast<te::AudioTrack*> (tr))
                for (auto* c : at->getClips())
                    if (auto* w = dynamic_cast<te::WaveAudioClip*> (c))
                    {
                        storedRef      = w->state.getProperty (juce::Identifier ("source")).toString();
                        resolvedExists = w->getCurrentSourceFile().existsAsFile();
                    }
        check (storedRef.contains ("by-hash"), "committed clip points at the by-hash stem");
        check (! storedRef.startsWith ("../") && ! storedRef.contains ("/../"),
               "by-hash ref has no spurious '../' so it resolves inside the session (" + storedRef + ")");
        check (resolvedExists, "committed clip's resolved source exists on disk");

        auto wavMag = [] (const File& f) -> float
        {
            AudioFormatManager fm; fm.registerBasicFormats();
            if (std::unique_ptr<AudioFormatReader> reader { fm.createReaderFor (f) })
            {
                const int toRead = (int) jmin ((int64) 4'000'000, reader->lengthInSamples);
                if (toRead > 0)
                {
                    AudioBuffer<float> buf ((int) reader->numChannels, toRead);
                    reader->read (&buf, 0, toRead, 0, true, true);
                    float mag = 0.0f;
                    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
                        mag = jmax (mag, buf.getMagnitude (ch, 0, toRead));
                    return mag;
                }
            }
            return -1.0f;
        };

        auto outFile = eng.sessionDir().getChildFile ("exports").getChildFile ("mp-commit-export.wav");
        outFile.deleteFile();
        check (ok (cmd (ops, "export_audio", objN ({ { "file", outFile.getFullPathName() },
                                                     { "format", "wav" }, { "bitDepth", 16 } }))),
               "export_audio after mp_commit_track COMPLETES (no hang)");
        check (wavMag (outFile) > 0.02f,
               "exported MP-committed audio is NON-SILENT (the stem actually rendered)");
        outFile.deleteFile();

        // Restore the on-disk edit we removed above so later sections see a persisted edit.
        check (ok (cmd (ops, "save")), "re-persist the edit after the mp-commit-export probe");
    }

    // Regression: export after relink_clip to a project-LOCAL copy. relink_clip rewrites a
    // wave clip's source via setToDirectFileReference(newFile, /*useRelativePath*/ local).
    // When the new file lives under the project dir (local==true), that computes the path
    // relative to the edit FILE — and if the edit file isn't on disk, JUCE treats the edit
    // file's own path as a directory, yielding a spurious leading "../" (e.g. "../audio/
    // foo.wav"). Mosh's filePathResolver (MoshEngine::wireEditResolvers) resolves relative
    // to the edit file's PARENT dir, so that "../" escapes the session dir to a path that
    // doesn't exist → the offline-render WaveNode can never open the source → export_audio
    // spins forever. This is the exact mechanism PR #104 fixed for mp_commit_track. Guards:
    // the relinked ref has no "../", resolves to an existing file, export COMPLETES (the
    // render loop is bounded too), and renders NON-SILENT.
    {
        section ("Relink: export after relink to a local copy (guards the export hang)");

        check (ok (cmd (ops, "new_project", args1 ("name", "relink-export-selftest"))),
               "new_project (relink export isolation) ok");

        auto mkt = cmd (ops, "create_track", objN ({ { "name", "Aud" } }));
        check (ok (mkt), "create_track (audio) ok");
        const auto tid = mkt["data"].getProperty ("trackId", var()).toString();

        // A clip whose source lives OUTSIDE the project dir (the shared session pool), so
        // relinking to a project-local copy exercises the relative-ref rewrite.
        check (ok (cmd (ops, "add_test_tone_clip", objN ({ { "trackId", tid }, { "seconds", 1.0 }, { "freq", 440 } }))),
               "add_test_tone_clip ok");

        auto firstClipOnTrack = [&] () -> var
        {
            auto trks = ops.snapshot().getProperty ("tracks", var());
            for (int i = 0; i < trks.size(); ++i)
                if (trks[i].getProperty ("id", var()).toString() == tid)
                    return trks[i].getProperty ("clips", var())[0];
            return var();
        };
        const auto clipId = firstClipOnTrack().getProperty ("id", var()).toString();
        check (clipId.isNotEmpty(), "probe clip present");

        const File origSrc (firstClipOnTrack().getProperty ("sourceFile", var()).toString());
        const auto projectDir = eng.editFile().getParentDirectory();
        check (! origSrc.isAChildOf (projectDir), "probe clip's source starts OUTSIDE the project dir");

        // Copy the source to a project-LOCAL path and relink to it (local => relative ref).
        auto localCopy = projectDir.getChildFile ("audio").getChildFile ("relinked.wav");
        localCopy.getParentDirectory().createDirectory();
        localCopy.deleteFile();
        check (origSrc.copyFileTo (localCopy), "copied source to a project-local file");
        check (localCopy.isAChildOf (projectDir), "relink target is under the project dir (=> relative ref)");

        // Force the precondition that actually triggers the bug: an edit not yet on disk.
        // setToDirectFileReference(file, /*relative*/ true) -> findPathFromFile ->
        // file.getRelativePathFrom(editFileRetriever()), and JUCE's getRelativePathFrom uses
        // the base's PARENT only when the base existsAsFile() — otherwise it treats the edit
        // file's own path as a directory and emits the spurious leading "../". A real user
        // hits this when relinking on a fresh arrangement before its first save (the
        // cold-start session edit). new_project persists the edit, so we remove it here to
        // model the unsaved state deterministically. (Without this the relative ref resolves
        // fine and the bug stays hidden — which is exactly why it lay latent.)
        const auto editFile = eng.editFile();
        editFile.deleteFile();
        check (! editFile.existsAsFile(), "edit file is absent at relink time (the bug's precondition)");

        check (ok (cmd (ops, "relink_clip", objN ({ { "clipId", clipId }, { "file", localCopy.getFullPathName() } }))),
               "relink_clip to the local copy ok");

        juce::String storedRef;
        bool resolvedExists = false;
        for (auto* tr : te::getAllTracks (eng.edit()))
            if (auto* at = dynamic_cast<te::AudioTrack*> (tr))
                for (auto* c : at->getClips())
                    if (auto* w = dynamic_cast<te::WaveAudioClip*> (c))
                    {
                        storedRef      = w->state.getProperty (juce::Identifier ("source")).toString();
                        resolvedExists = w->getCurrentSourceFile().existsAsFile();
                    }
        check (! storedRef.startsWith ("../") && ! storedRef.contains ("/../"),
               "relinked ref has no spurious '../' so it resolves inside the session (" + storedRef + ")");
        check (resolvedExists, "relinked clip's resolved source exists on disk");

        auto wavMag = [] (const File& f) -> float
        {
            AudioFormatManager fm; fm.registerBasicFormats();
            if (std::unique_ptr<AudioFormatReader> reader { fm.createReaderFor (f) })
            {
                const int toRead = (int) jmin ((int64) 4'000'000, reader->lengthInSamples);
                if (toRead > 0)
                {
                    AudioBuffer<float> buf ((int) reader->numChannels, toRead);
                    reader->read (&buf, 0, toRead, 0, true, true);
                    float mag = 0.0f;
                    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
                        mag = jmax (mag, buf.getMagnitude (ch, 0, toRead));
                    return mag;
                }
            }
            return -1.0f;
        };

        auto outFile = eng.sessionDir().getChildFile ("exports").getChildFile ("relink-export.wav");
        outFile.deleteFile();
        check (ok (cmd (ops, "export_audio", objN ({ { "file", outFile.getFullPathName() },
                                                     { "format", "wav" }, { "bitDepth", 16 } }))),
               "export_audio after relink_clip COMPLETES (no hang)");
        check (wavMag (outFile) > 0.02f,
               "exported relinked audio is NON-SILENT (the relinked source actually rendered)");
        outFile.deleteFile();

        // Restore the on-disk edit we removed above so later sections see a persisted edit.
        check (ok (cmd (ops, "save")), "re-persist the edit after the relink-export probe");
    }

    // P2 — native↔relay transport, end to end over real HTTP. Gated (spawns a
    // relay + needs MOSH_RELAY_URL) so it stays OUT of the deterministic core run.
    if (std::getenv ("MOSH_SELFTEST_MP") != nullptr)
    {
        section ("Multiplayer: native relay round-trip (P2, gated MOSH_SELFTEST_MP)");

        MultiplayerClient a, b;   // both resolve the relay from MOSH_RELAY_URL
        const auto code = a.createSession ("Ada", "#ff0000");
        check (code.isNotEmpty(), "peer A created a session (got a room code) [" + a.lastError() + "]");
        check (code.length() >= 16, "room code is a high-entropy bearer");
        check (b.joinSession (code, "Bo", "#0000ff"), "peer B joined by code [" + b.lastError() + "]");

        // A serializes a real track and publishes the commit over the wire.
        check (ok (cmd (ops, "create_track", args1 ("name", "Net Src"))), "create Net Src");
        juce::String netId;
        {
            auto snap = ops.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("name", juce::var()).toString() == "Net Src")
                        netId = tv.getProperty ("id", juce::var()).toString();
        }
        cmd (ops, "add_test_tone_clip", objN ({ { "trackId", netId }, { "seconds", 1.0 } }));
        auto ser = cmd (ops, "mp_serialize_track", args1 ("trackId", netId));
        const auto blob = ser.getProperty ("data", juce::var()).getProperty ("blob", juce::var()).toString();
        const auto lid  = ser.getProperty ("data", juce::var()).getProperty ("logicalId", juce::var()).toString();
        check (blob.isNotEmpty(), "serialized Net Src to a commit blob");

        auto* commit = new juce::DynamicObject();
        commit->setProperty ("type", "commit");
        commit->setProperty ("logicalId", lid);
        commit->setProperty ("blob", blob);
        const int seq = a.publish (juce::var (commit));
        // seq is monotonic but its absolute value is backend-specific (a fresh local
        // relay starts at 1; the cloud relay's seq is a global serial), so assert >=1.
        check (seq >= 1, "peer A published the commit (seq " + juce::String (seq) + ") [" + a.lastError() + "]");

        // B receives exactly that commit; A does not get its own back (no echo).
        auto frames = b.poll();
        check (frames.size() == 1, "peer B received exactly one frame [" + b.lastError() + "]");
        juce::String gotBlob, gotLid;
        if (frames.size() > 0)
        {
            gotBlob = frames[0].getProperty ("msg", juce::var()).getProperty ("blob", juce::var()).toString();
            gotLid  = frames[0].getProperty ("msg", juce::var()).getProperty ("logicalId", juce::var()).toString();
        }
        check (gotBlob == blob && gotBlob.isNotEmpty(), "commit blob survived the relay round-trip byte-for-byte");
        check (gotLid == lid, "commit logicalId survived the round-trip");
        check (a.poll().isEmpty(), "peer A does not receive its own commit (no echo)");

        // Apply the wire-delivered commit (after mutating) -> the track is restored.
        cmd (ops, "rename_track", objN ({ { "trackId", netId }, { "name", "NET-MUTATED" } }));
        check (ok (cmd (ops, "apply_remote_track", args1 ("blob", gotBlob))), "apply_remote_track (from wire) ok");
        juce::String restoredName;
        {
            auto snap = ops.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("logicalId", juce::var()).toString() == lid)
                        restoredName = tv.getProperty ("name", juce::var()).toString();
        }
        check (restoredName == "Net Src", "track restored from the relayed commit (end-to-end over HTTP)");

        // Exercise the NATIVE session command path (MultiplayerSession lifecycle:
        // create -> background poll thread starts -> leave -> thread joins).
        auto created = cmd (ops, "mp_create_session", objN ({ { "name", "Cy" }, { "color", "#00ff88" } }));
        check (ok (created), "mp_create_session (native session) ok");
        check (created.getProperty ("data", juce::var()).getProperty ("code", juce::var()).toString().isNotEmpty(),
               "native session returned a room code");
        check (ok (cmd (ops, "mp_leave_session")), "mp_leave_session ok (poll thread joined)");

        // P4 — audio stems. Content-addressing + the by-hash rewrite run on any
        // relay; the upload/peer-download round-trip now runs against WHATEVER
        // relay MOSH_RELAY_URL points at — cloud or local. (Previously gated to
        // the cloud relay only, because the local dev relay had no /mp/blob/*
        // storage; relay/server.py now mirrors that contract for local/CI use —
        // see the mp_fetch_missing_stems self-heal section below.)
        auto sess = cmd (ops, "mp_create_session", objN ({ { "name", "Hz" }, { "color", "#ffff00" } }));
        check (ok (sess), "mp_create_session (audio)");
        const auto sessCode = sess.getProperty ("data", juce::var()).getProperty ("code", juce::var()).toString();
        cmd (ops, "create_track", args1 ("name", "Stem Trk"));
        juce::String stemTrk;
        {
            auto snap = ops.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("name", juce::var()).toString() == "Stem Trk")
                        stemTrk = tv.getProperty ("id", juce::var()).toString();
        }
        cmd (ops, "add_test_tone_clip", objN ({ { "trackId", stemTrk }, { "seconds", 1.0 } }));

        auto commitRes = cmd (ops, "mp_commit_track", args1 ("trackId", stemTrk));
        check (ok (commitRes), "mp_commit_track ok (with audio)");
        // MOSH_MP_SYNC_TRANSFER (the PR-2 kill switch, gated separately below) pins this
        // to "committed" instead; that combination is exercised in its own dedicated
        // section, so this just accepts whichever mode is actually active here.
        const auto commitStatus = commitRes.getProperty ("data", juce::var()).getProperty ("status", juce::var()).toString();
        check (commitStatus == "uploading" || commitStatus == "committed",
               "PR-2: mp_commit_track returns a recognized status (\"" + commitStatus + "\")");
        auto refs = commitRes.getProperty ("data", juce::var()).getProperty ("audioRefs", juce::var());
        check (refs.isArray() && refs.size() >= 1, "commit content-addressed the clip's stem");
        const auto h0 = (refs.isArray() && refs.size() > 0) ? refs[0].getProperty ("hash", juce::var()).toString() : juce::String();
        const auto e0 = (refs.isArray() && refs.size() > 0) ? refs[0].getProperty ("ext", juce::var()).toString() : juce::String();
        check (h0.length() == 64, "stem hash is a sha256");
        const auto stemLogicalId = commitRes.getProperty ("data", juce::var()).getProperty ("logicalId", juce::var()).toString();

        // PR-2: the upload + publish now run on the transfer worker (mp_commit_track
        // returns status:"uploading" immediately) instead of inline — wait for the
        // additive mp_commit_done event before assuming the stem has actually landed
        // on the relay's blob store (a bounded drain, mirroring the async-outbox
        // check below; the shared event sink set at the top of this function
        // captures it into lastEvent).
        {
            auto* mmc = juce::MessageManager::getInstanceWithoutCreating();
            bool committed = false;
            const auto commitDeadline = juce::Time::getMillisecondCounter() + (juce::uint32) 20000;
            while (! committed && juce::Time::getMillisecondCounter() < commitDeadline)
            {
                if (mmc != nullptr) mmc->runDispatchLoopUntil (50);
                else juce::Thread::sleep (50);
                committed = lastEvent.getProperty ("type", juce::var()).toString() == "mp_commit_done"
                            && lastEvent.getProperty ("payload", juce::var()).getProperty ("logicalId", juce::var()).toString() == stemLogicalId;
            }
            check (committed, "mp_commit_track's async transfer completed (mp_commit_done observed)");
            check ((bool) lastEvent.getProperty ("payload", juce::var()).getProperty ("ok", false),
                   "mp_commit_done reports ok:true");
        }

        {
            MultiplayerClient peer;
            check (peer.joinSession (sessCode, "Peer", "#00ffff"), "peer joined the audio session");
            auto tmp = selftestTempPath (eng, "mp-stem-" + h0 + "." + e0);
            tmp.deleteFile();
            check (peer.downloadBlob (h0, e0, tmp), "peer fetched the stem from the relay's blob store [" + peer.lastError() + "]");
            check (tmp.existsAsFile() && tmp.getSize() > 0, "fetched stem is non-empty (" + juce::String (tmp.getSize()) + " bytes)");
            tmp.deleteFile();
            peer.leave();
        }
        cmd (ops, "mp_leave_session");

        // PR-2 — stem transfer off the message thread. Proves global apply ORDER
        // survives two quick successive commits of the SAME track (a fast second
        // commit must never jump ahead of a still-in-flight first one) through a
        // REAL live guest session (mp_join_session, not a direct apply_remote_track
        // command) — exercising the guest's own commit-frame prefetch -> apply path
        // (routeStateMutatingJob) end-to-end, including the received clip's audio
        // resolving via the worker's prefetch stage (the "receive path" case).
        section ("Multiplayer PR-2: stem transfer order + receive path (live session)");
        {
            MoshEngine ordHostEng (false, true, "pr2-order-host");
            MoshOps    ordHostOps (ordHostEng);
            MoshEngine ordGuestEng (false, true, "pr2-order-guest");
            MoshOps    ordGuestOps (ordGuestEng);

            auto ordSess = cmd (ordHostOps, "mp_create_session", objN ({ { "name", "OrdHost" }, { "color", "#101010" } }));
            check (ok (ordSess), "order: host created a session");
            const auto ordCode = ordSess.getProperty ("data", juce::var()).getProperty ("code", juce::var()).toString();

            check (ok (cmd (ordGuestOps, "mp_join_session",
                            objN ({ { "code", ordCode }, { "name", "OrdGuest" }, { "color", "#202020" } }))),
                   "order: guest joined the host's room (a REAL live session, not a direct apply)");
            // Settle joinSession()'s own auto-fired (harmless, 0-track) bootstrap_request
            // before creating real content -- see the identical comment in the self-heal
            // section below for why this matters once a bootstrap answer can carry a
            // (possibly slow, under MOSH_RELAY_BLOB_DELAY_MS) stem upload.
            {
                auto* mmSettle = juce::MessageManager::getInstanceWithoutCreating();
                const auto settleDeadline = juce::Time::getMillisecondCounter() + (juce::uint32) 1000;
                while (juce::Time::getMillisecondCounter() < settleDeadline)
                {
                    if (mmSettle != nullptr) mmSettle->runDispatchLoopUntil (50);
                    else juce::Thread::sleep (50);
                }
            }

            auto ordMk = cmd (ordHostOps, "create_track", args1 ("name", "Order Src"));
            const auto ordTrackId = ordMk.getProperty ("data", juce::var()).getProperty ("trackId", juce::var()).toString();
            check (ok (cmd (ordHostOps, "add_test_tone_clip", objN ({ { "trackId", ordTrackId }, { "seconds", 1.0 } }))),
                   "order: host added a wave clip");

            juce::String ordLid;
            {
                auto snap = ordHostOps.snapshot();
                if (auto* arr = snap["tracks"].getArray())
                    for (auto& tv : *arr)
                        if (tv.getProperty ("name", juce::var()).toString() == "Order Src")
                            ordLid = tv.getProperty ("logicalId", juce::var()).toString();
            }
            check (ordLid.isNotEmpty(), "order: host track logicalId resolved");

            // Commit #1 (original name), then IMMEDIATELY mutate + commit #2 (renamed)
            // — back-to-back, no wait in between, so both are in flight close together.
            auto ordCommit1 = cmd (ordHostOps, "mp_commit_track", args1 ("trackId", ordTrackId));
            check (ok (ordCommit1), "order: commit #1 ok");
            check (ok (cmd (ordHostOps, "rename_track", objN ({ { "trackId", ordTrackId }, { "name", "Order Src RENAMED" } }))),
                   "order: host renamed the track");
            auto ordCommit2 = cmd (ordHostOps, "mp_commit_track", args1 ("trackId", ordTrackId));
            check (ok (ordCommit2), "order: commit #2 ok");

            // Bounded drain: the guest's own live poll loop receives BOTH commit
            // frames, each routed prefetch (download the stem) -> apply
            // (apply_remote_track) through the SAME single-worker FIFO — proving the
            // second (later) commit's apply can never be scheduled ahead of the
            // first's, even though both reference the IDENTICAL stem (so the
            // second's prefetch is a fast already-downloaded no-op, unlike the first).
            auto* ordMm = juce::MessageManager::getInstanceWithoutCreating();
            bool ordSettled = false;
            const auto ordDeadline = juce::Time::getMillisecondCounter() + (juce::uint32) 20000;
            juce::String ordGuestName;
            bool ordGuestClipMissing = true;
            while (! ordSettled && juce::Time::getMillisecondCounter() < ordDeadline)
            {
                if (ordMm != nullptr) ordMm->runDispatchLoopUntil (50);
                else juce::Thread::sleep (50);
                auto t = trackSnapshotByLogicalId (ordGuestOps, ordLid);
                ordGuestName = t.getProperty ("name", juce::var()).toString();
                ordGuestClipMissing = true;
                if (auto* cs = t.getProperty ("clips", juce::var()).getArray())
                    for (auto& c : *cs)
                        if (c.getProperty ("type", juce::var()).toString() == "wave")
                            ordGuestClipMissing = (bool) c.getProperty ("sourceMissing", false);
                ordSettled = (ordGuestName == "Order Src RENAMED") && ! ordGuestClipMissing;
            }
            check (ordSettled, "order+receive: guest settles at the SECOND (later) commit's name with its clip resolved, within the bound");
            check (ordGuestName == "Order Src RENAMED",
                   "order: guest never regresses to (or gets stuck on) the FIRST commit's name -- global apply order preserved");
            check (! ordGuestClipMissing,
                   "receive path: guest's clip is NOT sourceMissing (the worker's prefetch stage downloaded the stem before commit's apply ran)");

            cmd (ordGuestOps, "mp_leave_session");
            cmd (ordHostOps, "mp_leave_session");
        }

        // PR-2 — no-freeze proxy. Gated additionally on MOSH_RELAY_BLOB_DELAY_MS (set
        // for the WHOLE relay process by relay/run-mp-selftest.sh's caller — the local
        // relay has no per-call toggle, so this only runs in a dedicated gate
        // invocation with the delay armed) so the default MOSH_SELFTEST_MP=1 run stays
        // fast. Proves mp_commit_track returns — and a second, unrelated command
        // executes — well before the artificially slow upload could possibly have
        // completed inline, deterministically demonstrating the message thread never
        // blocked on it.
        if (std::getenv ("MOSH_RELAY_BLOB_DELAY_MS") != nullptr)
        {
            section ("Multiplayer PR-2: no-freeze proxy (MOSH_RELAY_BLOB_DELAY_MS)");

            MoshEngine nfEng (false, true, "pr2-nofreeze-host");
            MoshOps    nfOps (nfEng);
            juce::var nfLastEvent;
            nfOps.setEventSink ([&] (const juce::var& e) { nfLastEvent = e; });

            auto nfSess = cmd (nfOps, "mp_create_session", objN ({ { "name", "NF" }, { "color", "#ffffff" } }));
            check (ok (nfSess), "no-freeze: host created a session");

            auto nfMk = cmd (nfOps, "create_track", args1 ("name", "NF Src"));
            const auto nfTrackId = nfMk.getProperty ("data", juce::var()).getProperty ("trackId", juce::var()).toString();
            check (ok (cmd (nfOps, "add_test_tone_clip", objN ({ { "trackId", nfTrackId }, { "seconds", 1.0 } }))),
                   "no-freeze: host added a wave clip");

            const auto nfT0 = juce::Time::getMillisecondCounterHiRes();
            auto nfCommit = cmd (nfOps, "mp_commit_track", args1 ("trackId", nfTrackId));
            const auto nfCommitElapsedMs = juce::Time::getMillisecondCounterHiRes() - nfT0;
            check (ok (nfCommit), "no-freeze: mp_commit_track ok");
            check (nfCommit.getProperty ("data", juce::var()).getProperty ("status", juce::var()).toString() == "uploading",
                   "no-freeze: async branch taken");
            check (nfCommitElapsedMs < 400.0,
                   "no-freeze: mp_commit_track returned near-instantly despite the delayed upload ("
                       + juce::String (nfCommitElapsedMs, 1) + "ms)");

            const auto nfT1 = juce::Time::getMillisecondCounterHiRes();
            check (ok (cmd (nfOps, "create_track", args1 ("name", "NF Trivial"))),
                   "no-freeze: a trivial command executes while the upload is still in flight");
            const auto nfTrivialElapsedMs = juce::Time::getMillisecondCounterHiRes() - nfT1;
            check (nfTrivialElapsedMs < 400.0,
                   "no-freeze: the trivial command was ALSO fast ("
                       + juce::String (nfTrivialElapsedMs, 1) + "ms) — the message thread stayed free");

            auto* nfMm = juce::MessageManager::getInstanceWithoutCreating();
            bool nfCommitted = false;
            const auto nfDeadline = juce::Time::getMillisecondCounter() + (juce::uint32) 20000;
            while (! nfCommitted && juce::Time::getMillisecondCounter() < nfDeadline)
            {
                if (nfMm != nullptr) nfMm->runDispatchLoopUntil (50);
                else juce::Thread::sleep (50);
                nfCommitted = nfLastEvent.getProperty ("type", juce::var()).toString() == "mp_commit_done";
            }
            check (nfCommitted, "no-freeze: the delayed upload eventually completes in the background (mp_commit_done observed)");
            check ((bool) nfLastEvent.getProperty ("payload", juce::var()).getProperty ("ok", false),
                   "no-freeze: the delayed upload succeeded");

            cmd (nfOps, "mp_leave_session");
        }

        // PR-2 — MOSH_MP_SYNC_TRANSFER kill switch. Gated on the env var being set
        // (read once at MultiplayerSession construction, so it can't be toggled
        // mid-process — a dedicated gate invocation, like the no-freeze check above).
        // Proves the switch actually reverts to the original fully synchronous/
        // inline behaviour: mp_commit_track reports status:"committed" (not
        // "uploading") and the stem is ALREADY on the relay by the time it returns
        // — no waiting for mp_commit_done required.
        if (std::getenv ("MOSH_MP_SYNC_TRANSFER") != nullptr)
        {
            section ("Multiplayer PR-2: MOSH_MP_SYNC_TRANSFER kill switch");

            MoshEngine syncEng (false, true, "pr2-syncswitch-host");
            MoshOps    syncOps (syncEng);

            auto syncSess = cmd (syncOps, "mp_create_session", objN ({ { "name", "Sync" }, { "color", "#666666" } }));
            check (ok (syncSess), "sync-switch: host created a session");
            const auto syncCode = syncSess.getProperty ("data", juce::var()).getProperty ("code", juce::var()).toString();

            auto syncMk = cmd (syncOps, "create_track", args1 ("name", "Sync Src"));
            const auto syncTrackId = syncMk.getProperty ("data", juce::var()).getProperty ("trackId", juce::var()).toString();
            check (ok (cmd (syncOps, "add_test_tone_clip", objN ({ { "trackId", syncTrackId }, { "seconds", 1.0 } }))),
                   "sync-switch: host added a wave clip");

            auto syncCommit = cmd (syncOps, "mp_commit_track", args1 ("trackId", syncTrackId));
            check (ok (syncCommit), "sync-switch: mp_commit_track ok");
            check (syncCommit.getProperty ("data", juce::var()).getProperty ("status", juce::var()).toString() == "committed",
                   "sync-switch: status is \"committed\" (synchronous), NOT \"uploading\" — the kill switch reverted the async path");

            auto syncRefs = syncCommit.getProperty ("data", juce::var()).getProperty ("audioRefs", juce::var());
            const auto syncHash = (syncRefs.isArray() && syncRefs.size() > 0) ? syncRefs[0].getProperty ("hash", juce::var()).toString() : juce::String();
            const auto syncExt  = (syncRefs.isArray() && syncRefs.size() > 0) ? syncRefs[0].getProperty ("ext", juce::var()).toString() : juce::String();
            check (syncHash.length() == 64, "sync-switch: stem hash is a sha256");

            // No wait/drain here at all — under the kill switch, mp_commit_track only
            // returns once the upload+publish already completed inline, so a peer can
            // fetch the stem IMMEDIATELY.
            MultiplayerClient syncPeer;
            check (syncPeer.joinSession (syncCode, "SyncPeer", "#777777"), "sync-switch: peer joined the session");
            auto syncTmp = selftestTempPath (eng, "mp-syncswitch-" + syncHash + "." + syncExt);
            syncTmp.deleteFile();
            check (syncPeer.downloadBlob (syncHash, syncExt, syncTmp),
                   "sync-switch: peer fetched the stem immediately, no drain needed [" + syncPeer.lastError() + "]");
            check (syncTmp.existsAsFile() && syncTmp.getSize() > 0, "sync-switch: fetched stem is non-empty");
            syncTmp.deleteFile();
            syncPeer.leave();

            cmd (syncOps, "mp_leave_session");
        }

        // ── PR-2 BLOCKER: a rejected upload must surface as mp_commit_done{ok:false} ──
        // Adversarial review: MultiplayerClient::uploadBlob's raw PUT never checked the
        // HTTP status code (createInputStream() returns non-null for 4xx/5xx on macOS),
        // so a REJECTED upload (quota/auth/a transient 5xx from the relay) was reported
        // back as a false success -- mp_commit_done would fire ok:true for a commit
        // whose stem never actually landed on the relay. Drives MultiplayerSession
        // directly (constructible standalone, no MoshOps/engine needed) with a
        // synthetic audioRef under the reserved ".failtest" ext that relay/server.py's
        // MOSH_RELAY_BLOB_FAIL hook (armed for this whole gate run, like
        // MOSH_RELAY_BLOB_CORRUPT) rejects with a 503 -- proving the failure actually
        // propagates end-to-end through commit() -> uploadBlob() -> emitCommitDone(),
        // the exact chain cmdMpCommitTrack relies on. The adjacent success-path test
        // above already proves ok:true for a real commit, so this closes the other half.
        section ("Multiplayer PR-2 BLOCKER: rejected upload surfaces as mp_commit_done{ok:false}");
        {
            juce::Array<juce::var> failEvents;
            MultiplayerSession failSess (
                [] (const juce::var&) {},                                              // applyCommit (unused)
                [&failEvents] (const juce::String& type, juce::var payload)
                {
                    if (type == "mp_commit_done") failEvents.add (payload);
                },
                [] (bool, const juce::String&, const std::map<juce::String, juce::String>&) {},   // syncLocks
                [] () -> juce::var { return {}; },                                       // provideBootstrap
                [] (const juce::var&) {},                                               // applyBootstrap
                [] (const juce::var&) {});                                              // applyStructural

            const auto failCode = failSess.createSession ("FailHost", "#facade");
            check (failCode.isNotEmpty(), "commit-fail: session created");

            // A synthetic audioRef: the ext is the reserved sentinel the relay's fail
            // hook targets. The uploaded bytes/hash don't need to be a real WAV --
            // uploadBlob is rejected by the relay before any hash/content matters.
            const juce::String failPayload ("bytes-for-the-rejected-commit-upload-check");
            juce::File failSrc = selftestTempPath (eng, "commitfail-src.failtest");
            failSrc.replaceWithText (failPayload);
            juce::FileInputStream failFis (failSrc);
            const auto failHash = juce::SHA256 (failFis).toHexString();

            auto* refObj = new DynamicObject();
            refObj->setProperty ("hash", failHash);
            refObj->setProperty ("ext", "failtest");
            juce::Array<juce::var> failRefs; failRefs.add (var (refObj));
            juce::Array<juce::File> failStemFiles; failStemFiles.add (failSrc);

            const juce::String failLid ("commit-fail-logical-id");
            failSess.commit (failLid, "{\"fake\":\"blob\"}", var (failRefs), failStemFiles);

            // Bounded drain for mp_commit_done (async worker unless MOSH_MP_SYNC_TRANSFER
            // is set, in which case commit() has already returned synchronously and the
            // event was pushed inline -- either way this loop is a correct, cheap wait).
            auto* mmFail = juce::MessageManager::getInstanceWithoutCreating();
            const auto failDeadline = juce::Time::getMillisecondCounter() + (juce::uint32) 20000;
            while (failEvents.isEmpty() && juce::Time::getMillisecondCounter() < failDeadline)
            {
                if (mmFail != nullptr) mmFail->runDispatchLoopUntil (50);
                else juce::Thread::sleep (50);
            }
            check (! failEvents.isEmpty(), "commit-fail: mp_commit_done was emitted");
            if (! failEvents.isEmpty())
            {
                const auto& done = failEvents.getReference (0);
                check (done.getProperty ("logicalId", juce::var()).toString() == failLid,
                       "commit-fail: mp_commit_done carries the right logicalId");
                check (! (bool) done.getProperty ("ok", true),
                       "commit-fail: mp_commit_done reports ok:false (the rejected upload was NOT a false success)");
                check (done.getProperty ("error", juce::var()).toString().isNotEmpty(),
                       "commit-fail: mp_commit_done carries an error string");
            }

            failSrc.deleteFile();
            failSess.leaveSession();
        }

        // Async outbox (anti-jank): a fire-and-forget broadcast does NOT block the
        // message thread on HTTP — it enqueues, and the background poll thread drains
        // + publishes it. Prove the round-trip: a watcher peer eventually receives a
        // selection we broadcast through the live session.
        {
            auto host = cmd (ops, "mp_create_session", objN ({ { "name", "Sel" }, { "color", "#abcdef" } }));
            check (ok (host), "mp_create_session (outbox path) ok");
            const auto hostCode = host.getProperty ("data", juce::var()).getProperty ("code", juce::var()).toString();

            MultiplayerClient watcher;
            check (watcher.joinSession (hostCode, "Watch", "#123456"), "watcher joined the outbox session [" + watcher.lastError() + "]");

            // Returns immediately (enqueue only — no synchronous HTTP on this thread).
            check (ok (cmd (ops, "mp_broadcast_selection", objN ({ { "trackId", "trk-7" }, { "clipId", "clip-9" } }))),
                   "mp_broadcast_selection returns without blocking");

            // Poll the watcher until the poll thread has drained + published it (bounded
            // so a stall fails the gate rather than hanging). Pump the message loop so
            // the session's callAsyncs drain too.
            auto* mm = juce::MessageManager::getInstanceWithoutCreating();
            bool gotSel = false;
            const auto deadline = juce::Time::getMillisecondCounter() + (juce::uint32) 20000;
            while (! gotSel && juce::Time::getMillisecondCounter() < deadline)
            {
                for (auto& f : watcher.poll())
                {
                    auto msg = f.getProperty ("msg", juce::var());
                    if (msg.getProperty ("type", juce::var()).toString() == "selection"
                        && msg.getProperty ("trackId", juce::var()).toString() == "trk-7"
                        && msg.getProperty ("clipId", juce::var()).toString() == "clip-9")
                        gotSel = true;
                }
                if (! gotSel)
                {
                    if (mm != nullptr) mm->runDispatchLoopUntil (100);
                    else juce::Thread::sleep (100);
                }
            }
            check (gotSel, "selection broadcast reached a peer via the async outbox (poll thread published it)");

            cmd (ops, "mp_leave_session");
            watcher.leave();
        }

        // Shared by both sub-sections below: a wave clip's sourceMissing flag / id,
        // read from a track located by logicalId (mirrors trackSnapshotByLogicalId's
        // own scoping, used across both the self-heal regression and the bootstrap
        // end-to-end test).
        auto clipSourceMissing = [] (MoshOps& o, const juce::String& lid) -> bool
        {
            auto t = trackSnapshotByLogicalId (o, lid);
            if (auto* cs = t.getProperty ("clips", juce::var()).getArray())
                for (auto& c : *cs)
                    if (c.getProperty ("type", juce::var()).toString() == "wave")
                        return (bool) c.getProperty ("sourceMissing", false);
            return false;
        };
        auto waveClipIdOf = [] (MoshOps& o, const juce::String& lid) -> juce::String
        {
            auto t = trackSnapshotByLogicalId (o, lid);
            if (auto* cs = t.getProperty ("clips", juce::var()).getArray())
                for (auto& c : *cs)
                    if (c.getProperty ("type", juce::var()).toString() == "wave")
                        return c.getProperty ("id", juce::var()).toString();
            return {};
        };

        // ── mp_fetch_missing_stems — self-healing stem resolution ───────────
        // Fresh, isolated host + guest engines (distinct session dirs, like the
        // AL-010 / "Layer 3" two-engine patterns above) so a stem download is a
        // REAL cross-directory HTTP fetch through relay/server.py's blob store,
        // not a same-directory coincidence.
        section ("Multiplayer P4: self-healing stem fetch (mp_fetch_missing_stems)");
        {
            MoshEngine hostEng (false, true, "mp-selfheal-host");
            MoshOps    hostOps (hostEng);
            MoshEngine guestEng (false, true, "mp-selfheal-guest");
            MoshOps    guestOps (guestEng);

            auto hostSess = cmd (hostOps, "mp_create_session", objN ({ { "name", "SHHost" }, { "color", "#111111" } }));
            check (ok (hostSess), "self-heal: host created a session");
            const auto shCode = hostSess.getProperty ("data", juce::var()).getProperty ("code", juce::var()).toString();
            check (shCode.isNotEmpty(), "self-heal: host got a room code");

            check (ok (cmd (guestOps, "mp_join_session",
                            objN ({ { "code", shCode }, { "name", "SHGuest" }, { "color", "#222222" } }))),
                   "self-heal: guest joined the host's room");
            // joinSession() unconditionally fires its own bootstrap_request (the
            // normal late-join path) the instant it joins -- at this point the host
            // has zero tracks, so the round-trip answer is harmless (0 tracks -> 0
            // tracks) PROVIDED it lands before the host creates real content below.
            // Drain it here (bounded) rather than risk it landing LATE (e.g. because
            // MOSH_RELAY_BLOB_DELAY_MS is slowing down some unrelated stem upload
            // elsewhere) and overwriting the guest's own apply_remote_track state
            // via a now-stale cmdMpApplyBootstrap mid-test.
            {
                auto* mmSettle = juce::MessageManager::getInstanceWithoutCreating();
                const auto settleDeadline = juce::Time::getMillisecondCounter() + (juce::uint32) 1000;
                while (juce::Time::getMillisecondCounter() < settleDeadline)
                {
                    if (mmSettle != nullptr) mmSettle->runDispatchLoopUntil (50);
                    else juce::Thread::sleep (50);
                }
            }

            auto mk = cmd (hostOps, "create_track", args1 ("name", "SH Src"));
            const auto shTrackId = mk.getProperty ("data", juce::var()).getProperty ("trackId", juce::var()).toString();
            check (ok (cmd (hostOps, "add_test_tone_clip", objN ({ { "trackId", shTrackId }, { "seconds", 1.0 } }))),
                   "self-heal: host added a wave clip");

            // mp_serialize_project content-addresses + uploads the stem (the same path
            // a late-joiner's bootstrap uses) and returns the blob directly.
            auto ser = cmd (hostOps, "mp_serialize_project");
            check (ok (ser), "self-heal: host mp_serialize_project ok");
            juce::var shTrackEntry;
            if (auto* tarr = ser.getProperty ("data", juce::var()).getProperty ("tracks", juce::var()).getArray())
                for (auto& tv : *tarr)
                    if (auto rr = tv.getProperty ("audioRefs", juce::var()); rr.isArray() && rr.size() > 0)
                        shTrackEntry = tv;
            check (shTrackEntry.isObject(), "self-heal: host's bundle carries a track with audioRefs");
            const auto shBlob = shTrackEntry.getProperty ("blob", juce::var()).toString();
            check (shBlob.isNotEmpty(), "self-heal: host track blob non-empty");

            // THE REGRESSION: apply the peer's track structure directly (bypassing the
            // download-before-apply step that applyMultiplayerCommitMessage/
            // cmdMpApplyBootstrap normally run) — reproduces a transient upload/download
            // failure, where the ignored uploadBlob/downloadBlob bool result left the
            // guest's clip permanently sourceMissing with no recovery but a host re-commit.
            auto applied = cmd (guestOps, "apply_remote_track", args1 ("blob", shBlob));
            check (ok (applied), "self-heal: guest applied the track structure (no stem download)");
            const auto shLid = applied.getProperty ("data", juce::var()).getProperty ("logicalId", juce::var()).toString();
            check (shLid.isNotEmpty(), "self-heal: applied track logicalId resolved");

            check (clipSourceMissing (guestOps, shLid),
                   "self-heal: guest's clip is sourceMissing before fetch (regression reproduced)");
            const auto shClipId = waveClipIdOf (guestOps, shLid);
            check (shClipId.isNotEmpty(), "self-heal: guest's wave clip id resolved");
            check (! ok (cmd (guestOps, "get_clip_peaks", args1 ("clipId", shClipId))),
                   "self-heal: get_clip_peaks fails before the stem is fetched");

            // THE FIX: the guest self-heals by re-deriving the missing hash/ext from its
            // own clip's by-hash source ref and retrying the download.
            auto fetch = cmd (guestOps, "mp_fetch_missing_stems", args1 ("wait", true));
            check (ok (fetch), "self-heal: mp_fetch_missing_stems ok");
            check ((int) fetch.getProperty ("data", juce::var()).getProperty ("fetched", 0) == 1,
                   "self-heal: fetched exactly 1 missing stem");
            check ((int) fetch.getProperty ("data", juce::var()).getProperty ("failed", 0) == 0,
                   "self-heal: 0 failures");
            check (! clipSourceMissing (guestOps, shLid),
                   "self-heal: guest's clip is no longer sourceMissing after fetch");
            check (ok (cmd (guestOps, "get_clip_peaks", args1 ("clipId", shClipId))),
                   "self-heal: get_clip_peaks succeeds after the fetch");

            // A second fetch with nothing missing is a cheap synchronous no-op.
            auto refetch = cmd (guestOps, "mp_fetch_missing_stems", args1 ("wait", true));
            check (ok (refetch), "self-heal: re-running mp_fetch_missing_stems is a harmless no-op");
            check ((int) refetch.getProperty ("data", juce::var()).getProperty ("fetched", 0) == 0,
                   "self-heal: nothing left to fetch");

            // Adversarial-review finding #2: every check above uses wait:true (the
            // SYNCHRONOUS branch) — the std::thread + callAsync ASYNC branch had ZERO
            // coverage. Force it directly with a second missing-stem clip on the SAME
            // host+guest room (the relay already holds the correct bytes, so this is a
            // deterministic proof the background-thread path lands correctly, not a
            // race against a deliberately-broken transfer).
            auto mk2 = cmd (hostOps, "create_track", args1 ("name", "SH Src 2"));
            const auto shTrackId2 = mk2.getProperty ("data", juce::var()).getProperty ("trackId", juce::var()).toString();
            check (ok (cmd (hostOps, "add_test_tone_clip",
                            objN ({ { "trackId", shTrackId2 }, { "seconds", 1.0 }, { "freq", 440.0 } }))),
                   "self-heal (async): host added a second wave clip");

            auto ser2 = cmd (hostOps, "mp_serialize_project");
            check (ok (ser2), "self-heal (async): host mp_serialize_project ok");
            juce::String shLid2;
            {
                auto snap = hostOps.snapshot();
                if (auto* arr = snap["tracks"].getArray())
                    for (auto& tv : *arr)
                        if (tv.getProperty ("name", juce::var()).toString() == "SH Src 2")
                            shLid2 = tv.getProperty ("logicalId", juce::var()).toString();
            }
            check (shLid2.isNotEmpty(), "self-heal (async): host's second track logicalId resolved");

            juce::var shTrackEntry2;
            if (auto* tarr = ser2.getProperty ("data", juce::var()).getProperty ("tracks", juce::var()).getArray())
                for (auto& tv : *tarr)
                    if (tv.getProperty ("logicalId", juce::var()).toString() == shLid2)
                        shTrackEntry2 = tv;
            check (shTrackEntry2.isObject(), "self-heal (async): host's bundle carries the second track");
            const auto shBlob2 = shTrackEntry2.getProperty ("blob", juce::var()).toString();
            check (shBlob2.isNotEmpty(), "self-heal (async): second track blob non-empty");

            auto applied2 = cmd (guestOps, "apply_remote_track", args1 ("blob", shBlob2));
            check (ok (applied2), "self-heal (async): guest applied the second track structure (no stem download)");
            const auto shLid2Applied = applied2.getProperty ("data", juce::var()).getProperty ("logicalId", juce::var()).toString();
            check (shLid2Applied == shLid2, "self-heal (async): applied logicalId matches the host's second track");
            check (clipSourceMissing (guestOps, shLid2Applied),
                   "self-heal (async): guest's second clip is sourceMissing before fetch");

            // THE ASYNC PATH: no `wait` arg -> cmdMpFetchMissingStems takes the
            // std::thread + callAsync branch (mirrors cmdMpApplyBootstrap's own
            // auto-trigger call, which also omits `wait`).
            auto fetch2 = cmd (guestOps, "mp_fetch_missing_stems");
            check (ok (fetch2), "self-heal (async): mp_fetch_missing_stems (no wait) returns ok immediately");
            check (fetch2.getProperty ("data", juce::var()).getProperty ("status", juce::var()).toString() == "started",
                   "self-heal (async): took the async branch (status:\"started\")");

            // Bounded drain for the background thread's downloadBlob + its callAsync
            // completion (sourceMediaChanged + emitSnapshotInvalidated) to land.
            auto* mm2 = juce::MessageManager::getInstanceWithoutCreating();
            bool resolved2 = false;
            const auto deadline2 = juce::Time::getMillisecondCounter() + (juce::uint32) 20000;
            while (! resolved2 && juce::Time::getMillisecondCounter() < deadline2)
            {
                if (mm2 != nullptr) mm2->runDispatchLoopUntil (50);
                else juce::Thread::sleep (50);
                resolved2 = ! clipSourceMissing (guestOps, shLid2Applied);
            }
            check (resolved2, "self-heal (async): guest's clip resolved via the background thread + callAsync (previously untested code path)");
            const auto shClipId2 = waveClipIdOf (guestOps, shLid2Applied);
            auto peaksRes2 = cmd (guestOps, "get_clip_peaks", args1 ("clipId", shClipId2));
            check (ok (peaksRes2),
                   "self-heal (async): get_clip_peaks succeeds after the async fetch [clipId=" + shClipId2
                       + " err=" + peaksRes2.getProperty ("error", juce::var()).toString() + "]");

            cmd (guestOps, "mp_leave_session");
            cmd (hostOps, "mp_leave_session");
        }

        // ── PR-1 should-fix: downloadBlob rejects a corrupted transfer ───────
        // Nothing previously proved the SHA-256 integrity check in
        // MultiplayerClient::downloadBlob (see its .h doc comment) actually fires —
        // it was "correct by inspection" only. relay/server.py's MOSH_RELAY_BLOB_CORRUPT
        // hook (armed for this whole gate run by run-mp-selftest.sh, ext-scoped so it
        // can be left on without corrupting every OTHER test's real ".wav" stem) flips
        // the bytes of any raw GET whose key ends in ".corrupttest" — a reserved ext
        // used nowhere else in this file. A direct MultiplayerClient-level check (not
        // routed through MoshOps/a clip) isolates the exact mechanism cmdMpFetchMissingStems
        // depends on: its `land` lambda (MoshOps.cpp) only calls sourceMediaChanged() /
        // clears sourceMissing when downloadBlob returns true, and downloadBlob itself
        // never leaves a corrupt/truncated file on disk on a hash mismatch — so proving
        // downloadBlob's rejection here is precisely the guarantee the clip-level
        // self-heal flow (proven working above) relies on to keep a corrupted clip
        // sourceMissing (retryable) rather than falsely landing bad bytes as resolved.
        section ("Multiplayer PR-1 should-fix: downloadBlob rejects a corrupted transfer (MOSH_RELAY_BLOB_CORRUPT)");
        {
            MultiplayerClient corruptHost;
            const auto corruptCode = corruptHost.createSession ("CorruptHost", "#abcabc");
            check (corruptCode.isNotEmpty(), "corrupt: host created a session [" + corruptHost.lastError() + "]");

            MultiplayerClient corruptPeer;
            check (corruptPeer.joinSession (corruptCode, "CorruptPeer", "#cbacba"),
                   "corrupt: peer joined the room [" + corruptPeer.lastError() + "]");

            // Upload a KNOWN payload under the reserved "corrupttest" ext -- the relay's
            // hook targets exactly (and only) this ext for the whole run.
            const juce::String payload ("known-stem-bytes-for-the-corruption-rejection-check");
            juce::File srcTmp = selftestTempPath (eng, "corrupt-src.corrupttest");
            srcTmp.replaceWithText (payload);
            juce::FileInputStream fis (srcTmp);
            const auto hash = juce::SHA256 (fis).toHexString();
            check (corruptHost.uploadBlob (hash, "corrupttest", srcTmp),
                   "corrupt: host uploaded the known payload [" + corruptHost.lastError() + "]");
            srcTmp.deleteFile();

            juce::File dest = selftestTempPath (eng, "corrupt-dest-" + hash + ".corrupttest");
            dest.deleteFile();
            const bool got = corruptPeer.downloadBlob (hash, "corrupttest", dest);
            check (! got, "corrupt: downloadBlob correctly REJECTS the corrupted transfer (returns false)");
            check (! dest.existsAsFile(), "corrupt: the corrupted/truncated download was deleted, not left on disk");
            check (corruptPeer.lastError().contains ("hash mismatch"),
                   "corrupt: the error reports a hash mismatch [" + corruptPeer.lastError() + "]");

            // Retryable: a clean download (a normal ".wav"-scoped ext, untouched by the
            // hook) must still succeed right after -- the rejection above doesn't wedge
            // the client or the relay into a permanently-broken state.
            const juce::String payload2 ("clean-retry-bytes-prove-the-client-recovers");
            juce::File srcTmp2 = selftestTempPath (eng, "corrupt-retry-src.wav");
            srcTmp2.replaceWithText (payload2);
            juce::FileInputStream fis2 (srcTmp2);
            const auto hash2 = juce::SHA256 (fis2).toHexString();
            check (corruptHost.uploadBlob (hash2, "wav", srcTmp2),
                   "corrupt: host uploaded a second (clean-path) payload [" + corruptHost.lastError() + "]");
            srcTmp2.deleteFile();
            juce::File dest2 = selftestTempPath (eng, "corrupt-retry-dest-" + hash2 + ".wav");
            dest2.deleteFile();
            // NOTE: lastError() is sticky (only ever set, never cleared on success) --
            // don't print it here, it would misleadingly show the PRIOR rejection's
            // message even though this call succeeds.
            check (corruptPeer.downloadBlob (hash2, "wav", dest2),
                   "corrupt: a clean (non-corrupted-ext) retry still succeeds -- rejection is retryable, not wedged");
            check (dest2.existsAsFile(), "corrupt: the clean retry landed a real file");
            dest2.deleteFile();

            corruptPeer.leave();
            corruptHost.leave();
        }

        // ── Bootstrap end-to-end on the local/dev relay ──────────────────────
        // The NORMAL (non-regression) path: a fresh late-joiner adopts the host's
        // whole project via mp_apply_bootstrap, and the stem arrives automatically
        // (cmdMpApplyBootstrap's existing download-before-apply loop) — proving the
        // real cross-machine fetch that was previously only exercised against the
        // cloud relay now also works against relay/server.py.
        section ("Multiplayer P4: bootstrap end-to-end on the local relay");
        {
            MoshEngine bootHostEng (false, true, "mp-bootstrap-host");
            MoshOps    bootHostOps (bootHostEng);
            MoshEngine bootGuestEng (false, true, "mp-bootstrap-guest");
            MoshOps    bootGuestOps (bootGuestEng);

            auto bhSess = cmd (bootHostOps, "mp_create_session", objN ({ { "name", "BHost" }, { "color", "#333333" } }));
            check (ok (bhSess), "bootstrap: host created a session");
            const auto bhCode = bhSess.getProperty ("data", juce::var()).getProperty ("code", juce::var()).toString();

            check (ok (cmd (bootGuestOps, "mp_join_session",
                            objN ({ { "code", bhCode }, { "name", "BGuest" }, { "color", "#444444" } }))),
                   "bootstrap: guest joined the host's room");

            auto bmk = cmd (bootHostOps, "create_track", args1 ("name", "Boot Src"));
            const auto bhTrackId = bmk.getProperty ("data", juce::var()).getProperty ("trackId", juce::var()).toString();
            check (ok (cmd (bootHostOps, "add_test_tone_clip", objN ({ { "trackId", bhTrackId }, { "seconds", 1.0 } }))),
                   "bootstrap: host added a wave clip");

            auto bser = cmd (bootHostOps, "mp_serialize_project");
            check (ok (bser), "bootstrap: host mp_serialize_project ok");
            auto bBundle = bser.getProperty ("data", juce::var());
            check ((int) bBundle.getProperty ("count", 0) == 1, "bootstrap: serialized a 1-track bundle");

            auto bApp = cmd (bootGuestOps, "mp_apply_bootstrap",
                             objN ({ { "tracks", bBundle.getProperty ("tracks", juce::var()) },
                                     { "annotations", bBundle.getProperty ("annotations", juce::var()) } }));
            check (ok (bApp), "bootstrap: guest mp_apply_bootstrap ok");
            check ((int) bApp.getProperty ("data", juce::var()).getProperty ("applied", 0) == 1,
                   "bootstrap: guest applied 1 track");

            juce::String bLid;
            {
                auto snap = bootGuestOps.snapshot();
                if (auto* arr = snap["tracks"].getArray())
                    for (auto& tv : *arr)
                        if (tv.getProperty ("name", juce::var()).toString() == "Boot Src")
                            bLid = tv.getProperty ("logicalId", juce::var()).toString();
            }
            check (bLid.isNotEmpty(), "bootstrap: guest's track resolved by name");
            check (! clipSourceMissing (bootGuestOps, bLid),
                   "bootstrap: guest's clip is NOT sourceMissing (stem arrived via real cross-directory HTTP fetch)");

            cmd (bootGuestOps, "mp_leave_session");
            cmd (bootHostOps, "mp_leave_session");
        }

        a.leave();
        b.leave();
    }

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

    finishSection();
    std::cerr << "===== " << (checks - failures) << "/" << checks
              << " checks passed, " << failures << " failed =====\n\n";
    return failures;
}

} // namespace mosh
