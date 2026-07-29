// ── SelfTest harness plumbing (RFC 002 — selftest chapter split, scaffolding) ──
// Bodies verbatim from the pre-split src/app/SelfTest.cpp anonymous namespace,
// reworked only to take SelfTestCtx& where they used the file-static counters.

#include "SelfTestSupport.h"

#include "engine/MoshEngine.h"
#include "moshops/MoshOps.h"

#include <iostream>

namespace mosh
{
namespace selftest
{
    SelfTestCtx& globalCtx()
    {
        static SelfTestCtx ctx;
        return ctx;
    }

    void finishSection (SelfTestCtx& ctx)
    {
        if (ctx.activeSection.isEmpty())
            return;

        const auto elapsed = (juce::Time::getMillisecondCounterHiRes() - ctx.activeSectionStartedMs) / 1000.0;
        std::cerr << "  ..   section \"" << ctx.activeSection.toStdString() << "\" completed in "
                  << juce::String (elapsed, 3).toStdString() << "s ("
                  << (ctx.checks - ctx.activeSectionStartChecks) << " checks, "
                  << (ctx.failures - ctx.activeSectionStartFailures) << " failed)" << std::endl;
        ctx.activeSection.clear();
    }

    void resetSections (SelfTestCtx& ctx)
    {
        ctx.activeSection.clear();
        ctx.activeSectionStartedMs = 0.0;
        ctx.activeSectionStartChecks = ctx.checks;
        ctx.activeSectionStartFailures = ctx.failures;
    }

    void section (SelfTestCtx& ctx, const juce::String& name)
    {
        finishSection (ctx);
        ctx.activeSection = name;
        ctx.activeSectionStartedMs = juce::Time::getMillisecondCounterHiRes();
        ctx.activeSectionStartChecks = ctx.checks;
        ctx.activeSectionStartFailures = ctx.failures;
        std::cerr << "--- " << name.toStdString() << " ---" << std::endl;
    }

    void section (SelfTestCtx& ctx, const char* name)
    {
        section (ctx, juce::String (juce::CharPointer_UTF8 (name)));
    }

    void check (SelfTestCtx& ctx, bool cond, const juce::String& what)
    {
        ++ctx.checks;
        std::cerr << (cond ? "  ok   " : "  FAIL ");
        if (! cond && ctx.activeSection.isNotEmpty())
            std::cerr << "[" << ctx.activeSection.toStdString() << "] ";
        std::cerr << what << std::endl;  // flush each line
        if (! cond) ++ctx.failures;
    }

    void check (SelfTestCtx& ctx, bool cond, const char* what)
    {
        check (ctx, cond, juce::String (juce::CharPointer_UTF8 (what)));
    }

    juce::var cmd (MoshOps& ops, const juce::String& name, juce::var args)
    {
        auto* c = new juce::DynamicObject();
        c->setProperty ("command", name);
        if (! args.isVoid()) c->setProperty ("args", args);
        return ops.execute (juce::var (c));
    }

    juce::var args1 (const char* k, juce::var v)
    {
        auto* o = new juce::DynamicObject();
        o->setProperty (k, v);
        return juce::var (o);
    }

    juce::var objN (std::initializer_list<std::pair<const char*, juce::var>> kv)
    {
        auto* o = new juce::DynamicObject();
        for (auto& p : kv) o->setProperty (p.first, p.second);
        return juce::var (o);
    }

    // A fixed filename in the shared, machine-wide system temp dir collides when two
    // `Mosh --selftest` processes run at once on the same host (a self-hosted CI runner
    // racing a dev's local run, or two concurrent worktree gates): one process's
    // deleteFile()/write races the other's read and false-fails a check that has nothing
    // to do with the code under test. The per-run session dir (isolated via
    // MOSH_SELFTEST_SESSION) is the existing hermeticity boundary, but File::tempDirectory
    // paths escape it. Scope every temp artifact to THIS process — same root-cause class as
    // PR #342's hermetic service ports, for a temp-file path instead of a network port.
    juce::File selftestTempPath (const MoshEngine& eng, const juce::String& leafName)
    {
        // Computed once per process: the isolated session leaf (already unique under the
        // documented MOSH_SELFTEST_SESSION isolation) + a Uuid fragment (unique even when
        // that env override is absent — e.g. a plain `--selftest` racing on both sides).
        static const juce::String tag = eng.sessionDir().getFileName()
                                            + "-" + juce::Uuid().toString().substring (0, 8);
        return juce::File::getSpecialLocation (juce::File::tempDirectory)
                   .getChildFile ("mosh-selftest-" + tag + "-" + leafName);
    }

    bool ok (const juce::var& r) { return (bool) r.getProperty ("ok", false); }

    int tracks (MoshOps& ops) { return ops.snapshot().getProperty ("tracks", juce::var()).size(); }

    juce::var firstTrack (MoshOps& ops) { return ops.snapshot()["tracks"][0]; }
    int trackClips (const juce::var& t) { return t.getProperty ("clips", juce::var()).size(); }

    juce::var trackSnapshotByLogicalId (MoshOps& ops, const juce::String& logicalId)
    {
        auto snapshot = ops.snapshot();
        if (auto* arr = snapshot.getProperty ("tracks", juce::var()).getArray())
            for (auto& track : *arr)
                if (track.getProperty ("logicalId", juce::var()).toString() == logicalId)
                    return track;
        return {};
    }

} // namespace selftest
} // namespace mosh
