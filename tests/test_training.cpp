#include <catch2/catch_test_macros.hpp>
#include <cstddef>
#include <juce_core/juce_core.h>
#include <juce_cryptography/juce_cryptography.h>
#include "training/TrainerRegistry.h"

namespace
{
    juce::File makeTempRoot()
    {
        auto root = juce::File::getSpecialLocation (juce::File::tempDirectory)
                        .getChildFile ("mosh-training-test-" + juce::String (juce::Time::getCurrentTime().toMilliseconds()));
        root.deleteRecursively();
        root.createDirectory();
        return root;
    }

    juce::File writeDummyFile (const juce::File& file, const juce::String& text)
    {
        file.getParentDirectory().createDirectory();
        file.replaceWithText (text);
        return file;
}

juce::var runFakeTrainer (const juce::File& serviceDir,
                          const juce::String& corpusBundle,
                          const juce::File& outputDir,
                          juce::String& error)
{
    juce::String script;
    script << "import json, os, sys\n"
           << "sys.path.insert(0, sys.argv[1])\n"
           << "os.environ['MOSH_TRAINING_BACKEND'] = 'fake'\n"
           << "from training.trainer_job import train\n"
           << "result = train(sys.argv[2], sys.argv[3], {'rank': 16, 'steps': 64, 'lr': 1e-4, 'base_model': 'test-base'})\n"
           << "print(json.dumps(result, sort_keys=True))\n";

    juce::ChildProcess proc;
    if (! proc.start (juce::StringArray { "python3", "-c", script, serviceDir.getFullPathName(), corpusBundle, outputDir.getFullPathName() }))
    {
        error = "could not start python trainer";
        return {};
    }

    juce::MemoryOutputStream captured;
    auto drainOutput = [&]
    {
        char buffer[4096];

        for (;;)
        {
            const auto bytesRead = proc.readProcessOutput (buffer, (int) sizeof (buffer));
            if (bytesRead <= 0)
                break;

            captured.write (buffer, static_cast<std::size_t> (bytesRead));
        }
    };

    const auto startMs = juce::Time::getMillisecondCounter();
    while (proc.isRunning())
    {
        drainOutput();

        if (juce::Time::getMillisecondCounter() - startMs >= 120000u)
        {
            proc.kill();
            drainOutput();
            error = "python trainer timed out";
            return {};
        }

        juce::Thread::sleep (5);
    }

    drainOutput();
    auto output = captured.toString().trim();
    if (output.isEmpty())
    {
        error = "python trainer produced no output";
        return {};
    }

    auto parsed = juce::JSON::parse (output);
    if (! parsed.isObject())
    {
        error = "python trainer output was not JSON";
        return {};
    }

    return parsed;
}
}

