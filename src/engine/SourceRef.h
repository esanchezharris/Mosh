#pragma once

#include <tracktion_engine/tracktion_engine.h>

namespace mosh
{

/** Re-point a wave clip's audio source at @p target, the ONE way.

    Three call sites rewrite a clip's te::SourceFileReference — mp_commit_track
    (content-addressed by-hash stem), relink_clip (user re-points a missing source),
    and the save_as audio consolidation — and getting the *relative* form subtly wrong
    silently reintroduces a real, hard-to-spot bug, so they share this helper.

    Why not just setToDirectFileReference(target, useRelativePath=true): that routes
    through findPathFromFile -> target.getRelativePathFrom(edit.editFileRetriever()), i.e.
    relative to the edit FILE. JUCE's getRelativePathFrom only strips to the base's parent
    when the base existsAsFile(); when the edit file is NOT yet on disk (a fresh, unsaved
    arrangement) it treats the edit file's own path as a directory and prepends a spurious
    "../" (e.g. "../audio/foo.wav"). Mosh's filePathResolver (MoshEngine::wireEditResolvers)
    resolves relative to the edit file's PARENT directory, so that "../" escapes the session
    dir to a path that doesn't exist — the offline-render WaveNode then never opens the
    source and export_audio spins forever (PR #104).

    So for a relative ref we compute the path relative to the edit file's PARENT directory
    ourselves (robust whether or not the edit file is on disk, since a directory never
    "exists as a file"), with portable '/' separators so an edit saved on one OS opens on
    another. Absolute refs (target outside the project) are stored verbatim.

    @param clip               the wave clip whose source is being re-pointed
    @param target             the file the clip should reference (must already exist)
    @param editFileParentDir  eng.editFile().getParentDirectory() — the session/project dir
    @param relative           store a project-relative ref (target lives under the project
                              dir, keeping the project portable) vs. an absolute path
*/
inline void repointWaveClipSource (tracktion::engine::WaveAudioClip& clip,
                                   const juce::File& target,
                                   const juce::File& editFileParentDir,
                                   bool relative)
{
    auto& srcRef = clip.getSourceFileReference();
    // Seed via the ABSOLUTE form (useRelativePath=false). setToDirectFileReference is just
    // `source = findPathFromFile(...)`, and findPathFromFile(useRelativePath=true) jassert-fires
    // when the edit file isn't on disk yet (a fresh, unsaved arrangement — exactly the case the
    // by-hash repoint must still work for). For the relative case we overwrite `source` below
    // with our own PARENT-relative computation anyway, so the relative seed buys nothing but a
    // spurious debug assertion. !relative keeps the absolute path verbatim.
    srcRef.setToDirectFileReference (target, false);
    if (relative)
        srcRef.source = target.getRelativePathFrom (editFileParentDir).replaceCharacter ('\\', '/');
    clip.sourceMediaChanged();                            // refresh the clip's cached source file
}

} // namespace mosh
