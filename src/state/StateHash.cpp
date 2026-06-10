#include "StateHash.h"
#include "Ids.h"
#include <juce_cryptography/juce_cryptography.h>
#include <algorithm>
#include <vector>

namespace mosh
{
using namespace juce;

namespace
{
    // Canonical writer: we never use JSON::toString for the hashed projection —
    // JUCE's double formatting is not pinned, and property order would couple
    // the hash to insertion order. This writer is the format contract.
    struct Canon
    {
        String out;

        void key (const char* k)            { out << '"' << k << "\":"; }
        void str (const String& s)          { out << '"' << s.replace ("\\", "\\\\").replace ("\"", "\\\"") << '"'; }
        void num (double v)
        {
            // Fixed 6-decimal format; normalize negative zero.
            if (v == 0.0) v = 0.0;
            char buf[64];
            snprintf (buf, sizeof (buf), "%.6f", v);
            out << buf;
        }
        void num (int v)                    { out << String (v); }
        void boolean (bool b)               { out << (b ? "true" : "false"); }
        void open()                         { out << '{'; }
        void close()                        { out << '}'; }
        void openArr()                      { out << '['; }
        void closeArr()                     { out << ']'; }
        void comma()                        { out << ','; }
    };

    juce::String sourceContentId (const File& f)
    {
        // Cached by (path, size, mtime): clip sources are effectively
        // immutable, and stateHash runs after every recorded mutation.
        struct Entry { int64 size, mtime; String md5; };
        static std::map<String, Entry> cache;
        if (! f.existsAsFile()) return f.getFileName();
        const auto key = f.getFullPathName();
        const auto size = f.getSize();
        const auto mtime = f.getLastModificationTime().toMilliseconds();
        if (auto it = cache.find (key); it != cache.end()
              && it->second.size == size && it->second.mtime == mtime)
            return it->second.md5;
        const auto md5 = MD5 (f).toHexString();
        cache[key] = { size, mtime, md5 };
        return md5;
    }

    int trackOrdinalFor (te::Edit& edit, te::Track* t)
    {
        if (t == nullptr) return -1;
        int i = 0;
        for (auto* at : te::getAudioTracks (edit))
        {
            if (at == t) return i;
            ++i;
        }
        return -1;
    }

    void writeAutomation (Canon& c, te::Plugin& p)
    {
        // Only parameters that actually carry points; index-addressed.
        c.key ("automation"); c.openArr();
        bool first = true;
        const int n = p.getNumAutomatableParameters();
        for (int i = 0; i < n; ++i)
        {
            auto param = p.getAutomatableParameter (i);
            if (param == nullptr || ! param->hasAutomationPoints()) continue;
            auto& curve = param->getCurve();
            if (! first) c.comma();
            first = false;
            c.open();
            c.key ("param"); c.num (i); c.comma();
            c.key ("points"); c.openArr();
            for (int j = 0; j < curve.getNumPoints(); ++j)
            {
                auto pt = curve.getPoint (j);
                if (j > 0) c.comma();
                c.open();
                c.key ("t"); c.num (curve.getPointTime (j).inSeconds()); c.comma();
                c.key ("v"); c.num ((double) pt.value); c.comma();
                c.key ("c"); c.num ((double) pt.curve);
                c.close();
            }
            c.closeArr();
            c.close();
        }
        c.closeArr();
    }

    void writePlugin (Canon& c, te::Plugin& p)
    {
        const bool external = dynamic_cast<te::ExternalPlugin*> (&p) != nullptr;
        c.open();
        c.key ("type"); c.str (p.getPluginType()); c.comma();
        c.key ("name"); c.str (p.getName()); c.comma();
        c.key ("enabled"); c.boolean (p.isEnabled()); c.comma();
        c.key ("params"); c.openArr();
        // ALL params for builtins; externals capped at 128 (header note).
        // An AUTOMATED parameter's live value is playback-position state, not
        // session state (the engine re-evaluates it at the playhead on load) —
        // for those the curve, serialized below, IS the canonical value.
        const int n = jmin (p.getNumAutomatableParameters(), external ? 128 : 4096);
        for (int i = 0; i < n; ++i)
        {
            if (i > 0) c.comma();
            auto param = p.getAutomatableParameter (i);
            c.num (param == nullptr ? 0.0
                   : param->hasAutomationPoints() ? 0.0
                                                  : (double) param->getCurrentNormalisedValue());
        }
        c.closeArr(); c.comma();
        writeAutomation (c, p);
        c.close();
    }

