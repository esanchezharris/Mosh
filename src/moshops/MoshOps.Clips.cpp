// RFC 001 (A-PR2) — MoshOps partial-class split: the clip-domain command
// bodies (the shared wave-file insertion path importWaveFileToTrack +
// import/test-tone, and the Stage-2 arrangement-editing block: move/trim/
// split/remove/rename/mute/gain/fade/reverse/crossfade/loop/normalize/relink/
// warp/stretch/detect-bpm/duplicate/delete-time-range/paste), moved VERBATIM
// from MoshOps.cpp. Same class, same member functions — only the translation
// unit changed. The dispatch if-chain and all transaction/log/result/emit
// plumbing stay in MoshOps.cpp (one mutation path, by construction).
// Cross-TU helpers live in MoshOpsInternal.h; the two helpers whose ONLY
// consumers moved here (findSourcePeak, rippleShiftClipsAfter) moved into
// this TU's anonymous namespace, verbatim.

#include "MoshOps.h"
#include "MoshOpsInternal.h"
#include "ClipLoopPhase.h"
#include "ClipGainCurveWrite.h"
#include "ClipGainEnvelope.h"
#include "state/Ids.h"
#include "engine/SourceRef.h"
#include "files/ImportCopy.h"
#include <limits>

namespace mosh
{
using namespace juce;

namespace
{
    // Overall absolute-value peak sample within [startSample, endSample) of a reader
    // (linear, 0..~1+). endSample < 0 (the default) means "to the end of the file" —
    // callers that want the whole span (get_clip_peaks/bucketedPeaks's sibling use,
    // or a normalize_clip fallback for warped clips, see clipAudibleSourceSpan below)
    // just omit both bounds. Range is clamped to the reader's actual length so an
    // offset/length that runs past EOF degrades gracefully instead of erroring.
    // Shared with normalize_clip — reuses the same block-read shape as bucketedPeaks
    // (Stage-2's get_clip_peaks path) instead of a dedicated render job (tracktion's
    // ClipEffects/NormaliseEffect are an unused, heavier subsystem for this).
    float findSourcePeak (juce::AudioFormatReader& reader, juce::int64 startSample = 0, juce::int64 endSample = -1)
    {
        const auto total = (juce::int64) reader.lengthInSamples;
        const int chans = (int) reader.numChannels;
        if (total <= 0 || chans <= 0) return 0.0f;
        if (endSample < 0) endSample = total;
        startSample = juce::jlimit ((juce::int64) 0, total, startSample);
        endSample   = juce::jlimit (startSample, total, endSample);
        if (endSample <= startSample) return 0.0f;

        constexpr juce::int64 blockSize = 65536;
        juce::AudioBuffer<float> buf (chans, (int) juce::jmin (blockSize, endSample - startSample));
        float peak = 0.0f;
        for (juce::int64 start = startSample; start < endSample; start += blockSize)
        {
            const int n = (int) juce::jmin (blockSize, endSample - start);
            buf.clear();
            reader.read (&buf, 0, n, start, true, chans > 1);
            for (int c = 0; c < buf.getNumChannels(); ++c)
            {
                auto r = juce::FloatVectorOperations::findMinAndMax (buf.getReadPointer (c), n);
                peak = juce::jmax (peak, std::abs (r.getStart()), std::abs (r.getEnd()));
            }
        }
        return peak;
    }

    // ARR-011 — RIPPLE shift. Moves every clip on `clipTrack` that starts at or after
    // `fromSec` by `deltaSec` seconds (negative closes a gap, positive opens one).
    // Shared by the opt-in `ripple` flag on delete_time_range and trim_clip; those two
    // commands only differ in what they compute for fromSec/deltaSec, so the actual
    // shift lives here once.
    //
    // Uses Clip::setStart(pos, false, true) — the SAME primitive as move_clip — so a
    // rippled clip is repositioned exactly as if the producer had dragged it, and the
    // whole shift joins the caller's already-open Tracktion transaction (one undo
    // reverts the removal/trim AND the shift together).
    //
    // NEGATIVE-START GUARD: a resulting start is clamped at 0. A ripple can never push
    // a clip to a negative position; in the degenerate case (a clip nearer to zero than
    // the shift distance) it lands at 0 rather than off the timeline.
    //
    // `exclude` skips one clip (trim_clip passes the clip it just trimmed, which may
    // itself satisfy the >= fromSec test after an unusual trim).
    int rippleShiftClipsAfter (te::ClipTrack& clipTrack, double fromSec, double deltaSec,
                               const te::Clip* exclude = nullptr)
    {
        constexpr double kEps = 1.0e-6;
        if (std::abs (deltaSec) < kEps) return 0;

        // Iterate a stable copy — setStart re-sorts the live clip list.
        juce::Array<te::Clip*> snap;
        for (auto* c : clipTrack.getClips())
            if (c != nullptr && c != exclude)
                snap.add (c);

        int moved = 0;
        for (auto* c : snap)
        {
            if (c == nullptr) continue;
            const double s = c->getPosition().getStart().inSeconds();
            if (s < fromSec - kEps) continue;                  // strictly before the edit point — untouched
            const double ns = juce::jmax (0.0, s + deltaSec);  // negative-start guard
            if (std::abs (ns - s) < kEps) continue;
            c->setStart (tracktion::TimePosition::fromSeconds (ns), false, true);   // keep length (move_clip's primitive)
            ++moved;
        }
        return moved;
    }

    // Maps a clip's PLAYED span — position offset/length, or the loop range for a
    // looping clip — onto a [startSec, lengthSec) window in SOURCE-FILE seconds: the
    // samples that actually sound when the clip plays, as opposed to the whole
    // (possibly much longer) source file it was trimmed from. Mirrors the arithmetic
    // in the (private) non-auto-tempo branch of te::AudioClipBase::getReferencedItems
    // — sourceSec = clipTimeSec * getSpeedRatio() — which is the same formula
    // Tracktion itself uses to report a clip's "used" file range for export/reference
    // purposes, just not exposed as a public helper.
    //
    // WARPED CAVEAT: auto-tempo (warp-locked) clips are deliberately NOT mapped —
    // lengthSec is returned negative to mean "unmapped, scan the whole file", which
    // callers should treat as a fallback. This matches Tracktion's own
    // getReferencedItems, which ALSO falls back to the whole source file for
    // auto-tempo clips (see the `if (getAutoTempo())` branch that resets
    // firstTimeUsed/lengthUsed to the full file): the elastique-driven mapping from
    // edit time to source time isn't a simple linear scale, so there's no cheap exact
    // window to compute here either. A precise warped-clip mapping is a documented
    // follow-up, not attempted in this pass.
    //
    // Demoted from MoshOpsInternal.h (A-PR2 promoted it; hostile review of #502
    // proved its only real consumer is this TU — the two MoshOps.cpp/MoshOps.h
    // mentions are comments — so per the promotion rule it belongs here).
    struct ClipSourceSpan { double startSec = 0.0; double lengthSec = -1.0; };

    ClipSourceSpan clipAudibleSourceSpan (te::AudioClipBase& ac)
    {
        if (ac.getAutoTempo())
            return {};   // warped — see the WARPED CAVEAT above; caller scans the whole file

        const double speed = ac.getSpeedRatio();
        if (ac.isLooping())
            return { ac.getLoopStart().inSeconds() * speed, ac.getLoopLength().inSeconds() * speed };

        auto pos = ac.getPosition();
        return { pos.getOffset().inSeconds() * speed, pos.getLength().inSeconds() * speed };
    }

    // CAP-CLP-017 — the transport LOOP REGION is the one thing insert_time moves that is
    // NOT in the Edit's undo history: TransportControl::loopPoint1/loopPoint2 are
    // CachedValues wired with no UndoManager, which is exactly why set_transport is
    // classified NonUndoable in TransactionSafe.h. Leaving the loop where it was would be
    // a silent lie (insert 8 bars before the chorus, and the loop still brackets the OLD
    // chorus); shifting it non-undoably would break the one-transaction promise in the
    // other direction. So the shift is pushed as an explicit UndoableAction — the same
    // device SetFaderValueAction (MoshOps.Mixer.cpp) and SetPluginParamValueAction
    // (MoshOps.Plugins.cpp) already use for engine state that lives outside the ValueTree.
    // It joins the caller's open transaction, so one ⌘Z still reverts the loop with
    // everything else.
    //
    // Holding `te::Edit&` matches SetPluginParamValueAction: an Edit swap (reload /
    // open_project) replaces the UndoManager along with the Edit, so a stale action can
    // never be replayed against a dead one.
    struct SetLoopRangeAction final : public juce::UndoableAction
    {
        SetLoopRangeAction (te::Edit& e, tracktion::TimeRange after)
            : edit (e), rangeAfter (after), rangeBefore (e.getTransport().getLoopRange()) {}

        bool perform() override        { edit.getTransport().setLoopRange (rangeAfter);  return true; }
        bool undo() override           { edit.getTransport().setLoopRange (rangeBefore); return true; }
        int  getSizeInUnits() override { return (int) sizeof (*this); }

        te::Edit& edit;
        const tracktion::TimeRange rangeAfter, rangeBefore;
    };

    // CAP-CLP-017 — the ONE shift rule, applied to every span-shaped thing insert_time
    // touches (the loop region in seconds, a song section in beats). A span that ends at
    // or before the insertion point is untouched; a span that starts at or after it moves
    // whole; a span that STRADDLES it grows — its start holds and only its end moves, so
    // the inserted space lands inside the span rather than teleporting it. That is what
    // both reference DAWs do with a selection/loop that brackets an Insert Time, and it is
    // the only rule under which "insert then delete the same span" is an exact inverse.
    struct SpanShift { double lo = 0.0, hi = 0.0; bool moved = false; };

