#include "Lift.h"

namespace mosh::ir
{
using namespace juce;

namespace
{
    DynamicObject* obj() { return new DynamicObject(); }

    var op (const char* kind, DynamicObject* params, const String& out = {})
    {
        auto* o = obj();
        o->setProperty ("kind", kind);
        o->setProperty ("params", var (params));
        if (out.isNotEmpty()) o->setProperty ("out", out);
        return var (o);
    }

    var one (var v)                 { Array<var> a; a.add (v); return var (a); }
    var two (var a1, var a2)        { Array<var> a; a.add (a1); a.add (a2); return var (a); }
    var none()                      { return var (Array<var>()); }

    String trackSym (const var& v)  { return "t" + v.toString(); }
    String clipSym (const var& v)   { return "c" + v.toString(); }

    double bpmOf (te::Edit& edit)
    {
        return edit.tempoSequence.getBpmAt (tracktion::TimePosition());
    }

    double beatsPerBarOf (te::Edit& edit)
    {
        auto& ts = edit.tempoSequence.getTimeSigAt (tracktion::TimePosition());
        return (double) ts.numerator.get() * 4.0 / (double) jmax (1, ts.denominator.get());
    }

    int secondsToBar (te::Edit& edit, double seconds)
    {
        const double beats = edit.tempoSequence.toBeats (
            tracktion::TimePosition::fromSeconds (seconds)).inBeats();
        return 1 + (int) std::lround (beats / beatsPerBarOf (edit));
    }