    void writeNotes (Canon& c, te::MidiClip& mc)
    {
        // Sorted by (start, pitch, length, vel) — sequence storage order is an
        // implementation detail, the musical content is the set.
        struct N { double s, d; int p, v; };
        std::vector<N> notes;
        for (auto* n : mc.getSequence().getNotes())
            notes.push_back ({ n->getStartBeat().inBeats(), n->getLengthBeats().inBeats(),
                               n->getNoteNumber(), n->getVelocity() });
        std::sort (notes.begin(), notes.end(), [] (const N& a, const N& b)
        {
            if (a.s != b.s) return a.s < b.s;
            if (a.p != b.p) return a.p < b.p;
            if (a.d != b.d) return a.d < b.d;
            return a.v < b.v;
        });

        c.key ("notes"); c.openArr();
        for (size_t i = 0; i < notes.size(); ++i)
        {
            if (i > 0) c.comma();
            c.open();
            c.key ("p"); c.num (notes[i].p); c.comma();
            c.key ("s"); c.num (notes[i].s); c.comma();
            c.key ("d"); c.num (notes[i].d); c.comma();
            c.key ("v"); c.num (notes[i].v);
            c.close();
        }
        c.closeArr();
    }

    void writeRenderLayer (Canon& c, const ValueTree& rl)
    {
        // Musical identity only — cacheKey/cacheArtifact are machine-local.
        c.key ("renderLayer"); c.open();
        c.key ("mode"); c.str (rl[ids::mode].toString()); c.comma();
        c.key ("variant"); c.str (rl[ids::modelVariant].toString()); c.comma();
        c.key ("adapter"); c.str (rl[ids::modelAdapter].toString()); c.comma();
        c.key ("seed"); c.num ((int) rl[ids::seed]); c.comma();
        c.key ("kept"); c.boolean ((bool) rl[ids::userKept]);
        if (auto params = rl.getChildWithName (ids::PARAMS); params.isValid())
        {
            c.comma();
            c.key ("prompt"); c.str (params[ids::prompt].toString()); c.comma();
            c.key ("nl"); c.num ((double) params[ids::nl]); c.comma();
            c.key ("colors"); c.openArr();
            if (auto cs = params.getChildWithName (ids::COLORS); cs.isValid())
                for (int i = 0; i < cs.getNumChildren(); ++i)
                {
                    if (i > 0) c.comma();
                    c.open();
                    c.key ("n"); c.str (cs.getChild (i)[ids::name].toString()); c.comma();
                    c.key ("v"); c.num ((double) cs.getChild (i)[ids::value]);
                    c.close();
                }
            c.closeArr();
        }
        c.close();
    }

