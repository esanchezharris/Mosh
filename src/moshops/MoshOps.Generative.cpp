// RFC 001 (A-PR3) — MoshOps partial-class split: the Tier-B generative-layer
// command bodies (render-layer create/set-param/compile/render/cancel/accept/
// reject/bypass/freeze/unfreeze/bounce/reset/remove, fingerprint + LoRA-key
// resolution, finalize/apply + pendingSwaps deferred swap, the Phase-3
// reactive-touch loop, render-ahead, colours/loras/transform-target listings,
// and — contiguous with this block — the build-gated Route-C RAVE insert
// commands), moved VERBATIM from MoshOps.cpp. Same class, same member
// functions — only the translation unit changed. The dispatch if-chain and
// all transaction/log/result/emit plumbing stay in MoshOps.cpp (one mutation
// path, by construction). Cross-TU helpers (asRave, findSerumRealtimeRender-
// Reason — also used by code that stays behind or moved elsewhere) live in
// MoshOpsInternal.h; the two helpers whose ONLY consumers moved here
// (noAssertedWordsToSingMessage, LambdaTimer) moved into this TU's anonymous
// namespace, verbatim.

#include "MoshOps.h"
#include "MoshOpsInternal.h"
#include "state/Ids.h"
#include "state/RenderLayer.h"
#include "state/Lyrics.h"
#include "engine/SourceRef.h"
#include "engine/RenderArtifacts.h"
#include <thread>

namespace mosh
{
using namespace juce;

namespace
{
    juce::String noAssertedWordsToSingMessage()
    {
        return juce::String (juce::CharPointer_UTF8 ("no asserted words to sing \xe2\x80\x94 assert the lyric line first"));
    }

