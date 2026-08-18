// PAUSED (2026-08-11, indefinitely) — Finish-My-Song development is paused. See
// docs/FINISH_MY_SONG_ROADMAP.md for why and the bar to reopen; CLAUDE.md §Paused work.
// These commands ship and work; do not extend them without the owner reopening the
// program.
//
// RFC 001 (A-PR1) — MoshOps partial-class split: the lyric-domain command
// bodies (LYR-001 Finish-My-Song lyric sheet + skeleton/build-from-clip lane),
// moved VERBATIM from MoshOps.cpp. Same class, same member functions — only
// the translation unit changed. The dispatch if-chain and all transaction/
// log/result/emit plumbing stay in MoshOps.cpp (one mutation path, by
// construction). Cross-TU helpers live in MoshOpsInternal.h.

#include "MoshOps.h"
#include "MoshOpsInternal.h"
#include "state/Ids.h"
#include "state/Lyrics.h"
#include <thread>

namespace mosh
{
using namespace juce;

namespace
{
void clearLyricAnalysis (const juce::ValueTree& sheet)
{
    auto lines = mosh::LyricSheet::lines (sheet);
    for (int i = 0; i < lines.getNumChildren(); ++i)
        lines.getChild (i).removeProperty (ids::lyricAnalysis, nullptr);
}
}

// ── LYR-001 — Finish-My-Song lyric sheet (per-track MOSH_LYRICSHEET) ───────────

juce::var MoshOps::cmdCreateLyricSheet (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    auto* t = findTrack (trackId);
    if (t == nullptr) return errResult ("create_lyric_sheet", "no track: " + trackId);
    if (t->state.getChildWithName (ids::MOSH_LYRICSHEET).isValid())
        return errResult ("create_lyric_sheet", "track already has a lyric sheet");

    const auto grid     = args.getProperty ("grid", "1/16").toString();
    const auto language = args.getProperty ("language", "en").toString();

    beginTxn ("create_lyric_sheet");
    const auto sheetId = juce::Uuid().toString();
    auto sheet = mosh::LyricSheet::create (sheetId, grid, language);
    if (args.hasProperty ("topic"))    sheet.setProperty (ids::lyricTopic,    args.getProperty ("topic", var()), nullptr);
    if (args.hasProperty ("mood"))     sheet.setProperty (ids::lyricMood,     args.getProperty ("mood", var()), nullptr);
    if (args.hasProperty ("explicit")) sheet.setProperty (ids::lyricExplicit, args.getProperty ("explicit", var()), nullptr);
    t->state.appendChild (sheet, &undoManager());

    auto* data = new DynamicObject();
    data->setProperty ("sheetId", sheetId);
    data->setProperty ("trackId", trackId);
    logLine ("create_lyric_sheet", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("create_lyric_sheet", var (data));
}

juce::var MoshOps::cmdRemoveLyricSheet (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    auto* t = findTrack (trackId);
    if (t == nullptr) return errResult ("remove_lyric_sheet", "no track: " + trackId);
    auto sheet = t->state.getChildWithName (ids::MOSH_LYRICSHEET);
    if (! sheet.isValid()) return errResult ("remove_lyric_sheet", "track has no lyric sheet");

    beginTxn ("remove_lyric_sheet");
    t->state.removeChild (sheet, &undoManager());
    logLine ("remove_lyric_sheet", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_lyric_sheet");
}

juce::var MoshOps::cmdSetLyricConstraint (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    auto* t = findTrack (trackId);
    if (t == nullptr) return errResult ("set_lyric_constraint", "no track: " + trackId);
    auto sheet = t->state.getChildWithName (ids::MOSH_LYRICSHEET);
    if (! sheet.isValid()) return errResult ("set_lyric_constraint", "track has no lyric sheet");
    const auto analysisBefore = mosh::LyricSheet::analysisFingerprint (lyricSpecForTrack (*t));

    beginTxn ("set_lyric_constraint");
    if (args.hasProperty ("grid"))            sheet.setProperty (ids::lyricGrid,            args.getProperty ("grid", var()), &undoManager());
    if (args.hasProperty ("topic"))           sheet.setProperty (ids::lyricTopic,           args.getProperty ("topic", var()), &undoManager());
    if (args.hasProperty ("mood"))            sheet.setProperty (ids::lyricMood,            args.getProperty ("mood", var()), &undoManager());
    if (args.hasProperty ("explicit"))        sheet.setProperty (ids::lyricExplicit,        args.getProperty ("explicit", var()), &undoManager());
    if (args.hasProperty ("rhymeStrictness")) sheet.setProperty (ids::lyricRhymeStrictness, args.getProperty ("rhymeStrictness", var()), &undoManager());
    if (args.hasProperty ("styleBias"))       sheet.setProperty (ids::lyricStyleBias,       (bool) args.getProperty ("styleBias", false), &undoManager());
    if (analysisBefore != mosh::LyricSheet::analysisFingerprint (lyricSpecForTrack (*t)))
        clearLyricAnalysis (sheet);
    logLine ("set_lyric_constraint", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_lyric_constraint");
}

juce::var MoshOps::cmdSetLyricLine (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    auto* t = findTrack (trackId);
    if (t == nullptr) return errResult ("set_lyric_line", "no track: " + trackId);
    auto sheet = t->state.getChildWithName (ids::MOSH_LYRICSHEET);
    if (! sheet.isValid()) return errResult ("set_lyric_line", "track has no lyric sheet");
    auto lines = mosh::LyricSheet::lines (sheet);

    const int lineIndex = (int) args.getProperty ("lineIndex", -1);
    if (lineIndex < 0) return errResult ("set_lyric_line", "lineIndex required (>= 0)");
    if (lineIndex > lines.getNumChildren())
        return errResult ("set_lyric_line", "lineIndex out of range (lines are kept dense)");
    const auto analysisBefore = mosh::LyricSheet::analysisFingerprint (lyricSpecForTrack (*t));

    beginTxn ("set_lyric_line");
    auto line = lines.getChildWithProperty (ids::lyricIndex, lineIndex);
    if (! line.isValid())
    {
        // Append a new line at the next index (lineIndex == current count).
        const auto role = args.getProperty ("role", "verse").toString();
        line = mosh::LyricLine::create (juce::Uuid().toString(), lineIndex, role);
        lines.appendChild (line, &undoManager());
    }
    if (args.hasProperty ("text"))
    {
        // A hand edit on a VERBATIM-sung line demotes its provenance to "edited" —
        // we never claim an edited line as exactly what the producer sang.
        if (line[ids::lyricOrigin].toString() == "sung"
            && args.getProperty ("text", var()).toString() != line[ids::lyricText].toString())
            line.setProperty (ids::lyricOrigin, "edited", &undoManager());
        line.setProperty (ids::lyricText, args.getProperty ("text", var()), &undoManager());
    }
    if (args.hasProperty ("role"))            line.setProperty (ids::lyricRole,            args.getProperty ("role", var()), &undoManager());
    if (args.hasProperty ("seedText"))
    {
        // The LyricPanel editor commits hand edits as seedText (review find): on a line
        // whose text is already finalized (sung/accepted), a differing seed edit IS the
        // new effective lyric — mirror it into lyricText so the edit takes effect, and
        // demote a verbatim-"sung" line to "edited" (never claim it verbatim-his again).
        const auto newSeed = args.getProperty ("seedText", var()).toString();
        if (line[ids::lyricText].toString().isNotEmpty()
            && newSeed != line[ids::lyricText].toString())
        {
            if (line[ids::lyricOrigin].toString() == "sung")
                line.setProperty (ids::lyricOrigin, "edited", &undoManager());
            line.setProperty (ids::lyricText, newSeed, &undoManager());
        }
        line.setProperty (ids::lyricSeedText, args.getProperty ("seedText", var()), &undoManager());
    }
    if (args.hasProperty ("syllableTarget"))  line.setProperty (ids::lyricSyllableTarget,  (int) args.getProperty ("syllableTarget", 0), &undoManager());
    if (args.hasProperty ("syllableTol"))     line.setProperty (ids::lyricSyllableTol,     (int) args.getProperty ("syllableTol", 1), &undoManager());
    if (args.hasProperty ("stress"))          line.setProperty (ids::lyricStress,          args.getProperty ("stress", var()), &undoManager());
    if (args.hasProperty ("rhymeGroup"))      line.setProperty (ids::lyricRhymeGroup,      args.getProperty ("rhymeGroup", var()), &undoManager());
    if (args.hasProperty ("rhymeStrictness")) line.setProperty (ids::lyricRhymeStrictness, args.getProperty ("rhymeStrictness", var()), &undoManager());
    if (args.hasProperty ("locked"))          line.setProperty (ids::lyricLocked,          (bool) args.getProperty ("locked", false), &undoManager());
    if (args.hasProperty ("sectionId"))       line.setProperty (ids::lyricSectionId,       args.getProperty ("sectionId", var()), &undoManager());
    // A line carrying a seed/text is no longer "empty" (richer statuses arrive with the
    // generation loop in L2). EXCEPT a Phase-2 `skeleton` line: it carries an all-gaps seed
    // but must stay `skeleton` while the producer edits the grid (the +/- syllable stepper
    // goes through here) — confirm_skeleton does the skeleton→seed flip. (NOTE: `proposed` is
    // L2's "has proposals" status — distinct — so it's NOT preserved here.)
    const bool contentEdited = args.hasProperty ("text") || args.hasProperty ("seedText");
    if (contentEdited
        && line[ids::status].toString() != "skeleton"
        && (line[ids::lyricText].toString().isNotEmpty() || line[ids::lyricSeedText].toString().isNotEmpty()))
        line.setProperty (ids::status, "seed", &undoManager());

    // Analysis is sheet-wide: changing one line may change the rhyme anchor/grade of
    // another. Clear every cached blob only when an actual service input changed.
    if (analysisBefore != mosh::LyricSheet::analysisFingerprint (lyricSpecForTrack (*t)))
        clearLyricAnalysis (sheet);

    auto* data = new DynamicObject();
    data->setProperty ("lineIndex", lineIndex);
    data->setProperty ("lineId", line[ids::id].toString());
    logLine ("set_lyric_line", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("set_lyric_line", var (data));
}

juce::var MoshOps::cmdRemoveLyricLine (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    auto* t = findTrack (trackId);
    if (t == nullptr) return errResult ("remove_lyric_line", "no track: " + trackId);
    auto sheet = t->state.getChildWithName (ids::MOSH_LYRICSHEET);
    if (! sheet.isValid()) return errResult ("remove_lyric_line", "track has no lyric sheet");
    auto lines = mosh::LyricSheet::lines (sheet);

    const int lineIndex = (int) args.getProperty ("lineIndex", -1);
    auto line = lines.getChildWithProperty (ids::lyricIndex, lineIndex);
    if (! line.isValid()) return errResult ("remove_lyric_line", "no line at index " + juce::String (lineIndex));
    const auto analysisBefore = mosh::LyricSheet::analysisFingerprint (lyricSpecForTrack (*t));

    beginTxn ("remove_lyric_line");
    lines.removeChild (line, &undoManager());
    // Keep indices dense: renumber the surviving lines by their child order.
    for (int i = 0; i < lines.getNumChildren(); ++i)
        lines.getChild (i).setProperty (ids::lyricIndex, i, &undoManager());
    if (analysisBefore != mosh::LyricSheet::analysisFingerprint (lyricSpecForTrack (*t)))
        clearLyricAnalysis (sheet);
    logLine ("remove_lyric_line", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_lyric_line");
}

juce::var MoshOps::cmdGetRhymes (const juce::var& args)
{
    const auto word = args.getProperty ("word", var()).toString().trim();
    if (word.isEmpty()) return errResult ("get_rhymes", "word required");
    auto strictness = args.getProperty ("strictness", "slant").toString();
    if (strictness != "perfect" && strictness != "slant" && strictness != "free")
        strictness = "slant";
    const int syllables = (int) args.getProperty ("syllables", 0);
    const int maxN      = (int) args.getProperty ("maxN", 50);

    // Phonology read — a fast, deterministic SERVICE call (no LLM, not undoable, no
    // state change). Blocks briefly; this is an explicit on-demand lookup.
    auto res = jobManager.getRhymes (word, strictness, maxN, syllables);
    const bool ok = res.isObject() && (bool) res.getProperty ("ok", false);
    logLine ("get_rhymes", args, ok, ok ? juce::String() : juce::String ("phonology service unavailable"), false);
    if (! ok)
        return errResult ("get_rhymes", "phonology service unavailable (start the generative service)");
    return okResult ("get_rhymes", res);
}

juce::var MoshOps::lyricSheetToVar (te::AudioTrack& t)
{
    auto sheet = t.state.getChildWithName (ids::MOSH_LYRICSHEET);
    if (! sheet.isValid()) return {};

    auto* o = new DynamicObject();
    o->setProperty ("id",              sheet[ids::id].toString());
    o->setProperty ("grid",            sheet[ids::lyricGrid].toString());
    o->setProperty ("language",        sheet[ids::lyricLanguage].toString());
    o->setProperty ("topic",           sheet[ids::lyricTopic].toString());
    o->setProperty ("mood",            sheet[ids::lyricMood].toString());
    o->setProperty ("explicit",        sheet[ids::lyricExplicit].toString());
    o->setProperty ("rhymeStrictness", sheet[ids::lyricRhymeStrictness].toString());
    o->setProperty ("styleBias",       (bool) sheet[ids::lyricStyleBias]);
    o->setProperty ("specVersion",     (int) sheet[ids::lyricSpecVersion]);

    Array<var> lines;
    auto container = mosh::LyricSheet::lines (sheet);
    for (int i = 0; i < container.getNumChildren(); ++i)
    {
        auto l = container.getChild (i);
        auto* lo = new DynamicObject();
        lo->setProperty ("index",           (int) l[ids::lyricIndex]);
        lo->setProperty ("role",            l[ids::lyricRole].toString());
        lo->setProperty ("seedText",        l[ids::lyricSeedText].toString());
        lo->setProperty ("text",            l[ids::lyricText].toString());
        lo->setProperty ("syllableTarget",  (int) l[ids::lyricSyllableTarget]);
        lo->setProperty ("syllableTol",     (int) l[ids::lyricSyllableTol]);
        lo->setProperty ("stress",          l[ids::lyricStress].toString());
        lo->setProperty ("rhymeGroup",      l[ids::lyricRhymeGroup].toString());
        lo->setProperty ("rhymeStrictness", l[ids::lyricRhymeStrictness].toString());
        lo->setProperty ("locked",          (bool) l[ids::lyricLocked]);
        lo->setProperty ("sectionId",       l[ids::lyricSectionId].toString());
        lo->setProperty ("status",          l[ids::status].toString());
        const bool asserted = l[ids::status].toString() == "asserted"
                              && lyricTextIsCompleteForSing (l[ids::lyricText].toString());
        lo->setProperty ("asserted", asserted);
        lo->setProperty ("singable", lyricLineIsAssertedForSing (l));
        // L2 — transient ranked proposals (a JSON blob; absent ⇒ none) + regen counter.
        if (l.hasProperty (ids::lyricProposals))
        {
            auto parsed = juce::JSON::parse (l[ids::lyricProposals].toString());
            if (parsed.isArray()) lo->setProperty ("proposals", parsed);
        }
        if (l.hasProperty (ids::lyricRegen))
            lo->setProperty ("regen", (int) l[ids::lyricRegen]);
        // FMS Phase-3 — a BOOLEAN only (the blob itself stays out of the snapshot): the
        // sing drawer shows how many lines carry a flow from the take.
        lo->setProperty ("hasScore", l.hasProperty (ids::lyricScore));
        // Extraction provenance: the sung-vs-generated distinction for the UI; the heard
        // blob itself stays out of the snapshot (a boolean, like hasScore).
        if (l.hasProperty (ids::lyricOrigin))
            lo->setProperty ("origin", l[ids::lyricOrigin].toString());
        lo->setProperty ("hasHeard", l.hasProperty (ids::lyricHeard));
        // L1 — transient precise phonology (a JSON object; absent ⇒ not yet analysed).
        if (l.hasProperty (ids::lyricAnalysis))
        {
            auto parsed = juce::JSON::parse (l[ids::lyricAnalysis].toString());
            if (parsed.isObject()) lo->setProperty ("analysis", parsed);
        }
        lines.add (var (lo));
    }
    o->setProperty ("lines", lines);
    return var (o);
}

// ── LYR-L2 — the generation loop (propose → validate → retry → rank), fake-first ──

juce::var MoshOps::lyricSpecForTrack (te::AudioTrack& t)
{
    auto sheet = t.state.getChildWithName (ids::MOSH_LYRICSHEET);
    if (! sheet.isValid()) return {};
    const bool styleBias = (bool) sheet[ids::lyricStyleBias];
    auto* o = new DynamicObject();
    o->setProperty ("grid",            sheet[ids::lyricGrid].toString());
    o->setProperty ("topic",           sheet[ids::lyricTopic].toString());
    o->setProperty ("mood",            sheet[ids::lyricMood].toString());
    o->setProperty ("explicit",        sheet[ids::lyricExplicit].toString());
    o->setProperty ("rhymeStrictness", sheet[ids::lyricRhymeStrictness].toString());
    o->setProperty ("styleBias",       styleBias);
    Array<var> lines;
    Array<var> styleCorpus;   // §7 — the artist's OWN finalized lines = the voice corpus
    auto container = mosh::LyricSheet::lines (sheet);
    for (int i = 0; i < container.getNumChildren(); ++i)
    {
        auto l = container.getChild (i);
        auto* lo = new DynamicObject();
        lo->setProperty ("index",           (int) l[ids::lyricIndex]);
        lo->setProperty ("role",            l[ids::lyricRole].toString());
        lo->setProperty ("seedText",        l[ids::lyricSeedText].toString());
        lo->setProperty ("text",            l[ids::lyricText].toString());
        lo->setProperty ("syllableTarget",  (int) l[ids::lyricSyllableTarget]);
        lo->setProperty ("syllableTol",     (int) l[ids::lyricSyllableTol]);
        lo->setProperty ("stress",          l[ids::lyricStress].toString());
        lo->setProperty ("rhymeGroup",      l[ids::lyricRhymeGroup].toString());
        lo->setProperty ("rhymeStrictness", l[ids::lyricRhymeStrictness].toString());
        lo->setProperty ("locked",          (bool) l[ids::lyricLocked]);
        lines.add (var (lo));
        const auto finalized = l[ids::lyricText].toString();
        if (styleBias && finalized.trim().isNotEmpty())
            styleCorpus.add (finalized);   // user-owned only; passed inline (no persistence)
    }
    o->setProperty ("lines", lines);
    if (styleBias)
        o->setProperty ("styleCorpus", styleCorpus);
    return var (o);
}

juce::var MoshOps::lyricRegenForTrack (te::AudioTrack& t)
{
    auto sheet = t.state.getChildWithName (ids::MOSH_LYRICSHEET);
    auto* o = new DynamicObject();
    if (sheet.isValid())
    {
        auto container = mosh::LyricSheet::lines (sheet);
        for (int i = 0; i < container.getNumChildren(); ++i)
        {
            auto l = container.getChild (i);
            if (l.hasProperty (ids::lyricRegen) && (int) l[ids::lyricRegen] > 0)
                o->setProperty (juce::Identifier (l[ids::lyricIndex].toString()), (int) l[ids::lyricRegen]);
        }
    }
    return var (o);
}

juce::var MoshOps::runLyricGeneration (const juce::String& cmdName, const juce::String& mode,
                                       const juce::String& trackId, int lineIndex, int afterIndex,
                                       const juce::var& args)
{
    auto* t = findTrack (trackId);
    if (t == nullptr) return errResult (cmdName, "no track: " + trackId);
    if (! t->state.getChildWithName (ids::MOSH_LYRICSHEET).isValid())
        return errResult (cmdName, "track has no lyric sheet");

    const auto spec  = lyricSpecForTrack (*t);
    const auto regen = lyricRegenForTrack (*t);

    // Land proposals (a JSON blob per line) on the message thread; re-look-up the sheet
    // (it may have changed) and write only lines the service returned. NON-undoable
    // (ephemeral generation output); accept/reject is the user's commit.
    auto land = [this, cmdName, trackId] (const juce::var& result) -> juce::var
    {
        auto* tt = findTrack (trackId);
        auto sheet = tt != nullptr ? tt->state.getChildWithName (ids::MOSH_LYRICSHEET) : juce::ValueTree();
        if (! sheet.isValid()) return errResult (cmdName, "lyric sheet gone");
        if (! result.isObject() || ! (bool) result.getProperty ("ok", false))
            return errResult (cmdName, "lyric service unavailable (start the generative service)");
        auto lines = mosh::LyricSheet::lines (sheet);
        auto resLines = result.getProperty ("lines", var());
        int n = 0;
        if (resLines.isArray())
            for (auto& rl : *resLines.getArray())
            {
                auto node = lines.getChildWithProperty (ids::lyricIndex, (int) rl.getProperty ("index", -1));
                if (! node.isValid()) continue;
                node.setProperty (ids::lyricProposals, juce::JSON::toString (rl.getProperty ("proposals", var())), nullptr);
                node.setProperty (ids::status, "proposed", nullptr);
                ++n;
            }
        emitSnapshotInvalidated();
        auto* d = new DynamicObject(); d->setProperty ("status", "proposed"); d->setProperty ("lineCount", n);
        return okResult (cmdName, var (d));
    };

    logLine (cmdName, args, true, {}, false);

    // Synchronous (harness / agent): block on generation + land inline.
    if ((bool) args.getProperty ("wait", false))
        return land (jobManager.generateLyrics (mode, spec, lineIndex, afterIndex, regen));

    // Async (GUI): generate off the message thread; land via callAsync, skipping if a
    // cancel bumped the epoch in the meantime.
    const int epoch = ++lyricGenEpoch_;   // capture; a later launch or cancel supersedes
    std::thread ([this, mode, spec, lineIndex, afterIndex, regen, land, epoch]
    {
        auto result = jobManager.generateLyrics (mode, spec, lineIndex, afterIndex, regen);
        juce::MessageManager::callAsync ([this, land, result, epoch]
        {
            if (epoch != lyricGenEpoch_) return;   // cancelled / superseded
            land (result);
        });
    }).detach();

    auto* d = new DynamicObject(); d->setProperty ("status", "generating");
    return okResult (cmdName, var (d));
}

juce::var MoshOps::cmdCompleteLyrics (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    return runLyricGeneration ("complete_lyrics", "complete", trackId, -1, -1, args);
}

juce::var MoshOps::cmdFillLyricGap (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    const int lineIndex = (int) args.getProperty ("lineIndex", -1);
    return runLyricGeneration ("fill_lyric_gap", "fill", trackId, lineIndex, -1, args);
}

juce::var MoshOps::cmdSuggestNextLine (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    const int afterIndex = (int) args.getProperty ("afterIndex", -1);
    return runLyricGeneration ("suggest_next_line", "next", trackId, -1, afterIndex, args);
}

juce::var MoshOps::cmdRegenerateLyric (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    const int lineIndex = (int) args.getProperty ("lineIndex", -1);
    auto* t = findTrack (trackId);
    if (t == nullptr) return errResult ("regenerate_lyric", "no track: " + trackId);
    auto sheet = t->state.getChildWithName (ids::MOSH_LYRICSHEET);
    if (! sheet.isValid()) return errResult ("regenerate_lyric", "track has no lyric sheet");
    auto node = mosh::LyricSheet::lines (sheet).getChildWithProperty (ids::lyricIndex, lineIndex);
    if (! node.isValid()) return errResult ("regenerate_lyric", "no line at index " + juce::String (lineIndex));
    // Bump the line's regen counter (non-undoable) so the service draws a fresh sample.
    node.setProperty (ids::lyricRegen, (int) node.getProperty (ids::lyricRegen, 0) + 1, nullptr);
    return runLyricGeneration ("regenerate_lyric", "fill", trackId, lineIndex, -1, args);
}

juce::var MoshOps::cmdCancelLyricJob (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    ++lyricGenEpoch_;   // any in-flight async land for the prior epoch is skipped
    logLine ("cancel_lyric_job", args, true, {}, false);
    return okResult ("cancel_lyric_job");
}

juce::var MoshOps::cmdAcceptLyricProposal (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    const int lineIndex = (int) args.getProperty ("lineIndex", -1);
    const int proposalIndex = (int) args.getProperty ("proposalIndex", 0);
    auto* t = findTrack (trackId);
    if (t == nullptr) return errResult ("accept_lyric_proposal", "no track: " + trackId);
    auto sheet = t->state.getChildWithName (ids::MOSH_LYRICSHEET);
    if (! sheet.isValid()) return errResult ("accept_lyric_proposal", "track has no lyric sheet");
    auto node = mosh::LyricSheet::lines (sheet).getChildWithProperty (ids::lyricIndex, lineIndex);
    if (! node.isValid()) return errResult ("accept_lyric_proposal", "no line at index " + juce::String (lineIndex));
    auto props = juce::JSON::parse (node.getProperty (ids::lyricProposals, "").toString());
    if (! props.isArray() || proposalIndex < 0 || proposalIndex >= props.size())
        return errResult ("accept_lyric_proposal", "no proposal at that index");
    const auto chosen = props[proposalIndex].getProperty ("text", var()).toString();
    if (! lyricTextIsCompleteForSing (chosen))
        return errResult ("accept_lyric_proposal", "proposal has unresolved words");
    const auto analysisBefore = mosh::LyricSheet::analysisFingerprint (lyricSpecForTrack (*t));

    beginTxn ("accept_lyric_proposal");
    node.setProperty (ids::lyricText, chosen, &undoManager());     // the COMMIT (undoable)
    node.setProperty (ids::status, "asserted", &undoManager());
    node.removeProperty (ids::lyricProposals, nullptr);            // clear the ephemeral proposals
    // Provenance (honest by construction): "mixed" only when a heard-kept word actually
    // SURVIVES in the accepted text (review find: the blob alone proves what the take
    // said, not what this proposal kept — a regenerated line that dropped his anchors
    // must land "generated").
    {
        bool heardKept = false;
        if (node.hasProperty (ids::lyricHeard))
        {
            auto tokens = juce::StringArray::fromTokens (chosen.toLowerCase(), " \t", {});
            for (auto& t : tokens)
                t = t.trimCharactersAtStart (".,!?'\"-").trimCharactersAtEnd (".,!?'\"-");
            auto hb = juce::JSON::parse (node[ids::lyricHeard].toString());
            if (auto* ws = hb.getProperty ("words", var()).getArray())
                for (auto& w : *ws)
                    if ((bool) w.getProperty ("kept", false)
                        && tokens.contains (w.getProperty ("word", var()).toString()
                                                .toLowerCase()
                                                .trimCharactersAtStart (".,!?'\"-")
                                                .trimCharactersAtEnd (".,!?'\"-")))
                    { heardKept = true; break; }
        }
        node.setProperty (ids::lyricOrigin, heardKept ? "mixed" : "generated", &undoManager());
    }
    if (analysisBefore != mosh::LyricSheet::analysisFingerprint (lyricSpecForTrack (*t)))
        clearLyricAnalysis (sheet);
    logLine ("accept_lyric_proposal", args, true, {}, true);       // explicit TASTE label (positive)
    emitSnapshotInvalidated();

    // §7 style-RAG flywheel — auto-accumulate the accepted line into the PERSISTED
    // cross-song voice corpus so future songs sound more like the artist. Fire-and-forget
    // on a detached thread: styleCorpusAdd is NON-SPAWNING (isHealthy-gated) + best-effort,
    // so accept NEVER blocks/fails on it and a service-down state is a silent no-op (keeps
    // --selftest hermetic). NON-undoable by design: undo pulls the text from the sheet but
    // not the corpus — acceptable, the corpus is a "lines I liked" accumulation (add_lines
    // dedups + the near-verbatim guard handles redundancy). Mirrors cmdAnalyzeLyrics's
    // detached-thread idiom.
    if (chosen.trim().isNotEmpty())
    {
        const juce::String line = chosen;
        std::thread ([this, line]
        {
            jobManager.styleCorpusAdd (juce::StringArray { line }, "accept");
        }).detach();
    }

    auto* d = new DynamicObject(); d->setProperty ("text", chosen);
    return okResult ("accept_lyric_proposal", var (d));
}

juce::var MoshOps::cmdAssertLyricLine (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    const int lineIndex = (int) args.getProperty ("lineIndex", -1);
    auto* t = findTrack (trackId);
    if (t == nullptr) return errResult ("assert_lyric_line", "no track: " + trackId);
    auto sheet = t->state.getChildWithName (ids::MOSH_LYRICSHEET);
    if (! sheet.isValid()) return errResult ("assert_lyric_line", "track has no lyric sheet");
    auto node = mosh::LyricSheet::lines (sheet).getChildWithProperty (ids::lyricIndex, lineIndex);
    if (! node.isValid()) return errResult ("assert_lyric_line", "no line at index " + juce::String (lineIndex));

    const auto assertedText = args.hasProperty ("text")
        ? args.getProperty ("text", var()).toString()
        : node[ids::lyricText].toString();
    if (! lyricTextIsCompleteForSing (assertedText))
        return errResult ("assert_lyric_line", "line needs complete words before it can be asserted");
    const auto analysisBefore = mosh::LyricSheet::analysisFingerprint (lyricSpecForTrack (*t));

    beginTxn ("assert_lyric_line");
    node.setProperty (ids::lyricText, assertedText.trim(), &undoManager());
    node.setProperty (ids::status, "asserted", &undoManager());
    node.removeProperty (ids::lyricProposals, nullptr);
    if (analysisBefore != mosh::LyricSheet::analysisFingerprint (lyricSpecForTrack (*t)))
        clearLyricAnalysis (sheet);
    logLine ("assert_lyric_line", args, true, {}, true);
    emitSnapshotInvalidated();

    auto* d = new DynamicObject(); d->setProperty ("text", assertedText.trim());
    return okResult ("assert_lyric_line", var (d));
}

juce::var MoshOps::cmdRejectLyricProposal (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    const int lineIndex = (int) args.getProperty ("lineIndex", -1);
    auto* t = findTrack (trackId);
    if (t == nullptr) return errResult ("reject_lyric_proposal", "no track: " + trackId);
    auto sheet = t->state.getChildWithName (ids::MOSH_LYRICSHEET);
    if (! sheet.isValid()) return errResult ("reject_lyric_proposal", "track has no lyric sheet");
    auto node = mosh::LyricSheet::lines (sheet).getChildWithProperty (ids::lyricIndex, lineIndex);
    if (! node.isValid()) return errResult ("reject_lyric_proposal", "no line at index " + juce::String (lineIndex));
    node.removeProperty (ids::lyricProposals, nullptr);
    node.setProperty (ids::status, node[ids::lyricText].toString().isNotEmpty()
                                       || node[ids::lyricSeedText].toString().isNotEmpty() ? "seed" : "empty", nullptr);
    logLine ("reject_lyric_proposal", args, true, {}, false);      // TASTE label (negative)
    emitSnapshotInvalidated();
    return okResult ("reject_lyric_proposal");
}

// LYR-L1 — precise per-line phonology for the flow visualizer. Service-backed (no LLM),
// idempotent + read-only: the analysis is a recomputable JSON blob landed per line →
// snapshot. NON-undoable. A sheet-spec fingerprint prevents a late result from attaching
// old words/gaps/rhyme anchors after the producer edits while the request is in flight.
juce::var MoshOps::cmdAnalyzeLyrics (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    auto* t = findTrack (trackId);
    if (t == nullptr) return errResult ("analyze_lyrics", "no track: " + trackId);
    if (! t->state.getChildWithName (ids::MOSH_LYRICSHEET).isValid())
        return errResult ("analyze_lyrics", "track has no lyric sheet");

    const auto spec = lyricSpecForTrack (*t);
    const auto specFingerprint = mosh::LyricSheet::analysisFingerprint (spec);

    auto land = [this, trackId, specFingerprint] (const juce::var& result) -> juce::var
    {
        auto* tt = findTrack (trackId);
        auto sheet = tt != nullptr ? tt->state.getChildWithName (ids::MOSH_LYRICSHEET) : juce::ValueTree();
        if (! sheet.isValid()) return errResult ("analyze_lyrics", "lyric sheet gone");
        if (specFingerprint != mosh::LyricSheet::analysisFingerprint (lyricSpecForTrack (*tt)))
        {
            auto* d = new DynamicObject();
            d->setProperty ("status", "stale");
            d->setProperty ("lineCount", 0);
            return okResult ("analyze_lyrics", var (d));
        }
        if (! result.isObject() || ! (bool) result.getProperty ("ok", false))
            return errResult ("analyze_lyrics", "lyric service unavailable (start the generative service)");
        auto lines = mosh::LyricSheet::lines (sheet);
        auto resLines = result.getProperty ("lines", var());
        int n = 0;
        if (resLines.isArray())
            for (auto& rl : *resLines.getArray())
            {
                auto node = lines.getChildWithProperty (ids::lyricIndex, (int) rl.getProperty ("index", -1));
                if (! node.isValid()) continue;
                node.setProperty (ids::lyricAnalysis, juce::JSON::toString (rl.getProperty ("analysis", var())), nullptr);
                ++n;
            }
        emitSnapshotInvalidated();
        auto* d = new DynamicObject(); d->setProperty ("status", "analyzed"); d->setProperty ("lineCount", n);
        return okResult ("analyze_lyrics", var (d));
    };

    logLine ("analyze_lyrics", args, true, {}, false);

    if ((bool) args.getProperty ("wait", false))
        return land (jobManager.analyzeLyrics (spec));

    std::thread ([this, spec, land]
    {
        auto result = jobManager.analyzeLyrics (spec);
        juce::MessageManager::callAsync ([land, result] { land (result); });
    }).detach();

    auto* d = new DynamicObject(); d->setProperty ("status", "analyzing");
    return okResult ("analyze_lyrics", var (d));
}

// §7 — read-only corpus size ("N lines in your voice"). NON-SPAWNING (styleCorpusStats is
// isHealthy-gated) → returns lines:-1 when the service is down (the UI shows nothing). Counts
// only; the corpus content is never exposed (the backend-only safety wall).
juce::var MoshOps::cmdGetLyricCorpusStats (const juce::var& args)
{
    const int lines = jobManager.styleCorpusStats();
    auto* d = new DynamicObject(); d->setProperty ("lines", lines);
    return okResult ("get_lyric_corpus_stats", var (d));
}

// LYR Phase 3 — audio "mumble take". A recorded vocal take → Basic Pitch note onsets (the
// reliable RHYTHM) + Whisper confidence-gated words → a lyric constraint sheet on the clip's
// OWN track, so the producer doesn't hand-type the flow; the L2/L3 loop fills the gaps.
// Mirrors cmdTranscribeClip's async-on-the-snapshot-rail shape (clip-scoped, service-spawning).
juce::var MoshOps::cmdBuildLyricsFromClip (const juce::var& args)
{
    const auto clipId = args.getProperty ("clipId", var()).toString();
    const double confThreshold = (double) args.getProperty ("confThreshold", 0.6);

    auto* w = dynamic_cast<te::WaveAudioClip*> (findClip (clipId));
    if (w == nullptr) return errResult ("build_lyrics_from_clip", "no wave clip with that id");
    const auto srcFile = w->getCurrentSourceFile();
    if (! srcFile.existsAsFile()) return errResult ("build_lyrics_from_clip", "clip has no readable source audio");

    auto* track = dynamic_cast<te::AudioTrack*> (w->getTrack());
    if (track == nullptr) return errResult ("build_lyrics_from_clip", "clip is not on an audio track");
    const auto trackId = track->itemID.toString();
    if (track->state.getChildWithName (ids::MOSH_LYRICSHEET).isValid())
        return errResult ("build_lyrics_from_clip", "track already has a lyric sheet");

    auto& edit = eng.edit();
    auto* tempo = edit.tempoSequence.getNumTempos() > 0 ? edit.tempoSequence.getTempo (0) : nullptr;
    const double bpm = tempo != nullptr ? tempo->getBpm() : 120.0;
    auto* tsig = edit.tempoSequence.getNumTimeSigs() > 0 ? edit.tempoSequence.getTimeSig (0) : nullptr;
    const int tsNum = tsig != nullptr ? tsig->numerator.get() : 4;
    const int tsDen = tsig != nullptr ? tsig->denominator.get() : 4;

    // Land the built spec as a MOSH_LYRICSHEET on the clip's OWN track in ONE undo txn —
    // written via the state helpers directly (re-invoking create/set sub-commands would make
    // N undo steps + emit nested logs/events). Always on the message thread.
    auto land = [this, clipId, trackId] (const juce::var& spec) -> juce::var
    {
        auto* tt = findTrack (trackId);
        if (tt == nullptr) return errResult ("build_lyrics_from_clip", "track gone");
        if (tt->state.getChildWithName (ids::MOSH_LYRICSHEET).isValid())
            return errResult ("build_lyrics_from_clip", "track already has a lyric sheet");

        auto linesVar = spec.isObject() ? spec.getProperty ("lines", var()) : var();
        if (! spec.isObject() || ! (bool) spec.getProperty ("ok", false) || ! linesVar.isArray() || linesVar.size() == 0)
        {
            const auto err = spec.isObject() ? spec.getProperty ("error", var()).toString() : juce::String();
            const auto msg = err == "no_melody_detected" ? juce::String ("no melody detected in the take")
                           : err.isNotEmpty() ? err : juce::String ("lyric service unavailable (start the generative service)");
            emit ("build_lyrics_status", [&] { auto* o = new DynamicObject();
                o->setProperty ("clipId", clipId); o->setProperty ("state", "error");
                o->setProperty ("error", msg); return var (o); }());
            return errResult ("build_lyrics_from_clip", msg);
        }

        beginTxn ("build_lyrics_from_clip");
        const auto sheetId = juce::Uuid().toString();
        auto sheet = mosh::LyricSheet::create (sheetId, spec.getProperty ("grid", "1/16").toString());
        if (spec.getProperty ("topic", var()).toString().isNotEmpty())
            sheet.setProperty (ids::lyricTopic, spec.getProperty ("topic", var()), nullptr);
        auto container = mosh::LyricSheet::lines (sheet);
        for (auto& lv : *linesVar.getArray())
        {
            auto line = mosh::LyricLine::create (juce::Uuid().toString(),
                                                 (int) lv.getProperty ("index", 0),
                                                 lv.getProperty ("role", "verse").toString());
            line.setProperty (ids::lyricSeedText,       lv.getProperty ("seedText", var()), nullptr);
            line.setProperty (ids::lyricSyllableTarget, (int) lv.getProperty ("syllableTarget", 0), nullptr);
            line.setProperty (ids::lyricSyllableTol,    (int) lv.getProperty ("syllableTol", 1), nullptr);
            line.setProperty (ids::lyricStress,         lv.getProperty ("stress", var()), nullptr);
            line.setProperty (ids::lyricRhymeGroup,     lv.getProperty ("rhymeGroup", var()), nullptr);
            line.setProperty (ids::status,              "seed", nullptr);
            container.appendChild (line, nullptr);
        }
        tt->state.appendChild (sheet, &undoManager());

        emit ("build_lyrics_status", [&] { auto* o = new DynamicObject();
            o->setProperty ("clipId", clipId); o->setProperty ("state", "done");
            o->setProperty ("lineCount", linesVar.size()); return var (o); }());
        emitSnapshotInvalidated();

        auto* d = new DynamicObject();
        d->setProperty ("status", "done");
        d->setProperty ("sheetId", sheetId);
        d->setProperty ("trackId", trackId);
        d->setProperty ("lineCount", linesVar.size());
        return okResult ("build_lyrics_from_clip", var (d));
    };

    emit ("build_lyrics_status", [&] { auto* o = new DynamicObject();
        o->setProperty ("clipId", clipId); o->setProperty ("state", "working"); return var (o); }());
    logLine ("build_lyrics_from_clip", args, true, {}, false);

    // Off the message thread (or inline for wait:true): notes (Basic Pitch) → words (Whisper,
    // possibly empty) → mumble_spec. Absent notes (dead service / no Basic Pitch) ⇒ a
    // no_melody_detected spec so `land` surfaces a friendly error.
    auto fetchSpec = [this, srcFile, bpm, tsNum, tsDen, confThreshold] () -> juce::var
    {
        auto notesRes = jobManager.transcribe (srcFile, "mono");
        auto notes = notesRes.isObject() ? notesRes.getProperty ("notes", var()) : var();
        if (! notesRes.isObject() || ! (bool) notesRes.getProperty ("ok", false) || ! notes.isArray() || notes.size() == 0)
        {
            auto* e = new DynamicObject(); e->setProperty ("ok", false);
            e->setProperty ("error", "no_melody_detected"); e->setProperty ("lines", var (Array<var>{}));
            return var (e);
        }
        auto wordsRes = jobManager.transcribeWords (srcFile);
        auto words = wordsRes.isObject() ? wordsRes.getProperty ("words", var()) : var();
        if (! words.isArray()) words = var (Array<var>{});
        return jobManager.mumbleSpec (notes, words, bpm, tsNum, tsDen, confThreshold);
    };

    if ((bool) args.getProperty ("wait", false))
        return land (fetchSpec());

    std::thread ([this, fetchSpec, land]
    {
        auto spec = fetchSpec();
        juce::MessageManager::callAsync ([land, spec] { land (spec); });
    }).detach();

    auto* data = new DynamicObject();
    data->setProperty ("status", "started");
    return okResult ("build_lyrics_from_clip", var (data));
}

// LYR Phase 2 — audio "mumble take" (gibberish → rhythmic SKELETON). Mirrors
// cmdBuildLyricsFromClip, but the take is WORDLESS: skeletonSpec returns an all-gaps spec
// (syllable grid + stress) and each line lands `proposed` — the producer confirms the grid
// (confirm_skeleton) before the Phase-1 engine fills the words. Clip-scoped, service-spawning.
juce::var MoshOps::cmdBuildSkeletonFromClip (const juce::var& args)
{
    const auto clipId = args.getProperty ("clipId", var()).toString();
    const auto grid = args.getProperty ("grid", "1/16").toString();

    auto* w = dynamic_cast<te::WaveAudioClip*> (findClip (clipId));
    if (w == nullptr) return errResult ("build_skeleton_from_clip", "no wave clip with that id");
    const auto srcFile = w->getCurrentSourceFile();
    if (! srcFile.existsAsFile()) return errResult ("build_skeleton_from_clip", "clip has no readable source audio");

    auto* track = dynamic_cast<te::AudioTrack*> (w->getTrack());
    if (track == nullptr) return errResult ("build_skeleton_from_clip", "clip is not on an audio track");
    const auto trackId = track->itemID.toString();
    if (track->state.getChildWithName (ids::MOSH_LYRICSHEET).isValid())
        return errResult ("build_skeleton_from_clip", "track already has a lyric sheet");

    auto& edit = eng.edit();
    auto* tempo = edit.tempoSequence.getNumTempos() > 0 ? edit.tempoSequence.getTempo (0) : nullptr;
    const double bpm = tempo != nullptr ? tempo->getBpm() : 120.0;
    auto* tsig = edit.tempoSequence.getNumTimeSigs() > 0 ? edit.tempoSequence.getTimeSig (0) : nullptr;
    const int tsNum = tsig != nullptr ? tsig->numerator.get() : 4;
    const int tsDen = tsig != nullptr ? tsig->denominator.get() : 4;

    // Land the skeleton as a MOSH_LYRICSHEET on the clip's OWN track in ONE undo txn, each line
    // `proposed` (the human-in-the-loop grid the producer confirms). Always on the message thread.
    auto land = [this, clipId, trackId] (const juce::var& spec) -> juce::var
    {
        auto* tt = findTrack (trackId);
        if (tt == nullptr) return errResult ("build_skeleton_from_clip", "track gone");
        if (tt->state.getChildWithName (ids::MOSH_LYRICSHEET).isValid())
            return errResult ("build_skeleton_from_clip", "track already has a lyric sheet");

        auto linesVar = spec.isObject() ? spec.getProperty ("lines", var()) : var();
        if (! spec.isObject() || ! (bool) spec.getProperty ("ok", false) || ! linesVar.isArray() || linesVar.size() == 0)
        {
            const auto err = spec.isObject() ? spec.getProperty ("error", var()).toString() : juce::String();
            const auto msg = err == "no_melody_detected" ? juce::String ("no melody detected in the take")
                           : err.isNotEmpty() ? err : juce::String ("skeleton service unavailable (start the generative service)");
            emit ("skeleton_status", [&] { auto* o = new DynamicObject();
                o->setProperty ("clipId", clipId); o->setProperty ("state", "error");
                o->setProperty ("error", msg); return var (o); }());
            return errResult ("build_skeleton_from_clip", msg);
        }

        beginTxn ("build_skeleton_from_clip");
        const auto sheetId = juce::Uuid().toString();
        auto sheet = mosh::LyricSheet::create (sheetId, spec.getProperty ("grid", "1/16").toString());
        if (spec.getProperty ("topic", var()).toString().isNotEmpty())
            sheet.setProperty (ids::lyricTopic, spec.getProperty ("topic", var()), nullptr);
        auto container = mosh::LyricSheet::lines (sheet);
        const auto scoresVar = spec.getProperty ("lineScores", var());  // Stage 1: aligned 1:1 with lines
        const auto heardVar  = spec.getProperty ("lineHeard", var());   // extraction: aligned 1:1 with lines
        int li = 0;
        for (auto& lv : *linesVar.getArray())
        {
            auto line = mosh::LyricLine::create (juce::Uuid().toString(),
                                                 (int) lv.getProperty ("index", 0),
                                                 lv.getProperty ("role", "verse").toString());
            line.setProperty (ids::lyricSeedText,       lv.getProperty ("seedText", var()), nullptr);
            line.setProperty (ids::lyricSyllableTarget, (int) lv.getProperty ("syllableTarget", 0), nullptr);
            line.setProperty (ids::lyricSyllableTol,    (int) lv.getProperty ("syllableTol", 1), nullptr);
            line.setProperty (ids::lyricStress,         lv.getProperty ("stress", var()), nullptr);
            line.setProperty (ids::lyricRhymeGroup,     lv.getProperty ("rhymeGroup", var()), nullptr);
            // Lyric EXTRACTION (pipeline correction 2026-07-04): a line the producer REALLY
            // sang lands VERBATIM — text + gapless seed + status "seed" (already done: the
            // generation loop skips it and rhyme-anchors on it) + origin "sung". A partly-
            // real line keeps the grid editor (status "skeleton") with his words as seed
            // anchors, origin "partial". Wordless lines = the pre-correction behavior.
            const auto sungText = lv.getProperty ("text", var()).toString();
            const auto lvOrigin = lv.getProperty ("origin", var()).toString();
            if (sungText.isNotEmpty() && lvOrigin == "sung")
            {
                line.setProperty (ids::lyricText,     sungText, nullptr);
                line.setProperty (ids::lyricSeedText, sungText, nullptr);   // gapless ⇒ not fillable
                line.setProperty (ids::status,        "seed", nullptr);
                line.setProperty (ids::lyricOrigin,   "sung", nullptr);
            }
            else
            {
                line.setProperty (ids::status, "skeleton", nullptr);   // the grid-editor gate (distinct from L2 "proposed")
                if (lvOrigin == "partial")
                    line.setProperty (ids::lyricOrigin, "partial", nullptr);
            }
            // Phase-3 Stage 1: persist the render-ready score blob (articulation slots +
            // melisma segments) with its line — the Stage-2 SoulX adapter authors the
            // target score from this. Absent from older/degraded specs ⇒ simply no blob.
            if (scoresVar.isArray() && li < scoresVar.size() && scoresVar[li].isObject())
                line.setProperty (ids::lyricScore, juce::JSON::toString (scoresVar[li], true), nullptr);
            // Everything the take was HEARD to say (kept AND rejected, with slot hints) —
            // persisted for future splice boundaries + correction seeds; raw ASR is never
            // discarded anymore.
            if (heardVar.isArray() && li < heardVar.size() && heardVar[li].isObject())
                line.setProperty (ids::lyricHeard, juce::JSON::toString (heardVar[li], true), nullptr);
            ++li;
            container.appendChild (line, nullptr);
        }
        tt->state.appendChild (sheet, &undoManager());

        emit ("skeleton_status", [&] { auto* o = new DynamicObject();
            o->setProperty ("clipId", clipId); o->setProperty ("state", "done");
            o->setProperty ("lineCount", linesVar.size()); return var (o); }());
        emitSnapshotInvalidated();

        auto* d = new DynamicObject();
        d->setProperty ("status", "done");
        d->setProperty ("sheetId", sheetId);
        d->setProperty ("trackId", trackId);
        d->setProperty ("lineCount", linesVar.size());
        return okResult ("build_skeleton_from_clip", var (d));
    };

    emit ("skeleton_status", [&] { auto* o = new DynamicObject();
        o->setProperty ("clipId", clipId); o->setProperty ("state", "working"); return var (o); }());
    logLine ("build_skeleton_from_clip", args, true, {}, false);

    // The server orchestrates Basic-Pitch onsets (+ optional FCPE F0) then bins → one call.
    // Absent any onset detector ⇒ a no_melody_detected spec so `land` surfaces a friendly error.
    auto fetchSpec = [this, srcFile, bpm, tsNum, tsDen, grid] () -> juce::var
    {
        return jobManager.skeletonSpec (srcFile, bpm, tsNum, tsDen, grid);
    };

    if ((bool) args.getProperty ("wait", false))
        return land (fetchSpec());

    std::thread ([this, fetchSpec, land]
    {
        auto spec = fetchSpec();
        juce::MessageManager::callAsync ([land, spec] { land (spec); });
    }).detach();

    auto* data = new DynamicObject();
    data->setProperty ("status", "started");
    return okResult ("build_skeleton_from_clip", var (data));
}

// LYR Phase 2 — confirm the proposed flow grid: flip each `proposed` line → `seed` so the
// Phase-1 engine (complete_lyrics / fill_lyric_gap) will fill it. The human-in-the-loop gate.
juce::var MoshOps::cmdConfirmSkeleton (const juce::var& args)
{
    const auto trackId = args.getProperty ("trackId", var()).toString();
    auto* t = findTrack (trackId);
    if (t == nullptr) return errResult ("confirm_skeleton", "no track: " + trackId);
    auto sheet = t->state.getChildWithName (ids::MOSH_LYRICSHEET);
    if (! sheet.isValid()) return errResult ("confirm_skeleton", "track has no lyric sheet");

    beginTxn ("confirm_skeleton");
    auto lines = mosh::LyricSheet::lines (sheet);
    int n = 0;
    for (int i = 0; i < lines.getNumChildren(); ++i)
    {
        auto line = lines.getChild (i);
        if (line[ids::status].toString() == "skeleton")
        {
            line.setProperty (ids::status, "seed", &undoManager());
            ++n;
        }
    }
    logLine ("confirm_skeleton", args, true, {}, false);
    emitSnapshotInvalidated();
    auto* d = new DynamicObject(); d->setProperty ("confirmed", n);
    return okResult ("confirm_skeleton", var (d));
}

} // namespace mosh
