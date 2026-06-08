#include "EngineHandlers.h"
#include "EngineSnapshot.h"
#include "Ids.h"
#include <juce_audio_basics/juce_audio_basics.h>     // juce::Decibels
#include <juce_audio_formats/juce_audio_formats.h>   // juce::WavAudioFormat (tone fallback)
#include <cmath>

namespace mosh
{
    namespace te = tracktion;

    // ── lookup helpers (ids are "track:<rawId>" / "clip:<rawId>") ─────────────
    static te::AudioTrack* findAudioTrack (te::Edit& edit, const juce::String& ref)
    {
        juce::String type, id;
        if (! ids::parseRef (ref, type, id))
            id = ref;
        for (auto* t : te::getAudioTracks (edit))
            if (t->itemID.toString() == id)
                return t;
        return nullptr;
    }

    static te::Clip* findClip (te::Edit& edit, const juce::String& ref, te::AudioTrack** ownerOut = nullptr)
    {
        juce::String type, id;
        if (! ids::parseRef (ref, type, id))
            id = ref;
        for (auto* t : te::getAudioTracks (edit))
            for (auto* c : t->getClips())
                if (c->itemID.toString() == id)
                {
                    if (ownerOut != nullptr) *ownerOut = t;
                    return c;
                }
        return nullptr;
    }

    static MoshResult okChanged (const juce::String& msg, const juce::String& ref, juce::var data = juce::var())
    {
        juce::StringArray changed; changed.add (ref);
        return MoshResult::success (msg, changed, data);
    }

    // Generate a real WAV tone file of `lengthSec` seconds. Used as the import_clip
    // fallback when the UI's click-to-add affordance supplies no source file: a real
    // import passes {path} from a file picker, but for arranging we want an actual
    // audio clip (real samples → real peaks, plays on a device) rather than a stub.
    static juce::File generateToneFile (const juce::File& dir, double lengthSec)
    {
        static int counter = 0;
        const int n = ++counter;

        auto clipsDir = dir.getChildFile ("mosh-clips");
        clipsDir.createDirectory();
        auto file = clipsDir.getChildFile ("tone_" + juce::String (n) + ".wav");

        const double sampleRate = 44100.0;
        const double freqHz = 110.0 * std::pow (2.0, (double) ((n - 1) % 12) / 12.0); // walk the scale
        const int numSamples = juce::jmax (1, (int) (juce::jmax (0.1, lengthSec) * sampleRate));

        juce::AudioBuffer<float> buffer (1, numSamples);
        auto* d = buffer.getWritePointer (0);
        for (int i = 0; i < numSamples; ++i)
        {
            const double t = (double) i / sampleRate;
            const double env = 0.6 * std::exp (-1.5 * std::fmod (t, 1.0));   // per-beat decay
            d[i] = (float) (env * std::sin (2.0 * juce::MathConstants<double>::pi * freqHz * t));
        }

        file.deleteFile();
        juce::WavAudioFormat wav;
        if (auto os = std::unique_ptr<juce::FileOutputStream> (file.createOutputStream()))
        {
            if (auto* writer = wav.createWriterFor (os.get(), sampleRate, 1, 16, {}, 0))
            {
                os.release();                 // writer owns the stream now
                std::unique_ptr<juce::AudioFormatWriter> w (writer);
                w->writeFromAudioSampleBuffer (buffer, 0, numSamples);
            }
        }
        return file;
    }

    void registerEngineHandlers (DslExecutor& exec, MoshEngine& eng)
    {
        // create_track {name?}
        exec.registerCommand ("create_track", [&eng] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto& edit = eng.getEdit();
            auto track = edit.insertNewAudioTrack (te::TrackInsertPoint::getEndOfTracks (edit), nullptr);
            if (track == nullptr)
                return MoshResult::failure (error::internalError, "insertNewAudioTrack failed");
            if (const auto name = cmd.argString ("name"); name.isNotEmpty())
                track->setName (name);

            const auto ref = ids::trackRef (track->itemID.toString());
            ctx.emit (events::trackAdded (trackToVar (track.get())));
            auto* data = new juce::DynamicObject(); data->setProperty ("id", ref);
            return okChanged ("Created track", ref, juce::var (data));
        });

