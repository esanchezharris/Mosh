// MOSHI-LOOP — the recording loop an iPhone in the live room and the desktop Booth
// both drive.
//
// THE MODEL, in the producer's words. You pick a track: that is the LEAD, and it holds
// the takes you decide to keep. Beneath it the loop makes a second track, "<lead> ·
// Takes", armed with the lead's input while the lead itself is un-armed — so every pass
// lands on TAKES and nothing you already kept is ever recorded over. One pass is one
// CONTRIBUTION: one wave clip, stamped with a stable id, labelled "Part N" by the order
// it was captured in.
//
// Then four buttons. PUT ME IN starts a pass at the listening start, with the project's
// normal count-in. KEEP finalizes the pass, moves the clip up onto LEAD, advances the
// listening start to just before the end of what you kept (the remembered lead-in), and
// immediately starts recording again — with NO count-in, because you are already singing
// and a pre-roll here is an interruption, not a courtesy. AGAIN rejects the pass instead:
// it stays on TAKES, muted, and the loop rewinds to that pass's own entry so the next
// attempt starts exactly where the last one did. REVIEW plays one pass back; PLAY ALL
// plays the whole arrangement from the listening start. Only the newest unkept pass is
// audible — everything older is muted on TAKES, so what you hear is always "the keepers
// plus the thing I just did".
//
// This is REAPER's loop-recording workflow, spelled as commands so a phone can drive it.
//
// UNDO POSTURE — the part that earns the file header.
//
//   • IDENTITY is not an edit. A pass id, its entry qn and its order are written ONCE
//     with a NULL UndoManager (state/Ids.h says so at each id). The phone is holding a
//     pass id on screen; an Undo that re-minted it would strand the take the producer is
//     pointing at.
//   • KEEP and AGAIN are edits. Each opens ONE transaction and writes moshLoopKeeper /
//     moshLoopRejected, the clip's mute and its track move through &undoManager(), so one
//     Cmd+Z puts a wrongly-rejected take back exactly as it was.
//   • The listening start, the lead-in and the last/review ids are PREFERENCES. They are
//     written with a null UndoManager and always AFTER the undoable writes of the same
//     command. Writing them first — or alone — is the G14 class this repo has been bitten
//     by: a transaction whose only content is a null-UM write is EMPTY, and the next Undo
//     then destroys the PREVIOUS edit instead. Preferences are honestly undoable:false.
//   • UNDO AFTER A FINALIZED KEEP IS TWO STEPS. Tracktion lands a recorded clip with the
//     Edit's own UndoManager, so loopFinalizeCapture() opens its own "loop_capture"
//     transaction before stopping — otherwise the landing would join whatever transaction
//     the previous command left at the head of the stack and one Undo would take both.
//     The consequence is deliberate and worth knowing at the console: after a Keep that
//     landed a real take, the first Undo reverses the keep (the clip goes back to TAKES,
//     un-kept) and the second reverses the capture (the clip goes away).
//
// HEADLESS. Every transport step degrades exactly the way cmdStopRecording does — ok,
// data.applied:false, a named reason, never an error — because a producer who pressed
// Record with no interface plugged in has done nothing wrong. The parts that are not the
// transport (the track pairing, the keeper/rejected edit, the listening arithmetic) still
// apply, which is what makes the loop provable in --selftest.
//
// WHAT `applied` MEANS, exactly: the command's PRIMARY effect landed. The phone turns
// applied:false into a REJECTED receipt, so the field has to answer "did the thing I
// pressed happen?" and nothing else.
//   • loop_record / loop_hear / loop_play_all, and Keep's resume branch, exist ONLY to
//     move the transport. Nothing rolled ⇒ applied:false + reason, which is honest.
//   • loop_keep and loop_again primarily EDIT A CLIP — the keeper moves up to LEAD, the
//     reject is muted on TAKES — and only then try to roll again. Once that edit has
//     committed, the button did what it said, so applied is TRUE even with no interface
//     in the building. The restart is reported separately as `restarted`, with its reason
//     folded into `detail` ("Kept Part 2; recording did not restart: no audio device").
//     Reporting those as rejected would tell the producer their keep did not happen while
//     the clip sat on the lead track, which is the worst lie this surface can tell.
//
// AUTHORITY. The phone echoes back a fingerprint of everything it had on screen when the
// producer chose. If the Mac has moved on, the request targets a state nobody saw, so it
// is refused BEFORE any mutation (mosh::phoneloop::compatibleAuthority). Stop is
// deliberately looser — the panic button has to survive the state moving under the user.
// Desktop callers omit the field entirely and are never gated.

#include "MoshOps.h"
#include "MoshOpsInternal.h"
#include "RecordingLanding.h"
#include "state/Ids.h"
#include "remote/PhoneLoopProtocol.h"

#include <algorithm>
#include <cmath>
#include <vector>

