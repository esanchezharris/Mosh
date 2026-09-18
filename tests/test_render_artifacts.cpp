#include <catch2/catch_test_macros.hpp>
#include "engine/RenderArtifacts.h"

namespace
{
struct ArtifactFixture
{
    juce::File root = juce::File::getSpecialLocation (juce::File::tempDirectory)
        .getNonexistentChildFile ("mosh-render-artifacts", {}, false);
    juce::File project = root.getChildFile ("project");
    juce::ValueTree edit { "EDIT" };
    juce::ValueTree layer { mosh::ids::MOSH_RENDERLAYER };

    ArtifactFixture()
    {
        REQUIRE (project.createDirectory().wasOk());
        layer.setProperty (mosh::ids::id, "render-one", nullptr);
        edit.appendChild (layer, nullptr);
    }
    ~ArtifactFixture() { root.deleteRecursively(); }

    juce::File asset (const juce::String& name, const juce::String& contents)
    {
        auto file = root.getChildFile (name);
        REQUIRE (file.replaceWithText (contents));
        return file;
    }
};
}

TEST_CASE ("render consolidation retains different same-size generations", "[render-artifacts]")
{
    // Given: an earlier generation already consolidated under the same layer ID.
    ArtifactFixture f;
    const auto first = f.asset ("first.wav", "first audio");
    f.layer.setProperty (mosh::ids::cacheArtifact, first.getFullPathName(), nullptr);
    REQUIRE (mosh::consolidateRenderArtifacts (f.edit, f.project).wasOk());
    const auto kept = mosh::resolveCacheArtifact (f.layer, f.project);
    const auto second = f.asset ("second.wav", "later audio");
    REQUIRE (first.getSize() == second.getSize());
    f.layer.setProperty (mosh::ids::cacheArtifact, second.getFullPathName(), nullptr);

    // When: Save As consolidates another result with the same byte length.
    REQUIRE (mosh::consolidateRenderArtifacts (f.edit, f.project).wasOk());

    // Then: the old asset survives and the new reference contains the new audio.
    const auto pending = mosh::resolveCacheArtifact (f.layer, f.project);
    CHECK (pending != kept);
    CHECK (pending.loadFileAsString() == "later audio");
    CHECK (kept.loadFileAsString() == "first audio");
    CHECK (first.loadFileAsString() == "first audio");
    CHECK (second.loadFileAsString() == "later audio");
}

TEST_CASE ("all direct render references survive a project move", "[render-artifacts]")
{
    ArtifactFixture f;
    f.layer.setProperty ("decisionPolicy", "explicit", nullptr);
    const juce::Identifier properties[] { mosh::ids::originalSourceRef,
        mosh::ids::cacheArtifact, juce::Identifier ("committedArtifact"),
        juce::Identifier ("directManifest") };
    const juce::String contents[] { "original audio", "pending audio", "kept audio", "{\"seed\":0}" };
    for (int i = 0; i < 4; ++i)
    {
        const auto extension = i == 3 ? ".json" : ".wav";
        const auto source = f.asset (properties[i].toString() + extension, contents[i]);
        f.layer.setProperty (properties[i], source.getFullPathName(), nullptr);
    }

    REQUIRE (mosh::consolidateRenderArtifacts (f.edit, f.project).wasOk());

    const auto saved = f.edit.createXml();
    REQUIRE (saved != nullptr);
    const auto reopened = juce::ValueTree::fromXml (*saved);
    const auto moved = f.root.getChildFile ("moved-project");
    REQUIRE (f.project.moveFileTo (moved));
    const auto reopenedLayer = reopened.getChildWithName (mosh::ids::MOSH_RENDERLAYER);
    for (int i = 0; i < 4; ++i)
    {
        const auto stored = reopenedLayer[properties[i]].toString();
        CHECK_FALSE (juce::File::isAbsolutePath (stored));
        const auto restored = mosh::resolveCacheArtifact (stored, moved);
        CHECK (restored.loadFileAsString() == contents[i]);
        CHECK (restored.getFileExtension() == (i == 3 ? ".json" : ".wav"));
    }
}

