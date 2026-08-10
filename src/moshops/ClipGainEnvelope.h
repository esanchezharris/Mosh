#pragma once

#include <tracktion_engine/tracktion_engine.h>
#include <cmath>
#include "ClipGainCurveWrite.h"
#include "state/Ids.h"

namespace mosh
{
namespace te = tracktion::engine;

inline te::VolumeAndPanPlugin* findClipGainEnvelopePlugin (te::AudioClipBase& clip)
{
    auto* plugins = clip.getPluginList();
    if (plugins == nullptr) return nullptr;
    for (auto* plugin : *plugins)
        if ((bool) plugin->state.getProperty (ids::moshClipGainEnvelope, false))
            return dynamic_cast<te::VolumeAndPanPlugin*> (plugin);
    return nullptr;
}

inline te::AutomationCurveModifier::Ptr findClipGainEnvelopeModifier (
    te::AudioClipBase& clip,
    te::VolumeAndPanPlugin& plugin)
{
    auto* list = clip.getAutomationCurveList (false);
    if (list == nullptr) return {};
    for (auto modifier : list->getItems())
        if (modifier != nullptr && te::getParameter (*modifier).get() == plugin.volParam.get())
            return modifier;
    return {};
}

inline juce::var clipGainEnvelopeToVar (te::AudioClipBase& clip)
{
    auto* plugin = findClipGainEnvelopePlugin (clip);
    if (plugin == nullptr) return {};
    auto modifier = findClipGainEnvelopeModifier (clip, *plugin);
    if (modifier == nullptr) return {};
    auto& curve = modifier->getCurve (te::CurveModifierType::absolute).curve;
    if (curve.getNumPoints() == 0) return {};

    const auto clipStart = clip.getPosition().getStart();
    juce::Array<juce::var> points;
    for (int index = 0; index < curve.getNumPoints(); ++index)
    {
        const auto beat = te::toBeats (curve.getPointPosition (index), clip.edit.tempoSequence);
        const double t = (clip.getTimeOfContentBeat (beat) - clipStart).inSeconds();
        const float gainDb = juce::jlimit (-48.0f, 6.0f,
            te::volumeFaderPositionToDB (curve.getPointValue (index)));
        auto* point = new juce::DynamicObject();
        point->setProperty ("t", t);
        point->setProperty ("gainDb", gainDb);
        const float curveAmount = curve.getPointCurve (index);
        if (std::abs (curveAmount) > 0.000001f)
            point->setProperty ("curve", curveAmount);
        points.add (juce::var (point));
    }
    return juce::var (points);
}

/** Replaces the hidden clip-local processor and its absolute gain curve inside
    the caller's transaction. Returns an error string without committing a
    partial fallback; the caller owns transaction rollback on failure. */
inline juce::String replaceClipGainEnvelope (
    te::AudioClipBase& clip,
    const std::vector<ClipGainCurvePointIn>& points,
    juce::UndoManager& undoManager)
{
    auto* plugin = findClipGainEnvelopePlugin (clip);
    if (points.empty())
    {
        if (plugin == nullptr) return {};
        if (auto modifier = findClipGainEnvelopeModifier (clip, *plugin))
            modifier->remove();
        plugin->deleteFromParent();
        return {};
    }

    if (plugin == nullptr)
    {
        auto state = te::VolumeAndPanPlugin::create();
        state.setProperty (ids::moshClipGainEnvelope, true, nullptr);
        auto inserted = clip.getPluginList()->insertPlugin (state, 0);
        plugin = dynamic_cast<te::VolumeAndPanPlugin*> (inserted.get());
        if (plugin == nullptr) return "could not create clip gain processor";
    }

    auto modifier = findClipGainEnvelopeModifier (clip, *plugin);
    if (modifier == nullptr)
        if (auto* list = clip.getAutomationCurveList (true))
            modifier = list->addCurve (*plugin->volParam);
    if (modifier == nullptr) return "could not create clip gain curve";

    auto& curve = modifier->getCurve (te::CurveModifierType::absolute).curve;
    curve.clear (&undoManager);
    const auto clipStart = clip.getPosition().getStart();
    for (const auto& point : points)
    {
        const auto editTime = clipStart + tracktion::TimeDuration::fromSeconds (point.t);
        const auto contentBeat = clip.getContentBeatAtTime (editTime);
        curve.addPoint (contentBeat, te::decibelsToVolumeFaderPosition (point.gainDb),
                        point.curve, &undoManager);
    }
    return {};
}

} // namespace mosh