    double secondsToBeats (te::Edit& edit, double seconds)
    {
        return edit.tempoSequence.toBeats (tracktion::TimePosition::fromSeconds (seconds)).inBeats();
    }
}

juce::var lift (const String& command, const var& args, const var& result, te::Edit& edit)
{
    const auto data = result.getProperty ("data", var());

    // ── project ──────────────────────────────────────────────────────────
    if (command == "set_tempo")
    {
        auto* p = obj(); p->setProperty ("bpm", args.getProperty ("bpm", 120.0));
        if (args.hasProperty ("atBar"))
            p->setProperty ("at_bar", args.getProperty ("atBar", 1));   // v0.3
        return one (op ("project.set_tempo", p));
    }
    if (command == "set_time_sig")
    {
        auto* p = obj();
        p->setProperty ("num", args.getProperty ("numerator", 4));
        p->setProperty ("denom", args.getProperty ("denominator", 4));
        return one (op ("project.set_time_sig", p));
    }
    if (command == "set_key")
    {
        auto* p = obj();
        p->setProperty ("root", args.getProperty ("root", var()));
        p->setProperty ("scale", args.getProperty ("scale", var()));
        return one (op ("project.set_key", p));
    }

    // ── tracks ───────────────────────────────────────────────────────────
    if (command == "create_track")
    {
        auto* p = obj();
        p->setProperty ("track_id", trackSym (data.getProperty ("trackId", var())));
        p->setProperty ("kind", "audio");
        if (auto name = args.getProperty ("name", var()).toString(); name.isNotEmpty())
            p->setProperty ("name", name);
        return one (op ("track.create", p));
    }
    if (command == "rename_track")
    {
        auto* p = obj();
        p->setProperty ("track_id", trackSym (args.getProperty ("trackId", var())));
        p->setProperty ("name", args.getProperty ("name", var()));
        return one (op ("track.rename", p));
    }
    if (command == "remove_track")
    {
        auto* p = obj();
        p->setProperty ("track_id", trackSym (args.getProperty ("trackId", var())));
        return one (op ("track.delete", p));
    }
    if (command == "route_track")
    {
        const auto dest = args.getProperty ("destTrackId", var()).toString();
        if (dest.isEmpty()) return none();
        auto* p = obj();
        p->setProperty ("track_id", trackSym (args.getProperty ("trackId", var())));
        p->setProperty ("to", trackSym (dest));
        return one (op ("track.route", p));
    }

    // ── clips / samples ──────────────────────────────────────────────────
    if (command == "import_clip")
    {
        const auto file = File (args.getProperty ("file", var()).toString());
        const auto assetSym = "a" + data.getProperty ("clipId", var()).toString();
        auto* rp = obj();
        auto* desc = obj();
        desc->setProperty ("text", file.getFileNameWithoutExtension());
        rp->setProperty ("descriptor", var (desc));
        Array<var> strat; strat.add ("local");
        rp->setProperty ("strategy", strat);

        auto* pp = obj();
        pp->setProperty ("clip_id", clipSym (data.getProperty ("clipId", var())));
        pp->setProperty ("track_id", trackSym (data.getProperty ("trackId", var())));
        pp->setProperty ("asset_id", assetSym);
        pp->setProperty ("start_bar", secondsToBar (edit, (double) args.getProperty ("startSeconds", 0.0)));
        return two (op ("asset.resolve", rp, assetSym), op ("sample.place", pp));
    }
    if (command == "add_midi_clip")
    {
        auto* p = obj();
        p->setProperty ("clip_id", clipSym (data.getProperty ("clipId", var())));
        p->setProperty ("track_id", trackSym (data.getProperty ("trackId", var())));
        p->setProperty ("start_bar", secondsToBar (edit, (double) args.getProperty ("start", 0.0)));
        const double lengthBeats = secondsToBeats (edit, (double) args.getProperty ("start", 0.0)
                                                          + (double) args.getProperty ("length", 2.0))
                                   - secondsToBeats (edit, (double) args.getProperty ("start", 0.0));
        p->setProperty ("length_beats", jmax (0.25, lengthBeats));
        p->setProperty ("kind", "midi");
        auto clipCreate = op ("clip.create", p);

        if (auto notes = args.getProperty ("notes", var()); notes.isArray() && notes.size() > 0)
        {
            auto* np = obj();
            np->setProperty ("clip_id", clipSym (data.getProperty ("clipId", var())));
            Array<var> irNotes;
            for (auto& n : *notes.getArray())
            {
                auto* nn = obj();
                nn->setProperty ("pitch", n.getProperty ("pitch", 60));
                nn->setProperty ("start_beats", n.getProperty ("start", 0.0));
                nn->setProperty ("dur_beats", n.getProperty ("length", 1.0));
                nn->setProperty ("vel", n.getProperty ("velocity", 100));
                irNotes.add (var (nn));
            }
            np->setProperty ("notes", irNotes);
            return two (clipCreate, op ("notes.add", np));
        }
        return one (clipCreate);
    }
    if (command == "move_clip")
    {
        auto* p = obj();
        p->setProperty ("clip_id", clipSym (args.getProperty ("clipId", var())));
        p->setProperty ("start_bar", secondsToBar (edit, (double) args.getProperty ("start", 0.0)));
        if (args.hasProperty ("trackId"))
            p->setProperty ("track_id", trackSym (args.getProperty ("trackId", var())));
        return one (op ("clip.move", p));
    }
    if (command == "remove_clip")
    {
        auto* p = obj();
        p->setProperty ("clip_id", clipSym (args.getProperty ("clipId", var())));
        return one (op ("clip.delete", p));
    }
    if (command == "rename_clip")
    {
        auto* p = obj();
        p->setProperty ("clip_id", clipSym (args.getProperty ("clipId", var())));
        p->setProperty ("name", args.getProperty ("name", var()));
        return one (op ("clip.rename", p));
    }
    if (command == "nudge_notes")
    {
        auto* p = obj();
        p->setProperty ("clip_id", clipSym (args.getProperty ("clipId", var())));
        p->setProperty ("offset_beats", args.getProperty ("offsetBeats", 0.0));
        if (auto pv = args.getProperty ("pitches", var()); pv.isArray())
            p->setProperty ("pitches", pv);
        if (args.hasProperty ("rangeStartBeats"))
        {
            auto* r = obj();
            r->setProperty ("start_beats", args.getProperty ("rangeStartBeats", 0.0));
            r->setProperty ("length_beats", args.getProperty ("rangeLengthBeats", 0.0));
            p->setProperty ("range", var (r));
        }
        return one (op ("notes.nudge", p));
    }
    if (command == "set_track_mute" || command == "set_track_solo")
    {
        // v0.3: mute/solo finally have IR shapes (the Stage-9 lift gap).
        auto* p = obj();
        p->setProperty ("track_id", trackSym (args.getProperty ("trackId", var())));
        p->setProperty ("on", args.getProperty (command == "set_track_mute" ? "mute" : "solo", false));
        return one (op (command == "set_track_mute" ? "mixer.mute" : "mixer.solo", p));
    }
    if (command == "move_track")
    {
        auto* p = obj();
        p->setProperty ("track_id", trackSym (args.getProperty ("trackId", var())));
        if (args.hasProperty ("beforeTrackId"))
            p->setProperty ("before_track_id", trackSym (args.getProperty ("beforeTrackId", var())));
        return one (op ("track.move", p));
    }
    if (command == "set_master_volume")
    {
        auto* p = obj();
        p->setProperty ("db", args.getProperty ("db", 0.0));
        return one (op ("mixer.set_master_gain", p));
    }
    if (command == "duplicate_clip")
    {
        auto data = result.getProperty ("data", var());
        auto* p = obj();
        p->setProperty ("clip_id", clipSym (args.getProperty ("clipId", var())));
        p->setProperty ("new_clip_id", clipSym (data.getProperty ("clipId", var())));
        if (args.hasProperty ("startSeconds"))
            p->setProperty ("start_bar", secondsToBar (edit, (double) args.getProperty ("startSeconds", 0.0)));
        return one (op ("clip.duplicate", p));
    }
    if (command == "set_clip_pitch")
    {
        auto* p = obj();
        p->setProperty ("clip_id", clipSym (args.getProperty ("clipId", var())));
        p->setProperty ("semitones", args.getProperty ("semitones", 0.0));
        return one (op ("sample.pitch", p));
    }
    if (command == "set_clip_stretch")
    {
        auto* p = obj();
        p->setProperty ("clip_id", clipSym (args.getProperty ("clipId", var())));
        p->setProperty ("ratio", args.getProperty ("ratio", 1.0));
        return one (op ("sample.stretch", p));
    }

    // ── notes ────────────────────────────────────────────────────────────
    if (command == "update_notes")
    {
        // Lossless in the v0.2 vocabulary: one notes.remove + notes.add pair
        // per edit, re-adding the FINAL values the command resolved
        // (result.data.notes — set-fields applied over the matched note).
        const auto clip = clipSym (args.getProperty ("clipId", var()));
        auto finals = result.getProperty ("data", var()).getProperty ("notes", var());
        Array<var> ops;
        if (finals.isArray())
            for (auto& f : *finals.getArray())
            {
                auto* rem = obj();
                rem->setProperty ("clip_id", clip);
                Array<var> pitches; pitches.add (f.getProperty ("matchPitch", 0));
                rem->setProperty ("pitches", pitches);
                auto* range = obj();
                range->setProperty ("start_beats", (double) f.getProperty ("matchStartBeats", 0.0) - 0.01);
                range->setProperty ("length_beats", 0.02);
                rem->setProperty ("range", var (range));
                ops.add (op ("notes.remove", rem));

                auto* add = obj();
                add->setProperty ("clip_id", clip);
                auto* nn = obj();
                nn->setProperty ("pitch", f.getProperty ("pitch", 60));
                nn->setProperty ("start_beats", f.getProperty ("startBeats", 0.0));
                nn->setProperty ("dur_beats", f.getProperty ("durBeats", 0.25));
                nn->setProperty ("vel", f.getProperty ("vel", 100));
                Array<var> irNotes; irNotes.add (var (nn));
                add->setProperty ("notes", irNotes);
                ops.add (op ("notes.add", add));
            }
        return var (ops);
    }
    if (command == "add_notes")
    {
        auto* p = obj();
        p->setProperty ("clip_id", clipSym (args.getProperty ("clipId", var())));
        Array<var> irNotes;
        if (auto notes = args.getProperty ("notes", var()); notes.isArray())
            for (auto& n : *notes.getArray())
            {
                auto* nn = obj();
                nn->setProperty ("pitch", n.getProperty ("pitch", 60));
                nn->setProperty ("start_beats", n.getProperty ("startBeats", 0.0));
                nn->setProperty ("dur_beats", n.getProperty ("durBeats", 1.0));
                nn->setProperty ("vel", n.getProperty ("vel", 100));
                irNotes.add (var (nn));
            }
        if (irNotes.isEmpty()) return none();
        p->setProperty ("notes", irNotes);
        return one (op ("notes.add", p));
    }
    if (command == "transpose_notes")
    {
        auto* p = obj();
        p->setProperty ("clip_id", clipSym (args.getProperty ("clipId", var())));
        p->setProperty ("semitones", args.getProperty ("semitones", 0));
        return one (op ("notes.transpose", p));
    }
    if (command == "quantize_notes")
    {
        const double grid = (double) args.getProperty ("gridBeats", 0.25);
        auto* p = obj();
        p->setProperty ("clip_id", clipSym (args.getProperty ("clipId", var())));
        p->setProperty ("grid", grid >= 1.0 ? "1/4" : grid >= 0.5 ? "1/8"
                                  : grid >= 0.25 ? "1/16" : "1/32");
        p->setProperty ("strength", args.getProperty ("strength", 1.0));
        if (args.hasProperty ("swing"))
            p->setProperty ("swing", args.getProperty ("swing", 0.0));   // v0.3
        return one (op ("notes.quantize", p));
    }
    if (command == "humanize_notes")
    {
        auto* p = obj();
        p->setProperty ("clip_id", clipSym (args.getProperty ("clipId", var())));
        p->setProperty ("timing_ms", (double) args.getProperty ("timingBeats", 0.0) * 60000.0 / jmax (1.0, bpmOf (edit)));
        p->setProperty ("vel_var", args.getProperty ("velVar", 0.0));
        p->setProperty ("seed", args.getProperty ("seed", 0));
        return one (op ("notes.humanize", p));
    }

    // ── devices ──────────────────────────────────────────────────────────
    if (command == "load_plugin" || command == "load_builtin_plugin" || command == "add_neural_insert")
    {
        auto* p = obj();
        const auto trackId = args.getProperty ("trackId", var()).toString();
        p->setProperty ("device_id", "d" + trackId + "x" + data.getProperty ("index", var()).toString());
        p->setProperty ("track_id", trackSym (trackId));
        Array<var> prefer;
        if (command == "load_plugin")
        {
            p->setProperty ("role", "util");           // external role unknown from the call alone
            prefer.add (args.getProperty ("pluginId", var()).toString());
        }
        else if (command == "add_neural_insert")
        {
            p->setProperty ("role", "saturator");
            prefer.add ("builtin.sat");
        }
        else
        {
            const auto type = args.getProperty ("type", var()).toString();
            p->setProperty ("role", type == "sampler" ? "sampler"
                                   : type == "4osc" ? "synth"
                                   : type == "compressor" ? "comp"
                                   : type == "eq" ? "eq"
                                   : type == "delay" ? "delay"
                                   : type == "reverb" ? "reverb"
                                   : type == "lowpass" ? "filter" : "util");
            prefer.add ("builtin." + (type == "4osc" ? String ("synth") : type));
        }
        p->setProperty ("prefer", prefer);
        return one (op ("device.add", p));
    }
    if (command == "set_plugin_param" || command == "set_neural_param")
    {
        auto* p = obj();
        const auto trackId = args.getProperty ("trackId", var()).toString();
        p->setProperty ("device_id", "d" + trackId + "x" + args.getProperty ("index", var()).toString());
        if (command == "set_neural_param")
        {
            p->setProperty ("param", args.getProperty ("paramId", var()));
            p->setProperty ("value_norm", jlimit (0.0, 1.0, (double) args.getProperty ("value", 0.0) / 100.0));
        }
        else
        {
            if (args.hasProperty ("paramName")) p->setProperty ("param", args.getProperty ("paramName", var()));
            else                                p->setProperty ("param", args.getProperty ("paramIndex", 0));
            p->setProperty ("value_norm", args.getProperty ("value", 0.0));
        }
        return one (op ("device.set_param", p));
    }
    if (command == "bypass_plugin")
    {
        auto* p = obj();
        const auto trackId = args.getProperty ("trackId", var()).toString();
        p->setProperty ("device_id", "d" + trackId + "x" + args.getProperty ("index", var()).toString());
        p->setProperty ("bypassed", args.getProperty ("bypassed", false));
        return one (op ("device.bypass", p));
    }

    // ── mixer ────────────────────────────────────────────────────────────
    if (command == "set_track_volume")
    {
        auto* p = obj();
        p->setProperty ("track_id", trackSym (args.getProperty ("trackId", var())));
        p->setProperty ("db", args.getProperty ("db", 0.0));
        return one (op ("mixer.set_gain", p));
    }
    if (command == "set_track_pan")
    {
        auto* p = obj();
        p->setProperty ("track_id", trackSym (args.getProperty ("trackId", var())));
        p->setProperty ("pan", args.getProperty ("pan", 0.0));
        return one (op ("mixer.set_pan", p));
    }
    if (command == "add_send")
    {
        auto* p = obj();
        p->setProperty ("track_id", trackSym (args.getProperty ("trackId", var())));
        p->setProperty ("to_bus", "bus" + args.getProperty ("busNumber", var()).toString());
        p->setProperty ("db", args.getProperty ("gainDb", 0.0));
        return one (op ("mixer.send", p));
    }
    if (command == "set_sidechain")
    {
        auto* p = obj();
        p->setProperty ("src", trackSym (args.getProperty ("sourceTrackId", var())));
        p->setProperty ("dst", trackSym (args.getProperty ("trackId", var())));
        p->setProperty ("amount", jlimit (0.0, 1.0, -(double) args.getProperty ("thresholdDb", -20.0) / 40.0));
        if (args.hasProperty ("ratio")) p->setProperty ("ratio", args.getProperty ("ratio", 4.0));
        return one (op ("mixer.sidechain", p));
    }

    // ── arrangement / render ─────────────────────────────────────────────
    if (command == "create_section")
    {
        auto* p = obj();
        p->setProperty ("name", args.getProperty ("name", var()));
        p->setProperty ("start_bar", args.getProperty ("startBar", 1));
        p->setProperty ("length_bars", args.getProperty ("lengthBars", 1));
        return one (op ("arrange.create_section", p));
    }
    if (command == "save")
        return one (op ("render.commit", obj()));
    if (command == "export_audio")
    {
        auto* p = obj();
        return one (op ("render.bounce", p, "bounce"));
    }
    if (command == "generate_asset")
    {
        const bool a2a = args.getProperty ("mode", "text_to_audio").toString() == "audio_to_audio";
        auto* p = obj();
        p->setProperty ("seed", args.getProperty ("seed", 0));
        p->setProperty ("model_version", args.getProperty ("adapter", "fake").toString() + "-lifted");
        const auto out = "a" + File (args.getProperty ("file", var()).toString()).getFileNameWithoutExtension();
        if (a2a)
        {
            p->setProperty ("asset_id", "a" + File (args.getProperty ("initFile", var()).toString()).getFileNameWithoutExtension());
            p->setProperty ("strength", args.getProperty ("strength", 0.4));
            return one (op ("latent.variate", p, out));
        }
        p->setProperty ("prompt", args.getProperty ("prompt", ""));
        p->setProperty ("duration_beats", secondsToBeats (edit, (double) args.getProperty ("seconds", 4.0)));
        return one (op ("latent.generate", p, out));
    }

    // No IR family (mute/solo, RenderLayer flow, transport, queries, editors):
    // the native record carries it; v0.2 candidates noted in the ledger review.
    return none();
}

} // namespace mosh::ir
