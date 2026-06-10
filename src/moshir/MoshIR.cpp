#include "MoshIR.h"
#include "MoshIRVocab.h"

namespace mosh::ir
{
using namespace juce;

namespace
{
    const Identifier MOSH_IR_BINDINGS ("MOSH_IR_BINDINGS");
    const Identifier BINDING ("BINDING");
    const Identifier MOSH_ARRANGE ("MOSH_ARRANGE");

    DynamicObject* obj() { return new DynamicObject(); }
}

Executor::Executor (MoshOps& opsToUse, MoshEngine& engineToUse)
    : ops (opsToUse), eng (engineToUse)
{
    const auto overridePath = SystemStats::getEnvironmentVariable ("MOSH_GAP_LEDGER", {});
    ledgerFile = overridePath.isNotEmpty() ? File (overridePath)
                                           : eng.sessionDir().getChildFile ("gap-ledger.jsonl");
    loadBindings();
}

StringArray Executor::opKinds()
{
    StringArray out;
    for (auto* k : kOpKinds) out.add (k);
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry
// ─────────────────────────────────────────────────────────────────────────────
juce::var Executor::executeOps (const juce::var& args)
{
    auto opsArr = args.getProperty ("ops", var());
    if (! opsArr.isArray())
        return MoshOps::errResult ("execute_ir", "missing 'ops' array");

    const auto tutorialId = args.getProperty ("tutorialId", var()).toString();
    const bool dryRun = (bool) args.getProperty ("dryRun", false);

    Array<var> results;
    int executed = 0, unsupported = 0, failed = 0;

    for (int i = 0; i < opsArr.size(); ++i)
    {
        const auto& op = opsArr[i];
        var r;
        if (dryRun)
        {
            // Validation only — lowering of later ops depends on bindings
            // created by earlier ones, so a dry run cannot lower faithfully.
            const auto kind = op.getProperty ("kind", var()).toString();
            r = opKinds().contains (kind)
                    ? okOp (kind, {})
                    : failOp (kind, "validate", "unknown op kind: " + kind);
        }
        else
        {
            r = runOp (op, tutorialId);
        }

        if (auto* o = r.getDynamicObject()) o->setProperty ("index", i);
        const bool opOk = (bool) r.getProperty ("ok", false);
        const bool opUnsupported = r.hasProperty ("unsupported");
        if (opOk) ++executed;
        else if (opUnsupported) ++unsupported;
        else ++failed;
        results.add (r);
    }

    saveBindings();

    auto* counts = obj();
    counts->setProperty ("executed", executed);
    counts->setProperty ("unsupported", unsupported);
    counts->setProperty ("failed", failed);

    auto* data = obj();
    data->setProperty ("irVersion", kIrVersion);
    data->setProperty ("results", results);
    data->setProperty ("counts", var (counts));
    // Strict ok = nothing failed; Unsupported is a *finding*, reported but
    // not a hard failure (the caller decides — extraction grades on L0).
    return failed == 0 ? MoshOps::okResult ("execute_ir", var (data))
                       : [&] { auto r = MoshOps::errResult ("execute_ir",
                                  String (failed) + " op(s) failed");
                               r.getDynamicObject()->setProperty ("data", var (data));
                               return r; }();
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-op dispatch
// ─────────────────────────────────────────────────────────────────────────────
juce::var Executor::runOp (const juce::var& op, const juce::String& tutorialId)
{
    const auto kind = op.getProperty ("kind", var()).toString();
    const auto p    = op.getProperty ("params", var (obj()));
    const auto out  = op.getProperty ("out", var()).toString();

    if (! opKinds().contains (kind))
        return failOp (kind, "validate", "unknown op kind: " + kind);

    auto trackId = [&] (const char* key = "track_id") -> String
    {
        if (auto* b = find (p.getProperty (key, var()).toString(), "track")) return b->ref;
        return {};
    };
    auto clipId = [&] (const char* key = "clip_id") -> String
    {
        if (auto* b = find (p.getProperty (key, var()).toString(), "clip")) return b->ref;
        return {};
    };
    auto needTrack = [&] (const char* key = "track_id") { return failOp (kind, "validate",
        String ("unbound track id: ") + p.getProperty (key, var()).toString()); };
    auto needClip = [&] (const char* key = "clip_id") { return failOp (kind, "validate",
        String ("unbound clip id: ") + p.getProperty (key, var()).toString()); };

    // ── project ──────────────────────────────────────────────────────────
    if (kind == "project.set_tempo")
    {
        auto* a = obj(); a->setProperty ("bpm", p.getProperty ("bpm", 0.0));
        auto r = run ("set_tempo", a);
        return succeeded (r) ? okOp (kind, { "set_tempo" })
                             : failOp (kind, "execute", r.getProperty ("error", "").toString());
    }
    if (kind == "project.set_time_sig")
    {
        auto* a = obj();
        a->setProperty ("numerator", p.getProperty ("num", 4));
        a->setProperty ("denominator", p.getProperty ("denom", 4));
        auto r = run ("set_time_sig", a);
        return succeeded (r) ? okOp (kind, { "set_time_sig" })
                             : failOp (kind, "execute", r.getProperty ("error", "").toString());
    }
    if (kind == "project.set_key")
    {
        auto* a = obj();
        a->setProperty ("root", p.getProperty ("root", var()));
        a->setProperty ("scale", p.getProperty ("scale", var()));
        auto r = run ("set_key", a);
        return succeeded (r) ? okOp (kind, { "set_key" })
                             : failOp (kind, "execute", r.getProperty ("error", "").toString());
    }
    if (kind == "project.set_swing")
        return unsupportedOp (op, "engine has no global groove/swing (per-clip groove templates only)",
                              "project.set_swing", tutorialId);

    // ── track ────────────────────────────────────────────────────────────
    if (kind == "track.create")
    {
        const auto sym = p.getProperty ("track_id", var()).toString();
        if (sym.isEmpty()) return failOp (kind, "validate", "missing track_id");
        if (bindingExists (sym)) return failOp (kind, "validate", "id already bound: " + sym);

        auto name = p.getProperty ("name", var()).toString();
        if (name.isEmpty()) name = sym;
        auto* a = obj(); a->setProperty ("name", name);
        auto r = run ("create_track", a);
        if (! succeeded (r)) return failOp (kind, "execute", r.getProperty ("error", "").toString());

        Binding b; b.kind = "track";
        b.ref  = r.getProperty ("data", var()).getProperty ("trackId", var()).toString();
        b.type = p.getProperty ("kind", "audio").toString();   // audio|midi|bus — engine tracks are uniform
        bind (sym, b);
        auto* data = obj(); data->setProperty ("trackId", b.ref);
        return okOp (kind, { "create_track" }, var (data));
    }
    if (kind == "track.rename")
    {
        const auto id = trackId(); if (id.isEmpty()) return needTrack();
        auto* a = obj();
        a->setProperty ("trackId", id);
        a->setProperty ("name", p.getProperty ("name", var()));
        auto r = run ("rename_track", a);
        return succeeded (r) ? okOp (kind, { "rename_track" })
                             : failOp (kind, "execute", r.getProperty ("error", "").toString());
    }
    if (kind == "track.set_role")
    {
        // Role is IR/corpus metadata; nothing audible changes. Record it on the
        // binding so future ops (and the lift in Stage 9) can read it back.
        const auto sym = p.getProperty ("track_id", var()).toString();
        auto it = bindings.find (sym);
        if (it == bindings.end() || it->second.kind != "track") return needTrack();
        it->second.type = p.getProperty ("role", var()).toString();
        return okOp (kind, {});
    }
    if (kind == "track.route")
    {
        const auto id = trackId(); if (id.isEmpty()) return needTrack();
        const auto destSym = p.getProperty ("to", var()).toString();
        auto* dest = find (destSym, "track");
        if (dest == nullptr) return failOp (kind, "validate", "unbound dest id: " + destSym);
        auto* a = obj();
        a->setProperty ("trackId", id);
        a->setProperty ("destTrackId", dest->ref);
        auto r = run ("route_track", a);
        return succeeded (r) ? okOp (kind, { "route_track" })
                             : failOp (kind, "execute", r.getProperty ("error", "").toString());
    }
    if (kind == "track.delete")
    {
        const auto sym = p.getProperty ("track_id", var()).toString();
        const auto id = trackId(); if (id.isEmpty()) return needTrack();
        auto* a = obj(); a->setProperty ("trackId", id);
        auto r = run ("remove_track", a);
        if (! succeeded (r)) return failOp (kind, "execute", r.getProperty ("error", "").toString());
        bindings.erase (sym);
        return okOp (kind, { "remove_track" });
    }

    // ── asset / latent ───────────────────────────────────────────────────
    if (kind == "asset.resolve")
        return lowerAssetResolve (p, out, tutorialId);
    if (kind.startsWith ("latent."))
    {
        // Stochastic contract first: unseeded/unpinned latent ops are rejected,
        // not ledgered (§4.3) — there is no default seed and no floating model.
        if (! p.hasProperty ("seed"))
            return failOp (kind, "validate", "seed required (stochastic op, no default seed)");
        if (! p.hasProperty ("model_version"))
            return failOp (kind, "validate", "model_version required on latent ops");

        const auto modelVersion = p.getProperty ("model_version", var()).toString();
        const auto adapter = modelVersion.containsIgnoreCase ("sa3") ? String ("stable_audio3")
                                                                     : String ("fake");

        if (kind == "latent.generate")
        {
            if (out.isEmpty()) return failOp (kind, "validate", "latent.generate requires 'out'");
            if (bindingExists (out)) return failOp (kind, "validate", "id already bound: " + out);
            auto file = eng.sessionDir().getChildFile ("renders").getChildFile (out + ".wav");
            auto* a = obj();
            a->setProperty ("mode", "text_to_audio");
            a->setProperty ("prompt", p.getProperty ("prompt", ""));
            a->setProperty ("seconds", beatsToSeconds ((double) p.getProperty ("duration_beats", 8.0)));
            a->setProperty ("seed", p.getProperty ("seed", 0));
            a->setProperty ("adapter", adapter);
            a->setProperty ("file", file.getFullPathName());
            auto r = run ("generate_asset", a);
            if (! succeeded (r)) return failOp (kind, "execute", r.getProperty ("error", "").toString());
            Binding b; b.kind = "asset"; b.ref = file.getFullPathName();
            bind (out, b);
            return okOp (kind, { "generate_asset" }, r.getProperty ("data", var()));
        }
        if (kind == "latent.variate")
        {
            if (out.isEmpty()) return failOp (kind, "validate", "latent.variate requires 'out'");
            if (bindingExists (out)) return failOp (kind, "validate", "id already bound: " + out);
            auto* src = find (p.getProperty ("asset_id", var()).toString(), "asset");
            if (src == nullptr) return failOp (kind, "validate",
                "unbound asset id: " + p.getProperty ("asset_id", var()).toString());
            auto file = eng.sessionDir().getChildFile ("renders").getChildFile (out + ".wav");
            auto* a = obj();
            a->setProperty ("mode", "audio_to_audio");
            a->setProperty ("initFile", src->ref);
            a->setProperty ("strength", p.getProperty ("strength", 0.4));
            a->setProperty ("seed", p.getProperty ("seed", 0));
            a->setProperty ("adapter", adapter);
            a->setProperty ("file", file.getFullPathName());
            auto r = run ("generate_asset", a);
            if (! succeeded (r)) return failOp (kind, "execute", r.getProperty ("error", "").toString());
            Binding b; b.kind = "asset"; b.ref = file.getFullPathName();
            bind (out, b);
            return okOp (kind, { "generate_asset" }, r.getProperty ("data", var()));
        }
        // morph / inpaint stay engine gaps for now.
        return unsupportedOp (op, "latent morph/inpaint are not wired to an adapter yet",
                              kind, tutorialId);
    }

    // ── clip ─────────────────────────────────────────────────────────────
    if (kind == "clip.create")
    {
        const auto sym = p.getProperty ("clip_id", var()).toString();
        if (sym.isEmpty()) return failOp (kind, "validate", "missing clip_id");
        if (bindingExists (sym)) return failOp (kind, "validate", "id already bound: " + sym);
        const auto id = trackId(); if (id.isEmpty()) return needTrack();
        if (p.getProperty ("kind", "midi").toString() != "midi")
            return unsupportedOp (op, "audio clips are created by sample.place in v0", "clip.create.audio", tutorialId);

        auto* a = obj();
        a->setProperty ("trackId", id);
        a->setProperty ("name", sym);
        a->setProperty ("start", beatsToSeconds (barToBeats ((int) p.getProperty ("start_bar", 1))));
        a->setProperty ("length", beatsToSeconds (barToBeats ((int) p.getProperty ("start_bar", 1))
                                                  + (double) p.getProperty ("length_beats", 4.0))
                                  - beatsToSeconds (barToBeats ((int) p.getProperty ("start_bar", 1))));
        a->setProperty ("notes", var (Array<var>()));    // empty — no default arpeggio
        auto r = run ("add_midi_clip", a);
        if (! succeeded (r)) return failOp (kind, "execute", r.getProperty ("error", "").toString());

        Binding b; b.kind = "clip";
        b.ref = r.getProperty ("data", var()).getProperty ("clipId", var()).toString();
        b.trackRef = id;
        bind (sym, b);
        auto* data = obj(); data->setProperty ("clipId", b.ref);
        return okOp (kind, { "add_midi_clip" }, var (data));
    }
    if (kind == "clip.move")
    {
        const auto id = clipId(); if (id.isEmpty()) return needClip();
        auto* a = obj();
        a->setProperty ("clipId", id);
        a->setProperty ("start", beatsToSeconds (barToBeats ((int) p.getProperty ("start_bar", 1))));
        if (p.hasProperty ("track_id"))
        {
            const auto destId = trackId(); if (destId.isEmpty()) return needTrack();
            a->setProperty ("trackId", destId);
        }
        auto r = run ("move_clip", a);
        return succeeded (r) ? okOp (kind, { "move_clip" })
                             : failOp (kind, "execute", r.getProperty ("error", "").toString());
    }
    if (kind == "clip.duplicate")
        return unsupportedOp (op, "clip duplication is not yet a native command", "clip.duplicate", tutorialId);
    if (kind == "clip.delete")
    {
        const auto sym = p.getProperty ("clip_id", var()).toString();
        const auto id = clipId(); if (id.isEmpty()) return needClip();
        auto* a = obj(); a->setProperty ("clipId", id);
        auto r = run ("remove_clip", a);
        if (! succeeded (r)) return failOp (kind, "execute", r.getProperty ("error", "").toString());
        bindings.erase (sym);
        return okOp (kind, { "remove_clip" });
    }
    if (kind == "clip.set_length")
    {
        const auto id = clipId(); if (id.isEmpty()) return needClip();
        auto* a = obj();
        a->setProperty ("clipId", id);
        // length is tempo-relative: convert the beat span at the clip's start.
        a->setProperty ("length", beatsToSeconds ((double) p.getProperty ("length_beats", 4.0)));
        auto r = run ("trim_clip", a);
        return succeeded (r) ? okOp (kind, { "trim_clip" })
                             : failOp (kind, "execute", r.getProperty ("error", "").toString());
    }

    // ── notes ────────────────────────────────────────────────────────────
    if (kind == "notes.add")
    {
        const auto id = clipId(); if (id.isEmpty()) return needClip();
        auto notes = p.getProperty ("notes", var());
        if (! notes.isArray()) return failOp (kind, "validate", "missing notes");
        Array<var> lowered;
        for (auto& n : *notes.getArray())
        {
            const int pitch = parsePitch (n.getProperty ("pitch", var()));
            if (pitch < 0) return failOp (kind, "validate",
                "bad pitch: " + n.getProperty ("pitch", var()).toString());
            auto* ln = obj();
            ln->setProperty ("pitch", pitch);
            ln->setProperty ("startBeats", n.getProperty ("start_beats", 0.0));
            ln->setProperty ("durBeats", n.getProperty ("dur_beats", 1.0));
            ln->setProperty ("vel", n.getProperty ("vel", 100));
            lowered.add (var (ln));
        }
        auto* a = obj();
        a->setProperty ("clipId", id);
        a->setProperty ("notes", lowered);
        auto r = run ("add_notes", a);
        return succeeded (r) ? okOp (kind, { "add_notes" }, r.getProperty ("data", var()))
                             : failOp (kind, "execute", r.getProperty ("error", "").toString());
    }
    if (kind == "notes.remove")
    {
        const auto id = clipId(); if (id.isEmpty()) return needClip();
        auto* a = obj();
        a->setProperty ("clipId", id);
        if (auto pv = p.getProperty ("pitches", var()); pv.isArray())
        {
            Array<var> ints;
            for (auto& x : *pv.getArray())
            {
                const int pitch = parsePitch (x);
                if (pitch < 0) return failOp (kind, "validate", "bad pitch in pitches");
                ints.add (pitch);
            }
            a->setProperty ("pitches", ints);
        }
        if (auto rv = p.getProperty ("range", var()); rv.isObject())
        {
            a->setProperty ("rangeStartBeats", rv.getProperty ("start_beats", 0.0));
            a->setProperty ("rangeLengthBeats", rv.getProperty ("length_beats", 0.0));
        }
        auto r = run ("remove_notes", a);
        return succeeded (r) ? okOp (kind, { "remove_notes" }, r.getProperty ("data", var()))
                             : failOp (kind, "execute", r.getProperty ("error", "").toString());
    }
    if (kind == "notes.transpose")
    {
        const auto id = clipId(); if (id.isEmpty()) return needClip();
        auto* a = obj();
        a->setProperty ("clipId", id);
        a->setProperty ("semitones", p.getProperty ("semitones", 0));
        auto r = run ("transpose_notes", a);
        return succeeded (r) ? okOp (kind, { "transpose_notes" })
                             : failOp (kind, "execute", r.getProperty ("error", "").toString());
    }
    if (kind == "notes.quantize")
    {
        const auto id = clipId(); if (id.isEmpty()) return needClip();
        const double grid = gridToBeats (p.getProperty ("grid", var()).toString());
        if (grid <= 0.0) return failOp (kind, "validate", "bad grid: " + p.getProperty ("grid", var()).toString());
        auto* a = obj();
        a->setProperty ("clipId", id);
        a->setProperty ("gridBeats", grid);
        a->setProperty ("strength", p.getProperty ("strength", 1.0));
        auto r = run ("quantize_notes", a);
        return succeeded (r) ? okOp (kind, { "quantize_notes" })
                             : failOp (kind, "execute", r.getProperty ("error", "").toString());
    }
    if (kind == "notes.humanize")
    {
        const auto id = clipId(); if (id.isEmpty()) return needClip();
        if (! p.hasProperty ("seed"))
            return failOp (kind, "validate", "seed required (stochastic op, no default seed)");
        // ms → beats through the CURRENT tempo so the op stays tempo-relative.
        const double bpm = eng.edit().tempoSequence.getBpmAt (tracktion::TimePosition());
        auto* a = obj();
        a->setProperty ("clipId", id);
        a->setProperty ("timingBeats", (double) p.getProperty ("timing_ms", 0.0) / 1000.0 * bpm / 60.0);
        a->setProperty ("velVar", p.getProperty ("vel_var", 0.0));
        a->setProperty ("seed", p.getProperty ("seed", 0));
        auto r = run ("humanize_notes", a);
        return succeeded (r) ? okOp (kind, { "humanize_notes" })
                             : failOp (kind, "execute", r.getProperty ("error", "").toString());
    }

    // ── sample ───────────────────────────────────────────────────────────
    if (kind == "sample.place")
    {
        const auto sym = p.getProperty ("clip_id", var()).toString();
        if (bindingExists (sym)) return failOp (kind, "validate", "id already bound: " + sym);
        const auto id = trackId(); if (id.isEmpty()) return needTrack();
        auto* asset = find (p.getProperty ("asset_id", var()).toString(), "asset");
        if (asset == nullptr) return failOp (kind, "validate",
            "unbound asset id: " + p.getProperty ("asset_id", var()).toString());

        auto* a = obj();
        a->setProperty ("trackId", id);
        a->setProperty ("file", asset->ref);
        a->setProperty ("name", sym);
        a->setProperty ("startSeconds", beatsToSeconds (barToBeats ((int) p.getProperty ("start_bar", 1))));
        auto r = run ("import_clip", a);
        if (! succeeded (r)) return failOp (kind, "execute", r.getProperty ("error", "").toString());

        Binding b; b.kind = "clip";
        b.ref = r.getProperty ("data", var()).getProperty ("clipId", var()).toString();
        b.trackRef = id;
        bind (sym, b);

        StringArray cmds { "import_clip" };
        if ((double) p.getProperty ("offset_beats", 0.0) > 0.0)
        {
            auto* t = obj();
            t->setProperty ("clipId", b.ref);
            t->setProperty ("offset", beatsToSeconds ((double) p.getProperty ("offset_beats", 0.0)));
            if (succeeded (run ("trim_clip", t))) cmds.add ("trim_clip");
        }
        auto* data = obj(); data->setProperty ("clipId", b.ref);
        return okOp (kind, cmds, var (data));
    }
    if (kind == "sample.slice")
    {
        const auto id = clipId(); if (id.isEmpty()) return needClip();
        if (p.getProperty ("mode", var()).toString() == "transient")
            return unsupportedOp (op, "transient detection is async in the engine; grid slicing only",
                                  "sample.slice.transient", tutorialId);
        const double grid = gridToBeats (p.getProperty ("grid", var()).toString());
        if (grid <= 0.0) return failOp (kind, "validate", "grid mode requires a valid grid");
        auto* a = obj();
        a->setProperty ("clipId", id);
        a->setProperty ("gridBeats", grid);
        auto r = run ("slice_clip", a);
        return succeeded (r) ? okOp (kind, { "slice_clip" }, r.getProperty ("data", var()))
                             : failOp (kind, "execute", r.getProperty ("error", "").toString());
    }
    if (kind == "sample.pitch")
    {
        const auto id = clipId(); if (id.isEmpty()) return needClip();
        auto* a = obj();
        a->setProperty ("clipId", id);
        a->setProperty ("semitones", p.getProperty ("semitones", 0.0));
        auto r = run ("set_clip_pitch", a);
        return succeeded (r) ? okOp (kind, { "set_clip_pitch" })
                             : failOp (kind, "execute", r.getProperty ("error", "").toString());
    }
    if (kind == "sample.stretch")
    {
        const auto id = clipId(); if (id.isEmpty()) return needClip();
        auto* a = obj();
        a->setProperty ("clipId", id);
        a->setProperty ("ratio", p.getProperty ("ratio", 1.0));
        auto r = run ("set_clip_stretch", a);
        return succeeded (r) ? okOp (kind, { "set_clip_stretch" })
                             : failOp (kind, "execute", r.getProperty ("error", "").toString());
    }

    // ── device ───────────────────────────────────────────────────────────
    if (kind == "device.add")
        return lowerDeviceAdd (p, out, tutorialId);
    if (kind == "device.set_param")
    {
        const auto sym = p.getProperty ("device_id", var()).toString();
        auto* dev = find (sym, "device");
        if (dev == nullptr) return failOp (kind, "validate", "unbound device id: " + sym);

        const auto param = p.getProperty ("param", var());
        const double valueNorm = (double) p.getProperty ("value_norm", 0.0);

        if (dev->type == "neural")
        {
            auto* a = obj();
            a->setProperty ("trackId", dev->trackRef);
            a->setProperty ("index", dev->index);
            a->setProperty ("paramId", param.toString());
            a->setProperty ("value", valueNorm * 100.0);   // 0–100 ASTD UI range
            auto r = run ("set_neural_param", a);
            return succeeded (r) ? okOp (kind, { "set_neural_param" })
                                 : failOp (kind, "execute", r.getProperty ("error", "").toString());
        }

        auto* a = obj();
        a->setProperty ("trackId", dev->trackRef);
        a->setProperty ("index", dev->index);
        if (param.isInt() || param.isInt64() || param.isDouble())
            a->setProperty ("paramIndex", (int) param);
        else
            a->setProperty ("paramName", param.toString());
        a->setProperty ("value", valueNorm);
        auto r = run ("set_plugin_param", a);
        if (! succeeded (r))
        {
            const auto err = r.getProperty ("error", "").toString();
            // A semantic-name miss is a mapping gap, not a malformed op —
            // ledger it so the per-device mapping table grows from real data.
            if (err.startsWith ("no param named"))
            {
                auto* fakeOp = obj();
                fakeOp->setProperty ("kind", kind);
                auto* pp = obj();
                pp->setProperty ("device_type", dev->type);
                pp->setProperty ("param", param);
                fakeOp->setProperty ("params", var (pp));
                return unsupportedOp (var (fakeOp), err, "device.param." + param.toString(), tutorialId);
            }
            return failOp (kind, "execute", err);
        }
        return okOp (kind, { "set_plugin_param" });
    }
    if (kind == "device.load_preset")
        return unsupportedOp (op, "builtin devices have no preset API in the engine", "device.load_preset", tutorialId);
    if (kind == "device.bypass")
    {
        auto* dev = find (p.getProperty ("device_id", var()).toString(), "device");
        if (dev == nullptr) return failOp (kind, "validate", "unbound device id");
        auto* a = obj();
        a->setProperty ("trackId", dev->trackRef);
        a->setProperty ("index", dev->index);
        a->setProperty ("bypassed", p.getProperty ("bypassed", false));
        auto r = run ("bypass_plugin", a);
        return succeeded (r) ? okOp (kind, { "bypass_plugin" })
                             : failOp (kind, "execute", r.getProperty ("error", "").toString());
    }

    // ── mixer ────────────────────────────────────────────────────────────
    if (kind == "mixer.set_gain")
    {
        const auto id = trackId(); if (id.isEmpty()) return needTrack();
        auto* a = obj();
        a->setProperty ("trackId", id);
        a->setProperty ("db", p.getProperty ("db", 0.0));
        auto r = run ("set_track_volume", a);
        return succeeded (r) ? okOp (kind, { "set_track_volume" })
                             : failOp (kind, "execute", r.getProperty ("error", "").toString());
    }
    if (kind == "mixer.set_pan")
    {
        const auto id = trackId(); if (id.isEmpty()) return needTrack();
        auto* a = obj();
        a->setProperty ("trackId", id);
        a->setProperty ("pan", p.getProperty ("pan", 0.0));
        auto r = run ("set_track_pan", a);
        return succeeded (r) ? okOp (kind, { "set_track_pan" })
                             : failOp (kind, "execute", r.getProperty ("error", "").toString());
    }
    if (kind == "mixer.send")
        return lowerMixerSend (p, tutorialId);
    if (kind == "mixer.sidechain")
        return lowerSidechain (p, tutorialId);

    // ── automation ───────────────────────────────────────────────────────
    if (kind == "automation.write")
    {
        const auto target = p.getProperty ("target", var());
        auto points = p.getProperty ("points", var());
        if (! points.isArray() || points.size() == 0)
            return failOp (kind, "validate", "missing points");

        auto* a = obj();
        if (target.hasProperty ("mixer"))
        {
            auto* tb = find (target.getProperty ("track_id", var()).toString(), "track");
            if (tb == nullptr) return failOp (kind, "validate", "unbound track in target");
            a->setProperty ("trackId", tb->ref);
            const auto field = target.getProperty ("mixer", var()).toString();
            a->setProperty ("mixer", field == "pan" ? "pan" : "volume");
        }
        else
        {
            auto* dev = find (target.getProperty ("device_id", var()).toString(), "device");
            if (dev == nullptr) return failOp (kind, "validate", "unbound device in target");
            a->setProperty ("trackId", dev->trackRef);
            a->setProperty ("pluginIndex", dev->index);
            const auto param = target.getProperty ("param", var());
            if (param.isInt() || param.isInt64() || param.isDouble())
                a->setProperty ("paramIndex", (int) param);
            else
                a->setProperty ("paramName", param.toString());
        }
        Array<var> lowered;
        for (auto& pt : *points.getArray())
        {
            auto* lp = obj();
            lp->setProperty ("beats", pt.getProperty ("pos_beats", 0.0));
            lp->setProperty ("value", pt.getProperty ("value_norm", 0.0));
            lp->setProperty ("curve", pt.getProperty ("curve", 0.0));
            lowered.add (var (lp));
        }
        a->setProperty ("points", lowered);
        auto r = run ("write_automation", a);
        return succeeded (r) ? okOp (kind, { "write_automation" }, r.getProperty ("data", var()))
                             : failOp (kind, "execute", r.getProperty ("error", "").toString());
    }

    // ── arrange ──────────────────────────────────────────────────────────
    if (kind == "arrange.create_section")
    {
        auto* a = obj();
        a->setProperty ("name", p.getProperty ("name", var()));
        a->setProperty ("startBar", p.getProperty ("start_bar", 1));
        a->setProperty ("lengthBars", p.getProperty ("length_bars", 1));
        auto r = run ("create_section", a);
        return succeeded (r) ? okOp (kind, { "create_section" })
                             : failOp (kind, "execute", r.getProperty ("error", "").toString());
    }
    if (kind == "arrange.place")
    {
        const auto id = clipId(); if (id.isEmpty()) return needClip();
        int startBar = (int) p.getProperty ("start_bar", 0);
        if (const auto section = p.getProperty ("section", var()).toString(); section.isNotEmpty())
        {
            auto arrange = eng.edit().state.getChildWithName (MOSH_ARRANGE);
            auto node = arrange.isValid() ? arrange.getChildWithProperty ("name", section) : ValueTree();
            if (! node.isValid()) return failOp (kind, "validate", "unknown section: " + section);
            startBar = (int) node.getProperty ("startBar", 1);
        }
        if (startBar < 1) return failOp (kind, "validate", "need section or start_bar");
        auto* a = obj();
        a->setProperty ("clipId", id);
        a->setProperty ("start", beatsToSeconds (barToBeats (startBar)));
        auto r = run ("move_clip", a);
        return succeeded (r) ? okOp (kind, { "move_clip" })
                             : failOp (kind, "execute", r.getProperty ("error", "").toString());
    }

    // ── render ───────────────────────────────────────────────────────────
    if (kind == "render.commit")
    {
        // v0: a commit point = a saved session. Stage 8 adds the state_hash.
        auto r = run ("save", obj());
        return succeeded (r) ? okOp (kind, { "save" })
                             : failOp (kind, "execute", r.getProperty ("error", "").toString());
    }
    if (kind == "render.bounce")
    {
        // Deterministic artifact path keyed on the out-symbol (no wall-clock).
        const auto stem = out.isNotEmpty() ? out : String ("bounce");
        auto file = eng.sessionDir().getChildFile ("renders").getChildFile (stem + ".wav");
        auto* a = obj();
        a->setProperty ("file", file.getFullPathName());
        auto r = run ("export_audio", a);
        if (! succeeded (r)) return failOp (kind, "execute", r.getProperty ("error", "").toString());
        if (out.isNotEmpty())
        {
            Binding b; b.kind = "asset"; b.ref = file.getFullPathName();
            bind (out, b);
        }
        return okOp (kind, { "export_audio" }, r.getProperty ("data", var()));
    }

    return failOp (kind, "lower", "no lowering rule (internal)");
}

// ─────────────────────────────────────────────────────────────────────────────
// Asset resolver (asset.resolve — fallback chain local → splice → latent_gen;
// licensing is enforced HERE, nowhere else: phase0 §14.1)
// ─────────────────────────────────────────────────────────────────────────────
juce::var Executor::lowerAssetResolve (const juce::var& p, const juce::String& outSym,
                                       const juce::String& tutorialId)
{
    const auto kind = String ("asset.resolve");
    if (outSym.isEmpty()) return failOp (kind, "validate", "asset.resolve requires 'out'");
    if (bindingExists (outSym)) return failOp (kind, "validate", "id already bound: " + outSym);

    const auto descriptor = p.getProperty ("descriptor", var());
    const auto text = descriptor.getProperty ("text", var()).toString();
    if (text.isEmpty()) return failOp (kind, "validate", "descriptor.text required");

    StringArray tokens;
    tokens.addTokens (text.toLowerCase(), " ,-_", {});
    if (auto tags = descriptor.getProperty ("tags", var()); tags.isArray())
        for (auto& t : *tags.getArray()) tokens.add (t.toString().toLowerCase());
    tokens.removeEmptyStrings();
    tokens.removeDuplicates (false);

    auto strategies = p.getProperty ("strategy", var());
    StringArray chain;
    if (strategies.isArray())
        for (auto& s : *strategies.getArray()) chain.add (s.toString());
    if (chain.isEmpty()) chain.add ("local");

    for (const auto& strategy : chain)
    {
        if (strategy == "local")
        {
            const auto libPath = SystemStats::getEnvironmentVariable ("MOSH_SAMPLE_LIBRARY",
                File::getSpecialLocation (File::userHomeDirectory)
                    .getChildFile ("Library/Mosh/library").getFullPathName());
            File lib (libPath);
            if (! lib.isDirectory()) continue;

            // Deterministic scoring: token hits on the lowercased filename,
            // ties broken lexicographically by path.
            File best; int bestScore = 0;
            auto files = lib.findChildFiles (File::findFiles, true, "*.wav;*.aif;*.aiff;*.mp3;*.flac");
            files.sort();
            for (const auto& f : files)
            {
                const auto name = f.getFileName().toLowerCase();
                int score = 0;
                for (const auto& tok : tokens)
                    if (name.contains (tok)) ++score;
                if (score > bestScore) { bestScore = score; best = f; }
            }
            if (bestScore > 0)
            {
                Binding b; b.kind = "asset"; b.ref = best.getFullPathName();
                bind (outSym, b);
                // The resolution is logged in the result — it is training data
                // for a future resolver model (§3.1.4).
                auto* data = obj();
                data->setProperty ("assetId", outSym);
                data->setProperty ("file", best.getFullPathName());
                data->setProperty ("strategy", "local");
                data->setProperty ("score", bestScore);
                return okOp (kind, {}, var (data));
            }
        }
        // splice / latent_gen: not wired in v0; fall through and ledger below.
    }

    auto* fakeOp = obj();
    fakeOp->setProperty ("kind", kind);
    auto* pp = obj();
    pp->setProperty ("descriptor", descriptor);
    pp->setProperty ("strategy", strategies);
    fakeOp->setProperty ("params", var (pp));
    return unsupportedOp (var (fakeOp),
        "no local match for descriptor '" + text + "'; splice/latent_gen strategies not wired in v0",
        "asset.resolve", tutorialId);
}

// ─────────────────────────────────────────────────────────────────────────────
// device.add (prefer-chain resolution — phase0 §3.4)
// ─────────────────────────────────────────────────────────────────────────────
juce::var Executor::lowerDeviceAdd (const juce::var& p, const juce::String&,
                                    const juce::String& tutorialId)
{
    const auto kind = String ("device.add");
    const auto sym = p.getProperty ("device_id", var()).toString();
    if (sym.isEmpty()) return failOp (kind, "validate", "missing device_id");
    if (bindingExists (sym)) return failOp (kind, "validate", "id already bound: " + sym);
    auto* tb = find (p.getProperty ("track_id", var()).toString(), "track");
    if (tb == nullptr) return failOp (kind, "validate",
        "unbound track id: " + p.getProperty ("track_id", var()).toString());

    const auto role = p.getProperty ("role", var()).toString();

    // The prefer chain: explicit entries first, then the role's builtin default.
    StringArray prefer;
    if (auto pv = p.getProperty ("prefer", var()); pv.isArray())
        for (auto& x : *pv.getArray()) prefer.add (x.toString());
    if      (role == "synth")     prefer.add ("builtin.synth");
    else if (role == "sampler")   prefer.add ("builtin.sampler");
    else if (role == "eq")        prefer.add ("builtin.eq");
    else if (role == "comp")      prefer.add ("builtin.comp");
    else if (role == "saturator") prefer.add ("builtin.sat");
    else if (role == "delay")     prefer.add ("builtin.delay");
    else if (role == "reverb")    prefer.add ("builtin.reverb");
    else if (role == "filter")    prefer.add ("builtin.filter");

    static const std::map<String, String> builtinMap = {
        { "builtin.sampler", "sampler" }, { "builtin.synth", "4osc" },
        { "builtin.eq", "eq" },           { "builtin.comp", "compressor" },
        { "builtin.delay", "delay" },     { "builtin.reverb", "reverb" },
        { "builtin.filter", "lowpass" },  { "builtin.pitch", "pitchshift" },
    };

    for (const auto& want : prefer)
    {
        // The Tier-A neural insert IS the house saturator (a genuine tanh-MLP
        // waveshaper) — 'builtin.sat' routes to it.
        if (want == "builtin.sat" || want == "builtin.saturator")
        {
            auto* a = obj();
            a->setProperty ("trackId", tb->ref);
            auto r = run ("add_neural_insert", a);
            if (! succeeded (r)) continue;
            Binding b; b.kind = "device"; b.trackRef = tb->ref; b.type = "neural";
            b.index = (int) r.getProperty ("data", var()).getProperty ("index", -1);
            bind (sym, b);
            auto* data = obj(); data->setProperty ("resolved", want);
            return okOp (kind, { "add_neural_insert" }, var (data));
        }

        if (auto it = builtinMap.find (want); it != builtinMap.end())
        {
            auto* a = obj();
            a->setProperty ("trackId", tb->ref);
            a->setProperty ("type", it->second);
            auto r = run ("load_builtin_plugin", a);
            if (! succeeded (r)) continue;
            Binding b; b.kind = "device"; b.trackRef = tb->ref; b.type = "builtin:" + it->second;
            b.index = (int) r.getProperty ("data", var()).getProperty ("index", -1);
            bind (sym, b);
            auto* data = obj(); data->setProperty ("resolved", want);
            return okOp (kind, { "load_builtin_plugin" }, var (data));
        }

        if (! want.startsWith ("builtin."))
        {
            // External plugin: first available whose name matches (logged choice).
            auto list = run ("list_plugins", obj());
            auto plugins = list.getProperty ("data", var()).getProperty ("plugins", var());
            if (! plugins.isArray()) continue;
            for (auto& pl : *plugins.getArray())
            {
                if (! pl.getProperty ("name", var()).toString().containsIgnoreCase (want)) continue;
                auto* a = obj();
                a->setProperty ("trackId", tb->ref);
                a->setProperty ("pluginId", pl.getProperty ("id", var()));
                auto r = run ("load_plugin", a);
                if (! succeeded (r)) break;
                Binding b; b.kind = "device"; b.trackRef = tb->ref; b.type = "external";
                b.index = (int) r.getProperty ("data", var()).getProperty ("index", -1);
                bind (sym, b);
                auto* data = obj();
                data->setProperty ("resolved", pl.getProperty ("name", var()));
                return okOp (kind, { "load_plugin" }, var (data));
            }
        }
    }

    auto* fakeOp = obj();
    fakeOp->setProperty ("kind", kind);
    auto* pp = obj();
    pp->setProperty ("role", role);
    pp->setProperty ("prefer", p.getProperty ("prefer", var()));
    fakeOp->setProperty ("params", var (pp));
    return unsupportedOp (var (fakeOp),
        "no device resolved for role '" + role + "' (prefer chain exhausted)",
        "device.add." + role, tutorialId);
}

// ─────────────────────────────────────────────────────────────────────────────
// mixer.send / mixer.sidechain
// ─────────────────────────────────────────────────────────────────────────────
juce::var Executor::lowerMixerSend (const juce::var& p, const juce::String&)
{
    const auto kind = String ("mixer.send");
    auto* tb = find (p.getProperty ("track_id", var()).toString(), "track");
    if (tb == nullptr) return failOp (kind, "validate", "unbound track id");
    const auto busSym = p.getProperty ("to_bus", var()).toString();
    auto it = bindings.find (busSym);
    if (it == bindings.end() || it->second.kind != "track")
        return failOp (kind, "validate", "unbound bus id: " + busSym + " (create it with track.create kind=bus)");

    StringArray cmds;
    // First send to this bus: allocate a bus number + install the return.
    if (it->second.index < 0)
    {
        const int bus = nextBusNumber++;
        auto* ra = obj();
        ra->setProperty ("trackId", it->second.ref);
        ra->setProperty ("busNumber", bus);
        auto rr = run ("add_return", ra);
        if (! succeeded (rr)) return failOp (kind, "execute", rr.getProperty ("error", "").toString());
        it->second.index = bus;
        cmds.add ("add_return");
    }

    auto* a = obj();
    a->setProperty ("trackId", tb->ref);
    a->setProperty ("busNumber", it->second.index);
    a->setProperty ("gainDb", p.getProperty ("db", 0.0));
    auto r = run ("add_send", a);
    if (! succeeded (r)) return failOp (kind, "execute", r.getProperty ("error", "").toString());
    cmds.add ("add_send");

    auto* data = obj(); data->setProperty ("busNumber", it->second.index);
    return okOp (kind, cmds, var (data));
}

juce::var Executor::lowerSidechain (const juce::var& p, const juce::String&)
{
    const auto kind = String ("mixer.sidechain");
    auto* src = find (p.getProperty ("src", var()).toString(), "track");
    auto* dst = find (p.getProperty ("dst", var()).toString(), "track");
    if (src == nullptr || dst == nullptr)
        return failOp (kind, "validate", "unbound src/dst track id");

    // A compressor on dst, keyed from src. amount ∈ [0,1] maps to threshold
    // depth (0 → no compression, 1 → -40 dB threshold, heavy duck).
    auto* la = obj();
    la->setProperty ("trackId", dst->ref);
    la->setProperty ("type", "compressor");
    auto lr = run ("load_builtin_plugin", la);
    if (! succeeded (lr)) return failOp (kind, "execute", lr.getProperty ("error", "").toString());
    const int index = (int) lr.getProperty ("data", var()).getProperty ("index", -1);

    auto* a = obj();
    a->setProperty ("trackId", dst->ref);
    a->setProperty ("index", index);
    a->setProperty ("sourceTrackId", src->ref);
    a->setProperty ("thresholdDb", -40.0 * jlimit (0.0, 1.0, (double) p.getProperty ("amount", 0.5)));
    a->setProperty ("ratio", p.getProperty ("ratio", 4.0));
    if (p.hasProperty ("attack_ms"))  a->setProperty ("attackMs", p.getProperty ("attack_ms", 5.0));
    if (p.hasProperty ("release_ms")) a->setProperty ("releaseMs", p.getProperty ("release_ms", 120.0));
    auto r = run ("set_sidechain", a);
    return succeeded (r) ? okOp (kind, { "load_builtin_plugin", "set_sidechain" })
                         : failOp (kind, "execute", r.getProperty ("error", "").toString());
}

// ─────────────────────────────────────────────────────────────────────────────
// Plumbing
// ─────────────────────────────────────────────────────────────────────────────
juce::var Executor::run (const String& command, DynamicObject* args)
{
    auto* c = obj();
    c->setProperty ("command", command);
    c->setProperty ("args", var (args));
    return ops.execute (var (c));
}

bool Executor::succeeded (const juce::var& result)
{
    return (bool) result.getProperty ("ok", false);
}

const Executor::Binding* Executor::find (const String& sym, const String& kind) const
{
    auto it = bindings.find (sym);
    if (it == bindings.end() || it->second.kind != kind) return nullptr;
    return &it->second;
}

void Executor::bind (const String& sym, Binding b)
{
    bindings[sym] = std::move (b);
}

void Executor::loadBindings()
{
    auto node = eng.edit().state.getChildWithName (MOSH_IR_BINDINGS);
    if (! node.isValid()) return;
    nextBusNumber = (int) node.getProperty ("nextBusNumber", 1);
    for (int i = 0; i < node.getNumChildren(); ++i)
    {
        auto c = node.getChild (i);
        Binding b;
        b.kind     = c.getProperty ("kind", "").toString();
        b.ref      = c.getProperty ("ref", "").toString();
        b.trackRef = c.getProperty ("trackRef", "").toString();
        b.type     = c.getProperty ("type", "").toString();
        b.index    = (int) c.getProperty ("idx", -1);
        bindings[c.getProperty ("sym", "").toString()] = b;
    }
}

void Executor::saveBindings()
{
    // Not undoable by design: bindings are IR bookkeeping, not musical state.
    auto state = eng.edit().state;
    auto node = state.getOrCreateChildWithName (MOSH_IR_BINDINGS, nullptr);
    node.removeAllChildren (nullptr);
    node.setProperty ("nextBusNumber", nextBusNumber, nullptr);
    for (const auto& [sym, b] : bindings)
    {
        ValueTree c (BINDING);
        c.setProperty ("sym", sym, nullptr);
        c.setProperty ("kind", b.kind, nullptr);
        c.setProperty ("ref", b.ref, nullptr);
        if (b.trackRef.isNotEmpty()) c.setProperty ("trackRef", b.trackRef, nullptr);
        if (b.type.isNotEmpty())     c.setProperty ("type", b.type, nullptr);
        if (b.index >= 0)            c.setProperty ("idx", b.index, nullptr);
        node.appendChild (c, nullptr);
    }
}

double Executor::beatsPerBar() const
{
    auto& ts = eng.edit().tempoSequence.getTimeSigAt (tracktion::TimePosition());
    // Engine beats are quarter-note pulses; a bar of num/denom holds num*(4/denom).
    return (double) ts.numerator.get() * 4.0 / (double) jmax (1, ts.denominator.get());
}

double Executor::beatsToSeconds (double beats) const
{
    return eng.edit().tempoSequence.toTime (tracktion::BeatPosition::fromBeats (beats)).inSeconds();
}

double Executor::gridToBeats (const String& grid)
{
    if (grid == "1/4")  return 1.0;
    if (grid == "1/8")  return 0.5;
    if (grid == "1/16") return 0.25;
    if (grid == "1/32") return 0.125;
    if (grid == "1/4T")  return 2.0 / 3.0;
    if (grid == "1/8T")  return 1.0 / 3.0;
    if (grid == "1/16T") return 1.0 / 6.0;
    return 0.0;
}

int Executor::parsePitch (const juce::var& pitch)
{
    if (pitch.isInt() || pitch.isInt64() || pitch.isDouble())
    {
        const int v = (int) pitch;
        return (v >= 0 && v <= 127) ? v : -1;
    }
    const auto s = pitch.toString().trim();
    if (s.isEmpty()) return -1;

    static const int semis[7] = { 9, 11, 0, 2, 4, 5, 7 };   // A B C D E F G
    const auto letter = (juce_wchar) CharacterFunctions::toUpperCase (s[0]);
    if (letter < 'A' || letter > 'G') return -1;
    int semi = semis[letter - 'A'];
    int idx = 1;
    if (idx < s.length() && (s[idx] == '#' || s[idx] == 'b'))
    {
        semi += (s[idx] == '#') ? 1 : -1;
        ++idx;
    }
    const auto octaveStr = s.substring (idx);
    if (octaveStr.isEmpty() || ! octaveStr.retainCharacters ("-0123456789").equalsIgnoreCase (octaveStr))
        return -1;
    const int octave = octaveStr.getIntValue();
    const int midi = 12 * (octave + 1) + semi;      // C-1 = 0, C4 = 60
    return (midi >= 0 && midi <= 127) ? midi : -1;
}

void Executor::ledger (const juce::var& op, const String& reason,
                       const String& missingCapability, const String& tutorialId)
{
    // Gap ledger (phase0 §4.5): every Unsupported appends {op, reason,
    // missing_capability, tutorial_id?, ts}. The ledger is the instrument
    // that turns low lowering rates into engine-roadmap decisions.
    auto* o = obj();
    o->setProperty ("ts", Time::getCurrentTime().toMilliseconds());
    o->setProperty ("op", op);
    o->setProperty ("reason", reason);
    o->setProperty ("missing_capability", missingCapability);
    if (tutorialId.isNotEmpty()) o->setProperty ("tutorial_id", tutorialId);
    ledgerFile.getParentDirectory().createDirectory();
    ledgerFile.appendText (JSON::toString (var (o), true) + "\n");
}

juce::var Executor::okOp (const String& kind, const StringArray& commands, juce::var data)
{
    auto* o = obj();
    o->setProperty ("ok", true);
    o->setProperty ("kind", kind);
    Array<var> cmds;
    for (const auto& c : commands) cmds.add (c);
    o->setProperty ("commands", cmds);
    if (! data.isVoid()) o->setProperty ("data", data);
    return var (o);
}

juce::var Executor::failOp (const String& kind, const String& stage, const String& error)
{
    auto* o = obj();
    o->setProperty ("ok", false);
    o->setProperty ("kind", kind);
    o->setProperty ("stage", stage);
    o->setProperty ("error", error);
    return var (o);
}

juce::var Executor::unsupportedOp (const juce::var& op, const String& reason,
                                   const String& missing, const String& tutorialId)
{
    ledger (op, reason, missing, tutorialId);
    auto* o = obj();
    o->setProperty ("ok", false);
    o->setProperty ("kind", op.getProperty ("kind", var()));
    o->setProperty ("stage", "lower");
    o->setProperty ("unsupported", true);
    o->setProperty ("reason", reason);
    o->setProperty ("missing_capability", missing);
    return var (o);
}

} // namespace mosh::ir
