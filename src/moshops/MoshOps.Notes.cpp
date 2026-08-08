// RFC 001 (A-PR1) — MoshOps partial-class split: the sections / annotations /
// agent-memory command bodies (SEC-001 named song sections, ANN-001 authored
// timeline annotations, AGT-MEM Phase-B memory lane), moved VERBATIM from
// MoshOps.cpp. Same class, same member functions — only the translation unit
// changed. The dispatch if-chain and all transaction/log/result/emit plumbing
// stay in MoshOps.cpp (one mutation path, by construction).

#include "MoshOps.h"
#include "AgentMemoryStore.h"
#include "state/Ids.h"
#include "state/Section.h"
#include "state/Annotation.h"

namespace mosh
{
using namespace juce;

// ── SEC-001 — named song sections (MOSH_SECTIONS tree on the Edit) ────────────
// Beat-range regions with a name + colour; create/rename/move/remove are undoable
// writes to the Edit's own ValueTree, so they save/reload with the .tracktionedit
// and ride the one undo system. Section ids are engine-assigned UUIDs.
juce::var MoshOps::cmdCreateSection (const juce::var& args)
{
    const auto name = args.getProperty ("name", var()).toString();
    const double startBeat = (double) args.getProperty ("startBeat", 0.0);
    const double endBeat = (double) args.getProperty ("endBeat", startBeat + 16.0);
    const auto color = args.getProperty ("color", var()).toString();

    beginTxn ("create_section");
    auto state = eng.edit().state;
    auto sections = state.getChildWithName (ids::MOSH_SECTIONS);
    if (! sections.isValid())
    {
        sections = juce::ValueTree (ids::MOSH_SECTIONS);
        state.appendChild (sections, &undoManager());
    }
    const auto sectionId = juce::Uuid().toString();
    sections.appendChild (mosh::Section::create (sectionId, name, startBeat, endBeat, color), &undoManager());

    auto* data = new DynamicObject(); data->setProperty ("sectionId", sectionId);
    logLine ("create_section", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("create_section", var (data));
}

juce::var MoshOps::cmdRenameSection (const juce::var& args)
{
    const auto sectionId = args.getProperty ("sectionId", var()).toString();
    const auto name = args.getProperty ("name", var()).toString();
    auto sections = eng.edit().state.getChildWithName (ids::MOSH_SECTIONS);
    auto node = sections.getChildWithProperty (ids::id, sectionId);
    if (! node.isValid()) return errResult ("rename_section", "no section: " + sectionId);

    beginTxn ("rename_section");
    node.setProperty (ids::sectionName, name, &undoManager());
    logLine ("rename_section", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("rename_section");
}

juce::var MoshOps::cmdMoveSection (const juce::var& args)
{
    const auto sectionId = args.getProperty ("sectionId", var()).toString();
    const double startBeat = (double) args.getProperty ("startBeat", 0.0);
    const double endBeat = (double) args.getProperty ("endBeat", 0.0);
    auto sections = eng.edit().state.getChildWithName (ids::MOSH_SECTIONS);
    auto node = sections.getChildWithProperty (ids::id, sectionId);
    if (! node.isValid()) return errResult ("move_section", "no section: " + sectionId);

    beginTxn ("move_section");
    node.setProperty (ids::sectionStartBeat, startBeat, &undoManager());
    node.setProperty (ids::sectionEndBeat, endBeat, &undoManager());
    logLine ("move_section", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("move_section");
}

juce::var MoshOps::cmdRemoveSection (const juce::var& args)
{
    const auto sectionId = args.getProperty ("sectionId", var()).toString();
    auto sections = eng.edit().state.getChildWithName (ids::MOSH_SECTIONS);
    auto node = sections.getChildWithProperty (ids::id, sectionId);
    if (! node.isValid()) return errResult ("remove_section", "no section: " + sectionId);

    beginTxn ("remove_section");
    sections.removeChild (node, &undoManager());
    logLine ("remove_section", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_section");
}

juce::var MoshOps::sectionsToVar()
{
    Array<var> out;
    auto sections = eng.edit().state.getChildWithName (ids::MOSH_SECTIONS);
    if (sections.isValid())
        for (int i = 0; i < sections.getNumChildren(); ++i)
        {
            auto s = sections.getChild (i);
            auto* o = new DynamicObject();
            o->setProperty ("id", s[ids::id].toString());
            o->setProperty ("name", s[ids::sectionName].toString());
            o->setProperty ("startBeat", (double) s[ids::sectionStartBeat]);
            o->setProperty ("endBeat", (double) s[ids::sectionEndBeat]);
            if (s.hasProperty (ids::sectionColor))
                o->setProperty ("color", s[ids::sectionColor].toString());
            out.add (var (o));
        }
    return out;
}

// ── AGT-MEM (Phase-B memory lane, M1): the native agent-memory store ────────────────
// Pure file I/O via AgentMemoryStore.h — NO ValueTree/Edit mutation, NO snapshot change,
// NO undo transaction (mirrors the training commands' non-undoable posture: no
// beginTxn, logLine(..., /*undoable=*/false) — undo() therefore can never touch a
// stored item, by construction, not by a special-cased guard). Global scope writes
// preferences.jsonl / patterns/drums.jsonl / patterns/lyrics.jsonl under MOSH_AGENT_DIR
// (else ~/Library/Mosh/agent/); project scope writes a sidecar JSON next to the current
// edit file (<edit>.mosh-memory.json), copied on Save-As by cmdSaveAs below.
juce::var MoshOps::cmdAgentMemoryWrite (const juce::var& args)
{
    const auto scope = args.getProperty ("scope", var()).toString();
    if (scope != "global" && scope != "project")
        return errResult ("agent_memory_write", "'scope' must be \"global\" or \"project\"");

    const auto item = args.getProperty ("item", var());
    const bool itemPresent = ! item.isVoid() && (item.isObject() || (item.isString() && item.toString().trim().isNotEmpty()));
    if (! itemPresent)
        return errResult ("agent_memory_write", "missing or invalid 'item' (must be a non-empty JSON object or string)");

    const bool explicitFlag = (bool) args.getProperty ("explicit", false);

    if (scope == "global")
    {
        const auto kind = args.getProperty ("kind", var()).toString();
        if (! AgentMemoryStore::isValidGlobalKind (kind))
            return errResult ("agent_memory_write",
                "'kind' must be one of \"preference\", \"drum_pattern\", \"lyric_framework\" for global scope");

        const auto root = AgentMemoryStore::globalRoot();
        AgentMemoryStore::ensureGlobalMeta (root);
        const auto file = AgentMemoryStore::globalStoreFile (root, kind);

        auto items = AgentMemoryStore::readJsonlFile (file);
        const auto record = AgentMemoryStore::makeRecord (kind, explicitFlag, item);
        String error;
        if (! AgentMemoryStore::applyWrite (items, record, error))
        {
            logLine ("agent_memory_write", args, false, error, false);
            return errResult ("agent_memory_write", error);
        }
        if (! AgentMemoryStore::writeJsonlFile (file, items))
        {
            const auto ioErr = "failed to write " + file.getFullPathName();
            logLine ("agent_memory_write", args, false, ioErr, false);
            return errResult ("agent_memory_write", ioErr);
        }

        logLine ("agent_memory_write", args, true, {}, false);
        auto* d = new DynamicObject(); d->setProperty ("count", items.size());
        return okResult ("agent_memory_write", var (d));
    }

    // scope == "project" — kind defaults to "note"; the project-scope kind vocabulary
    // is open (unlike global's closed 3-kind set).
    const auto kind = args.hasProperty ("kind") ? args.getProperty ("kind", var()).toString() : String ("note");
    const auto sidecar = AgentMemoryStore::sidecarFileFor (eng.editFile());
    auto notes = AgentMemoryStore::readSidecarNotes (sidecar);
    const auto record = AgentMemoryStore::makeRecord (kind, explicitFlag, item);
    String error;
    if (! AgentMemoryStore::applyWrite (notes, record, error))
    {
        logLine ("agent_memory_write", args, false, error, false);
        return errResult ("agent_memory_write", error);
    }
    if (! AgentMemoryStore::writeSidecarNotes (sidecar, notes))
    {
        const auto ioErr = "failed to write " + sidecar.getFullPathName();
        logLine ("agent_memory_write", args, false, ioErr, false);
        return errResult ("agent_memory_write", ioErr);
    }

    logLine ("agent_memory_write", args, true, {}, false);
    auto* d = new DynamicObject(); d->setProperty ("count", notes.size());
    return okResult ("agent_memory_write", var (d));
}

// Read-only — deliberately does NOT call logLine (mirrors cmdGetLyricCorpusStats /
// cmdGetRhymes' read posture: mosh-log.jsonl records mutations, not lookups).
juce::var MoshOps::cmdAgentMemoryRead (const juce::var& args)
{
    const auto scope = args.getProperty ("scope", var()).toString();
    if (scope != "global" && scope != "project")
        return errResult ("agent_memory_read", "'scope' must be \"global\" or \"project\"");

    const int limit = (int) args.getProperty ("limit", 50);

    if (scope == "global")
    {
        const auto kind = args.getProperty ("kind", var()).toString();
        if (kind.isNotEmpty() && ! AgentMemoryStore::isValidGlobalKind (kind))
            return errResult ("agent_memory_read",
                "'kind' must be one of \"preference\", \"drum_pattern\", \"lyric_framework\" for global scope");

        const auto items = AgentMemoryStore::readGlobal (AgentMemoryStore::globalRoot(), kind, limit);
        auto* d = new DynamicObject(); d->setProperty ("items", items);
        return okResult ("agent_memory_read", var (d));
    }

    const auto sidecar = AgentMemoryStore::sidecarFileFor (eng.editFile());
    const auto items = AgentMemoryStore::selectForRead (AgentMemoryStore::readSidecarNotes (sidecar), limit);
    auto* d = new DynamicObject(); d->setProperty ("items", items);
    return okResult ("agent_memory_read", var (d));
}

// AGT-MEM (M3) — deletes ONE item by its exact `ts` (nextTs() makes it a unique id
// within a process's lifetime — see AgentMemoryStore.h). Global scope: `kind`
// selects WHICH FILE to search (all three when omitted); project scope: `kind`, if
// given, is an extra safety check against the found item's own kind field (ts alone
// already locates it). A mutation — logged, non-undoable, same posture as write.
juce::var MoshOps::cmdAgentMemoryDelete (const juce::var& args)
{
    const auto scope = args.getProperty ("scope", var()).toString();
    if (scope != "global" && scope != "project")
        return errResult ("agent_memory_delete", "'scope' must be \"global\" or \"project\"");
    if (! args.hasProperty ("ts"))
        return errResult ("agent_memory_delete", "missing 'ts'");
    const juce::int64 ts = (juce::int64) args.getProperty ("ts", var (0));
    const auto kind = args.getProperty ("kind", var()).toString();

    if (scope == "global")
    {
        if (kind.isNotEmpty() && ! AgentMemoryStore::isValidGlobalKind (kind))
            return errResult ("agent_memory_delete",
                "'kind' must be one of \"preference\", \"drum_pattern\", \"lyric_framework\" for global scope");

        const auto root = AgentMemoryStore::globalRoot();
        const auto kindsToSearch = kind.isNotEmpty() ? StringArray { kind } : AgentMemoryStore::allGlobalKinds();
        for (auto& k : kindsToSearch)
        {
            const auto file = AgentMemoryStore::globalStoreFile (root, k);
            auto items = AgentMemoryStore::readJsonlFile (file);
            if (! AgentMemoryStore::deleteByTsAndKind (items, ts, {}))
                continue;
            if (! AgentMemoryStore::writeJsonlFile (file, items))
            {
                const auto ioErr = "failed to write " + file.getFullPathName();
                logLine ("agent_memory_delete", args, false, ioErr, false);
                return errResult ("agent_memory_delete", ioErr);
            }
            logLine ("agent_memory_delete", args, true, {}, false);
            auto* d = new DynamicObject(); d->setProperty ("count", items.size());
            return okResult ("agent_memory_delete", var (d));
        }
        const auto notFound = "no item with ts " + String (ts) + " found";
        logLine ("agent_memory_delete", args, false, notFound, false);
        return errResult ("agent_memory_delete", notFound);
    }

    // scope == "project"
    const auto sidecar = AgentMemoryStore::sidecarFileFor (eng.editFile());
    auto notes = AgentMemoryStore::readSidecarNotes (sidecar);
    if (! AgentMemoryStore::deleteByTsAndKind (notes, ts, kind))
    {
        const auto notFound = "no item with ts " + String (ts) + " found";
        logLine ("agent_memory_delete", args, false, notFound, false);
        return errResult ("agent_memory_delete", notFound);
    }
    if (! AgentMemoryStore::writeSidecarNotes (sidecar, notes))
    {
        const auto ioErr = "failed to write " + sidecar.getFullPathName();
        logLine ("agent_memory_delete", args, false, ioErr, false);
        return errResult ("agent_memory_delete", ioErr);
    }
    logLine ("agent_memory_delete", args, true, {}, false);
    auto* d = new DynamicObject(); d->setProperty ("count", notes.size());
    return okResult ("agent_memory_delete", var (d));
}

// AGT-MEM (M3) — clears a whole tier. Global scope: `kind` wipes just that ONE kind's
// FILE (a global kind IS a file); omitted wipes all three. Project scope: `kind`, if
// given, removes only notes carrying that kind field (leaving other kinds in the
// sidecar untouched); omitted clears the whole notes array. A mutation — logged,
// non-undoable, same posture as write/delete.
juce::var MoshOps::cmdAgentMemoryClear (const juce::var& args)
{
    const auto scope = args.getProperty ("scope", var()).toString();
    if (scope != "global" && scope != "project")
        return errResult ("agent_memory_clear", "'scope' must be \"global\" or \"project\"");
    const auto kind = args.getProperty ("kind", var()).toString();

    if (scope == "global")
    {
        if (kind.isNotEmpty() && ! AgentMemoryStore::isValidGlobalKind (kind))
            return errResult ("agent_memory_clear",
                "'kind' must be one of \"preference\", \"drum_pattern\", \"lyric_framework\" for global scope");

        const auto root = AgentMemoryStore::globalRoot();
        const auto kindsToClear = kind.isNotEmpty() ? StringArray { kind } : AgentMemoryStore::allGlobalKinds();
        int cleared = 0;
        for (auto& k : kindsToClear)
        {
            const auto file = AgentMemoryStore::globalStoreFile (root, k);
            const auto items = AgentMemoryStore::readJsonlFile (file);
            cleared += items.size();
            if (! AgentMemoryStore::writeJsonlFile (file, Array<var>()))
            {
                const auto ioErr = "failed to write " + file.getFullPathName();
                logLine ("agent_memory_clear", args, false, ioErr, false);
                return errResult ("agent_memory_clear", ioErr);
            }
        }
        logLine ("agent_memory_clear", args, true, {}, false);
        auto* d = new DynamicObject(); d->setProperty ("cleared", cleared);
        return okResult ("agent_memory_clear", var (d));
    }

    // scope == "project"
    const auto sidecar = AgentMemoryStore::sidecarFileFor (eng.editFile());
    auto notes = AgentMemoryStore::readSidecarNotes (sidecar);
    const int cleared = AgentMemoryStore::clearMatchingKind (notes, kind);
    if (cleared > 0 && ! AgentMemoryStore::writeSidecarNotes (sidecar, notes))
    {
        const auto ioErr = "failed to write " + sidecar.getFullPathName();
        logLine ("agent_memory_clear", args, false, ioErr, false);
        return errResult ("agent_memory_clear", ioErr);
    }
    logLine ("agent_memory_clear", args, true, {}, false);
    auto* d = new DynamicObject(); d->setProperty ("cleared", cleared);
    return okResult ("agent_memory_clear", var (d));
}

// ── ANN-001: authored timeline annotations (mirror the sections CRUD; multiplayer-
// broadcast so collaborators share comments). ───────────────────────────────────────
juce::var MoshOps::cmdCreateAnnotation (const juce::var& args)
{
    const auto text   = args.getProperty ("text", var()).toString();
    const double beat = (double) args.getProperty ("beat", 0.0);
    const auto color  = args.getProperty ("color", var()).toString();
    const auto author = args.getProperty ("author", var()).toString();
    // Stable cross-peer id: reuse the caller's if supplied (the broadcast re-exec passes
    // it back), else mint one. Broadcasting the RESOLVED id keeps both peers' ids equal so
    // edit/move/remove address the same annotation.
    auto annId = args.getProperty ("annotationId", var()).toString();
    if (annId.isEmpty()) annId = juce::Uuid().toString();

    beginTxn ("create_annotation");
    auto state = eng.edit().state;
    auto anns = state.getChildWithName (ids::MOSH_ANNOTATIONS);
    if (! anns.isValid())
    {
        anns = juce::ValueTree (ids::MOSH_ANNOTATIONS);
        state.appendChild (anns, &undoManager());
    }
    // Idempotent on the resolved id: a re-applied create (the only ADDITIVE op broadcast
    // over MP) must not append a duplicate node.
    if (! anns.getChildWithProperty (ids::id, annId).isValid())
        anns.appendChild (mosh::Annotation::create (annId, text, beat, color, author), &undoManager());

    auto* data = new DynamicObject(); data->setProperty ("annotationId", annId);
    logLine ("create_annotation", args, true, {}, true);
    emitSnapshotInvalidated();

    // Broadcast the RESOLVED id through the shared structural producer seam (passing
    // the original args would re-mint on the peer).
    auto* broadcastArgs = new DynamicObject();
    broadcastArgs->setProperty ("annotationId", annId);
    broadcastArgs->setProperty ("text", text);
    broadcastArgs->setProperty ("beat", beat);
    if (color.isNotEmpty())  broadcastArgs->setProperty ("color", color);
    if (author.isNotEmpty()) broadcastArgs->setProperty ("author", author);
    return broadcastStructuralIfActive ("create_annotation", var (broadcastArgs),
                                        okResult ("create_annotation", var (data)));
}

juce::var MoshOps::cmdEditAnnotation (const juce::var& args)
{
    const auto annId = args.getProperty ("annotationId", var()).toString();
    auto anns = eng.edit().state.getChildWithName (ids::MOSH_ANNOTATIONS);
    auto node = anns.getChildWithProperty (ids::id, annId);
    if (! node.isValid()) return errResult ("edit_annotation", "no annotation: " + annId);

    beginTxn ("edit_annotation");
    if (args.hasProperty ("text"))  node.setProperty (ids::annotationText, args.getProperty ("text", var()), &undoManager());
    if (args.hasProperty ("color")) node.setProperty (ids::annotationColor, args.getProperty ("color", var()), &undoManager());
    logLine ("edit_annotation", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("edit_annotation");
}

juce::var MoshOps::cmdMoveAnnotation (const juce::var& args)
{
    const auto annId = args.getProperty ("annotationId", var()).toString();
    auto anns = eng.edit().state.getChildWithName (ids::MOSH_ANNOTATIONS);
    auto node = anns.getChildWithProperty (ids::id, annId);
    if (! node.isValid()) return errResult ("move_annotation", "no annotation: " + annId);

    beginTxn ("move_annotation");
    node.setProperty (ids::annotationBeat, (double) args.getProperty ("beat", 0.0), &undoManager());
    logLine ("move_annotation", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("move_annotation");
}

juce::var MoshOps::cmdRemoveAnnotation (const juce::var& args)
{
    const auto annId = args.getProperty ("annotationId", var()).toString();
    auto anns = eng.edit().state.getChildWithName (ids::MOSH_ANNOTATIONS);
    auto node = anns.getChildWithProperty (ids::id, annId);
    if (! node.isValid()) return errResult ("remove_annotation", "no annotation: " + annId);

    beginTxn ("remove_annotation");
    anns.removeChild (node, &undoManager());
    logLine ("remove_annotation", args, true, {}, true);
    emitSnapshotInvalidated();
    return okResult ("remove_annotation");
}

juce::var MoshOps::annotationsToVar()
{
    Array<var> out;
    auto anns = eng.edit().state.getChildWithName (ids::MOSH_ANNOTATIONS);
    if (anns.isValid())
        for (int i = 0; i < anns.getNumChildren(); ++i)
        {
            auto a = anns.getChild (i);
            auto* o = new DynamicObject();
            o->setProperty ("id", a[ids::id].toString());
            o->setProperty ("text", a[ids::annotationText].toString());
            o->setProperty ("beat", (double) a[ids::annotationBeat]);
            if (a.hasProperty (ids::annotationColor))  o->setProperty ("color", a[ids::annotationColor].toString());
            if (a.hasProperty (ids::annotationAuthor)) o->setProperty ("author", a[ids::annotationAuthor].toString());
            out.add (var (o));
        }
    return out;
}

} // namespace mosh
