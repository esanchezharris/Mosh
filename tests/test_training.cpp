#include <catch2/catch_test_macros.hpp>
#include <juce_core/juce_core.h>
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

    if (! proc.waitForProcessToFinish (120000))
    {
        error = "python trainer timed out";
        return {};
    }

    auto output = proc.readAllProcessOutput().trim();
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