namespace mosh
{
using namespace juce;

namespace
{
/** Defaults for the two dials. 8 quarter notes is two bars of 4/4 — enough run-up to
    breathe in and land on the beat, which is what a producer punching in actually needs. */
constexpr double kLoopDefaultLeadQn = 8.0;
constexpr double kLoopMaxLeadQn     = 256.0;
constexpr int    kLoopMaxBar        = 1000000;
/** How long after its last poll the pad still counts as attached. Three seconds is four
    missed polls at the pad's own cadence — long enough to ride a Wi-Fi hiccup. */
constexpr double kLoopPhoneWindowMs = 3000.0;

const char* const kLoopStaleAuthority = "Recording state changed; refresh before choosing a target.";
const char* const kLoopNoTarget       = "Selected contribution is no longer available";
const char* const kLoopNotEngaged     = "Pick a track on the Mac first";

/** A missing project property reads back as its default rather than as a hole: a fresh
    project must render the loop cold, not render it wrong. */
double loopPrefDouble (const juce::ValueTree& node, const juce::Identifier& id, double fallback)
{
    return node.hasProperty (id) ? (double) node.getProperty (id) : fallback;
}

juce::var optionalId (const juce::String& id)
{
    return id.isNotEmpty() ? juce::var (id) : juce::var();
}

/** True when a live input instance targets this track AND is record-enabled. Always false
    headless (getAllInputDevices() is empty without a playback context), which is why
    loop_setup falls through to the project's stored lead rather than refusing there. */
bool trackIsArmed (te::Edit& edit, te::AudioTrack& track)
{
    for (auto* instance : edit.getAllInputDevices())
        if (instance != nullptr
            && te::isOnTargetTrack (*instance, track, 0)
            && instance->isRecordingEnabled (track.itemID))
            return true;
    return false;
}

/** A one-line args object for the sub-commands loop_setup composes. */
juce::var objectOf (std::initializer_list<std::pair<const char*, juce::var>> fields)
{
    auto* object = new juce::DynamicObject();
    for (auto& field : fields)
        object->setProperty (field.first, field.second);
    return juce::var (object);
}
} // namespace

// ── resolution ───────────────────────────────────────────────────────────────────────
te::AudioTrack* MoshOps::loopLeadTrack()
{
    auto node = eng.edit().state.getChildWithName (ids::MOSH_PROJECT);
    return findTrack (node.getProperty (ids::loopLeadTrackId, var()).toString());
}

te::AudioTrack* MoshOps::loopTakesTrack()
{
    auto node = eng.edit().state.getChildWithName (ids::MOSH_PROJECT);
    return findTrack (node.getProperty (ids::loopTakesTrackId, var()).toString());
}

te::Clip* MoshOps::loopFindContribution (const juce::String& passId)
{
    if (passId.isEmpty())
        return nullptr;

    for (auto* track : te::getAudioTracks (eng.edit()))
        if (track != nullptr)
            for (auto* clip : track->getClips())
                if (clip != nullptr
                    && clip->state.getProperty (ids::moshLoopPassId, var()).toString() == passId)
                    return clip;
    return nullptr;
}

// ── time ─────────────────────────────────────────────────────────────────────────────
double MoshOps::loopQnToSeconds (double qn)
{
    return eng.edit().tempoSequence.toTime (tracktion::BeatPosition::fromBeats (qn)).inSeconds();
}

double MoshOps::loopSecondsToQn (double seconds)
{
    return eng.edit().tempoSequence.toBeats (tracktion::TimePosition::fromSeconds (seconds)).inBeats();
}

int MoshOps::loopQnToBar (double qn)
{
    // Bars are 1-based EVERYWHERE the producer can see them — the pad's stepper, the
    // Booth's readout, the receipt text — while the engine counts from 0.
    return eng.edit().tempoSequence.toBarsAndBeats (
               tracktion::TimePosition::fromSeconds (loopQnToSeconds (qn))).bars + 1;
}

double MoshOps::loopBarToQn (int bar)
{
    tracktion::tempo::BarsAndBeats at;
    at.bars = bar - 1;
    return eng.edit().tempoSequence.toBeats (eng.edit().tempoSequence.toTime (at)).inBeats();
}

// ── identity: adopting a clip the loop has not seen before ───────────────────────────
void MoshOps::loopAdoptUnstampedClips()
{
    auto* lead  = loopLeadTrack();
    auto* takes = loopTakesTrack();
    if (lead == nullptr || takes == nullptr)
        return;

    // Read off the raw node (which may not exist yet) and only WRITE through
    // projectSettingsTree() if something was actually adopted — the pad polls this two or
    // three times a second, and a poll should not keep touching the Edit tree.
    int order = (int) eng.edit().state.getChildWithName (ids::MOSH_PROJECT)
                          .getProperty (ids::loopPassCounter, 0);
    const int orderAtEntry = order;

    // Precedent: mosh::takeidentity::backfill (cmdStopRecording). A wave clip sitting on
    // LEAD or TAKES is something the producer put there — a hand-dragged reference, a
    // take from before the loop was set up, a clip restored by Undo — and the loop can
    // only talk about it if it has a name. Null UndoManager: naming is not an edit.
    for (auto* track : { lead, takes })
        for (auto* clip : track->getClips())
            if (auto* wave = dynamic_cast<te::WaveAudioClip*> (clip))
                if (! wave->state.hasProperty (ids::moshLoopPassId))
                {
                    wave->state.setProperty (ids::moshLoopPassId, juce::Uuid().toDashedString(), nullptr);
                    wave->state.setProperty (ids::moshLoopEntryQn,
                                             loopSecondsToQn (wave->getPosition().getStart().inSeconds()), nullptr);
                    wave->state.setProperty (ids::moshLoopOrder, ++order, nullptr);
                }

    if (order != orderAtEntry)
        projectSettingsTree().setProperty (ids::loopPassCounter, order, nullptr);
}

// ── the state the phone polls ────────────────────────────────────────────────────────
juce::var MoshOps::loopStateVar()
{
    // READ-ONLY by contract: snapshot() embeds this, and every command fingerprints it
    // for the authority handshake before deciding whether to mutate. getChildWithName
    // returns an INVALID tree when the node is absent, and hasProperty on an invalid tree
    // is false — so a project that has never seen the loop reads its defaults without
    // this read quietly creating the node.
    auto node = eng.edit().state.getChildWithName (ids::MOSH_PROJECT);
    auto* lead  = loopLeadTrack();
    auto* takes = loopTakesTrack();
    const bool engaged = lead != nullptr && takes != nullptr;

    auto& transport = eng.edit().getTransport();
    const bool recording = transport.isRecording();
    const bool playing   = transport.isPlaying();

    auto* transportOut = new DynamicObject();
    transportOut->setProperty ("recording", recording);
    transportOut->setProperty ("playing", playing);
    transportOut->setProperty ("positionSec", transport.getPosition().inSeconds());

    const double listeningQn = loopPrefDouble (node, ids::loopListeningQn, 0.0);
    const double leadQn      = loopPrefDouble (node, ids::loopLeadQn, kLoopDefaultLeadQn);

    auto* listening = new DynamicObject();
    listening->setProperty ("qn", listeningQn);
    listening->setProperty ("bar", loopQnToBar (listeningQn));
    // Absent means "no pass has entered yet", which the pad renders differently from
    // "enters at zero" — so it stays a JSON null rather than collapsing to 0.
    listening->setProperty ("entryQn", node.hasProperty (ids::loopEntryQn)
                                           ? var ((double) node.getProperty (ids::loopEntryQn)) : var());
    listening->setProperty ("leadQn", leadQn);

    // Contributions, in CAPTURE order — which is what "Part N" means. Sorting by order
    // rather than by position is deliberate: a producer who drags a take earlier on the
    // timeline has not renumbered their own history.
    struct Entry { int order; te::Clip* clip; };
    std::vector<Entry> found;
    if (engaged)
        for (auto* track : { lead, takes })
            for (auto* clip : track->getClips())
                if (clip != nullptr && clip->state.hasProperty (ids::moshLoopPassId))
                    found.push_back ({ (int) clip->state.getProperty (ids::moshLoopOrder, 0), clip });

    std::sort (found.begin(), found.end(),
               [] (const Entry& a, const Entry& b) { return a.order < b.order; });

    Array<var> contributions;
    int partNumber = 0;
    for (auto& entry : found)
    {
        auto& clip = *entry.clip;
        const auto position = clip.getPosition();
        auto* out = new DynamicObject();
        out->setProperty ("id", clip.state.getProperty (ids::moshLoopPassId, var()).toString());
        out->setProperty ("clipId", clip.itemID.toString());
        out->setProperty ("trackId", clip.getTrack() != nullptr ? clip.getTrack()->itemID.toString() : String());
        out->setProperty ("label", "Part " + String (++partNumber));
        out->setProperty ("keeper", (bool) clip.state.getProperty (ids::moshLoopKeeper, false));
        out->setProperty ("rejected", (bool) clip.state.getProperty (ids::moshLoopRejected, false));
        out->setProperty ("entryQn", (double) clip.state.getProperty (ids::moshLoopEntryQn, 0.0));
        out->setProperty ("startQn", loopSecondsToQn (position.getStart().inSeconds()));
        out->setProperty ("endQn", loopSecondsToQn (position.getEnd().inSeconds()));
        contributions.add (var (out));
    }

    auto* state = new DynamicObject();
    state->setProperty ("projectId", agentProjectId());
    state->setProperty ("host", loopHostEpoch_);
    state->setProperty ("engaged", engaged);
    state->setProperty ("leadTrackId", engaged ? lead->itemID.toString() : String());
    state->setProperty ("takesTrackId", engaged ? takes->itemID.toString() : String());
    state->setProperty ("transport", var (transportOut));
    state->setProperty ("phase",
        ! engaged                                                             ? "setup_required"
      : recording && transport.getPosition().inSeconds() < loopQnToSeconds (loopCurrent_.entryQn)
                                                                              ? "count_in"
      : recording                                                             ? "recording"
      : playing && loopAuditionedId_.isNotEmpty()                             ? "auditioning"
      : playing                                                               ? "playing"
                                                                              : "idle");
    state->setProperty ("listening", var (listening));
    // Only while it is actually recording: a stop that bypassed the finalize (export, a loop
    // toggle) leaves loopCurrent_ set until the next command forgets it, and the Booth must not
    // claim a pass is in flight in between. A pure read -- loopForgetStaleCapture clears it.
    state->setProperty ("currentId", loopCurrentIdVar());
    state->setProperty ("lastId", optionalId (node.getProperty (ids::loopLastId, var()).toString()));
    state->setProperty ("reviewId", optionalId (node.getProperty (ids::loopReviewId, var()).toString()));
    state->setProperty ("auditionedId", optionalId (loopAuditionedId_));
    state->setProperty ("contributions", contributions);
    // The ANSWER, not the evidence. `phoneSeenMs` is a juce::Time::getMillisecondCounterHiRes
    // reading — milliseconds since this Mac booted — so a UI that compares it to its own
    // Date.now() epoch clock is subtracting two unrelated numbers and will never see a
    // phone. Only this side owns a clock the stamp is comparable to, so this side decides.
    // The stamp stays for diagnostics (and for the same-process native selftest).
    state->setProperty ("phoneConnected", loopPhoneConnected_);
    state->setProperty ("phoneSeenMs", loopPhoneSeenMs_);
    // The one thing the pad cannot work out for itself: whether this Mac can record at
    // all right now. It renders this verbatim above the buttons.
    state->setProperty ("blockReason", eng.audioReady()
                                           ? String()
                                           : String (juce::CharPointer_UTF8 ("No audio device \xe2\x80\x94 recording is unavailable on this Mac")));
    return var (state);
}

void MoshOps::loopRefreshPhonePresence (bool polled)
{
    const double now = juce::Time::getMillisecondCounterHiRes();
    if (polled)
        loopPhoneSeenMs_ = now;

    // A zero stamp means the pad has NEVER polled, which is not the same as "polled a
    // long time ago" — on a Mac that has just booted, `now` itself is small enough that
    // the subtraction alone would report a phone that is not there.
    const bool connected = loopPhoneSeenMs_ > 0.0 && (now - loopPhoneSeenMs_) < kLoopPhoneWindowMs;
    if (connected == loopPhoneConnected_)
        return;   // the common case: a poll every 200 ms (5 Hz) changes nothing

    // Only the EDGE is an event. Emitting per poll would push a full loop payload and a
    // snapshot re-pull five times a second for the life of the session — the same mistake
    // the live-note audition path exists to avoid.
    //
    // THIS CONVERGES, including from snapshot(). snapshot() calls this before embedding
    // the loop block, so an edge found there emits — and emitSnapshotInvalidated() makes
    // the UI re-pull the snapshot, which calls this again. That second pass finds
    // `connected == loopPhoneConnected_` (the flag was written before the emit) and
    // returns at the line above, so the cycle is exactly one extra read deep and stops.
    // The ordering below is what makes that true: assign FIRST, emit second.
    loopPhoneConnected_ = connected;
    emit ("loop", loopStateVar());
    emitSnapshotInvalidated();
}

// ── the authority handshake ──────────────────────────────────────────────────────────
juce::String MoshOps::loopAuthorityRefusal (const juce::String& command, const juce::var& args)
{
    // ABSENT, not empty: a desktop caller sends no authority at all and is never gated,
    // while a phone that sends "" is claiming it saw a state nobody could have had.
    if (! args.hasProperty ("authority"))
        return {};

    const auto observed = args.getProperty ("authority", var()).toString();
    return phoneloop::compatibleAuthority (observed, loopStateVar(), command == "loop_stop")
               ? String() : String (kLoopStaleAuthority);
}

// ── capture lifecycle ────────────────────────────────────────────────────────────────
bool MoshOps::loopStartCapture (double startQn, bool bypassCountIn, juce::String& reason)
{
    auto& transport = eng.edit().getTransport();

    // Looping OFF, always. A WaveInputDevice adds a landed pass as a TAKE inside the clip
    // it fell on when the transport is looping — which is exactly the lane model this
    // loop replaces, and it would make every pass invisible to loop_state.
    // Written only when it differs, so a no-op never reaches the Edit's undo manager.
    if (transport.looping)
        transport.looping = false;

    if (! eng.audioReady())
    {
        // Mint nothing: a pass id handed out for a capture that never rolled would be a
        // contribution the phone can select and the Mac cannot find.
        reason = "no audio device";
        return false;
    }

    // Keep and Again pass bypassCountIn: the producer never stopped playing, so a pre-roll
    // would be an interruption. TransportControl::performRecord reads getNumCountInBeats
    // SYNCHRONOUSLY inside record(), so the override is set here and restored immediately
    // after the call — the stored project preference is never changed.
    if (bypassCountIn)
        eng.edit().setCountInMode (te::Edit::CountIn::none);
    else
        applyCountInToEdit();

    applyRecordOptionsToDevices();
    eng.ensurePlaybackContext();

    // REC-NO-INPUT (cmdSetTransport's record branch): refuse a record that can capture
    // NOTHING rather than sit inert. Same sentence, deliberately — a producer who has hit
    // this from the transport bar should read the same words from the phone.
    bool anyRecordActive = false;
    for (auto* instance : eng.edit().getAllInputDevices())
        if (instance != nullptr && instance->isRecordingActive())
        {
            anyRecordActive = true;
            break;
        }

    if (! anyRecordActive)
    {
        applyCountInToEdit();
        reason = juce::String (juce::CharPointer_UTF8 ("no armed track with a usable input \xe2\x80\x94 arm a track and pick an input in Settings > Audio"));
        return false;
    }

    const double startSec = loopQnToSeconds (startQn);
    transport.setPosition (tracktion::TimePosition::fromSeconds (startSec));
    insertMarkerSec = startSec;      // a stop returns the playhead to where the pass began
    transport.record (false);
    applyCountInToEdit();            // restore the project's own pre-roll for the next start

    loopCurrent_ = { juce::Uuid().toDashedString(), startQn, true };
    loopAuditionedId_.clear();
    return true;
}

bool MoshOps::loopStartPlayback (double startQn, juce::String& reason)
{
    auto& transport = eng.edit().getTransport();
    if (transport.looping)
        transport.looping = false;

    if (! eng.audioReady())
    {
        reason = "no audio device";
        return false;
    }

    eng.ensurePlaybackContext();
    const double startSec = loopQnToSeconds (startQn);
    transport.setPosition (tracktion::TimePosition::fromSeconds (startSec));
    insertMarkerSec = startSec;
    transport.play (false);
    return true;
}

juce::var MoshOps::loopCurrentIdVar()
{
    // The one gate for every place that names the capture in flight: snapshot.loop,
    // loop_state and the loop_record / loop_keep / loop_again results. A start that did not
    // roll (no input, no device) leaves a pass that some bypassed stop ended still sitting
    // in loopCurrent_; a result that named it would mark "Not recording: ..." as rolling
    // while the snapshot shows no pass (review of PR #730, round 3).
    return loopCurrent_.active && eng.edit().getTransport().isRecording() ? var (loopCurrent_.passId) : var();
}

bool MoshOps::loopForgetStaleCapture()
{
    if (! loopCurrent_.active || eng.edit().getTransport().isRecording())
        return false;
    loopCurrent_ = {};
    return true;
}

MoshOps::LoopFinalized MoshOps::loopFinalizeCapture (const juce::var& stopArgs)
{
    LoopFinalized out;
    if (! loopCurrent_.active)
        return out;

    const auto passId    = loopCurrent_.passId;
    const double entryQn = loopCurrent_.entryQn;
    out.passId = passId;

    // A FRESH transaction before stopping. Tracktion inserts the landed clip with the
    // Edit's own UndoManager, so without this the landing joins whatever transaction the
    // previous command left at the head of the stack and one Undo would take both. When
    // nothing lands the transaction stays empty, which JUCE never pushes — so a stop
    // during the count-in leaves the undo history exactly as it found it.
    //
    // stopRecordingAndLand, NOT cmdStopRecording: the latter is what routes a TopBar stop
    // HERE while a pass is in flight, so calling it would come straight back.
    beginTxn ("loop_capture");
    const auto stopArgsObject = stopArgs.isObject() ? stopArgs : var (new DynamicObject());
    const auto stopped = stopRecordingAndLand (stopArgsObject,
                                               (bool) stopArgsObject.getProperty ("discardRecordings", false));
    out.stopResult = stopped;
    loopCurrent_ = {};

    auto* takes = loopTakesTrack();
    if (takes == nullptr)
        return out;

    int order = (int) eng.edit().state.getChildWithName (ids::MOSH_PROJECT)
                          .getProperty (ids::loopPassCounter, 0);

    const auto data  = stopped.getProperty ("data", var());
    const auto clips = data.getProperty ("clips", var());   // bound: getArray() on a temporary dangles
    if (auto* landed = clips.getArray())
        for (auto& landedClip : *landed)
            if (auto* clip = findClip (landedClip.getProperty ("id", var()).toString()))
                if (clip->getTrack() == takes)
                {
                    // Identity, null UndoManager — see the file header. The entry is the
                    // qn the capture STARTED at, not where the clip happens to sit: a
                    // latency adjustment moves the clip by milliseconds, not the punch.
                    // (The count-in pre-roll no longer moves it: cmdStopRecording trims a
                    // landed clip to the punch-in — RecordingLanding.h, 2026-09-19.)
                    clip->state.setProperty (ids::moshLoopPassId, passId, nullptr);
                    clip->state.setProperty (ids::moshLoopEntryQn, entryQn, nullptr);
                    clip->state.setProperty (ids::moshLoopOrder, ++order, nullptr);
                    out.clipId = clip->itemID.toString();
                    out.landed = true;
                }

    if (! out.landed)
        return out;   // a stop during the count-in: no contribution, nothing written

    auto node = projectSettingsTree();
    node.setProperty (ids::loopPassCounter, order, nullptr);

    // "Only the newest unkept pass is audible." Undoable, in this same transaction, so an
    // Undo of the capture brings the previous pass back audible with it. Keepers and
    // already-rejected passes are left alone — the producer decided about those.
    for (auto* clip : takes->getClips())
        if (clip != nullptr
            && clip->state.hasProperty (ids::moshLoopPassId)
            && clip->state.getProperty (ids::moshLoopPassId, var()).toString() != passId
            && ! (bool) clip->state.getProperty (ids::moshLoopKeeper, false)
            && ! (bool) clip->state.getProperty (ids::moshLoopRejected, false)
            && ! clip->isMuted())
            clip->setMuted (true);

    // Preferences LAST (the G14 rule): the transaction above already carries the landing
    // and the mutes, so these null-UM writes can never be its only content.
    node.setProperty (ids::loopLastId, passId, nullptr);
    node.setProperty (ids::loopReviewId, passId, nullptr);
    return out;
}

// ── shared result / refusal plumbing ─────────────────────────────────────────────────
juce::var MoshOps::loopOk (const juce::String& command, juce::DynamicObject* data,
                           const juce::String& actionId, const juce::String& detail)
{
    // Every loop result carries these two. actionId is what the phone's receipt ledger
    // keys on, and detail is the one sentence it shows — never a code the producer has to
    // interpret while holding a microphone.
    data->setProperty ("actionId", actionId);
    data->setProperty ("detail", detail);
    return okResult (command, var (data));
}

juce::String MoshOps::loopActionId (const juce::var& args)
{
    // The phone's own request id when it sent one, so a retried POST and the receipt it
    // gets back describe the SAME action; a fresh id for a desktop press.
    const auto requestId = args.getProperty ("requestId", var()).toString();
    return requestId.isNotEmpty() ? requestId : juce::Uuid().toDashedString();
}

juce::String MoshOps::loopLabelFor (const juce::String& passId)
{
    const auto state = loopStateVar();
    const auto contributions = state.getProperty ("contributions", var());   // bound, not a temporary
    if (auto* parts = contributions.getArray())
        for (auto& part : *parts)
            if (part.getProperty ("id", var()).toString() == passId)
                return part.getProperty ("label", var()).toString();
    return "that take";
}

juce::String MoshOps::loopMovingRefusal()
{
    // Moving the listening start under a rolling transport would relocate the thing the
    // producer is listening to mid-sentence. Both cursor commands are stopped-only.
    auto& transport = eng.edit().getTransport();
    return transport.isRecording() || transport.isPlaying()
               ? String ("Stop before changing the listening start") : String();
}

juce::var MoshOps::loopWriteCursor (const juce::String& command, const juce::var& args,
                                    const juce::var& listeningQn, const juce::var& leadQn)
{
    // The one write path for all three cursor commands, and the cmdSetCountIn template
    // exactly: validate (done by the caller), write to MOSH_PROJECT with a NULL
    // UndoManager, markDirty, log undoable:false, emit. No transaction — none of this is
    // a session edit, and a transaction here would be an empty one (the G14 class).
    //
    // A VOID argument means "leave that one alone". loop_lead_in changes how much run-up
    // the NEXT pass gets, which is not a move: writing the cursor there would silently
    // stamp an entry onto a project where no pass has happened yet, and jog a playhead the
    // producer did not ask to move.
    auto node = projectSettingsTree();
    if (! listeningQn.isVoid())
    {
        node.setProperty (ids::loopListeningQn, (double) listeningQn, nullptr);
        node.setProperty (ids::loopEntryQn, (double) listeningQn, nullptr);

        // A stopped playhead follows the cursor, so the Mac in front of the producer's
        // collaborator shows what the phone just chose.
        auto& transport = eng.edit().getTransport();
        if (! transport.isRecording() && ! transport.isPlaying())
        {
            const double startSec = loopQnToSeconds ((double) listeningQn);
            transport.setPosition (tracktion::TimePosition::fromSeconds (startSec));
            insertMarkerSec = startSec;
        }
    }
    if (! leadQn.isVoid())
        node.setProperty (ids::loopLeadQn, (double) leadQn, nullptr);

    eng.markDirty();
    logLine (command, args, true, {}, false);   // preference — NOT undoable
    emitSnapshotInvalidated();
    emit ("loop", loopStateVar());

    const double cursorQn = loopPrefDouble (node, ids::loopListeningQn, 0.0);
    auto* listening = new DynamicObject();
    listening->setProperty ("bar", loopQnToBar (cursorQn));
    listening->setProperty ("qn", cursorQn);
    listening->setProperty ("leadQn", loopPrefDouble (node, ids::loopLeadQn, kLoopDefaultLeadQn));

    auto* data = new DynamicObject();
    data->setProperty ("listening", var (listening));
    return loopOk (command, data, loopActionId (args),
                   "Listening from bar " + String (loopQnToBar (cursorQn)));
}

// ── loop_state ───────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdLoopState (const juce::var& args)
{
    // A READ: no transaction, no JSONL line (the pad polls this every 200 ms — 5 Hz, see
    // the pad controller's poll timer — so logging it would bury every real command in the
    // console within a minute). The one thing it writes is IDENTITY for clips it has not
    // seen before, with a null UndoManager, which is naming rather than editing.
    //
    // DELIBERATELY UNGATED BY AUTHORITY. Every other loop_* command runs
    // loopAuthorityRefusal() first; this one does not, because it is the read the phone
    // uses to LEARN the current authority. Gating it would make a phone that has fallen
    // out of date unable to ever find out what it fell out of date with.
    loopAdoptUnstampedClips();
    loopRefreshPhonePresence ((bool) args.getProperty ("phonePoll", false));
    return okResult ("loop_state", loopStateVar());
}

// ── loop_setup ───────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdLoopSetup (const juce::var& args)
{
    static const char* const kName = "loop_setup";
    if (const auto refusal = loopAuthorityRefusal (kName, args); refusal.isNotEmpty())
        return errResult (kName, refusal);

    const auto actionId = loopActionId (args);
    auto node = eng.edit().state.getChildWithName (ids::MOSH_PROJECT);
    const auto storedLead  = node.getProperty (ids::loopLeadTrackId, var()).toString();
    const auto storedTakes = node.getProperty (ids::loopTakesTrackId, var()).toString();

    // Which track is the LEAD? The explicit pick wins; then the single armed audio track
    // (the producer has already told the Mac where they are singing); then the one this
    // project used last. Three tries and then an honest refusal — guessing between two
    // armed tracks would put the loop on the wrong one silently.
    const auto wanted = args.getProperty ("trackId", var()).toString();
    te::AudioTrack* lead = wanted.isNotEmpty() ? findTrack (wanted) : nullptr;
    if (wanted.isNotEmpty() && lead == nullptr)
        return errResult (kName, "no track: " + wanted);

    if (lead == nullptr)
    {
        te::AudioTrack* onlyArmed = nullptr;
        int armedCount = 0;
        for (auto* track : te::getAudioTracks (eng.edit()))
            if (track != nullptr && trackIsArmed (eng.edit(), *track))
            {
                onlyArmed = track;
                ++armedCount;
            }
        lead = armedCount == 1 ? onlyArmed : findTrack (storedLead);
    }

    if (lead == nullptr)
        return errResult (kName, kLoopNotEngaged);

    // The takes track is the loop's own scratch lane. Promoting it to LEAD would make the
    // keepers and the rejects the same track and there would be no way back.
    if (lead->itemID.toString() == storedTakes)
        return errResult (kName, juce::String (juce::CharPointer_UTF8 ("That is the takes track \xe2\x80\x94 pick the track you are singing onto")));

    auto* takes = findTrack (storedTakes);
    const bool alreadyPaired = takes != nullptr && storedLead == lead->itemID.toString();

    bool created = false;
    if (! alreadyPaired)
    {
        beginTxn (kName);
        takes = createAudioTrack (lead->getName() + juce::String (juce::CharPointer_UTF8 (" \xc2\xb7 Takes")));
        if (takes == nullptr)
        {
            logLine (kName, args, false, "insert failed", true);
            return errResult (kName, "insert failed");
        }

        // Directly under the lead, INSIDE this transaction. Tracktion's own deferred
        // sort runs through the UndoManager on the next message pump, and a track that
        // moves later is a phantom undo step sitting between the producer and their
        // last real edit.
        eng.edit().moveTrack (takes, te::TrackInsertPoint (*lead, /*insertBefore=*/ false));
        ensureTrackMeter (*takes);   // METER-001 — every track-creation path self-meters

        // The captured input must be the one the producer already chose for the lead.
        // Non-undoable preferences (cmdSetTrackInput's posture), written AFTER the
        // undoable insert above so this transaction is never a null-UM-only one.
        for (auto& pref : { ids::moshInputDevice, ids::moshInputDeviceKind })
            if (lead->state.hasProperty (pref))
                takes->state.setProperty (pref, lead->state.getProperty (pref), nullptr);

        created = true;
    }

    // Re-pointing the loop at a different lead leaves the OLD takes track behind — it
    // holds real recorded audio, so it is never deleted. It must not stay record-enabled:
    // two armed tracks capture the same input twice, and the copy on the abandoned lane
    // is never stamped and never shows up in loop_state. An invisible duplicate recording
    // is exactly the class of silent failure this surface exists to remove.
    if (auto* previousTakes = findTrack (storedTakes); previousTakes != nullptr && previousTakes != takes)
        cmdArmTrack (objectOf ({ { "trackId", previousTakes->itemID.toString() }, { "armed", false } }));

    // Arm TAKES, un-arm LEAD: the whole point of the pairing is that a new pass can never
    // land on top of something already kept. Both log their own JSONL line, the same way
    // cmdSetTransport lets cmdStopRecording log its own.
    const auto armed = cmdArmTrack (objectOf ({ { "trackId", takes->itemID.toString() }, { "armed", true } }));
    cmdArmTrack (objectOf ({ { "trackId", lead->itemID.toString() }, { "armed", false } }));

    auto prefs = projectSettingsTree();
    prefs.setProperty (ids::loopLeadTrackId, lead->itemID.toString(), nullptr);
    prefs.setProperty (ids::loopTakesTrackId, takes->itemID.toString(), nullptr);
    eng.markDirty();

    logLine (kName, args, true, {}, false);   // the PAIRING is a preference; the insert undoes on its own
    emitSnapshotInvalidated();
    emit ("loop", loopStateVar());

    auto* data = new DynamicObject();
    data->setProperty ("leadTrackId", lead->itemID.toString());
    data->setProperty ("takesTrackId", takes->itemID.toString());
    data->setProperty ("created", created);
    data->setProperty ("armed", (bool) armed.getProperty ("data", var()).getProperty ("applied", false));
    return loopOk (kName, data, actionId,
                   created ? juce::String (juce::CharPointer_UTF8 ("Ready \xe2\x80\x94 takes land on \"")) + takes->getName() + "\""
                           : "Already set up on \"" + lead->getName() + "\"");
}

// ── loop_record ──────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdLoopRecord (const juce::var& args)
{
    static const char* const kName = "loop_record";
    if (const auto refusal = loopAuthorityRefusal (kName, args); refusal.isNotEmpty())
        return errResult (kName, refusal);

    const auto actionId = loopActionId (args);

    // Put Me In on a project that was never set up is still Put Me In: do the setup the
    // producer would otherwise have had to walk over to the Mac for.
    if (loopLeadTrack() == nullptr || loopTakesTrack() == nullptr)
    {
        const auto setup = cmdLoopSetup (args);
        if (! (bool) setup.getProperty ("ok", false))
            return setup;
    }
    if (loopLeadTrack() == nullptr || loopTakesTrack() == nullptr)
        return errResult (kName, kLoopNotEngaged);

    auto& transport = eng.edit().getTransport();
    if (transport.isRecording())
        return errResult (kName, "Already recording");
    if (transport.isPlaying())
        return errResult (kName, "Stop first");

    auto node = eng.edit().state.getChildWithName (ids::MOSH_PROJECT);
    const double startQn = loopPrefDouble (node, ids::loopListeningQn, 0.0);

    juce::String reason;
    const bool applied = loopStartCapture (startQn, /*bypassCountIn=*/ false, reason);

    logLine (kName, args, true, {}, false);   // recording LIFECYCLE, never an undoable edit
    emitSnapshotInvalidated();                // loopCurrent_ rides the snapshot's loop.currentId
    emit ("transport", transportToVar());
    emit ("loop", loopStateVar());

    auto* data = new DynamicObject();
    data->setProperty ("applied", applied);
    if (! applied) data->setProperty ("reason", reason);
    data->setProperty ("currentId", loopCurrentIdVar());
    data->setProperty ("entryQn", startQn);
    // The Booth and the phone show `detail` as-is, so it must never claim a take is
    // rolling when the transport never started (e.g. no audio device).
    return loopOk (kName, data, actionId,
                   applied ? "Recording from bar " + String (loopQnToBar (startQn))
                           : "Not recording: " + reason);
}

// ── loop_keep ────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdLoopKeep (const juce::var& args)
{
    static const char* const kName = "loop_keep";
    if (const auto refusal = loopAuthorityRefusal (kName, args); refusal.isNotEmpty())
        return errResult (kName, refusal);

    const auto actionId = loopActionId (args);
    const auto targetId = args.getProperty ("targetId", var()).toString();

    auto* lead = loopLeadTrack();
    if (lead == nullptr || loopTakesTrack() == nullptr)
        return errResult (kName, kLoopNotEngaged);

    auto& transport = eng.edit().getTransport();
    const bool wasRecording = transport.isRecording();

    // While a pass is being captured there is only one thing Keep can mean. Letting the
    // phone keep some OTHER take mid-capture would silently abandon the one being sung.
    if (wasRecording && targetId != loopCurrent_.passId)
        return errResult (kName, "During capture this control targets the current recording");
    if (! wasRecording && loopFindContribution (targetId) == nullptr)
        return errResult (kName, kLoopNoTarget);

    if (wasRecording)
    {
        const auto finalized = loopFinalizeCapture();
        if (! finalized.landed)
        {
            logLine (kName, args, false, "Nothing was captured", false);
            emit ("transport", transportToVar());
            emit ("loop", loopStateVar());
            return errResult (kName, "Nothing was captured");
        }
    }

    auto* clip = loopFindContribution (targetId);
    if (clip == nullptr)
        return errResult (kName, kLoopNoTarget);

    auto node = projectSettingsTree();
    juce::String reason;

    // Keep on a take that is ALREADY kept, with the transport stopped, is the producer
    // asking to go again from where they left off — not a second keep. No transaction:
    // nothing about the take changes.
    if (! wasRecording && (bool) clip->state.getProperty (ids::moshLoopKeeper, false))
    {
        const double resumeQn = loopPrefDouble (node, ids::loopListeningQn, 0.0);
        const bool applied = loopStartCapture (resumeQn, /*bypassCountIn=*/ false, reason);

        logLine (kName, args, true, {}, false);
        emitSnapshotInvalidated();   // loopCurrent_ rides the snapshot's loop.currentId
        emit ("transport", transportToVar());
        emit ("loop", loopStateVar());

        auto* data = new DynamicObject();
        data->setProperty ("keptId", targetId);
        data->setProperty ("clipId", clip->itemID.toString());
        data->setProperty ("listeningQn", resumeQn);
        data->setProperty ("currentId", loopCurrentIdVar());
        data->setProperty ("applied", applied);
        if (! applied) data->setProperty ("reason", reason);
        return loopOk (kName, data, actionId,
                       applied ? "Resumed recording from bar " + String (loopQnToBar (resumeQn))
                               : "Not recording: " + reason);
    }

    const auto label = loopLabelFor (targetId);
    const double endQn = loopSecondsToQn (clip->getPosition().getEnd().inSeconds());

    beginTxn (kName);
    if (clip->getTrack() != lead)
        clip->moveTo (*lead);
    clip->state.setProperty (ids::moshLoopKeeper, true, &undoManager());
    if ((bool) clip->state.getProperty (ids::moshLoopRejected, false))
        clip->state.setProperty (ids::moshLoopRejected, false, &undoManager());
    // A keeper is audible BY DEFINITION — that is what the lead track is. It may have
    // been muted as a superseded take or rejected outright; either way it comes back.
    if (clip->isMuted())
        clip->setMuted (false);

    // Preferences, AFTER the undoable writes above (the G14 rule in the file header).
    // max(): keeping an EARLIER take must never drag the loop backwards over ground the
    // producer has already covered.
    const double leadQn = loopPrefDouble (node, ids::loopLeadQn, kLoopDefaultLeadQn);
    const double listeningQn = juce::jmax (0.0,
                                   juce::jmax (loopPrefDouble (node, ids::loopListeningQn, 0.0),
                                               endQn - leadQn));
    node.setProperty (ids::loopListeningQn, listeningQn, nullptr);
    node.setProperty (ids::loopEntryQn, listeningQn, nullptr);
    node.setProperty (ids::loopLastId, targetId, nullptr);
    node.setProperty (ids::loopReviewId, targetId, nullptr);
    eng.markDirty();

    // Straight back in, with NO count-in: the producer is still singing.
    const bool restarted = loopStartCapture (listeningQn, /*bypassCountIn=*/ true, reason);

    logLine (kName, args, true, {}, true);
    emitSnapshotInvalidated();
    emit ("transport", transportToVar());
    emit ("loop", loopStateVar());

    // applied:true — the KEEP is what the producer pressed, and it has committed. Whether
    // the loop could roll again is a separate, secondary outcome (see the file header).
    auto* data = new DynamicObject();
    data->setProperty ("keptId", targetId);
    data->setProperty ("clipId", clip->itemID.toString());
    data->setProperty ("listeningQn", listeningQn);
    data->setProperty ("currentId", loopCurrentIdVar());
    data->setProperty ("applied", true);
    data->setProperty ("restarted", restarted);
    return loopOk (kName, data, actionId,
                   restarted ? "Kept " + label + "; recording from bar " + String (loopQnToBar (listeningQn))
                             : "Kept " + label + "; recording did not restart: " + reason);
}

// ── loop_again ───────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdLoopAgain (const juce::var& args)
{
    static const char* const kName = "loop_again";
    if (const auto refusal = loopAuthorityRefusal (kName, args); refusal.isNotEmpty())
        return errResult (kName, refusal);

    const auto actionId = loopActionId (args);
    const auto targetId = args.getProperty ("targetId", var()).toString();

    auto* takes = loopTakesTrack();
    if (loopLeadTrack() == nullptr || takes == nullptr)
        return errResult (kName, kLoopNotEngaged);

    auto& transport = eng.edit().getTransport();
    const bool wasRecording = transport.isRecording();
    if (wasRecording && targetId != loopCurrent_.passId)
        return errResult (kName, "During capture this control targets the current recording");
    if (! wasRecording && loopFindContribution (targetId) == nullptr)
        return errResult (kName, kLoopNoTarget);

    if (wasRecording)
    {
        const auto finalized = loopFinalizeCapture();
        if (! finalized.landed)
        {
            logLine (kName, args, false, "Nothing was captured", false);
            emit ("transport", transportToVar());
            emit ("loop", loopStateVar());
            return errResult (kName, "Nothing was captured");
        }
    }

    auto* clip = loopFindContribution (targetId);
    if (clip == nullptr)
        return errResult (kName, kLoopNoTarget);

    const auto label = loopLabelFor (targetId);
    const double entryQn = (double) clip->state.getProperty (ids::moshLoopEntryQn, 0.0);

    // Already rejected, already muted, already on takes? Then Again has nothing to edit
    // and opening a transaction for it would put an empty step in the producer's history.
    const bool changes = ! (bool) clip->state.getProperty (ids::moshLoopRejected, false)
                      || (bool) clip->state.getProperty (ids::moshLoopKeeper, false)
                      || ! clip->isMuted()
                      || clip->getTrack() != takes;

    if (changes)
    {
        beginTxn (kName);
        clip->state.setProperty (ids::moshLoopRejected, true, &undoManager());
        clip->state.setProperty (ids::moshLoopKeeper, false, &undoManager());
        if (! clip->isMuted())
            clip->setMuted (true);
        if (clip->getTrack() != takes)
            clip->moveTo (*takes);
    }

    // Preferences, after the undoable writes. Rewinding to the pass's OWN entry is what
    // makes "again" mean again: the next attempt starts exactly where the last one did.
    auto node = projectSettingsTree();
    node.setProperty (ids::loopListeningQn, entryQn, nullptr);
    node.setProperty (ids::loopEntryQn, entryQn, nullptr);
    node.setProperty (ids::loopReviewId, targetId, nullptr);
    eng.markDirty();

    juce::String reason;
    const bool restarted = loopStartCapture (entryQn, /*bypassCountIn=*/ true, reason);

    logLine (kName, args, true, {}, changes);   // honest: no transaction ⇒ nothing to undo
    emitSnapshotInvalidated();
    emit ("transport", transportToVar());
    emit ("loop", loopStateVar());

    // applied:true for the same reason Keep is — the REJECT is the primary effect, and by
    // here it has committed (or was already true, which is the same outcome).
    auto* data = new DynamicObject();
    data->setProperty ("rejectedId", targetId);
    data->setProperty ("listeningQn", entryQn);
    data->setProperty ("currentId", loopCurrentIdVar());
    data->setProperty ("applied", true);
    data->setProperty ("restarted", restarted);
    return loopOk (kName, data, actionId,
                   restarted ? "Redoing " + label + " from bar " + String (loopQnToBar (entryQn))
                             : "Rejected " + label + "; recording did not restart: " + reason);
}

// ── loop_hear ────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdLoopHear (const juce::var& args)
{
    static const char* const kName = "loop_hear";
    if (const auto refusal = loopAuthorityRefusal (kName, args); refusal.isNotEmpty())
        return errResult (kName, refusal);

    const auto actionId = loopActionId (args);
    const auto targetId = args.getProperty ("targetId", var()).toString();

    if (loopLeadTrack() == nullptr || loopTakesTrack() == nullptr)
        return errResult (kName, kLoopNotEngaged);

    auto& transport = eng.edit().getTransport();
    if (transport.isRecording())
        loopFinalizeCapture();   // preserve what was being sung; Review is not a discard

    auto* clip = loopFindContribution (targetId);
    if (clip == nullptr)
        return errResult (kName, kLoopNoTarget);

    const auto label = loopLabelFor (targetId);
    const double entryQn = (double) clip->state.getProperty (ids::moshLoopEntryQn, 0.0);

    juce::String reason;
    const bool applied = loopStartPlayback (entryQn, reason);
    if (applied)
        loopAuditionedId_ = targetId;

    auto node = projectSettingsTree();
    node.setProperty (ids::loopReviewId, targetId, nullptr);
    eng.markDirty();

    logLine (kName, args, true, {}, false);
    emitSnapshotInvalidated();   // reviewId rides the snapshot's loop block
    emit ("transport", transportToVar());
    emit ("loop", loopStateVar());

    // A rejected take is MUTED, so Review on one plays silence where the producer expects
    // their voice. Say so in the receipt rather than letting them conclude the mic died.
    const bool rejected = (bool) clip->state.getProperty (ids::moshLoopRejected, false);
    auto* data = new DynamicObject();
    data->setProperty ("auditionedId", targetId);
    data->setProperty ("entryQn", entryQn);
    data->setProperty ("applied", applied);
    if (! applied) data->setProperty ("reason", reason);
    return loopOk (kName, data, actionId,
                   ! applied ? "Not playing: " + reason
                   : rejected ? "Playing " + label + juce::String (juce::CharPointer_UTF8 (" \xe2\x80\x94 rejected take stays muted; restore it with Undo on the Mac"))
                              : "Playing " + label + " from bar " + String (loopQnToBar (entryQn)));
}

// ── loop_play_all ────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdLoopPlayAll (const juce::var& args)
{
    static const char* const kName = "loop_play_all";
    if (const auto refusal = loopAuthorityRefusal (kName, args); refusal.isNotEmpty())
        return errResult (kName, refusal);

    const auto actionId = loopActionId (args);
    if (loopLeadTrack() == nullptr || loopTakesTrack() == nullptr)
        return errResult (kName, kLoopNotEngaged);

    auto& transport = eng.edit().getTransport();
    if (transport.isRecording())
        loopFinalizeCapture();

    auto node = eng.edit().state.getChildWithName (ids::MOSH_PROJECT);
    const double startQn = loopPrefDouble (node, ids::loopListeningQn, 0.0);

    juce::String reason;
    const bool applied = loopStartPlayback (startQn, reason);
    loopAuditionedId_.clear();   // this is the whole arrangement, not one take

    logLine (kName, args, true, {}, false);
    emitSnapshotInvalidated();   // loopAuditionedId_ rides the snapshot's loop.auditionedId
    emit ("transport", transportToVar());
    emit ("loop", loopStateVar());

    auto* data = new DynamicObject();
    data->setProperty ("listeningQn", startQn);
    data->setProperty ("applied", applied);
    if (! applied) data->setProperty ("reason", reason);
    return loopOk (kName, data, actionId,
                   applied ? "Playing from bar " + String (loopQnToBar (startQn)) + " (rejected takes muted)"
                           : "Not playing: " + reason);
}

// ── loop_stop ────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdLoopStop (const juce::var& args)
{
    static const char* const kName = "loop_stop";
    // Stop's authority check is the LOOSE one (phoneloop::compatibleAuthority's stopOnly):
    // the panic button has to keep working after the state has moved under the producer.
    if (const auto refusal = loopAuthorityRefusal (kName, args); refusal.isNotEmpty())
        return errResult (kName, refusal);

    const auto actionId = loopActionId (args);
    auto& transport = eng.edit().getTransport();
    // The panic button also clears a pass some other stop (export, a loop toggle) left
    // "in flight": with nothing recording there is no capture for it to preserve.
    loopForgetStaleCapture();

    // It ends WHATEVER is recording (recording::loopStopRoute). PRESERVE, never discard,
    // either way: a producer pressing Stop is ending a take, not throwing it away.
    const bool wasRecording = transport.isRecording();
    bool stoppedPlayback = false, landed = false;
    switch (recording::loopStopRoute (wasRecording, loopCurrent_.active, transport.isPlaying()))
    {
        case recording::LoopStopRoute::finalizePass:
            landed = loopFinalizeCapture().landed;
            break;

        case recording::LoopStopRoute::landTake:
        {
            // A take the loop did not start (the TopBar Record, an agent's set_transport
            // record). Before 2026-09-23 it went to loopFinalizeCapture, which returns at once
            // with no pass in flight: the transport kept recording. Landed exactly as the
            // TopBar stop lands it -- unstamped, so the Booth does not list it as a Part (a
            // phone's loop_state read adopts it later, as it adopts any take on Takes).
            const auto stopped = stopRecordingAndLand (var (new DynamicObject()), /*discard=*/ false);
            const auto data    = stopped.getProperty ("data", var());
            const auto clips   = data.getProperty ("clips", var());   // bound, never a temporary
            landed = clips.size() > 0;
            break;
        }

        case recording::LoopStopRoute::stopPlayback:
            // Leave the playhead where it halted (no return to the insert marker): the
            // producer stopped to listen to the thing that is on screen right now.
            transport.stop (false, false);
            stoppedPlayback = true;
            break;

        case recording::LoopStopRoute::nothing:
            break;
    }
    const bool stillRecording   = transport.isRecording();
    const bool stoppedRecording = wasRecording && ! stillRecording;
    loopAuditionedId_.clear();

    logLine (kName, args, true, {}, false);
    emit ("transport", transportToVar());
    emit ("loop", loopStateVar());
    emitSnapshotInvalidated();

    // NEVER an error, headless or otherwise. A stop that reports failure is a stop the
    // producer will press again, harder, while the Mac was already stopped.
    auto* data = new DynamicObject();
    data->setProperty ("applied", true);
    data->setProperty ("stoppedRecording", stoppedRecording);
    data->setProperty ("stoppedPlayback", stoppedPlayback);
    data->setProperty ("landed", landed);
    return loopOk (kName, data, actionId,
                   recording::loopStopDetail (wasRecording, stillRecording, landed));
}

// ── loop_navigate / loop_home / loop_lead_in ─────────────────────────────────────────
juce::var MoshOps::cmdLoopNavigate (const juce::var& args)
{
    static const char* const kName = "loop_navigate";
    if (const auto refusal = loopAuthorityRefusal (kName, args); refusal.isNotEmpty())
        return errResult (kName, refusal);

    const auto bar = args.getProperty ("bar", var());
    if (! (bar.isInt() || bar.isInt64())
        || (juce::int64) bar < 1 || (juce::int64) bar > kLoopMaxBar)
        return errResult (kName, "Enter a valid displayed bar");

    if (const auto refusal = loopMovingRefusal(); refusal.isNotEmpty())
        return errResult (kName, refusal);

    return loopWriteCursor (kName, args, var (loopBarToQn ((int) bar)), var());
}

juce::var MoshOps::cmdLoopHome (const juce::var& args)
{
    static const char* const kName = "loop_home";
    if (const auto refusal = loopAuthorityRefusal (kName, args); refusal.isNotEmpty())
        return errResult (kName, refusal);
    if (const auto refusal = loopMovingRefusal(); refusal.isNotEmpty())
        return errResult (kName, refusal);

    return loopWriteCursor (kName, args, var (0.0), var());
}

juce::var MoshOps::cmdLoopLeadIn (const juce::var& args)
{
    static const char* const kName = "loop_lead_in";
    if (const auto refusal = loopAuthorityRefusal (kName, args); refusal.isNotEmpty())
        return errResult (kName, refusal);

    const auto lead = args.getProperty ("leadQn", var());
    if (! (lead.isDouble() || lead.isInt() || lead.isInt64()))
        return errResult (kName, "Enter a valid lead-in in quarter-note beats");

    const double leadQn = (double) lead;
    if (! std::isfinite (leadQn) || leadQn < 0.0 || leadQn > kLoopMaxLeadQn)
        return errResult (kName, "Enter a valid lead-in in quarter-note beats");

    // Deliberately allowed WHILE rolling, unlike the two cursor commands: changing how
    // much run-up the NEXT pass gets does not move anything that is currently playing —
    // which is also why the listening start is passed as void here, not re-written.
    return loopWriteCursor (kName, args, var(), var (leadQn));
}

} // namespace mosh
