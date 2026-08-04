// Live note audition — playing a pitch through a track's REAL instrument, on demand,
// without touching the arrangement. Three features ride this one seam: the piano roll's
// "hear the note as you drag it up the scale", the drum pad preview, and the computer
// keyboard used as a MIDI controller.
//
// WHY THIS IS NOT A MUTATION. audition_note deliberately calls none of beginTxn,
// logLine or emitSnapshotInvalidated — the same posture as cmdAuditionFile
// (MoshOps.Mixer.cpp), and for a sharper reason: a held key repeats at roughly 30 Hz, so
// logging or invalidating per event would push 30 empty undo transactions, 30 JSONL lines
// and 30 full snapshot re-pulls every second. It is registered in
// mosh::txnsafe::readOnlyDuringTransaction() for the same reason — without that, pressing
// a key while an agent skill holds a transaction open would fail the keypress.
//
// ONE COMMAND, THREE ACTIONS. A QWERTY keyboard needs unbounded sustain ("on" until the
// key comes up), which no duration argument can express; a drag-audition needs a
// fire-and-forget blip whose lifetime does NOT depend on a second WebView round trip
// arriving (a drag that ends over a scroll-jacked element, or a React unmount mid-gesture,
// would otherwise leave a note sounding forever). Those are genuinely different lifetimes,
// so both exist — but as one command, because each new command costs seven registration
// surfaces.
//
// THE HOLE THIS HAS TO REPORT. te::AudioTrack::injectLiveMidiMessage only reaches the
// graph through a LiveMidiInjectingNode, and the engine only builds one when the track
// produced a clips node (tracktion_EditNodeBuilder.cpp — the wrap sits inside `if (node)`,
// and the synth-only SilentNode stub is created afterwards in the `node == nullptr`
// branch, so it never gets one). A track that has an instrument but NO CLIPS therefore
// swallows every injected note in silence. We detect that exactly, via the engine's own
// WastedMidiMessagesListener, and say so — rather than returning ok and letting the
// producer wonder why their keyboard is mute. Where the track has a sampler we can still
// sound it, because SamplerPlugin::playNotes talks to the plugin and bypasses the graph.

#include "MoshOps.h"
#include "MoshOpsInternal.h"
#include "state/Ids.h"
#include <algorithm>