    SpanShift shiftSpanForInsert (double lo, double hi, double at, double delta, double eps)
    {
        if (hi <= at + eps)              return { lo, hi, false };            // entirely before
        if (lo >= at - eps)              return { lo + delta, hi + delta, true };   // entirely after
        return { lo, hi + delta, true };                                      // straddles → grows
    }
}

// Shared wave-file insertion path used by both import_clip (path-based) and
// import_clip_data (bytes-over-bridge). The caller guarantees `file` is a real,
// already-validated audio file on disk. Opens one undo transaction, finds-or-
// creates the target track, inserts the wave clip at `startSeconds`, drains the
// post-insert AsyncUpdater headless (so itemIDs settle, no itemID assert), logs
// the command as undoable and emits a snapshot invalidation.
juce::var MoshOps::importWaveFileToTrack (const juce::String& command,
                                          const juce::File& file,
                                          const juce::String& clipName,
                                          const juce::String& trackId,
                                          double startSeconds,
                                          const juce::var& logArgs)
{
    auto& edit = eng.edit();

    // Validate the audio file BEFORE any mutation. We may auto-create a track
    // below; doing that (undoable) creation first and only then discovering the
    // file is invalid would leave an orphan track in a failed command's undo
    // transaction (partial mutation). Validate up front so an invalid import is a
    // clean no-op.
    te::AudioFile audioFile (edit.engine, file);
    if (! audioFile.isValid()) return errResult (command, "invalid audio file");

    auto* track = trackId.isNotEmpty() ? findTrack (trackId) : nullptr;
    if (track == nullptr)
    {
        auto tracks = te::getAudioTracks (edit);
        track = tracks.isEmpty() ? nullptr : tracks.getFirst();
    }

    beginTxn (command);
    if (track == nullptr)
        track = createAudioTrack ({});
    if (track == nullptr) return errResult (command, "no track");
    ensureTrackMeter (*track);   // METER-001 — self-healing: covers both the auto-created and the resolved-existing case

    const double len = audioFile.getLength();
    auto name = clipName;
    if (name.isEmpty()) name = file.getFileNameWithoutExtension();

    auto clip = track->insertWaveClip (name, file,
        { { tracktion::TimePosition::fromSeconds (startSeconds), tracktion::TimeDuration::fromSeconds (len) }, {} }, false);
    if (clip == nullptr)
    {
        logLine (command, logArgs, false, "insert failed", true);
        return errResult (command, "insertWaveClip failed");
    }

    // Deliberately NO message-loop pump here: EditItemID assignment is synchronous
    // (edit.createNewItemID() runs inline), and a mid-command pump re-enters queued
    // async engine work — the AUD-001 use-after-free class (see patches/0005).

    auto* data = new DynamicObject();
    data->setProperty ("clipId", clip->itemID.toString());
    data->setProperty ("trackId", track->itemID.toString());
    data->setProperty ("file", file.getFullPathName());
    logLine (command, logArgs, true, {}, true);
    emitSnapshotInvalidated();
    return okResult (command, var (data));
}

juce::var MoshOps::cmdImportClip (const juce::var& args)
{
    const auto path = args.getProperty ("file", var()).toString();
    if (path.isEmpty()) return errResult ("import_clip", "missing 'file'");

    const File source (path);
    if (! source.existsAsFile()) return errResult ("import_clip", "file not found: " + path);

    te::AudioFile sourceAudio (eng.engine(), source);
    if (! sourceAudio.isValid()) return errResult ("import_clip", "invalid audio file");

    const auto copied = copyIntoImports (
        source, eng.sessionDir().getChildFile ("imports"));
    if (copied.error.isNotEmpty())
        return errResult ("import_clip", copied.error);

    return importWaveFileToTrack ("import_clip", copied.file,
                                  args.getProperty ("name", var()).toString(),
                                  args.getProperty ("trackId", var()).toString(),
                                  (double) args.getProperty ("startSeconds", 0.0),
                                  args);
}

juce::var MoshOps::cmdImportClipData (const juce::var& args)
{
    auto name = args.getProperty ("name", var()).toString();
    const auto dataBase64 = args.getProperty ("dataBase64", var()).toString();
    if (name.isEmpty())       return errResult ("import_clip_data", "missing 'name'");
    if (dataBase64.isEmpty()) return errResult ("import_clip_data", "missing 'dataBase64'");

    // Size guard: reject a pathological drop before decoding to avoid OOM.
    // ~280 MB of base64 decodes to ~200 MB of audio.
    if (dataBase64.length() > 280 * 1024 * 1024)
        return errResult ("import_clip_data", "file too large");

    // Decode base64 -> raw bytes. Guard against malformed input (no crash).
    juce::MemoryOutputStream mos;
    if (! juce::Base64::convertFromBase64 (mos, dataBase64))
        return errResult ("import_clip_data", "invalid base64 data");

    // Write the decoded bytes under sessionDir/imports/. Uniquify the destination so
    // two drops sharing a display name (both "loop.wav") don't overwrite each other's
    // on-disk source: an earlier imported clip still references the first file, so an
    // in-place overwrite would silently alias it (and persist across save/reload).
    auto importsDir = eng.sessionDir().getChildFile ("imports");
    importsDir.createDirectory();
    const juce::File named (importsDir.getChildFile (juce::File::createLegalFileName (name)));
    auto file = importsDir.getNonexistentChildFile (named.getFileNameWithoutExtension(),
                                                    named.getFileExtension(), false);
    if (! file.replaceWithData (mos.getData(), mos.getDataSize()))
        return errResult ("import_clip_data", "could not write the import file");

    // Validate it is real audio BEFORE inserting; never leave a garbage file or
    // insert a non-audio clip.
    te::AudioFile af (eng.engine(), file);
    if (! af.isValid())
    {
        file.deleteFile();
        return errResult ("import_clip_data", "not a supported audio file");
    }

    return importWaveFileToTrack ("import_clip_data", file, name,
                                  args.getProperty ("trackId", var()).toString(),
                                  (double) args.getProperty ("start", 0.0),
                                  args);
}

juce::var MoshOps::cmdAddTestTone (const juce::var& args)
{
    const double seconds = (double) args.getProperty ("seconds", 2.0);
    const double freq = (double) args.getProperty ("freq", 220.0);
    auto name = args.getProperty ("name", var()).toString();
    if (name.isEmpty()) name = "tone-" + String ((int) freq);

    auto file = eng.generateTestTone (seconds, freq, name);
    if (! file.existsAsFile()) return errResult ("add_test_tone_clip", "tone generation failed");

    auto* importArgs = new DynamicObject();
    importArgs->setProperty ("file", file.getFullPathName());
    importArgs->setProperty ("trackId", args.getProperty ("trackId", var()));
    importArgs->setProperty ("name", name);
    return cmdImportClip (var (importArgs));   // logs as import_clip
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 2 — arrangement editing
// ─────────────────────────────────────────────────────────────────────────────
juce::var MoshOps::cmdMoveClip (const juce::var& args)
{
    const auto id = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (id);
    if (clip == nullptr) return errResult ("move_clip", "no clip: " + id);

    // CAP-CLP-017 — opt-in RIPPLE (default FALSE ⇒ the move below is byte-identical when
    // the arg is absent). Captured BEFORE the move: the neighbours downstream follow this
    // clip's OLD end and shift by however far the clip itself travelled. Exactly
    // trim_clip's rule (ARR-011), differing only in what produced the delta.
    const bool   ripple   = (bool) args.getProperty ("ripple", false);
    const auto   origPos  = clip->getPosition();
    const double oldStart = origPos.getStart().inSeconds();
    const double oldEnd   = origPos.getEnd().inSeconds();
    const auto clipGroup = findClipGroupForClip (id, true);
    const auto groupedMembers = clipGroup.isValid() ? clipGroupMembers (clipGroup)
                                                    : std::vector<te::Clip*> {};

    if (clipGroup.isValid() && ripple)
        return errResult ("move_clip", "ripple move is not supported for a clip group");
    if (clipGroup.isValid() && args.hasProperty ("trackId"))
        if (auto* dest = findTrack (args.getProperty ("trackId", var()).toString());
            dest != nullptr && dest != clip->getTrack())
            return errResult ("move_clip", "moving a multitrack clip group between tracks is not supported");

    // Validated BEFORE any side effect (no transaction opened, nothing mutated): ripple
    // has no defined meaning across a track change. The neighbours it would carry live on
    // the track the clip is LEAVING, and "shift them by how far the clip moved" describes
    // a distance the clip no longer has on that track. A legible refusal costs a caller
    // nothing; guessing would silently rearrange a track the caller never named.
    if (ripple && args.hasProperty ("trackId"))
        if (auto* dest = findTrack (args.getProperty ("trackId", var()).toString());
            dest != nullptr && dest != clip->getTrack())
            return errResult ("move_clip", "ripple:true cannot be combined with a move to another track");

    beginTxn ("move_clip");
    const double newStart = juce::jmax (0.0, (double) args.getProperty ("start", oldStart));
    if (clipGroup.isValid())
    {
        double earliestStart = oldStart;
        for (auto* member : groupedMembers)
            earliestStart = juce::jmin (earliestStart, member->getPosition().getStart().inSeconds());
        const double delta = juce::jmax (newStart - oldStart, -earliestStart);
        for (auto* member : groupedMembers)
            member->setStart (tracktion::TimePosition::fromSeconds (
                member->getPosition().getStart().inSeconds() + delta), false, true);
    }
    else
        clip->setStart (tracktion::TimePosition::fromSeconds (newStart), false, true);   // keep length

    // Optional move to another track.
    if (args.hasProperty ("trackId"))
        if (auto* dest = findTrack (args.getProperty ("trackId", var()).toString()))
            if (dest != clip->getTrack())
                clip->moveTo (*dest);

    // Ripple scope = THIS clip's own track, the only track a same-track move touches
    // (mirrors trim_clip; delete_time_range's cross-track trackIds set has no analogue for
    // a single-clip command). Moving right pushes the later clips right by the same
    // amount; moving left pulls them left. `clip` itself is excluded — it has already
    // landed, and it can satisfy the >= oldEnd test after a large move.
    if (ripple)
        if (auto* clipTrack = dynamic_cast<te::ClipTrack*> (clip->getTrack()))
            rippleShiftClipsAfter (*clipTrack, oldEnd, newStart - oldStart, clip);

    logLine ("move_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("move_clip");
}

juce::var MoshOps::cmdTrimClip (const juce::var& args)
{
    const auto id = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (id);
    if (clip == nullptr) return errResult ("trim_clip", "no clip: " + id);

    auto pos = clip->getPosition();
    const double start  = (double) args.getProperty ("start",  pos.getStart().inSeconds());
    const double length = juce::jmax (0.01, (double) args.getProperty ("length", pos.getLength().inSeconds()));
    const double offset = (double) args.getProperty ("offset", pos.getOffset().inSeconds());

    // ARR-011 — opt-in ripple (default FALSE ⇒ the trim path below is byte-identical
    // when the arg is absent). Captured BEFORE the trim: the neighbours downstream
    // follow this clip's OLD end, and shift by however much that end moved.
    const bool   ripple = (bool) args.getProperty ("ripple", false);
    const double oldEnd = pos.getEnd().inSeconds();

    beginTxn ("trim_clip");
    clip->setPosition ({ { tracktion::TimePosition::fromSeconds (start),
                           tracktion::TimeDuration::fromSeconds (length) },
                         tracktion::TimeDuration::fromSeconds (offset) });

    // Ripple scope = THIS clip's own track (the only track trim_clip touches — it is a
    // single-clip command, so there is no cross-track set to ripple, unlike
    // delete_time_range's trackIds). Shortening the clip (newEnd < oldEnd) pulls the
    // next clips left; lengthening pushes them right by the same amount.
    if (ripple)
        if (auto* clipTrack = dynamic_cast<te::ClipTrack*> (clip->getTrack()))
            rippleShiftClipsAfter (*clipTrack, oldEnd,
                                   clip->getPosition().getEnd().inSeconds() - oldEnd,
                                   clip);

    logLine ("trim_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouch (id);   // Phase 3 — a length/offset change re-bounces the source window
    return okResult ("trim_clip");
}

juce::var MoshOps::cmdSplitClip (const juce::var& args)
{
    const auto id = args.getProperty ("clipId", var()).toString();
    auto* clip = findClip (id);
    if (clip == nullptr) return errResult ("split_clip", "no clip: " + id);
    auto* clipTrack = dynamic_cast<te::ClipTrack*> (clip->getTrack());
    if (clipTrack == nullptr) return errResult ("split_clip", "clip not on a clip track");

    // Split-point normalization (r4 gate-miss fix plan P1): agents and utterances mix
    // ABSOLUTE and CLIP-RELATIVE times ("split at 8s" on a clip spanning [4,12] can mean
    // t=8 or start+8). Absolute wins when it lands strictly inside; otherwise a value
    // that resolves inside as start+t is treated as clip-relative. Exact edges and
    // truly-outside values error with the resolved point + range (previously Tracktion's
    // splitClip silently no-opped and we returned ok with no newClipId).
    const double reqAt = (double) args.getProperty ("time", 0.0);
    const double cStart = clip->getPosition().getStart().inSeconds();
    const double cEnd   = clip->getPosition().getEnd().inSeconds();
    constexpr double kSplitEps = 1.0e-6;
    const auto insideClip = [&] (double x) { return x > cStart + kSplitEps && x < cEnd - kSplitEps; };
    double at = reqAt;
    if (! insideClip (at))
    {
        if (const double rel = cStart + reqAt; insideClip (rel))
            at = rel;
        else
            return errResult ("split_clip",
                "split point outside clip: time " + juce::String (reqAt, 3)
                + " (relative candidate " + juce::String (cStart + reqAt, 3)
                + ") not strictly inside [" + juce::String (cStart, 3) + ", "
                + juce::String (cEnd, 3) + "]");
    }
    beginTxn ("split_clip");
    auto* newClip = clipTrack->splitClip (*clip, tracktion::TimePosition::fromSeconds (at));

    auto* data = new DynamicObject();
    if (newClip != nullptr) data->setProperty ("newClipId", newClip->itemID.toString());
    logLine ("split_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("split_clip", var (data));
}

// ⌘J (Live's Consolidate) — merge clips into one, dispatched by clip TYPE (Live
// consolidates both; a mixed MIDI+WAVE set is refused plainly rather than
// silently picking a type).
//
// MIDI: exact note arithmetic, re-anchored through the tempo map (beat positions
// are clip-local, so each source clip's absolute start beat minus the span's
// start beat is its offset).
//
// WAVE: render the span covering the selection through the track's instrument+FX
// chain to a WAV (bounceRenderToWavImpl — the same offline RenderTask path as
// bounce_track and the generative auto-bounce), remove the sources, insert the
// rendered clip at the span start. The render happens BEFORE the transaction
// (file side effect, not undo state); an UNSELECTED clip overlapping the span is
// refused up front, or its audio would land in the render and stay on the track.
juce::var MoshOps::cmdConsolidateClips (const juce::var& args)
{
    std::vector<te::Clip*> clips;
    if (auto* arr = args.getProperty ("clipIds", var()).getArray())
        for (auto& id : *arr)
            if (auto* c = findClip (id.toString()))
                clips.push_back (c);
    if (clips.empty()) return errResult ("consolidate_clips", "no clips found");

    auto* track = dynamic_cast<te::ClipTrack*> (clips[0]->getTrack());
    if (track == nullptr) return errResult ("consolidate_clips", "clip not on a clip track");
    int midiCount = 0, waveCount = 0;
    for (auto* c : clips)
    {
        if (c->getTrack() != track)
            return errResult ("consolidate_clips", "consolidate works within one track");
        if (dynamic_cast<te::MidiClip*> (c) != nullptr) ++midiCount;
        else if (dynamic_cast<te::WaveAudioClip*> (c) != nullptr) ++waveCount;
        else return errResult ("consolidate_clips", "consolidate works on MIDI and audio clips");
    }
    if (midiCount > 0 && waveCount > 0)
        return errResult ("consolidate_clips",
            "a mixed MIDI + audio selection can't consolidate — consolidate per type (Live's rule)");

    double spanStart = std::numeric_limits<double>::max();
    double spanEnd   = std::numeric_limits<double>::lowest();
    for (auto* c : clips)
    {
        const auto pos = c->getPosition();
        spanStart = juce::jmin (spanStart, pos.getStart().inSeconds());
        spanEnd   = juce::jmax (spanEnd,   pos.getEnd().inSeconds());
    }
    // Harvest BEFORE any mutation: removing a clip can destroy the runtime object
    // (the undo manager keeps its STATE, not the te::Clip*), so anything read from
    // the sources below — today just the merged clip's name — is captured up front.
    const juce::String firstClipName = clips[0]->getName();

    // ── WAVE path — render the span through the track's chain ─────────────────
    if (waveCount > 0)
    {
        // An unselected clip overlapping the span would be rendered into the
        // consolidated file AND left on the track — double audio. Refuse honestly.
        const auto selected = std::unordered_set<te::Clip*> (clips.begin(), clips.end());
        for (auto* c : track->getClips())
        {
            if (c == nullptr || selected.count (c) != 0) continue;
            const auto pos = c->getPosition();
            if (pos.getEnd().inSeconds() > spanStart + 1.0e-4 && pos.getStart().inSeconds() < spanEnd - 1.0e-4)
                return errResult ("consolidate_clips",
                    "an unselected clip overlaps the span — include it or move it before consolidating");
        }

        static int consolidateSeq = 0;
        const auto destWav = eng.sessionDir().getChildFile ("consolidate")
            .getChildFile (track->getName() + "-" + track->itemID.toString()
                           + "-" + juce::String (++consolidateSeq) + ".wav");
        if (! bounceRenderToWavImpl (*track, spanStart, spanEnd, destWav, nullptr))
            return errResult ("consolidate_clips", "offline render failed (stalled or not possible here)");
        te::AudioFile af (eng.edit().engine, destWav);
        const double len = af.isValid() ? af.getLength() : (spanEnd - spanStart);

        beginTxn ("consolidate_clips");
        for (auto* c : clips)
        {
            if (auto node = c->state.getChildWithName (ids::MOSH_RENDERLAYER);
                node.isValid() && (bool) node[kSourceMutedByLayer])
                if (auto hiddenId = node[kLandedClipId].toString(); hiddenId.isNotEmpty())
                    if (auto* hidden = findClip (hiddenId); hidden != nullptr && hidden != c)
                        hidden->removeFromParent();
            c->removeFromParent();
        }
        auto nc = track->insertWaveClip (firstClipName, destWav,
            { { tracktion::TimePosition::fromSeconds (spanStart),
                tracktion::TimeDuration::fromSeconds (len) }, {} }, false);
        if (nc == nullptr) return errResult ("consolidate_clips", "insertWaveClip failed");

        auto* data = new DynamicObject();
        data->setProperty ("newClipId", nc->itemID.toString());
        data->setProperty ("file", destWav.getFullPathName());
        logLine ("consolidate_clips", args, true, {}, true);
        emitSnapshotInvalidated();
        return okResult ("consolidate_clips", var (data));
    }

    // ── MIDI path (byte-identical to the pre-audio behaviour) ────────────────

    // Harvest note data BEFORE any mutation: the sources are removed before the new
    // clip is inserted, so an overlap between the merged span and a still-present
    // source can never split or swallow either.
    struct Harvested { int pitch; double start; double length; int vel; };
    std::vector<Harvested> notes;
    auto& ts = eng.edit().tempoSequence;
    const double spanStartBeat = ts.toBeats (tracktion::TimePosition::fromSeconds (spanStart)).inBeats();
    for (auto* c : clips)
    {
        auto* m = dynamic_cast<te::MidiClip*> (c);
        const double clipStartBeat = ts.toBeats (m->getPosition().getStart()).inBeats();
        auto& src = m->getSequence();
        for (int i = 0; i < src.getNumNotes(); ++i)
            if (auto* n = src.getNote (i))
                notes.push_back ({ n->getNoteNumber(),
                                   clipStartBeat - spanStartBeat + n->getStartBeat().inBeats(),
                                   n->getLengthBeats().inBeats(), n->getVelocity() });
    }

    beginTxn ("consolidate_clips");
    for (auto* c : clips)
    {
        // Mirror cmdRemoveClip: a source with a hidden beneath-render takes that audio
        // with it, or the hidden clip is orphaned on the track.
        if (auto node = c->state.getChildWithName (ids::MOSH_RENDERLAYER);
            node.isValid() && (bool) node[kSourceMutedByLayer])
            if (auto hiddenId = node[kLandedClipId].toString(); hiddenId.isNotEmpty())
                if (auto* hidden = findClip (hiddenId); hidden != nullptr && hidden != c)
                    hidden->removeFromParent();
        c->removeFromParent();
    }
    auto nc = track->insertMIDIClip (firstClipName,
        { tracktion::TimePosition::fromSeconds (spanStart),
          tracktion::TimePosition::fromSeconds (spanEnd) }, nullptr);
    if (nc == nullptr) return errResult ("consolidate_clips", "insertMIDIClip failed");
    auto& dst = nc->getSequence();
    for (auto& n : notes)
        dst.addNote (n.pitch, tracktion::BeatPosition::fromBeats (n.start),
                     tracktion::BeatDuration::fromBeats (n.length), n.vel, 0, &undoManager());

    auto* data = new DynamicObject();
    data->setProperty ("newClipId", nc->itemID.toString());
    data->setProperty ("noteCount", (int) notes.size());
    logLine ("consolidate_clips", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("consolidate_clips", var (data));
}

// ⇧⌘J (Live's Crop Clip — arrangement-context only) — trim each given clip to its
// intersection with the passed TIME RANGE (the arrangement time selection; the UI
// owns selection state, so it arrives as start/end seconds, like insert_time).
// MIDI clips: notes fully outside the crop are removed and notes crossing an edge
// are clipped to it — Tracktion's OWN MidiClip::trimBeyondEnds, so the note math is
// the engine's, not hand-rolled. Audio clips: a plain edge-trim (offset adjusts,
// exactly cmdTrimClip's semantics). A clip fully inside the range is untouched.
// No-op → user-facing error when the range is empty or nothing overlaps. ONE
// transaction, one log line — the whole crop is a single undo step.
juce::var MoshOps::cmdCropClip (const juce::var& args)
{
    const double start = (double) args.getProperty ("start", 0.0);
    const double end   = (double) args.getProperty ("end", 0.0);
    if (! (end > start)) return errResult ("crop_clip", "crop needs a time selection (start < end)");

    std::vector<te::Clip*> clips;
    if (auto* arr = args.getProperty ("clipIds", var()).getArray())
        for (auto& id : *arr)
            if (auto* c = findClip (id.toString()))
                clips.push_back (c);
    if (clips.empty()) return errResult ("crop_clip", "no clips found");

    struct Plan { te::Clip* clip; double s, e; bool startMoved, endMoved; };
    std::vector<Plan> plans;
    for (auto* c : clips)
    {
        const auto pos = c->getPosition();
        const double cs = pos.getStart().inSeconds();
        const double ce = pos.getEnd().inSeconds();
        const double s = juce::jmax (cs, start);
        const double e = juce::jmin (ce, end);
        if (e <= s) continue;
        plans.push_back ({ c, s, e, s > cs + 1.0e-9, e < ce - 1.0e-9 });
    }
    if (plans.empty()) return errResult ("crop_clip", "the time selection does not overlap the clip(s)");
    // A clip fully inside the range is untouched — and if that is ALL of them, the
    // crop is a no-op, reported rather than silently ok (Live's own behaviour).
    const auto croppable = std::count_if (plans.begin(), plans.end(),
                                          [] (const Plan& p) { return p.startMoved || p.endMoved; });
    if (croppable == 0) return errResult ("crop_clip", "the time selection already covers the clip(s)");

    beginTxn ("crop_clip");
    for (auto& p : plans)
    {
        if (! p.startMoved && ! p.endMoved) continue;
        auto* c = p.clip;
        const auto pos = c->getPosition();
        const double cStart = pos.getStart().inSeconds();
        c->setPosition ({ { tracktion::TimePosition::fromSeconds (p.s),
                            tracktion::TimeDuration::fromSeconds (p.e - p.s) },
                          tracktion::TimeDuration::fromSeconds (
                              pos.getOffset().inSeconds() + (p.s - cStart)) });
        // Cut the content to the new window — only the side(s) that actually moved,
        // so a one-sided crop never rewrites the untouched end (and TE's allowed
        // but anomalous notes-in-the-offset on the other side stay put).
        if (auto* mc = dynamic_cast<te::MidiClip*> (c))
            mc->trimBeyondEnds (p.startMoved, p.endMoved, &undoManager());
        reactiveTouch (c->itemID.toString());   // Phase 3 — re-bounce the source window, as trim_clip
    }

    logLine ("crop_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("crop_clip");
}

juce::var MoshOps::cmdRemoveClip (const juce::var& args)
{
    auto* clip = findClip (args.getProperty ("clipId", var()).toString());
    if (clip == nullptr) return errResult ("remove_clip", "no clip");
    beginTxn ("remove_clip");
    // Phase 2 — if this MIDI/drum clip owns a hidden beneath-render, remove the hidden audio with it
    // (else it's orphaned on the track). The source mute goes away with the clip itself.
    if (auto node = clip->state.getChildWithName (ids::MOSH_RENDERLAYER);
        node.isValid() && (bool) node[kSourceMutedByLayer])
        if (auto hiddenId = node[kLandedClipId].toString(); hiddenId.isNotEmpty())
            if (auto* hidden = findClip (hiddenId); hidden != nullptr && hidden != clip)
                hidden->removeFromParent();
    clip->removeFromParent();
    logLine ("remove_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_clip");
}

juce::var MoshOps::cmdRenameClip (const juce::var& args)
{
    auto* clip = findClip (args.getProperty ("clipId", var()).toString());
    if (clip == nullptr) return errResult ("rename_clip", "no clip");
    beginTxn ("rename_clip");
    clip->setName (args.getProperty ("name", var()).toString());
    logLine ("rename_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("rename_clip");
}

juce::var MoshOps::cmdSetClipMute (const juce::var& args)
{
    auto* clip = findClip (args.getProperty ("clipId", var()).toString());
    if (clip == nullptr) return errResult ("set_clip_mute", "no clip");
    beginTxn ("set_clip_mute");
    clip->setMuted ((bool) args.getProperty ("mute", false));
    logLine ("set_clip_mute", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_clip_mute");
}

juce::var MoshOps::cmdSetClipGain (const juce::var& args)
{
    auto* ac = dynamic_cast<te::AudioClipBase*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (ac == nullptr) return errResult ("set_clip_gain", "not an audio clip");
    beginTxn ("set_clip_gain");
    ac->setGainDB (juce::jlimit (-48.0f, 24.0f, (float) (double) args.getProperty ("gainDb", 0.0)));
    logLine ("set_clip_gain", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_clip_gain");
}

juce::var MoshOps::cmdWriteClipGainCurve (const juce::var& args)
{
    auto* clip = dynamic_cast<te::AudioClipBase*> (
        findClip (args.getProperty ("clipId", var()).toString()));
    if (clip == nullptr) return errResult ("write_clip_gain_curve", "not an audio clip");

    const auto parsed = parseClipGainCurvePoints (args.getProperty ("points", var()));
    if (! parsed.ok) return errResult ("write_clip_gain_curve", parsed.error);

    if (parsed.points.empty() && findClipGainEnvelopePlugin (*clip) == nullptr)
    {
        auto* data = new DynamicObject();
        data->setProperty ("pointCount", 0);
        return okResult ("write_clip_gain_curve", var (data));
    }

    beginTxn ("write_clip_gain_curve");
    if (const auto error = replaceClipGainEnvelope (*clip, parsed.points, undoManager());
        error.isNotEmpty())
    {
        undoManager().undoCurrentTransactionOnly();
        return errResult ("write_clip_gain_curve", error);
    }

    logLine ("write_clip_gain_curve", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject();
    data->setProperty ("pointCount", (int) parsed.points.size());
    return okResult ("write_clip_gain_curve", var (data));
}

// G4b — clip fades. String -> AudioFadeCurve::Type, default linear (mirrors the enum
// tracktion_AudioFadeCurve.h ships: linear=1, convex=2, concave=3, sCurve=4).
static te::AudioFadeCurve::Type fadeCurveFromName (const juce::String& name)
{
    if (name.equalsIgnoreCase ("convex"))  return te::AudioFadeCurve::convex;
    if (name.equalsIgnoreCase ("concave")) return te::AudioFadeCurve::concave;
    if (name.equalsIgnoreCase ("sCurve") || name.equalsIgnoreCase ("scurve")) return te::AudioFadeCurve::sCurve;
    return te::AudioFadeCurve::linear;
}

juce::var MoshOps::cmdSetClipFade (const juce::var& args)
{
    // Clip-edge fades (reality-pack inv 30: "affect edges without moving clip boundaries").
    // setFadeIn/setFadeOut (AudioClipBase.cpp) clamp to [0, clipLength] and rescale if
    // fadeIn+fadeOut exceeds the clip length — no boundary move, ever. Audio-clip-only,
    // mirrors set_clip_gain. Fades bind to the clip's own ValueTree via a plain
    // CachedValue.referTo(state, id, um) — the SAME undo/persistence path as clip gain,
    // so this is undoable + save/reload-durable with zero src/state schema change.
    auto* ac = dynamic_cast<te::AudioClipBase*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (ac == nullptr) return errResult ("set_clip_fade", "not an audio clip");
    beginTxn ("set_clip_fade");
    if (args.hasProperty ("fadeInSec"))
        ac->setFadeIn  (tracktion::TimeDuration::fromSeconds (juce::jmax (0.0, (double) args.getProperty ("fadeInSec",  0.0))));
    if (args.hasProperty ("fadeOutSec"))
        ac->setFadeOut (tracktion::TimeDuration::fromSeconds (juce::jmax (0.0, (double) args.getProperty ("fadeOutSec", 0.0))));
    if (args.hasProperty ("curveIn"))
        ac->setFadeInType  (fadeCurveFromName (args.getProperty ("curveIn",  "linear").toString()));
    if (args.hasProperty ("curveOut"))
        ac->setFadeOutType (fadeCurveFromName (args.getProperty ("curveOut", "linear").toString()));
    logLine ("set_clip_fade", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject();
    data->setProperty ("clipId", ac->itemID.toString());
    data->setProperty ("fadeInSec",  ac->getFadeIn().inSeconds());
    data->setProperty ("fadeOutSec", ac->getFadeOut().inSeconds());
    return okResult ("set_clip_fade", var (data));
}

// clip-ops wave — reverse / auto-crossfade / normalize. Mirrors cmdSetClipGain's
// shape exactly: audio-clip-only (AudioClipBase), one CachedValue flip, undoable
// via the clip's own ValueTree (no src/state schema change, free persistence).
juce::var MoshOps::cmdSetClipReverse (const juce::var& args)
{
    auto* ac = dynamic_cast<te::AudioClipBase*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (ac == nullptr) return errResult ("set_clip_reverse", "not an audio clip");
    beginTxn ("set_clip_reverse");
    ac->setIsReversed ((bool) args.getProperty ("reversed", false));
    logLine ("set_clip_reverse", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_clip_reverse");
}

// Auto-crossfade only has an audible effect when this clip OVERLAPS a neighbor on
// the same track (Tracktion auto-computes a triangular fade via getOverlappingClip);
// Mosh otherwise leaves it off, so overlapping clips sum at full volume (see the
// comment on cmdSetClipFade above). This just exposes the toggle.
juce::var MoshOps::cmdSetClipCrossfade (const juce::var& args)
{
    auto* ac = dynamic_cast<te::AudioClipBase*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (ac == nullptr) return errResult ("set_clip_crossfade", "not an audio clip");
    beginTxn ("set_clip_crossfade");
    ac->setAutoCrossfade ((bool) args.getProperty ("enabled", false));
    logLine ("set_clip_crossfade", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_clip_crossfade");
}

// CLP-LOOP — clip loop region (reality-pack invariant 28: "a clip can loop a defined
// sub-region of its source"). Audio-clip-only, mirrors cmdSetClipGain's shape exactly
// (AudioClipBase cast, Clip-scoped MP lock, one transaction, undoable, free persistence
// — loopStart/loopLength are CachedValues on the clip's own ValueTree, so no src/state
// schema change and save/reload is free).
//
// EXACT tracktion API (tracktion_AudioClipBase.h:246-270, pinned clone 2877b621):
//   void          setLoopRange (TimeRange)   — start/length in SECONDS
//   TimePosition  getLoopStart() const
//   TimeDuration  getLoopLength() const
//   bool          isLooping() const          — getAutoTempo() ? loopLengthBeats > 0
//                                                             : loopLength > 0
//
// ONE notion of "looping": there is no separate enabled flag in the engine — a clip
// loops iff its loop LENGTH is > 0, which is exactly what `isLooping()` reports and
// exactly what normalize_clip's `clipAudibleSourceSpan` (MoshOps.cpp, LOOPING branch)
// already keys off. So `enabled:false` writes an EMPTY range rather than inventing a
// second flag, and the snapshot's loopEnabled reads back through isLooping().
//
// Deliberately NOT AudioClipBase::disableLooping(): that helper also resizes the
// clip to one loop iteration. Toggling a loop off must not move or resize the clip.
// We do, however, have to materialise the currently audible loop phase into the
// source offset. Tracktion permits a looping clip to hold a virtual offset outside
// the loop range (including an exact EOF offset); leaving that value untouched when
// the wrapping loop is removed turns it into a literal source position and can make
// the clip silent.
//
// Tracktion clamps what it stores (setLoopRange: start ≤ sourceLength/speed, length ≤
// 50× sourceLength/speed; auto-tempo clips route to setLoopRangeBeats), so the result
// echoes the ACTUAL post-clamp values read back off the clip — never the raw request.
juce::var MoshOps::cmdSetClipLoop (const juce::var& args)
{
    // MIDI branch (Live 12: every MIDI clip can loop). loopStart/loopLength are
    // CONTENT-RELATIVE seconds, exactly like the wave path; TE converts to beats at
    // the clip's own tempo (setLoopRange). A zeroed range deactivates — notes play
    // once, clip length independent (Live's per-clip deactivate). Undo rides the
    // clip's own CachedValue undo manager inside our single transaction.
    if (auto* mc = dynamic_cast<te::MidiClip*> (findClip (args.getProperty ("clipId", var()).toString())))
    {
        const bool enabled = (bool) args.getProperty ("enabled", false);
        const double curStart  = mc->getLoopStart().inSeconds();
        const double curLength = mc->getLoopLength().inSeconds();
        const double start  = juce::jmax (0.0, (double) args.getProperty ("start", curStart));
        const double lengthDefault = curLength > 0.0 ? curLength : mc->getPosition().getLength().inSeconds();
        const double length = juce::jmax (0.0, (double) args.getProperty ("length", lengthDefault));
        if (enabled && ! (length > 0.0))
            return errResult ("set_clip_loop", "loop length must be greater than 0 when enabled");

        beginTxn ("set_clip_loop");
        if (enabled)
            mc->setLoopRange ({ tracktion::TimePosition::fromSeconds (start),
                                tracktion::TimeDuration::fromSeconds (length) });
        else
            mc->setLoopRangeBeats ({});   // empty range ⇒ isLooping() false (notes once)

        logLine ("set_clip_loop", args, true, {}, true);
        emitSnapshotInvalidated();
        reactiveTouch (mc->itemID.toString());   // Phase 3 — a looped source re-bounces

        auto* data = new DynamicObject();
        data->setProperty ("clipId", mc->itemID.toString());
        data->setProperty ("loopEnabled", mc->isLooping());
        // Echo the engine truth in BEATS (the snapshot's additive MIDI loop fields).
        data->setProperty ("midiLoopStartBeats", mc->getLoopStartBeats().inBeats());
        data->setProperty ("midiLoopLengthBeats", mc->getLoopLengthBeats().inBeats());
        return okResult ("set_clip_loop", var (data));
    }

    auto* ac = dynamic_cast<te::AudioClipBase*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (ac == nullptr) return errResult ("set_clip_loop", "not an audio clip");

    const bool enabled = (bool) args.getProperty ("enabled", false);

    // Resolve + validate BEFORE opening the transaction (an errResult must never leave
    // a half-open txn). Defaults when enabling without explicit bounds: keep any loop
    // range already on the clip, else loop the clip's whole current length from 0.
    const double curStart  = ac->getLoopStart().inSeconds();
    const double curLength = ac->getLoopLength().inSeconds();
    const double start  = juce::jmax (0.0, (double) args.getProperty ("start", curStart));
    const double lengthDefault = curLength > 0.0 ? curLength : ac->getPosition().getLength().inSeconds();
    const double length = juce::jmax (0.0, (double) args.getProperty ("length", lengthDefault));
    if (enabled && ! (length > 0.0))
        return errResult ("set_clip_loop", "loop length must be greater than 0 when enabled");

    // Resolve the audible phase before clearing the range. This is the floating-
    // point equivalent of LoopReader's negative-aware sample modulo. getLoopStart/
    // getLoopLength are expressed in seconds even for beat-based auto-tempo loops,
    // using the same clip-start tempo conversion as the stored offset.
    double materialisedOffset = 0.0;
    const bool materialisePhase = ! enabled && curLength > 0.0;
    if (materialisePhase)
        materialisedOffset = materialiseLoopSourceOffset (ac->getPosition().getOffset().inSeconds(),
                                                          curStart, curLength);

    beginTxn ("set_clip_loop");
    if (enabled)
        ac->setLoopRange ({ tracktion::TimePosition::fromSeconds (start),
                            tracktion::TimeDuration::fromSeconds (length) });
    else
    {
        ac->setLoopRange ({});   // empty range ⇒ isLooping() false
        if (materialisePhase)
            ac->setOffset (tracktion::TimeDuration::fromSeconds (materialisedOffset));
    }

    logLine ("set_clip_loop", args, true, {}, true);
    emitSnapshotInvalidated();

    auto* data = new DynamicObject();
    data->setProperty ("clipId", ac->itemID.toString());
    data->setProperty ("loopEnabled", ac->isLooping());
    data->setProperty ("loopStart",   ac->getLoopStart().inSeconds());
    data->setProperty ("loopLength",  ac->getLoopLength().inSeconds());
    return okResult ("set_clip_loop", var (data));
}

juce::var MoshOps::cmdNormalizeClip (const juce::var& args)
{
    // Non-destructive: reads the source's true peak sample via the SAME reader path
    // get_clip_peaks uses (no re-render, no source-file mutation), then sets the
    // clip's own gain — the identical AudioClipBase::setGainDB set_clip_gain uses —
    // so the peak lands at targetDb. Undo restores the prior gain exactly like
    // set_clip_gain. (newGainDb = targetDb - peakDb algebraically absorbs any gain
    // already on the clip, so "set" vs "add a delta" converge to the same result.)
    //
    // Scans only the clip's AUDIBLE span (clipAudibleSourceSpan), not the whole
    // source file: a clip trimmed to a quiet segment of a longer take must normalize
    // against the peak that actually plays, not a transient elsewhere in the take
    // that never sounds. Warped (auto-tempo) clips fall back to the whole file — see
    // clipAudibleSourceSpan's WARPED CAVEAT.
    auto* wave = dynamic_cast<te::WaveAudioClip*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (wave == nullptr) return errResult ("normalize_clip", "no wave clip");

    // A REVERSED clip's current source is a generated reversed proxy that may not exist
    // yet (proxy generation is async, and never runs headless) — createReaderFor would
    // return nullptr and normalize would spuriously fail. Peak level is reversal-
    // invariant, so read the ORIGINAL file instead, over its WHOLE span (the audible-
    // span offsets are mirrored under reversal; whole-file is the same conservative
    // fallback the WARPED CAVEAT below already takes). Found by fam_clip_reverse_normalize.
    const bool reversed = wave->getIsReversed();
    auto file = reversed ? wave->getOriginalFile() : wave->getCurrentSourceFile();
    juce::AudioFormatManager fm; fm.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader (fm.createReaderFor (file));
    if (reader == nullptr) return errResult ("normalize_clip", "cannot read source");

    const auto span = clipAudibleSourceSpan (*wave);
    const float peakLinear = (reversed || span.lengthSec < 0.0)
        ? findSourcePeak (*reader)
        : findSourcePeak (*reader,
                           (juce::int64) std::llround (span.startSec * reader->sampleRate),
                           (juce::int64) std::llround ((span.startSec + span.lengthSec) * reader->sampleRate));
    if (peakLinear <= 0.0f) return errResult ("normalize_clip", "clip is silent (peak 0) — nothing to normalize");

    const double targetDb = args.hasProperty ("targetDb") ? (double) args.getProperty ("targetDb", 0.0) : 0.0;
    const float peakDb = juce::Decibels::gainToDecibels (peakLinear);
    const float newGainDb = juce::jlimit (-48.0f, 24.0f, (float) targetDb - peakDb);

    beginTxn ("normalize_clip");
    wave->setGainDB (newGainDb);
    logLine ("normalize_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject();
    data->setProperty ("clipId", wave->itemID.toString());
    data->setProperty ("gainDb", (double) wave->getGainDB());
    data->setProperty ("peakDb", (double) peakDb);
    return okResult ("normalize_clip", var (data));
}

juce::var MoshOps::cmdRelinkClip (const juce::var& args)
{
    // gap 3 — relink-on-load: re-point a wave clip whose source went missing (a project
    // moved off-machine, audio renamed, etc.) to a user-chosen file. Stores the ref
    // relative iff the new file lives under the project dir (keeps a relinked-to-local
    // file portable), else absolute. Undoable.
    const auto id   = args.getProperty ("clipId", var()).toString();
    const auto path = args.getProperty ("file", var()).toString();
    if (path.isEmpty()) return errResult ("relink_clip", "missing 'file'");
    File newFile (path);
    if (! newFile.existsAsFile()) return errResult ("relink_clip", "file not found: " + path);
    auto* w = dynamic_cast<te::WaveAudioClip*> (findClip (id));
    if (w == nullptr) return errResult ("relink_clip", "wave clip not found: " + id);

    beginTxn ("relink_clip");
    // Relative ref iff the new file lives under the project dir (keeps a relinked-to-local
    // file portable), else absolute. repointWaveClipSource stores the relative form against
    // the edit file's PARENT dir — NOT setToDirectFileReference's edit-FILE-relative "../"
    // form, which (when the edit isn't yet on disk) escapes the session dir and would hang a
    // later offline export (the same mechanism PR #104 fixed for mp_commit_track).
    const bool local = newFile.isAChildOf (eng.editFile().getParentDirectory());
    repointWaveClipSource (*w, newFile, eng.editFile().getParentDirectory(), local);
    logLine ("relink_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("relink_clip");
}

// Minimum normalized-autocorrelation peak (0..1) for a detected BPM to be trusted
// over the map-tempo default. A pure tone / silence scores ~0 and falls back.
static constexpr double kBpmDetectConfidence = 0.10;

// Offline loop-BPM estimate from an audio file: build a coarse onset-energy
// envelope (positive first-difference of per-hop RMS), autocorrelate it across a
// musical tempo range, argmax. Pure + deterministic (no service) so it runs inside
// --selftest. Returns {bpm, confidence}; confidence is the normalized autocorrelation
// at the winning lag (0 == flat/no beat, up toward 1 == a strong periodic pulse).
static std::pair<double, double> detectBpmFromFile (const juce::File& file)
{
    juce::AudioFormatManager fm; fm.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader (fm.createReaderFor (file));
    if (reader == nullptr || reader->lengthInSamples <= 0 || reader->sampleRate <= 0.0)
        return { 0.0, 0.0 };

    const double sr = reader->sampleRate;
    const int chans = (int) reader->numChannels;
    // Analyse at most the first 30s — plenty for a loop, and it bounds the cost.
    const juce::int64 maxSamples = (juce::int64) juce::jmin ((double) reader->lengthInSamples, sr * 30.0);
    const int hop = juce::jmax (1, (int) std::llround (sr / 200.0)); // ~5ms hops → ~200 Hz envelope
    const int nHops = (int) (maxSamples / hop);
    if (nHops < 16) return { 0.0, 0.0 };

    // Per-hop RMS energy.
    std::vector<float> energy ((size_t) nHops, 0.0f);
    juce::AudioBuffer<float> buf (juce::jmax (1, chans), hop);
    for (int h = 0; h < nHops; ++h)
    {
        buf.clear();
        reader->read (&buf, 0, hop, (juce::int64) h * hop, true, chans > 1);
        double e = 0.0;
        for (int c = 0; c < buf.getNumChannels(); ++c)
        {
            const float* p = buf.getReadPointer (c);
            for (int i = 0; i < hop; ++i) e += (double) p[i] * (double) p[i];
        }
        energy[(size_t) h] = (float) std::sqrt (e / (double) juce::jmax (1, hop * juce::jmax (1, chans)));
    }

    // Onset function: positive first difference of the energy envelope, zero-meaned.
    std::vector<float> onset ((size_t) nHops, 0.0f);
    double mean = 0.0;
    for (int h = 1; h < nHops; ++h)
    {
        const float d = energy[(size_t) h] - energy[(size_t) h - 1];
        onset[(size_t) h] = d > 0.0f ? d : 0.0f;
        mean += (double) onset[(size_t) h];
    }
    mean /= (double) juce::jmax (1, nHops - 1);
    if (mean <= 1.0e-9) return { 0.0, 0.0 };  // silence / DC
    double var0 = 0.0;
    for (auto& v : onset) { v = (float) ((double) v - mean); var0 += (double) v * (double) v; }
    var0 /= (double) nHops;
    if (var0 <= 1.0e-12) return { 0.0, 0.0 };

    const double hopRate = sr / (double) hop; // hops per second
    auto autocorrAtLag = [&] (double lag) -> double
    {
        // Linear-interpolated autocorrelation at a fractional lag (in hops).
        const int L = (int) std::floor (lag);
        const double frac = lag - (double) L;
        double acc = 0.0; int cnt = 0;
        for (int i = 0; i + L + 1 < nHops; ++i)
        {
            const double shifted = (double) onset[(size_t) (i + L)] * (1.0 - frac)
                                 + (double) onset[(size_t) (i + L + 1)] * frac;
            acc += (double) onset[(size_t) i] * shifted;
            ++cnt;
        }
        return cnt > 0 ? acc / (double) cnt : 0.0;
    };

    // Scan a musical tempo range; the reported tempo stays in [70,180].
    double bestScore = -1.0e30, bestBpm = 0.0;
    for (double bpm = 70.0; bpm <= 180.0 + 1.0e-6; bpm += 0.5)
    {
        const double lag = 60.0 / bpm * hopRate;
        if (lag < 1.0 || lag >= (double) (nHops - 2)) continue;
        const double s = autocorrAtLag (lag);
        if (s > bestScore) { bestScore = s; bestBpm = bpm; }
    }
    if (bestBpm <= 0.0) return { 0.0, 0.0 };
    return { bestBpm, juce::jlimit (0.0, 1.0, bestScore / var0) };
}

juce::var MoshOps::cmdSetClipWarp (const juce::var& args)
{
    // Audio warp (auto-tempo): the clip re-anchors in BEATS so its audio
    // time-stretches to follow the tempo map. The position remap is IMMEDIATE
    // (getMaximumLength reads the live tempoSequence), so a tempo change visibly
    // re-lengths the clip in the next snapshot — fully headless-verifiable.
    // Stretching uses the engine's vendored SoundTouch (TRACKTION_ENABLE_
    // TIMESTRETCH_SOUNDTOUCH); free warp MARKERS are a deferred subsystem.
    auto* ac = dynamic_cast<te::AudioClipBase*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (ac == nullptr) return errResult ("set_clip_warp", "not an audio clip");
    if (! args.hasProperty ("autoTempo")) return errResult ("set_clip_warp", "missing 'autoTempo'");
    const bool on = (bool) args.getProperty ("autoTempo", false);

    beginTxn ("set_clip_warp");

    if (on)
    {
        // Stretch mode: the requested name, validated against what this build
        // compiles in (checkModeIsAvailable returns a usable fallback).
        auto mode = te::TimeStretcher::defaultMode;
        if (args.hasProperty ("mode"))
            mode = te::TimeStretcher::getModeFromName (eng.engine(),
                                                       args.getProperty ("mode", var()).toString());
        mode = te::TimeStretcher::checkModeIsAvailable (mode);
        ac->setTimeStretchMode (mode);

        // Source BPM: explicit when given; else default to the map tempo at the
        // clip's start, so enabling warp is a 1:1 no-op until the map changes.
        // With detect:true (and no explicit sourceBpm) we estimate the loop's own
        // BPM offline and lock it to the grid — the "easy" Ableton behaviour. This
        // is GUARDED so the default (detect absent) path stays byte-identical.
        double defaultBpm = eng.edit().tempoSequence.getBpmAt (ac->getPosition().getStart());
        if (! args.hasProperty ("sourceBpm") && (bool) args.getProperty ("detect", false))
            if (auto* wav = dynamic_cast<te::WaveAudioClip*> (ac))
            {
                const auto est = detectBpmFromFile (wav->getCurrentSourceFile());
                if (est.first > 0.0 && est.second >= kBpmDetectConfidence) defaultBpm = est.first;
            }
        const double sourceBpm = juce::jlimit (20.0, 999.0,
            (double) args.getProperty ("sourceBpm", defaultBpm));
        auto info = ac->getAudioFile().getInfo();
        ac->getLoopInfo().setBpm (sourceBpm, info);
    }
    ac->setAutoTempo (on);

    logLine ("set_clip_warp", args, true, {}, true);
    emitSnapshotInvalidated();
    auto* data = new DynamicObject();
    data->setProperty ("clipId", ac->itemID.toString());
    data->setProperty ("autoTempo", ac->getAutoTempo());
    data->setProperty ("stretchMode", te::TimeStretcher::getNameOfMode (ac->getTimeStretchMode()));
    return okResult ("set_clip_warp", var (data));
}

juce::var MoshOps::cmdStretchClip (const juce::var& args)
{
    // Time-stretch a wave clip to a target WARPED length (seconds) or a bar count,
    // by enabling auto-tempo and deriving the sourceBpm that makes it fit. Powers
    // the drag-to-stretch gesture and the Inspector "Fit N bars / ×2 / ÷2" helpers.
    // warpedLen = sourceLen × sourceBpm / projectBpm  ⇒  sourceBpm = projectBpm × target / sourceLen.
    auto* ac = dynamic_cast<te::AudioClipBase*> (findClip (args.getProperty ("clipId", var()).toString()));
    if (ac == nullptr) return errResult ("stretch_clip", "not an audio clip");
    if (! args.hasProperty ("length") && ! args.hasProperty ("bars"))
        return errResult ("stretch_clip", "missing 'length' or 'bars'");

    const double sourceLen = ac->getAudioFile().getLength();
    if (sourceLen <= 0.0) return errResult ("stretch_clip", "source has no length");

    auto& tempoSeq = eng.edit().tempoSequence;
    const auto startPos = ac->getPosition().getStart();
    const double projectBpm = tempoSeq.getBpmAt (startPos);
    if (projectBpm <= 0.0) return errResult ("stretch_clip", "invalid project tempo");

    double sourceBpm = 0.0;
    if (args.hasProperty ("bars"))
    {
        const double bars = (double) args.getProperty ("bars", 0.0);
        if (bars <= 0.0) return errResult ("stretch_clip", "'bars' must be > 0");
        const int beatsPerBar = juce::jmax (1, tempoSeq.getTimeSigAt (startPos).numerator.get());
        // The source should span exactly bars×beatsPerBar beats.
        sourceBpm = (bars * (double) beatsPerBar * 60.0) / sourceLen;
    }
    else
    {
        const double target = (double) args.getProperty ("length", sourceLen);
        if (target <= 0.0) return errResult ("stretch_clip", "'length' must be > 0");
        sourceBpm = projectBpm * target / sourceLen;
    }
    sourceBpm = juce::jlimit (20.0, 999.0, sourceBpm);
    const double warpedLen = sourceLen * sourceBpm / projectBpm;

    beginTxn ("stretch_clip");
    ac->setTimeStretchMode (te::TimeStretcher::checkModeIsAvailable (te::TimeStretcher::defaultMode));
    auto info = ac->getAudioFile().getInfo();
    ac->getLoopInfo().setBpm (sourceBpm, info);
    ac->setAutoTempo (true);
    // Fill the target span explicitly so the clip visibly stretches to the dragged
    // length (the whole source maps across warpedLen at this sourceBpm).
    ac->setPosition ({ { startPos, tracktion::TimeDuration::fromSeconds (warpedLen) },
                       ac->getPosition().getOffset() });

    logLine ("stretch_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    reactiveTouch (ac->itemID.toString());
    auto* data = new DynamicObject();
    data->setProperty ("clipId", ac->itemID.toString());
    data->setProperty ("sourceBpm", sourceBpm);
    data->setProperty ("length", ac->getPosition().getLength().inSeconds());
    return okResult ("stretch_clip", var (data));
}

juce::var MoshOps::cmdDetectClipBpm (const juce::var& args)
{
    // Read-only offline BPM estimate of a wave clip's source loop (no txn / log,
    // mirrors get_clip_peaks). Feeds the Inspector "Detect BPM" affordance.
    const auto id = args.getProperty ("clipId", var()).toString();
    auto* wave = dynamic_cast<te::WaveAudioClip*> (findClip (id));
    if (wave == nullptr) return errResult ("detect_clip_bpm", "no wave clip: " + id);

    const auto est = detectBpmFromFile (wave->getCurrentSourceFile());
    if (est.first <= 0.0) return errResult ("detect_clip_bpm", "cannot estimate BPM (unreadable or no pulse)");

    auto* data = new DynamicObject();
    data->setProperty ("clipId", id);
    data->setProperty ("bpm", est.first);
    data->setProperty ("confidence", est.second);
    return okResult ("detect_clip_bpm", var (data));
}

juce::var MoshOps::cmdDuplicateClip (const juce::var& args)
{
    auto* clip = findClip (args.getProperty ("clipId", var()).toString());
    if (clip == nullptr) return errResult ("duplicate_clip", "no clip");
    auto* track = dynamic_cast<te::ClipTrack*> (clip->getTrack());
    if (track == nullptr) return errResult ("duplicate_clip", "clip not on a clip track");

    auto pos = clip->getPosition();
    const double newStart = pos.getEnd().inSeconds();
    const double len = pos.getLength().inSeconds();
    ClipGainCurveWriteResult sourceGainCurve;
    bool hasSourceGainCurve = false;
    if (auto* sourceAudio = dynamic_cast<te::AudioClipBase*> (clip))
    {
        const auto points = clipGainEnvelopeToVar (*sourceAudio);
        if (! points.isVoid())
        {
            sourceGainCurve = parseClipGainCurvePoints (points);
            if (! sourceGainCurve.ok)
                return errResult ("duplicate_clip", "source clip gain curve is invalid: " + sourceGainCurve.error);
            hasSourceGainCurve = true;
        }
    }

    beginTxn ("duplicate_clip");
    te::Clip* dup = nullptr;
    if (auto* w = dynamic_cast<te::WaveAudioClip*> (clip))
    {
        auto nc = track->insertWaveClip (clip->getName(), w->getCurrentSourceFile(),
            { { tracktion::TimePosition::fromSeconds (newStart), pos.getLength() }, pos.getOffset() }, false);
        if (nc != nullptr)
        {
            nc->setGainDB (w->getGainDB());
            if (hasSourceGainCurve)
                if (const auto error = replaceClipGainEnvelope (*nc, sourceGainCurve.points, undoManager());
                    error.isNotEmpty())
                {
                    undoManager().undoCurrentTransactionOnly();
                    return errResult ("duplicate_clip", error);
                }
            dup = nc.get();
        }
    }
    else if (auto* m = dynamic_cast<te::MidiClip*> (clip))
    {
        auto nc = track->insertMIDIClip (clip->getName(),
            { tracktion::TimePosition::fromSeconds (newStart),
              tracktion::TimePosition::fromSeconds (newStart + len) }, nullptr);
        if (nc != nullptr)
        {
            auto& src = m->getSequence();
            auto& dst = nc->getSequence();
            for (int i = 0; i < src.getNumNotes(); ++i)
                if (auto* n = src.getNote (i))
                    dst.addNote (n->getNoteNumber(), n->getStartBeat(), n->getLengthBeats(),
                                 n->getVelocity(), 0, &undoManager());
            dup = nc.get();
        }
    }
    if (dup == nullptr) return errResult ("duplicate_clip", "could not duplicate this clip type");
    dup->setMuted (clip->isMuted());

    auto* data = new DynamicObject();
    data->setProperty ("newClipId", dup->itemID.toString());
    logLine ("duplicate_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("duplicate_clip", var (data));
}

// ARR-010: delete a time range [start, end] across one or more tracks as a
// SINGLE undoable transaction. For each targeted track we split every clip that
// straddles a bound (reusing ClipTrack::splitClip, the same primitive as
// split_clip) and then remove every clip segment that ends up fully inside the
// range (removeFromParent, the same primitive as remove_clip). Edge cases fall
// out of the geometry: a clip entirely inside is removed whole; a clip
// straddling only one bound is split once and the inside half removed (trim); a
// clip fully outside is never touched; an empty track / no-overlap range is a
// graceful no-op. trackIds defaults to every audio track.
//
// ARR-011 — the optional `ripple` flag (default FALSE, so the pre-existing lift/cut
// behaviour above is byte-identical when the arg is absent). When true, after the
// removal each targeted track's downstream clips slide LEFT by the range length to
// close the gap, inside this same transaction.
//
// RIPPLE SCOPE = the tracks this command already targets (`targets`), not "every
// track in the edit". That is the only choice consistent with the command's existing
// contract: delete_time_range ALREADY scopes its removal to `trackIds` (defaulting to
// all audio tracks), so rippling the same set keeps "what got cut" and "what got
// closed up" identical. Rippling all tracks on a trackIds-scoped call would shift
// clips on tracks the caller explicitly excluded — silently desyncing them from a
// deletion they never participated in. Note the DEFAULT (no trackIds) is already
// every audio track, so a whole-timeline ripple remains one call away.
juce::var MoshOps::cmdDeleteTimeRange (const juce::var& args)
{
    const double start = (double) args.getProperty ("start", 0.0);
    const double end   = (double) args.getProperty ("end",   0.0);
    if (! (start < end))
        return errResult ("delete_time_range", "start must be less than end");

    const bool ripple = (bool) args.getProperty ("ripple", false);

    auto& edit = eng.edit();

    // Resolve the target tracks. Bind the var array to a local before getArray()
    // so the temporary stays alive while we read it.
    juce::Array<te::AudioTrack*> targets;
    const auto trackIdsVar = args.getProperty ("trackIds", var());
    if (auto* ids = trackIdsVar.getArray())
    {
        for (auto& idv : *ids)
            if (auto* t = findTrack (idv.toString()))
                if (! targets.contains (t))
                    targets.add (t);
    }
    else
    {
        for (auto* t : te::getAudioTracks (edit))
            if (t != nullptr)
                targets.add (t);
    }

    const auto rStart = tracktion::TimePosition::fromSeconds (start);
    const auto rEnd   = tracktion::TimePosition::fromSeconds (end);

    beginTxn ("delete_time_range");

    int removed = 0, splits = 0;
    bool structurallyChanged = false;

    for (auto* track : targets)
    {
        if (track == nullptr) continue;
        auto* clipTrack = dynamic_cast<te::ClipTrack*> (track);
        if (clipTrack == nullptr) continue;

        // Phase 1 — split at the range bounds so every clip aligns to start/end.
        // Iterate a stable copy (split inserts a clip into the live list). Split at
        // the LATER bound (end) first so splitting at start doesn't shift which
        // clip the end falls inside; both splits use the same primitive as
        // split_clip (ClipTrack::splitClip). We re-read each clip's live position
        // before deciding (the bound must be strictly inside, mirroring split's own
        // reduced(0.001s).contains guard).
        for (const auto& bound : { rEnd, rStart })
        {
            juce::Array<te::Clip*> snap;
            for (auto* c : clipTrack->getClips())
                if (c != nullptr)
                    snap.add (c);

            for (auto* c : snap)
            {
                if (c == nullptr) continue;
                const auto p = c->getPosition();
                if (p.getStart() < bound && bound < p.getEnd())
                {
                    clipTrack->splitClip (*c, bound);
                    ++splits;
                    structurallyChanged = true;
                }
            }

            // Deliberately NO message-loop pump: splitClip's position writes are
            // synchronous ValueTree ops, visible immediately (AUD-001; patches/0005).
        }

        // Phase 2 — every clip now begins/ends on the range bounds. Remove the
        // segment(s) lying fully inside [start, end] (removeFromParent, the same
        // primitive as remove_clip). A clip entirely inside is caught here whole; a
        // clip straddling only one bound has been split and its inside half lands
        // fully inside; a clip fully outside never matches.
        juce::Array<te::Clip*> toRemove;
        for (auto* c : clipTrack->getClips())
            if (c != nullptr)
            {
                const auto p = c->getPosition();
                if (p.getStart() >= rStart - tracktion::TimeDuration::fromSeconds (0.0005)
                    && p.getEnd() <= rEnd + tracktion::TimeDuration::fromSeconds (0.0005))
                    toRemove.add (c);
            }
        for (auto* c : toRemove)
            if (c != nullptr)
            {
                c->removeFromParent();
                ++removed;
                structurallyChanged = true;
            }

        // Phase 3 (ARR-011, opt-in) — close the gap. Every clip now starting at or
        // after the range END slides LEFT by the range length. Phases 1+2 guarantee
        // nothing straddles rEnd any more, so this is a clean translation: no clip is
        // cut in half by the shift and the spacing downstream is preserved exactly.
        if (ripple)
            if (rippleShiftClipsAfter (*clipTrack, end, -(end - start)) > 0)
                structurallyChanged = true;
    }

    // Deliberately NO message-loop pump here: EditItemID assignment is synchronous
    // (edit.createNewItemID() runs inline), and a mid-command pump re-enters queued
    // async engine work — the AUD-001 use-after-free class (see patches/0005).

    auto* data = new DynamicObject();
    data->setProperty ("removed", removed);
    data->setProperty ("splits", splits);
    data->setProperty ("tracks", targets.size());
    data->setProperty ("ripple", ripple);
    logLine ("delete_time_range", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("delete_time_range", var (data));
}

// ── CAP-CLP-017 — insert_time ─────────────────────────────────────────────────
// Open `duration` seconds of empty timeline at `start` and push everything after it
// right. The inverse of a ripple delete, and the single most common arrangement edit
// there is ("I need another 8 before the chorus").
//
// WHAT MOVES — the whole point of this command, so it is written down rather than
// implied. An UNSCOPED call (no `trackIds`) moves all six:
//
//   1. CLIPS on every audio track. A clip straddling the insertion point is SPLIT there
//      first (ClipTrack::splitClip, the same primitive as split_clip / delete_time_range's
//      phase 1) so the space opens inside it rather than teleporting it; every clip then
//      starting at or after the point slides right by exactly `duration`.
//   2. AUTOMATION CURVES on every one of those tracks' plugin racks, AND on the MASTER
//      bus. Points at or after the insertion point move right; a hold point is written at
//      each edge of the new span so the value in force at the insertion point is held
//      FLAT across the inserted silence instead of a ramp being stretched through it.
//      This is the failure that is silent and unrecoverable if you get it wrong, so it
//      does not use hand-rolled arithmetic: it calls the engine's OWN insert-space
//      implementation (te::Track::insertSpaceIntoTrack), which is the code Tracktion's
//      insertSpaceIntoEdit uses. Master is reached explicitly because te::MasterTrack is
//      not a ClipTrack and insertSpaceIntoEdit therefore MISSES it — a real gap in the
//      engine helper, closed here.
//   3. TEMPO changes, TIME SIGNATURES and pitch changes on the tempo track
//      (te::TempoTrack::insertSpaceIntoTrack → tempoSequence/pitchSequence
//      insertSpaceIntoSequence).
//   4. Named SONG SECTIONS (MOSH_SECTIONS) — beat-anchored, so they shift by the number
//      of BEATS the inserted span occupies, measured across the tempo edit above.
//   5. Timeline ANNOTATIONS (MOSH_ANNOTATIONS) — same beat shift.
//   6. The transport LOOP REGION, via SetLoopRangeAction so it undoes with everything else.
//
// WHAT DOES NOT MOVE, named rather than left to be discovered:
//   • A SCOPED call (`trackIds` present) moves ONLY those tracks' clips and their own rack
//     automation. Tempo, sections, annotations, the loop and the master bus are
//     PROJECT-GLOBAL: shifting them for a partial insert would desync every track the
//     caller deliberately excluded. Same rationale as delete_time_range's ripple scope.
//   • Non-audio clip tracks (marker / chord / arranger). The target set is
//     te::getAudioTracks(), identical to delete_time_range's, so the two commands are
//     exact inverses. Mosh creates none of those track types; song structure lives in
//     MOSH_SECTIONS (4) instead.
//   • Automation inside a RackType, on a MacroParameter, or on a Modifier. Mosh has no
//     command or UI that authors any of those and never creates a rack; an edit that
//     acquired one elsewhere would keep its curves where they are.
//   • A lyric line's baked lyricScore blob, which carries an absolute `bar`. Inserting
//     time before it leaves that stale (LYR Phase-3 state; regenerate the skeleton).
//   • Multiplayer peers. insert_time does not broadcast, exactly like delete_time_range —
//     the same pre-existing hole in both, not a new one.
//
// ONE TRANSACTION. Every write above joins the single beginTxn("insert_time"), including
// the loop region. An insert that left half the timeline moved because it opened several
// transactions is not recoverable by ⌘Z, which is the worst possible failure for an edit
// this large.
juce::var MoshOps::cmdInsertTime (const juce::var& args)
{
    const double start    = (double) args.getProperty ("start", 0.0);
    const double duration = (double) args.getProperty ("duration", 0.0);
    if (start < 0.0)         return errResult ("insert_time", "start must be >= 0");
    if (! (duration > 0.0))  return errResult ("insert_time", "duration must be greater than 0");

    auto& edit = eng.edit();

    // Resolve the target tracks. Bind the var array to a local before getArray() so the
    // temporary stays alive while we read it (a pointer into a destroyed var temporary is
    // a use-after-free this codebase has already paid for once).
    juce::Array<te::AudioTrack*> targets;
    const auto trackIdsVar = args.getProperty ("trackIds", var());
    const bool scoped = trackIdsVar.isArray();
    if (auto* ids = trackIdsVar.getArray())
    {
        for (auto& idv : *ids)
            if (auto* t = findTrack (idv.toString()))
                if (! targets.contains (t))
                    targets.add (t);
    }
    else
    {
        for (auto* t : te::getAudioTracks (edit))
            if (t != nullptr)
                targets.add (t);
    }

    const auto at    = tracktion::TimePosition::fromSeconds (start);
    const auto space = tracktion::TimeDuration::fromSeconds (duration);
    auto& ts = edit.tempoSequence;

    // Captured BEFORE the tempo map is touched: the beat coordinate of the insertion
    // point. Beats before the point are unaffected by the insert (the tempo in force at
    // `start` does not change and the beat origin is 0), so this stays valid afterwards
    // and (beatsAt(start+duration) − this) is the exact beat width of the new space.
    const double beatAtStart = ts.toBeats (at).inBeats();

    beginTxn ("insert_time");

    // Tempo-track ORDERING, mirrored verbatim from te::insertSpaceIntoEdit: the tempo map
    // goes first UNLESS the edit's timecode format is bars/beats, in which case the
    // time-domain moves happen first and the map follows. Beat-anchored material (a
    // warp-locked clip) is repositioned implicitly by a tempo shift, so doing both in the
    // wrong order double-counts it. Following the engine's own choice keeps insert_time
    // behaviour-identical to the Insert Space it is built on.
    const bool tempoFirst = ! edit.getTimecodeFormat().isBarsBeats();
    const auto shiftTempoTrack = [&]
    {
        if (auto* tempoTrack = edit.getTempoTrack())
            tempoTrack->insertSpaceIntoTrack (at, space);   // base (automation) + tempo/pitch sequences
    };

    if (! scoped && tempoFirst)
        shiftTempoTrack();

    int splits = 0, clipsMoved = 0;

    for (auto* track : targets)
    {
        if (track == nullptr) continue;
        auto* clipTrack = dynamic_cast<te::ClipTrack*> (track);
        if (clipTrack == nullptr) continue;

        // Phase 1 — split every clip that straddles the insertion point, so nothing is cut
        // in half by the shift. Iterate a stable copy (splitClip inserts into the live
        // list) and re-read each clip's live position; the bound must be STRICTLY inside,
        // mirroring delete_time_range's phase 1 and split_clip's own guard.
        {
            juce::Array<te::Clip*> snap;
            for (auto* c : clipTrack->getClips())
                if (c != nullptr)
                    snap.add (c);

            for (auto* c : snap)
            {
                if (c == nullptr) continue;
                const auto p = c->getPosition();
                if (p.getStart() < at && at < p.getEnd())
                {
                    clipTrack->splitClip (*c, at);
                    ++splits;
                }
            }
            // Deliberately NO message-loop pump: splitClip's position writes are
            // synchronous ValueTree ops, visible immediately (AUD-001; patches/0005).
        }

        // Phase 2 — the AUTOMATION half of the engine's insert-space, and ONLY that half.
        // The qualified call reaches te::Track::insertSpaceIntoTrack directly instead of
        // te::ClipTrack's override, on purpose: the override's clip loop walks getClips()
        // BACKWARDS and `break`s at the first clip whose centre precedes the insertion
        // point, which is only correct if the clip list is sorted by start. In Tracktion
        // that sort is an ASYNC handleAsyncUpdate, and MoshOps never pumps the message loop
        // mid-command (AUD-001), so a track whose clips are in un-sorted ValueTree order —
        // trivially produced by moving one clip right and then adding another — would have
        // had its later clips silently left behind. Phase 3 below does the clip move with
        // the order-independent helper the ripple family already uses.
        clipTrack->te::Track::insertSpaceIntoTrack (at, space);

        // Phase 3 — the clip move. rippleShiftClipsAfter iterates a full stable copy with
        // no ordering assumption and no early break, and is the SAME primitive
        // delete_time_range's ripple and trim_clip's ripple use, so "insert 2s" and "ripple
        // delete 2s" are exact inverses of each other by construction.
        clipsMoved += rippleShiftClipsAfter (*clipTrack, start, duration);
    }

    if (! scoped && ! tempoFirst)
        shiftTempoTrack();

    int sectionsMoved = 0, annotationsMoved = 0;
    bool loopShifted = false;

    if (! scoped)
    {
        // MASTER-BUS automation. te::MasterTrack wraps getMasterPluginList() and is a
        // Track but NOT a ClipTrack, so Tracktion's own insertSpaceIntoEdit — which only
        // walks getTracksOfType<ClipTrack> plus the tempo track — never reaches it. A
        // master-bus filter sweep would have stayed put while the music under it moved.
        if (auto* master = edit.getMasterTrack())
            master->insertSpaceIntoTrack (at, space);   // MasterTrack adds no override → automation only

        // BEAT-ANCHORED Mosh state. Sections and annotations are stored in beats so they
        // survive tempo edits; the tempo map has just moved under them, so the shift is
        // measured in beats across that edit rather than derived from `duration`.
        constexpr double kBeatEps = 1.0e-6;
        const double beatDelta = ts.toBeats (at + space).inBeats() - beatAtStart;

        if (beatDelta > kBeatEps)
        {
            if (auto sections = edit.state.getChildWithName (ids::MOSH_SECTIONS); sections.isValid())
                for (int i = 0; i < sections.getNumChildren(); ++i)
                {
                    auto s = sections.getChild (i);
                    const auto sh = shiftSpanForInsert ((double) s[ids::sectionStartBeat],
                                                        (double) s[ids::sectionEndBeat],
                                                        beatAtStart, beatDelta, kBeatEps);
                    if (! sh.moved) continue;
                    s.setProperty (ids::sectionStartBeat, sh.lo, &undoManager());
                    s.setProperty (ids::sectionEndBeat,   sh.hi, &undoManager());
                    ++sectionsMoved;
                }

            if (auto anns = edit.state.getChildWithName (ids::MOSH_ANNOTATIONS); anns.isValid())
                for (int i = 0; i < anns.getNumChildren(); ++i)
                {
                    auto a = anns.getChild (i);
                    const double b = (double) a[ids::annotationBeat];
                    if (b < beatAtStart - kBeatEps) continue;
                    a.setProperty (ids::annotationBeat, b + beatDelta, &undoManager());
                    ++annotationsMoved;
                }
        }

        // The transport LOOP REGION. An empty range is the "no loop" state — leave it
        // alone rather than manufacturing a loop at `duration`.
        const auto loop = edit.getTransport().getLoopRange();
        if (loop.getLength().inSeconds() > 1.0e-6)
        {
            const auto sh = shiftSpanForInsert (loop.getStart().inSeconds(), loop.getEnd().inSeconds(),
                                                start, duration, 1.0e-6);
            if (sh.moved)
            {
                undoManager().perform (new SetLoopRangeAction (edit,
                    tracktion::TimeRange (tracktion::TimePosition::fromSeconds (sh.lo),
                                          tracktion::TimePosition::fromSeconds (sh.hi))));
                loopShifted = true;
            }
        }
    }

    auto* data = new DynamicObject();
    data->setProperty ("start", start);
    data->setProperty ("duration", duration);
    data->setProperty ("tracks", targets.size());
    data->setProperty ("splits", splits);
    data->setProperty ("clipsMoved", clipsMoved);
    data->setProperty ("sectionsMoved", sectionsMoved);
    data->setProperty ("annotationsMoved", annotationsMoved);
    data->setProperty ("loopShifted", loopShifted);
    data->setProperty ("scoped", scoped);
    logLine ("insert_time", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("insert_time", var (data));
}

// Recreate a clip from a clipToVar-shaped descriptor on a target track at a
// target time. This is the paste half of the UI-local copy/cut/paste clipboard
// (the clipboard itself is view state and never crosses the bridge until here).
// A genuine undoable edit: open a transaction and log undoable:true.
juce::var MoshOps::cmdPasteClip (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    if (trackId.isEmpty()) return errResult ("paste_clip", "missing 'trackId'");

    const auto clipVar = args.getProperty ("clip", var());
    if (! clipVar.isObject()) return errResult ("paste_clip", "missing 'clip'");

    const auto type = clipVar.getProperty ("type", var()).toString();
    if (type != "wave" && type != "midi")
        return errResult ("paste_clip", "unsupported clip type: " + type);

    // Validate cheap per-type preconditions BEFORE any side effect (transaction /
    // track auto-create) so a malformed descriptor errors out with zero side effects
    // (no orphan track left behind, no empty transaction opened).
    File waveSource;
    ClipGainCurveWriteResult pastedGainCurve;
    const bool hasPastedGainCurve = clipVar.hasProperty ("clipGainPoints");
    if (type == "wave")
    {
        const auto sourcePath = clipVar.getProperty ("sourceFile", var()).toString();
        if (sourcePath.isEmpty()) return errResult ("paste_clip", "wave clip missing 'sourceFile'");
        waveSource = File (sourcePath);
        if (! waveSource.existsAsFile()) return errResult ("paste_clip", "source file not found: " + sourcePath);
        if (hasPastedGainCurve)
        {
            pastedGainCurve = parseClipGainCurvePoints (clipVar.getProperty ("clipGainPoints", var()));
            if (! pastedGainCurve.ok)
                return errResult ("paste_clip", "clip gain curve is invalid: " + pastedGainCurve.error);
        }
    }

    auto* track = findTrack (trackId);

    beginTxn ("paste_clip");
    // Match cmdImportClip/cmdAddMidiClip: create the track if it's missing.
    if (track == nullptr)
        track = createAudioTrack ({});
    if (track == nullptr) return errResult ("paste_clip", "no track");

    const double start  = (double) args.getProperty ("start", 0.0);
    const double length = juce::jmax (0.0, (double) clipVar.getProperty ("length", 0.0));
    const double offset = (double) clipVar.getProperty ("offset", 0.0);
    auto name = clipVar.getProperty ("name", var()).toString();
    if (name.isEmpty()) name = (type == "midi") ? "MIDI" : "clip";

    te::Clip* pasted = nullptr;
    if (type == "wave")
    {
        auto nc = track->insertWaveClip (name, waveSource,
            { { tracktion::TimePosition::fromSeconds (start), tracktion::TimeDuration::fromSeconds (length) },
              tracktion::TimeDuration::fromSeconds (offset) }, false);
        if (nc == nullptr) return errResult ("paste_clip", "insertWaveClip failed");
        nc->setGainDB ((float) (double) clipVar.getProperty ("gainDb", 0.0));
        if (hasPastedGainCurve)
            if (const auto error = replaceClipGainEnvelope (*nc, pastedGainCurve.points, undoManager());
                error.isNotEmpty())
            {
                undoManager().undoCurrentTransactionOnly();
                return errResult ("paste_clip", error);
            }
        pasted = nc.get();
    }
    else // midi
    {
        auto nc = track->insertMIDIClip (name,
            { tracktion::TimePosition::fromSeconds (start),
              tracktion::TimePosition::fromSeconds (start + length) }, nullptr);
        if (nc == nullptr) return errResult ("paste_clip", "insertMIDIClip failed");

        auto& sequence = nc->getSequence();
        // Bind the notes array to a local before getArray(): a pointer into a
        // temporary var dangles (has bitten prior waves).
        const auto notesVar = clipVar.getProperty ("notes", var());
        if (notesVar.isArray())
            for (auto& n : *notesVar.getArray())
                sequence.addNote (juce::jlimit (0, 127, (int) n.getProperty ("pitch", 60)),
                                  tracktion::BeatPosition::fromBeats ((double) n.getProperty ("start", 0.0)),
                                  tracktion::BeatDuration::fromBeats (juce::jmax (0.0625, (double) n.getProperty ("length", 1.0))),
                                  juce::jlimit (1, 127, (int) n.getProperty ("velocity", 100)), 0, &undoManager());
        pasted = nc.get();
    }

    if (pasted == nullptr) return errResult ("paste_clip", "could not paste this clip type");
    pasted->setMuted ((bool) clipVar.getProperty ("mute", false));

    // Deliberately NO message-loop pump here: EditItemID assignment is synchronous
    // (edit.createNewItemID() runs inline), and a mid-command pump re-enters queued
    // async engine work — the AUD-001 use-after-free class (see patches/0005).

    ensureTrackMeter (*track);   // METER-001 — self-healing: covers both the auto-created and the resolved-existing case

    auto* data = new DynamicObject();
    data->setProperty ("clipId", pasted->itemID.toString());
    data->setProperty ("trackId", track->itemID.toString());
    logLine ("paste_clip", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("paste_clip", var (data));
}

} // namespace mosh
