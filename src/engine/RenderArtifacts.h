#pragma once

#include <functional>
#include <juce_data_structures/juce_data_structures.h>
#include "state/Ids.h"

namespace mosh
{

/** Save-As consolidation + portability for Tier-B render-layer artifacts (AL-009).

    A MOSH_RENDERLAYER stores its rendered audio as `cacheArtifact` — the path the
    `accept_render`, `freeze_layer` and snapshot read sites depend on. It is written by
    `finalizeRender` as the renderer's ABSOLUTE output path, which lives in the shared
    session pool (`~/Library/Mosh/<session>/renders/<id>/output.wav`), NOT inside the
    project dir. `MoshEngine::consolidateAudioInto` (the Save-As pass) localises wave-clip
    sources and sampler sounds into the project's `audio/` dir and re-points them with
    RELATIVE refs so the project moves wholesale — but it never touched `cacheArtifact`.
    So after a Save-As + project move, the artifact path still points at the old pool: if
    the pool is gone (another machine / cleaned session) `freeze_layer` / re-`accept_render`
    fail ("nothing rendered to freeze"); even when the pool survives, the saved project is
    not portable.

    These two free functions close that gap, kept out of MoshEngine.{cpp,h} (a
    prime-directive seam) and invoked from `MoshOps::cmdSaveAs` after the engine's own
    consolidation. They mirror the SourceRef.h / consolidateAudioInto conventions:
    portable '/' separators (a project saved on one OS opens on another) and a relative
    ref resolved against the edit file's PARENT directory.
*/

/** Resolve a stored `cacheArtifact` string (relative OR absolute) to a concrete file.

    Mirrors MoshEngine::wireEditResolvers' filePathResolver so every read site (accept,
    freeze, snapshot) is move-aware: an absolute path resolves as-is (legacy / external);
    a project-relative ref resolves against the edit file's PARENT directory. An empty
    string yields an invalid File (existsAsFile() == false), the same "nothing rendered"
    signal the callers already handle. */
inline juce::File resolveCacheArtifact (const juce::String& stored,
                                        const juce::File& editParentDir)
{
    if (stored.isEmpty())
        return {};
    if (juce::File::isAbsolutePath (stored))
        return juce::File (stored);
    return editParentDir.getChildFile (stored);   // project-relative ref
}

/** Read a render-layer node's resolved artifact file. Convenience over the string read. */
inline juce::File resolveCacheArtifact (const juce::ValueTree& renderLayer,
                                        const juce::File& editParentDir)
{
    return resolveCacheArtifact (renderLayer[ids::cacheArtifact].toString(), editParentDir);
}

/** Consolidate every render layer's `cacheArtifact` into the project's `audio/renders/`
    dir and re-point it with a portable, project-relative ref — the Save-As render-artifact
    pass (AL-009). Walks all clips under @p editState (clips parent a single MOSH_RENDERLAYER
    child). For each layer:

      - resolve the current artifact (relative-or-absolute) against @p editParentDir;
      - skip layers with no artifact, a missing artifact (nothing to consolidate — a later
        re-render rebuilds it), or one already inside the project dir;
      - copy it to `audio/renders/<layerId>.wav` (de-duping by name+size like
        consolidateAudioInto), and rewrite `cacheArtifact` to the relative path with '/'
        separators.

    Idempotent: a second call sees the now-already-local ref and does nothing. Written
    WITHOUT an undo manager — Save-As persistence is not an undoable user edit (matching
    cmdSaveAs / consolidateAudioInto). */
inline void consolidateRenderArtifacts (juce::ValueTree editState,
                                        const juce::File& editParentDir)
{
    auto rendersDir = editParentDir.getChildFile ("audio").getChildFile ("renders");

    // Depth-first walk for MOSH_RENDERLAYER nodes anywhere under the edit tree (clips live
    // under TRACK/.../CLIP; a render layer is a direct child of its clip). A recursive scan
    // is robust to the exact track/clip nesting and matches how the snapshot finds them.
    std::function<void (const juce::ValueTree&)> visit = [&] (const juce::ValueTree& node)
    {
        for (int i = 0; i < node.getNumChildren(); ++i)
        {
            auto child = node.getChild (i);
            if (child.hasType (ids::MOSH_RENDERLAYER))
            {
                // Consolidate a stored ref (cacheArtifact OR the in-place originalSourceRef) into
                // audio/renders/ + re-point it relative, so the saved project carries no absolute
                // session-pool path and BOTH the render and "Reset to original" survive a move.
                auto consolidate = [&] (const juce::Identifier& prop, const juce::String& suffix)
                {
                    auto src = resolveCacheArtifact (child[prop].toString(), editParentDir);
                    if (src.existsAsFile() && ! src.isAChildOf (editParentDir))
                    {
                        rendersDir.createDirectory();
                        auto dest = rendersDir.getChildFile (child[ids::id].toString() + suffix + ".wav");
                        // De-dupe by name+size: keep an identical existing copy; otherwise refresh.
                        if (! (dest.existsAsFile() && dest.getSize() == src.getSize()))
                        {
                            dest.deleteFile();
                            src.copyFileTo (dest);
                        }
                        if (dest.existsAsFile())
                            child.setProperty (prop,
                                dest.getRelativePathFrom (editParentDir).replaceCharacter ('\\', '/'),
                                nullptr);   // portable relative ref (no undo — Save-As persistence)
                    }
                };
                consolidate (ids::cacheArtifact, "");
                consolidate (ids::originalSourceRef, "-original");
            }
            visit (child);
        }
    };
    visit (editState);
}

} // namespace mosh
