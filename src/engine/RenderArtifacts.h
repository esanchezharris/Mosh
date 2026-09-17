#pragma once

#include <functional>
#include <vector>
#include <juce_cryptography/juce_cryptography.h>
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

/** Preserve render assets with content-addressed, project-relative references.
    The caller resolves old project-relative refs before changing the edit directory.
    Ref rewrites commit only after every copy succeeds; explicit-decision layers fail
    on missing referenced files. Legacy missing caches remain optional. Save As owns
    this persistence operation, so it does not enter the edit's undo history. */
inline juce::Result consolidateRenderArtifacts (juce::ValueTree editState,
                                               const juce::File& editParentDir)
{
    const auto rendersDir = editParentDir.getChildFile ("audio").getChildFile ("renders");
    struct RefUpdate
    {
        juce::ValueTree layer;
        juce::Identifier property;
        juce::String reference;
    };
    std::vector<RefUpdate> updates;

    auto consolidate = [&] (juce::ValueTree layer, const juce::Identifier& property) -> juce::Result
    {
        const auto stored = layer[property].toString();
        if (stored.isEmpty())
            return juce::Result::ok();
        const auto source = resolveCacheArtifact (stored, editParentDir);
        const auto failure = [&] (const juce::String& reason)
        {
            return juce::Result::fail ("Cannot preserve Re-Imagine " + property.toString()
                                       + ": " + reason + " (" + source.getFullPathName() + ")");
        };
        if (! source.existsAsFile())
            return layer["decisionPolicy"].toString() == "explicit"
                ? failure ("referenced file is missing") : juce::Result::ok();

        juce::FileInputStream sourceStream (source);
        if (! sourceStream.openedOk())
            return failure ("referenced file cannot be read");
        const auto digest = juce::SHA256 (sourceStream).toHexString();
        if (sourceStream.getStatus().failed())
            return failure (sourceStream.getStatus().getErrorMessage());
        const auto destination = rendersDir.getChildFile (digest + source.getFileExtension());
        if (destination.existsAsFile())
        {
            juce::FileInputStream existingStream (destination);
            if (! existingStream.openedOk() || juce::SHA256 (existingStream).toHexString() != digest
                || existingStream.getStatus().failed())
                return failure ("stored asset differs from its content identity");
        }
        else
        {
            if (const auto result = rendersDir.createDirectory(); result.failed())
                return failure (result.getErrorMessage());
            juce::TemporaryFile temporary (destination);
            if (! source.copyFileTo (temporary.getFile()))
                return failure ("asset copy failed");
            {
                juce::FileInputStream copiedStream (temporary.getFile());
                if (! copiedStream.openedOk() || juce::SHA256 (copiedStream).toHexString() != digest
                    || copiedStream.getStatus().failed())
                    return failure ("copied asset differs from its content identity");
            }
            if (! temporary.overwriteTargetFileWithTemporary())
                return failure ("asset could not be stored");
        }
        updates.push_back ({ layer, property,
            destination.getRelativePathFrom (editParentDir).replaceCharacter ('\\', '/') });
        return juce::Result::ok();
    };

    std::function<juce::Result (juce::ValueTree)> visit = [&] (juce::ValueTree node)
    {
        if (node.hasType (ids::MOSH_RENDERLAYER))
            for (const auto& property : { ids::cacheArtifact, ids::originalSourceRef,
                                         juce::Identifier ("committedArtifact"),
                                         juce::Identifier ("directManifest") })
                if (const auto result = consolidate (node, property); result.failed())
                    return result;
        for (int i = 0; i < node.getNumChildren(); ++i)
            if (const auto result = visit (node.getChild (i)); result.failed())
                return result;
        return juce::Result::ok();
    };
    if (const auto result = visit (editState); result.failed())
        return result;
    for (auto& update : updates)
        update.layer.setProperty (update.property, update.reference, nullptr);
    return juce::Result::ok();
}

} // namespace mosh