TEST_CASE ("[smoke] trainer imports a local source, builds corpus, trains fake adapter, and activates", "[training]")
{
    auto root = makeTempRoot();
    auto sessionDir = root.getChildFile ("session");
    sessionDir.createDirectory();
    mosh::TrainerRegistry registry (sessionDir);

    auto sourceFile = writeDummyFile (root.getChildFile ("source.wav"), "dummy-audio");
    juce::String error;
    auto source = registry.importSource (juce::var (new juce::DynamicObject()), error);
    REQUIRE (error.isNotEmpty());

    auto* importArgs = new juce::DynamicObject();
    importArgs->setProperty ("title", "Reference Beat");
    importArgs->setProperty ("creator", "Producer");
    importArgs->setProperty ("sourceUrl", "https://example.invalid/beat");
    importArgs->setProperty ("localPath", sourceFile.getFullPathName());
    importArgs->setProperty ("userClaimedLicense", "user-granted + written approval");
    importArgs->setProperty ("proofOfRights", "user claim");
    importArgs->setProperty ("approvedForTraining", false);
    auto imported = registry.importSource (juce::var (importArgs), error);
    REQUIRE (error.isEmpty());
    REQUIRE (imported.isObject());
    REQUIRE (imported.getProperty ("source_id", juce::var()).toString().isNotEmpty());

    auto approved = registry.approveSource (imported.getProperty ("source_id", juce::var()).toString(), true, error);
    REQUIRE (error.isEmpty());
    REQUIRE ((bool) approved.getProperty ("approved_for_training", false));

    auto bundle = registry.buildCorpus (juce::var (new juce::DynamicObject()), error);
    REQUIRE (error.isEmpty());
    REQUIRE (bundle.isObject());
    REQUIRE (juce::File (bundle.getProperty ("bundlePath", juce::var()).toString()).exists());
    REQUIRE (juce::File (bundle.getProperty ("manifestPath", juce::var()).toString()).existsAsFile());
    REQUIRE ((int) bundle.getProperty ("sourceCount", 0) == 1);

    auto trainerOutputDir = root.getChildFile ("trainer-output");
    trainerOutputDir.createDirectory();
    auto trainer = runFakeTrainer (juce::File::getCurrentWorkingDirectory().getChildFile ("service"),
                                   bundle.getProperty ("bundlePath", juce::var()).toString(),
                                   trainerOutputDir,
                                   error);
    REQUIRE (error.isEmpty());
    REQUIRE (trainer.isObject());
    REQUIRE (juce::File (trainer.getProperty ("artifact_path", juce::var()).toString()).existsAsFile());
    REQUIRE (juce::File (trainer.getProperty ("manifest_path", juce::var()).toString()).existsAsFile());

    auto importedAdapter = registry.importAdapter (trainer.getProperty ("artifact_path", juce::var()).toString(),
                                                   trainer.getProperty ("manifest_path", juce::var()).toString(),
                                                   "", error);
    REQUIRE (error.isEmpty());
    REQUIRE (importedAdapter.isObject());
    REQUIRE (registry.activeAdapterId() == trainer.getProperty ("adapter_id", juce::var()).toString());

    auto activated = registry.activateAdapter (trainer.getProperty ("adapter_id", juce::var()).toString(),
                                               trainer.getProperty ("artifact_path", juce::var()).toString(),
                                               bundle.getProperty ("bundleHash", juce::var()).toString(), error);
    REQUIRE (error.isEmpty());
    REQUIRE (activated.getProperty ("adapterId", juce::var()).toString() == trainer.getProperty ("adapter_id", juce::var()).toString());

    auto adapters = registry.listAdapters();
    REQUIRE (adapters.isObject());
    REQUIRE (adapters.getProperty ("adapters", juce::var()).size() == 1);

    auto state = registry.snapshot();
    REQUIRE (state.isObject());
    REQUIRE (state.getProperty ("activeAdapterId", juce::var()).toString() == trainer.getProperty ("adapter_id", juce::var()).toString());

    root.deleteRecursively();
}

TEST_CASE ("importSource: re-importing an existing source_id returns its real index, not size()-1", "[training]")
{
    auto root = makeTempRoot();
    auto sessionDir = root.getChildFile ("session");
    sessionDir.createDirectory();
    mosh::TrainerRegistry registry (sessionDir);
    juce::String error;

    // First import: "alpha" lands at index 0.
    auto* first = new juce::DynamicObject();
    first->setProperty ("sourceId", "alpha");
    first->setProperty ("title", "Alpha Beat");
    first->setProperty ("creator", "Producer A");
    first->setProperty ("sourceUrl", "https://example.invalid/alpha");
    auto alpha = registry.importSource (juce::var (first), error);
    REQUIRE (error.isEmpty());
    REQUIRE ((int) alpha.getProperty ("index", -1) == 0);

    // Second import: "beta" lands at index 1.
    auto* second = new juce::DynamicObject();
    second->setProperty ("sourceId", "beta");
    second->setProperty ("title", "Beta Beat");
    second->setProperty ("creator", "Producer B");
    second->setProperty ("sourceUrl", "https://example.invalid/beta");
    auto beta = registry.importSource (juce::var (second), error);
    REQUIRE (error.isEmpty());
    REQUIRE ((int) beta.getProperty ("index", -1) == 1);

    // Re-importing "alpha" with different content REPLACES the record in its
    // existing slot (0); the returned summary must point at that real slot, not
    // sources.size()-1 (which is slot 1 -- "beta"'s slot -- once "beta" exists).
    auto* alphaAgain = new juce::DynamicObject();
    alphaAgain->setProperty ("sourceId", "alpha");
    alphaAgain->setProperty ("title", "Alpha Beat (re-imported)");
    alphaAgain->setProperty ("creator", "Producer A");
    alphaAgain->setProperty ("sourceUrl", "https://example.invalid/alpha-v2");
    auto alphaReimported = registry.importSource (juce::var (alphaAgain), error);
    REQUIRE (error.isEmpty());
    REQUIRE (alphaReimported.getProperty ("source_id", juce::var()).toString() == "alpha");
    REQUIRE ((int) alphaReimported.getProperty ("index", -1) == 0);
    REQUIRE (alphaReimported.getProperty ("title", juce::var()).toString() == "Alpha Beat (re-imported)");

    // Cross-check against listSources(): slot 0 is the updated "alpha", slot 1 is
    // the untouched "beta" -- the replacement must not have disturbed either slot.
    auto list = registry.listSources();
    auto items = list.getProperty ("sources", juce::var());
    REQUIRE (items.size() == 2);
    REQUIRE (items[0].getProperty ("source_id", juce::var()).toString() == "alpha");
    REQUIRE (items[0].getProperty ("title", juce::var()).toString() == "Alpha Beat (re-imported)");
    REQUIRE ((int) items[0].getProperty ("index", -1) == 0);
    REQUIRE (items[1].getProperty ("source_id", juce::var()).toString() == "beta");
    REQUIRE ((int) items[1].getProperty ("index", -1) == 1);

    root.deleteRecursively();
}

