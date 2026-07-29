// ── SelfTest.Ch02_hosting_session_editing.cpp — runSelfTest chapter 2 (RFC 002 A-PR5) ──────
// Sections moved VERBATIM by prefix-motion from src/app/SelfTest.cpp
// (pre-split lines 387-1093), in exact pre-split order:
//   . "Stage 3: VST3 hosting + MIDI"
//   . "INS-002/INS-005: AU hosting + scan / blocklist"
//   . "Wave 2: tempo / meter / metronome / nav"
//   . "Wave 5: mixer / master / pan"
//   . "Wave 6: clip editing"
// The ONLY in-section edits are the identifier adaptations forced by promoting
// compiler-enumerated cross-chapter locals into SelfTestCtx (SelfTestSupport.h);
// the check messages and their order are byte-identical to the pre-split file.

#include "app/SelfTest.h"
#include "SelfTestChapters.h"
#include "SelfTestSupport.h"
#include "engine/MoshEngine.h"
#include "engine/SessionPaths.h"
#include "moshops/MoshOps.h"
#include "plugins/spectral/MasterSpectralTapPlugin.h"
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

void runChapter02_hosting_session_editing (selftest::SelfTestCtx& ctx)
{
    using namespace juce;
    auto& eng = *ctx.eng;
    auto& ops = *ctx.ops;
    auto& eventTypes = ctx.eventTypes;
    const auto& tid = ctx.tid;

    // ─── Stage 3: VST3 hosting + MIDI ───
    section ("Stage 3: VST3 hosting + MIDI");
    auto& trackById = ctx.trackById = [&] (const String& id) -> var {
        auto snap = ops.snapshot();                 // keep the temporary alive (no dangling array)
        if (auto* arr = snap["tracks"].getArray())
            for (auto& tr : *arr)
                if (tr.getProperty ("id", var()).toString() == id) return tr;
        return {};
    };
    auto externalPluginIndex = [&] (const var& track) -> int {
        if (auto* arr = track.getProperty ("plugins", var()).getArray())
            for (auto& p : *arr)
                if ((bool) p.getProperty ("external", false)) return (int) p.getProperty ("index", -1);
        return -1;
    };

    auto lp = cmd (ops, "list_plugins");
    check (ok (lp), "list_plugins ok");
    const int nPlugins = lp["data"].getProperty ("plugins", var()).size();
    std::cerr << "  ..    " << nPlugins << " VST3 plugin(s) scanned\n";

    // Lane B — RAVE model browser (non-gated fs scan; works in the default light build). Assert the
    // SHAPE (ok + a models array + an available flag), not the count — the model dir is machine-
    // dependent, so a clean CI box with no ~/AI/rave-models returns {models:[], available:false}.
    {
        auto lr = cmd (ops, "list_rave_models");
        check (ok (lr), "list_rave_models ok (fs scan, non-gated)");
        check (lr["data"].getProperty ("models", var()).isArray(), "list_rave_models returns a models array");
        check (lr["data"].hasProperty ("available"), "list_rave_models reports an available flag");
    }

    String fxId, instId;
    if (auto* arr = lp["data"].getProperty ("plugins", var()).getArray())
        for (auto& p : *arr)
        {
            if (! isHarnessHostablePlugin (p)) continue;   // only host vetted, host-safe VST3s
            const bool inst = (bool) p.getProperty ("isInstrument", false);
            if (inst && instId.isEmpty()) instId = p.getProperty ("id", var()).toString();
            if (! inst && fxId.isEmpty()) fxId = p.getProperty ("id", var()).toString();
        }

    if (nPlugins == 0)
    {
        std::cerr << "  (no VST3s available — skipping host checks; commands compiled+dispatch ok)\n";
    }
    else
    {
        // Effect on the existing wave track (tid).
        if (fxId.isNotEmpty())
        {
            { auto* a = new DynamicObject(); a->setProperty ("trackId", tid); a->setProperty ("pluginId", fxId);
              check (ok (cmd (ops, "load_plugin", var (a))), "load_plugin (effect) on wave track ok"); }
            int idx = externalPluginIndex (trackById (tid));
            check (idx >= 0, "effect appears in the plugin chain");
            if (idx >= 0)
            {
                { auto* a = new DynamicObject(); a->setProperty ("trackId", tid); a->setProperty ("index", idx);
                  a->setProperty ("paramIndex", 0); a->setProperty ("value", 0.5);
                  check (ok (cmd (ops, "set_plugin_param", var (a))), "set_plugin_param ok"); }
                { auto* a = new DynamicObject(); a->setProperty ("trackId", tid); a->setProperty ("index", idx);
                  a->setProperty ("bypassed", true);
                  cmd (ops, "bypass_plugin", var (a)); }
                // enabled==false reflected
                bool bypassed = false;
                { auto trk = trackById (tid);   // bind to a local (no dangling temporary)
                  if (auto* arr = trk.getProperty ("plugins", var()).getArray())
                    for (auto& p : *arr) if ((int) p.getProperty ("index", -1) == idx) bypassed = ! (bool) p.getProperty ("enabled", true); }
                check (bypassed, "bypass_plugin disabled the plugin");
                // persists across save/reload
                cmd (ops, "save"); cmd (ops, "reload");
                check (externalPluginIndex (trackById (tid)) >= 0, "hosted plugin persists across save/reload");
                { auto* a = new DynamicObject(); a->setProperty ("trackId", tid);
                  a->setProperty ("index", externalPluginIndex (trackById (tid)));
                  check (ok (cmd (ops, "remove_plugin", var (a))), "remove_plugin ok"); }
                check (externalPluginIndex (trackById (tid)) < 0, "plugin removed from chain");
            }
        }

        // MIDI synth: new track + MIDI clip + instrument.
        auto ct = cmd (ops, "create_track", args1 ("name", "Synth"));
        const auto synthTid = ct["data"].getProperty ("trackId", var()).toString();
        { auto* a = new DynamicObject(); a->setProperty ("trackId", synthTid);
          check (ok (cmd (ops, "add_midi_clip", var (a))), "add_midi_clip ok"); }
        check (trackClips (trackById (synthTid)) == 1, "MIDI clip on synth track");
        auto synthClips = trackById (synthTid).getProperty ("clips", var());
        check (synthClips.size() > 0 && synthClips[0].getProperty ("type", var()).toString() == "midi", "clip type == midi");
        if (instId.isNotEmpty())
        {
            { auto* a = new DynamicObject(); a->setProperty ("trackId", synthTid); a->setProperty ("pluginId", instId);
              check (ok (cmd (ops, "load_plugin", var (a))), "load_plugin (instrument) on MIDI track ok"); }
            bool hasInst = false;
            { auto trk = trackById (synthTid);   // bind to a local (no dangling temporary)
              if (auto* arr = trk.getProperty ("plugins", var()).getArray())
                for (auto& p : *arr) if ((bool) p.getProperty ("isInstrument", false)) hasInst = true; }
            check (hasInst, "instrument appears in the synth track chain");
        }
    }

    // ─── INS-002 / INS-005: AU hosting + plugin scan / blocklist / management ───
    // Headless-verifiable COMMAND SURFACE only. We do NOT trigger a real AU sweep
    // (MOSH_SCAN_AU is unset here, so rescan_plugins stays VST3-only + inline) and
    // we do NOT assert any machine-specific AU content -- only shape/ok, so the
    // gate stays green on a box with zero .component files.
    section ("INS-002/INS-005: AU hosting + scan / blocklist");
    {
        // The AudioUnit format is registered (proves the JUCE_PLUGINHOST_AU flag is
        // live) -- machine-independent; the format object exists even with no AUs.
        bool auFormatRegistered = false;
        auto& pfm = eng.engine().getPluginManager().pluginFormatManager;
        for (int i = 0; i < pfm.getNumFormats(); ++i)
            if (pfm.getFormat (i)->getName() == "AudioUnit") auFormatRegistered = true;
       #if JUCE_PLUGINHOST_AU
        check (auFormatRegistered, "AudioUnit format registered in the format manager");
       #else
        std::cerr << "  (JUCE_PLUGINHOST_AU off in this build -- skipping AU format check)\n";
       #endif

        // list_plugins now carries a per-format counts object + a format field per entry.
        auto lp2 = cmd (ops, "list_plugins");
        check (ok (lp2), "list_plugins ok (INS-005)");
        auto counts = lp2["data"].getProperty ("counts", var());
        check (counts.isObject(), "list_plugins payload carries a counts object");
        const int total  = (int) counts.getProperty ("total", -1);
        const int nList  = lp2["data"].getProperty ("plugins", var()).size();
        check (total == nList, "counts.total == plugins array size");
        check ((int) counts.getProperty ("vst3", -1) >= 0
            && (int) counts.getProperty ("au", -1) >= 0, "counts.vst3 and counts.au are present");
        // Every entry carries a format field (VST3 / AudioUnit).
        bool allHaveFormat = true;
        { auto pv = lp2["data"].getProperty ("plugins", var());
          if (auto* arr = pv.getArray())
            for (auto& p : *arr)
                if (p.getProperty ("format", var()).toString().isEmpty()) allHaveFormat = false; }
        check (allHaveFormat, "every list_plugins entry has a non-empty format field");

        // rescan_plugins (VST3-only, inline) dispatches + returns ok with a count.
        // Idempotent: the catalog must not shrink across a rescan.
        //
        // FIT-003 regression-lock: the sync (VST3-only) path must emit ZERO
        // 'plugin_scan_progress' events. That event (now enriched with a live
        // running count + elapsedMs from timerCallback()'s sampler) is reserved for
        // the async AU/deep sweep -- proves enriching it didn't leak sampler state
        // into the inline, message-thread-safe VST3 path.
        auto countScanEvents = [&] {
            int n = 0; for (auto& e : eventTypes) if (e == "plugin_scan_progress") ++n; return n; };
        const int scanEventsBefore = countScanEvents();
        auto rs = cmd (ops, "rescan_plugins", objN ({{ "format", "vst3" }, { "wait", true }}));
        check (ok (rs), "rescan_plugins (vst3) ok");
        check ((int) rs["data"].getProperty ("count", -1) >= total, "rescan_plugins reports a count (>= prior total)");
        check (countScanEvents() == scanEventsBefore,
               "sync VST3 rescan emits no plugin_scan_progress events (FIT-003)");

        // AUD-SCAN — an explicit AU request without the opt-in must FAIL LOUDLY. It used
        // to fall through to the VST3-only branch and answer status:"done" with a count,
        // so a caller that asked for AudioUnits was told the scan had run. That silent
        // success is how "the shipped app can never see an AU" stayed invisible: the env
        // var MOSH_SCAN_AU was the only way in, and it is set in exactly one place in the
        // tree (Main.cpp, for --scan-plugins-deep).
        //
        // Hermetic: this errors BEFORE any scanning, so no AU sweep runs here. The
        // harness never passes allowAU and never requests format:"all", so --selftest
        // still performs no AudioUnit scan of any kind.
        auto auDenied = cmd (ops, "rescan_plugins", objN ({{ "format", "au" }}));
        check (! ok (auDenied), "rescan_plugins(au) without allowAU is refused, not a silent success");
        check (auDenied.getProperty ("error", var()).toString().containsIgnoreCase ("audio unit"),
               "the AU refusal explains itself");
        check (countScanEvents() == scanEventsBefore,
               "a refused AU rescan starts no scan (no progress events)");

        // get_plugin_blocklist returns a well-formed (possibly empty) array.
        auto gb = cmd (ops, "get_plugin_blocklist");
        check (ok (gb), "get_plugin_blocklist ok");
        check (gb["data"].getProperty ("blocklist", var()).isArray(), "get_plugin_blocklist returns an array");

        // block_plugin real round-trip: prefer a VST3 actually in the catalog so
        // we exercise the resolve-to-fileOrIdentifier path (fix for INS-005 id-namespace
        // mismatch).  Fall back to a raw "AudioUnit:..." id if the catalog is empty
        // (e.g. on a box with no VST3 bundles present), which is accepted as a
        // raw-identifier direct block.  Never assert machine-specific content.
        {
            // Snapshot the catalog before we touch it.
            auto lp3 = cmd (ops, "list_plugins");
            auto pv  = lp3["data"].getProperty ("plugins", var());
            String blockTarget;   // the UI-facing id we will pass to block_plugin
            bool   useRealEntry = false;
            if (auto* arr = pv.getArray())
            {
                for (auto& p : *arr)
                {
                    if (p.getProperty ("format", var()).toString() == "VST3")
                    {
                        blockTarget  = p.getProperty ("id", var()).toString();
                        useRealEntry = true;
                        break;
                    }
                }
            }
            // Fall back: a raw "AudioUnit:..." string is accepted as a direct block
            // (no catalog lookup required, as per cmdBlockPlugin implementation).
            const String fallbackId = "AudioUnit:Effect/aufx,fake,MOSH";
            if (blockTarget.isEmpty())
                blockTarget = fallbackId;

            // Calling block_plugin with a bogus (non-path, non-AU, non-VST3-id)
            // string must produce errResult (validates the bad-id path).
            check (! ok (cmd (ops, "block_plugin", args1 ("pluginId", "not-a-real-plugin-id"))),
                   "block_plugin rejects an unresolvable id with errResult");

            // block_plugin with a valid target must succeed.
            check (ok (cmd (ops, "block_plugin", args1 ("pluginId", blockTarget))),
                   "block_plugin ok (real catalog entry or raw AU id)");

            // The blocked entry must appear in get_plugin_blocklist.
            // For a real catalog entry the 'id' field is the UI-facing id (idFor form).
            // For the raw AU fallback the 'id' field equals the raw string (no catalog match).
            // FIT-003: block_plugin is a MANUAL block, so its reason must read "manual"
            // (not "crash_or_hang" -- that tag is reserved for dead-mans-pedal recovery).
            bool inBlock = false;
            juce::String blockedReason;
            { auto bl = cmd (ops, "get_plugin_blocklist")["data"].getProperty ("blocklist", var());
              if (auto* arr = bl.getArray())
                for (auto& e : *arr)
                    if (e.getProperty ("id",    var()).toString() == blockTarget ||
                        e.getProperty ("rawId", var()).toString() == blockTarget)
                        { inBlock = true; blockedReason = e.getProperty ("reason", var()).toString(); } }
            check (inBlock, "blocked id appears in get_plugin_blocklist");
            check (blockedReason == "manual", "manual block_plugin is tagged reason:\"manual\"");

            // If we blocked a real catalog entry it must have disappeared from list_plugins.
            if (useRealEntry)
            {
                auto lp4 = cmd (ops, "list_plugins");
                auto pv4 = lp4["data"].getProperty ("plugins", var());
                bool stillPresent = false;
                if (auto* arr = pv4.getArray())
                    for (auto& p : *arr)
                        if (p.getProperty ("id", var()).toString() == blockTarget) stillPresent = true;
                check (! stillPresent, "blocked VST3 removed from list_plugins immediately");
            }
        }

        // clear_plugin_blocklist empties it again.
        check (ok (cmd (ops, "clear_plugin_blocklist")), "clear_plugin_blocklist ok");
        { auto bl = cmd (ops, "get_plugin_blocklist")["data"].getProperty ("blocklist", var());
          check (bl.isArray() && bl.size() == 0, "blocklist empty after clear_plugin_blocklist"); }

        // READ-ONLY proof: get_plugin_blocklist must NOT be logged (would pollute
        // nothing here, but the contract is read-only).
        auto plog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        check (! plog.contains ("get_plugin_blocklist"), "get_plugin_blocklist is READ-ONLY (not logged)");

        // FIT-003 — dead-mans-pedal crash/hang recovery tags the RIGHT reason.
        // A real in-session AU hang can't be simulated headlessly (JUCE marshals AU
        // instantiation to the message thread with no per-component timeout -- see
        // PluginHost.cpp's HONEST CAVEAT), but the recovery-and-tag bookkeeping IS
        // exactly what a real hang's *next launch* runs, and that part is fully
        // exercisable: debugSimulateCrashRecovery writes the pedal file and replays
        // the identical PluginHost::recoverFromDeadMansPedal() path initialise() runs
        // at real startup.
        {
            auto& ph = ops.pluginHostForScan();
            const String crasherId = "AudioUnit:Effect/aufx,fitkillsim,MOSH";
            ph.debugSimulateCrashRecovery (crasherId);

            auto bl = cmd (ops, "get_plugin_blocklist")["data"].getProperty ("blocklist", var());
            bool found = false; String reason;
            if (auto* arr = bl.getArray())
                for (auto& e : *arr)
                    if (e.getProperty ("rawId", var()).toString() == crasherId)
                        { found = true; reason = e.getProperty ("reason", var()).toString(); }
            check (found, "dead-mans-pedal recovery quarantines the crasher id");
            check (reason == "crash_or_hang",
                   "dead-mans-pedal recovery is tagged reason:\"crash_or_hang\" (not \"manual\")");

            // Clean up: never leave a synthetic id in the shared, machine-wide catalog.
            check (ok (cmd (ops, "clear_plugin_blocklist")), "clear_plugin_blocklist ok (crash-recovery cleanup)");
            auto bl2 = cmd (ops, "get_plugin_blocklist")["data"].getProperty ("blocklist", var());
            check (bl2.isArray() && bl2.size() == 0, "blocklist empty after crash-recovery cleanup");
        }
    }

    // ─── Wave 2: tempo / time-signature / metronome / record / navigation ───
    section ("Wave 2: tempo / meter / metronome / nav");
    {
        auto sess = [&] { return ops.snapshot().getProperty ("session", var()); };

        // Tempo control.
        check (ok (cmd (ops, "set_tempo", args1 ("bpm", 140.0))), "set_tempo ok");
        check (std::abs ((double) sess().getProperty ("tempo", 0.0) - 140.0) < 0.5, "snapshot tempo reflects set_tempo");
        cmd (ops, "set_tempo", args1 ("bpm", 99999.0));
        check ((double) sess().getProperty ("tempo", 0.0) <= 999.0, "set_tempo clamps absurd BPM to <= 999");

        // Time signature.
        check (ok (cmd (ops, "set_time_signature", objN ({{ "numerator", 3 }, { "denominator", 4 }}))), "set_time_signature ok");
        check ((int) sess().getProperty ("timeSigNumerator", 0) == 3, "snapshot numerator == 3");
        check ((int) sess().getProperty ("timeSigDenominator", 0) == 4, "snapshot denominator == 4");
        check (! ok (cmd (ops, "set_time_signature", objN ({{ "numerator", 4 }, { "denominator", 5 }}))), "set_time_signature rejects non-power-of-two denominator");

        // Metronome toggle.
        cmd (ops, "set_metronome", args1 ("enabled", true));
        check ((bool) sess().getProperty ("metronome", false), "metronome enabled in snapshot");
        cmd (ops, "set_metronome", args1 ("enabled", false));
        check (! (bool) sess().getProperty ("metronome", true), "metronome disabled in snapshot");

        // G2b — count-in / pre-roll bars (smoke; full coverage in its own section below).
        cmd (ops, "set_count_in", args1 ("bars", 1));
        check ((int) sess().getProperty ("countInBars", -1) == 1, "countInBars reflects set_count_in in the Wave 2 smoke");
        cmd (ops, "set_count_in", args1 ("bars", 0));   // restore default for the rest of Wave 2

        // Navigation: go-to-end / go-to-start.
        const double len = (double) sess().getProperty ("length", 0.0);
        cmd (ops, "set_transport", args1 ("action", "to_end"));
        const double endPos = (double) ops.snapshot()["transport"].getProperty ("position", -1.0);
        check (len > 0.0 && std::abs (endPos - len) < 0.05, "to_end moves the playhead to the edit length");
        cmd (ops, "set_transport", args1 ("action", "to_start"));
        check ((double) ops.snapshot()["transport"].getProperty ("position", -1.0) < 0.01, "to_start returns the playhead to 0");

        // Leave a clean musical default for later stages.
        cmd (ops, "set_tempo", args1 ("bpm", 120.0));
        cmd (ops, "set_time_signature", objN ({{ "numerator", 4 }, { "denominator", 4 }}));
    }

    // ─── Wave 5: mixer — master bus + pan ───
    section ("Wave 5: mixer / master / pan");
    {
        auto master = [&] { return ops.snapshot().getProperty ("master", var()); };
        check (master().isObject(), "snapshot exposes a master bus");

        check (ok (cmd (ops, "set_master_volume", args1 ("db", -6.0))), "set_master_volume ok");
        check (std::abs ((double) master().getProperty ("volumeDb", 0.0) - (-6.0)) < 0.5, "master volume reflects in snapshot");
        check (ok (cmd (ops, "set_master_pan", args1 ("pan", -0.5))), "set_master_pan ok");
        check (std::abs ((double) master().getProperty ("pan", 0.0) - (-0.5)) < 0.02, "master pan reflects in snapshot");

        // Per-track pan (set_track_pan existed but was never covered).
        check (ok (cmd (ops, "set_track_pan", objN ({{ "trackId", tid }, { "pan", 0.4 }}))), "set_track_pan ok");
        check (std::abs ((double) trackById (tid).getProperty ("pan", 0.0) - 0.4) < 0.02, "track pan reflects in snapshot");

        // G14 — set_track_volume / pan (+ master) route through the UndoManager so undo
        // restores the prior value (previously vp->setVolumeDb() bypassed it -> empty txn).
        {
            // Track volume: set -6 dB, undo restores 0 dB, redo re-applies -6 dB.
            const double trackVolBefore = (double) trackById (tid).getProperty ("volumeDb", 999.0);
            check (ok (cmd (ops, "set_track_volume", objN ({{ "trackId", tid }, { "db", -6.0 }}))), "G14: set_track_volume ok");
            check (std::abs ((double) trackById (tid).getProperty ("volumeDb", 999.0) - (-6.0)) < 0.5, "G14: track volume applies (-6 dB)");
            check (ok (cmd (ops, "undo")), "G14: undo set_track_volume ok");
            check (std::abs ((double) trackById (tid).getProperty ("volumeDb", 999.0) - trackVolBefore) < 0.5, "G14: undo restores prior track volume");
            check (ok (cmd (ops, "redo")), "G14: redo set_track_volume ok");
            check (std::abs ((double) trackById (tid).getProperty ("volumeDb", 999.0) - (-6.0)) < 0.5, "G14: redo re-applies track volume (-6 dB)");
            cmd (ops, "undo");   // leave the track fader where Wave 5 found it

            // Track pan: undo restores the prior pan (0.4 set just above).
            check (ok (cmd (ops, "set_track_pan", objN ({{ "trackId", tid }, { "pan", -0.7 }}))), "G14: set_track_pan ok");
            check (std::abs ((double) trackById (tid).getProperty ("pan", 999.0) - (-0.7)) < 0.02, "G14: track pan applies (-0.7)");
            check (ok (cmd (ops, "undo")), "G14: undo set_track_pan ok");
            check (std::abs ((double) trackById (tid).getProperty ("pan", 999.0) - 0.4) < 0.02, "G14: undo restores prior track pan (0.4)");
            check (ok (cmd (ops, "redo")), "G14: redo set_track_pan ok");
            check (std::abs ((double) trackById (tid).getProperty ("pan", 999.0) - (-0.7)) < 0.02, "G14: redo re-applies track pan (-0.7)");

            // Master volume: undo restores the prior master gain (-6 dB set above).
            check (ok (cmd (ops, "set_master_volume", args1 ("db", -12.0))), "G14: set_master_volume ok");
            check (std::abs ((double) master().getProperty ("volumeDb", 999.0) - (-12.0)) < 0.5, "G14: master volume applies (-12 dB)");
            check (ok (cmd (ops, "undo")), "G14: undo set_master_volume ok");
            check (std::abs ((double) master().getProperty ("volumeDb", 999.0) - (-6.0)) < 0.5, "G14: undo restores prior master volume (-6 dB)");
            check (ok (cmd (ops, "redo")), "G14: redo set_master_volume ok");
            check (std::abs ((double) master().getProperty ("volumeDb", 999.0) - (-12.0)) < 0.5, "G14: redo re-applies master volume (-12 dB)");

            // Master pan: undo restores the prior master pan (-0.5 set above).
            check (ok (cmd (ops, "set_master_pan", args1 ("pan", 0.3))), "G14: set_master_pan ok");
            check (std::abs ((double) master().getProperty ("pan", 999.0) - 0.3) < 0.02, "G14: master pan applies (0.3)");
            check (ok (cmd (ops, "undo")), "G14: undo set_master_pan ok");
            check (std::abs ((double) master().getProperty ("pan", 999.0) - (-0.5)) < 0.02, "G14: undo restores prior master pan (-0.5)");
            check (ok (cmd (ops, "redo")), "G14: redo set_master_pan ok");
            check (std::abs ((double) master().getProperty ("pan", 999.0) - 0.3) < 0.02, "G14: redo re-applies master pan (0.3)");
        }

        cmd (ops, "set_master_volume", args1 ("db", -3.0));   // restore a sane default
    }

    // ─── Wave 6: clip editing (delete / rename / mute / gain / duplicate) ───
    section ("Wave 6: clip editing");
    {
        auto clipById = [&] (const String& cid) -> var {
            auto snap = ops.snapshot();
            if (auto* tracks = snap["tracks"].getArray())
                for (auto& tr : *tracks)
                    if (auto* clips = tr.getProperty ("clips", var()).getArray())
                        for (auto& c : *clips)
                            if (c.getProperty ("id", var()).toString() == cid) return c;
            return {};
        };

        auto et = cmd (ops, "create_track", args1 ("name", "Edit"))["data"].getProperty ("trackId", var()).toString();
        auto cid = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", et }, { "seconds", 1.0 }, { "freq", 330.0 }}))["data"].getProperty ("clipId", var()).toString();
        check (cid.isNotEmpty(), "tone clip created for editing");

        check (ok (cmd (ops, "rename_clip", objN ({{ "clipId", cid }, { "name", "Renamed" }}))), "rename_clip ok");
        check (clipById (cid).getProperty ("name", var()).toString() == "Renamed", "clip name reflects rename");
        // G4A — rename_clip is undoable (was uncovered): undo restores the prior name, redo re-applies.
        check (ok (cmd (ops, "undo")), "undo rename_clip ok");
        check (clipById (cid).getProperty ("name", var()).toString() != "Renamed", "undo restores clip's prior name");
        check (ok (cmd (ops, "redo")), "redo rename_clip ok");
        check (clipById (cid).getProperty ("name", var()).toString() == "Renamed", "redo re-applies clip rename");

        check (ok (cmd (ops, "set_clip_mute", objN ({{ "clipId", cid }, { "mute", true }}))), "set_clip_mute ok");
        check ((bool) clipById (cid).getProperty ("mute", false), "clip mute reflects in snapshot");
        // mute is undoable (was uncovered): undo unmutes, redo re-mutes.
        check (ok (cmd (ops, "undo")), "undo set_clip_mute ok");
        check (! (bool) clipById (cid).getProperty ("mute", true), "undo restores clip unmuted");
        check (ok (cmd (ops, "redo")), "redo set_clip_mute ok");
        check ((bool) clipById (cid).getProperty ("mute", false), "redo re-applies clip mute");

        check (ok (cmd (ops, "set_clip_gain", objN ({{ "clipId", cid }, { "gainDb", 6.0 }}))), "set_clip_gain ok");
        check (std::abs ((double) clipById (cid).getProperty ("gainDb", 0.0) - 6.0) < 0.5, "clip gain reflects in snapshot");
        // gain clamps below quality-collapse (jlimit -48..+24) and is undoable — both uncovered.
        check (ok (cmd (ops, "set_clip_gain", objN ({{ "clipId", cid }, { "gainDb", 999.0 }}))), "set_clip_gain (over-max) ok");
        check (std::abs ((double) clipById (cid).getProperty ("gainDb", 0.0) - 24.0) < 0.5, "clip gain clamps to +24 dB");
        check (ok (cmd (ops, "set_clip_gain", objN ({{ "clipId", cid }, { "gainDb", -999.0 }}))), "set_clip_gain (under-min) ok");
        check (std::abs ((double) clipById (cid).getProperty ("gainDb", 0.0) - (-48.0)) < 0.5, "clip gain clamps to -48 dB");
        check (ok (cmd (ops, "undo")), "undo set_clip_gain ok");
        check (std::abs ((double) clipById (cid).getProperty ("gainDb", 0.0) - 24.0) < 0.5, "undo restores prior clip gain (+24)");
        cmd (ops, "set_clip_gain", objN ({{ "clipId", cid }, { "gainDb", 6.0 }}));   // sane default for downstream

        // G4b — clip fades (fade-in / fade-out, + optional curve type). Audio-clip-only,
        // undoable, JSONL-logged undoable:true, snapshot-invalidating. Fades render NATIVELY
        // through Tracktion's AudioClipBase — no src/state schema change (free persistence
        // + undo, proven below).
        check (std::abs ((double) clipById (cid).getProperty ("fadeInSec", -1.0) - 0.0) < 0.02
               && std::abs ((double) clipById (cid).getProperty ("fadeOutSec", -1.0) - 0.0) < 0.02,
               "clip fades default to 0/0");
        check (ok (cmd (ops, "set_clip_fade", objN ({{ "clipId", cid }, { "fadeInSec", 0.5 }, { "fadeOutSec", 0.25 }}))),
               "set_clip_fade ok");
        check (std::abs ((double) clipById (cid).getProperty ("fadeInSec", 0.0) - 0.5) < 0.02, "clip fadeInSec reflects in snapshot");
        check (std::abs ((double) clipById (cid).getProperty ("fadeOutSec", 0.0) - 0.25) < 0.02, "clip fadeOutSec reflects in snapshot");

        // Undo/redo — the plain CachedValue.referTo(state, id, um) path (same mechanism as
        // clip gain), so this is undoable exactly like every other clip command.
        check (ok (cmd (ops, "undo")), "undo set_clip_fade ok");
        check (std::abs ((double) clipById (cid).getProperty ("fadeInSec", -1.0) - 0.0) < 0.02, "undo restores clip fadeInSec to 0");
        check (std::abs ((double) clipById (cid).getProperty ("fadeOutSec", -1.0) - 0.0) < 0.02, "undo restores clip fadeOutSec to 0");
        check (ok (cmd (ops, "redo")), "redo set_clip_fade ok");
        check (std::abs ((double) clipById (cid).getProperty ("fadeInSec", 0.0) - 0.5) < 0.02, "redo re-applies clip fadeInSec");
        check (std::abs ((double) clipById (cid).getProperty ("fadeOutSec", 0.0) - 0.25) < 0.02, "redo re-applies clip fadeOutSec");

        // Clamp / no-boundary-move (reality-pack inv 30): an over-length fade-in clamps to
        // the clip's own length and NEVER moves the clip's start/length — the fade shapes
        // the edge, it never relocates it.
        {
            const double startBefore  = (double) clipById (cid).getProperty ("start", -1.0);
            const double lengthBefore = (double) clipById (cid).getProperty ("length", -1.0);
            check (ok (cmd (ops, "set_clip_fade", objN ({{ "clipId", cid }, { "fadeInSec", 5.0 }}))),
                   "set_clip_fade (over-length fadeIn) ok");
            check ((double) clipById (cid).getProperty ("fadeInSec", 0.0) <= lengthBefore + 0.02,
                   "clip fadeInSec clamps to <= clip length");
            check (std::abs ((double) clipById (cid).getProperty ("start", -1.0) - startBefore) < 0.001
                   && std::abs ((double) clipById (cid).getProperty ("length", -1.0) - lengthBefore) < 0.001,
                   "fade does not move clip start/length (inv 30)");
            check (ok (cmd (ops, "undo")), "undo over-length fadeIn ok");   // restore 0.5/0.25 for downstream
        }

        // Type rejection: fades are audio-clip-only (mirrors set_clip_gain).
        {
            auto midiFade = cmd (ops, "add_midi_clip", objN ({{ "trackId", et }, { "length", 1.0 }}));
            const auto midiFadeCid = midiFade["data"].getProperty ("clipId", var()).toString();
            check (! ok (cmd (ops, "set_clip_fade", objN ({{ "clipId", midiFadeCid }, { "fadeInSec", 0.2 }}))),
                   "set_clip_fade on a MIDI clip rejected");
            cmd (ops, "remove_clip", args1 ("clipId", midiFadeCid));   // tidy
        }

        // Save/reload persistence — proves the free-persistence claim: fades ride
        // Tracktion's own ValueTree, no src/state code at all.
        cmd (ops, "save"); cmd (ops, "reload");
        check (std::abs ((double) clipById (cid).getProperty ("fadeInSec", 0.0) - 0.5) < 0.02, "clip fadeInSec persists across save/reload");
        check (std::abs ((double) clipById (cid).getProperty ("fadeOutSec", 0.0) - 0.25) < 0.02, "clip fadeOutSec persists across save/reload");

        // JSONL: set_clip_fade logged undoable:true (mirror the warp assert).
        {
            auto flog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
            bool fadeU = false;
            for (auto& ln : StringArray::fromLines (flog))
                if (ln.contains ("\"command\": \"set_clip_fade\"") && ln.contains ("\"undoable\": true")) fadeU = true;
            check (fadeU, "set_clip_fade logged undoable:true");
        }

        // Curve types (optional args): curveIn/curveOut map to AudioFadeCurve::Type
        // (1=linear 2=convex 3=concave 4=sCurve), surfaced on the snapshot as
        // fadeInType/fadeOutType next to the durations.
        check ((int) clipById (cid).getProperty ("fadeInType", 0) == 1
               && (int) clipById (cid).getProperty ("fadeOutType", 0) == 1,
               "clip fade curve types default to linear (1)");
        check (ok (cmd (ops, "set_clip_fade", objN ({{ "clipId", cid }, { "curveIn", "convex" }, { "curveOut", "sCurve" }}))),
               "set_clip_fade (curve) ok");
        check ((int) clipById (cid).getProperty ("fadeInType", 0) == 2, "clip fadeInType reflects curveIn=convex");
        check ((int) clipById (cid).getProperty ("fadeOutType", 0) == 4, "clip fadeOutType reflects curveOut=sCurve");

        // clip-ops wave — reverse / auto-crossfade. Mirrors the fade tests above exactly:
        // audio-clip-only, undoable via the same CachedValue.referTo path, free
        // persistence (no src/state schema change).
        check (! (bool) clipById (cid).getProperty ("reversed", true), "clip reversed defaults to false");
        check (ok (cmd (ops, "set_clip_reverse", objN ({{ "clipId", cid }, { "reversed", true }}))), "set_clip_reverse ok");
        check ((bool) clipById (cid).getProperty ("reversed", false), "clip reversed reflects in snapshot");
        check (ok (cmd (ops, "undo")), "undo set_clip_reverse ok");
        check (! (bool) clipById (cid).getProperty ("reversed", true), "undo restores clip un-reversed");
        check (ok (cmd (ops, "redo")), "redo set_clip_reverse ok");
        check ((bool) clipById (cid).getProperty ("reversed", false), "redo re-applies clip reverse");

        check (! (bool) clipById (cid).getProperty ("autoCrossfade", true), "clip autoCrossfade defaults to false");
        check (ok (cmd (ops, "set_clip_crossfade", objN ({{ "clipId", cid }, { "enabled", true }}))), "set_clip_crossfade ok");
        check ((bool) clipById (cid).getProperty ("autoCrossfade", false), "clip autoCrossfade reflects in snapshot (round-trips)");
        check (ok (cmd (ops, "undo")), "undo set_clip_crossfade ok");
        check (! (bool) clipById (cid).getProperty ("autoCrossfade", true), "undo restores clip autoCrossfade off");
        check (ok (cmd (ops, "redo")), "redo set_clip_crossfade ok");
        check ((bool) clipById (cid).getProperty ("autoCrossfade", false), "redo re-applies clip autoCrossfade");

        // Save/reload persistence — both ride Tracktion's own ValueTree (isReversed /
        // autoCrossfade CachedValues), no src/state code at all, mirrors the fade proof.
        cmd (ops, "save"); cmd (ops, "reload");
        check ((bool) clipById (cid).getProperty ("reversed", false), "clip reversed persists across save/reload");
        check ((bool) clipById (cid).getProperty ("autoCrossfade", false), "clip autoCrossfade persists across save/reload");

        // Type rejection: both are audio-clip-only (mirrors set_clip_gain/set_clip_fade).
        {
            auto midiRev = cmd (ops, "add_midi_clip", objN ({{ "trackId", et }, { "length", 1.0 }}));
            const auto midiRevCid = midiRev["data"].getProperty ("clipId", var()).toString();
            check (! ok (cmd (ops, "set_clip_reverse", objN ({{ "clipId", midiRevCid }, { "reversed", true }}))),
                   "set_clip_reverse on a MIDI clip rejected");
            check (! ok (cmd (ops, "set_clip_crossfade", objN ({{ "clipId", midiRevCid }, { "enabled", true }}))),
                   "set_clip_crossfade on a MIDI clip rejected");
            cmd (ops, "remove_clip", args1 ("clipId", midiRevCid));   // tidy
        }

        // JSONL: both logged undoable:true (mirrors the fade assert).
        {
            auto rlog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
            bool revU = false, xfU = false;
            for (auto& ln : StringArray::fromLines (rlog))
            {
                if (ln.contains ("\"command\": \"set_clip_reverse\"")   && ln.contains ("\"undoable\": true")) revU = true;
                if (ln.contains ("\"command\": \"set_clip_crossfade\"") && ln.contains ("\"undoable\": true")) xfU = true;
            }
            check (revU, "set_clip_reverse logged undoable:true");
            check (xfU, "set_clip_crossfade logged undoable:true");
        }

        // Leave both off for downstream (the undo/redo pairs above left them ON).
        cmd (ops, "set_clip_reverse",   objN ({{ "clipId", cid }, { "reversed", false }}));
        cmd (ops, "set_clip_crossfade", objN ({{ "clipId", cid }, { "enabled",  false }}));

        // clip-ops wave — normalize_clip: non-destructive gain-to-peak. A fresh tone
        // clip (generateTestTone writes 0.25 peak amplitude) has a known source peak of
        // ~-12.04 dBFS (20*log10(0.25)); normalizing to the default target (0 dB) should
        // move the clip's gain to ~+12.04 dB — proving the gain moves toward the target
        // from a known peak, exactly as the task asks.
        {
            auto nCid = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", et }, { "seconds", 0.3 }, { "freq", 440.0 }}))["data"].getProperty ("clipId", var()).toString();
            check (nCid.isNotEmpty(), "tone clip created for normalize_clip");
            check (std::abs ((double) clipById (nCid).getProperty ("gainDb", 999.0) - 0.0) < 0.5, "fresh tone clip starts at ~0 dB gain");

            auto nres = cmd (ops, "normalize_clip", args1 ("clipId", nCid));
            check (ok (nres), "normalize_clip ok");
            check (std::abs ((double) nres["data"].getProperty ("peakDb", 0.0) - (-12.04)) < 0.5,
                   "normalize_clip measures the tone's known ~-12 dB peak");
            check (std::abs ((double) clipById (nCid).getProperty ("gainDb", 0.0) - 12.04) < 0.5,
                   "normalize_clip (default target 0 dB) moves gain toward +12 dB");

            // Undo restores the prior gain; redo re-applies (same CachedValue path as set_clip_gain).
            check (ok (cmd (ops, "undo")), "undo normalize_clip ok");
            check (std::abs ((double) clipById (nCid).getProperty ("gainDb", 999.0) - 0.0) < 0.5, "undo restores prior clip gain (~0 dB)");
            check (ok (cmd (ops, "redo")), "redo normalize_clip ok");
            check (std::abs ((double) clipById (nCid).getProperty ("gainDb", 0.0) - 12.04) < 0.5, "redo re-applies normalize_clip gain");

            // Explicit targetDb: normalizing to -6 dB should land gain around -6-(-12.04) = +6.04 dB.
            auto nres2 = cmd (ops, "normalize_clip", objN ({{ "clipId", nCid }, { "targetDb", -6.0 }}));
            check (ok (nres2), "normalize_clip (targetDb -6) ok");
            check (std::abs ((double) clipById (nCid).getProperty ("gainDb", 0.0) - 6.04) < 0.5,
                   "normalize_clip moves gain toward the requested target, not just 0 dB");

            // Clamp: an extreme target clamps to the same +24 dB ceiling as set_clip_gain.
            auto nres3 = cmd (ops, "normalize_clip", objN ({{ "clipId", nCid }, { "targetDb", 200.0 }}));
            check (ok (nres3), "normalize_clip (extreme target) ok");
            check (std::abs ((double) clipById (nCid).getProperty ("gainDb", 0.0) - 24.0) < 0.5, "normalize_clip clamps gain to +24 dB");

            // Silent clip (freq 0 -> an all-zero tone): a clear error, not a silent no-op or crash.
            auto silentCid = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", et }, { "seconds", 0.2 }, { "freq", 0.0 }}))["data"].getProperty ("clipId", var()).toString();
            check (! ok (cmd (ops, "normalize_clip", args1 ("clipId", silentCid))), "normalize_clip on a silent clip errors gracefully");

            // Type rejection: MIDI clips have no source audio to scan.
            auto midiNormCid = cmd (ops, "add_midi_clip", objN ({{ "trackId", et }, { "length", 1.0 }}))["data"].getProperty ("clipId", var()).toString();
            check (! ok (cmd (ops, "normalize_clip", args1 ("clipId", midiNormCid))), "normalize_clip on a MIDI clip rejected");

            cmd (ops, "remove_clip", args1 ("clipId", nCid));
            cmd (ops, "remove_clip", args1 ("clipId", silentCid));
            cmd (ops, "remove_clip", args1 ("clipId", midiNormCid));
        }

        // normalize_clip: AUDIBLE-SPAN correctness (clipAudibleSourceSpan), not the
        // whole source file. A clip trimmed to a quiet segment of a longer take must
        // normalize against the peak that actually PLAYS, not a transient elsewhere in
        // the take that never sounds. Source WAV layout (2.5s @44.1kHz, 440Hz sine):
        // [0.0,0.5) LOUD (peak 0.9, ~-0.92 dBFS), [0.5,1.0) EXACT SILENCE,
        // [1.0,2.5) QUIET (peak 0.1, ~-20 dBFS). The core assertion below FAILS against
        // the old whole-file findSourcePeak behavior: the old code always measured the
        // loud segment's ~-0.92 dBFS peak regardless of where the clip is trimmed to,
        // landing gain around +0.9 dB even when trimmed well clear of it into the quiet
        // region — a ~19 dB silent under-normalization a producer would only catch by ear.
        {
            auto makeSpanWav = [&] () -> juce::File
            {
                const double sr = 44100.0;
                const juce::int64 n = (juce::int64) (sr * 2.5);   // 2.5s total
                juce::AudioBuffer<float> buf (1, (int) n);
                buf.clear();
                const juce::int64 loudEnd    = (juce::int64) (0.5 * sr);   // [0, loudEnd)    -> loud (0.9)
                const juce::int64 quietStart = (juce::int64) (1.0 * sr);   // [quietStart, n) -> quiet (0.1)
                                                                            // [loudEnd, quietStart) stays exact silence.
                const double inc = juce::MathConstants<double>::twoPi * 440.0 / sr;
                double phase = 0.0;
                for (juce::int64 i = 0; i < loudEnd; ++i, phase += inc)
                    buf.setSample (0, (int) i, (float) (std::sin (phase) * 0.9));
                for (juce::int64 i = quietStart; i < n; ++i, phase += inc)
                    buf.setSample (0, (int) i, (float) (std::sin (phase) * 0.1));

                auto dir = eng.sessionDir().getChildFile ("normalize-span-test");
                dir.createDirectory();
                auto f = dir.getChildFile ("loud-silent-quiet.wav");
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
            auto spanFile = makeSpanWav();
            check (spanFile.existsAsFile(), "normalize span-test WAV synthesized (loud/silent/quiet)");

            auto spanImp = cmd (ops, "import_clip", objN ({{ "trackId", et }, { "file", spanFile.getFullPathName() }}));
            check (ok (spanImp), "normalize span-test clip imported");
            const auto spanCid = spanImp["data"].getProperty ("clipId", var()).toString();

            // Baseline: UNTRIMMED (offset 0, full 2.5s source) — the audible span IS the
            // whole file here, so this must still find the LOUD peak (~-0.92 dBFS).
            // Proves the fix is behavior-preserving for the common untrimmed case.
            auto spanBase = cmd (ops, "normalize_clip", args1 ("clipId", spanCid));
            check (ok (spanBase), "normalize_clip (untrimmed) ok");
            check (std::abs ((double) spanBase["data"].getProperty ("peakDb", 0.0) - (-0.92)) < 0.5,
                   "untrimmed clip normalizes against the LOUD segment (whole file == audible span)");

            // Trim into [1.0s, 2.0s) — entirely inside the QUIET region, clear of both the
            // loud segment and the silent gap. This is the core fix assertion.
            check (ok (cmd (ops, "trim_clip", objN ({{ "clipId", spanCid }, { "offset", 1.0 }, { "length", 1.0 }}))),
                   "trim_clip into the quiet region ok");
            auto spanQuiet = cmd (ops, "normalize_clip", args1 ("clipId", spanCid));
            check (ok (spanQuiet), "normalize_clip (trimmed to quiet region) ok");
            check (std::abs ((double) spanQuiet["data"].getProperty ("peakDb", 0.0) - (-20.0)) < 0.5,
                   "trimmed clip measures the QUIET region's ~-20 dBFS peak, not the loud transient outside its "
                   "span (FAILS against the old whole-file scan, which would report ~-0.92 dBFS here)");
            check (std::abs ((double) clipById (spanCid).getProperty ("gainDb", 0.0) - 20.0) < 0.5,
                   "trimmed clip's normalize gain targets the audible (quiet) peak, ~+20 dB — not ~+0.9 dB");

            // Trim to the EXACT-SILENCE gap [0.5s, 1.0s) — the audible SPAN is silent even
            // though the source file as a whole isn't. Still the existing clean "silent"
            // error — and now span-accurate (the old whole-file code would NOT have
            // errored here, since it always saw the loud segment elsewhere in the file).
            check (ok (cmd (ops, "trim_clip", objN ({{ "clipId", spanCid }, { "offset", 0.5 }, { "length", 0.5 }}))),
                   "trim_clip into the silent gap ok");
            check (! ok (cmd (ops, "normalize_clip", args1 ("clipId", spanCid))),
                   "normalize_clip on a clip trimmed to a silent SPAN errors cleanly, even though the source file "
                   "isn't silent elsewhere");

            // EOF handling: a length running past the end of the source clamps gracefully
            // (no crash, no out-of-range read) and measures only the clamped, in-range
            // remainder (here: [2.3s, 2.5s), still inside the quiet region).
            check (ok (cmd (ops, "trim_clip", objN ({{ "clipId", spanCid }, { "offset", 2.3 }, { "length", 5.0 }}))),
                   "trim_clip with length past EOF ok (accepted, not rejected)");
            auto spanEof = cmd (ops, "normalize_clip", args1 ("clipId", spanCid));
            check (ok (spanEof), "normalize_clip with a length-past-EOF span still succeeds (clamped)");
            check (std::abs ((double) spanEof["data"].getProperty ("peakDb", 0.0) - (-20.0)) < 0.5,
                   "length-past-EOF span still measures the quiet region's peak from its clamped remainder");

            // Offset entirely beyond EOF: the clamped audible range is empty -> the
            // existing clean "silent" error, not a crash or an out-of-range read.
            check (ok (cmd (ops, "trim_clip", objN ({{ "clipId", spanCid }, { "offset", 10.0 }, { "length", 1.0 }}))),
                   "trim_clip with offset beyond EOF ok (accepted, not rejected)");
            check (! ok (cmd (ops, "normalize_clip", args1 ("clipId", spanCid))),
                   "normalize_clip with offset entirely beyond EOF errors cleanly, not a crash");

            cmd (ops, "remove_clip", args1 ("clipId", spanCid));
        }

        const int before = trackById (et).getProperty ("clips", var()).size();
        auto dup = cmd (ops, "duplicate_clip", args1 ("clipId", cid));
        check (ok (dup), "duplicate_clip ok");
        check (trackById (et).getProperty ("clips", var()).size() == before + 1, "duplicate adds a clip to the track");
        const auto newId = dup["data"].getProperty ("newClipId", var()).toString();
        check ((double) clipById (newId).getProperty ("start", 0.0) > 0.5, "duplicate lands after the original");
        // duplicate is undoable (was uncovered): undo drops the copy, redo restores it.
        check (ok (cmd (ops, "undo")), "undo duplicate_clip ok");
        check (trackById (et).getProperty ("clips", var()).size() == before, "undo removes the duplicated clip");
        check (ok (cmd (ops, "redo")), "redo duplicate_clip ok");
        check (trackById (et).getProperty ("clips", var()).size() == before + 1, "redo restores the duplicated clip");

        check (ok (cmd (ops, "remove_clip", args1 ("clipId", cid))), "remove_clip ok");
        check (! clipById (cid).isObject(), "remove_clip deletes the clip");
    }
}

} // namespace mosh