namespace mosh
{
using namespace juce;

namespace
{
// How long a HELD voice may last before the sweep force-releases it — the backstop for a
// note-off that never arrives (a WebView crash, a frozen page, a dropped event). Generous
// enough that a producer genuinely leaning on a key is never cut off.
double heldTtlMs()
{
    const auto env = juce::SystemStats::getEnvironmentVariable ("MOSH_AUDITION_MAX_HOLD_MS", {});
    const int  v   = env.getIntValue();
    return v > 0 ? (double) v : 30000.0;
}

constexpr int kBlipDefaultMs = 250;
constexpr int kBlipMinMs     = 20;
constexpr int kBlipMaxMs     = 5000;
}

// ── REC-002: the keyboard as a real MIDI input ───────────────────────────────────────
te::MidiInputDevice* MoshOps::ensureKeyboardInputDevice()
{
    if (! eng.hasAudio()) return nullptr;

    auto& dm = eng.engine().getDeviceManager();
    auto find = [&] () -> te::MidiInputDevice*
    {
        for (auto& mi : dm.getMidiInDevices())
            if (mi != nullptr && mi->getName() == kKeyboardDeviceName)
                return mi.get();
        return nullptr;
    };

    if (auto* existing = find())
    {
        keyboardDeviceEnsured_ = true;
        return existing;
    }

    // Not the same thing as the flag: the flag stops us RE-SCANNING every 30 Hz tick once
    // we have looked. A device that was created and then deleted by the producer stays
    // deleted — republishing it under them would be the wrong kind of helpful.
    if (keyboardDeviceEnsured_) return nullptr;
    keyboardDeviceEnsured_ = true;

    // createVirtualMidiDevice persists the name in engine property storage and rescans,
    // so this happens once per install rather than once per launch. A failure (the name
    // is somehow taken) is not worth an error: the keyboard still auditions, it just
    // cannot be recorded, and cmdAuditionNote says so through `recordable`.
    dm.createVirtualMidiDevice (kKeyboardDeviceName);
    return find();
}

te::MidiInputDevice* MoshOps::armedMidiInputFor (te::AudioTrack& track)
{
    for (auto* inst : eng.edit().getAllInputDevices())
        if (inst != nullptr
            && te::isOnTargetTrack (*inst, track, 0)
            && inst->isRecordingEnabled (track.itemID))
        {
            auto& dev = inst->getInputDevice();
            if (dev.isMidi())
                return dynamic_cast<te::MidiInputDevice*> (&dev);
        }
    return nullptr;
}

// ── the command ──────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdAuditionNote (const juce::var& args)
{
    auto* track = findTrack (args.getProperty ("trackId", var()).toString());
    if (track == nullptr) return errResult ("audition_note", "no track");

    if (! args.hasProperty ("pitch")) return errResult ("audition_note", "missing 'pitch'");
    const int pitch    = juce::jlimit (0, 127, (int) args.getProperty ("pitch", 60));
    const int velocity = juce::jlimit (1, 127, (int) args.getProperty ("velocity", 100));
    const int channel  = juce::jlimit (1,  16, (int) args.getProperty ("channel", 1));

    const auto action = args.getProperty ("action", "blip").toString();
    if (action != "on" && action != "off" && action != "blip")
        return errResult ("audition_note", "action must be 'on', 'off' or 'blip'");

    const int blipMs = juce::jlimit (kBlipMinMs, kBlipMaxMs,
                                     (int) args.getProperty ("durationMs", kBlipDefaultMs));

    auto* data = new DynamicObject();
    data->setProperty ("trackId", track->itemID.toString());
    data->setProperty ("pitch", pitch);
    data->setProperty ("action", action);

    auto reply = [&] (bool audible, const char* path, const juce::String& reason = {})
    {
        data->setProperty ("audible", audible);
        data->setProperty ("path", path);
        data->setProperty ("held", (int) heldVoices_.size());
        // REC-002 — only the "input" path can be captured or recorded. The caller is told
        // WHICH path fired rather than left to assume the three are equivalent: the
        // sampler path ignores velocity, and the inject path is invisible to recording.
        data->setProperty ("recordable", juce::String (path) == "input");
        if (reason.isNotEmpty()) data->setProperty ("reason", reason);
        return okResult ("audition_note", var (data));
    };

    const bool noteOn = (action != "off");

    // Voice bookkeeping runs FIRST and unconditionally — before the no-audio bail below,
    // and before the sampler fallback further down (which rebuilds the held set to decide
    // what to sound). Doing it even with no device costs nothing, keeps `held` meaningful
    // everywhere, and means this state machine — the only real logic in the command — is
    // provable in a headless --selftest instead of being invisible to it.
    const auto sameVoice = [&] (const HeldVoice& v)
    {
        return v.track == track->itemID && v.pitch == pitch && v.channel == channel;
    };
    heldVoices_.erase (std::remove_if (heldVoices_.begin(), heldVoices_.end(), sameVoice),
                       heldVoices_.end());
    if (noteOn)
        heldVoices_.push_back ({ track->itemID, pitch, channel,
                                 juce::Time::getMillisecondCounterHiRes(),
                                 action == "blip" ? (double) blipMs : heldTtlMs() });

    // Headless / no device: nothing below can sound, and saying so is the honest answer.
    // NOT an error — a keypress has done nothing wrong — and --selftest pins this exact
    // graceful shape, since it can never prove audibility itself.
    if (! eng.hasAudio())
        return reply (false, "none", "no audio device");

    eng.ensurePlaybackContext();   // no-op once allocated; never starts the transport

    const auto msg = noteOn ? juce::MidiMessage::noteOn  (channel, pitch, (juce::uint8) velocity)
                            : juce::MidiMessage::noteOff (channel, pitch);

    // REC-002 — an ARMED track takes the input path instead, so what you play on the
    // computer keyboard is recordable and reaches the buffer Capture reads. The engine
    // owns everything from here: timing, record latency, overdub merge, record-quantise.
    //
    // Deliberately gated on ARMED rather than taken always. Two reasons, and the second
    // is the load-bearing one:
    //   • Doubling. With the track armed, monitoring makes the input path audible; adding
    //     an inject on top would sound every note twice.
    //   • Blast radius. The unarmed path is the spine of three shipped surfaces — the
    //     piano roll's drag-audition, the drum pads, and the QWERTY keyboard on an idle
    //     track. None of them can regress from a change that cannot reach them, and none
    //     of their audibility is provable in a headless run.
    // It also matches Ableton, where the computer MIDI keyboard plays the armed track.
    ensureKeyboardInputDevice();
    if (auto* armedInput = armedMidiInputFor (*track))
    {
        armedInput->handleIncomingMidiMessage (msg, armedInput->getMPESourceID());
        return reply (true, "input");
    }

    // Cleared immediately before and read immediately after: the engine calls
    // warnOfWastedMidiMessages synchronously from inside this very call.
    wastedMidiFired_ = false;
    track->injectLiveMidiMessage (msg, kLiveSourceID);
    const bool reachedGraph = ! wastedMidiFired_;

    if (reachedGraph)
        return reply (true, "inject");

    // The clipless-track hole. A sampler can still be driven directly, which is what makes
    // drum pads previewable on a bare drum track. Velocity is NOT honoured on this path
    // (the engine hardcodes it), which is exactly why the caller is told WHICH path fired
    // rather than left to assume the two are equivalent.
    if (auto* sampler = findSampler (*track))
    {
        juce::BigInteger keys;
        for (auto& v : heldVoices_)
            if (v.track == track->itemID)
                keys.setBit (v.pitch);
        sampler->playNotes (keys);
        return reply (true, "sampler");
    }

    return reply (false, "none",
                  "the track has no clips, so the engine builds no live-MIDI node for it "
                  "— add a clip to play this instrument");
}

juce::var MoshOps::cmdAllNotesOff (const juce::var& args)
{
    const auto id = args.getProperty ("trackId", var()).toString();
    te::AudioTrack* only = nullptr;
    if (id.isNotEmpty())
    {
        only = findTrack (id);
        if (only == nullptr) return errResult ("all_notes_off", "no track");
    }

    const int released = releaseAllVoices (only);

    auto* data = new DynamicObject();
    data->setProperty ("released", released);
    data->setProperty ("held", (int) heldVoices_.size());
    return okResult ("all_notes_off", var (data));
}

// ── shared release path ──────────────────────────────────────────────────────────────
void MoshOps::releaseOneVoice (te::AudioTrack& track, int channel, int pitch)
{
    // REC-002 — the note-off MUST take the same road the note-on took. A note sounded
    // through the armed input and released through the inject path would leave the
    // engine's recorder holding an unmatched note-on: the take lands with a note that
    // never ends, and the producer's monitoring hangs. Re-resolving the armed input per
    // release (rather than remembering it on the HeldVoice) is deliberate — arming can
    // change while a key is held, and the CURRENT road is the one that will be listened to.
    const auto off = juce::MidiMessage::noteOff (channel, pitch);
    if (auto* armedInput = armedMidiInputFor (track))
    {
        armedInput->handleIncomingMidiMessage (off, armedInput->getMPESourceID());
        return;
    }
    track.injectLiveMidiMessage (off, kLiveSourceID);
}

int MoshOps::releaseAllVoices (te::AudioTrack* onlyThisTrack)
{
    const bool audio = eng.hasAudio();
    const auto wanted = [&] (const HeldVoice& v) -> te::AudioTrack*
    {
        auto* t = findTrack (v.track.toString());
        if (t == nullptr) return nullptr;
        if (onlyThisTrack != nullptr && t != onlyThisTrack) return nullptr;
        return t;
    };

    // 1. An explicit note-off per held voice, so a well-behaved instrument releases its
    //    envelope rather than being cut off. Snapshot first — the erase below mutates.
    int released = 0;
    const auto voices = heldVoices_;
    for (auto& v : voices)
        if (auto* t = wanted (v))
        {
            if (audio)
                releaseOneVoice (*t, v.channel, v.pitch);
            ++released;
        }

    heldVoices_.erase (std::remove_if (heldVoices_.begin(), heldVoices_.end(),
                                       [&] (const HeldVoice& v)
                                       {
                                           // Drop it if it belonged to a track we just
                                           // released, or to a track that no longer exists.
                                           return wanted (v) != nullptr
                                               || findTrack (v.track.toString()) == nullptr;
                                       }),
                       heldVoices_.end());

    // 2. A blanket all-notes-off per channel, and 3. the sampler's own — the ONLY thing
    //    that stops an open-ended one-shot, which ignores note-off by design.
    for (auto* t : te::getAudioTracks (eng.edit()))
    {
        if (t == nullptr) continue;
        if (onlyThisTrack != nullptr && t != onlyThisTrack) continue;
        if (audio)
            for (int ch = 1; ch <= 16; ++ch)
                t->injectLiveMidiMessage (juce::MidiMessage::allNotesOff (ch), kLiveSourceID);
        if (auto* sampler = findSampler (*t))
            sampler->allNotesOff();
    }

    return released;
}

void MoshOps::sweepStuckVoices()
{
    if (heldVoices_.empty()) return;

    const double now   = juce::Time::getMillisecondCounterHiRes();
    const bool   audio = eng.hasAudio();
    const auto   expired = [&] (const HeldVoice& v) { return now - v.startedMs > v.ttlMs; };

    // Collect first, release after — injecting can re-enter engine code, and the erase
    // below invalidates iterators either way.
    std::vector<HeldVoice> done;
    std::copy_if (heldVoices_.begin(), heldVoices_.end(), std::back_inserter (done), expired);
    if (done.empty()) return;

    for (auto& v : done)
        if (auto* t = findTrack (v.track.toString()))
            if (audio)
                releaseOneVoice (*t, v.channel, v.pitch);

    heldVoices_.erase (std::remove_if (heldVoices_.begin(), heldVoices_.end(), expired),
                       heldVoices_.end());
}

} // namespace mosh