// ── TrainerRegistry::snapshot() — the block MoshOps::snapshot() carries as `training` ──
// The UI's training popover and LoRA Lab read that block and nothing else, and it is
// asked for after every command, so the registry serves it from memory. These pin the
// two halves of that bargain: every write through the registry shows up in the very
// next snapshot, and a snapshot with nothing new to say does not go back to the disk.

namespace
{
    juce::var importApprovedSource (mosh::TrainerRegistry& registry, const juce::File& audio,
                                    const juce::String& title, bool approved)
    {
        auto* args = new juce::DynamicObject();
        args->setProperty ("title", title);
        args->setProperty ("creator", "Producer");
        args->setProperty ("localPath", audio.getFullPathName());
        args->setProperty ("userClaimedLicense", "own work");
        args->setProperty ("proofOfRights", "made it");
        args->setProperty ("approvedForTraining", approved);
        juce::String error;
        auto source = registry.importSource (juce::var (args), error);
        REQUIRE (error.isEmpty());
        return source;
    }

    juce::var snapshotSource (mosh::TrainerRegistry& registry, const juce::String& sourceId)
    {
        const auto sources = registry.snapshot().getProperty ("sources", juce::var());
        for (int i = 0; i < sources.size(); ++i)
            if (sources[i].getProperty ("source_id", juce::var()).toString() == sourceId)
                return sources[i];
        return {};
    }

    juce::var snapshotJob (mosh::TrainerRegistry& registry, const juce::String& jobId)
    {
        const auto jobs = registry.snapshot().getProperty ("jobs", juce::var());
        for (int i = 0; i < jobs.size(); ++i)
            if (jobs[i].getProperty ("jobId", juce::var()).toString() == jobId)
                return jobs[i];
        return {};
    }

    juce::var jobRecord (const juce::String& jobId, const juce::String& status, double progress)
    {
        auto* job = new juce::DynamicObject();
        job->setProperty ("jobId", jobId);
        job->setProperty ("status", status);
        job->setProperty ("progress", progress);
        return juce::var (job);
    }
}

TEST_CASE ("snapshot: an empty registry still has the lists the UI maps over", "[training][snapshot]")
{
    auto root = makeTempRoot();
    mosh::TrainerRegistry registry (root.getChildFile ("session"));

    const auto state = registry.snapshot();
    REQUIRE (state.isObject());
    for (auto* list : { "sources", "adapters", "jobs" })
    {
        INFO (list);
        REQUIRE (state.getProperty (list, juce::var()).isArray());
        REQUIRE (state.getProperty (list, juce::var()).size() == 0);
    }
    REQUIRE (state.getProperty ("registryPath", juce::var()).toString() == registry.registryFile().getFullPathName());
    REQUIRE (state.getProperty ("statePath", juce::var()).toString() == registry.stateFile().getFullPathName());
    REQUIRE (state.getProperty ("activeAdapterId", juce::var()).isString());

    root.deleteRecursively();
}

