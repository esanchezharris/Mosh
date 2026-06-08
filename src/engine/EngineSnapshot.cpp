#include "EngineSnapshot.h"
#include "Ids.h"
#include <juce_audio_basics/juce_audio_basics.h>   // juce::Decibels

namespace mosh
{
    namespace te = tracktion;

    juce::var clipToVar (te::Clip* clip)
    {
        auto* o = new juce::DynamicObject();
        o->setProperty ("id", ids::clipRef (clip->itemID.toString()));
        const auto pos = clip->getPosition();
        juce::Array<juce::var> range { pos.getStart().inSeconds(), pos.getEnd().inSeconds() };
        o->setProperty ("range", range);
        // takeCount/activeTake surface at Stage 5 (generative auditioning).
        return juce::var (o);
    }

    juce::var trackToVar (te::AudioTrack* track)
    {
        auto* o = new juce::DynamicObject();
        o->setProperty ("id", ids::trackRef (track->itemID.toString()));
        o->setProperty ("name", track->getName());

        // gain: linear from the track's volume plugin (dB), default unity.
        double gain = 1.0;
        if (auto* vp = track->getVolumePlugin())
            gain = juce::Decibels::decibelsToGain (vp->getVolumeDb());
        o->setProperty ("gain", gain);

        o->setProperty ("mute", track->isMuted (false));   // VERIFY: Track::isMuted(bool)
        o->setProperty ("solo", track->isSolo (false));     // VERIFY: Track::isSolo(bool)

        juce::Array<juce::var> clips;
        for (auto* clip : track->getClips())
            clips.add (clipToVar (clip));
        o->setProperty ("clips", clips);

        o->setProperty ("plugins", juce::Array<juce::var>());        // Stage 3
        o->setProperty ("renderLayers", juce::Array<juce::var>());   // Stage 5
        return juce::var (o);
    }

    juce::var EngineSnapshotSource::getSnapshot()
    {
        auto& edit = eng.getEdit();
        auto* root = new juce::DynamicObject();

        juce::Array<juce::var> tracks;
        for (auto* track : te::getAudioTracks (edit))
            tracks.add (trackToVar (track));
        root->setProperty ("tracks", tracks);

        // transport
        auto& tc = edit.getTransport();
        auto* tr = new juce::DynamicObject();
        tr->setProperty ("position", tc.getPosition().inSeconds());
        tr->setProperty ("playing", tc.isPlaying());
        const auto loop = tc.getLoopRange();
        if (loop.getLength().inSeconds() > 0.0)
        {
            juce::Array<juce::var> loopArr { loop.getStart().inSeconds(), loop.getEnd().inSeconds() };
            tr->setProperty ("loop", loopArr);
        }
        else
        {
            tr->setProperty ("loop", juce::var());
        }
        root->setProperty ("transport", juce::var (tr));

        // tempo
        auto* tem = new juce::DynamicObject();
        tem->setProperty ("bpm", edit.tempoSequence.getBpmAt (te::TimePosition()));
        juce::String sig = "4/4";
        if (auto* ts = edit.tempoSequence.getTimeSig (0))
            sig = juce::String ((int) ts->numerator) + "/" + juce::String ((int) ts->denominator);
        tem->setProperty ("sig", sig);
        root->setProperty ("tempo", juce::var (tem));

        return juce::var (root);
    }
}
