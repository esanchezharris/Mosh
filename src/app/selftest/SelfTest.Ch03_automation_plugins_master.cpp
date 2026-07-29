// ── SelfTest.Ch03_automation_plugins_master.cpp — runSelfTest chapter 3 (RFC 002 A-PR5) ──────
// Sections moved VERBATIM by prefix-motion from src/app/SelfTest.cpp
// (pre-split lines 1094-1922), in exact pre-split order:
//   . "Wave 7: parameter automation"
//   . "G10: parameter automation recording"
//   . "G10: set_plugin_param undo regression (G14-class)"
//   . "ADVERSARIAL-REVIEW: SetPluginParamValueAction UAF ..."
//   . "Wave 1: built-in plugin palette"
//   . "PLG reorder: plugin chain ordering (reorder_plugin)"
//   . "Master bus plugins (load/remove/reorder/bypass/param, undo)"
//   . "Master bus: internal plugin (spectral tap) visible-index boundary"
//   . "MON-004: PDC / reported-latency readout"
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

void runChapter03_automation_plugins_master (selftest::SelfTestCtx& ctx)
{
    using namespace juce;
    auto& eng = *ctx.eng;
    auto& ops = *ctx.ops;
    auto& trackById = ctx.trackById;

    // ─── Wave 7: parameter automation ───
    section ("Wave 7: parameter automation");
    {
        auto paramVar = [&] (const String& trkId, int plugIdx, int paramIdx) -> var {
            auto trk = trackById (trkId);
            if (auto* plugins = trk.getProperty ("plugins", var()).getArray())
                for (auto& p : *plugins)
                    if ((int) p.getProperty ("index", -1) == plugIdx)
                        if (auto* params = p.getProperty ("params", var()).getArray())
                            for (auto& pr : *params)
                                if ((int) pr.getProperty ("index", -1) == paramIdx) return pr;
            return {};
        };

        auto at = cmd (ops, "create_track", args1 ("name", "Auto"))["data"].getProperty ("trackId", var()).toString();
        cmd (ops, "load_builtin", objN ({{ "trackId", at }, { "type", "compressor" }}));
        int pidx = -1;
        { auto trk = trackById (at);
          if (auto* plugins = trk.getProperty ("plugins", var()).getArray())
            for (auto& p : *plugins) if (p.getProperty ("type", var()).toString() == "compressor") pidx = (int) p.getProperty ("index", -1); }
        check (pidx >= 0, "compressor loaded for automation");

        check (ok (cmd (ops, "add_automation_point", objN ({{ "trackId", at }, { "pluginIndex", pidx }, { "paramIndex", 0 }, { "time", 0.0 }, { "value", 0.2 }}))), "add_automation_point ok");
        check (ok (cmd (ops, "add_automation_point", objN ({{ "trackId", at }, { "pluginIndex", pidx }, { "paramIndex", 0 }, { "time", 2.0 }, { "value", 0.8 }}))), "second automation point ok");
        check (paramVar (at, pidx, 0).getProperty ("points", var()).size() == 2, "snapshot serialises 2 automation points");
        check ((bool) paramVar (at, pidx, 0).getProperty ("automated", false), "param flagged automated");
        { auto pts = paramVar (at, pidx, 0).getProperty ("points", var());
          check (pts.size() == 2 && std::abs ((double) pts[0].getProperty ("v", 0.0) - 0.2) < 0.03
                 && std::abs ((double) pts[1].getProperty ("v", 0.0) - 0.8) < 0.03, "automation point values round-trip 0..1"); }

        check (ok (cmd (ops, "set_automation_point", objN ({{ "trackId", at }, { "pluginIndex", pidx }, { "paramIndex", 0 }, { "pointIndex", 0 }, { "time", 0.5 }, { "value", 0.5 }}))), "set_automation_point ok");
        check (ok (cmd (ops, "remove_automation_point", objN ({{ "trackId", at }, { "pluginIndex", pidx }, { "paramIndex", 0 }, { "pointIndex", 0 }}))), "remove_automation_point ok");
        check (paramVar (at, pidx, 0).getProperty ("points", var()).size() == 1, "remove drops an automation point");

        check (ok (cmd (ops, "clear_automation", objN ({{ "trackId", at }, { "pluginIndex", pidx }, { "paramIndex", 0 }}))), "clear_automation ok");
        check (! (bool) paramVar (at, pidx, 0).getProperty ("automated", true), "clear_automation removes all points");
    }

    // ─── G10: parameter automation RECORDING (v0) ───
    // docs/superpowers/specs/2026-07-17-g10-automation-record.md — synchronous capture
    // (gated on automationMode==write, NOT transport.isPlaying()) inside cmdSetPluginParam;
    // set_track_automation_mode arms/disarms all 4 values but only write is behavioral;
    // write_automation_curve bulk-authors a curve in one undoable step.
    section ("G10: parameter automation recording");
    {
        auto paramVarG10 = [&] (const String& trkId, int plugIdx, int paramIdx) -> var {
            auto trk = trackById (trkId);
            if (auto* plugins = trk.getProperty ("plugins", var()).getArray())
                for (auto& p : *plugins)
                    if ((int) p.getProperty ("index", -1) == plugIdx)
                        if (auto* params = p.getProperty ("params", var()).getArray())
                            for (auto& pr : *params)
                                if ((int) pr.getProperty ("index", -1) == paramIdx) return pr;
            return {};
        };

        auto gt = cmd (ops, "create_track", args1 ("name", "AutoRec"))["data"].getProperty ("trackId", var()).toString();
        cmd (ops, "load_builtin", objN ({{ "trackId", gt }, { "type", "compressor" }}));
        int gpidx = -1;
        { auto trk = trackById (gt);
          if (auto* plugins = trk.getProperty ("plugins", var()).getArray())
            for (auto& p : *plugins) if (p.getProperty ("type", var()).toString() == "compressor") gpidx = (int) p.getProperty ("index", -1); }
        check (gpidx >= 0, "G10: compressor loaded for recording test");

        // ── set_track_automation_mode: default, round-trip, validation, undo/redo ──
        check (trackById (gt).getProperty ("automationMode", "?").toString() == "read", "G10: fresh track defaults automationMode=read");
        check (ok (cmd (ops, "set_track_automation_mode", objN ({{ "trackId", gt }, { "mode", "write" }}))), "G10: set_track_automation_mode write ok");
        check (trackById (gt).getProperty ("automationMode", "?").toString() == "write", "G10: automationMode reflects write");
        check (! ok (cmd (ops, "set_track_automation_mode", objN ({{ "trackId", gt }, { "mode", "bogus" }}))), "G10: rejects an unknown mode");
        check (trackById (gt).getProperty ("automationMode", "?").toString() == "write", "G10: a rejected mode leaves the track unchanged");
        check (ok (cmd (ops, "undo")), "G10: undo set_track_automation_mode ok");
        check (trackById (gt).getProperty ("automationMode", "?").toString() == "read", "G10: undo reverts automationMode to read (CachedValue undo, no custom action needed)");
        check (ok (cmd (ops, "redo")), "G10: redo set_track_automation_mode ok");
        check (trackById (gt).getProperty ("automationMode", "?").toString() == "write", "G10: redo restores automationMode to write");

        // ── write mode captures a point at the transport position; ONE undo reverts value+point together ──
        cmd (ops, "set_transport", args1 ("position", 3.0));
        const double v0 = (double) paramVarG10 (gt, gpidx, 0).getProperty ("value", -1.0);
        check (ok (cmd (ops, "set_plugin_param", objN ({{ "trackId", gt }, { "index", gpidx }, { "paramIndex", 0 }, { "value", 0.75 }}))),
               "G10: set_plugin_param under write mode ok");
        check (std::abs ((double) paramVarG10 (gt, gpidx, 0).getProperty ("value", -1.0) - 0.75) < 0.02, "G10: value reflects the set_plugin_param call");
        check ((bool) paramVarG10 (gt, gpidx, 0).getProperty ("automated", false), "G10: write mode captured a point (param flagged automated)");
        { auto pts = paramVarG10 (gt, gpidx, 0).getProperty ("points", var());
          check (pts.size() == 1, "G10: exactly one point captured");
          check (pts.size() == 1 && std::abs ((double) pts[0].getProperty ("t", -1.0) - 3.0) < 0.05, "G10: captured point lands at the transport position");
          check (pts.size() == 1 && std::abs ((double) pts[0].getProperty ("v", -1.0) - 0.75) < 0.02, "G10: captured point value matches the set value"); }
        check (ok (cmd (ops, "undo")), "G10: undo set_plugin_param (write mode) ok");
        check (paramVarG10 (gt, gpidx, 0).getProperty ("points", var()).size() == 0, "G10: one undo removes the captured point");
        check (std::abs ((double) paramVarG10 (gt, gpidx, 0).getProperty ("value", -1.0) - v0) < 0.02,
               "G10: the SAME undo reverts the value too (bug-fix regression: not stale at the pre-undo value)");
        check (ok (cmd (ops, "redo")), "G10: redo set_plugin_param (write mode) ok");
        check (paramVarG10 (gt, gpidx, 0).getProperty ("points", var()).size() == 1, "G10: redo restores the captured point");
        check (std::abs ((double) paramVarG10 (gt, gpidx, 0).getProperty ("value", -1.0) - 0.75) < 0.02, "G10: redo restores the value");

        cmd (ops, "clear_automation", objN ({{ "trackId", gt }, { "pluginIndex", gpidx }, { "paramIndex", 0 }}));

        // ── read mode does NOT capture ──
        cmd (ops, "set_track_automation_mode", objN ({{ "trackId", gt }, { "mode", "read" }}));
        cmd (ops, "set_plugin_param", objN ({{ "trackId", gt }, { "index", gpidx }, { "paramIndex", 0 }, { "value", 0.4 }}));
        check (! (bool) paramVarG10 (gt, gpidx, 0).getProperty ("automated", true), "G10: read mode does not capture a point");

        // ── touch/latch are ACCEPTED (round-trip losslessly) but INERT in v0 — Phase 2 ──
        cmd (ops, "set_track_automation_mode", objN ({{ "trackId", gt }, { "mode", "touch" }}));
        check (trackById (gt).getProperty ("automationMode", "?").toString() == "touch", "G10: touch mode stored");
        cmd (ops, "set_plugin_param", objN ({{ "trackId", gt }, { "index", gpidx }, { "paramIndex", 0 }, { "value", 0.6 }}));
        check (! (bool) paramVarG10 (gt, gpidx, 0).getProperty ("automated", true), "G10 AUTO-MODE-INERT: touch mode does not capture in v0");

        cmd (ops, "set_track_automation_mode", objN ({{ "trackId", gt }, { "mode", "latch" }}));
        check (trackById (gt).getProperty ("automationMode", "?").toString() == "latch", "G10: latch mode stored");
        cmd (ops, "set_plugin_param", objN ({{ "trackId", gt }, { "index", gpidx }, { "paramIndex", 0 }, { "value", 0.3 }}));
        check (! (bool) paramVarG10 (gt, gpidx, 0).getProperty ("automated", true), "G10 AUTO-MODE-INERT: latch mode does not capture in v0");

        // ── write_automation_curve: validate-before-mutate, replace, reject, merge, undo, JSON-string form ──
        cmd (ops, "set_track_automation_mode", objN ({{ "trackId", gt }, { "mode", "read" }}));   // don't let write-mode capture interfere below
        cmd (ops, "clear_automation", objN ({{ "trackId", gt }, { "pluginIndex", gpidx }, { "paramIndex", 0 }}));

        var replacePoints; { Array<var> a; a.add (objN ({{ "t", 0.0 }, { "v", 0.1 }}));
                              a.add (objN ({{ "t", 1.0 }, { "v", 0.5 }}));
                              a.add (objN ({{ "t", 2.0 }, { "v", 0.9 }})); replacePoints = a; }
        auto wr = cmd (ops, "write_automation_curve", objN ({{ "trackId", gt }, { "pluginIndex", gpidx }, { "paramIndex", 0 },
                                                              { "points", replacePoints }, { "apply", "replace" }}));
        check (ok (wr), "G10: write_automation_curve replace ok");
        check ((int) wr["data"].getProperty ("pointCount", -1) == 3, "G10: replace reports 3 points written");
        check (paramVarG10 (gt, gpidx, 0).getProperty ("points", var()).size() == 3, "G10: curve now has exactly the 3 replaced points");

        // reject: non-ascending t -> the WHOLE call is rejected, curve UNCHANGED (validate-before-mutate)
        var badPoints; { Array<var> a; a.add (objN ({{ "t", 1.0 }, { "v", 0.2 }}));
                          a.add (objN ({{ "t", 0.5 }, { "v", 0.4 }})); badPoints = a; }
        check (! ok (cmd (ops, "write_automation_curve", objN ({{ "trackId", gt }, { "pluginIndex", gpidx }, { "paramIndex", 0 },
                                                                { "points", badPoints }, { "apply", "replace" }}))),
               "G10: rejects non-ascending t");
        check (paramVarG10 (gt, gpidx, 0).getProperty ("points", var()).size() == 3, "G10: a rejected call leaves the curve untouched");

        // reject: v out of range
        var badV; { Array<var> a; a.add (objN ({{ "t", 5.0 }, { "v", 1.5 }})); badV = a; }
        check (! ok (cmd (ops, "write_automation_curve", objN ({{ "trackId", gt }, { "pluginIndex", gpidx }, { "paramIndex", 0 },
                                                                { "points", badV }, { "apply", "replace" }}))),
               "G10: rejects v outside 0..1");

        // merge: adds without clearing the existing 3
        var mergePoints; { Array<var> a; a.add (objN ({{ "t", 5.0 }, { "v", 0.3 }})); mergePoints = a; }
        auto wm = cmd (ops, "write_automation_curve", objN ({{ "trackId", gt }, { "pluginIndex", gpidx }, { "paramIndex", 0 },
                                                              { "points", mergePoints }, { "apply", "merge" }}));
        check (ok (wm), "G10: write_automation_curve merge ok");
        check (paramVarG10 (gt, gpidx, 0).getProperty ("points", var()).size() == 4, "G10: merge adds without clearing the existing 3 points");

        // one undo reverts the WHOLE bulk write (all points added in one beginTxn)
        check (ok (cmd (ops, "undo")), "G10: undo write_automation_curve (merge) ok");
        check (paramVarG10 (gt, gpidx, 0).getProperty ("points", var()).size() == 3, "G10: undo drops the whole merged batch in one step");

        // the agent-catalog form: points as a JSON-encoded string (ArgType has no array type)
        check (ok (cmd (ops, "write_automation_curve", objN ({{ "trackId", gt }, { "pluginIndex", gpidx }, { "paramIndex", 0 },
                        { "points", String ("[{\"t\":9.0,\"v\":0.2}]") }, { "apply", "merge" }}))),
               "G10: write_automation_curve accepts a JSON-string points array");
        check (paramVarG10 (gt, gpidx, 0).getProperty ("points", var()).size() == 4, "G10: JSON-string points landed");
    }

    // ─── G10 bug fix: cmdSetPluginParam undo correctness (G14-class regression) ───
    section ("G10: set_plugin_param undo regression (G14-class)");
    {
        auto paramValueG10b = [&] (const String& trkId, int plugIdx, int paramIdx) -> double {
            auto trk = trackById (trkId);
            if (auto* plugins = trk.getProperty ("plugins", var()).getArray())
                for (auto& p : *plugins)
                    if ((int) p.getProperty ("index", -1) == plugIdx)
                        if (auto* params = p.getProperty ("params", var()).getArray())
                            for (auto& pr : *params)
                                if ((int) pr.getProperty ("index", -1) == paramIdx) return (double) pr.getProperty ("value", -1.0);
            return -1.0;
        };

        auto puTrack = cmd (ops, "create_track", args1 ("name", "ParamUndo"))["data"].getProperty ("trackId", var()).toString();
        cmd (ops, "load_builtin", objN ({{ "trackId", puTrack }, { "type", "compressor" }}));
        int rpidx = -1;
        { auto trk = trackById (puTrack);
          if (auto* plugins = trk.getProperty ("plugins", var()).getArray())
            for (auto& p : *plugins) if (p.getProperty ("type", var()).toString() == "compressor") rpidx = (int) p.getProperty ("index", -1); }
        check (rpidx >= 0, "G10 regression: compressor loaded");

        const double before = paramValueG10b (puTrack, rpidx, 0);
        check (ok (cmd (ops, "set_plugin_param", objN ({{ "trackId", puTrack }, { "index", rpidx }, { "paramIndex", 0 }, { "value", 0.95 }}))),
               "G10 regression: set_plugin_param ok");
        check (std::abs (paramValueG10b (puTrack, rpidx, 0) - 0.95) < 0.02, "G10 regression: value reflects the set");
        check (ok (cmd (ops, "undo")), "G10 regression: undo ok");
        // The exact G14-class assertion: pre-fix, AutomatableParameter::currentValue (and so
        // getCurrentNormalisedValue(), what the snapshot's params[].value reads) stayed stale
        // at the post-set value even though the persisted ValueTree property correctly reverted.
        check (std::abs (paramValueG10b (puTrack, rpidx, 0) - before) < 0.02,
               "G10 regression: undo restores the LIVE param value (not stale at the pre-undo value)");
        check (ok (cmd (ops, "redo")), "G10 regression: redo ok");
        check (std::abs (paramValueG10b (puTrack, rpidx, 0) - 0.95) < 0.02, "G10 regression: redo restores the set value");
    }

    // ─── ADVERSARIAL-REVIEW FIX: SetPluginParamValueAction use-after-free (blocking) ───
    // Repro found in review: set_plugin_param pushed a SetPluginParamValueAction holding a raw
    // te::AutomatableParameter& captured at construction. remove_plugin detaches the plugin
    // (plugin->deleteFromParent()); te::PluginCache purges the underlying C++
    // Plugin/AutomatableParameter object via its own 1s JUCE::Timer once the cache is its last
    // owner (refcount hits 1) — pumped for real below via runDispatchLoopUntil, so this test
    // forces the ACTUAL purge headlessly rather than relying on same-address reuse masking the
    // bug. undo (of remove_plugin) then re-adds the plugin as a BRAND-NEW C++ object at a new
    // address (PluginList's ValueTreeObjectList rebuilds via getOrCreatePluginFor), restored
    // from the same ValueTree node -> same te::EditItemID. A second undo (of the original
    // set_plugin_param) invokes the now-STALE action's undo(): pre-fix this dereferenced the
    // freed original AutomatableParameter& (undefined behavior / crash). Post-fix the action
    // re-resolves the parameter fresh, by (pluginItemId,paramIndex) via the Edit's PluginCache,
    // on every perform()/undo() call — so the WHOLE sequence below must complete without
    // crashing, and must land the correct value on the RE-CREATED plugin object.
    section ("ADVERSARIAL-REVIEW: SetPluginParamValueAction UAF across remove_plugin+undo");
    {
        auto paramValueUAF = [&] (const String& trkId, int plugIdx, int paramIdx) -> double {
            auto trk = trackById (trkId);
            if (auto* plugins = trk.getProperty ("plugins", var()).getArray())
                for (auto& p : *plugins)
                    if ((int) p.getProperty ("index", -1) == plugIdx)
                        if (auto* params = p.getProperty ("params", var()).getArray())
                            for (auto& pr : *params)
                                if ((int) pr.getProperty ("index", -1) == paramIdx) return (double) pr.getProperty ("value", -1.0);
            return -1.0;
        };
        auto hasPluginAt = [&] (const String& trkId, int plugIdx) -> bool {
            auto trk = trackById (trkId);
            if (auto* plugins = trk.getProperty ("plugins", var()).getArray())
                for (auto& p : *plugins)
                    if ((int) p.getProperty ("index", -1) == plugIdx) return true;
            return false;
        };

        auto uafTrack = cmd (ops, "create_track", args1 ("name", "ParamUAF"))["data"].getProperty ("trackId", var()).toString();
        cmd (ops, "load_builtin", objN ({{ "trackId", uafTrack }, { "type", "compressor" }}));
        int uafIdx = -1;
        { auto trk = trackById (uafTrack);
          if (auto* plugins = trk.getProperty ("plugins", var()).getArray())
            for (auto& p : *plugins) if (p.getProperty ("type", var()).toString() == "compressor") uafIdx = (int) p.getProperty ("index", -1); }
        check (uafIdx >= 0, "UAF regression: compressor loaded");

        const double uafBefore = paramValueUAF (uafTrack, uafIdx, 0);

        // T1: set_plugin_param — pushes the SetPluginParamValueAction under test.
        check (ok (cmd (ops, "set_plugin_param", objN ({{ "trackId", uafTrack }, { "index", uafIdx }, { "paramIndex", 0 }, { "value", 0.85 }}))),
               "UAF regression: set_plugin_param ok");
        check (std::abs (paramValueUAF (uafTrack, uafIdx, 0) - 0.85) < 0.02, "UAF regression: value reflects the set");

        // T2: remove_plugin — detaches the plugin the T1 action's original param lived on.
        check (ok (cmd (ops, "remove_plugin", objN ({{ "trackId", uafTrack }, { "index", uafIdx }}))),
               "UAF regression: remove_plugin ok");
        check (! hasPluginAt (uafTrack, uafIdx), "UAF regression: plugin gone after remove");

        // Force the REAL te::PluginCache 1s purge timer to fire (pump the message loop past
        // 1000ms in 50ms slices — mirrors the pump() idiom used elsewhere in this file for
        // async waits) so the original Plugin/AutomatableParameter C++ objects are actually
        // destroyed, not just detached — otherwise the repro is inert (same-address reuse would
        // mask the bug even pre-fix).
        {
            auto* uafMm = juce::MessageManager::getInstanceWithoutCreating();
            const auto uafPumpEnd = juce::Time::getMillisecondCounter() + (juce::uint32) 1300;
            while (juce::Time::getMillisecondCounter() < uafPumpEnd)
            {
                if (uafMm != nullptr) uafMm->runDispatchLoopUntil (50);
                else juce::Thread::sleep (50);
            }
        }

        // Undo #1 reverts T2 (remove_plugin): Tracktion's built-in ValueTree undo restores the
        // removed node — same te::EditItemID, but (since the cache purged the original) a NEW
        // C++ Plugin object gets instantiated for it.
        check (ok (cmd (ops, "undo")), "UAF regression: undo #1 (revert remove_plugin) ok, no crash");
        check (hasPluginAt (uafTrack, uafIdx), "UAF regression: plugin restored after undo #1");
        check (std::abs (paramValueUAF (uafTrack, uafIdx, 0) - 0.85) < 0.05,
               "UAF regression: restored plugin's param reflects the value it had when removed");

        // Undo #2 reverts T1 (set_plugin_param) — the STALE action. Pre-fix its raw
        // AutomatableParameter& pointed at the now-freed original object; post-fix it
        // re-resolves by (pluginItemId,paramIndex) against the (new) live plugin instead.
        // Reaching + passing the assertions below is itself part of the proof (a UAF here is
        // undefined behavior, not a silently-wrong-but-safe result).
        check (ok (cmd (ops, "undo")), "UAF regression: undo #2 (revert set_plugin_param on the RE-CREATED plugin) ok, no crash");
        check (hasPluginAt (uafTrack, uafIdx), "UAF regression: plugin still present after undo #2");
        check (std::abs (paramValueUAF (uafTrack, uafIdx, 0) - uafBefore) < 0.05,
               "UAF regression: undo #2 correctly restores the pre-set value on the RE-CREATED plugin object (not a crash, not a silent no-op)");

        // Redo both, proving the re-resolving perform()/undo() path works in both directions
        // post-purge, not just undo().
        check (ok (cmd (ops, "redo")), "UAF regression: redo #1 (re-apply set_plugin_param) ok");
        check (std::abs (paramValueUAF (uafTrack, uafIdx, 0) - 0.85) < 0.05, "UAF regression: redo #1 restores the set value");
        check (ok (cmd (ops, "redo")), "UAF regression: redo #2 (re-apply remove_plugin) ok");
        check (! hasPluginAt (uafTrack, uafIdx), "UAF regression: redo #2 removes the plugin again");
    }

    // ─── Wave 1: engine built-in plugin palette (effects + instruments) ───
    section ("Wave 1: built-in plugin palette");
    {
        auto builtinIndex = [&] (const var& track, const char* type) -> int {
            if (auto* arr = track.getProperty ("plugins", var()).getArray())
                for (auto& p : *arr)
                    if (p.getProperty ("type", var()).toString() == type) return (int) p.getProperty ("index", -1);
            return -1;
        };

        auto lb = cmd (ops, "list_builtins");
        check (ok (lb), "list_builtins ok");
        const int nB = lb["data"].getProperty ("plugins", var()).size();
        check (nB >= 13, "built-in palette has the full catalog plus Mosh FX");
        bool sawComp = false, sawSynth = false, sawAutoTune = false, sawOTT = false, sawXFeedback = false;
        if (auto* arr = lb["data"].getProperty ("plugins", var()).getArray())
            for (auto& p : *arr)
            {
                if (p.getProperty ("type", var()).toString() == "compressor") sawComp = true;
                if (p.getProperty ("type", var()).toString() == "4osc"
                    && (bool) p.getProperty ("isInstrument", false)) sawSynth = true;
                if (p.getProperty ("type", var()).toString() == "moshAutoTune") sawAutoTune = true;
                if (p.getProperty ("type", var()).toString() == "moshOTT") sawOTT = true;
                if (p.getProperty ("type", var()).toString() == "moshXFeedback") sawXFeedback = true;
            }
        check (sawComp, "catalog includes compressor (effect)");
        check (sawSynth, "catalog includes 4osc (instrument)");
        check (sawAutoTune, "catalog includes Mosh AutoTune");
        check (sawOTT, "catalog includes Mosh OTT");
        check (sawXFeedback, "catalog includes Mosh X-FDBK");

        auto bt = cmd (ops, "create_track", args1 ("name", "Built-ins"))["data"].getProperty ("trackId", var()).toString();

        // Effect: a built-in compressor lands in the chain, flagged + categorised.
        check (ok (cmd (ops, "load_builtin", objN ({{ "trackId", bt }, { "type", "compressor" }}))), "load_builtin (compressor) ok");
        int cidx = builtinIndex (trackById (bt), "compressor");
        check (cidx >= 0, "compressor appears in the chain");
        bool compFlagged = false, compCategorised = false;
        { auto trk = trackById (bt);
          if (auto* arr = trk.getProperty ("plugins", var()).getArray())
            for (auto& p : *arr) if ((int) p.getProperty ("index", -1) == cidx)
            { compFlagged = (bool) p.getProperty ("builtin", false);
              compCategorised = p.getProperty ("category", var()).toString() == "Dynamics"; } }
        check (compFlagged, "built-in plugin flagged builtin=true in snapshot");
        check (compCategorised, "built-in plugin carries its category");
        if (cidx >= 0)
            check (ok (cmd (ops, "set_plugin_param", objN ({{ "trackId", bt }, { "index", cidx }, { "paramIndex", 0 }, { "value", 0.5 }}))),
                   "set_plugin_param on a built-in ok");

        // Instrument: a built-in synth on the same track is flagged isInstrument.
        check (ok (cmd (ops, "load_builtin", objN ({{ "trackId", bt }, { "type", "4osc" }}))), "load_builtin (4osc synth) ok");
        bool hasBuiltinInst = false;
        { auto trk = trackById (bt);
          if (auto* arr = trk.getProperty ("plugins", var()).getArray())
            for (auto& p : *arr) if (p.getProperty ("type", var()).toString() == "4osc")
                hasBuiltinInst = (bool) p.getProperty ("isInstrument", false); }
        check (hasBuiltinInst, "built-in 4osc flagged as an instrument");

        const char* moshFxTypes[] = { "moshAutoTune", "moshOTT", "moshXFeedback" };
        for (auto* type : moshFxTypes)
        {
            const String typeId (type);
            check (ok (cmd (ops, "load_builtin", objN ({{ "trackId", bt }, { "type", type }}))), String ("load_builtin (") + typeId + ") ok");
            const int midx = builtinIndex (trackById (bt), type);
            check (midx >= 0, typeId + " appears in the chain");
            bool hasMoshCategory = false, hasParams = false, hasReadout = false;
            { auto trk = trackById (bt);
              if (auto* arr = trk.getProperty ("plugins", var()).getArray())
                for (auto& p : *arr) if ((int) p.getProperty ("index", -1) == midx)
                {
                    hasMoshCategory = p.getProperty ("category", var()).toString() == "Mosh FX";
                    hasParams = p.getProperty ("params", var()).size() >= 6;
                    auto mfx = p.getProperty ("moshFx", var());
                    if (typeId == "moshAutoTune")
                        hasReadout = mfx.getProperty ("kind", var()).toString() == "autotune"
                                     && mfx.hasProperty ("inputHz")
                                     && mfx.hasProperty ("targetHz")
                                     && mfx.hasProperty ("correctionCents")
                                     && mfx.hasProperty ("confidence");
                    else if (typeId == "moshOTT")
                        hasReadout = mfx.getProperty ("kind", var()).toString() == "ott"
                                     && mfx.hasProperty ("amount")
                                     && mfx.hasProperty ("timeMs");
                    else if (typeId == "moshXFeedback")
                        hasReadout = mfx.getProperty ("kind", var()).toString() == "feedback"
                                     && mfx.hasProperty ("candidates")
                                     && mfx.hasProperty ("activeCuts");
                } }
            check (hasMoshCategory, typeId + " carries Mosh FX category");
            check (hasParams, typeId + " exposes generic rack params");
            check (hasReadout, typeId + " exposes additive moshFx readout");
            if (midx >= 0)
                check (ok (cmd (ops, "set_plugin_param", objN ({{ "trackId", bt }, { "index", midx }, { "paramIndex", 0 }, { "value", 0.55 }}))),
                       String ("set_plugin_param on ") + typeId + " ok");
        }

        auto xfTrack = cmd (ops, "create_track", args1 ("name", "X-FDBK Readout"))["data"].getProperty ("trackId", var()).toString();
        check (ok (cmd (ops, "add_test_tone_clip", objN ({{ "trackId", xfTrack }, { "seconds", 1.0 }, { "freq", 2600.0 }}))),
               "X-FDBK readout tone created");
        auto xfLoad = cmd (ops, "load_builtin", objN ({{ "trackId", xfTrack }, { "type", "moshXFeedback" }}));
        const int xfIdx = (int) xfLoad["data"].getProperty ("index", -1);
        check (ok (xfLoad), "X-FDBK readout plugin loaded");
        check (ok (cmd (ops, "set_plugin_param", objN ({{ "trackId", xfTrack }, { "index", xfIdx }, { "paramIndex", 0 }, { "value", 0.85 }}))),
               "X-FDBK readout sensitivity set");
        check (ok (cmd (ops, "set_plugin_param", objN ({{ "trackId", xfTrack }, { "index", xfIdx }, { "paramIndex", 4 }, { "value", 1.0 }}))),
               "X-FDBK readout auto-suppress enabled");
        auto xfOut = selftestTempPath (eng, "xfeedback-readout.wav");
        xfOut.deleteFile();
        check (ok (cmd (ops, "export_audio", objN ({{ "file", xfOut.getFullPathName() }, { "format", "wav" }, { "bitDepth", 24 }}))),
               "X-FDBK readout export ok");
        bool activeCutHasScore = false, activeCutHasDepth = false;
        { auto trk = trackById (xfTrack);
          if (auto* arr = trk.getProperty ("plugins", var()).getArray())
            for (auto& p : *arr) if ((int) p.getProperty ("index", -1) == xfIdx)
            {
                auto cuts = p.getProperty ("moshFx", var()).getProperty ("activeCuts", var());
                if (auto* ca = cuts.getArray(); ca != nullptr && ! ca->isEmpty())
                {
                    const auto first = ca->getReference (0);
                    activeCutHasScore = (double) first.getProperty ("score", 0.0) > 0.0;
                    activeCutHasDepth = (double) first.getProperty ("depthDb", 0.0) > 0.0;
                }
            } }
        check (activeCutHasScore, "X-FDBK active cut readout carries its own score");
        check (activeCutHasDepth, "X-FDBK active cut readout carries depth");
        xfOut.deleteFile();   // per-process unique name → clean up so it can't accumulate in the temp dir

        const int autoIdx = builtinIndex (trackById (bt), "moshAutoTune");
        if (autoIdx >= 0)
        {
            check (ok (cmd (ops, "bypass_plugin", objN ({{ "trackId", bt }, { "index", autoIdx }, { "bypassed", true }}))),
                   "bypass_plugin on Mosh AutoTune ok");
            bool bypassed = false;
            { auto trk = trackById (bt);
              if (auto* arr = trk.getProperty ("plugins", var()).getArray())
                for (auto& p : *arr) if ((int) p.getProperty ("index", -1) == autoIdx)
                    bypassed = ! (bool) p.getProperty ("enabled", true); }
            check (bypassed, "Mosh AutoTune bypass reflected in snapshot");
            check (ok (cmd (ops, "undo")), "undo Mosh AutoTune bypass ok");
        }

        // Persistence + validation.
        cmd (ops, "save"); cmd (ops, "reload");
        check (builtinIndex (trackById (bt), "compressor") >= 0, "built-in plugin persists across save/reload");
        check (builtinIndex (trackById (bt), "moshAutoTune") >= 0, "Mosh AutoTune persists across save/reload");
        check (builtinIndex (trackById (bt), "moshOTT") >= 0, "Mosh OTT persists across save/reload");
        check (builtinIndex (trackById (bt), "moshXFeedback") >= 0, "Mosh X-FDBK persists across save/reload");
        const int ottIdx = builtinIndex (trackById (bt), "moshOTT");
        if (ottIdx >= 0)
        {
            check (ok (cmd (ops, "remove_plugin", objN ({{ "trackId", bt }, { "index", ottIdx }}))), "remove_plugin on Mosh OTT ok");
            check (builtinIndex (trackById (bt), "moshOTT") < 0, "Mosh OTT removed from chain");
            check (ok (cmd (ops, "undo")), "undo Mosh OTT remove ok");
            check (builtinIndex (trackById (bt), "moshOTT") >= 0, "undo restores Mosh OTT");
        }
        check (! ok (cmd (ops, "load_builtin", objN ({{ "trackId", bt }, { "type", "no_such_plugin" }}))), "load_builtin rejects unknown type");
        // The scratch "Built-ins" track is left in place: the only later count
        // check in this run is relative (tracksBefore+1), and absolute-count
        // checks live in the separate runUndoSelfTest with its own fresh engine.
    }

    // ─── reorder_plugin: chain ordering + undo + out-of-bounds clamp (was 0-ref) ───
    section ("PLG reorder: plugin chain ordering (reorder_plugin)");
    {
        auto effectOrder = [&] (const String& tid) -> StringArray {
            StringArray order; auto trk = trackById (tid);
            if (auto* arr = trk.getProperty ("plugins", var()).getArray())
                for (auto& p : *arr)
                { auto ty = p.getProperty ("type", var()).toString();
                  if (ty == "compressor" || ty == "reverb" || ty == "delay") order.add (ty); }
            return order;
        };
        auto idxOf = [&] (const String& tid, const String& type) -> int {
            auto trk = trackById (tid);
            if (auto* arr = trk.getProperty ("plugins", var()).getArray())
                for (auto& p : *arr) if (p.getProperty ("type", var()).toString() == type) return (int) p.getProperty ("index", -1);
            return -1;
        };

        auto rt = cmd (ops, "create_track", args1 ("name", "Reorder"))["data"].getProperty ("trackId", var()).toString();
        check (ok (cmd (ops, "load_builtin", objN ({{ "trackId", rt }, { "type", "compressor" }}))), "reorder: load compressor");
        check (ok (cmd (ops, "load_builtin", objN ({{ "trackId", rt }, { "type", "reverb" }}))),     "reorder: load reverb");
        check (ok (cmd (ops, "load_builtin", objN ({{ "trackId", rt }, { "type", "delay" }}))),      "reorder: load delay");
        check (effectOrder (rt) == StringArray ({ "compressor", "reverb", "delay" }), "effects load in chain order C,R,D");

        // Move compressor to the end via an out-of-bounds toIndex — Tracktion's
        // insertPlugin clamps an out-of-range index to append (no crash / no error).
        const int compIdx = idxOf (rt, "compressor");
        check (ok (cmd (ops, "reorder_plugin", objN ({{ "trackId", rt }, { "index", compIdx }, { "toIndex", 99 }}))),
               "reorder_plugin with an out-of-bounds toIndex clamps to append (ok, no crash)");
        check (effectOrder (rt) == StringArray ({ "reverb", "delay", "compressor" }), "compressor moved to the end of the chain");

        check (ok (cmd (ops, "undo")), "undo reorder_plugin ok");
        check (effectOrder (rt) == StringArray ({ "compressor", "reverb", "delay" }), "undo restores the prior plugin order");

        check (! ok (cmd (ops, "reorder_plugin", objN ({{ "trackId", rt }, { "index", 99 }, { "toIndex", 0 }}))),
               "reorder_plugin with a bad from-index errors");
    }

    // ─── Master-bus plugins: host plugins (limiter, bus EQ, …) on getMasterPluginList(),
    // mirroring the per-track plugin commands one level up (no trackId). Built-ins only
    // (compressor/reverb/4bandEq/delay) — deterministic, no VST3 dependency — plus one
    // block gated on a real scanned VST3 (mirrors Stage 3's fxId-gated block above). ───
    section ("Master bus plugins (load/remove/reorder/bypass/param, undo)");
    {
        auto masterPlugins = [&] () -> var {
            return ops.snapshot().getProperty ("master", var()).getProperty ("plugins", var());
        };
        // NOTE: `masterPlugins()` returns a fresh var by value each call. getArray() hands
        // back a raw pointer into that var's (ref-counted) internal array storage, so the
        // var itself MUST be kept alive (bound to a named local) for as long as the pointer
        // is used. `if (auto* arr = masterPlugins().getArray())` looks equivalent but is a
        // real use-after-free: the condition of an if-statement is its own full-expression,
        // so the unnamed `masterPlugins()` temporary — and the array it owns — is destroyed
        // the instant the condition finishes evaluating, BEFORE the loop body runs (unlike
        // the `trk`/`snap`-named-local idiom used everywhere else in this file, where the
        // owning var outlives the condition because it's a named variable in the enclosing
        // scope). Every read below binds the result to a named local first.
        auto masterOrder = [&] () -> StringArray {
            StringArray order;
            auto plugins = masterPlugins();
            if (auto* arr = plugins.getArray())
                for (auto& p : *arr) order.add (p.getProperty ("type", var()).toString());
            return order;
        };
        auto masterIdxOf = [&] (const String& type) -> int {
            auto plugins = masterPlugins();
            if (auto* arr = plugins.getArray())
                for (auto& p : *arr) if (p.getProperty ("type", var()).toString() == type) return (int) p.getProperty ("index", -1);
            return -1;
        };

        check (masterOrder().isEmpty(), "master bus starts with no plugins");

        check (ok (cmd (ops, "load_master_builtin", objN ({{ "type", "compressor" }}))), "load_master_builtin (compressor) ok");
        check (masterOrder() == StringArray ({ "compressor" }), "compressor appears in master.plugins");
        check (ok (cmd (ops, "load_master_builtin", objN ({{ "type", "reverb" }}))), "load_master_builtin (reverb) ok");
        check (ok (cmd (ops, "load_master_builtin", objN ({{ "type", "delay" }}))),  "load_master_builtin (delay) ok");
        check (masterOrder() == StringArray ({ "compressor", "reverb", "delay" }), "master effects load in chain order C,R,D");

        // set_master_plugin_param — value reflected in the snapshot.
        const int compIdx = masterIdxOf ("compressor");
        check (compIdx >= 0, "compressor index resolved");
        check (ok (cmd (ops, "set_master_plugin_param", objN ({{ "index", compIdx }, { "paramIndex", 0 }, { "value", 0.65 }}))),
               "set_master_plugin_param ok");
        {
            double v = -1.0;
            auto plugins = masterPlugins();
            if (auto* arr = plugins.getArray())
                for (auto& p : *arr)
                    if ((int) p.getProperty ("index", -1) == compIdx)
                    {
                        auto params = p.getProperty ("params", var());
                        if (auto* ps = params.getArray())
                            for (auto& pp : *ps)
                                if ((int) pp.getProperty ("index", -1) == 0)
                                    v = (double) pp.getProperty ("value", -1.0);
                    }
            check (std::abs (v - 0.65) < 0.02, "set_master_plugin_param value reflects in the snapshot");
        }

        // bypass_master_plugin + undo.
        check (ok (cmd (ops, "bypass_master_plugin", objN ({{ "index", compIdx }, { "bypassed", true }}))), "bypass_master_plugin ok");
        {
            bool bypassed = false;
            auto plugins = masterPlugins();
            if (auto* arr = plugins.getArray())
                for (auto& p : *arr) if ((int) p.getProperty ("index", -1) == compIdx) bypassed = ! (bool) p.getProperty ("enabled", true);
            check (bypassed, "bypass_master_plugin disabled the plugin");
        }
        check (ok (cmd (ops, "undo")), "undo bypass_master_plugin ok");

        // reorder_master_plugin — an out-of-bounds toIndex clamps INSIDE the visible
        // prefix (unlike reorder_plugin, which relies on Tracktion's raw append-at-end
        // clamp — master must never land a plugin after the (currently absent, headless)
        // internal spectral tap; see masterVisibleBoundary()).
        check (ok (cmd (ops, "reorder_master_plugin", objN ({{ "index", compIdx }, { "toIndex", 99 }}))),
               "reorder_master_plugin with an out-of-bounds toIndex clamps (ok, no crash)");
        check (masterOrder() == StringArray ({ "reverb", "delay", "compressor" }), "compressor moved to the end of the master chain");
        check (ok (cmd (ops, "undo")), "undo reorder_master_plugin ok");
        check (masterOrder() == StringArray ({ "compressor", "reverb", "delay" }), "undo restores the prior master plugin order");

        check (! ok (cmd (ops, "reorder_master_plugin", objN ({{ "index", 99 }, { "toIndex", 0 }}))),
               "reorder_master_plugin with a bad from-index errors");

        // persists across save/reload.
        cmd (ops, "save"); cmd (ops, "reload");
        check (masterOrder() == StringArray ({ "compressor", "reverb", "delay" }), "master plugins persist across save/reload");

        // remove_master_plugin + undo.
        check (ok (cmd (ops, "remove_master_plugin", objN ({{ "index", masterIdxOf ("delay") }}))), "remove_master_plugin ok");
        check (masterOrder() == StringArray ({ "compressor", "reverb" }), "master plugin removed from chain");
        check (ok (cmd (ops, "undo")), "undo remove_master_plugin restores it");
        check (masterOrder() == StringArray ({ "compressor", "reverb", "delay" }), "undo restores the removed master plugin");

        // open_master_plugin_editor — dispatches without crashing (native pop-out itself
        // is untestable headless, same posture as open_plugin_editor).
        check (ok (cmd (ops, "open_master_plugin_editor", objN ({{ "index", compIdx }}))), "open_master_plugin_editor ok");

        // bad index -> clean errors, not crashes.
        check (! ok (cmd (ops, "set_master_plugin_param", objN ({{ "index", 99 }, { "paramIndex", 0 }, { "value", 0.5 }}))),
               "set_master_plugin_param on a bad index errors");
        check (! ok (cmd (ops, "bypass_master_plugin", objN ({{ "index", 99 }, { "bypassed", true }}))),
               "bypass_master_plugin on a bad index errors");
        check (! ok (cmd (ops, "remove_master_plugin", objN ({{ "index", 99 }}))),
               "remove_master_plugin on a bad index errors");
        check (! ok (cmd (ops, "load_master_builtin", objN ({{ "type", "not-a-real-builtin" }}))),
               "load_master_builtin on an unknown type errors");

        // Optional: a real scanned VST3 (Stage 3's fxId-gated posture) — proves
        // load_master_plugin/pluginId end-to-end when the harness has a hostable plugin.
        {
            String masterFxId;
            auto lpMaster = cmd (ops, "list_plugins");
            if (auto* arr = lpMaster["data"].getProperty ("plugins", var()).getArray())
                for (auto& p : *arr)
                    if (isHarnessHostablePlugin (p) && ! (bool) p.getProperty ("isInstrument", false))
                    { masterFxId = p.getProperty ("id", var()).toString(); break; }

            if (masterFxId.isNotEmpty())
            {
                auto lr = cmd (ops, "load_master_plugin", objN ({{ "pluginId", masterFxId }}));
                check (ok (lr), "load_master_plugin (real VST3) ok");
                const int idx = (int) lr["data"].getProperty ("index", -1);
                check (idx >= 0 && masterOrder().size() == 4, "real VST3 appears in master.plugins");
                check (ok (cmd (ops, "remove_master_plugin", objN ({{ "index", idx }}))), "remove_master_plugin (real VST3) ok");
            }
            else
                std::cerr << "  (no hostable VST3 available — skipping load_master_plugin/pluginId check)\n";
        }

        // cleanup — leave the master bus clean for later sections/demos.
        for (int guard = 0; guard < 8 && ! masterOrder().isEmpty(); ++guard)
        {
            const int idx = (int) masterPlugins()[0].getProperty ("index", -1);
            cmd (ops, "remove_master_plugin", objN ({{ "index", idx }}));
        }
        check (masterOrder().isEmpty(), "master bus cleaned up");
    }

    // ─── Master-bus internal-plugin boundary coverage: everything in the section
    // above exercises isInternalMasterPlugin()/masterVisibleBoundary()/findMasterPlugin()
    // only "by inspection" — the internal spectral tap is normally created lazily by
    // emitSpectrum() during REAL playback (a live PlaybackContext), which headless
    // --selftest never reaches, so the mapping logic that is supposed to protect the
    // tap from user-facing commands has never actually run against a real internal
    // plugin. This section constructs one directly — the SAME insertion call
    // cmdLoadMasterBuiltin/ensureMasterSpectralTap use (PluginCache::createNewPlugin +
    // PluginList::insertPlugin at the list's current end) — and proves the mapping
    // holds around it, then tears it down by hand (there is deliberately no user-facing
    // command that can reach an internal plugin) so later sections see a clean bus. ───
    section ("Master bus: internal plugin (spectral tap) visible-index boundary");
    {
        auto masterPlugins = [&] () -> var {
            return ops.snapshot().getProperty ("master", var()).getProperty ("plugins", var());
        };
        // See the NOTE on the masterPlugins()/masterOrder() lambdas in the section above —
        // same use-after-free trap with an unnamed temporary; every read here binds to a
        // named local first.
        auto masterOrder = [&] () -> StringArray {
            StringArray order;
            auto plugins = masterPlugins();
            if (auto* arr = plugins.getArray())
                for (auto& p : *arr) order.add (p.getProperty ("type", var()).toString());
            return order;
        };
        auto masterIdxOf = [&] (const String& type) -> int {
            auto plugins = masterPlugins();
            if (auto* arr = plugins.getArray())
                for (auto& p : *arr) if (p.getProperty ("type", var()).toString() == type) return (int) p.getProperty ("index", -1);
            return -1;
        };
        auto physicalCount = [&] { return eng.edit().getMasterPluginList().getPlugins().size(); };
        auto physicalTypeAt = [&] (int i) -> String {
            auto plugins = eng.edit().getMasterPluginList().getPlugins();
            return (i >= 0 && i < plugins.size()) ? plugins[i]->getPluginType() : String();
        };
        const String tapType (MasterSpectralTapPlugin::xmlTypeName);

        check (masterOrder().isEmpty(), "boundary section starts with a clean master bus");

        // Three visible plugins, then the internal tap.
        check (ok (cmd (ops, "load_master_builtin", objN ({{ "type", "compressor" }}))), "compressor loaded");
        check (ok (cmd (ops, "load_master_builtin", objN ({{ "type", "reverb" }}))),     "reverb loaded");
        check (ok (cmd (ops, "load_master_builtin", objN ({{ "type", "delay" }}))),      "delay loaded");
        check (masterOrder() == StringArray ({ "compressor", "reverb", "delay" }), "3 visible plugins load in order before the tap exists");
        check (physicalCount() == 3, "physical master list has exactly 3 plugins pre-tap");

        {
            auto tap = eng.edit().getPluginCache().createNewPlugin (MasterSpectralTapPlugin::xmlTypeName, {});
            check (tap != nullptr, "synthetic internal plugin (spectral tap) created");
            auto& list = eng.edit().getMasterPluginList();
            list.insertPlugin (tap, list.getPlugins().size(), nullptr);   // append — same call cmdLoadMasterBuiltin/ensureMasterSpectralTap use
        }
        check (physicalCount() == 4, "physical master list now has 4 plugins (3 visible + the internal tap)");
        check (physicalTypeAt (3) == tapType, "the tap physically sits at index 3 (last)");

        // (a) master.plugins EXCLUDES the internal plugin.
        check (masterOrder() == StringArray ({ "compressor", "reverb", "delay" }), "master.plugins still reports only the 3 visible plugins with the tap present");
        check (masterPlugins().size() == 3, "master.plugins length unaffected by the internal plugin");

        // (b) user-visible indices still resolve to the RIGHT physical plugins for
        // load/remove/reorder/bypass/set_param, with the tap present.
        const int reverbIdx = masterIdxOf ("reverb");
        check (reverbIdx == 1, "reverb resolved at visible index 1");
        check (ok (cmd (ops, "set_master_plugin_param", objN ({{ "index", reverbIdx }, { "paramIndex", 0 }, { "value", 0.42 }}))),
               "set_master_plugin_param on a visible index still resolves with the tap present");
        check (ok (cmd (ops, "bypass_master_plugin", objN ({{ "index", reverbIdx }, { "bypassed", true }}))),
               "bypass_master_plugin on a visible index still resolves with the tap present");
        {
            bool bypassed = false;
            auto plugins = masterPlugins();
            if (auto* arr = plugins.getArray())
                for (auto& p : *arr) if ((int) p.getProperty ("index", -1) == reverbIdx) bypassed = ! (bool) p.getProperty ("enabled", true);
            check (bypassed, "the bypass landed on reverb, not the tap");
        }
        check (ok (cmd (ops, "undo")), "undo bypass ok");
        check (physicalTypeAt (3) == tapType, "the tap is untouched by a visible-plugin bypass+undo");

        // (d) NO OFF-BY-ONE at the boundary: index == boundary (3, the tap's own
        // physical slot) must NOT resolve. If masterVisibleBoundary()/findMasterPlugin()
        // had an off-by-one (e.g. an inclusive `<=` bound instead of `<`), this would
        // silently let a user-facing command reach into the internal tap.
        check (! ok (cmd (ops, "set_master_plugin_param", objN ({{ "index", 3 }, { "paramIndex", 0 }, { "value", 0.5 }}))),
               "index == boundary (the tap's own slot) is rejected, not resolved to the tap");
        check (! ok (cmd (ops, "bypass_master_plugin", objN ({{ "index", 3 }, { "bypassed", true }}))),
               "bypass at index == boundary is rejected");
        check (! ok (cmd (ops, "remove_master_plugin", objN ({{ "index", 3 }}))),
               "remove at index == boundary is rejected — the tap can't be deleted via the user command surface");
        check (physicalCount() == 4, "the tap survived every boundary-index command attempt");
        // ...and boundary - 1 (the LAST visible plugin, delay) still resolves correctly —
        // the guard isn't over-conservative either.
        const int delayIdx = masterIdxOf ("delay");
        check (delayIdx == 2, "delay resolved at visible index 2 (== boundary - 1)");
        check (ok (cmd (ops, "bypass_master_plugin", objN ({{ "index", delayIdx }, { "bypassed", true }}))),
               "bypass at boundary - 1 (the last visible plugin) still resolves");
        check (ok (cmd (ops, "undo")), "undo ok");

        // (c) reorder/insert can NEVER place a user plugin after the internal tap — the
        // tap must stay physically last so it taps the FULLY-PROCESSED master signal.
        const int compIdx = masterIdxOf ("compressor");
        check (ok (cmd (ops, "reorder_master_plugin", objN ({{ "index", compIdx }, { "toIndex", 99 }}))),
               "reorder_master_plugin with an out-of-bounds toIndex clamps (ok, no crash) with the tap present");
        check (masterOrder() == StringArray ({ "reverb", "delay", "compressor" }), "compressor moved to the end of the VISIBLE chain");
        check (physicalTypeAt (3) == tapType, "the tap is still physically last after a max-index reorder");
        check (ok (cmd (ops, "undo")), "undo reorder ok");
        check (masterOrder() == StringArray ({ "compressor", "reverb", "delay" }), "undo restores the visible order");

        // A new plugin load with NO explicit index must land BEFORE the tap, pushing the
        // tap's physical slot from 3 to 4 — never after it. This is also the one check
        // in this section that depends on te::EditLimits::maxNumMasterPlugins: Tracktion
        // counts the (invisible) tap against that same cap, so without the
        // MoshEngineBehaviour::getEditLimits() +1 override (see MoshEngine.cpp) this 4th
        // VISIBLE plugin would silently fail to insert — PluginList::insertPlugin
        // returns an empty Ptr with no error, and the pre-fix cmdLoadMasterBuiltin
        // didn't check indexOf() either, so it would have reported "ok" for a plugin
        // that was never actually added. This is a real bug this coverage caught
        // (fixed alongside the coverage; see the belt-and-suspenders checks below and
        // the MoshEngine.cpp/cmdLoadMasterPlugin/cmdLoadMasterBuiltin comments).
        check (ok (cmd (ops, "load_master_builtin", objN ({{ "type", "4bandEq" }}))), "4bandEq loaded (4th visible plugin)");
        check (masterOrder() == StringArray ({ "compressor", "reverb", "delay", "4bandEq" }), "the 4th visible plugin appended before the tap");
        check (physicalCount() == 5, "physical list now has 5 (4 visible + the tap)");
        check (physicalTypeAt (4) == tapType, "the tap was pushed to index 4 — still physically last");
        check (masterPlugins().size() == 4, "master.plugins still excludes the (now index-4) tap");

        // Make room — the master bus caps at 4 VISIBLE plugins regardless of the tap
        // (that part of the cap is pre-existing Tracktion behavior, out of scope here)
        // — before proving an explicit, absurdly-out-of-range `index` on load ALSO
        // clamps before the tap, not after it (mirrors cmdLoadMasterPlugin/
        // cmdLoadMasterBuiltin's `index > boundary -> boundary` clamp).
        check (ok (cmd (ops, "remove_master_plugin", objN ({{ "index", masterIdxOf ("4bandEq") }}))),
               "4bandEq removed to make room for the next probe");
        check (ok (cmd (ops, "load_master_builtin", objN ({{ "type", "4bandEq" }, { "index", 999 }}))),
               "load_master_builtin with an absurd explicit index still succeeds (clamped)");
        check (masterOrder() == StringArray ({ "compressor", "reverb", "delay", "4bandEq" }),
               "the absurd-index load landed at the visible end (index 999 clamped to the boundary), not literally index 999");
        check (physicalCount() == 5, "physical list is back to 5 (4 visible + the tap)");
        check (physicalTypeAt (4) == tapType, "the tap is STILL physically last after an absurd-index load");
        check (masterPlugins().size() == 4, "master.plugins reports 4 visible plugins, tap still excluded");

        // Belt-and-suspenders: findMasterPlugin/cmdSetMasterPluginParam etc. resolve a
        // freshly-loaded plugin correctly with the tap present (not the empty-Ptr/
        // index -1 shape a silently-failed insert would have left behind).
        {
            const int eqIdx = masterIdxOf ("4bandEq");
            check (eqIdx == 3, "4bandEq resolved at visible index 3, not -1");
            check (ok (cmd (ops, "set_master_plugin_param", objN ({{ "index", eqIdx }, { "paramIndex", 0 }, { "value", 0.3 }}))),
                   "set_master_plugin_param on the freshly-loaded 4th visible plugin resolves correctly");
        }

        // ── cleanup: remove every visible plugin via the command surface (proves
        // remove_master_plugin keeps working with the tap present through to the end),
        // then remove the synthetic internal plugin directly — mirrors its direct
        // construction above; there is deliberately no user-facing command that can
        // reach it — so later sections/demos see a fully clean master bus. ──
        for (int guard = 0; guard < 8 && ! masterOrder().isEmpty(); ++guard)
        {
            const int idx = (int) masterPlugins()[0].getProperty ("index", -1);
            cmd (ops, "remove_master_plugin", objN ({{ "index", idx }}));
        }
        check (masterOrder().isEmpty(), "all visible master plugins removed");
        check (physicalCount() == 1, "only the internal tap remains physically");
        {
            auto plugins = eng.edit().getMasterPluginList().getPlugins();
            if (! plugins.isEmpty())
                plugins.getLast()->deleteFromParent();
        }
        check (eng.edit().getMasterPluginList().getPlugins().isEmpty(), "synthetic internal plugin cleaned up — master bus fully empty for later sections");
    }

    // ─── MON-004: total plugin delay compensation (PDC) readout in the snapshot ───
    section ("MON-004: PDC / reported-latency readout");
    {
        auto sess = ops.snapshot().getProperty ("session", var());
        // Fields present + numeric (the UI reads these for the transport readout).
        check (sess.hasProperty ("totalLatencySamples"), "session.totalLatencySamples present");
        check (sess.hasProperty ("totalLatencyMs"), "session.totalLatencyMs present");
        check (sess.hasProperty ("latencyContextReady"), "session.latencyContextReady present");
        const int  latSamples = (int) sess.getProperty ("totalLatencySamples", -1);
        const double latMs     = (double) sess.getProperty ("totalLatencyMs", -1.0);
        const bool ready       = (bool) sess.getProperty ("latencyContextReady", true);
        check (latSamples >= 0, "totalLatencySamples is non-negative");
        check (latMs >= 0.0, "totalLatencyMs is non-negative");
        // ms is consistent with samples / sampleRate (guard against a divide-by-zero SR).
        const double sr = (double) sess.getProperty ("sampleRate", 44100.0);
        const double sr2 = sr > 0.0 ? sr : 44100.0;
        check (std::abs (latMs - (double) latSamples / sr2 * 1000.0) < 1e-6, "totalLatencyMs == samples / sampleRate * 1000 (consistent)");

        // Honest headless posture: with no audio device the playback graph is never
        // prepared, so the context is null -> ready=false + 0 samples (NOT a false 0 ms
        // claimed as real). The number is verified live via the GUI / live-audio smoke.
        if (! eng.hasAudio())
        {
            check (! ready, "no-audio headless -> latencyContextReady=false (honest, not a false 0.0 ms)");
            check (latSamples == 0, "no-audio headless -> totalLatencySamples=0");
        }
        else
            check (ready, "audio attached -> latencyContextReady=true (graph prepared)");
    }
}

} // namespace mosh