TEST_CASE ("snapshot: every write through the registry is in the next snapshot", "[training][snapshot]")
{
    auto root = makeTempRoot();
    mosh::TrainerRegistry registry (root.getChildFile ("session"));
    juce::String error;

    // Ask first, so each step below has an older answer it must not hand back.
    REQUIRE (registry.snapshot().getProperty ("sources", juce::var()).size() == 0);

    auto audio = writeDummyFile (root.getChildFile ("beat.wav"), "dummy-audio");
    const auto sourceId = importApprovedSource (registry, audio, "First Beat", false)
                              .getProperty ("source_id", juce::var()).toString();
    auto listed = snapshotSource (registry, sourceId);
    REQUIRE (listed.isObject());
    REQUIRE (listed.getProperty ("title", juce::var()).toString() == "First Beat");
    REQUIRE_FALSE ((bool) listed.getProperty ("eligible", true));
    REQUIRE (listed.getProperty ("blocked_reason", juce::var()).toString() == "not approved_for_training");

    registry.approveSource (sourceId, true, error);
    REQUIRE (error.isEmpty());
    REQUIRE ((bool) snapshotSource (registry, sourceId).getProperty ("eligible", false));

    registry.approveSource (sourceId, false, error);
    REQUIRE (error.isEmpty());
    REQUIRE_FALSE ((bool) snapshotSource (registry, sourceId).getProperty ("eligible", true));

    // Jobs live in the other file, with its own cached half.
    REQUIRE (registry.snapshot().getProperty ("jobs", juce::var()).size() == 0);
    registry.updateJob (jobRecord ("job-1", "queued", 0.0));
    REQUIRE (snapshotJob (registry, "job-1").getProperty ("status", juce::var()).toString() == "queued");
    registry.updateJob (jobRecord ("job-1", "ready", 1.0));
    REQUIRE (snapshotJob (registry, "job-1").getProperty ("status", juce::var()).toString() == "ready");
    REQUIRE (registry.snapshot().getProperty ("jobs", juce::var()).size() == 1);

    REQUIRE (registry.snapshot().getProperty ("activeAdapterId", juce::var()).toString().isEmpty());
    registry.activateAdapter ("adapter-1", "/somewhere/adapter-1.safetensors", "hash-1", error);
    REQUIRE (error.isEmpty());
    const auto activated = registry.snapshot();
    REQUIRE (activated.getProperty ("activeAdapterId", juce::var()).toString() == "adapter-1");
    REQUIRE (activated.getProperty ("activeAdapterPath", juce::var()).toString() == "/somewhere/adapter-1.safetensors");
    REQUIRE (activated.getProperty ("activeCorpusHash", juce::var()).toString() == "hash-1");

    // A write to one file must not lose what the other half already held.
    REQUIRE (snapshotJob (registry, "job-1").isObject());
    REQUIRE (snapshotSource (registry, sourceId).isObject());

    root.deleteRecursively();
}

TEST_CASE ("snapshot: is served from memory until the registry looks at the disk again", "[training][snapshot]")
{
    auto root = makeTempRoot();
    mosh::TrainerRegistry registry (root.getChildFile ("session"));
    juce::String error;

    auto audio = writeDummyFile (root.getChildFile ("beat.wav"), "dummy-audio");
    const auto sourceId = importApprovedSource (registry, audio, "Only Beat", true)
                              .getProperty ("source_id", juce::var()).toString();
    REQUIRE ((bool) snapshotSource (registry, sourceId).getProperty ("eligible", false));

    // The source's audio file is not the registry's to watch. Building the block
    // from disk on every call would notice this at once — at the price of a stat
    // per source after every command.
    REQUIRE (audio.deleteFile());
    REQUIRE ((bool) snapshotSource (registry, sourceId).getProperty ("eligible", false));

    SECTION ("a direct read is a fresh look, and the snapshot follows it")
    {
        const auto direct = registry.listSources().getProperty ("sources", juce::var());
        REQUIRE (direct.size() == 1);
        REQUIRE_FALSE ((bool) direct[0].getProperty ("eligible", true));

        const auto listed = snapshotSource (registry, sourceId);
        REQUIRE_FALSE ((bool) listed.getProperty ("eligible", true));
        REQUIRE (listed.getProperty ("blocked_reason", juce::var()).toString().startsWith ("missing local file"));
    }

    SECTION ("building a corpus looks again too, even when it finds nothing to build")
    {
        auto bundle = registry.buildCorpus (juce::var (new juce::DynamicObject()), error);
        REQUIRE (error == "no approved local sources available for training");
        REQUIRE_FALSE ((bool) snapshotSource (registry, sourceId).getProperty ("eligible", true));
    }

    root.deleteRecursively();
}

