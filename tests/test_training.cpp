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