    // Phase 3 — a one-shot lambda timer used for the per-clip reactive-render debounce. Calls fn ONCE
    // after the delay (it stops itself first), so each reactiveTouch just restarts it (coalescing a
    // burst of edits into a single re-render). Fires on the message thread (juce::Timer's thread).
    struct LambdaTimer : public juce::Timer
    {
        std::function<void()> fn;
        void timerCallback() override { stopTimer(); if (fn) fn(); }
    };
}

juce::var MoshOps::cmdAddRenderLayer (const juce::var& args)
{
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (clipId);
    if (clip == nullptr) return errResult ("add_render_layer", "no clip: " + clipId);

    beginTxn ("add_render_layer");
    auto pos = clip->getPosition();
    auto node = RenderLayer::create (
        "rl-" + String (Time::getCurrentTime().toMilliseconds()),
        clip->itemID.toString(),
        pos.getStart().inSeconds(), pos.getEnd().inSeconds(),
        args.getProperty ("adapter", "fake").toString());
    clip->state.appendChild (node, &undoManager());

    auto* data = new DynamicObject();
    data->setProperty ("layerId", node[ids::id].toString());
    logLine ("add_render_layer", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("add_render_layer", var (data));
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 5 — Tier-B generative layer (RenderLayer flow)
// ─────────────────────────────────────────────────────────────────────────────
juce::ValueTree MoshOps::findRenderLayer (const juce::String& clipId)
{
    if (auto* clip = findClip (clipId))
        return clip->state.getChildWithName (ids::MOSH_RENDERLAYER);
    return {};
}

juce::String MoshOps::computeFingerprint (const juce::ValueTree& node, const juce::File& inputWav,
                                         const juce::String& upstreamOverride,
                                         const juce::String& lorasKey)
{
    // Wave clips hash the staged audio. MIDI/drum clips are auto-bounced, but the bounce
    // isn't bit-deterministic (a synth's free-running phase), so they pass a stable source
    // signature instead (notes + instrument/FX state) — identical source → cache HIT.
    const auto upstreamHash = upstreamOverride.isNotEmpty() ? upstreamOverride
                                                            : juce::MD5 (inputWav).toHexString();

    // KEY-001 — feed the LIVE tempo/key context into the fingerprint (was the
    // hardcoded "120bpm/Cmaj" placeholder). bpm is the playback bpm at the start of
    // the edit; the key is the stored project intent (defaulting A/minor where unset),
    // read straight from the MOSH_PROJECT node so it matches the snapshot. A key (or
    // tempo) change therefore changes the fingerprint → render cache MISS.
    const double bpm = eng.edit().tempoSequence.getBpmAt (tracktion::TimePosition());
    auto proj = eng.edit().state.getChildWithName (ids::MOSH_PROJECT);
    const juce::String tonic = proj.hasProperty (ids::musicalTonic)
                                   ? proj.getProperty (ids::musicalTonic).toString()
                                   : juce::String (kDefaultKeyTonic);
    const juce::String keyMode = proj.hasProperty (ids::musicalMode)
                                     ? proj.getProperty (ids::musicalMode).toString()
                                     : juce::String (kDefaultKeyMode);
    const juce::String tempoKeyContext =
        juce::String (bpm, 4) + "bpm/" + tonic + " " + keyMode;

    return RenderLayer::fingerprint (node, upstreamHash, tempoKeyContext, 44100, 2,
                                     jobManager.serviceBuild(), lorasKey);
}

bool MoshOps::resolveLorasKey (const juce::ValueTree& node, juce::String& lorasKey, juce::String& err)
{
    // "name=value@sha12:trigger;" per ACTIVE (value != 0) row, rack order — resolved at
    // RENDER time via GET /loras so the key carries content identity: a retrained
    // same-name file (new sha) or a sidecar trigger edit is a cache MISS, and an
    // unknown name errors BEFORE any job submit. Non-SA3 adapters key name=value only
    // (the fake never applies adapters) — hermetic, no service round-trip.
    lorasKey = {};
    auto params = node.getChildWithName (ids::PARAMS);
    auto loras = params.getChildWithName (ids::LORAS);
    if (! loras.isValid() || loras.getNumChildren() == 0)
        return true;

    juce::Array<juce::ValueTree> active;
    for (int i = 0; i < loras.getNumChildren(); ++i)
        if (auto row = loras.getChild (i); (double) row[ids::value] != 0.0)
            active.add (row);
    if (active.isEmpty())
        return true;

    const auto adapter = node[ids::modelAdapter].toString();
    const bool isSa3 = adapter == "stable_audio3" || adapter == "sa3";
    if (! isSa3)
    {
        for (auto& row : active)
            lorasKey << row[ids::name].toString() << "=" << row[ids::value].toString() << ";";
        return true;
    }

    auto reg = jobManager.listLoras();
    if (! (bool) reg.getProperty ("ok", false))
    {
        err = "LoRA registry unavailable (generative service)";
        return false;
    }
    std::map<juce::String, juce::var> byName;
    if (auto* arr = reg.getProperty ("loras", var()).getArray())
        for (auto& r : *arr)
            byName[r.getProperty ("name", "").toString()] = r;

    for (auto& row : active)
    {
        const auto name = row[ids::name].toString();
        auto it = byName.find (name);
        if (it == byName.end() || ! (bool) it->second.getProperty ("valid", false))
        {
            const auto dir = reg.getProperty ("dir", "~/Library/Mosh/loras/sa3").toString();
            err = "LoRA '" + name + "' not found — drop the .safetensors in " + dir;
            return false;
        }
        lorasKey << name << "=" << row[ids::value].toString()
                 << "@" << it->second.getProperty ("sha12", "").toString()
                 << ":" << it->second.getProperty ("trigger", "").toString() << ";";
    }
    return true;
}

// Slice [srcStartSec, srcEndSec] of an audio file into destWav (raw, no FX) — the
// staged input for a render — ALWAYS written at 44100 Hz / 16-bit / stereo, which is
// the rate the generative engine's reader handles natively (it otherwise shells out to
// ffmpeg, fragile in the deployed app's spawned PATH). Resamples per channel with a
// deterministic LagrangeInterpolator when the source rate differs; 44100/2 also matches
// what computeFingerprint() claims. Pass [0, lengthInSeconds] for a whole clip. Returns
// false (caller errors) if the source can't be read or the range is degenerate, so a
// failed slice never silently renders the wrong audio.
static bool stageWavRegionAt44k (const juce::File& sourceFile, double srcStartSec, double srcEndSec,
                                 const juce::File& destWav)
{
    static constexpr double kStageSR   = 44100.0;
    static constexpr int    kStageBits = 16;
    static constexpr int    kStageCh   = 2;   // engine read_wav duplicates mono → stereo anyway

    if (srcEndSec <= srcStartSec) return false;
    juce::AudioFormatManager fm; fm.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader (fm.createReaderFor (sourceFile));
    if (reader == nullptr || reader->sampleRate <= 0.0) return false;

    const double sr = reader->sampleRate;
    const juce::int64 total = reader->lengthInSamples;
    juce::int64 startSamp = juce::jlimit ((juce::int64) 0, total, (juce::int64) std::floor (srcStartSec * sr));
    juce::int64 endSamp   = juce::jlimit (startSamp,       total, (juce::int64) std::ceil  (srcEndSec   * sr));
    const int numSamps = (int) (endSamp - startSamp);
    if (numSamps <= 0) return false;

    const int srcNumCh = (int) juce::jmax ((unsigned) 1, reader->numChannels);
    juce::AudioBuffer<float> srcBuf (srcNumCh, numSamps);
    if (! reader->read (&srcBuf, 0, numSamps, startSamp, true, true)) return false;

    const bool needResample = std::abs (sr - kStageSR) > 1.0e-6;
    const double ratio = sr / kStageSR;   // > 1 downsamples (48k→44.1k)
    // floor keeps outNum*ratio <= numSamps so the interpolator never reads past srcBuf
    // (a sub-sample duration loss, inaudible). For a 44100 source ratio==1 → outNum==numSamps.
    const int outNum = needResample
        ? (int) std::floor ((double) numSamps * kStageSR / sr)
        : numSamps;
    if (outNum <= 0) return false;

    juce::AudioBuffer<float> outBuf (kStageCh, outNum);
    for (int ch = 0; ch < kStageCh; ++ch)
    {
        const int srcCh = juce::jmin (ch, srcNumCh - 1);   // mono → duplicate into L/R
        if (needResample)
        {
            juce::LagrangeInterpolator interp;             // fresh per channel: zeroed history, deterministic
            interp.process (ratio, srcBuf.getReadPointer (srcCh), outBuf.getWritePointer (ch), outNum);
        }
        else
            outBuf.copyFrom (ch, 0, srcBuf, srcCh, 0, outNum);
    }

    destWav.deleteFile();
    std::unique_ptr<juce::FileOutputStream> os (destWav.createOutputStream());
    if (os == nullptr) return false;
    juce::WavAudioFormat wav;
    std::unique_ptr<juce::AudioFormatWriter> writer (
        wav.createWriterFor (os.get(), kStageSR, (unsigned) kStageCh, kStageBits, {}, 0));
    if (writer == nullptr) return false;
    os.release();   // the writer owns the stream now
    const bool wrote = writer->writeFromAudioSampleBuffer (outBuf, 0, outNum);
    writer.reset(); // flush + close before the caller reads the file back
    return wrote;
}

juce::var MoshOps::cmdCreateRenderLayer (const juce::var& args)
{
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (clipId);
    if (clip == nullptr) return errResult ("create_render_layer", "no clip: " + clipId);
    if (clip->state.getChildWithName (ids::MOSH_RENDERLAYER).isValid())
        return errResult ("create_render_layer", "clip already has a render layer");

    beginTxn ("create_render_layer");
    auto pos = clip->getPosition();
    double rStart = pos.getStart().inSeconds();
    double rEnd   = pos.getEnd().inSeconds();
    // Section-scoped render (agent "rework the hook"): an explicit sub-region — beats
    // resolved to seconds by the caller — bounds the layer to part of the clip. Clamp
    // to the clip's own range; ignore a degenerate range and fall back to the whole clip.
    if (args.hasProperty ("regionStart") && args.hasProperty ("regionEnd"))
    {
        const double cs = rStart, ce = rEnd;
        const double qs = juce::jlimit (cs, ce, (double) args.getProperty ("regionStart", cs));
        const double qe = juce::jlimit (cs, ce, (double) args.getProperty ("regionEnd",   ce));
        if (juce::jmax (qs, qe) - juce::jmin (qs, qe) > 1.0e-3) { rStart = juce::jmin (qs, qe); rEnd = juce::jmax (qs, qe); }
    }
    auto node = RenderLayer::create ("rl-" + String (Time::getCurrentTime().toMilliseconds()),
        clipId, rStart, rEnd,
        args.getProperty ("adapter", "fake").toString());
    if (args.hasProperty ("mode"))         node.setProperty (ids::mode, args.getProperty ("mode", "reimagine"), nullptr);
    if (args.hasProperty ("modelVariant")) node.setProperty (ids::modelVariant, args.getProperty ("modelVariant", ""), nullptr);
    clip->state.appendChild (node, &undoManager());

    auto* data = new DynamicObject();
    data->setProperty ("layerId", node[ids::id].toString());
    logLine ("create_render_layer", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("create_render_layer", var (data));
}

juce::var MoshOps::cmdSetRenderParam (const juce::var& args)
{
    auto node = findRenderLayer (args.getProperty ("clipId", var()).toString());
    if (! node.isValid()) return errResult ("set_render_param", "no render layer");

    beginTxn ("set_render_param");
    auto params = node.getChildWithName (ids::PARAMS);
    if (args.hasProperty ("prompt")) params.setProperty (ids::prompt, args.getProperty ("prompt", ""), &undoManager());
    // cfg/steps are engine-level sampler tuning (env), not per-render controls — not accepted here.
    if (args.hasProperty ("nl"))     params.setProperty (ids::nl, args.getProperty ("nl", 0.4), &undoManager());
    if (args.hasProperty ("target"))   params.setProperty (ids::target, args.getProperty ("target", ""), &undoManager());      // Route B
    if (args.hasProperty ("strength")) params.setProperty (ids::strength, args.getProperty ("strength", 65.0), &undoManager());  // Route B
    if (args.hasProperty ("seed"))   node.setProperty (ids::seed, args.getProperty ("seed", 0), &undoManager());
    if (args.hasProperty ("mode"))   node.setProperty (ids::mode, args.getProperty ("mode", "reimagine"), &undoManager());
    if (args.hasProperty ("coverage")) node.setProperty (ids::coverage, args.getProperty ("coverage", "auto"), &undoManager());  // whole-clip: auto|loop|stitch
    if (args.hasProperty ("modelVariant")) node.setProperty (ids::modelVariant, args.getProperty ("modelVariant", ""), &undoManager());
    if (args.hasProperty ("lab"))    params.setProperty (juce::Identifier ("lab"), args.getProperty ("lab", false), &undoManager());

    if (args.hasProperty ("colors"))   // ≤3, ordered (01 §4.4)
    {
        auto colors = params.getChildWithName (ids::COLORS);
        colors.removeAllChildren (&undoManager());
        if (auto* arr = args.getProperty ("colors", var()).getArray())
            for (int i = 0; i < juce::jmin (3, arr->size()); ++i)
            {
                auto& c = arr->getReference (i);
                juce::ValueTree col (ids::COLOR);
                col.setProperty (ids::name, c.getProperty ("name", ""), nullptr);
                col.setProperty (ids::value, c.getProperty ("value", 0), nullptr);
                colors.appendChild (col, &undoManager());
            }
    }

    if (args.hasProperty ("loras"))   // LoRA rack: unbounded, ordered (stacks merge sequentially)
    {
        // getOrCreate: layers created before the rack shipped have no LORAS child.
        // No count cap / strength clamp (owner call): value > 100 = deliberate overdrive.
        auto loras = params.getOrCreateChildWithName (ids::LORAS, &undoManager());
        loras.removeAllChildren (&undoManager());
        if (auto* arr = args.getProperty ("loras", var()).getArray())
            for (int i = 0; i < arr->size(); ++i)
            {
                auto& l = arr->getReference (i);
                juce::ValueTree lo (ids::LORA);
                lo.setProperty (ids::name, l.getProperty ("name", ""), nullptr);
                lo.setProperty (ids::value, l.getProperty ("value", 0), nullptr);
                loras.appendChild (lo, &undoManager());
            }
    }

    node.setProperty (ids::status, "dirty", nullptr);   // params changed → re-render
    logLine ("set_render_param", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouch (args.getProperty ("clipId", var()).toString());   // Phase 3 — knob auto-apply (re-render in place)
    return okResult ("set_render_param");
}

// compile_render (generative-only v1): a loose instruction → a VALIDATED render envelope,
// applied to the clip's render layer through the SAME PARAMS writes set_render_param uses
// (undoable). Mirrors runLyricGeneration's async land (inline for wait:true; off-thread +
// callAsync, epoch-guarded, for the GUI). The compiler service classifies reimagine vs
// transform vs unsupported; an "unsupported" verdict (corrective/vocal) mutates NOTHING and
// surfaces the honest `say` — we never silently re-perform the take. The compiled envelope
// flows through the existing PARAMS, so the render-cache fingerprint already covers it (no
// new key field). A transient `compiledEnvelope` blob (non-undoable, like lyricProposals)
// carries the mode/backend/reasoning to the UI.
juce::var MoshOps::cmdCompileRender (const juce::var& args)
{
    const auto clipId      = args.getProperty ("clipId", var()).toString();
    const auto instruction = args.getProperty ("instruction", var()).toString();
    const int  intensity   = (int) args.getProperty ("intensity", -1);
    const auto backend     = args.getProperty ("backend", var()).toString();   // ""(auto)|"fake"|"llm"
    const bool autoRender  = (bool) args.getProperty ("autoRender", false);
    const bool wait        = (bool) args.getProperty ("wait", false);

    if (instruction.trim().isEmpty()) return errResult ("compile_render", "instruction required");
    if (findClip (clipId) == nullptr) return errResult ("compile_render", "no clip: " + clipId);

    auto land = [this, clipId, autoRender, wait, args] (const juce::var& result) -> juce::var
    {
        auto* c = findClip (clipId);
        if (c == nullptr) return errResult ("compile_render", "clip gone");
        if (! result.isObject() || ! (bool) result.getProperty ("ok", false))
            return errResult ("compile_render", "compiler service unavailable (start the generative service)");

        const auto mode      = result.getProperty ("mode", "").toString();
        const auto reasoning = result.getProperty ("reasoning", "").toString();
        const auto backendId = result.getProperty ("backend", "").toString();
        const auto say       = result.getProperty ("say", var()).toString();

        if (mode != "reimagine" && mode != "transform")
        {
            // Non-render verdicts — the honest boundary. "corrective" names an EXISTING
            // tool (moshAutoTune/eq/moshOTT/quantize_notes) the caller runs with its own
            // track/clip context; "unsupported" (vocal/noise) declines. Either way we
            // MUTATE NOTHING — generative-only v1 never silently re-performs the take.
            logLine ("compile_render", args, true, {}, false);
            emitSnapshotInvalidated();
            auto* d = new DynamicObject();
            d->setProperty ("mode", mode);
            d->setProperty ("say", say);
            d->setProperty ("reasoning", reasoning);
            d->setProperty ("backend", backendId);
            if (result.hasProperty ("subtype")) d->setProperty ("subtype", result.getProperty ("subtype", var()));
            if (result.hasProperty ("tool"))    d->setProperty ("tool", result.getProperty ("tool", var()));
            return okResult ("compile_render", var (d));
        }

        auto env = result.getProperty ("envelope", var());
        if (! env.isObject()) return errResult ("compile_render", "compiler returned no envelope");

        beginTxn ("compile_render");
        auto node = findRenderLayer (clipId);
        if (! node.isValid())
        {
            auto pos = c->getPosition();
            const juce::String adapter =
                mode == "transform" ? juce::String ("transform")
                : (args.getProperty ("adapter", var()).toString().isNotEmpty()
                       ? args.getProperty ("adapter", "").toString()
                       : juce::String ("fake"));
            node = RenderLayer::create ("rl-" + juce::String (juce::Time::getCurrentTime().toMilliseconds()),
                                        clipId, pos.getStart().inSeconds(), pos.getEnd().inSeconds(), adapter);
            node.setProperty (ids::mode, mode, nullptr);
            if (args.hasProperty ("modelVariant")) node.setProperty (ids::modelVariant, args.getProperty ("modelVariant", ""), nullptr);
            c->state.appendChild (node, &undoManager());
        }
        else
            node.setProperty (ids::mode, mode, &undoManager());

        auto params = node.getChildWithName (ids::PARAMS);
        if (mode == "reimagine")
        {
            params.setProperty (ids::prompt, env.getProperty ("prompt", ""), &undoManager());
            params.setProperty (ids::nl,     env.getProperty ("nl", 0.4),    &undoManager());
            params.setProperty (juce::Identifier ("lab"), env.getProperty ("lab", false), &undoManager());
            auto colors = params.getChildWithName (ids::COLORS);
            colors.removeAllChildren (&undoManager());
            if (auto* arr = env.getProperty ("colors", var()).getArray())
                for (int i = 0; i < juce::jmin (3, arr->size()); ++i)
                {
                    auto& cc = arr->getReference (i);
                    juce::ValueTree col (ids::COLOR);
                    col.setProperty (ids::name,  cc.getProperty ("name", ""), nullptr);
                    col.setProperty (ids::value, cc.getProperty ("value", 0), nullptr);
                    colors.appendChild (col, &undoManager());
                }
        }
        else // transform
        {
            params.setProperty (ids::target,   env.getProperty ("target", ""),     &undoManager());
            params.setProperty (ids::strength, env.getProperty ("strength", 65.0), &undoManager());
        }
        node.setProperty (ids::seed, env.getProperty ("seed", 0), &undoManager());
        node.setProperty (ids::status, "dirty", nullptr);
        node.setProperty (ids::compiledEnvelope, juce::JSON::toString (result), nullptr);  // transient

        logLine ("compile_render", args, true, {}, true);
        emitSnapshotInvalidated();

        var renderRes;
        if (autoRender)   // convenience: kick the render immediately after compiling
        {
            auto* ra = new DynamicObject();
            ra->setProperty ("clipId", clipId);
            ra->setProperty ("wait", wait);
            renderRes = cmdRenderLayer (var (ra));
        }

        auto* d = new DynamicObject();
        d->setProperty ("mode", mode);
        d->setProperty ("backend", backendId);
        d->setProperty ("reasoning", reasoning);
        d->setProperty ("envelope", env);   // the validated envelope (UI display + eval/preference data)
        d->setProperty ("layerId", node[ids::id].toString());
        if (! renderRes.isVoid()) d->setProperty ("render", renderRes);
        return okResult ("compile_render", var (d));
    };

    // Synchronous (harness / agent): block on the compile + land inline.
    if (wait)
        return land (jobManager.compileRender (instruction, intensity, backend));

    // Async (GUI): compile off the message thread; land via callAsync, skipping if a later
    // compile superseded this one.
    const int epoch = ++compileEpoch_;
    std::thread ([this, instruction, intensity, backend, land, epoch]
    {
        auto result = jobManager.compileRender (instruction, intensity, backend);
        juce::MessageManager::callAsync ([this, land, result, epoch]
        {
            if (epoch != compileEpoch_) return;
            land (result);
        });
    }).detach();

    auto* d = new DynamicObject();
    d->setProperty ("status", "compiling");
    return okResult ("compile_render", var (d));
}

// A stable, deterministic signature of a clip's GENERATIVE SOURCE — its MIDI note content
// plus the owning track's instrument + insert-FX names and param VALUES. Used as the
// render-cache upstream hash for non-wave clips, whose bounced audio isn't bit-stable.
// Editing a note OR an instrument/FX param changes this → cache MISS; an unchanged source
// → identical signature → cache HIT. Deliberately hashes note fields + param values, NOT
// the clip/plugin `state` ValueTrees — a synth scribbles its free-running phase into its
// opaque state chunk during render, which would make the signature differ every render.
static juce::String stableSourceSig (te::Clip& clip)
{
    juce::MemoryOutputStream mos;
    if (auto* m = dynamic_cast<te::MidiClip*> (&clip))
    {
        auto& seq = m->getSequence();
        for (int i = 0; i < seq.getNumNotes(); ++i)
            if (auto* n = seq.getNote (i))
            {
                mos.writeInt (n->getNoteNumber());
                mos.writeDouble (n->getStartBeat().inBeats());
                mos.writeDouble (n->getLengthBeats().inBeats());
                mos.writeInt (n->getVelocity());
            }
    }
    if (auto* tr = clip.getTrack())
        for (auto* p : tr->pluginList.getPlugins())
            if (p != nullptr)
            {
                mos.writeString (p->getName());                         // instrument/FX identity
                mos.writeBool (p->isEnabled());                         // bypass changes the bounced audio
                const int np = p->getNumAutomatableParameters();
                for (int i = 0; i < np; ++i)
                    if (auto par = p->getAutomatableParameter (i))
                    {
                        mos.writeFloat ((float) par->getCurrentNormalisedValue());  // base value (user setting)
                        if (par->hasAutomationPoints())                 // + the automation curve shape, if any
                        {
                            auto& curve = par->getCurve();
                            for (int j = 0; j < curve.getNumPoints(); ++j)
                            {
                                mos.writeDouble (curve.getPointTime (j).inSeconds());
                                mos.writeFloat ((float) par->valueRange.convertTo0to1 (curve.getPointValue (j)));
                            }
                        }
                    }
            }
    return juce::MD5 (mos.getMemoryBlock()).toHexString();
}

bool MoshOps::bounceClipToWav (te::Clip& clip, double startSec, double endSec, const juce::File& destWav)
{
    auto* track = clip.getTrack();
    if (track == nullptr || endSec <= startSec + 1.0e-4) return false;
    juce::Array<te::Clip*> only; only.add (&clip);
    return bounceRenderToWavImpl (*track, startSec, endSec, destWav, &only);
}

bool MoshOps::bounceTrackToWav (te::Track& track, double startSec, double endSec, const juce::File& destWav)
{
    if (endSec <= startSec + 1.0e-4) return false;
    return bounceRenderToWavImpl (track, startSec, endSec, destWav, nullptr);
}

// The shared offline-render body behind both bounce forms (see the two wrappers).
// `onlyTheseClips == nullptr` renders EVERY clip on the track; a non-null set restricts
// it (the generative auto-bounce's no-neighbour-bleed rule).
bool MoshOps::bounceRenderToWavImpl (te::Track& track, double startSec, double endSec, const juce::File& destWav,
                                     const juce::Array<te::Clip*>* onlyTheseClips)
{
    auto& edit = eng.edit();

    // Render exclusivity (01 §5): detach the Edit from the device before an offline
    // render (Tracktion asserts otherwise). Mirror cmdExportAudio's teardown so the
    // master meter re-attaches to the NEXT context (no ABA reuse). No-op when headless.
    unregisterAllMeterClients();
    edit.getTransport().stop (false, false);
    edit.getTransport().freePlaybackContext();
    lastSeenContext = nullptr;

    destWav.getParentDirectory().createDirectory();
    destWav.deleteFile();

    te::Renderer::Parameters params (edit);
    params.destFile = destWav;
    params.audioFormat = edit.engine.getAudioFileFormatManager().getWavFormat();
    params.bitDepth = 24;
    params.sampleRateForAudio = 44100.0;   // match computeFingerprint's claimed SR/ch (44100/2)
    params.blockSizeForAudio = edit.engine.getDeviceManager().getBlockSize();
    if (params.blockSizeForAudio <= 0) params.blockSizeForAudio = 512;
    params.time = { tracktion::TimePosition::fromSeconds (startSec),
                    tracktion::TimePosition::fromSeconds (endSec) };       // the clip's edit-time window
    juce::Array<te::Track*> just; just.add (&track);
    params.tracksToDo = te::toBitSet (just);                              // ONLY this clip's track…
    if (onlyTheseClips != nullptr) params.allowedClips = *onlyTheseClips;  // …and ONLY those clips (no neighbour bleed)
    params.usePlugins = true;            // we WANT the instrument + insert FX (that's the clip's sound)
    params.useMasterPlugins = false;     // bounce the track's own signal, not the full master mix
    params.createMidiFile = false;
    // Realtime-only hosted synths (e.g. Serum) can't render offline — reuse the export guard.
    params.realTimeRender = findSerumRealtimeRenderReason (edit).isNotEmpty();

    juce::String renderError;
    {
        const te::Edit::ScopedRenderStatus srs (edit, true);
        te::TransportControl::stopAllTransports (edit.engine, false, true);
        te::Renderer::turnOffAllPlugins (edit);

        if (params.tracksToDo.countNumberOfSetBits() > 0 && ! params.destFile.isDirectory())
        {
            te::Renderer::RenderTask task ("Mosh bounce", params, nullptr, nullptr);

            // Same no-progress watchdog + absolute deadline cmdExportAudio uses, so a
            // stuck bounce (e.g. an unreadable source) errors cleanly instead of hanging.
            const double secs = juce::jmax (0.1, endSec - startSec);
            const juce::uint32 startMs    = juce::Time::getMillisecondCounter();
            const juce::uint32 deadlineMs = (juce::uint32) juce::jmax (60000.0, secs * 8000.0 + 60000.0);
            const juce::uint32 stallMs    = 20000;
            float  lastProgress   = -1.0f;
            juce::uint32 lastProgressMs = startMs;
            while (task.runJob() == juce::ThreadPoolJob::jobNeedsRunningAgain)
            {
                const juce::uint32 nowMs = juce::Time::getMillisecondCounter();
                const float p = task.getCurrentTaskProgress();
                if (p > lastProgress) { lastProgress = p; lastProgressMs = nowMs; }
                if (nowMs - lastProgressMs > stallMs || nowMs - startMs > deadlineMs)
                {
                    if (task.errorMessage.isEmpty()) task.errorMessage = "bounce render stalled";
                    break;
                }
            }
            te::Renderer::turnOffAllPlugins (edit);
            if (task.errorMessage.isNotEmpty()) { renderError = task.errorMessage; destWav.deleteFile(); }
        }
        else renderError = "no renderable track for bounce";
    }
    return renderError.isEmpty() && destWav.existsAsFile() && destWav.getSize() > 0;
}

juce::var MoshOps::cmdRenderLayer (const juce::var& args)
{
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (clipId);
    auto node = findRenderLayer (clipId);
    if (clip == nullptr || ! node.isValid()) return errResult ("render_layer", "no render layer");

    // Sing precondition FIRST — before any staging work. A sheet-less sing render on a
    // MIDI/drum clip would otherwise pay a full instrument bounce before erroring (the
    // sheet can vanish between create_render_layer and render_layer via remove_lyric_sheet).
    if (node[ids::mode].toString() == "sing")
    {
        auto* singTrack = dynamic_cast<te::AudioTrack*> (clip->getTrack());
        const auto sheet = singTrack != nullptr ? singTrack->state.getChildWithName (ids::MOSH_LYRICSHEET)
                                                : juce::ValueTree();
        if (! sheet.isValid())
            return errResult ("render_layer", "sing needs a lyric sheet on the clip's track (build a flow from a take first)");
        auto lines = mosh::LyricSheet::lines (sheet);
        int singableLines = 0;
        for (int i = 0; i < lines.getNumChildren(); ++i)
            if (lyricLineIsAssertedForSing (lines.getChild (i)))
                ++singableLines;
        if (singableLines == 0)
            return errResult ("render_layer", noAssertedWordsToSingMessage());
    }

    // Phase 3 — snapshot the reactive epoch at submit; finalizeRender drops a result whose epoch the
    // node has since moved past (a newer edit-touch superseded this render). -1 ⇒ never raced.
    const int submitEpoch = (int) node[ids::reactiveEpoch];

    // Prepare the job dir + stage the render input as input.wav. Wave clips stage their
    // source audio (whole or a sliced sub-region); MIDI/drum (any non-wave) clips are
    // auto-BOUNCED to audio first (their instrument output) so the audio→audio generative
    // pipeline can run on ANY track — the model never sees MIDI.
    auto jobDir = eng.sessionDir().getChildFile ("renders").getChildFile (node[ids::id].toString());
    jobDir.createDirectory();
    auto input = jobDir.getChildFile ("input.wav");
    auto output = jobDir.getChildFile ("output.wav");
    auto manifest = jobDir.getChildFile ("output_manifest.json");
    input.deleteFile();

    // Section-scoped layers carry a sub-region tighter than the clip. The stored timeRange
    // is absolute timeline seconds frozen at create; CLAMP it to the clip's LIVE position
    // so a clip moved/trimmed since then can't mis-stage — a stale range that no longer
    // overlaps collapses to the whole clip. Computed for ALL clip types (the bounce path
    // renders [rs,re] directly via params.time; the wave path slices it).
    auto cpos = clip->getPosition();
    const double cs = cpos.getStart().inSeconds(), ce = cpos.getEnd().inSeconds();
    double rs = juce::jlimit (cs, ce, (double) node[ids::timeRangeStart]);
    double re = juce::jlimit (cs, ce, (double) node[ids::timeRangeEnd]);
    if (re <= rs + 1.0e-3) { rs = cs; re = ce; }   // stale/degenerate after a move → whole clip
    const bool subRegion = (rs > cs + 1.0e-3) || (re < ce - 1.0e-3);

    // Non-wave clips fingerprint their stable source (notes + instrument/FX), not the
    // non-deterministic bounced audio. Captured BEFORE the bounce so render side-effects
    // can't perturb it. Empty for wave clips → computeFingerprint hashes input.wav.
    juce::String upstreamOverride;

    if (auto* wave = dynamic_cast<te::WaveAudioClip*> (clip))
    {
        // Always re-imagine the PRISTINE original. Once a render is auto-applied in place
        // (the clip's source becomes the artifact), staging getCurrentSourceFile() would
        // re-imagine the previous render and compound it — so prefer originalSourceRef.
        juce::File sourceForStaging = wave->getCurrentSourceFile();
        if (const auto orig = node[ids::originalSourceRef].toString(); orig.isNotEmpty())
        {
            // originalSourceRef may be project-relative — resolve against the edit dir (a bare
            // juce::File("audio/x.wav") would be CWD-relative and miss, then wrongly stage the
            // already-applied artifact and compound the render).
            juce::File of = juce::File::isAbsolutePath (orig) ? juce::File (orig)
                            : eng.editFile().getParentDirectory().getChildFile (orig);
            if (of.existsAsFile()) sourceForStaging = of;
        }

        bool staged = false;
        if (subRegion)
        {
            const bool sliceable = std::abs (wave->getSpeedRatio() - 1.0) < 1.0e-6
                                   && ! wave->isLooping() && ! wave->getAutoTempo();
            if (sliceable)
            {
                const double off = cpos.getOffset().inSeconds();
                staged = stageWavRegionAt44k (sourceForStaging, rs - cs + off, re - cs + off, input);
            }
            if (! staged)   // never fall back to the whole clip for a section request
                return errResult ("render_layer", "section render needs an un-stretched, non-looping wave clip");
        }
        if (! staged)
        {
            // Whole clip: stage the entire source at 44100/16-bit (was a raw copyFileTo, which
            // preserved a non-44100 rate the engine reader can't handle without ffmpeg).
            juce::AudioFormatManager fm; fm.registerBasicFormats();
            std::unique_ptr<juce::AudioFormatReader> rd (fm.createReaderFor (sourceForStaging));
            const double srcLenSec = (rd != nullptr && rd->sampleRate > 0.0)
                ? (double) rd->lengthInSamples / rd->sampleRate : 0.0;
            rd.reset();
            if (srcLenSec <= 0.0
                || ! stageWavRegionAt44k (sourceForStaging, 0.0, srcLenSec, input))
                return errResult ("render_layer", "could not stage source region");
        }
    }
    else
    {
        // MIDI/drum (any non-wave) clip: fingerprint the stable source first, then bounce
        // its instrument output for [rs,re] to input.wav. params.time handles whole-clip
        // AND section renders, so no slicing. Fold the bounce window — as CLIP-RELATIVE
        // offsets — into the signature so a section render busts the cache when the clip is
        // moved/trimmed (the absolute window then covers different notes). Whole-clip stays
        // move-invariant (rs-cs=0, re-cs=clipLen). Mirrors the wave path's self-correction.
        upstreamOverride = stableSourceSig (*clip)
            + ":" + juce::String (rs - cs, 4)
            + ":" + juce::String (re - cs, 4)
            + ":" + juce::String (cpos.getOffset().inSeconds(), 4);
        // Phase 2: when this clip already has a hidden beneath-render it is MUTED (the producer hears
        // the hidden audio). bounceClipToWav must still capture the instrument output, so temporarily
        // un-mute across the (already device-detached) offline render and restore. The net ValueTree
        // change is zero — an undo of it is a no-op.
        const bool wasMuted = clip->isMuted();
        if (wasMuted) clip->setMuted (false);
        const bool bounced = bounceClipToWav (*clip, rs, re, input);
        if (wasMuted) clip->setMuted (true);
        if (! bounced)
            return errResult ("render_layer", "could not bounce clip to audio (add an instrument, or the render failed)");
    }

    // FMS Phase-3 sing mode: the render is a function of the lyric SHEET (words +
    // Stage-1 `lyricScore` flow), not just the staged audio. Gather the clip's track's
    // lines into the job params and fold their hash into the upstream key, so a lyric
    // or flow edit is a cache MISS (while the staged-audio/source hash stays in the key).
    juce::var singLines;
    if (node[ids::mode].toString() == "sing")
    {
        auto* singTrack = dynamic_cast<te::AudioTrack*> (clip->getTrack());
        auto sheet = singTrack != nullptr ? singTrack->state.getChildWithName (ids::MOSH_LYRICSHEET)
                                          : juce::ValueTree();
        if (! sheet.isValid())
            return errResult ("render_layer", "sing needs a lyric sheet on the clip's track (build a flow from a take first)");
        Array<var> arr;
        auto lines = mosh::LyricSheet::lines (sheet);
        for (int i = 0; i < lines.getNumChildren(); ++i)
        {
            auto l = lines.getChild (i);
            if (! lyricLineIsAssertedForSing (l))
                continue;
            auto* lo = new DynamicObject();
            lo->setProperty ("text", l[ids::lyricText].toString());
            const auto parsed = juce::JSON::parse (l[ids::lyricScore].toString());
            if (! parsed.isObject())
                continue;
            lo->setProperty ("score", parsed);
            lo->setProperty ("asserted", true);
            arr.add (var (lo));
        }
        if (arr.isEmpty())
            return errResult ("render_layer", noAssertedWordsToSingMessage());
        singLines = var (arr);
        const auto singJson = juce::JSON::toString (singLines, true);
        const auto singSig = juce::MD5 (singJson.toRawUTF8(), (size_t) singJson.getNumBytesAsUTF8()).toHexString();
        upstreamOverride = (upstreamOverride.isNotEmpty() ? upstreamOverride
                                                          : juce::MD5 (input).toHexString())
                           + ":sing:" + singSig;
    }

    // Ensure the service first so its build/version is part of EVERY fingerprint
    // (else the first render hashes an empty build and the cache never hits).
    if (! jobManager.ensureServiceRunning())
        return errResult ("render_layer", "generative service unavailable");

    // Resolve the LoRA rack to its content identity (sha12 + trigger via /loras) —
    // an unknown adapter name fails HERE, before any submit or cache probe.
    juce::String lorasKey, lorasErr;
    if (! resolveLorasKey (node, lorasKey, lorasErr))
        return errResult ("render_layer", lorasErr);

    const auto fp = computeFingerprint (node, input, upstreamOverride, lorasKey);

    // Cache by FULL fingerprint (05 §5) — reuse only on an exact match. Resolve the
    // artifact move-aware (AL-009): a Save-As'd project stores cacheArtifact relative.
    if (node[ids::cacheKey].toString() == fp
        && mosh::resolveCacheArtifact (node, eng.editFile().getParentDirectory()).existsAsFile())
    {
        // Re-apply on HIT too (a wave clip Reset since the last render must re-swap to the
        // cached artifact). applyRenderInPlace is a no-op repoint when already applied.
        // SING never auto-applies (same gate as finalizeRender — the guide vocal stays
        // an auditionable artifact, it must not replace the recorded take in place).
        auto art = mosh::resolveCacheArtifact (node, eng.editFile().getParentDirectory());
        if (node[ids::mode].toString() == "sing"
            || (! applyRenderInPlace (clipId, node, art, fp)
                && ! applyRenderBeneathMidi (clipId, node, art, fp)))
            node.setProperty (ids::status, "ready", nullptr);
        emit ("layer_status", [&] { auto* o = new DynamicObject();
            o->setProperty ("clipId", clipId); o->setProperty ("layerId", node[ids::id]);
            o->setProperty ("status", "ready"); o->setProperty ("cache", "hit"); return var (o); }());
        logLine ("render_layer", args, true, {}, false);
        auto* d = new DynamicObject(); d->setProperty ("cache", "hit"); d->setProperty ("status", "ready");
        return okResult ("render_layer", var (d));
    }

    // Build the job params from the node.
    auto params = node.getChildWithName (ids::PARAMS);
    auto* p = new DynamicObject();
    p->setProperty ("prompt", params[ids::prompt]);
    p->setProperty ("seed", node[ids::seed]);
    p->setProperty ("nl", params[ids::nl]);
    // cfg/steps intentionally NOT sent — sampler tuning is engine-level env on both
    // backends (MLX SA3_STEPS / CUDA MOSH_SA3_STEPS·MOSH_SA3_CFG), not a per-render param.
    p->setProperty ("mode", node[ids::mode]);          // Route B: route the adapter (reimagine|generate|transform)
    p->setProperty ("target", params[ids::target]);    // Route B transform target
    p->setProperty ("strength", params[ids::strength]); // Route B transform strength (0–100)
    Array<var> colors;
    if (auto cs = params.getChildWithName (ids::COLORS); cs.isValid())
        for (int i = 0; i < cs.getNumChildren(); ++i)
        {
            auto* co = new DynamicObject();
            co->setProperty ("name", cs.getChild (i)[ids::name]);
            co->setProperty ("value", cs.getChild (i)[ids::value]);
            colors.add (var (co));
        }
    p->setProperty ("colors", colors);
    Array<var> lorasArr;
    if (auto ls = params.getChildWithName (ids::LORAS); ls.isValid())
        for (int i = 0; i < ls.getNumChildren(); ++i)
        {
            auto* lo = new DynamicObject();
            lo->setProperty ("name", ls.getChild (i)[ids::name]);
            lo->setProperty ("value", ls.getChild (i)[ids::value]);
            lorasArr.add (var (lo));
        }
    p->setProperty ("loras", lorasArr);
    p->setProperty ("lab", (bool) params.getProperty (juce::Identifier ("lab"), false));
    if (! singLines.isVoid())
        p->setProperty ("lines", singLines);   // sing: sheet text + lyricScore flow per line

    // Whole-clip coverage (1b): tell the adapter the FULL target length + how to cover a clip
    // longer than the model's single render window — tile one cycle ("loop") or window+crossfade
    // ("stitch"). Fixes the "render came back short" 8s-cap bug. The staged input.wav IS the audio
    // to cover, so its duration is the target. "auto" → loop a clip flagged looping, else stitch.
    {
        double inputDur = re - rs;
        { juce::AudioFormatManager fm; fm.registerBasicFormats();
          if (std::unique_ptr<juce::AudioFormatReader> rd (fm.createReaderFor (input));
              rd != nullptr && rd->sampleRate > 0.0)
              inputDur = (double) rd->lengthInSamples / rd->sampleRate; }
        juce::String cov = node[ids::coverage].toString();
        if (cov.isEmpty() || cov == "auto")
        {
            const bool looping = [&] { if (auto* w = dynamic_cast<te::WaveAudioClip*> (clip)) return w->isLooping(); return false; }();
            cov = looping ? "loop" : "stitch";
        }
        p->setProperty ("duration_s", inputDur);
        p->setProperty ("coverage", cov);
        p->setProperty ("loop_seconds", inputDur);   // one cycle; the adapter clamps to its window
        p->setProperty ("xfade_ms", 8.0);
    }

    const auto jobId = jobManager.submitJob (node[ids::modelAdapter].toString(),
                                             input, output, manifest, var (p));
    if (jobId.isEmpty()) return errResult ("render_layer", "job submit failed");

    node.setProperty (ids::cacheKey, fp, nullptr);
    node.setProperty (ids::renderError, "", nullptr);   // clear any stale error from a prior failed render
    node.setProperty (ids::status, "rendering", nullptr);
    emit ("layer_status", [&] { auto* o = new DynamicObject();
        o->setProperty ("clipId", clipId); o->setProperty ("layerId", node[ids::id]);
        o->setProperty ("status", "rendering"); o->setProperty ("cache", "miss");
        o->setProperty ("jobId", jobId); return var (o); }());

    // Poll. Headless harness uses wait:true (inline); the GUI polls async on a
    // background thread so playback never stalls (05 §4) — see below.
    const bool wait = (bool) args.getProperty ("wait", false);
    if (wait)
    {
        const auto adapter = node[ids::modelAdapter].toString();
        // soulx's REAL backend is an SSH round-trip budgeted at up to 900s
        // (MOSH_SOULX_TIMEOUT_S) — the poll must outlast it or a slow render
        // reads as a false timeout. The fake path finishes in <1s regardless.
        const auto defaultWaitMs = (adapter == "stable_audio3" || adapter == "sa3") ? "360000"
                                 : (adapter == "soulx")                             ? "960000"
                                                                                    : "120000";
        const int waitTimeoutMs = juce::jmax (1000, juce::SystemStats::getEnvironmentVariable (
            "MOSH_RENDER_WAIT_TIMEOUT_MS", defaultWaitMs).getIntValue());
        const int maxPolls = juce::jmax (1, waitTimeoutMs / 50);
        const int statusConnectMs = adapter == "soulx" ? 350 : 1000;
        const int healthConnectMs = 250;
        const int maxSilentStatusPolls = adapter == "soulx" ? 3 : 5;
        int silentStatusPolls = 0;
        juce::String lastErr;
        for (int i = 0; i < maxPolls; ++i)   // default ~120s; PC CUDA cold loads can opt into longer waits
        {
            auto st = jobManager.jobStatus (jobId, statusConnectMs);
            const bool statusReachable = st.isObject();
            if (! statusReachable)
            {
                ++silentStatusPolls;
                if (output.existsAsFile() && manifest.existsAsFile())
                    break;
                if (silentStatusPolls >= maxSilentStatusPolls && ! jobManager.isHealthy (healthConnectMs))
                {
                    lastErr = "generative service stopped answering /status and /health while waiting for "
                              + adapter + " render " + jobId;
                    break;
                }
                juce::Thread::sleep (50);
                continue;
            }

            silentStatusPolls = 0;
            const auto status = st.getProperty ("status", var()).toString();
            if (const auto err = st.getProperty ("error", var()).toString(); err.isNotEmpty()) lastErr = err;
            emit ("layer_render_progress", [&] { auto* o = new DynamicObject();
                o->setProperty ("clipId", clipId); o->setProperty ("jobId", jobId);
                o->setProperty ("progress", st.getProperty ("progress", 0.0)); return var (o); }());
            // The file+manifest pair is the durable job contract. Real SA3 can finish
            // and write both files while /status is already unreachable during process
            // teardown, so don't turn a completed render into a false timeout.
            if (status == "ready" || (output.existsAsFile() && manifest.existsAsFile())
                || status == "error" || status == "cancelled")
                break;
            juce::Thread::sleep (50);
        }
        finalizeRender (clipId, output, manifest, fp, lastErr, submitEpoch);
        logLine ("render_layer", args, true, {}, false);
        auto* d = new DynamicObject(); d->setProperty ("cache", "miss");
        d->setProperty ("status", node[ids::status]); d->setProperty ("jobId", jobId);
        return okResult ("render_layer", var (d));
    }

    // Async: poll on a background thread, marshal node updates + events to the
    // message thread (service I/O off the message thread; tree on it).
    // soulx's real SSH backend runs up to 900s — poll long enough that a legitimate
    // slow render isn't abandoned as a false 'error' while the job completes unseen.
    const int asyncPolls = node[ids::modelAdapter].toString() == "soulx" ? 9600 : 1800;
    const auto asyncAdapter = node[ids::modelAdapter].toString();
    std::thread ([this, clipId, jobId, output, manifest, fp, asyncPolls, submitEpoch, asyncAdapter]
    {
        const int statusConnectMs = asyncAdapter == "soulx" ? 350 : 1000;
        const int healthConnectMs = 250;
        const int maxSilentStatusPolls = asyncAdapter == "soulx" ? 3 : 5;
        int silentStatusPolls = 0;
        juce::String lastErr;
        for (int i = 0; i < asyncPolls; ++i)   // 100ms ticks: ~180s default, ~960s soulx
        {
            auto st = jobManager.jobStatus (jobId, statusConnectMs);
            const bool statusReachable = st.isObject();
            if (! statusReachable)
            {
                ++silentStatusPolls;
                if (output.existsAsFile() && manifest.existsAsFile())
                    break;
                if (silentStatusPolls >= maxSilentStatusPolls && ! jobManager.isHealthy (healthConnectMs))
                {
                    lastErr = "generative service stopped answering /status and /health while waiting for "
                              + asyncAdapter + " render " + jobId;
                    break;
                }
                juce::Thread::sleep (100);
                continue;
            }

            silentStatusPolls = 0;
            const auto status = st.getProperty ("status", juce::var()).toString();
            const auto progress = st.getProperty ("progress", 0.0);
            if (const auto err = st.getProperty ("error", juce::var()).toString(); err.isNotEmpty()) lastErr = err;
            juce::MessageManager::callAsync ([this, clipId, jobId, progress]
            {
                emit ("layer_render_progress", [&] { auto* o = new juce::DynamicObject();
                    o->setProperty ("clipId", clipId); o->setProperty ("jobId", jobId);
                    o->setProperty ("progress", progress); return juce::var (o); }());
            });
            if (status == "ready" || (output.existsAsFile() && manifest.existsAsFile())
                || status == "error" || status == "cancelled")
                break;
            juce::Thread::sleep (100);
        }
        juce::MessageManager::callAsync ([this, clipId, output, manifest, fp, lastErr, submitEpoch]
        {
            finalizeRender (clipId, output, manifest, fp, lastErr, submitEpoch);
        });
    }).detach();

    logLine ("render_layer", args, true, {}, false);
    auto* d = new DynamicObject(); d->setProperty ("cache", "miss");
    d->setProperty ("status", "rendering"); d->setProperty ("jobId", jobId);
    return okResult ("render_layer", var (d));
}

void MoshOps::finalizeRender (const juce::String& clipId, const juce::File& outputWav,
                              const juce::File& manifestFile, const juce::String& cacheKey,
                              const juce::String& serviceError, int expectedEpoch)
{
    auto node = findRenderLayer (clipId);
    if (! node.isValid()) return;

    // Phase 3 — drop a SUPERSEDED reactive render: a newer edit-touch bumped reactiveEpoch after this
    // job was submitted, so its (now-stale) output must not overwrite the live state. The newer touch's
    // own debounced render is already coming. (expectedEpoch < 0 ⇒ a render that never raced.)
    if (expectedEpoch >= 0 && (int) node[ids::reactiveEpoch] != expectedEpoch)
        return;
    if (! outputWav.existsAsFile())
    {
        // Surface the real reason (the service's exception, when we captured one) instead of a
        // bare "error" badge — otherwise the only signal is a missing file.
        const juce::String reason = serviceError.isNotEmpty() ? serviceError
                                                              : juce::String ("render produced no output");
        node.setProperty (ids::renderError, reason, nullptr);
        node.setProperty (ids::status, "error", nullptr);
        emit ("layer_status", [&] { auto* o = new DynamicObject();
            o->setProperty ("clipId", clipId); o->setProperty ("layerId", node[ids::id]);
            o->setProperty ("status", "error"); o->setProperty ("error", reason); return var (o); }());
        emitSnapshotInvalidated();
        return;
    }

    node.setProperty (ids::renderError, "", nullptr);   // clear on success

    // P5 — boundary-quantized swap (ORDINARY renders only; the Live lane lands its own
    // windows with a crossfade at the knob, the owner's default): a render that finishes
    // while the producer is LISTENING to the target clip must not swap mid-phrase — hold
    // it until the next musical boundary (the loop wrap when looping, else the next bar),
    // then land. Stopped transport / headless / sing (never auto-applies) / a Live-armed
    // layer land immediately as before.
    double boundarySec = 0.0, armedPosSec = 0.0;
    if (node[ids::mode].toString() != "sing"
        && ! (bool) node[ids::liveArmed]
        && shouldDeferSwap (clipId, boundarySec, armedPosSec))
    {
        pendingSwaps[clipId] = { outputWav, manifestFile, cacheKey, expectedEpoch,
                                 boundarySec, armedPosSec };
        if (swapTimer == nullptr)
            swapTimer = std::make_unique<SwapTimer> (*this);
        if (! swapTimer->isTimerRunning())
            swapTimer->startTimerHz (30);   // the same decimation rate as the transport rail
        return;   // status stays "rendering"; pollPendingSwaps() lands it at the boundary
    }

    applyFinalizedRender (clipId, outputWav, manifestFile, cacheKey);
}

void MoshOps::applyFinalizedRender (const juce::String& clipId, const juce::File& outputWav,
                                    const juce::File& manifestFile, const juce::String& cacheKey)
{
    auto node = findRenderLayer (clipId);
    if (! node.isValid()) return;

    // Auto-apply the render (the new default): WAVE clips swap their own source in place; MIDI/drum
    // clips land a HIDDEN looping audio clip beneath the now-muted MIDI (Phase 2). Either way it's an
    // instant preview with no accept step. A sub-region render (or a clip with no track) falls through
    // to the legacy "Neural Renders" lane (accept_render); the apply helpers return false for it.
    // SING keeps the legacy auditionable landing: the guide vocal must never replace the producer's
    // recorded take in place (and must not arm the reactive loop — a casual edit would fire a
    // multi-minute SSH render). imagine/transform are what the in-place model was built for.
    const bool autoApply = node[ids::mode].toString() != "sing";
    if (! (autoApply && (applyRenderInPlace (clipId, node, outputWav, cacheKey)
                         || applyRenderBeneathMidi (clipId, node, outputWav, cacheKey))))
    {
        node.setProperty (ids::cacheArtifact, outputWav.getFullPathName(), nullptr);
        node.setProperty (ids::cacheKey, cacheKey, nullptr);
        node.setProperty (ids::status, "ready", nullptr);
    }

    var qa = manifestFile.existsAsFile() ? JSON::parse (manifestFile.loadFileAsString()) : var();
    emit ("layer_status", [&] { auto* o = new DynamicObject();
        o->setProperty ("clipId", clipId); o->setProperty ("layerId", node[ids::id]);
        o->setProperty ("status", "ready"); o->setProperty ("cache", "miss");
        o->setProperty ("qa", qa); return var (o); }());
    emitSnapshotInvalidated();
}

bool MoshOps::shouldDeferSwap (const juce::String& clipId, double& boundarySec, double& posSec)
{
    // Only meaningful when audio is actually audible: headless (selftest/run-script)
    // never defers, so the harness stays deterministic by construction.
    if (! eng.hasAudio())
        return false;
    if (juce::SystemStats::getEnvironmentVariable ("MOSH_SWAP_QUANTIZE", "1") == "0")
        return false;   // escape hatch: land renders the instant they finish

    auto& transport = eng.edit().getTransport();
    if (! transport.isPlaying())
        return false;

    auto* clip = findClip (clipId);
    if (clip == nullptr)
        return false;
    const auto cpos = clip->getPosition();
    const double cs = cpos.getStart().inSeconds(), ce = cpos.getEnd().inSeconds();
    posSec = transport.getPosition().inSeconds();
    if (posSec < cs - 1.0e-3 || posSec >= ce - 1.0e-3)
        return false;   // the playhead isn't in this clip — nothing audible interrupts

    // Loop wrap when the transport loop is on and surrounds the playhead — "the change
    // arrives when the loop comes around".
    if (transport.looping.get())
    {
        const auto lr = transport.getLoopRange();
        const double ls = lr.getStart().inSeconds(), le = lr.getEnd().inSeconds();
        if (le > ls && posSec >= ls && posSec < le)
        {
            boundarySec = le;
            return true;
        }
    }

    // Otherwise the next BAR boundary from the tempo sequence.
    const auto bb = eng.edit().tempoSequence.toBarsAndBeats (
        tracktion::TimePosition::fromSeconds (posSec));
    tracktion::tempo::BarsAndBeats next;
    next.bars = bb.bars + 1;
    boundarySec = eng.edit().tempoSequence.toTime (next).inSeconds();
    return boundarySec > posSec + 1.0e-3;
}

void MoshOps::pollPendingSwaps()
{
    if (pendingSwaps.empty())
    {
        if (swapTimer != nullptr)
            swapTimer->stopTimer();
        return;
    }
    auto& transport = eng.edit().getTransport();
    const bool playing = transport.isPlaying();
    const double pos = transport.getPosition().inSeconds();

    for (auto it = pendingSwaps.begin(); it != pendingSwaps.end();)
    {
        auto& ps = it->second;
        const bool wrapped = pos < ps.armedPosSec - 0.05;         // loop wrap or seek-back
        const bool reached = pos >= ps.boundarySec - 1.0e-3;
        if (! playing || wrapped || reached)
        {
            // Same staleness rule as finalizeRender: a reactive render superseded while
            // waiting at the boundary must not land.
            auto node = findRenderLayer (it->first);
            const bool fresh = node.isValid()
                && ! (ps.expectedEpoch >= 0 && (int) node[ids::reactiveEpoch] != ps.expectedEpoch);
            if (fresh)
                applyFinalizedRender (it->first, ps.outputWav, ps.manifestFile, ps.cacheKey);
            it = pendingSwaps.erase (it);
        }
        else
        {
            ps.armedPosSec = pos;   // track motion so a wrap reads as pos going backwards
            ++it;
        }
    }
    if (pendingSwaps.empty() && swapTimer != nullptr)
        swapTimer->stopTimer();
}

bool MoshOps::applyRenderInPlace (const juce::String& clipId, juce::ValueTree node,
                                  const juce::File& artifact, const juce::String& cacheKey)
{
    auto* wave = dynamic_cast<te::WaveAudioClip*> (findClip (clipId));
    if (wave == nullptr || ! artifact.existsAsFile()) return false;   // non-wave → legacy lane path

    // In-place apply replaces the WHOLE clip's source. A sub-region (section-scoped) render
    // can't simply repoint the whole source, so those keep the legacy lane landing.
    {
        auto pos = wave->getPosition();
        const double cs = pos.getStart().inSeconds(), ce = pos.getEnd().inSeconds();
        const double rs = juce::jlimit (cs, ce, (double) node[ids::timeRangeStart]);
        const double re = juce::jlimit (cs, ce, (double) node[ids::timeRangeEnd]);
        if ((rs > cs + 1.0e-3) || (re < ce - 1.0e-3)) return false;   // sub-region → legacy path
    }

    // Durable per-render copy (a disposable artifact), named by the fingerprint so a re-render
    // writes a NEW file instead of overwriting the one the clip currently plays/displays.
    auto dest = eng.sessionDir().getChildFile ("audio")
                    .getChildFile (node[ids::id].toString() + "-" + cacheKey.substring (0, 12))
                    .withFileExtension ("wav");
    dest.getParentDirectory().createDirectory();
    if (dest != artifact && ! dest.existsAsFile() && ! artifact.copyFileTo (dest))
        return false;

    // Capture the ORIGINAL source ONCE (first apply: the clip's current source IS the original).
    // Stored ABSOLUTE; cmdSaveAs's consolidateRenderArtifacts copies it into audio/renders/ and
    // re-points it relative, so the saved project carries no absolute pool path AND "Reset to
    // original" survives a Save-As + move.
    if (node[ids::originalSourceRef].toString().isEmpty())
        node.setProperty (ids::originalSourceRef, wave->getCurrentSourceFile().getFullPathName(), nullptr);

    // The in-place swap is a regenerable PREVIEW, not an undo-history edit — Tracktion's
    // SourceFileReference change isn't routed through the UndoManager. reset_render_layer is the
    // way back; it persists across save/reload via originalSourceRef. (relative iff under the
    // project dir, mirroring relink_clip.)
    const bool local = dest.isAChildOf (eng.editFile().getParentDirectory());
    mosh::repointWaveClipSource (*wave, dest, eng.editFile().getParentDirectory(), local);
    node.setProperty (ids::appliedInPlace, true, nullptr);
    // cacheArtifact stored ABSOLUTE; cmdSaveAs's consolidateRenderArtifacts copies it into
    // audio/renders/ + re-points it relative (so the saved project carries no absolute pool path).
    node.setProperty (ids::cacheArtifact, dest.getFullPathName(), nullptr);
    node.setProperty (ids::cacheKey, cacheKey, nullptr);
    node.setProperty (ids::status, "ready", nullptr);
    return true;
}

bool MoshOps::applyRenderBeneathMidi (const juce::String& clipId, juce::ValueTree node,
                                      const juce::File& artifact, const juce::String& cacheKey)
{
    auto* midi = findClip (clipId);
    if (midi == nullptr || dynamic_cast<te::WaveAudioClip*> (midi) != nullptr) return false;   // wave → in-place path
    if (! artifact.existsAsFile()) return false;

    // Whole-clip only — a sub-region (section-scoped) MIDI render can't be the clip's "hidden self",
    // so those keep the legacy lane landing.
    {
        auto pos = midi->getPosition();
        const double cs = pos.getStart().inSeconds(), ce = pos.getEnd().inSeconds();
        const double rs = juce::jlimit (cs, ce, (double) node[ids::timeRangeStart]);
        const double re = juce::jlimit (cs, ce, (double) node[ids::timeRangeEnd]);
        if ((rs > cs + 1.0e-3) || (re < ce - 1.0e-3)) return false;   // sub-region → legacy path
    }

    // Durable per-render copy (a disposable artifact), named by the fingerprint so a re-render writes
    // a NEW file rather than overwriting the one the hidden clip currently plays.
    auto dest = eng.sessionDir().getChildFile ("audio")
                    .getChildFile (node[ids::id].toString() + "-" + cacheKey.substring (0, 12))
                    .withFileExtension ("wav");
    dest.getParentDirectory().createDirectory();
    if (dest != artifact && ! dest.existsAsFile() && ! artifact.copyFileTo (dest))
        return false;
    const bool local = dest.isAChildOf (eng.editFile().getParentDirectory());

    // RE-RENDER → HOT-SWAP: the hidden clip already exists, so just repoint its source (no structural
    // edit, no undo churn). The MIDI stays muted; the producer hears the updated audio in place.
    if (auto hiddenId = node[kLandedClipId].toString(); hiddenId.isNotEmpty())
        if (auto* hidden = dynamic_cast<te::WaveAudioClip*> (findClip (hiddenId)))
        {
            mosh::repointWaveClipSource (*hidden, dest, eng.editFile().getParentDirectory(), local);
            node.setProperty (ids::cacheArtifact, dest.getFullPathName(), nullptr);
            node.setProperty (ids::cacheKey, cacheKey, nullptr);
            node.setProperty (ids::status, "ready", nullptr);
            return true;
        }

    // FIRST apply: land the hidden full-span audio on a dedicated HIDDEN, INSTRUMENT-FREE track (NOT
    // the source track — its synth would overwrite the buffer and silence the clip) at the MIDI clip's
    // edit position, and MUTE the source MIDI so the re-imagined audio is what plays. snapshot()
    // excludes the hidden track, so the producer hears it but never sees it. One undoable unit — an undo
    // of it is exactly reset_render_layer (hidden clip removed + MIDI un-muted). The hidden track/clip +
    // the mute + the node markers persist with the .tracktionedit, so the model survives save/reload.
    auto pos = midi->getPosition();
    beginTxn ("apply_render_beneath");
    auto* hiddenTrack = findOrCreateHiddenRenderTrack();
    if (hiddenTrack == nullptr) return false;
    auto landed = hiddenTrack->insertWaveClip ("mosh-render-" + midi->getName(), dest,
        { { pos.getStart(), pos.getLength() }, {} }, false);
    if (landed == nullptr) return false;
    landed->state.setProperty (ids::moshHidden, true, &undoManager());
    midi->setMuted (true);
    node.setProperty (kLandedClipId, landed->itemID.toString(), &undoManager());
    node.setProperty (kSourceMutedByLayer, true, &undoManager());
    node.setProperty (ids::cacheArtifact, dest.getFullPathName(), nullptr);   // regenerable metadata → no undo
    node.setProperty (ids::cacheKey, cacheKey, nullptr);
    node.setProperty (ids::status, "ready", nullptr);
    return true;
}

te::AudioTrack* MoshOps::findOrCreateHiddenRenderTrack()
{
    // The single shared, instrument-free, snapshot-excluded track that holds every drum/MIDI
    // beneath-render clip (Phase 2). Found by its moshHidden flag (the name is cosmetic); created
    // once and reused. NOT undo-created on purpose mismatch — it's created inside the caller's txn.
    // METER-001 — deliberately NOT auto-metered: it's excluded from snapshot() entirely (the
    // producer never sees this track), so a meter tap here would only cost cycles + bytes over
    // the "levels" bridge event with no UI ever able to read it.
    for (auto* t : te::getAudioTracks (eng.edit()))
        if (t != nullptr && (bool) t->state.getProperty (ids::moshHidden, false))
            return t;
    auto* t = createAudioTrack ("re-imagined (hidden)");
    if (t != nullptr)
        t->state.setProperty (ids::moshHidden, true, &undoManager());
    return t;
}

juce::var MoshOps::cmdResetRenderLayer (const juce::var& args)
{
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (clipId);
    auto node = findRenderLayer (clipId);
    if (clip == nullptr || ! node.isValid()) return errResult ("reset_render_layer", "no render layer");

    // Phase 2 — MIDI/drum beneath-model: remove the hidden audio clip and un-mute the source MIDI, so
    // the producer is back to the live, editable instrument. Undoable (mirrors the apply txn).
    if (dynamic_cast<te::WaveAudioClip*> (clip) == nullptr)
    {
        if (! (bool) node[kSourceMutedByLayer])
            return errResult ("reset_render_layer", "nothing to reset");
        beginTxn ("reset_render_layer");
        if (auto hiddenId = node[kLandedClipId].toString(); hiddenId.isNotEmpty())
            if (auto* hidden = findClip (hiddenId); hidden != nullptr && hidden != clip)
                hidden->removeFromParent();
        clip->setMuted (false);
        node.setProperty (kLandedClipId, "", &undoManager());
        node.setProperty (kSourceMutedByLayer, false, &undoManager());
        node.setProperty (ids::status, "dirty", &undoManager());   // re-imagine is available again
        // JSONL TASTE LABEL (05 §9): with in-place/beneath auto-apply, reset IS the
        // workflow's reject — carry the join keys (layerId/cacheKey/adapter) so the
        // label pairs with the render artifact in the taste census.
        {
            auto* tl = new DynamicObject();
            tl->setProperty ("clipId", clipId); tl->setProperty ("layerId", node[ids::id]);
            tl->setProperty ("cacheKey", node[ids::cacheKey]);
            tl->setProperty ("adapter", node[ids::modelAdapter]);
            logLine ("reset_render_layer", var (tl), true, {}, false);
        }
        emitSnapshotInvalidated();
        return okResult ("reset_render_layer");
    }

    auto* wave = dynamic_cast<te::WaveAudioClip*> (clip);
    const auto orig = node[ids::originalSourceRef].toString();
    if (orig.isEmpty()) return errResult ("reset_render_layer", "no original source to restore");
    juce::File of = juce::File::isAbsolutePath (orig) ? juce::File (orig)
                    : eng.editFile().getParentDirectory().getChildFile (orig);
    if (! of.existsAsFile()) return errResult ("reset_render_layer", "original source missing");

    const bool local = of.isAChildOf (eng.editFile().getParentDirectory());
    mosh::repointWaveClipSource (*wave, of, eng.editFile().getParentDirectory(), local);
    node.setProperty (ids::appliedInPlace, false, nullptr);
    node.setProperty (ids::status, "dirty", nullptr);   // re-imagine is available again
    // JSONL TASTE LABEL (05 §9): with in-place auto-apply, reset IS the workflow's
    // reject — carry the join keys (layerId/cacheKey/adapter) so the label pairs with
    // the render artifact in the taste census.
    {
        auto* tl = new DynamicObject();
        tl->setProperty ("clipId", clipId); tl->setProperty ("layerId", node[ids::id]);
        tl->setProperty ("cacheKey", node[ids::cacheKey]);
        tl->setProperty ("adapter", node[ids::modelAdapter]);
        logLine ("reset_render_layer", var (tl), true, {}, false);
    }
    emitSnapshotInvalidated();
    return okResult ("reset_render_layer");
}

// TASTE-002 — the render_kept sweep. The 06-30 in-place overhaul removed accept/reject
// from the wave loop, so the JSONL stopped accumulating organic taste labels. The
// cheapest honest positive is survival: a render that is STILL applied when the
// producer persists the project (save / export_audio) was implicitly kept. One label
// per layer (deduped on layerId in renderKeptLogged_); bypassed layers are skipped —
// at this moment the producer is A/B'd back to the original, so "kept" would overclaim.
void MoshOps::logKeptRenderLabels()
{
    for (auto* t : te::getAudioTracks (eng.edit()))
        for (auto* c : t->getClips())
        {
            if (c == nullptr) continue;
            auto rl = c->state.getChildWithName (ids::MOSH_RENDERLAYER);
            if (! rl.isValid() || ! (bool) rl[ids::appliedInPlace]) continue;
            if (rl[ids::status].toString() == "bypassed") continue;
            const auto layerId = rl[ids::id].toString();
            if (layerId.isEmpty() || renderKeptLogged_.contains (layerId)) continue;
            renderKeptLogged_.add (layerId);
            auto* tl = new DynamicObject();   // JSONL TASTE LABEL (05 §9): soft positive
            tl->setProperty ("clipId", c->itemID.toString());
            tl->setProperty ("layerId", layerId);
            tl->setProperty ("cacheKey", rl[ids::cacheKey]);
            tl->setProperty ("adapter", rl[ids::modelAdapter]);
            logLine ("render_kept", var (tl), true, {}, false);
        }
}

// ── Phase 3 — reactive auto-re-render ────────────────────────────────────────
void MoshOps::reactiveTouch (const juce::String& clipId)
{
    // Lane A — while this clip is Live-armed, render-ahead OWNS re-rendering: route a knob/edit touch
    // to a re-lay from the playhead forward (new params) instead of the debounced whole-clip fire.
    // Placed BEFORE the hasAudio guard so a hermetic run-script that armed Live still re-lays; in
    // --selftest renderAhead_ is never armed, so this is a no-op (hermetic preserved).
    if (renderAhead_.active && renderAhead_.clipId == clipId)
    { renderAheadParamChanged (clipId); return; }

    // Hermetic-harness guard: a reactive render SPAWNS the generative service, so in headless runs
    // (no audio device — --selftest / --run-script) it stays OFF unless a test explicitly opts in via
    // MOSH_REACTIVE_DEBOUNCE_MS. Keeps --selftest deterministic + service-free; the real GUI (hasAudio)
    // and the reactive verify check both arm it.
    static const bool explicitDebounce =
        juce::SystemStats::getEnvironmentVariable ("MOSH_REACTIVE_DEBOUNCE_MS", "").trim().isNotEmpty();
    if (! eng.hasAudio() && ! explicitDebounce) return;

    auto node = findRenderLayer (clipId);
    if (! node.isValid()) return;
    if (! (bool) node.getProperty (ids::reactive, true)) return;   // per-layer opt-out (default on)
    // Only when a render is actually LIVE: a wave clip's source IS the render (appliedInPlace), or a
    // MIDI/drum clip's hidden audio plays beneath it (kSourceMutedByLayer). A dormant layer (created
    // but never rendered, or reset) is left alone — editing it shouldn't conjure a render.
    if (! ((bool) node[ids::appliedInPlace] || (bool) node[kSourceMutedByLayer])) return;

    // Bump the epoch so any in-flight render for this clip is dropped on finalize (superseded), then
    // (re)start the debounce — a burst of edits collapses to ONE re-render after it settles.
    node.setProperty (ids::reactiveEpoch, (int) node[ids::reactiveEpoch] + 1, nullptr);
    const int ms = juce::jmax (1, juce::SystemStats::getEnvironmentVariable (
        "MOSH_REACTIVE_DEBOUNCE_MS", "500").getIntValue());
    auto& timer = reactiveTimers[clipId];
    if (timer == nullptr)
    {
        auto t = std::make_unique<LambdaTimer>();
        t->fn = [this, clipId] { reactiveFire (clipId); };
        timer = std::move (t);
    }
    timer->startTimer (ms);
}

void MoshOps::reactiveTouchTrack (const juce::String& trackId)
{
    // An instrument/FX edit changes a MIDI clip's bounce (the stableSourceSig folds the track's
    // plugins in) → re-touch every applied NON-wave clip on the track. Wave in-place renders stage
    // the clip's own audio (independent of track FX), so they're not affected.
    auto* track = findTrack (trackId);
    if (track == nullptr) return;
    for (auto* c : track->getClips())
        if (c != nullptr && dynamic_cast<te::WaveAudioClip*> (c) == nullptr)
            reactiveTouch (c->itemID.toString());
}

void MoshOps::reactiveFire (const juce::String& clipId)
{
    // The debounce elapsed — fire a background (wait:false) re-render. cmdRenderLayer re-stages the
    // CURRENT source (post-edit), so an identical source HITs the cache (instant) and a changed one
    // re-renders + hot-swaps. The result envelope is ignored (this is an internal regeneration).
    if (! findRenderLayer (clipId).isValid()) return;   // layer removed since the touch
    auto* o = new juce::DynamicObject();
    o->setProperty ("clipId", clipId);
    o->setProperty ("wait", false);
    cmdRenderLayer (juce::var (o));
}

// ── Lane A — render-ahead ("Live") ───────────────────────────────────────────────
juce::var MoshOps::buildRenderAheadParams (const juce::ValueTree& node) const
{
    // node → single-window render params (same shape as cmdRenderLayer's job params, minus the
    // whole-clip coverage: the scheduler stages one 8s slice per window and stitches them itself).
    auto params = node.getChildWithName (ids::PARAMS);
    auto* p = new juce::DynamicObject();
    p->setProperty ("prompt", params[ids::prompt]);
    p->setProperty ("seed", node[ids::seed]);          // stable across windows → consistent "voice"
    p->setProperty ("nl", params[ids::nl]);
    // cfg/steps intentionally NOT sent — engine-level sampler tuning (see cmdRenderLayer).
    p->setProperty ("mode", node[ids::mode]);          // reimagine (Live is wave-clip re-imagine)
    p->setProperty ("target", params[ids::target]);
    p->setProperty ("strength", params[ids::strength]);
    juce::Array<juce::var> colors;
    if (auto cs = params.getChildWithName (ids::COLORS); cs.isValid())
        for (int i = 0; i < cs.getNumChildren(); ++i)
        {
            auto* co = new juce::DynamicObject();
            co->setProperty ("name", cs.getChild (i)[ids::name]);
            co->setProperty ("value", cs.getChild (i)[ids::value]);
            colors.add (juce::var (co));
        }
    p->setProperty ("colors", colors);
    juce::Array<juce::var> loras;
    if (auto ls = params.getChildWithName (ids::LORAS); ls.isValid())
        for (int i = 0; i < ls.getNumChildren(); ++i)
        {
            auto* lo = new juce::DynamicObject();
            lo->setProperty ("name", ls.getChild (i)[ids::name]);
            lo->setProperty ("value", ls.getChild (i)[ids::value]);
            loras.add (juce::var (lo));
        }
    p->setProperty ("loras", loras);
    p->setProperty ("lab", (bool) params.getProperty (juce::Identifier ("lab"), false));
    p->setProperty ("coverage", "single");             // one 8s window — no tile/stitch inside a window
    return juce::var (p);
}

juce::var MoshOps::cmdRenderAheadArm (const juce::var& args)
{
    const auto clipId = args.getProperty ("clipId", var()).toString();
    const bool armed  = (bool) args.getProperty ("armed", true);
    auto* clip = findClip (clipId);
    auto node  = findRenderLayer (clipId);
    if (clip == nullptr || ! node.isValid()) return errResult ("render_ahead_arm", "no render layer");

    if (! armed)
    {
        renderAheadDisarm();
        logLine ("render_ahead_arm", args, true, {}, false);
        return okResult ("render_ahead_arm", [] { auto* o = new DynamicObject(); o->setProperty ("armed", false); return var (o); }());
    }

    // v1 is WAVE-clip only: the clip's own source is progressively repointed. (MIDI/drum keep the
    // existing whole-clip beneath-render path — a progressive beneath variant is a later increment.)
    auto* wave = dynamic_cast<te::WaveAudioClip*> (clip);
    if (wave == nullptr)
        return errResult ("render_ahead_arm", "live render-ahead is wave-clip only (v1)");

    // Bring the generative service up ONCE at arm time (submitJob/stitchWindows don't self-spawn).
    if (! jobManager.ensureServiceRunning())
        return errResult ("render_ahead_arm", "generative service unavailable");

    // If another clip was armed, disarm it first (one Live clip at a time — the MLX worker is serial).
    if (renderAhead_.active && renderAhead_.clipId != clipId)
        renderAheadDisarm();

    auto& ra = renderAhead_;
    ra.active   = true;
    ra.clipId   = clipId;
    ra.layerId  = node[ids::id].toString();
    ra.epoch   += 1;                                    // fresh generation
    ra.winLen   = juce::jmax (1.0, juce::SystemStats::getEnvironmentVariable ("SA3_SECONDS", "8.0").getDoubleValue());
    auto cpos   = clip->getPosition();
    ra.clipStart = cpos.getStart().inSeconds();
    ra.clipEnd   = cpos.getEnd().inSeconds();
    ra.srcOffset = cpos.getOffset().inSeconds();
    ra.lastPlayheadSec = ra.clipStart;

    // Pristine original (prefer originalSourceRef so we never compound a prior in-place render).
    juce::File src = wave->getCurrentSourceFile();
    if (const auto orig = node[ids::originalSourceRef].toString(); orig.isNotEmpty())
    {
        juce::File of = juce::File::isAbsolutePath (orig) ? juce::File (orig)
                        : eng.editFile().getParentDirectory().getChildFile (orig);
        if (of.existsAsFile()) src = of;
    }
    ra.sourceFile = src;
    ra.adapter    = node[ids::modelAdapter].toString();
    ra.jobParams  = buildRenderAheadParams (node);
    ra.jobDir     = eng.sessionDir().getChildFile ("renders").getChildFile (ra.layerId).getChildFile ("live");
    ra.jobDir.createDirectory();

    const double clipLen = juce::jmax (0.0, ra.clipEnd - ra.clipStart);
    ra.numWindows = juce::jmax (1, (int) std::ceil (clipLen / ra.winLen - 1.0e-6));
    ra.nextWindow = 0;
    ra.growSeq    = 0;
    ra.rendering  = false;
    ra.originalCaptured = false;
    ra.windows.assign ((size_t) ra.numWindows, juce::File());

    node.setProperty (ids::liveArmed, true, nullptr);
    emit ("layer_status", [&] { auto* o = new DynamicObject();
        o->setProperty ("clipId", clipId); o->setProperty ("layerId", ra.layerId);
        o->setProperty ("status", "live"); o->setProperty ("live", true); return var (o); }());

    // Pre-warm from the current transport position (arming mid-play shouldn't render windows behind
    // the playhead). Async in the GUI; a hermetic run-script drives the clock via render_ahead_tick.
    if (eng.hasAudio())
        renderAheadTick (eng.edit().getTransport().getPosition().inSeconds());

    logLine ("render_ahead_arm", args, true, {}, false);
    auto* d = new DynamicObject();
    d->setProperty ("armed", true);
    d->setProperty ("windows", ra.numWindows);
    d->setProperty ("windowSeconds", ra.winLen);
    return okResult ("render_ahead_arm", var (d));
}

void MoshOps::renderAheadDisarm()
{
    auto& ra = renderAhead_;
    if (! ra.active && ra.clipId.isEmpty()) return;
    ra.epoch += 1;                                      // drop any in-flight window completion
    ra.active = false;
    if (auto node = findRenderLayer (ra.clipId); node.isValid())
        node.setProperty (ids::liveArmed, false, nullptr);
    const auto clipId = ra.clipId;
    ra.clipId = {}; ra.layerId = {};
    ra.windows.clear();
    emit ("layer_status", [&] { auto* o = new DynamicObject();
        o->setProperty ("clipId", clipId); o->setProperty ("status", "ready");
        o->setProperty ("live", false); return var (o); }());
}

void MoshOps::renderAheadTick (double playheadSec)
{
    auto& ra = renderAhead_;
    if (! ra.active) return;
    ra.lastPlayheadSec = playheadSec;
    if (ra.rendering) return;                           // one window in flight (MLX serial)

    const int cw = juce::jlimit (0, ra.numWindows - 1,
                                 (int) std::floor ((playheadSec - ra.clipStart) / ra.winLen));
    const int target = juce::jmin (cw + ra.lookahead, ra.numWindows - 1);
    if (ra.nextWindow <= target && ra.nextWindow < ra.numWindows)
        renderAheadStartWindow (ra.nextWindow);
}

bool MoshOps::renderAheadSubmitWindow (int k, int epoch, juce::String& jobId,
                                       juce::File& outFile, juce::File& manifest)
{
    auto& ra = renderAhead_;
    const double srcStart = ra.srcOffset + (double) k * ra.winLen;
    const double srcEnd   = ra.srcOffset + juce::jmin ((double) (k + 1) * ra.winLen, ra.clipEnd - ra.clipStart);
    const juce::String stem = "win_" + juce::String (k) + "_e" + juce::String (epoch);
    auto inFile = ra.jobDir.getChildFile (stem + "_in.wav");
    outFile     = ra.jobDir.getChildFile (stem + "_out.wav");
    manifest    = ra.jobDir.getChildFile (stem + "_out.wav.manifest.json");
    if (! stageWavRegionAt44k (ra.sourceFile, srcStart, srcEnd, inFile))
        return false;
    jobId = jobManager.submitJob (ra.adapter, inFile, outFile, manifest, ra.jobParams);
    return jobId.isNotEmpty();
}

void MoshOps::renderAheadStartWindow (int k)
{
    auto& ra = renderAhead_;
    ra.rendering = true;
    const int capturedEpoch = ra.epoch;
    juce::String jobId; juce::File outFile, manifest;
    if (! renderAheadSubmitWindow (k, capturedEpoch, jobId, outFile, manifest))
    {
        ra.rendering = false;
        emit ("layer_status", [&] { auto* o = new DynamicObject();
            o->setProperty ("clipId", ra.clipId); o->setProperty ("status", "error");
            o->setProperty ("error", "render-ahead window submit failed"); return var (o); }());
        renderAheadDisarm();
        return;
    }

    // Ceiling for one window, 100ms ticks. Default unchanged (~180s); PC CUDA cold
    // loads (model load + first render) can opt into longer via the same knob the
    // render-layer wait honours (verify-pc-build.ps1 -RealSA3 sets 600000).
    const int waitMs = juce::jmax (1000, juce::SystemStats::getEnvironmentVariable (
        "MOSH_RENDER_WAIT_TIMEOUT_MS", "180000").getIntValue());
    const int maxPolls = juce::jmax (1, waitMs / 100);

    // Poll on a background thread (service I/O off the message thread); marshal the placement back.
    std::thread ([this, k, capturedEpoch, jobId, outFile, manifest, maxPolls]
    {
        for (int i = 0; i < maxPolls; ++i)
        {
            auto st = jobManager.jobStatus (jobId);
            const auto status = st.getProperty ("status", juce::var()).toString();
            if (status == "ready" || (outFile.existsAsFile() && manifest.existsAsFile())
                || status == "error" || status == "cancelled")
                break;
            juce::Thread::sleep (100);
        }
        juce::MessageManager::callAsync ([this, k, capturedEpoch, outFile]
        {
            auto& r = renderAhead_;
            r.rendering = false;
            if (! r.active || capturedEpoch != r.epoch) { if (r.active) renderAheadTick (r.lastPlayheadSec); return; }
            if (! outFile.existsAsFile())
            {
                emit ("layer_status", [&] { auto* o = new DynamicObject();
                    o->setProperty ("clipId", r.clipId); o->setProperty ("status", "error");
                    o->setProperty ("error", "render-ahead window failed"); return var (o); }());
                renderAheadDisarm();
                return;
            }
            // A window that rendered but failed to STITCH/repoint must surface, not
            // silently no-op (a /stitch_windows failure once made the whole Live lane
            // report success while never changing the audio). A false return with a
            // matching epoch == the stitch/repoint failed; superseded/disarmed is fine.
            if (! renderAheadWindowDone (k, capturedEpoch, outFile)
                && r.active && capturedEpoch == r.epoch)
            {
                emit ("layer_status", [&] { auto* o = new DynamicObject();
                    o->setProperty ("clipId", r.clipId); o->setProperty ("status", "error");
                    o->setProperty ("error", "render-ahead stitch failed"); return var (o); }());
                renderAheadDisarm();
                return;
            }
            if (r.active) renderAheadTick (r.lastPlayheadSec);   // chain the next window
        });
    }).detach();
}

bool MoshOps::renderAheadWindowDone (int k, int epoch, const juce::File& outFile)
{
    auto& ra = renderAhead_;
    if (! ra.active || epoch != ra.epoch) return false;   // disarmed / superseded by a re-lay
    if (! outFile.existsAsFile()) return false;

    if (k >= (int) ra.windows.size()) ra.windows.resize ((size_t) (k + 1));
    ra.windows[(size_t) k] = outFile;
    ra.nextWindow = juce::jmax (ra.nextWindow, k + 1);

    // Contiguous completed prefix [0..m]; stitch it into the growing render-ahead file.
    int m = -1;
    for (int i = 0; i < (int) ra.windows.size(); ++i)
    {
        if (ra.windows[(size_t) i] != juce::File() && ra.windows[(size_t) i].existsAsFile()) m = i;
        else break;
    }
    if (m < 0) return true;

    juce::StringArray paths;
    for (int i = 0; i <= m; ++i) paths.add (ra.windows[(size_t) i].getFullPathName());
    auto dest = ra.jobDir.getChildFile ("render_ahead_" + juce::String (ra.growSeq) + ".wav");
    const double covered = jobManager.stitchWindows (paths, dest, 0.0, 1.0);   // 1ms — owner-tuned
    if (covered <= 0.0 || ! dest.existsAsFile()) return false;

    if (auto* wave = dynamic_cast<te::WaveAudioClip*> (findClip (ra.clipId)))
    {
        auto node = findRenderLayer (ra.clipId);
        if (! ra.originalCaptured)
        {
            if (node.isValid() && node[ids::originalSourceRef].toString().isEmpty())
                node.setProperty (ids::originalSourceRef, wave->getCurrentSourceFile().getFullPathName(), nullptr);
            ra.originalCaptured = true;
        }
        const bool local = dest.isAChildOf (eng.editFile().getParentDirectory());
        mosh::repointWaveClipSource (*wave, dest, eng.editFile().getParentDirectory(), local);
        if (node.isValid())
        {
            node.setProperty (ids::appliedInPlace, true, nullptr);
            node.setProperty (ids::cacheArtifact, dest.getFullPathName(), nullptr);
            node.setProperty (ids::status, "ready", nullptr);
        }
    }
    ra.growSeq += 1;

    emit ("render_ahead", [&] { auto* o = new DynamicObject();
        o->setProperty ("clipId", ra.clipId);
        o->setProperty ("coveredSeconds", covered);
        o->setProperty ("windows", m + 1);
        o->setProperty ("total", ra.numWindows); return var (o); }());
    return true;
}

void MoshOps::renderAheadParamChanged (const juce::String& clipId)
{
    auto& ra = renderAhead_;
    if (! ra.active || ra.clipId != clipId) return;
    auto node = findRenderLayer (clipId);
    if (! node.isValid()) return;

    ra.epoch += 1;                                      // supersede any in-flight window
    ra.jobParams = buildRenderAheadParams (node);       // capture the new knob values

    // Keep windows BEHIND the playhead (already heard, old params fine); re-render from the current
    // window forward. The stitch crossfades old→new at that seam (1ms, at the playhead) — a smooth
    // timbral shift exactly where the producer turned the knob.
    const int cw = juce::jlimit (0, ra.numWindows - 1,
                                 (int) std::floor ((ra.lastPlayheadSec - ra.clipStart) / ra.winLen));
    for (int i = cw; i < (int) ra.windows.size(); ++i) ra.windows[(size_t) i] = juce::File();
    ra.nextWindow = cw;
    // Do NOT kick a render here: the GUI's 30Hz transport tick (or a run-script's explicit wait-tick)
    // picks up the reset nextWindow within ~33ms. Kicking the async path directly would wedge headless
    // (callAsync never fires without a pumped message loop) and could race an in-flight window.
}

juce::var MoshOps::cmdRenderAheadTick (const juce::var& args)
{
    // Explicit clock tick. The GUI drives renderAheadTick from the transport timer (async); this
    // command lets a HERMETIC run-script drive a simulated playhead. wait:true renders the due
    // windows INLINE (no message-loop dependence) so a headless harness sees deterministic coverage.
    auto& ra = renderAhead_;
    if (! ra.active) return errResult ("render_ahead_tick", "not armed");
    const double playhead = (double) args.getProperty ("playheadSec", ra.lastPlayheadSec);
    const bool wait = (bool) args.getProperty ("wait", false);
    ra.lastPlayheadSec = playhead;

    if (! wait) { renderAheadTick (playhead); return okResult ("render_ahead_tick"); }

    const int cw = juce::jlimit (0, ra.numWindows - 1,
                                 (int) std::floor ((playhead - ra.clipStart) / ra.winLen));
    const int target = juce::jmin (cw + ra.lookahead, ra.numWindows - 1);
    int placed = 0;
    while (ra.active && ra.nextWindow <= target && ra.nextWindow < ra.numWindows)
    {
        const int k = ra.nextWindow;
        juce::String jobId; juce::File outFile, manifest;
        if (! renderAheadSubmitWindow (k, ra.epoch, jobId, outFile, manifest))
        { renderAheadDisarm(); return errResult ("render_ahead_tick", "window submit failed"); }
        for (int i = 0; i < 4800; ++i)                  // ~240s inline ceiling
        {
            auto st = jobManager.jobStatus (jobId);
            const auto status = st.getProperty ("status", var()).toString();
            if (status == "ready" || (outFile.existsAsFile() && manifest.existsAsFile())
                || status == "error" || status == "cancelled")
                break;
            juce::Thread::sleep (50);
        }
        if (! outFile.existsAsFile())
        { renderAheadDisarm(); return errResult ("render_ahead_tick", "window render failed"); }
        // Fail CLOSED on a stitch/repoint failure (found live: a /stitch_windows 404
        // silently no-op'd the whole lane while `placed` still reported success).
        if (! renderAheadWindowDone (k, ra.epoch, outFile))
        { renderAheadDisarm(); return errResult ("render_ahead_tick", "window stitch failed"); }
        ++placed;
    }
    auto* d = new DynamicObject();
    d->setProperty ("placed", placed);
    d->setProperty ("nextWindow", ra.nextWindow);
    d->setProperty ("total", ra.numWindows);
    return okResult ("render_ahead_tick", var (d));
}

juce::var MoshOps::cmdListColors (const juce::var&)
{
    // The SA3 colour rack (name + ASTD ceiling per color) for the generative UI.
    if (! jobManager.ensureServiceRunning())
        return errResult ("list_colors", "generative service unavailable");
    auto r = jobManager.listColors();
    if (! (bool) r.getProperty ("ok", false))
        return okResult ("list_colors", [] { auto* o = new DynamicObject(); o->setProperty ("colors", Array<var>{}); return var (o); }());
    return okResult ("list_colors", r);
}

juce::var MoshOps::cmdListLoras (const juce::var&)
{
    // The LoRA rack library (drop-in adapters + cards) for the generative UI.
    if (! jobManager.ensureServiceRunning())
        return errResult ("list_loras", "generative service unavailable");
    auto r = jobManager.listLoras();
    if (! (bool) r.getProperty ("ok", false))
        return okResult ("list_loras", [] { auto* o = new DynamicObject(); o->setProperty ("loras", Array<var>{}); return var (o); }());
    return okResult ("list_loras", r);
}

juce::var MoshOps::cmdListTransformTargets (const juce::var&)
{
    // Route B: the transform target list (instruments / models) for the generative UI.
    if (! jobManager.ensureServiceRunning())
        return errResult ("list_transform_targets", "generative service unavailable");
    auto r = jobManager.listTransformTargets();
    if (! (bool) r.getProperty ("ok", false))
        return okResult ("list_transform_targets", [] { auto* o = new DynamicObject();
            o->setProperty ("targets", Array<var>{}); o->setProperty ("freeText", true); return var (o); }());
    return okResult ("list_transform_targets", r);
}

// Non-gated: the RAVE model library dir (RAVE_MODEL_DIR, else ~/AI/rave-models). Used by the
// anira insert (raveModelPathFor) AND the always-available model browser (cmdListRaveModels) —
// listing is a filesystem scan and needs no anira, so the browser works in the default build too.
static juce::File raveModelDirFile()
{
    const auto dir = juce::SystemStats::getEnvironmentVariable ("RAVE_MODEL_DIR",
                         juce::File::getSpecialLocation (juce::File::userHomeDirectory)
                             .getChildFile ("AI").getChildFile ("rave-models").getFullPathName());
    return juce::File (dir);
}

#if MOSH_HAVE_ANIRA
// ─────────────────────────────────────────────────────────────────────────────
// Route C.2 — real-time RAVE insert (Tier-A; only built with anira+LibTorch)
// ─────────────────────────────────────────────────────────────────────────────
static juce::String raveModelPathFor (const juce::String& target)
{
    if (target.isEmpty()) return {};
    return raveModelDirFile().getChildFile (target + ".ts").getFullPathName();
}

juce::var MoshOps::cmdAddRaveInsert (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("add_rave_insert", "no track");

    beginTxn ("add_rave_insert");
    auto plugin = eng.edit().getPluginCache().createNewPlugin (RaveInsertPlugin::xmlTypeName, {});
    if (plugin == nullptr) return errResult ("add_rave_insert", "create failed");
    int index = (int) args.getProperty ("index", -1);
    if (index < 0) index = track->pluginList.getPlugins().size();
    track->pluginList.insertPlugin (plugin, index, nullptr);

    juce::String path = args.getProperty ("path", var()).toString();
    if (path.isEmpty()) path = raveModelPathFor (args.getProperty ("target", var()).toString());
    bool loaded = false;
    juce::String loadError;   // AL-022 — surfaced below when the best-effort load fails
    if (path.isNotEmpty())
        if (auto* r = asRave (plugin.get()))
        {
            loaded = r->loadModelFromFile (juce::File (path));
            if (! loaded) loadError = r->lastLoadError();
        }

    auto* data = new DynamicObject();
    data->setProperty ("index", track->pluginList.indexOf (plugin.get()));
    data->setProperty ("modelLoaded", loaded);
    if (! loaded && loadError.isNotEmpty()) data->setProperty ("lastError", loadError);
    logLine ("add_rave_insert", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("add_rave_insert", var (data));
}

juce::var MoshOps::cmdSetRaveParam (const juce::var& args)
{
    auto* r = asRave (findPlugin (args.getProperty ("trackId", var()).toString(),
                                  (int) args.getProperty ("index", -1)));
    if (r == nullptr) return errResult ("set_rave_param", "no rave insert");
    beginTxn ("set_rave_param");
    if (args.getProperty ("paramId", "mix").toString() == "mix")
        r->setMixUi ((float) (double) args.getProperty ("value", 100.0));   // 0–100 dry/wet
    logLine ("set_rave_param", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_rave_param");
}

juce::var MoshOps::cmdLoadRaveModel (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    const int idx = args.hasProperty ("pluginIndex") ? (int) args.getProperty ("pluginIndex", -1)
                                                     : (int) args.getProperty ("index", -1);
    auto* r = asRave (findPlugin (trackId, idx));
    if (r == nullptr) return errResult ("load_rave_model", "no rave insert");
    juce::String path = args.getProperty ("path", var()).toString();
    if (path.isEmpty()) path = raveModelPathFor (args.getProperty ("target", var()).toString());
    if (path.isEmpty()) return errResult ("load_rave_model", "path or target required");
    if (! juce::File (path).existsAsFile()) return errResult ("load_rave_model", "model file not found: " + path);
    const bool ok = r->loadModelFromFile (juce::File (path));
    logLine ("load_rave_model", args, ok, ok ? juce::String() : juce::String ("load failed"), false);
    emitSnapshotInvalidated();
    if (! ok)
    {
        // AL-022 — append the engine's diagnostic (exception message / failure
        // reason) to the error, when one was captured. Additive: the base
        // message is unchanged when there is no diagnostic to add.
        const auto detail = r->lastLoadError();
        return errResult ("load_rave_model", "could not load model: " + path
            + (detail.isNotEmpty() ? (" (" + detail + ")") : juce::String()));
    }
    auto* data = new DynamicObject();
    data->setProperty ("applied", true);
    data->setProperty ("describe", r->describe());
    return okResult ("load_rave_model", var (data));
}

juce::var MoshOps::cmdResetRave (const juce::var& args)
{
    auto* r = asRave (findPlugin (args.getProperty ("trackId", var()).toString(),
                                  (int) args.getProperty ("index", -1)));
    if (r == nullptr) return errResult ("reset_rave", "no rave insert");
    r->resetModel();
    logLine ("reset_rave", args, true, {}, false);
    return okResult ("reset_rave");
}
#endif // MOSH_HAVE_ANIRA

juce::var MoshOps::cmdListRaveModels (const juce::var&)
{
    // Lane B — browse the RAVE model library (RAVE_MODEL_DIR / ~/AI/rave-models). A pure filesystem
    // scan of *.ts, so it works in the DEFAULT build too (loading is still gated on
    // session.raveAvailable — only the anira build hosts the live insert). Mirrors the LoRA rack:
    // the UI card offers a dropdown instead of a raw path prompt. Sorted by name (std::map) for a
    // stable list; non-mutating, non-undoable.
    std::map<juce::String, int> found;   // name → sizeMB (auto-sorted by key)
    auto dir = raveModelDirFile();
    const bool available = dir.isDirectory();
    if (available)
        for (auto& f : dir.findChildFiles (juce::File::findFiles, false, "*.ts"))
            found[f.getFileNameWithoutExtension()] = juce::roundToInt (f.getSize() / (1024.0 * 1024.0));

    Array<var> models;
    for (auto& [name, sizeMB] : found)
    {
        auto* o = new DynamicObject();
        o->setProperty ("name", name);
        o->setProperty ("sizeMB", sizeMB);
        models.add (var (o));
    }
    auto* d = new DynamicObject();
    d->setProperty ("models", models);
    d->setProperty ("dir", dir.getFullPathName());
    d->setProperty ("available", available);
    return okResult ("list_rave_models", var (d));
}

juce::var MoshOps::cmdCancelRender (const juce::var& args)
{
    jobManager.cancelJob (args.getProperty ("jobId", var()).toString());
    if (auto node = findRenderLayer (args.getProperty ("clipId", var()).toString()); node.isValid())
        node.setProperty (ids::status, "dirty", nullptr);
    logLine ("cancel_render", args, true, {}, false);
    emitSnapshotInvalidated();
    return okResult ("cancel_render");
}

juce::var MoshOps::cmdAcceptRender (const juce::var& args)
{
    eng.saveIfDirty();   // A2 — pre-risky-op save (commits a generative render into the arrangement)
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (clipId);
    auto node = findRenderLayer (clipId);
    if (clip == nullptr || ! node.isValid()) return errResult ("accept_render", "no render layer");
    if (dynamic_cast<te::WaveAudioClip*> (clip) != nullptr && (bool) node[ids::appliedInPlace])
    {
        // Whole-clip wave renders AUTO-APPLY in place (no lane, no accept step). accept is a
        // no-op for them — Reset restores the original. (Sub-region wave renders are NOT
        // applied in place and still land via the lane path below.)
        logLine ("accept_render", args, true, {}, false);
        return okResult ("accept_render");
    }
    if (dynamic_cast<te::WaveAudioClip*> (clip) == nullptr && (bool) node[kSourceMutedByLayer])
    {
        // Phase 2 — MIDI/drum auto-applies beneath the muted source. accept is a no-op (the hidden
        // audio is already what plays); Reset un-mutes the MIDI and removes the hidden clip.
        logLine ("accept_render", args, true, {}, false);
        return okResult ("accept_render");
    }
    // Resolve move-aware (AL-009): a Save-As'd project stores cacheArtifact relative.
    juce::File artifact = mosh::resolveCacheArtifact (node, eng.editFile().getParentDirectory());
    if (! artifact.existsAsFile()) return errResult ("accept_render", "nothing rendered to accept");

    // Copy the render artifact into the project audio dir BEFORE any edit mutation.
    // copyFileTo does not create parent dirs and can fail (disk full, perms); doing
    // it up front and checking the result means a failed copy is a clean error
    // rather than a clip pointing at a missing/partial file landing in the saved
    // project. (createAudioTrack below is an undoable mutation, so we must not reach
    // it on a copy failure.)
    auto dest = eng.sessionDir().getChildFile ("audio")
                    .getChildFile (node[ids::id].toString()).withFileExtension ("wav");
    dest.getParentDirectory().createDirectory();
    dest.deleteFile();
    if (! artifact.copyFileTo (dest))
        return errResult ("accept_render", "failed to copy render artifact");

    // Landing: new clip on a dedicated "neural" lane (the documented guaranteed
    // fallback, 05 §3.1 — ships as a user-selectable mode, not a defeat).
    beginTxn ("accept_render");
    auto& edit = eng.edit();
    te::AudioTrack* lane = nullptr;
    for (auto* t : te::getAudioTracks (edit))
        if (t != nullptr && t->getName() == "Neural Renders") lane = t;
    if (lane == nullptr)
    {
        lane = createAudioTrack ("Neural Renders");
    }
    if (lane == nullptr) return errResult ("accept_render", "no lane");
    ensureTrackMeter (*lane);   // METER-001 — a normal, snapshot-visible track like any other

    // Land the render. Anchor to the clip's LIVE position; only when the layer carries a
    // genuine sub-region (tighter than the current clip span) do we land that sub-range.
    // The stored timeRange is frozen at create, so clamp it to the live clip — a clip
    // moved/trimmed since render lands over its current self, not a stale spot.
    auto pos = clip->getPosition();
    const double cs = pos.getStart().inSeconds(), ce = pos.getEnd().inSeconds();
    auto landStart = pos.getStart();
    auto landLen   = pos.getLength();
    {
        const double rs = juce::jlimit (cs, ce, (double) node[ids::timeRangeStart]);
        const double re = juce::jlimit (cs, ce, (double) node[ids::timeRangeEnd]);
        if (re > rs + 1.0e-3 && (re - rs) < (ce - cs) - 1.0e-3)   // genuine sub-region of the live clip
        {
            landStart = tracktion::TimePosition::fromSeconds (rs);
            landLen   = tracktion::TimeDuration::fromSeconds (re - rs);
        }
    }
    auto landed = lane->insertWaveClip ("neural-" + clip->getName(), dest,
        { { landStart, landLen }, {} }, false);

    node.setProperty (ids::userKept, true, &undoManager());
    node.setProperty (ids::status, "ready", &undoManager());
    // Record the landed neural clip so bypass_layer can re-route real audio (AL-008):
    // bypassing mutes THIS clip → the mix falls back to the original (pre-render) source.
    // A re-accept after bypass must start un-bypassed, so the new landed clip plays.
    if (landed != nullptr)
        node.setProperty (kLandedClipId, landed->itemID.toString(), &undoManager());

    // JSONL TASTE LABEL (05 §9): accept feeds the taste flywheel.
    auto* tl = new DynamicObject();
    tl->setProperty ("clipId", clipId); tl->setProperty ("layerId", node[ids::id]);
    tl->setProperty ("landing", "new_clip");
    logLine ("accept_render", var (tl), true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("accept_render");
}

juce::var MoshOps::cmdRejectRender (const juce::var& args)
{
    auto node = findRenderLayer (args.getProperty ("clipId", var()).toString());
    if (! node.isValid()) return errResult ("reject_render", "no render layer");
    beginTxn ("reject_render");
    node.setProperty (ids::userKept, false, &undoManager());
    node.setProperty (ids::status, "dirty", &undoManager());
    logLine ("reject_render", args, true, {}, true);   // TASTE LABEL (reject)
    emitSnapshotInvalidated();
    return okResult ("reject_render");
}

juce::var MoshOps::cmdBypassLayer (const juce::var& args)
{
    auto node = findRenderLayer (args.getProperty ("clipId", var()).toString());
    if (! node.isValid()) return errResult ("bypass_layer", "no render layer");
    const bool bypassed = (bool) args.getProperty ("bypassed", false);
    const auto bypClipId = args.getProperty ("clipId", var()).toString();
    beginTxn ("bypass_layer");
    node.setProperty (ids::status, bypassed ? "bypassed" : "ready", &undoManager());

    // Wave clips apply in place → bypass is an A/B: swap the source to the ORIGINAL when
    // bypassed, back to the render artifact when enabled. (Non-wave clips use the landed-clip
    // mute below.) The swap is the same regenerable-preview op as apply/reset.
    if (auto* wave = dynamic_cast<te::WaveAudioClip*> (findClip (bypClipId)))
    {
        if (const auto origRef = node[ids::originalSourceRef].toString(); origRef.isNotEmpty())
        {
            const auto art = mosh::resolveCacheArtifact (node, eng.editFile().getParentDirectory()).getFullPathName();
            const juce::String origAbs = juce::File::isAbsolutePath (origRef) ? origRef
                : eng.editFile().getParentDirectory().getChildFile (origRef).getFullPathName();
            const juce::String tgt = bypassed ? origAbs : art;
            if (juce::File tf (tgt); tf.existsAsFile())
            {
                const bool local = tf.isAChildOf (eng.editFile().getParentDirectory());
                mosh::repointWaveClipSource (*wave, tf, eng.editFile().getParentDirectory(), local);
            }
        }
    }

    // Phase 2 — for the MIDI/drum beneath-model, bypass routes back to the LIVE instrument: un-mute
    // the source MIDI when bypassed, re-mute it when enabled. (The landed-clip mute below mutes the
    // hidden audio inversely, so exactly one of the two sounds at a time.)
    if ((bool) node[kSourceMutedByLayer])
        if (auto* src = findClip (bypClipId))
            src->setMuted (! bypassed);

    // AL-008 — re-route REAL audio, not just the status flag: mute the landed neural / hidden
    // clip when bypassed so the mix falls back to the original (pre-render) source, and
    // un-mute it when re-enabled. Only meaningful once the layer was accepted / auto-applied (it
    // has a landed clip); a bypass before that is a pure status toggle (nothing to route).
    if (auto landedId = node[kLandedClipId].toString(); landedId.isNotEmpty())
        if (auto* landedClip = findClip (landedId))
            landedClip->setMuted (bypassed);

    logLine ("bypass_layer", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("bypass_layer");
}

juce::var MoshOps::cmdFreezeLayer (const juce::var& args)
{
    eng.saveIfDirty();   // A2 — pre-risky-op save (commits the cached render as durable audio)
    // Freeze = commit the cached render as the durable audio (already a file).
    auto node = findRenderLayer (args.getProperty ("clipId", var()).toString());
    if (! node.isValid()) return errResult ("freeze_layer", "no render layer");
    // Resolve move-aware (AL-009): a Save-As'd project stores cacheArtifact relative.
    if (! mosh::resolveCacheArtifact (node, eng.editFile().getParentDirectory()).existsAsFile())
        return errResult ("freeze_layer", "nothing rendered to freeze");
    beginTxn ("freeze_layer");
    node.setProperty (ids::status, "frozen", &undoManager());
    // The part that makes the name true. `status` is a LABEL nothing gates on; the reactive
    // auto-re-render loop gates on ids::reactive (reactiveTouch, below) — which Ids.h has
    // declared as the per-layer opt-out since Phase 3 while NO command ever wrote it. Without
    // this line a "frozen" layer still re-rendered on the next edit, spending exactly the
    // service time the freeze promises to save. cmdUnfreezeLayer is the way back.
    node.setProperty (ids::reactive, false, &undoManager());
    logLine ("freeze_layer", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("freeze_layer");
}

juce::var MoshOps::cmdUnfreezeLayer (const juce::var& args)
{
    // Thaw — re-arm the reactive loop a freeze switched off. Freeze had no way back at all
    // before this: no command moved status off "frozen", and nothing could set ids::reactive.
    auto node = findRenderLayer (args.getProperty ("clipId", var()).toString());
    if (! node.isValid()) return errResult ("unfreeze_layer", "no render layer");
    if ((bool) node.getProperty (ids::reactive, true))
        return errResult ("unfreeze_layer", "layer is not frozen");

    beginTxn ("unfreeze_layer");
    node.setProperty (ids::reactive, true, &undoManager());
    // "dirty", never "ready": edits made WHILE frozen deliberately did not fire a re-render, so
    // the artifact may no longer match its source and nothing here can tell. "dirty" is this
    // codebase's existing word for "re-imagine is available again" (cf. reset_render_layer) —
    // it is the honest answer, where "ready" would claim a freshness we cannot verify.
    node.setProperty (ids::status, "dirty", &undoManager());
    logLine ("unfreeze_layer", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("unfreeze_layer");
}

juce::var MoshOps::cmdBounceLayerToClip (const juce::var& args)
{
    eng.saveIfDirty();   // A2 — pre-risky-op save (bounce commits the render to a clip)
    // Bounce = accept_render then mark the layer bounced (the render becomes a
    // plain clip on the neural lane; lineage stays in the RenderLayer link).
    // The relabel is undo-tracked, like cmdFreezeLayer's — it must not outlive the accept it
    // describes. Opening the transaction HERE (not around the setProperty) keeps one command =
    // one undo step on both shapes: on the landing path cmdAcceptRender immediately re-names
    // this same still-empty transaction, so the landed clip and the label undo together; on the
    // no-op relabel paths (whole-clip wave / MIDI-beneath, where accept returns early without
    // opening one) the label gets its own step instead of being appended to whatever command
    // ran before it — which undo would then destroy along with the label.
    beginTxn ("bounce_layer_to_clip");
    auto r = cmdAcceptRender (args);
    if (! (bool) r.getProperty ("ok", false)) return r;
    if (auto node = findRenderLayer (args.getProperty ("clipId", var()).toString()); node.isValid())
        node.setProperty (ids::status, "bounced", &undoManager());
    logLine ("bounce_layer_to_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("bounce_layer_to_clip");
}

juce::var MoshOps::cmdRemoveRenderLayer (const juce::var& args)
{
    // Clear the MOSH_RENDERLAYER node off the clip (the genuine "remove" — reject_render
    // only marks the take dirty, it does NOT remove the layer). After this the clip has
    // no layer and create_render_layer succeeds again. Undoable (mirrors remove_plugin);
    // any accepted/bounced clip already landed on the neural lane is left untouched.
    const auto clipId = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (clipId);
    if (clip == nullptr) return errResult ("remove_render_layer", "no clip: " + clipId);
    auto node = clip->state.getChildWithName (ids::MOSH_RENDERLAYER);
    if (! node.isValid()) return errResult ("remove_render_layer", "clip has no render layer");

    beginTxn ("remove_render_layer");
    // Phase 2 — a MIDI/drum beneath-render owns a HIDDEN audio clip + a MUTED source. Tear them down
    // so removing the layer doesn't strand a hidden clip or leave the MIDI silently muted.
    if ((bool) node[kSourceMutedByLayer])
    {
        if (auto hiddenId = node[kLandedClipId].toString(); hiddenId.isNotEmpty())
            if (auto* hidden = findClip (hiddenId); hidden != nullptr && hidden != clip)
                hidden->removeFromParent();
        clip->setMuted (false);
    }
    clip->state.removeChild (node, &undoManager());
    logLine ("remove_render_layer", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_render_layer");
}

} // namespace mosh
