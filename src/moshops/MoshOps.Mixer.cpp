// RFC 001 (A-PR3) — MoshOps partial-class split: the mixer-domain command
// bodies (master volume/pan, Wave-9 metering enable/disable + the per-track
// LevelMeterPlugin helpers, the master spectral tap that feeds Moshi
// reactivity, bus/send routing, and — placed here because their base ranges
// are contiguous with this block, as A-PR2 deferred them — get_clip_peaks/
// file_peaks waveform overviews + file audition), moved VERBATIM from
// MoshOps.cpp. Same class, same member functions — only the translation unit
// changed. The dispatch if-chain and all transaction/log/result/emit plumbing
// stay in MoshOps.cpp (one mutation path, by construction). Cross-TU helpers
// (isInternalMasterPlugin — also used by the snapshot serializer that stays
// behind) live in MoshOpsInternal.h; bucketedPeaks joined it for the take-lanes
// wave (list_takes in MoshOps.Tracks.cpp is its third consumer).

#include "MoshOps.h"
#include "MoshOpsInternal.h"
#include "state/Ids.h"

#include <cmath>

namespace mosh
{
using namespace juce;

namespace
{
bool isPreFaderSend (te::AudioTrack& track, te::AuxSendPlugin& send)
{
    auto* volume = track.getVolumePlugin();
    if (volume == nullptr) return false;
    const int sendIndex = track.pluginList.indexOf (&send);
    const int volumeIndex = track.pluginList.indexOf (volume);
    return sendIndex >= 0 && volumeIndex >= 0 && sendIndex < volumeIndex;
}

bool positionSendRelativeToFader (te::AudioTrack& track, te::AuxSendPlugin& send,
                                  bool preFader, juce::UndoManager& undo)
{
    auto* volume = track.getVolumePlugin();
    if (volume == nullptr) return false;
    const int sendIndex = track.pluginList.state.indexOf (send.state);
    const int volumeIndex = track.pluginList.state.indexOf (volume->state);
    if (sendIndex < 0 || volumeIndex < 0) return false;

    const int targetIndex = preFader
        ? (sendIndex < volumeIndex ? volumeIndex - 1 : volumeIndex)
        : (sendIndex < volumeIndex ? volumeIndex : volumeIndex + 1);
    if (targetIndex != sendIndex)
        track.pluginList.state.moveChild (sendIndex, targetIndex, &undo);
    return true;
}
}

// ── Metering helpers (Wave 9) ────────────────────────────────────────────────
te::LevelMeterPlugin* MoshOps::findTrackMeter (te::AudioTrack& t)
{
    for (auto* p : t.pluginList.getPlugins())
        if (auto* m = dynamic_cast<te::LevelMeterPlugin*> (p))
            return m;
    return nullptr;
}

te::LevelMeterPlugin* MoshOps::ensureTrackMeter (te::AudioTrack& t)
{
    // CAP-AUT-006 — materialise the mute gate here, BEFORE the early return, so it lands
    // on legacy tracks that already have a meter as well as on fresh ones. Every path
    // that gives a track a meter gives it a mute gate; keeping the two together is what
    // guarantees the gate ends up upstream of the meter (see ensureTrackMuteGate).
    // Best-effort, exactly like the meter itself: a failure here must not fail the
    // caller's command.
    ensureTrackMuteGate (t);

    if (auto* lm = findTrackMeter (t)) return lm;
    auto plugin = eng.edit().getPluginCache().createNewPlugin (te::LevelMeterPlugin::xmlTypeName, {});
    if (plugin == nullptr) return nullptr;
    auto* lm = dynamic_cast<te::LevelMeterPlugin*> (plugin.get());
    t.pluginList.insertPlugin (plugin, t.pluginList.getPlugins().size(), nullptr);   // append → post-fader
    return lm;                                                // client is wired by reconcileMeterClients()
}

// ── CAP-AUT-006: the mute gate (a hidden mixer element, one automatable parameter) ────
TrackMutePlugin* MoshOps::findTrackMuteGate (te::AudioTrack& t)
{
    for (auto* p : t.pluginList.getPlugins())
        if (auto* g = dynamic_cast<TrackMutePlugin*> (p))
            return g;
    return nullptr;
}

TrackMutePlugin* MoshOps::ensureTrackMuteGate (te::AudioTrack& t)
{
    if (auto* g = findTrackMuteGate (t)) return g;

    auto plugin = eng.edit().getPluginCache().createNewPlugin (TrackMutePlugin::xmlTypeName, {});
    if (plugin == nullptr) return nullptr;
    auto* gate = dynamic_cast<TrackMutePlugin*> (plugin.get());
    if (gate == nullptr) return nullptr;

    // Insert immediately BEFORE the level-meter tap when one exists, else append. Two
    // things follow from that placement, and both are the point:
    //   - the meter is downstream of the gate, so a track the curve has muted reads
    //     silent on its own meter — a bouncing meter over a muted track would be exactly
    //     the kind of convincing lie this repo keeps getting bitten by;
    //   - the gate is a pure multiply, so it COMMUTES with the fader. It does not matter
    //     whether ensureVolumePlugin has run yet or where the fader lands relative to it;
    //     silence × any gain is silence. Only the meter's side of the gate matters.
    // A plugin the user loads LATER still appends to the end of the chain, i.e.
    // downstream of the gate — it is fed silence while muted, but can ring its own tail
    // out. TrackMutePlugin.h states that difference from the routing mute in full.
    int index = t.pluginList.getPlugins().size();
    if (auto* lm = findTrackMeter (t))
    {
        const int meterIndex = t.pluginList.indexOf (lm);
        if (meterIndex >= 0) index = meterIndex;
    }
    t.pluginList.insertPlugin (plugin, index, nullptr);
    return gate;
}

juce::var MoshOps::muteAutomationAtPlayhead()
{
    const auto now = eng.edit().getTransport().getPosition();

    juce::Array<var> tracks;
    for (auto* t : te::getAudioTracks (eng.edit()))
    {
        if (t == nullptr) continue;
        auto* gate = findTrackMuteGate (*t);
        if (gate == nullptr) continue;
        auto* param = gate->getMuteParameter();
        // Only tracks the producer has actually automated ride this rail. Presence in
        // the array IS the "this mute is automated" signal the UI styles on; a track
        // with no curve is absent, and its button keeps meaning exactly what it always
        // meant. Emitting every track would make "automated" indistinguishable from
        // "open", which is the whole thing the button has to tell apart.
        if (param == nullptr || ! param->hasAutomationPoints()) continue;

        // te::getValueAt falls back to the parameter's base value when the curve is
        // empty, and reads the curve otherwise — no audio thread, no playback context.
        // Threshold at 0.5 because that is exactly where the engine's own snapToState
        // flips this two-state parameter (TrackMutePlugin.cpp's MuteParameter).
        const bool muted = te::getValueAt (*param, now) >= 0.5f;

        auto* o = new DynamicObject();
        o->setProperty ("id", t->itemID.toString());
        o->setProperty ("muted", muted);
        tracks.add (var (o));
    }

    auto* payload = new DynamicObject();
    payload->setProperty ("tracks", tracks);
    return var (payload);
}

// Sync the client map to the LIVE meter taps in the edit. Robust against undo/
// redo/remove destroying a meter plugin: we only ever read our OWN Client (alive),
// never a stale measurer. A tap whose track no longer has a meter is dropped
// WITHOUT removeClient (its measurer is already gone); a fresh meter gets a client
// added to its (live) measurer. Called every frame before reading levels.
void MoshOps::reconcileMeterClients()
{
    std::map<juce::String, te::LevelMeterPlugin*> live;
    for (auto* t : te::getAudioTracks (eng.edit()))
        if (t != nullptr)
            if (auto* lm = findTrackMeter (*t))
                live[t->itemID.toString()] = lm;

    for (auto it = meterClients.begin(); it != meterClients.end();)
    {
        if (live.find (it->first) == live.end())
            it = meterClients.erase (it);                    // plugin gone (undo/remove) — drop, no removeClient
        else
            ++it;
    }
    for (auto& [id, lm] : live)
    {
        auto& slot = meterClients[id];
        if (slot == nullptr) slot = std::make_unique<MeterTap>();
        if (slot->plugin != lm)                              // new / replaced instance — (re)register our client
        {
            slot->plugin = lm;
            lm->measurer.addClient (slot->client);
        }
    }
}

void MoshOps::unregisterAllMeterClients()
{
    // Detach our clients, but ONLY from measurers that are still live — a track
    // removed since the last reconcile leaves a stale plugin pointer we must not
    // deref. Build the live set and match by value.
    juce::Array<te::LevelMeterPlugin*> live;
    for (auto* t : te::getAudioTracks (eng.edit()))
        if (t != nullptr)
            if (auto* lm = findTrackMeter (*t))
                live.add (lm);
    for (auto& [id, tap] : meterClients)
        if (tap != nullptr && tap->plugin != nullptr && live.contains (tap->plugin))
            tap->plugin->measurer.removeClient (tap->client);
    meterClients.clear();
}

// ── master spectral feed (Moshi reactivity) ──────────────────────────────────
MasterSpectralTapPlugin* MoshOps::findMasterSpectralTap()
{
    for (auto* p : eng.edit().getMasterPluginList().getPlugins())
        if (auto* t = dynamic_cast<MasterSpectralTapPlugin*> (p))
            return t;
    return nullptr;
}

MasterSpectralTapPlugin* MoshOps::ensureMasterSpectralTap()
{
    if (auto* t = findMasterSpectralTap()) return t;
    auto plugin = eng.edit().getPluginCache().createNewPlugin (MasterSpectralTapPlugin::xmlTypeName, {});
    if (plugin == nullptr) return nullptr;
    auto* t = dynamic_cast<MasterSpectralTapPlugin*> (plugin.get());
    auto& list = eng.edit().getMasterPluginList();
    list.insertPlugin (plugin, list.getPlugins().size(), nullptr);   // append → taps the final master output
    return t;
}

// See the MoshOps.h comment on masterVisibleBoundary() for the invariant this relies on.
int MoshOps::masterVisibleBoundary()
{
    int i = 0;
    for (auto* p : eng.edit().getMasterPluginList().getPlugins())
    {
        if (isInternalMasterPlugin (p)) return i;
        ++i;
    }
    return i;
}

te::Plugin* MoshOps::findMasterPlugin (int index)
{
    auto plugins = eng.edit().getMasterPluginList().getPlugins();
    return (index >= 0 && index < masterVisibleBoundary()) ? plugins[index].get() : nullptr;
}

// Drain the tap (message thread), window + Goertzel into 12 log-spaced bands +
// overall level + spectral flux, and emit the `spectrum` event (mirrors `levels`).
void MoshOps::emitSpectrum (bool playing)
{
    if (! playing)
    {
        Array<var> z; for (int b = 0; b < 12; ++b) z.add (0.0f);
        spectralPrevBands.fill (0.0f);
        auto* zp = new DynamicObject(); zp->setProperty ("bands", z); zp->setProperty ("level", 0.0f); zp->setProperty ("flux", 0.0f);
        emit ("spectrum", var (zp));
        return;
    }

    auto* tap = ensureMasterSpectralTap();
    if (tap == nullptr) return;

    float scratch[2048];
    const int got = tap->read (scratch, 2048);
    for (int i = 0; i < got; ++i) { spectralRing[(size_t) spectralRingPos] = scratch[i]; if (++spectralRingPos >= 1024) spectralRingPos = 0; }

    float win[1024];
    double sumsq = 0.0;
    for (int i = 0; i < 1024; ++i)
    {
        const int idx = (spectralRingPos + i) & 1023;
        const float wnd = 0.5f - 0.5f * std::cos (juce::MathConstants<float>::twoPi * (float) i / 1023.0f);
        const float s = spectralRing[(size_t) idx] * wnd;
        win[i] = s; sumsq += (double) s * (double) s;
    }
    const float levelDb = 20.0f * std::log10 ((float) std::sqrt (sumsq / 1024.0) + 1e-9f);
    const float level = juce::jlimit (0.0f, 1.0f, (levelDb + 60.0f) / 60.0f);

    const double sr = tap->getSampleRate() > 0.0 ? tap->getSampleRate() : 48000.0;
    static const float centers[12] = { 55, 80, 120, 180, 260, 380, 550, 800, 1200, 2000, 3500, 7000 };
    Array<var> bandsVar; float flux = 0.0f;
    for (int b = 0; b < 12; ++b)
    {
        const float f = centers[b] / (float) sr;
        float nb = 0.0f;
        if (f < 0.5f)
        {
            const double w = juce::MathConstants<double>::twoPi * (double) f;
            const double coeff = 2.0 * std::cos (w);
            double sp = 0.0, sp2 = 0.0;
            for (int i = 0; i < 1024; ++i) { const double s = (double) win[i] + coeff * sp - sp2; sp2 = sp; sp = s; }
            const double power = sp2 * sp2 + sp * sp - coeff * sp * sp2;
            const double mag = std::sqrt (juce::jmax (0.0, power)) / 512.0;
            const float db = 20.0f * std::log10 ((float) mag + 1e-9f);
            nb = juce::jlimit (0.0f, 1.0f, (db + 66.0f) / 60.0f);
        }
        flux += juce::jmax (0.0f, nb - spectralPrevBands[(size_t) b]);
        spectralPrevBands[(size_t) b] = nb;
        bandsVar.add (nb);
    }
    flux = juce::jlimit (0.0f, 1.0f, flux / 3.0f);

    auto* p = new DynamicObject();
    p->setProperty ("bands", bandsVar);
    p->setProperty ("level", level);
    p->setProperty ("flux", flux);
    emit ("spectrum", var (p));
}

juce::var MoshOps::cmdSetMasterVolume (const juce::var& args)
{
    auto mvp = eng.edit().getMasterVolumePlugin();
    if (mvp == nullptr) return errResult ("set_master_volume", "no master plugin");
    beginTxn ("set_master_volume");
    // G14 — route the master fader through the UndoManager (setVolumeDb alone bypasses it).
    undoManager().perform (new SetFaderValueAction (*mvp, false,
        juce::jlimit (-48.0f, 6.0f, (float) (double) args.getProperty ("db", 0.0))));
    logLine ("set_master_volume", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_master_volume");
}

juce::var MoshOps::cmdSetMasterPan (const juce::var& args)
{
    auto mvp = eng.edit().getMasterVolumePlugin();
    if (mvp == nullptr) return errResult ("set_master_pan", "no master plugin");
    beginTxn ("set_master_pan");
    // G14 — route the master pan through the UndoManager (setPan alone bypasses it).
    undoManager().perform (new SetFaderValueAction (*mvp, true,
        juce::jlimit (-1.0f, 1.0f, (float) (double) args.getProperty ("pan", 0.0))));
    logLine ("set_master_pan", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_master_pan");
}

juce::var MoshOps::cmdEnableTrackMeter (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("enable_track_meter", "no track");
    beginTxn ("enable_track_meter");
    if (ensureTrackMeter (*track) == nullptr) return errResult ("enable_track_meter", "could not create meter");
    logLine ("enable_track_meter", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("enable_track_meter");
}

juce::var MoshOps::cmdDisableTrackMeter (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("disable_track_meter", "no track");
    const auto id = track->itemID.toString();
    if (auto it = meterClients.find (id); it != meterClients.end())
    {
        if (it->second != nullptr && it->second->plugin != nullptr)
            it->second->plugin->measurer.removeClient (it->second->client);   // unregister before delete
        meterClients.erase (it);
    }
    beginTxn ("disable_track_meter");
    if (auto* lm = findTrackMeter (*track)) lm->deleteFromParent();
    logLine ("disable_track_meter", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("disable_track_meter");
}

juce::var MoshOps::cmdEnableAllMeters (const juce::var& args)
{
    beginTxn ("enable_all_meters");
    int n = 0;
    for (auto* t : te::getAudioTracks (eng.edit()))
        if (t != nullptr && ensureTrackMeter (*t) != nullptr) ++n;
    logLine ("enable_all_meters", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject(); data->setProperty ("count", n);
    return okResult ("enable_all_meters", var (data));
}

// ─────────────────────────────────────────────────────────────────────────────
// Wave 8 — sends / returns / aux buses. A "bus" is an integer busNumber; the
// return is a normal AudioTrack carrying an AuxReturnPlugin (which renders even
// with no input). Sends are post-fader AuxSendPlugins appended to a track's
// chain, routed purely by matching busNumber. (Plan: docs/plans/wave-sends.md.)
// ─────────────────────────────────────────────────────────────────────────────
te::AuxReturnPlugin* MoshOps::firstAuxReturnOn (te::AudioTrack& t)
{
    for (auto* p : t.pluginList.getPlugins())
        if (auto* r = dynamic_cast<te::AuxReturnPlugin*> (p))
            return r;
    return nullptr;
}

te::AudioTrack* MoshOps::findReturnTrackForBus (int bus)
{
    for (auto* t : te::getAudioTracks (eng.edit()))
        if (t != nullptr)
            if (auto* r = firstAuxReturnOn (*t))
                if (r->busNumber.get() == bus)
                    return t;
    return nullptr;
}

int MoshOps::allocateBusNumber()
{
    juce::Array<int> used;
    for (auto* t : te::getAudioTracks (eng.edit()))
        if (t != nullptr)
            for (auto* p : t->pluginList.getPlugins())
                if (auto* r = dynamic_cast<te::AuxReturnPlugin*> (p))
                    used.add (r->busNumber.get());
    int n = 0;
    while (used.contains (n)) ++n;
    return n;
}

juce::var MoshOps::cmdCreateBus (const juce::var& args)
{
    auto& edit = eng.edit();
    const int bus = allocateBusNumber();
    auto name = args.getProperty ("name", var()).toString();
    if (name.isEmpty()) name = "Bus " + String (bus + 1);

    beginTxn ("create_bus");
    auto* track = createAudioTrack (name);
    if (track == nullptr) return errResult ("create_bus", "could not create return track");

    auto plugin = edit.getPluginCache().createNewPlugin (te::AuxReturnPlugin::xmlTypeName, {});
    if (plugin == nullptr) return errResult ("create_bus", "could not create aux return");
    if (auto* r = dynamic_cast<te::AuxReturnPlugin*> (plugin.get()))
        r->busNumber = bus;
    track->pluginList.insertPlugin (plugin, 0, nullptr);
    ensureVolumePlugin (*track);
    // METER-001 — after the return/volume plugins so the tap stays truly last (post-fader).
    // Not surfaced in v2's arrangement (bus/return tracks are excluded from TrackLaneHeader,
    // matching classic Mixer.tsx's `!t.isReturn` filter) but kept consistent with what
    // enable_all_meters already covers for every AudioTrack, buses included.
    ensureTrackMeter (*track);
    edit.setAuxBusName (bus, name);

    auto* data = new DynamicObject();
    data->setProperty ("busNumber", bus);
    data->setProperty ("trackId", track->itemID.toString());
    data->setProperty ("name", name);
    logLine ("create_bus", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("create_bus", var (data));
}

juce::var MoshOps::cmdAddSend (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("add_send", "no track");
    const int bus = (int) args.getProperty ("bus", -1);
    if (findReturnTrackForBus (bus) == nullptr) return errResult ("add_send", "no such bus");
    if (track->getAuxSendPlugin (bus) != nullptr) return errResult ("add_send", "send already exists");

    auto plugin = eng.edit().getPluginCache().createNewPlugin (te::AuxSendPlugin::xmlTypeName, {});
    if (plugin == nullptr) return errResult ("add_send", "could not create aux send");
    auto* s = dynamic_cast<te::AuxSendPlugin*> (plugin.get());
    if (s == nullptr) return errResult ("add_send", "created plugin was not an aux send");

    const auto requestedPan = (double) args.getProperty ("pan", 0.0);
    if (! std::isfinite (requestedPan)) return errResult ("add_send", "pan must be finite");
    const bool preFader = (bool) args.getProperty ("preFader", false);

    beginTxn ("add_send");
    auto* volume = ensureVolumePlugin (*track);
    if (volume == nullptr) return errResult ("add_send", "could not create track fader");
    const int volumeIndex = track->pluginList.indexOf (volume);
    if (volumeIndex < 0) return errResult ("add_send", "track fader is not in the plugin chain");

    s->busNumber = bus;
    track->pluginList.insertPlugin (plugin, preFader ? volumeIndex : volumeIndex + 1, nullptr);
    s->setGainDb (juce::jlimit (-60.0f, 6.0f, (float) (double) args.getProperty ("db", 0.0)));
    s->setPan ((float) requestedPan);
    s->setMute ((bool) args.getProperty ("mute", false));
    logLine ("add_send", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject(); data->setProperty ("bus", bus);
    return okResult ("add_send", var (data));
}

juce::var MoshOps::cmdSetSendLevel (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("set_send_level", "no track");
    auto* s = track->getAuxSendPlugin ((int) args.getProperty ("bus", -1));
    if (s == nullptr) return errResult ("set_send_level", "no send to that bus");
    beginTxn ("set_send_level");
    s->setGainDb (juce::jlimit (-100.0f, 6.0f, (float) (double) args.getProperty ("db", 0.0)));
    logLine ("set_send_level", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_send_level");
}

juce::var MoshOps::cmdSetSendMute (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("set_send_mute", "no track");
    auto* s = track->getAuxSendPlugin ((int) args.getProperty ("bus", -1));
    if (s == nullptr) return errResult ("set_send_mute", "no send to that bus");
    beginTxn ("set_send_mute");
    s->setMute ((bool) args.getProperty ("mute", false));
    logLine ("set_send_mute", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_send_mute");
}

juce::var MoshOps::cmdSetSendPan (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("set_send_pan", "no track");
    auto* s = track->getAuxSendPlugin ((int) args.getProperty ("bus", -1));
    if (s == nullptr) return errResult ("set_send_pan", "no send to that bus");
    const auto pan = (double) args.getProperty ("pan", 0.0);
    if (! std::isfinite (pan)) return errResult ("set_send_pan", "pan must be finite");
    beginTxn ("set_send_pan");
    s->setPan ((float) pan);
    logLine ("set_send_pan", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_send_pan");
}

juce::var MoshOps::cmdSetSendPreFader (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("set_send_pre_fader", "no track");
    auto* s = track->getAuxSendPlugin ((int) args.getProperty ("bus", -1));
    if (s == nullptr) return errResult ("set_send_pre_fader", "no send to that bus");
    const bool preFader = (bool) args.getProperty ("preFader", false);

    beginTxn ("set_send_pre_fader");
    if (ensureVolumePlugin (*track) == nullptr
        || (isPreFaderSend (*track, *s) != preFader
            && ! positionSendRelativeToFader (*track, *s, preFader, undoManager())))
        return errResult ("set_send_pre_fader", "could not position send around the track fader");
    logLine ("set_send_pre_fader", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_send_pre_fader");
}

juce::var MoshOps::cmdRemoveSend (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("remove_send", "no track");
    auto* s = track->getAuxSendPlugin ((int) args.getProperty ("bus", -1));
    if (s == nullptr) return errResult ("remove_send", "no send to that bus");
    beginTxn ("remove_send");
    s->deleteFromParent();
    logLine ("remove_send", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_send");
}

juce::var MoshOps::cmdRemoveBus (const juce::var& args)
{
    const int bus = (int) args.getProperty ("bus", -1);
    if (bus < 0) return errResult ("remove_bus", "bad bus");
    auto* returnTrack = findReturnTrackForBus (bus);
    if (returnTrack == nullptr) return errResult ("remove_bus", "no such bus");

    beginTxn ("remove_bus");
    // Sweep orphan sends pointing at this bus, then drop the name + the return track.
    for (auto* t : te::getAudioTracks (eng.edit()))
        if (t != nullptr)
            if (auto* s = t->getAuxSendPlugin (bus))
                s->deleteFromParent();
    eng.edit().setAuxBusName (bus, {});
    eng.edit().deleteTrack (returnTrack);
    logLine ("remove_bus", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_bus");
}

juce::var MoshOps::cmdRenameBus (const juce::var& args)
{
    const int bus = (int) args.getProperty ("bus", -1);
    auto* returnTrack = findReturnTrackForBus (bus);
    if (returnTrack == nullptr) return errResult ("rename_bus", "no such bus");
    const auto name = args.getProperty ("name", var()).toString();
    // A bus name is a NON-undoable label (mirrors set_key / project settings): Tracktion's
    // Edit::setAuxBusName writes the AUXBUSNAMES tree with a nullptr UndoManager, so the bus
    // name — the snapshot's authoritative source (getAuxBusName) — cannot be undone. Write
    // the return-track name directly (IDs::name, nullptr) rather than via Track::setName
    // (which records through the UndoManager) so the WHOLE command is consistently
    // non-undoable, with no partial-undo (name half-reverting). markDirty + undoable:false.
    eng.edit().setAuxBusName (bus, name);
    returnTrack->state.setProperty (ids::name, name, nullptr);
    eng.markDirty();
    logLine ("rename_bus", args, true, {}, false);
    emitSnapshotInvalidated();
    return okResult ("rename_bus");
}

juce::var MoshOps::cmdGetClipPeaks (const juce::var& args)
{
    // Backend-computed waveform peaks (peak array per clip; no audio on the web
    // thread, 03 // VERIFY). Read-only — not a mutation, no undo/log.
    const auto id = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (id);
    auto* wave = dynamic_cast<te::WaveAudioClip*> (clip);
    if (wave == nullptr) return errResult ("get_clip_peaks", "no wave clip: " + id);

    const int buckets = juce::jlimit (16, 4000, (int) args.getProperty ("buckets", 600));
    auto file = wave->getCurrentSourceFile();

    juce::AudioFormatManager fm; fm.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader (fm.createReaderFor (file));
    if (reader == nullptr) return errResult ("get_clip_peaks", "cannot read source");

    auto peaks = bucketedPeaks (*reader, buckets);
    auto* data = new DynamicObject();
    data->setProperty ("clipId", id);
    data->setProperty ("buckets", peaks.size());
    data->setProperty ("peaks", var (peaks));
    return okResult ("get_clip_peaks", var (data));
}

juce::var MoshOps::cmdFilePeaks (const juce::var& args)
{
    // Waveform peaks for an un-imported file (the sample-browser thumbnail). Like
    // get_clip_peaks but path-addressed; read-only — no clip, transaction, or log.
    const auto path = args.getProperty ("path", var()).toString();
    if (path.isEmpty()) return errResult ("file_peaks", "missing 'path'");
    juce::File file (path);
    if (! file.existsAsFile()) return errResult ("file_peaks", "file not found: " + path);

    const int buckets = juce::jlimit (16, 4000, (int) args.getProperty ("buckets", 200));
    std::unique_ptr<juce::AudioFormatReader> reader (previewFormats.createReaderFor (file));
    if (reader == nullptr) return errResult ("file_peaks", "cannot read: " + path);

    auto peaks = bucketedPeaks (*reader, buckets);
    auto* data = new DynamicObject();
    data->setProperty ("path", path);
    data->setProperty ("buckets", peaks.size());
    data->setProperty ("peaks", var (peaks));
    return okResult ("file_peaks", var (data));
}

juce::var MoshOps::cmdAuditionFile (const juce::var& args)
{
    // Standalone file preview (audition) — transient, NOT a mutation: no undo
    // transaction, no JSONL line. One preview at a time; a new audition (or
    // stop_audition / the destructor) releases the previous source. Headless
    // (--selftest, no device) it can't sound, but it must start/stop cleanly.
    const auto path = args.getProperty ("path", var()).toString();
    if (path.isEmpty()) return errResult ("audition_file", "missing 'path'");
    juce::File file (path);
    if (! file.existsAsFile()) return errResult ("audition_file", "file not found: " + path);

    stopAudition();

    auto* reader = previewFormats.createReaderFor (file);
    if (reader == nullptr) return errResult ("audition_file", "cannot read: " + path);

    if (! previewThread.isThreadRunning()) previewThread.startThread();
    previewReader.reset (new juce::AudioFormatReaderSource (reader, true));   // owns the reader
    previewTransport.setSource (previewReader.get(), 32768, &previewThread, reader->sampleRate);
    previewPlayer.setSource (&previewTransport);
    if (! previewWired) { adm().addAudioCallback (&previewPlayer); previewWired = true; }
    previewTransport.setPosition (0.0);
    previewTransport.start();

    auto* data = new DynamicObject();
    data->setProperty ("path", path);
    data->setProperty ("playing", adm().getCurrentAudioDevice() != nullptr);
    return okResult ("audition_file", var (data));
}

juce::var MoshOps::cmdStopAudition (const juce::var&)
{
    stopAudition();
    return okResult ("stop_audition");
}

void MoshOps::stopAudition()
{
    previewTransport.stop();
    previewTransport.setSource (nullptr);
    previewPlayer.setSource (nullptr);
    previewReader.reset();
}

} // namespace mosh
