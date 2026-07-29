// ── SelfTest.Ch04_generative_layer.cpp — runSelfTest chapter 4 (RFC 002 A-PR5) ──────
// Sections moved VERBATIM by prefix-motion from src/app/SelfTest.cpp
// (pre-split lines 1923-2727), in exact pre-split order:
//   . "FMS Stage 2: sing mode (soulx, fake backend)"
//   . "Stage 5: generative layer (FakeAdapter, full loop)" (+ 3 nested)
//   . "Route B: transform render mode (fake)"
//   . "LoRA rack: params + fingerprint"
//   . "NRL-MIDI: generative on a MIDI clip (auto-bounce)"
//   . "Section-scoped render (rework-the-hook)"
//   . "bounce_layer_to_clip is undo-tracked"
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
#include "state/Ids.h"
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

void runChapter04_generative_layer (selftest::SelfTestCtx& ctx)
{
    using namespace juce;
    auto& eng = *ctx.eng;
    auto& ops = *ctx.ops;
    auto& trackById = ctx.trackById;

    // ─── FMS Phase-3 Stage 2: sing mode (SoulX adapter, fake legato-beep backend) ───
    section ("FMS Stage 2: sing mode (soulx, fake backend)");
    {
        auto vt = cmd (ops, "create_track", args1 ("name", "Vocal"))["data"].getProperty ("trackId", var()).toString();
        auto vtone = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", vt }, { "seconds", 2.0 }, { "freq", 220.0 }}));
        const auto vcid = vtone["data"].getProperty ("clipId", var()).toString();

        // No sheet yet → a clear error BEFORE any service/job work (never a silent render).
        check (ok (cmd (ops, "create_render_layer", objN ({{ "clipId", vcid }, { "adapter", "soulx" }, { "mode", "sing" }}))),
               "create_render_layer mode:sing ok");
        auto rNoSheet = cmd (ops, "render_layer", objN ({{ "clipId", vcid }, { "wait", true }}));
        check (! ok (rNoSheet), "sing without a lyric sheet errors (no silent render)");

        // Sheet + a line via commands; the Stage-1 lyricScore fixture is planted directly
        // (its landing command, build_skeleton_from_clip, needs the Basic-Pitch venv —
        // machine-dependent — while the RENDER path under test stays command-only).
        check (ok (cmd (ops, "create_lyric_sheet", args1 ("trackId", vt))), "create_lyric_sheet ok");
        check (ok (cmd (ops, "set_lyric_line", objN ({{ "trackId", vt }, { "lineIndex", 0 }, { "text", "hold the flame" }}))),
               "set_lyric_line ok");
        const juce::String scoreBlob =
            R"({"v":1,"algo":"v3","bar":0,"bpm":120.0,"timeSig":[4,4],"grid":"1/16","clamped":false,)"
            R"("slots":[{"start":0.0,"end":0.5,"velocity":90,"kind":"attack","segments":[{"start":0.0,"end":0.5,"pitch":57}]},)"
            R"({"start":0.5,"end":1.0,"velocity":90,"kind":"gap","segments":[{"start":0.5,"end":1.0,"pitch":59}]},)"
            R"({"start":1.0,"end":2.0,"velocity":90,"kind":"gap","segments":[{"start":1.0,"end":1.5,"pitch":60},{"start":1.5,"end":2.0,"pitch":64}]}]})";
        bool planted = false;
        for (auto* t : te::getAudioTracks (eng.edit()))
            if (t->itemID.toString() == vt)
                if (auto sheet = t->state.getChildWithName (mosh::ids::MOSH_LYRICSHEET); sheet.isValid())
                {
                    auto lines = sheet.getChildWithName (mosh::ids::LYRIC_LINES);
                    if (lines.getNumChildren() > 0)
                    {
                        lines.getChild (0).setProperty (mosh::ids::lyricScore, scoreBlob, nullptr);
                        planted = true;
                    }
                }
        check (planted, "lyricScore fixture planted on the line");

        auto draftRender = cmd (ops, "render_layer", objN ({{ "clipId", vcid }, { "wait", true }}));
        check (! ok (draftRender), "sing render rejects scored draft text until asserted");
        check (draftRender.getProperty ("error", var()).toString().contains ("asserted words"),
               "scored draft text returns asserted-words error");
        check (! ok (cmd (ops, "assert_lyric_line", objN ({{ "trackId", vt }, { "lineIndex", 0 }, { "text", "___ the flame" }}))),
               "assert_lyric_line rejects unresolved gaps");
        check (ok (cmd (ops, "assert_lyric_line", objN ({{ "trackId", vt }, { "lineIndex", 0 }}))),
               "assert_lyric_line ok");
        check (ok (cmd (ops, "undo")), "undo (assert_lyric_line) ok");
        auto undoneAssertRender = cmd (ops, "render_layer", objN ({{ "clipId", vcid }, { "wait", true }}));
        check (! ok (undoneAssertRender), "undoing assertion makes sing render reject again");
        check (ok (cmd (ops, "assert_lyric_line", objN ({{ "trackId", vt }, { "lineIndex", 0 }}))),
               "assert_lyric_line ok after undo");

        // Full loop: render (fake sing) → HIT on identical re-render → lyric edit = MISS.
        auto s1 = cmd (ops, "render_layer", objN ({{ "clipId", vcid }, { "wait", true }}));
        check (ok (s1), "sing render ok (fake legato-beep backend)");
        check (s1["data"].getProperty ("cache", var()).toString() == "miss", "first sing render is a cache MISS");
        check (s1["data"].getProperty ("status", var()).toString() == "ready", "sing render completed -> ready");
        // The authored SoulX target score is a durable job artifact next to the output.
        bool scoreArtifact = false;
        { auto renders = eng.sessionDir().getChildFile ("renders");
          for (auto& d : renders.findChildFiles (File::findDirectories, false))
              if (d.getChildFile ("target_score.json").existsAsFile())
                  scoreArtifact = true; }
        check (scoreArtifact, "target_score.json authored next to the render output");

        auto s2 = cmd (ops, "render_layer", objN ({{ "clipId", vcid }, { "wait", true }}));
        check (s2["data"].getProperty ("cache", var()).toString() == "hit", "identical sing re-render is a cache HIT");

        cmd (ops, "set_lyric_line", objN ({{ "trackId", vt }, { "lineIndex", 0 }, { "text", "hold the cold gold flame" }}));
        auto draftAfterEdit = cmd (ops, "render_layer", objN ({{ "clipId", vcid }, { "wait", true }}));
        check (! ok (draftAfterEdit), "editing asserted words returns line to draft state");
        check (ok (cmd (ops, "assert_lyric_line", objN ({{ "trackId", vt }, { "lineIndex", 0 }}))),
               "assert_lyric_line ok after edit");
        auto s3 = cmd (ops, "render_layer", objN ({{ "clipId", vcid }, { "wait", true }}));
        check (s3["data"].getProperty ("cache", var()).toString() == "miss", "lyric edit changes the sing fingerprint (cache MISS)");
    }

    // ─── Stage 5: Tier-B generative layer (FakeAdapter) ───
    section ("Stage 5: generative layer (FakeAdapter, full loop)");
    {
        // Fresh track + source clip for the generative flow.
        auto gt = cmd (ops, "create_track", args1 ("name", "Gen"))["data"].getProperty ("trackId", var()).toString();
        auto tone = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", gt }, { "seconds", 1.5 }, { "freq", 196.0 }}));
        const auto gcid = tone["data"].getProperty ("clipId", var()).toString();

        auto crl = cmd (ops, "create_render_layer", objN ({{ "clipId", gcid }, { "adapter", "fake" }}));
        check (ok (crl), "create_render_layer ok");

        Array<var> colors; { auto* c = new DynamicObject(); c->setProperty ("name", "grit"); c->setProperty ("value", 60); colors.add (var (c)); }
        cmd (ops, "set_render_param", objN ({{ "clipId", gcid }, { "seed", 1 }, { "nl", 0.4 }, { "colors", colors }}));

        // Render (wait inline — spawns the Python service via the job manager).
        auto r1 = cmd (ops, "render_layer", objN ({{ "clipId", gcid }, { "wait", true }}));
        check (ok (r1), "render_layer ok (service spawned, job ran)");
        check (r1["data"].getProperty ("cache", var()).toString() == "miss", "first render is a cache MISS");
        check (r1["data"].getProperty ("status", var()).toString() == "ready", "render completed -> status ready");
        // snapshot reflects the rendered layer
        bool hasArtifact = false;
        { auto trk = trackById (gt);
          if (auto* arr = trk.getProperty ("clips", var()).getArray())
            for (auto& c : *arr) if (c.getProperty ("id", var()).toString() == gcid)
                hasArtifact = (bool) c.getProperty ("renderLayer", var()).getProperty ("hasArtifact", false); }
        check (hasArtifact, "render produced a cached artifact (output.wav)");

        // Content fingerprint of the applied audio (the clip's in-place source). The MISS/HIT
        // checks alone can't see stale job-dir reuse: the layer's job dir keeps the SAME
        // output.wav path across renders, and the pollers treat an existing output+manifest
        // pair as the durable completion signal — so a re-render that never clears the pair
        // "completes" instantly with the PREVIOUS render's audio while still reporting MISS.
        auto clipSource = [&] (const String& cid) -> File {
            auto trk = trackById (gt);
            if (auto* arr = trk.getProperty ("clips", var()).getArray())
                for (auto& c : *arr)
                    if (c.getProperty ("id", var()).toString() == cid)
                        return File (c.getProperty ("sourceFile", var()).toString());
            return {};
        };
        const auto srcA = clipSource (gcid);
        check (srcA.existsAsFile(), "first render's applied source exists on disk");
        const auto bytesA = juce::MD5 (srcA).toHexString();

        // Re-render with identical fingerprint -> cache HIT.
        auto r2 = cmd (ops, "render_layer", objN ({{ "clipId", gcid }, { "wait", true }}));
        check (r2["data"].getProperty ("cache", var()).toString() == "hit", "identical re-render is a cache HIT (full fingerprint)");

        // Change a param -> fingerprint changes -> cache MISS (re-render).
        cmd (ops, "set_render_param", objN ({{ "clipId", gcid }, { "seed", 2 }}));
        auto r3 = cmd (ops, "render_layer", objN ({{ "clipId", gcid }, { "wait", true }}));
        check (r3["data"].getProperty ("cache", var()).toString() == "miss", "param change -> dirty -> re-render (cache MISS)");
        // The fake adapter's output depends on the seed, so the re-render's AUDIO must actually
        // change — this is the assertion that catches stale job-dir reuse (a stale pair lands
        // the old bytes under a fresh fingerprint name and MISS/HIT still looks correct).
        const auto srcB = clipSource (gcid);
        check (srcB.existsAsFile(), "param-change re-render's applied source exists on disk");
        check (juce::MD5 (srcB).toHexString() != bytesA,
               "param-change re-render produced DIFFERENT audio bytes (no stale job-dir reuse)");

        // --- NRL-004: render-layer management (in-place apply / reset / bypass / freeze / remove) ---
        section ("NRL-004: render-layer management");
        auto layerOf = [&] (const String& cid) -> var {
            auto trk = trackById (gt);
            if (auto* arr = trk.getProperty ("clips", var()).getArray())
                for (auto& c : *arr)
                    if (c.getProperty ("id", var()).toString() == cid)
                        return c.getProperty ("renderLayer", var());
            return {};
        };
        auto layerStatus = [&] (const String& cid) { return layerOf (cid).getProperty ("status", var()).toString(); };
        auto neuralLanes = [&] () -> int {
            int n = 0; auto snap = ops.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& t : *arr) if (t.getProperty ("name", var()).toString() == "Neural Renders") ++n;
            return n;
        };

        // ── In-place auto-apply (the NEW default for WAVE clips) ──
        // The render already AUTO-APPLIED in place: the clip's own source became the artifact.
        // There is no accept step and no "Neural Renders" lane for wave clips.
        check ((bool) layerOf (gcid).getProperty ("appliedInPlace", false),
               "wave render AUTO-APPLIES in place (no accept step)");
        check ((bool) layerOf (gcid).getProperty ("hasOriginal", false),
               "in-place apply stored the original source (Reset available)");

        // accept_render is a no-op for wave clips and creates NO lane.
        const int tracksBefore = tracks (ops);
        check (ok (cmd (ops, "accept_render", args1 ("clipId", gcid))), "accept_render ok (no-op for wave)");
        check (tracks (ops) == tracksBefore, "wave accept creates NO new track");
        check (neuralLanes() == 0, "no 'Neural Renders' lane for an in-place wave render");

        // reset_render_layer restores the ORIGINAL; the layer STAYS (re-imagine available again).
        check (ok (cmd (ops, "reset_render_layer", args1 ("clipId", gcid))), "reset_render_layer ok");
        check (! (bool) layerOf (gcid).getProperty ("appliedInPlace", true), "reset cleared appliedInPlace");
        check (layerStatus (gcid) == "dirty", "reset -> status dirty (re-imagine again)");
        check ((bool) layerOf (gcid).getProperty ("hasOriginal", false), "reset keeps the original lineage (Reset still available)");

        // Re-render after reset HITs the cache and RE-APPLIES in place.
        auto rRe = cmd (ops, "render_layer", objN ({{ "clipId", gcid }, { "wait", true }}));
        check (ok (rRe), "re-render after reset ok");
        check ((bool) layerOf (gcid).getProperty ("appliedInPlace", false), "re-render re-applies in place");

        // ── TASTE-002: the taste-label spigot (the in-place workflow's labels) ──
        // PR #185's in-place auto-apply removed accept/reject from the wave loop, so organic
        // taste labels stopped accumulating (census 2026-07-19: 1 accept, 0 rejects survive).
        // The spigot: reset_render_layer logs an explicit NEGATIVE carrying the render join
        // keys (layerId/cacheKey/adapter), and save/export while a render is still applied
        // logs ONE render_kept soft POSITIVE per layer (deduped on layerId).
        section ("TASTE-002: taste-label spigot (reset negative + render_kept positive)");
        const auto tasteLayerId = layerOf (gcid).getProperty ("id", var()).toString();
        check (tasteLayerId.isNotEmpty(), "layer id is a visible join key in the snapshot");
        auto tasteLines = [&] (const String& command) -> Array<var>
        {
            Array<var> out;
            for (auto& l : StringArray::fromLines (eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString()))
            {
                if (! l.contains ("\"" + command + "\"")) continue;
                const auto row = JSON::parse (l);   // named local — the var-temporary UAF class
                if (row.getProperty ("command", var()).toString() == command) out.add (row);
            }
            return out;
        };
        {
            auto resets = tasteLines ("reset_render_layer");
            check (resets.size() > 0, "reset_render_layer is in the JSONL log");
            const auto ra = resets.getLast().getProperty ("args", var());
            check (ra.getProperty ("clipId", var()).toString() == gcid, "reset taste label carries clipId");
            check (ra.getProperty ("layerId", var()).toString() == tasteLayerId, "reset taste label carries layerId (joins to the render)");
            check (ra.getProperty ("cacheKey", var()).toString().isNotEmpty(), "reset taste label carries the render cacheKey");
            check (ra.getProperty ("adapter", var()).toString() == "fake", "reset taste label carries the adapter");
        }
        auto keptFor = [&] (const String& layerId) -> int
        {
            int n = 0;
            for (auto& row : tasteLines ("render_kept"))
                if (row.getProperty ("args", var()).getProperty ("layerId", var()).toString() == layerId) ++n;
            return n;
        };
        check (keptFor (tasteLayerId) == 0, "no render_kept before any save (the label fires at persistence time)");
        check (ok (cmd (ops, "save")), "save ok (render_kept sweep runs)");
        check (keptFor (tasteLayerId) == 1, "save logs render_kept for the surviving applied layer");
        {
            auto kept = tasteLines ("render_kept");
            check (kept.size() == 1, "render_kept logged ONLY for the applied layer (no spurious labels)");
            const auto ka = kept.getLast().getProperty ("args", var());
            check (ka.getProperty ("clipId", var()).toString() == gcid
                       && ka.getProperty ("cacheKey", var()).toString().isNotEmpty()
                       && ka.getProperty ("adapter", var()).toString() == "fake",
                   "render_kept carries the join keys (clipId/cacheKey/adapter)");
        }
        check (ok (cmd (ops, "save")), "second save ok");
        check (keptFor (tasteLayerId) == 1, "render_kept deduped on layerId (a second save adds NO new label)");

        // bypass_layer toggles status ready<->bypassed (the wave A/B swaps the source to the
        // original when bypassed; here we round-trip the status flag).
        check (ok (cmd (ops, "bypass_layer", objN ({{ "clipId", gcid }, { "bypassed", true }}))), "bypass_layer ok");
        check (layerStatus (gcid) == "bypassed", "bypass_layer{true} -> status bypassed");
        cmd (ops, "bypass_layer", objN ({{ "clipId", gcid }, { "bypassed", false }}));
        check (layerStatus (gcid) == "ready", "bypass_layer{false} -> status ready");

        // Re-render so a cached artifact exists for freeze (cache HIT path).
        cmd (ops, "render_layer", objN ({{ "clipId", gcid }, { "wait", true }}));

        // freeze_layer requires a cached artifact -> status frozen.
        check (ok (cmd (ops, "freeze_layer", args1 ("clipId", gcid))), "freeze_layer ok (artifact present)");
        check (layerStatus (gcid) == "frozen", "freeze_layer -> status frozen");

        section ("freeze_layer actually freezes (+ unfreeze_layer, the way back)");
        // ── Freeze actually freezes (it used to be a label and nothing else) ──
        // The reactive auto-re-render loop gates on ids::reactive; Ids.h declared it as the
        // per-layer opt-out from the start but NO command wrote it, so a "frozen" layer went
        // right on re-rendering. These pin the flag itself, not the word.
        auto layerReactive = [&] (const String& cid) { return (bool) layerOf (cid).getProperty ("reactive", true); };
        check (! layerReactive (gcid), "freeze_layer disarms the reactive loop (ids::reactive=false)");

        // Why the snapshot must carry `reactive` and the UI must not read `status` for this:
        // a param edit overwrites the "frozen" LABEL with "dirty" while the layer is still
        // frozen. Both facts are true at once, and only `reactive` still tells the truth.
        check (ok (cmd (ops, "set_render_param", objN ({{ "clipId", gcid }, { "seed", 4242 }}))),
               "set_render_param on a frozen layer ok");
        check (layerStatus (gcid) == "dirty", "a param edit moves the frozen layer's status to dirty");
        check (! layerReactive (gcid), "...and the layer is STILL frozen (status alone would have lost it)");

        // The way back. There was none: no command moved status off "frozen", and nothing
        // could re-arm ids::reactive, so a freeze was permanent for the life of the project.
        check (ok (cmd (ops, "unfreeze_layer", args1 ("clipId", gcid))), "unfreeze_layer ok");
        check (layerReactive (gcid), "unfreeze_layer re-arms the reactive loop");
        check (layerStatus (gcid) == "dirty",
               "unfreeze reports dirty, not ready (edits made while frozen skipped their re-render)");
        check (! ok (cmd (ops, "unfreeze_layer", args1 ("clipId", gcid))),
               "unfreeze_layer on a layer that is not frozen errors");

        // One command = one undo step, for both directions.
        check (ok (cmd (ops, "freeze_layer", args1 ("clipId", gcid))), "re-freeze ok");
        check (! layerReactive (gcid), "re-freeze disarmed it again");
        check (ok (cmd (ops, "undo")), "freeze: undo ok");
        check (layerReactive (gcid), "undoing a freeze re-arms the reactive loop (not just the label)");
        check (ok (cmd (ops, "redo")), "freeze: redo ok");
        check (! layerReactive (gcid), "redoing a freeze disarms it again");
        check (layerStatus (gcid) == "frozen", "redo restored the frozen label with the flag");

        // Persistence: a freeze that evaporates on reload is the same lie in slower motion.
        check (ok (cmd (ops, "save")), "freeze: save ok");
        check (ok (cmd (ops, "reload")), "freeze: reload ok");
        check (! layerReactive (gcid), "the freeze survives save/reload");
        check (ok (cmd (ops, "unfreeze_layer", args1 ("clipId", gcid))), "unfreeze after reload ok");

        // freeze on a layer with NO artifact errors (gate the button on hasArtifact).
        auto gt2 = cmd (ops, "create_track", args1 ("name", "Gen2"))["data"].getProperty ("trackId", var()).toString();
        auto tone2 = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", gt2 }, { "seconds", 1.0 }, { "freq", 210.0 }}));
        const auto gcid2 = tone2["data"].getProperty ("clipId", var()).toString();
        cmd (ops, "create_render_layer", objN ({{ "clipId", gcid2 }, { "adapter", "fake" }}));
        check (! ok (cmd (ops, "freeze_layer", args1 ("clipId", gcid2))), "freeze_layer on un-rendered layer errors (nothing to freeze)");

        // remove_render_layer clears the node; create_render_layer then succeeds again.
        auto layerOf2 = [&] (const String& cid) -> bool {
            auto trk = trackById (gt2);
            if (auto* arr = trk.getProperty ("clips", var()).getArray())
                for (auto& c : *arr)
                    if (c.getProperty ("id", var()).toString() == cid)
                        return (bool) c.getProperty ("hasRenderLayer", false);
            return false;
        };
        check (layerOf2 (gcid2), "layer present before remove_render_layer");
        check (ok (cmd (ops, "remove_render_layer", args1 ("clipId", gcid2))), "remove_render_layer ok");
        check (! layerOf2 (gcid2), "remove_render_layer cleared MOSH_RENDERLAYER (hasRenderLayer=false)");
        check (ok (cmd (ops, "create_render_layer", objN ({{ "clipId", gcid2 }, { "adapter", "fake" }}))),
               "create_render_layer succeeds again after remove (no 'already has a layer')");
        // undo restores the removed-then-recreated layer state; just prove remove is undoable.
        cmd (ops, "undo");                                   // undo the re-create
        cmd (ops, "undo");                                   // undo the remove -> layer back
        check (layerOf2 (gcid2), "remove_render_layer is undoable (layer restored)");
        check (eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString().contains ("remove_render_layer"),
               "JSONL records remove_render_layer");
    }

    // --- Route B: Tier-B transform render mode (FakeTransformAdapter) ---
    // Same job protocol / cache / accept-landing as SA3 re-imagine, exercised on the
    // new mode:"transform" with the model-agnostic target+strength surface. Runs in the
    // default build (the fake transform is stdlib-only).
    section ("Route B: transform render mode (fake)");
    {
        auto xt = cmd (ops, "create_track", args1 ("name", "Xform"))["data"].getProperty ("trackId", var()).toString();
        auto xtone = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", xt }, { "seconds", 1.5 }, { "freq", 207.0 }}));
        const auto xcid = xtone["data"].getProperty ("clipId", var()).toString();

        auto crl = cmd (ops, "create_render_layer", objN ({{ "clipId", xcid }, { "adapter", "transform" }, { "mode", "transform" }}));
        check (ok (crl), "create_render_layer (transform) ok");
        cmd (ops, "set_render_param", objN ({{ "clipId", xcid }, { "target", "flute" }, { "strength", 70 }, { "seed", 1 }}));

        auto r1 = cmd (ops, "render_layer", objN ({{ "clipId", xcid }, { "wait", true }}));
        check (ok (r1), "transform render_layer ok (fake transform ran)");
        check (r1["data"].getProperty ("cache", var()).toString() == "miss", "first transform render is a cache MISS");
        check (r1["data"].getProperty ("status", var()).toString() == "ready", "transform render completed -> ready");
        bool xHasArtifact = false;
        { auto trk = trackById (xt);
          if (auto* arr = trk.getProperty ("clips", var()).getArray())
            for (auto& c : *arr) if (c.getProperty ("id", var()).toString() == xcid)
                xHasArtifact = (bool) c.getProperty ("renderLayer", var()).getProperty ("hasArtifact", false); }
        check (xHasArtifact, "transform produced a cached artifact (output.wav)");

        auto r2 = cmd (ops, "render_layer", objN ({{ "clipId", xcid }, { "wait", true }}));
        check (r2["data"].getProperty ("cache", var()).toString() == "hit", "identical transform re-render is a cache HIT");

        // The target is in the fingerprint: changing it must invalidate the cache.
        cmd (ops, "set_render_param", objN ({{ "clipId", xcid }, { "target", "violin" }}));
        auto r3 = cmd (ops, "render_layer", objN ({{ "clipId", xcid }, { "wait", true }}));
        check (r3["data"].getProperty ("cache", var()).toString() == "miss", "changing transform target -> cache MISS");

        // Strength is in the fingerprint too.
        cmd (ops, "set_render_param", objN ({{ "clipId", xcid }, { "strength", 95 }}));
        auto r4 = cmd (ops, "render_layer", objN ({{ "clipId", xcid }, { "wait", true }}));
        check (r4["data"].getProperty ("cache", var()).toString() == "miss", "changing transform strength -> cache MISS");

        // A whole-clip transform on a WAVE clip auto-applies in place too (same as re-imagine).
        auto xLayer = [&] () -> var {
            auto trk = trackById (xt);
            if (auto* arr = trk.getProperty ("clips", var()).getArray())
                for (auto& c : *arr) if (c.getProperty ("id", var()).toString() == xcid)
                    return c.getProperty ("renderLayer", var());
            return {};
        };
        check ((bool) xLayer().getProperty ("appliedInPlace", false), "wave transform AUTO-APPLIES in place");
        check ((bool) xLayer().getProperty ("hasOriginal", false), "transform stored the original (Reset available)");

        // TASTE-002 — the EXPORT trigger: export_audio runs the same render_kept sweep as
        // save. The transform layer is applied and unlogged here; the earlier re-imagine
        // layer was already logged by save — the export must add exactly ONE new label
        // (cross-trigger dedupe on layerId).
        {
            auto keptRows = [&] () -> Array<var>
            {
                Array<var> out;
                for (auto& l : StringArray::fromLines (eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString()))
                {
                    if (! l.contains ("\"render_kept\"")) continue;
                    const auto row = JSON::parse (l);   // named local — the var-temporary UAF class
                    if (row.getProperty ("command", var()).toString() == "render_kept") out.add (row);
                }
                return out;
            };
            check (keptRows().size() == 1, "before the export exactly one render_kept exists (the saved re-imagine layer)");
            auto expFile = eng.sessionDir().getChildFile ("taste-export-trigger.wav");
            check (ok (cmd (ops, "export_audio", objN ({{ "file", expFile.getFullPathName() }, { "format", "wav" }}))),
                   "export_audio ok (render_kept sweep runs on export)");
            auto rows = keptRows();
            check (rows.size() == 2, "export adds exactly ONE render_kept (new transform layer; earlier layer deduped)");
            const auto ea = rows.getLast().getProperty ("args", var());
            check (ea.getProperty ("clipId", var()).toString() == xcid
                       && ea.getProperty ("layerId", var()).toString().isNotEmpty()
                       && ea.getProperty ("cacheKey", var()).toString().isNotEmpty()
                       && ea.getProperty ("adapter", var()).toString() == "transform",
                   "export-triggered render_kept carries the join keys (clipId/layerId/cacheKey/adapter)");
        }

        check (ok (cmd (ops, "reset_render_layer", args1 ("clipId", xcid))), "reset after transform ok");
        check (! (bool) xLayer().getProperty ("appliedInPlace", true), "reset cleared the applied transform");
    }

    // ── LoRA rack: selection round-trip + full-fingerprint cache (fake adapter, hermetic).
    // The rack rides the re-imagine layer as a params modifier (like colours); the real
    // SA3 merge path is covered by verify-hardware, not selftest (service-spawning).
    section ("LoRA rack: params + fingerprint");
    {
        auto lt = cmd (ops, "create_track", args1 ("name", "LoraRack"))["data"].getProperty ("trackId", var()).toString();
        // freq 251 is unique to this section: add_test_tone_clip caches the generated
        // WAV by int(freq) and reuses it (duration is NOT in the key), so sharing a
        // frequency with another section that expects a different duration collides.
        auto ltone = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", lt }, { "seconds", 1.2 }, { "freq", 251.0 }}));
        const auto lcid = ltone["data"].getProperty ("clipId", var()).toString();
        check (ok (cmd (ops, "create_render_layer", objN ({{ "clipId", lcid }, { "adapter", "fake" }, { "mode", "reimagine" }}))),
               "create_render_layer (reimagine, for LoRA rack) ok");

        Array<var> sel;
        { auto* lo = new DynamicObject(); lo->setProperty ("name", "ken-sa3"); lo->setProperty ("value", 100); sel.add (var (lo)); }
        cmd (ops, "set_render_param", objN ({{ "clipId", lcid }, { "seed", 3 }, { "nl", 0.4 }, { "loras", var (sel) }}));

        auto lLayer = [&] () -> var {
            auto trk = trackById (lt);
            if (auto* arr = trk.getProperty ("clips", var()).getArray())
                for (auto& c : *arr) if (c.getProperty ("id", var()).toString() == lcid)
                    return c.getProperty ("renderLayer", var());
            return {};
        };
        { auto lv = lLayer().getProperty ("loras", var());   // keep the var alive past getArray()
          auto* larr = lv.getArray();
          check (larr != nullptr && larr->size() == 1
                 && larr->getReference (0).getProperty ("name", var()).toString() == "ken-sa3"
                 && (double) larr->getReference (0).getProperty ("value", 0) == 100.0,
                 "loras selection round-trips through the snapshot"); }

        auto lr1 = cmd (ops, "render_layer", objN ({{ "clipId", lcid }, { "wait", true }}));
        check (ok (lr1), "render with a LoRA selection ok (fake)");
        check (lr1["data"].getProperty ("cache", var()).toString() == "miss", "first LoRA render is a cache MISS");
        auto lr2 = cmd (ops, "render_layer", objN ({{ "clipId", lcid }, { "wait", true }}));
        check (lr2["data"].getProperty ("cache", var()).toString() == "hit", "identical LoRA re-render is a cache HIT");

        // Strength is in the fingerprint: 100 -> 40 must MISS.
        Array<var> sel40;
        { auto* lo = new DynamicObject(); lo->setProperty ("name", "ken-sa3"); lo->setProperty ("value", 40); sel40.add (var (lo)); }
        cmd (ops, "set_render_param", objN ({{ "clipId", lcid }, { "loras", var (sel40) }}));
        auto lr3 = cmd (ops, "render_layer", objN ({{ "clipId", lcid }, { "wait", true }}));
        check (lr3["data"].getProperty ("cache", var()).toString() == "miss", "LoRA strength change -> cache MISS");

        // Clearing the rack changes the fingerprint too.
        cmd (ops, "set_render_param", objN ({{ "clipId", lcid }, { "loras", Array<var>{} }}));
        auto lr4 = cmd (ops, "render_layer", objN ({{ "clipId", lcid }, { "wait", true }}));
        check (lr4["data"].getProperty ("cache", var()).toString() == "miss", "clearing the LoRA rack -> cache MISS");

        // The rack is UNBOUNDED and UNCLAMPED (owner call — no budget rule): all
        // entries stick in order, and value > 100 (deliberate overdrive) survives.
        Array<var> sel3;
        int v3 = 50;
        for (auto* nm : { "a", "b", "c" })
        { auto* lo = new DynamicObject(); lo->setProperty ("name", juce::String (nm)); lo->setProperty ("value", v3); sel3.add (var (lo)); v3 += 40; }
        cmd (ops, "set_render_param", objN ({{ "clipId", lcid }, { "loras", var (sel3) }}));
        { auto lv = lLayer().getProperty ("loras", var());   // keep the var alive past getArray()
          auto* larr = lv.getArray();
          check (larr != nullptr && larr->size() == 3
                 && larr->getReference (0).getProperty ("name", var()).toString() == "a"
                 && larr->getReference (2).getProperty ("name", var()).toString() == "c",
                 "LoRA rack is unbounded (3 entries, order preserved)");
          check (larr != nullptr && larr->size() == 3
                 && (double) larr->getReference (2).getProperty ("value", 0) == 130.0,
                 "LoRA overdrive (value > 100) survives unclamped"); }
    }

    // ─── NRL-MIDI: generative on a MIDI clip (auto-bounce → audio → model) ───
    // "Generative on ANY track": render_layer on a MIDI clip BOUNCES the track's
    // instrument output to audio first, then runs the same FakeAdapter pipeline. The
    // source MIDI is untouched. Because the bounce isn't bit-deterministic, the cache
    // fingerprint hashes a STABLE SOURCE SIGNATURE (MIDI note fields + instrument/FX
    // names, enabled state, param values + automation), NOT the bounced input.wav — so an
    // identical source HITs and editing a note/instrument busts the cache.
    section ("NRL-MIDI: generative on a MIDI clip (auto-bounce)");
    {
        auto mt = cmd (ops, "create_track", args1 ("name", "MidiGen"))["data"].getProperty ("trackId", var()).toString();
        // A MIDI clip with audible notes (add_midi_clip auto-loads a 4OSC instrument).
        Array<var> notes;
        for (int i = 0; i < 4; ++i) { auto* n = new DynamicObject();
            n->setProperty ("pitch", 60 + i * 2); n->setProperty ("start", (double) i * 0.5);
            n->setProperty ("length", 0.5); n->setProperty ("velocity", 100); notes.add (var (n)); }
        auto mc = cmd (ops, "add_midi_clip", objN ({{ "trackId", mt }, { "length", 2.0 }, { "notes", notes }}));
        check (ok (mc), "add_midi_clip (with notes) ok");
        const auto mcid = mc["data"].getProperty ("clipId", var()).toString();

        auto noteCount = [&] (const String& cid) -> int {
            auto trk = trackById (mt);
            if (auto* arr = trk.getProperty ("clips", var()).getArray())
                for (auto& c : *arr) if (c.getProperty ("id", var()).toString() == cid)
                    return (int) c.getProperty ("notes", var()).size();
            return -1;
        };
        const int notesBefore = noteCount (mcid);
        check (notesBefore == 4, "midi clip has 4 notes before render");

        auto crl = cmd (ops, "create_render_layer", objN ({{ "clipId", mcid }, { "adapter", "fake" }}));
        check (ok (crl), "create_render_layer on a MIDI clip ok");
        const auto layerId = crl["data"].getProperty ("layerId", var()).toString();
        cmd (ops, "set_render_param", objN ({{ "clipId", mcid }, { "seed", 7 }, { "nl", 0.3 }}));

        // The headline: render SUCCEEDS on a MIDI clip (previously errored "only wave
        // clips renderable") — the auto-bounce staged input.wav and the model ran.
        auto r1 = cmd (ops, "render_layer", objN ({{ "clipId", mcid }, { "wait", true }}));
        check (ok (r1), "render_layer on a MIDI clip ok (auto-bounced to audio, model ran)");
        check (r1["data"].getProperty ("status", var()).toString() == "ready", "MIDI render -> status ready");
        check (r1["data"].getProperty ("cache", var()).toString() == "miss", "first MIDI render is a cache MISS");

        // The bounce wrote a real, non-trivial input.wav (audio, not MIDI).
        auto input = eng.sessionDir().getChildFile ("renders").getChildFile (layerId).getChildFile ("input.wav");
        check (input.existsAsFile() && input.getSize() > 1000, "auto-bounce wrote a non-trivial input.wav");

        bool mHasArtifact = false; bool stillMidi = false;
        { auto trk = trackById (mt);
          if (auto* arr = trk.getProperty ("clips", var()).getArray())
            for (auto& c : *arr) if (c.getProperty ("id", var()).toString() == mcid)
            { mHasArtifact = (bool) c.getProperty ("renderLayer", var()).getProperty ("hasArtifact", false);
              stillMidi = c.getProperty ("type", var()).toString() == "midi"; } }
        check (mHasArtifact, "MIDI render produced a cached artifact (output.wav)");

        // The SOURCE clip is untouched — still MIDI, same notes (non-destructive).
        check (stillMidi, "source clip is still a MIDI clip after render");
        check (noteCount (mcid) == notesBefore, "source MIDI clip notes unchanged after render");

        // Identical re-render -> cache HIT (the builtin-synth bounce is deterministic).
        auto r2 = cmd (ops, "render_layer", objN ({{ "clipId", mcid }, { "wait", true }}));
        check (r2["data"].getProperty ("cache", var()).toString() == "hit", "identical MIDI re-render is a cache HIT");

        // Editing a NOTE changes the stable source signature -> cache MISS.
        // (Proves the source-signature fingerprint folds MIDI note content in.)
        cmd (ops, "add_note", objN ({{ "clipId", mcid }, { "pitch", 72 }, { "start", 0.0 }, { "length", 0.5 }, { "velocity", 100 }}));
        auto r3 = cmd (ops, "render_layer", objN ({{ "clipId", mcid }, { "wait", true }}));
        check (r3["data"].getProperty ("cache", var()).toString() == "miss", "editing a note -> source signature changed -> cache MISS");

        // Bypassing the instrument changes the bounced audio AND the source signature ->
        // cache MISS. Guards the enabled-state coverage: a stale render must NOT survive a
        // bypass (the dangerous "serves the wrong audio" direction).
        int instIdx = -1;
        { auto trk = trackById (mt);
          if (auto* arr = trk.getProperty ("plugins", var()).getArray())
            for (auto& pl : *arr) if ((bool) pl.getProperty ("isInstrument", false))
                { instIdx = (int) pl.getProperty ("index", -1); break; } }
        check (instIdx >= 0, "MIDI track has an instrument plugin to bypass");
        cmd (ops, "bypass_plugin", objN ({{ "trackId", mt }, { "index", instIdx }, { "bypassed", true } }));
        auto rb = cmd (ops, "render_layer", objN ({{ "clipId", mcid }, { "wait", true }}));
        check (rb["data"].getProperty ("cache", var()).toString() == "miss", "bypassing the instrument -> cache MISS (no stale render served)");

        // Phase 2 — a MIDI/drum re-imagine AUTO-APPLIES beneath the clip: the source MIDI is muted
        // and a HIDDEN, instrument-free audio render plays in its place. The hidden track is EXCLUDED
        // from the snapshot (the producer hears it but never sees it), so the structural proof that
        // the render exists is `reimagineActive` (kSourceMutedByLayer + a live landed clip). No accept
        // step, no "Neural Renders" lane, and no new VISIBLE track.
        auto midiClipVar = [&] () -> var {
            auto trk = trackById (mt);
            if (auto* arr = trk.getProperty ("clips", var()).getArray())
                for (auto& c : *arr) if (c.getProperty ("id", var()).toString() == mcid) return c;
            return {};
        };
        auto reimagineActive = [&] () -> bool {
            return (bool) midiClipVar().getProperty ("renderLayer", var()).getProperty ("reimagineActive", false);
        };
        auto visibleTracks = [&] () -> int {
            auto snap = ops.snapshot();
            auto* arr = snap["tracks"].getArray();
            return arr != nullptr ? arr->size() : 0;
        };
        auto neuralLanesM = [&] () -> int {
            int n = 0; auto snap = ops.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& t : *arr) if (t.getProperty ("name", var()).toString() == "Neural Renders"
                                         || t.getProperty ("name", var()).toString().contains ("hidden")) ++n;
            return n;
        };
        const int tracksBeforeApply = visibleTracks();
        check ((bool) midiClipVar().getProperty ("mute", false), "MIDI source muted under the beneath-render");
        check (reimagineActive(), "MIDI render is active beneath the clip (reimagineActive)");
        check (neuralLanesM() == 0, "no VISIBLE 'Neural Renders'/hidden lane for a MIDI beneath-render");
        check (visibleTracks() == tracksBeforeApply, "the hidden render track is excluded from the snapshot");

        // accept_render is a no-op for the beneath model — no new lane, no extra visible track.
        check (ok (cmd (ops, "accept_render", args1 ("clipId", mcid))), "accept_render (MIDI beneath) ok (no-op)");
        check (neuralLanesM() == 0 && visibleTracks() == tracksBeforeApply, "accept created no lane and no visible track");

        // bypass routes back to the LIVE instrument: the MIDI un-mutes (reimagineActive holds — the
        // hidden clip still exists, just muted).
        check (ok (cmd (ops, "bypass_layer", objN ({{ "clipId", mcid }, { "bypassed", true }}))), "bypass_layer (MIDI) ok");
        check (! (bool) midiClipVar().getProperty ("mute", true), "bypass un-mutes the source MIDI");
        cmd (ops, "bypass_layer", objN ({{ "clipId", mcid }, { "bypassed", false }}));
        check ((bool) midiClipVar().getProperty ("mute", false), "un-bypass re-mutes the source MIDI");

        // reset removes the hidden audio + un-mutes the MIDI (back to the editable instrument).
        check (ok (cmd (ops, "reset_render_layer", args1 ("clipId", mcid))), "reset_render_layer (MIDI) ok");
        check (! (bool) midiClipVar().getProperty ("mute", true), "reset un-muted the MIDI");
        check (! reimagineActive(), "reset cleared reimagineActive (hidden clip gone)");

        // TASTE-002 — the beneath-model reset is the SAME negative taste event: the label
        // must carry the join keys from the layer node (layerId/cacheKey).
        {
            var lastReset;
            for (auto& l : StringArray::fromLines (eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString()))
                if (l.contains ("\"reset_render_layer\""))
                {
                    const auto row = JSON::parse (l);   // named local — the var-temporary UAF class
                    if (row.getProperty ("command", var()).toString() == "reset_render_layer") lastReset = row;
                }
            const auto ba = lastReset.getProperty ("args", var());
            check (ba.getProperty ("clipId", var()).toString() == mcid
                       && ba.getProperty ("layerId", var()).toString().isNotEmpty()
                       && ba.getProperty ("cacheKey", var()).toString().isNotEmpty(),
                   "beneath-model reset logs the taste label with join keys (clipId/layerId/cacheKey)");
        }

        // re-render after reset re-applies beneath (cache HIT re-lands the hidden clip).
        auto rRe = cmd (ops, "render_layer", objN ({{ "clipId", mcid }, { "wait", true }}));
        check (ok (rRe), "re-render after reset (MIDI) ok");
        check (reimagineActive() && (bool) midiClipVar().getProperty ("mute", false),
               "re-render re-applied beneath (reimagineActive, MIDI muted)");

        // remove_render_layer tears down the hidden clip + un-mutes (no strand).
        check (ok (cmd (ops, "remove_render_layer", args1 ("clipId", mcid))), "remove_render_layer (MIDI) ok");
        check (! (bool) midiClipVar().getProperty ("mute", true), "remove_render_layer un-muted the MIDI");
    }

    // ─── Section-scoped render (the agent "rework the hook" path) ───
    // A render layer with an explicit sub-region renders ONLY that region's audio and
    // lands the result bounded to the region — proving create_render_layer
    // regionStart/regionEnd → a sliced input.wav → a region-bounded landing.
    section ("Section-scoped render (rework-the-hook)");
    {
        auto st = cmd (ops, "create_track", args1 ("name", "Scoped"))["data"].getProperty ("trackId", var()).toString();
        auto tone = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", st }, { "seconds", 2.0 }, { "freq", 220.0 }}));
        const auto scid = tone["data"].getProperty ("clipId", var()).toString();

        // Scope to a 0.5 s sub-region [0.5, 1.0] of the 2 s clip.
        auto crl = cmd (ops, "create_render_layer", objN ({{ "clipId", scid }, { "adapter", "fake" },
                                                           { "regionStart", 0.5 }, { "regionEnd", 1.0 }}));
        check (ok (crl), "create_render_layer with a sub-region ok");
        const auto layerId = crl["data"].getProperty ("layerId", var()).toString();

        // The snapshot reports the clamped sub-region, not the whole clip span.
        auto layerVar = [&] () -> var {
            auto trk = trackById (st);
            if (auto* arr = trk.getProperty ("clips", var()).getArray())
                for (auto& c : *arr) if (c.getProperty ("id", var()).toString() == scid)
                    return c.getProperty ("renderLayer", var());
            return {};
        };
        check (std::abs ((double) layerVar().getProperty ("regionStart", -1.0) - 0.5) < 1e-3, "layer region start = 0.5 s");
        check (std::abs ((double) layerVar().getProperty ("regionEnd",   -1.0) - 1.0) < 1e-3, "layer region end   = 1.0 s");

        auto rr = cmd (ops, "render_layer", objN ({{ "clipId", scid }, { "wait", true }}));
        check (ok (rr), "section-scoped render_layer ok");

        // The staged input.wav was SLICED to ~0.5 s — not the whole 2 s clip.
        auto inputWav = eng.sessionDir().getChildFile ("renders").getChildFile (layerId).getChildFile ("input.wav");
        double inputDur = -1.0;
        { AudioFormatManager fm; fm.registerBasicFormats();
          if (std::unique_ptr<AudioFormatReader> rd { fm.createReaderFor (inputWav) }; rd && rd->sampleRate > 0.0)
              inputDur = (double) rd->lengthInSamples / rd->sampleRate; }
        check (inputWav.existsAsFile(), "section render staged an input.wav");
        check (inputDur > 0.3 && inputDur < 0.8, "input.wav is the SECTION region (~0.5 s), not the whole clip (2 s)");

        // Accept lands the render bounded to the region: start ~0.5 s, length ~0.5 s.
        check (ok (cmd (ops, "accept_render", args1 ("clipId", scid))), "section-scoped accept_render ok");
        bool scopedLanding = false;
        { auto snap = ops.snapshot();
          if (auto* arr = snap["tracks"].getArray())
            for (auto& t : *arr) if (t.getProperty ("name", var()).toString() == "Neural Renders")
                if (auto* cs = t.getProperty ("clips", var()).getArray())
                    for (auto& c : *cs)
                    {
                        const double cstart = (double) c.getProperty ("start", -1.0);
                        const double clen   = (double) c.getProperty ("length", -1.0);
                        if (std::abs (cstart - 0.5) < 0.05 && std::abs (clen - 0.5) < 0.1) scopedLanding = true;
                    } }
        check (scopedLanding, "accepted render landed bounded to the section (start ~0.5 s, length ~0.5 s)");

        // METER-001 — the auto-created "Neural Renders" lane is metered too (no explicit
        // enable_track_meter call), same as any other track-creation path.
        bool neuralLaneMetered = false;
        { auto snap = ops.snapshot();
          if (auto* arr = snap["tracks"].getArray())
            for (auto& t : *arr) if (t.getProperty ("name", var()).toString() == "Neural Renders")
                neuralLaneMetered = (bool) t.getProperty ("meterEnabled", false); }
        check (neuralLaneMetered, "METER-001: the auto-created Neural Renders lane is metered");

        // A whole-clip render (no region) still works — guards the default path.
        auto st2 = cmd (ops, "create_track", args1 ("name", "Whole"))["data"].getProperty ("trackId", var()).toString();
        auto tone2 = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", st2 }, { "seconds", 1.0 }, { "freq", 180.0 }}));
        const auto wcid = tone2["data"].getProperty ("clipId", var()).toString();
        cmd (ops, "create_render_layer", objN ({{ "clipId", wcid }, { "adapter", "fake" }}));
        check (ok (cmd (ops, "render_layer", objN ({{ "clipId", wcid }, { "wait", true }}))),
               "whole-clip render (no region) still renders (default path unchanged)");

        // REGRESSION (review): the stored timeRange is frozen at create. A WHOLE-clip
        // layer whose clip is MOVED after creation must still render (whole source) and
        // land at the clip's LIVE position — the staging/landing clamp to the live clip
        // prevents a stale-region mis-stage (hard error) or a stale landing.
        auto mvt = cmd (ops, "create_track", args1 ("name", "Moved"))["data"].getProperty ("trackId", var()).toString();
        auto mvtone = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", mvt }, { "seconds", 1.0 }, { "freq", 175.0 }}));
        const auto mvcid = mvtone["data"].getProperty ("clipId", var()).toString();
        cmd (ops, "create_render_layer", objN ({{ "clipId", mvcid }, { "adapter", "fake" }}));   // whole-clip, no region
        cmd (ops, "move_clip", objN ({{ "clipId", mvcid }, { "start", 3.0 }}));                  // move AFTER create
        check (ok (cmd (ops, "render_layer", objN ({{ "clipId", mvcid }, { "wait", true }}))),
               "whole-clip layer still renders after the clip moved (no stale-region error)");
        check (ok (cmd (ops, "accept_render", args1 ("clipId", mvcid))), "accept after move ok");
        bool landedAtLive = false;
        { auto snap = ops.snapshot();
          if (auto* arr = snap["tracks"].getArray())
            for (auto& t : *arr) if (t.getProperty ("name", var()).toString() == "Neural Renders")
                if (auto* cs2 = t.getProperty ("clips", var()).getArray())
                    for (auto& c : *cs2)
                        if (std::abs ((double) c.getProperty ("start", -1.0) - 3.0) < 0.05) landedAtLive = true; }
        check (landedAtLive, "moved whole-clip render lands at the clip's LIVE position (3.0 s), not the stale create spot");
    }

    // ─── bounce_layer_to_clip: the "bounced" relabel rides the undo history ───
    // BUG (found wiring UI reachability): cmdBounceLayerToClip wrote status="bounced" with a
    // nullptr UndoManager, while the accept_render it wraps — and cmdFreezeLayer four lines
    // above it — write THROUGH the undo manager. The label therefore desynced from the clip it
    // describes: on the lane path a redo re-landed the clip but lost the "bounced" mark, and on
    // the no-op relabel paths (whole-clip wave / MIDI-beneath, where accept returns early and
    // opens no transaction at all) the mark was untracked entirely and stuck forever. A UI gate
    // keyed on status != "bounced" would then hide its own button permanently, so this is a
    // prerequisite for ever wiring that control (UI_REACH_GAPS).
    section ("bounce_layer_to_clip is undo-tracked");
    {
        auto statusOf = [&] (const String& trackId, const String& clipId) -> String {
            auto trk = trackById (trackId);
            if (auto* arr = trk.getProperty ("clips", var()).getArray())
                for (auto& c : *arr)
                    if (c.getProperty ("id", var()).toString() == clipId)
                        return c.getProperty ("renderLayer", var()).getProperty ("status", var()).toString();
            return {};
        };
        auto nameOf = [&] (const String& trackId, const String& clipId) -> String {
            auto trk = trackById (trackId);
            if (auto* arr = trk.getProperty ("clips", var()).getArray())
                for (auto& c : *arr)
                    if (c.getProperty ("id", var()).toString() == clipId)
                        return c.getProperty ("name", var()).toString();
            return {};
        };
        auto neuralClipCount = [&] () -> int {
            int n = 0;
            auto snap = ops.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& t : *arr)
                    if (t.getProperty ("name", var()).toString() == "Neural Renders")
                        if (auto* cs = t.getProperty ("clips", var()).getArray())
                            n += cs->size();
            return n;
        };

        // (a) LANE path — a sub-region render is not applied in place, so the accept wrapped by
        // bounce genuinely lands a clip. One command must be one undo step: undo takes the clip
        // AND the label, redo brings both back.
        auto bt = cmd (ops, "create_track", args1 ("name", "Bounce"))["data"].getProperty ("trackId", var()).toString();
        auto btone = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", bt }, { "seconds", 2.0 }, { "freq", 205.0 }}));
        const auto bcid = btone["data"].getProperty ("clipId", var()).toString();
        check (ok (cmd (ops, "create_render_layer", objN ({{ "clipId", bcid }, { "adapter", "fake" },
                                                           { "regionStart", 0.5 }, { "regionEnd", 1.0 }}))),
               "bounce: create_render_layer (sub-region) ok");
        check (ok (cmd (ops, "render_layer", objN ({{ "clipId", bcid }, { "wait", true }}))),
               "bounce: render_layer ok");

        const int beforeBounce = neuralClipCount();
        check (ok (cmd (ops, "bounce_layer_to_clip", args1 ("clipId", bcid))), "bounce_layer_to_clip ok");
        check (statusOf (bt, bcid) == "bounced", "bounce marked the layer status \"bounced\"");
        check (neuralClipCount() == beforeBounce + 1, "bounce landed the render as a clip on the neural lane");

        check (ok (cmd (ops, "undo")), "bounce: undo ok");
        check (neuralClipCount() == beforeBounce, "undo removed the landed clip");
        check (statusOf (bt, bcid) != "bounced",
               "undo left no \"bounced\" label on a layer whose clip is gone");
        // RED before the fix: the relabel was never recorded, so replaying the transaction
        // restored the clip but not the mark — a bounced layer reading back as merely "ready".
        check (ok (cmd (ops, "redo")), "bounce: redo ok");
        check (neuralClipCount() == beforeBounce + 1, "redo re-landed the bounced clip");
        check (statusOf (bt, bcid) == "bounced", "redo restored the \"bounced\" label with its clip");

        // (b) NO-OP relabel path — a whole-clip wave render auto-applies in place, so the
        // wrapped accept returns early without opening a transaction. The relabel must still be
        // its own undo step: neither stuck forever (untracked) nor folded into whatever command
        // happened to run before it (which undo would then destroy along with the label).
        auto wt = cmd (ops, "create_track", args1 ("name", "BounceWhole"))["data"].getProperty ("trackId", var()).toString();
        auto wtone = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", wt }, { "seconds", 1.0 }, { "freq", 195.0 }}));
        const auto wcid2 = wtone["data"].getProperty ("clipId", var()).toString();
        cmd (ops, "create_render_layer", objN ({{ "clipId", wcid2 }, { "adapter", "fake" }}));
        check (ok (cmd (ops, "render_layer", objN ({{ "clipId", wcid2 }, { "wait", true }}))),
               "bounce (whole clip): render_layer ok");

        const int beforeNoop = neuralClipCount();
        check (ok (cmd (ops, "rename_clip", objN ({{ "clipId", wcid2 }, { "name", "sentinel" }}))),
               "bounce (whole clip): sentinel edit before the bounce ok");
        check (ok (cmd (ops, "bounce_layer_to_clip", args1 ("clipId", wcid2))),
               "bounce_layer_to_clip (whole clip, no-op relabel) ok");
        check (statusOf (wt, wcid2) == "bounced", "whole-clip bounce marked the layer \"bounced\"");
        check (neuralClipCount() == beforeNoop, "whole-clip bounce landed no lane clip (applied in place)");

        check (ok (cmd (ops, "undo")), "bounce (whole clip): undo ok");
        check (statusOf (wt, wcid2) != "bounced",
               "undo cleared the \"bounced\" label (not stuck forever behind a null UndoManager)");
        check (nameOf (wt, wcid2) == "sentinel",
               "undoing the relabel did NOT also revert the preceding edit");
    }
}

} // namespace mosh
