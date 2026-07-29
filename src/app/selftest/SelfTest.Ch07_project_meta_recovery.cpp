// ── SelfTest.Ch07_project_meta_recovery.cpp — runSelfTest chapter 7 (RFC 002 A-PR6) ──
// Sections moved VERBATIM from src/app/SelfTest.cpp (pre-split lines 1036-1414), in
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

void runChapter07_project_meta_recovery (selftest::SelfTestCtx& ctx)
{
    using namespace juce;
    auto& eng = *ctx.eng;
    auto& ops = *ctx.ops;
    auto& lastEvent = ctx.lastEvent;

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
}

} // namespace mosh
