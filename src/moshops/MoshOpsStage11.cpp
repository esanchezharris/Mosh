// Stage 11 — Monster v0 (phase0 §10): the agent_propose command. A QUERY, not
// a mutation: it asks the service's /agent/propose for validated MoshIR ops;
// executing them is a separate, user-visible execute_ir (createdBy rides in
// its args). The LLM key lives in the service's environment, never here.

#include "MoshOps.h"

namespace mosh
{
using namespace juce;

juce::var MoshOps::cmdAgentPropose (const juce::var& args)
{
    const auto instruction = args.getProperty ("instruction", var()).toString();
    if (instruction.isEmpty())
        return errResult ("agent_propose", "missing 'instruction'");

    if (! jobManager.ensureServiceRunning())
        return errResult ("agent_propose", "generative service unavailable");

    // Compact session summary — what a producer would glance at.
    String summary;
    {
        auto snap = snapshot();
        auto session = snap.getProperty ("session", var());
        summary << "tempo " << String ((double) session.getProperty ("tempo", 120.0), 1) << " bpm";
        if (auto key = session.getProperty ("keyRoot", var()).toString(); key.isNotEmpty())
            summary << ", key " << key << " " << session.getProperty ("keyScale", var()).toString();
        auto tracks = snap.getProperty ("tracks", var());
        summary << "; " << tracks.size() << " tracks";
        for (int i = 0; i < jmin (12, tracks.size()); ++i)
        {
            auto t = tracks[i];
            summary << (i == 0 ? ": " : ", ")
                    << t.getProperty ("name", var()).toString()
                    << " (" << t.getProperty ("clips", var()).size() << " clips)";
        }
    }

    auto* body = new DynamicObject();
    body->setProperty ("instruction", instruction);
    body->setProperty ("session_summary", summary);
    if (args.hasProperty ("history")) body->setProperty ("history", args.getProperty ("history", var()));
    if (args.hasProperty ("provider")) body->setProperty ("provider", args.getProperty ("provider", var()));

    auto r = jobManager.postJson ("/agent/propose", var (body));
    const bool ok = (bool) r.getProperty ("ok", false);
    logLine ("agent_propose", args, ok,
             ok ? String() : r.getProperty ("error", "agent failed").toString(), false);
    if (! ok)
    {
        auto err = errResult ("agent_propose", r.getProperty ("error", "agent failed").toString());
        if (auto ve = r.getProperty ("validation_errors", var()); ve.isArray())
            err.getDynamicObject()->setProperty ("validation_errors", ve);
        return err;
    }
    return okResult ("agent_propose", r);
}

} // namespace mosh