    void writeClip (Canon& c, te::Clip& clip)
    {
        auto pos = clip.getPosition();
        c.open();
        c.key ("name"); c.str (clip.getName()); c.comma();
        c.key ("start"); c.num (pos.getStart().inSeconds()); c.comma();
        c.key ("length"); c.num (pos.getLength().inSeconds()); c.comma();
        c.key ("offset"); c.num (pos.getOffset().inSeconds());

        if (auto* w = dynamic_cast<te::WaveAudioClip*> (&clip))
        {
            c.comma();
            c.key ("type"); c.str ("wave"); c.comma();
            // CONTENT identity, not name identity: collab peers materialize
            // the same audio under different filenames (content-addressed
            // assets), so the canonical source is the file's MD5.
            c.key ("source"); c.str (sourceContentId (w->getCurrentSourceFile())); c.comma();
            c.key ("pitch"); c.num ((double) w->getPitchChange()); c.comma();
            c.key ("speed"); c.num (w->getSpeedRatio());
        }
        else if (auto* m = dynamic_cast<te::MidiClip*> (&clip))
        {
            c.comma();
            c.key ("type"); c.str ("midi"); c.comma();
            writeNotes (c, *m);
        }

        if (auto rl = clip.state.getChildWithName (ids::MOSH_RENDERLAYER); rl.isValid())
        {
            c.comma();
            writeRenderLayer (c, rl);
        }
        c.close();
    }
}

String stateProjection (te::Edit& edit)
{
    Canon c;
    c.open();

    // ── session / musical context ──
    c.key ("schema"); c.num (1); c.comma();
    c.key ("tempo"); c.num (edit.tempoSequence.getBpmAt (tracktion::TimePosition())); c.comma();
    auto& ts = edit.tempoSequence.getTimeSigAt (tracktion::TimePosition());
    c.key ("timeSig"); c.openArr(); c.num (ts.numerator.get()); c.comma(); c.num (ts.denominator.get()); c.closeArr(); c.comma();

    auto moshSession = edit.state.getChildWithName (Identifier ("MOSH_SESSION"));
    c.key ("key"); c.str (moshSession.isValid()
        ? moshSession.getProperty ("keyRoot", "").toString() + ":" + moshSession.getProperty ("keyScale", "").toString()
        : ":");
    c.comma();

    c.key ("sections"); c.openArr();
    if (auto arrange = edit.state.getChildWithName (Identifier ("MOSH_ARRANGE")); arrange.isValid())
        for (int i = 0; i < arrange.getNumChildren(); ++i)
        {
            auto s = arrange.getChild (i);
            if (i > 0) c.comma();
            c.open();
            c.key ("name"); c.str (s.getProperty ("name").toString()); c.comma();
            c.key ("start"); c.num ((int) s.getProperty ("startBar")); c.comma();
            c.key ("bars"); c.num ((int) s.getProperty ("lengthBars"));
            c.close();
        }
    c.closeArr(); c.comma();

    // ── tracks (structural order = ordinal identity) ──
    c.key ("tracks"); c.openArr();
    int ti = 0;
    for (auto* t : te::getAudioTracks (edit))
    {
        if (t == nullptr) continue;
        if (ti++ > 0) c.comma();
        c.open();
        c.key ("name"); c.str (t->getName()); c.comma();
        c.key ("mute"); c.boolean (t->isMuted (false)); c.comma();
        c.key ("solo"); c.boolean (t->isSolo (false)); c.comma();
        if (auto* vp = t->getVolumePlugin())
        {
            // Same automated-param rule as writePlugin: curve = the state.
            const bool volAuto = vp->volParam != nullptr && vp->volParam->hasAutomationPoints();
            const bool panAuto = vp->panParam != nullptr && vp->panParam->hasAutomationPoints();
            c.key ("vol"); c.num (volAuto ? 0.0 : (double) vp->getVolumeDb()); c.comma();
            c.key ("pan"); c.num (panAuto ? 0.0 : (double) vp->getPan()); c.comma();
        }
        else
        {
            c.key ("vol"); c.num (0.0); c.comma();
            c.key ("pan"); c.num (0.0); c.comma();
        }
        c.key ("routeTo"); c.num (trackOrdinalFor (edit, t->getOutput().getDestinationTrack())); c.comma();

        c.key ("plugins"); c.openArr();
        auto plugins = t->pluginList.getPlugins();
        int pi = 0;
        for (int i = 0; i < plugins.size(); ++i)
        {
            // The Stage-14 meter tap is observability, not musical state — a
            // plugin that cannot change sound must not change the hash (old
            // sessions lack it, every new track gains it).
            if (plugins[i]->getPluginType() == te::LevelMeterPlugin::xmlTypeName)
                continue;
            if (pi++ > 0) c.comma();
            writePlugin (c, *plugins[i]);
        }
        c.closeArr(); c.comma();

        c.key ("clips"); c.openArr();
        int ci = 0;
        for (auto* clip : t->getClips())
        {
            if (clip == nullptr) continue;
            if (ci++ > 0) c.comma();
            writeClip (c, *clip);
        }
        c.closeArr();
        c.close();
    }
    c.closeArr();

    c.close();
    return c.out;
}

String stateHash (te::Edit& edit)
{
    const auto projection = stateProjection (edit);
    return SHA256 (projection.toRawUTF8(), projection.getNumBytesAsUTF8()).toHexString();
}

} // namespace mosh
