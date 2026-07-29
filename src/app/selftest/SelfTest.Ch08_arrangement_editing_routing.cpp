// ── SelfTest.Ch08_arrangement_editing_routing.cpp — runSelfTest chapter 8 (RFC 002 A-PR6) ──
// Sections moved VERBATIM from src/app/SelfTest.cpp (pre-split lines 1416-1875), in
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

void runChapter08_arrangement_editing_routing (selftest::SelfTestCtx& ctx)
{
    using namespace juce;
    auto& eng = *ctx.eng;
    auto& ops = *ctx.ops;
    auto& trackById = ctx.trackById;

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
}

} // namespace mosh