        // import_clip {track, path, start?}
        exec.registerCommand ("import_clip", [&eng] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto& edit = eng.getEdit();
            auto* track = findAudioTrack (edit, cmd.argString ("track"));
            if (track == nullptr)
                return MoshResult::failure (error::noSuchTrack, "No such track: " + cmd.argString ("track"));

            const auto path = cmd.argString ("path");
            juce::File file (path);
            if (path.isEmpty() || ! file.existsAsFile())
            {
                // No source file (the UI's click-to-add affordance / headless arrange):
                // synthesize a real tone clip so arranging is exercisable end-to-end.
                file = generateToneFile (eng.getEditFile().getParentDirectory(),
                                         cmd.argDouble ("length", 4.0));
                if (! file.existsAsFile())
                    return MoshResult::failure (error::internalError, "could not generate clip audio");
            }

            te::AudioFile af (edit.engine, file);
            const double len = af.getLength();
            if (len <= 0.0)
                return MoshResult::failure (error::invalidArgs, "could not read audio: " + path);

            const auto start = cmd.argDouble ("start", 0.0);
            const te::ClipPosition pos { { te::TimePosition::fromSeconds (start),
                                           te::TimeDuration::fromSeconds (len) }, {} };
            auto clip = track->insertWaveClip (file.getFileNameWithoutExtension(), file, pos, false);
            if (clip == nullptr)
                return MoshResult::failure (error::internalError, "insertWaveClip failed");

            const auto ref = ids::clipRef (clip->itemID.toString());
            ctx.emit (events::clipAdded (ids::trackRef (track->itemID.toString()), clipToVar (clip.get())));
            auto* data = new juce::DynamicObject(); data->setProperty ("id", ref);
            return okChanged ("Imported clip", ref, juce::var (data));
        });

        // set_transport {playing?, position?, loopStart?, loopEnd?, looping?, record?}
        exec.registerCommand ("set_transport", [&eng] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto& tc = eng.getTransport();
            if (cmd.hasArg ("position"))
                tc.setPosition (te::TimePosition::fromSeconds (cmd.argDouble ("position")));
            if (cmd.hasArg ("loopStart") && cmd.hasArg ("loopEnd"))
                tc.setLoopRange ({ te::TimePosition::fromSeconds (cmd.argDouble ("loopStart")),
                                   te::TimePosition::fromSeconds (cmd.argDouble ("loopEnd")) });
            if (cmd.hasArg ("looping"))
                tc.looping = cmd.argBool ("looping");
            if (cmd.hasArg ("playing"))
            {
                if (cmd.argBool ("playing")) tc.play (false);
                else                         tc.stop (false, false);
            }
            if (cmd.argBool ("record", false))
                tc.record (false);

            ctx.emit (events::transportPosition (tc.getPosition().inSeconds()));
            return MoshResult::success ("Transport updated");
        });

        // set_tempo {bpm}
        exec.registerCommand ("set_tempo", [&eng] (const MoshCommand& cmd, DslExecutor::Context&) -> MoshResult
        {
            const double bpm = cmd.argDouble ("bpm", 0.0);
            if (bpm <= 0.0)
                return MoshResult::failure (error::invalidArgs, "bpm must be > 0");
            if (auto* tempo = eng.getEdit().tempoSequence.getTempo (0))
                tempo->setBpm (bpm);
            return MoshResult::success ("Tempo set");
        });

        // rename_track {track, name}
        exec.registerCommand ("rename_track", [&eng] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto* track = findAudioTrack (eng.getEdit(), cmd.argString ("track"));
            if (track == nullptr)
                return MoshResult::failure (error::noSuchTrack, "No such track");
            track->setName (cmd.argString ("name"));
            const auto ref = ids::trackRef (track->itemID.toString());
            auto* fields = new juce::DynamicObject(); fields->setProperty ("name", track->getName());
            ctx.emit (events::trackChanged (ref, juce::var (fields)));
            return okChanged ("Renamed track", ref);
        });

        // set_track_gain {track, gain}  (linear, clamped 0..4)
        exec.registerCommand ("set_track_gain", [&eng] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto* track = findAudioTrack (eng.getEdit(), cmd.argString ("track"));
            if (track == nullptr)
                return MoshResult::failure (error::noSuchTrack, "No such track");
            auto* vp = track->getVolumePlugin();
            if (vp == nullptr)
                return MoshResult::failure (error::internalError, "track has no volume plugin");
            const double gain = juce::jlimit (0.0, 4.0, cmd.argDouble ("gain", 1.0));
            vp->setVolumeDb ((float) juce::Decibels::gainToDecibels (gain));
            const auto ref = ids::trackRef (track->itemID.toString());
            auto* fields = new juce::DynamicObject(); fields->setProperty ("gain", gain);
            ctx.emit (events::trackChanged (ref, juce::var (fields)));
            return okChanged ("Set gain", ref);
        });

        // set_track_mute {track, mute}
        exec.registerCommand ("set_track_mute", [&eng] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto* track = findAudioTrack (eng.getEdit(), cmd.argString ("track"));
            if (track == nullptr)
                return MoshResult::failure (error::noSuchTrack, "No such track");
            track->setMute (cmd.argBool ("mute", true));
            const auto ref = ids::trackRef (track->itemID.toString());
            auto* fields = new juce::DynamicObject(); fields->setProperty ("mute", track->isMuted (false));
            ctx.emit (events::trackChanged (ref, juce::var (fields)));
            return okChanged ("Set mute", ref);
        });

        // set_track_solo {track, solo}
        exec.registerCommand ("set_track_solo", [&eng] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto* track = findAudioTrack (eng.getEdit(), cmd.argString ("track"));
            if (track == nullptr)
                return MoshResult::failure (error::noSuchTrack, "No such track");
            track->setSolo (cmd.argBool ("solo", true));
            const auto ref = ids::trackRef (track->itemID.toString());
            auto* fields = new juce::DynamicObject(); fields->setProperty ("solo", track->isSolo (false));
            ctx.emit (events::trackChanged (ref, juce::var (fields)));
            return okChanged ("Set solo", ref);
        });

        // delete_track {track}
        exec.registerCommand ("delete_track", [&eng] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto& edit = eng.getEdit();
            auto* track = findAudioTrack (edit, cmd.argString ("track"));
            if (track == nullptr)
                return MoshResult::failure (error::noSuchTrack, "No such track");
            const auto ref = ids::trackRef (track->itemID.toString());
            edit.deleteTrack (track);
            ctx.emit (events::trackRemoved (ref));
            return okChanged ("Deleted track", ref);
        });

        // ── Stage 2 arrangement ops (clip geometry; mirrors ClipMath) ─────────
        // move_clip {clip, start}
        exec.registerCommand ("move_clip", [&eng] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto* clip = findClip (eng.getEdit(), cmd.argString ("clip"));
            if (clip == nullptr)
                return MoshResult::failure (error::noSuchClip, "No such clip");
            const double start = juce::jmax (0.0, cmd.argDouble ("start", 0.0));
            clip->setStart (te::TimePosition::fromSeconds (start), false, /*keepLength*/ true);
            const auto pos = clip->getPosition();
            const auto ref = ids::clipRef (clip->itemID.toString());
            ctx.emit (events::clipMoved (ref, pos.getStart().inSeconds(), pos.getEnd().inSeconds()));
            return okChanged ("Moved clip", ref);
        });

        // trim_clip {clip, start?, end?}
        exec.registerCommand ("trim_clip", [&eng] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto* clip = findClip (eng.getEdit(), cmd.argString ("clip"));
            if (clip == nullptr)
                return MoshResult::failure (error::noSuchClip, "No such clip");
            if (cmd.hasArg ("end"))
                clip->setEnd (te::TimePosition::fromSeconds (cmd.argDouble ("end")), /*preserveSync*/ true);
            if (cmd.hasArg ("start"))
                clip->setStart (te::TimePosition::fromSeconds (cmd.argDouble ("start")), true, /*keepLength*/ false);
            const auto pos = clip->getPosition();
            const auto ref = ids::clipRef (clip->itemID.toString());
            ctx.emit (events::clipMoved (ref, pos.getStart().inSeconds(), pos.getEnd().inSeconds()));
            return okChanged ("Trimmed clip", ref);
        });

        // split_clip {clip, at}
        exec.registerCommand ("split_clip", [&eng] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto& edit = eng.getEdit();
            te::AudioTrack* owner = nullptr;
            auto* clip = findClip (edit, cmd.argString ("clip"), &owner);
            if (clip == nullptr || owner == nullptr)
                return MoshResult::failure (error::noSuchClip, "No such clip");
            auto* newClip = owner->splitClip (*clip, te::TimePosition::fromSeconds (cmd.argDouble ("at", 0.0)));

            juce::Array<juce::var> clips;
            clips.add (clipToVar (clip));
            juce::StringArray changed; changed.add (ids::clipRef (clip->itemID.toString()));
            if (newClip != nullptr)
            {
                clips.add (clipToVar (newClip));
                changed.add (ids::clipRef (newClip->itemID.toString()));
            }
            ctx.emit (events::clipSplit (ids::trackRef (owner->itemID.toString()), clips));
            return MoshResult::success ("Split clip", changed);
        });
    }
}