TEST_CASE ("missing direct committed audio fails without changing any references", "[render-artifacts]")
{
    ArtifactFixture f;
    f.layer.setProperty ("decisionPolicy", "explicit", nullptr);
    const auto source = f.asset ("original.wav", "source audio");
    f.layer.setProperty (mosh::ids::originalSourceRef, source.getFullPathName(), nullptr);
    f.layer.setProperty ("committedArtifact", f.root.getChildFile ("missing.wav").getFullPathName(), nullptr);
    const auto before = f.edit.createCopy();

    const auto result = mosh::consolidateRenderArtifacts (f.edit, f.project);

    CHECK (result.failed());
    CHECK (result.getErrorMessage().contains ("committedArtifact"));
    CHECK (f.edit.isEquivalentTo (before));
    CHECK (source.loadFileAsString() == "source audio");
}

TEST_CASE ("legacy missing cache remains optional during consolidation", "[render-artifacts]")
{
    ArtifactFixture f;
    const auto missing = f.root.getChildFile ("missing.wav").getFullPathName();
    f.layer.setProperty (mosh::ids::cacheArtifact, missing, nullptr);

    const auto result = mosh::consolidateRenderArtifacts (f.edit, f.project);

    CHECK (result.wasOk());
    CHECK (f.layer[mosh::ids::cacheArtifact].toString() == missing);
}

TEST_CASE ("unwritable render destination reports failure without changing references", "[render-artifacts]")
{
    ArtifactFixture f;
    const auto source = f.asset ("original.wav", "source audio");
    f.layer.setProperty (mosh::ids::originalSourceRef, source.getFullPathName(), nullptr);
    REQUIRE (f.project.getChildFile ("audio").replaceWithText ("blocks directory creation"));
    const auto before = f.edit.createCopy();

    const auto result = mosh::consolidateRenderArtifacts (f.edit, f.project);

    CHECK (result.failed());
    CHECK (f.edit.isEquivalentTo (before));
    CHECK (source.loadFileAsString() == "source audio");
}

TEST_CASE ("corrupt stored content is reported without overwriting either asset", "[render-artifacts]")
{
    ArtifactFixture f;
    const auto source = f.asset ("original.wav", "source audio");
    f.layer.setProperty (mosh::ids::originalSourceRef, source.getFullPathName(), nullptr);
    const auto destination = f.project.getChildFile ("audio/renders")
        .getChildFile (juce::SHA256 (source).toHexString() + ".wav");
    REQUIRE (destination.getParentDirectory().createDirectory().wasOk());
    REQUIRE (destination.replaceWithText ("broken audio"));

    const auto result = mosh::consolidateRenderArtifacts (f.edit, f.project);

    CHECK (result.failed());
    CHECK (result.getErrorMessage().contains ("content identity"));
    CHECK (f.layer[mosh::ids::originalSourceRef].toString() == source.getFullPathName());
    CHECK (source.loadFileAsString() == "source audio");
    CHECK (destination.loadFileAsString() == "broken audio");
}

TEST_CASE ("consolidation reuses matching stored assets without changing references", "[render-artifacts]")
{
    ArtifactFixture f;
    const auto source = f.asset ("original.wav", "source audio");
    f.layer.setProperty (mosh::ids::originalSourceRef, source.getFullPathName(), nullptr);
    REQUIRE (mosh::consolidateRenderArtifacts (f.edit, f.project).wasOk());
    const auto before = f.edit.createCopy();
    const auto stored = mosh::resolveCacheArtifact (f.layer[mosh::ids::originalSourceRef].toString(), f.project);
    const auto modified = stored.getLastModificationTime();

    const auto result = mosh::consolidateRenderArtifacts (f.edit, f.project);

    CHECK (result.wasOk());
    CHECK (f.edit.isEquivalentTo (before));
    CHECK (stored.getLastModificationTime() == modified);
}