TEST_CASE ("snapshot: what the caller gets is the caller's own copy", "[training][snapshot]")
{
    auto root = makeTempRoot();
    mosh::TrainerRegistry registry (root.getChildFile ("session"));

    auto audio = writeDummyFile (root.getChildFile ("beat.wav"), "dummy-audio");
    const auto sourceId = importApprovedSource (registry, audio, "Kept Title", true)
                              .getProperty ("source_id", juce::var()).toString();
    registry.updateJob (jobRecord ("job-1", "queued", 0.0));

    // juce::var objects are shared by reference: without a copy, a consumer that
    // edits its snapshot would be editing every later one.
    auto mine = registry.snapshot();
    mine.getProperty ("sources", juce::var())[0].getDynamicObject()->setProperty ("title", "scribbled");
    mine.getProperty ("jobs", juce::var())[0].getDynamicObject()->setProperty ("status", "scribbled");
    mine.getProperty ("sources", juce::var()).getArray()->clear();

    REQUIRE (snapshotSource (registry, sourceId).getProperty ("title", juce::var()).toString() == "Kept Title");
    REQUIRE (snapshotJob (registry, "job-1").getProperty ("status", juce::var()).toString() == "queued");

    // The same goes for a direct read handed out before the snapshot was asked for.
    auto direct = registry.listSources();
    direct.getProperty ("sources", juce::var())[0].getDynamicObject()->setProperty ("title", "scribbled");
    REQUIRE (snapshotSource (registry, sourceId).getProperty ("title", juce::var()).toString() == "Kept Title");

    root.deleteRecursively();
}

TEST_CASE ("sha256File (via buildCorpus manifest): streamed hash equals a full-read reference hash", "[training]")
{
    auto root = makeTempRoot();
    auto sessionDir = root.getChildFile ("session");
    sessionDir.createDirectory();
    mosh::TrainerRegistry registry (sessionDir);
    juce::String error;

    // Large enough to span many 64-byte SHA-256 blocks -- a single tiny file
    // wouldn't exercise a chunked/streamed read path.
    juce::String content;
    for (int i = 0; i < 5000; ++i)
        content << "mosh-training-corpus-line-" << i << "\n";
    auto sourceFile = writeDummyFile (root.getChildFile ("bigsource.wav"), content);

    // Reference hash computed the OLD way (full read into one MemoryBlock, then
    // hash that block) -- independent of TrainerRegistry::sha256File's own
    // implementation, so this is a real equivalence check, not a tautology.
    juce::MemoryBlock wholeFile;
    REQUIRE (sourceFile.loadFileAsData (wholeFile));
    const auto referenceHash = juce::SHA256 (wholeFile.getData(), wholeFile.getSize()).toHexString();

    auto* importArgs = new juce::DynamicObject();
    importArgs->setProperty ("title", "Big Beat");
    importArgs->setProperty ("creator", "Producer");
    importArgs->setProperty ("sourceUrl", "https://example.invalid/big");
    importArgs->setProperty ("localPath", sourceFile.getFullPathName());
    importArgs->setProperty ("userClaimedLicense", "user-granted");
    importArgs->setProperty ("proofOfRights", "user claim");
    importArgs->setProperty ("approvedForTraining", true);
    auto imported = registry.importSource (juce::var (importArgs), error);
    REQUIRE (error.isEmpty());

    auto bundle = registry.buildCorpus (juce::var (new juce::DynamicObject()), error);
    REQUIRE (error.isEmpty());
    auto manifestFile = juce::File (bundle.getProperty ("manifestPath", juce::var()).toString());
    REQUIRE (manifestFile.existsAsFile());
    auto manifest = juce::JSON::parse (manifestFile.loadFileAsString());
    REQUIRE (manifest.isObject());
    auto sources = manifest.getProperty ("sources", juce::var());
    REQUIRE (sources.size() == 1);
    auto actualHash = sources[0].getProperty ("sha256", juce::var()).toString();
    REQUIRE (actualHash.isNotEmpty());
    REQUIRE (actualHash == referenceHash);

    root.deleteRecursively();
}
