// M1 contextual loop, end to end, headless: the real ReImagineProcessor driving the real
// service/server.py over loopback with the direct-render TEST FIXTURE adapter (no model,
// no weights, no musical evidence). Proves the plumbing: import -> context -> generate ->
// revise -> keep -> export -> save/reopen, plus backend-down, LAN refusal, cancellation,
// budget exhaustion, missing assets, source immutability and two-instance isolation.
//
// usage: MoshReImagineLoopE2E <repo-root>

#include "ReImagineProcessor.h"

#include <cstdlib>
#include <functional>
#include <iostream>

using namespace mosh::reimagine;

namespace
{
int failures = 0;

void check (bool condition, const juce::String& what)
{
    std::cout << (condition ? "  ok   " : "  FAIL ") << what << "\n";
    if (! condition)
        ++failures;
}

bool waitFor (const std::function<bool()>& condition, double seconds)
{
    const auto deadline = juce::Time::getMillisecondCounterHiRes() + seconds * 1000.0;
    while (juce::Time::getMillisecondCounterHiRes() < deadline)
    {
        if (condition())
            return true;
        juce::Thread::sleep (50);
    }
    return condition();
}

void setEnv (const char* name, const juce::String& value)
{
   #if JUCE_WINDOWS
    _putenv_s (name, value.toRawUTF8());
   #else
    setenv (name, value.toRawUTF8(), 1);
   #endif
}

bool writeFixtureWav (const juce::File& file, double seconds)
{
    const int rate = 48000;
    const auto frames = static_cast<int> (seconds * rate);
    juce::AudioBuffer<float> audio (2, frames);
    for (int i = 0; i < frames; ++i)
    {
        const auto t = static_cast<float> (i) / static_cast<float> (rate);
        const auto chord = (i / (rate * 2)) % 2 == 0 ? 174.6f : 138.6f;   // two "chords", two seconds each
        const auto v = 0.2f * std::sin (juce::MathConstants<float>::twoPi * chord * t)
                     + 0.1f * std::sin (juce::MathConstants<float>::twoPi * chord * 1.5f * t);
        audio.setSample (0, i, v);
        audio.setSample (1, i, v * 0.9f);
    }
    juce::WavAudioFormat wav;
    std::unique_ptr<juce::OutputStream> stream (file.createOutputStream().release());
    if (stream == nullptr)
        return false;
    auto writer = wav.createWriterFor (stream, juce::AudioFormatWriterOptions().withSampleRate (rate)
                                                   .withNumChannels (2).withBitsPerSample (24));
    return writer != nullptr && writer->writeFromAudioSampleBuffer (audio, 0, frames);
}

juce::String sha256 (const juce::File& file)
{
    juce::FileInputStream in (file);
    return in.openedOk() ? juce::SHA256 (in).toHexString() : juce::String();
}

const TransferRegion* selectedRegion (const PluginStateV1& state)
{
    for (const auto& region : state.regions)
        if (region.id == state.selectedRegionId)
            return &region;
    return nullptr;
}

size_t takeCount (const ReImagineProcessor& p)
{
    const auto state = p.stateSnapshot();
    const auto* region = selectedRegion (state);
    return region == nullptr ? 0 : region->takes.size();
}

IntentionRecord intention (const ReImagineProcessor& p, const juce::String& id)
{
    for (const auto& item : p.stateSnapshot().intentions)
        if (item.getProperty ("id", {}).toString() == id)
            return intentionFromVar (item);
    return {};
}

IntentionInput request (int count, int64_t seed = 0)
{
    IntentionInput in;
    in.request = "hazy sampled-keyboard loop, less busy performance";
    in.strength = 0.35f;
    in.candidateCount = count;
    in.baseSeed = seed;
    return in;
}

bool idle (const ReImagineProcessor& p) { return ! p.generationActive(); }

std::unique_ptr<ReImagineProcessor> importedProcessor (const juce::File& wav)
{
    auto p = std::make_unique<ReImagineProcessor>();
    p->importTakeFromFile (wav, 1.0);
    waitFor ([&] { return takeCount (*p) == 1; }, 10.0);
    return p;
}

bool runGeneration (ReImagineProcessor& p, const std::function<juce::StringArray()>& start, size_t expectedTakes)
{
    start();
    juce::Thread::sleep (100);
    return waitFor ([&] { return idle (p) && takeCount (p) >= expectedTakes; }, 120.0) && idle (p);
}
}

int main (int argc, char** argv)
{
    if (argc != 2)
    {
        std::cerr << "usage: MoshReImagineLoopE2E <repo-root>\n";
        return 2;
    }
    const juce::File repo (juce::File::getCurrentWorkingDirectory().getChildFile (argv[1]));
    const auto server = repo.getChildFile ("service/server.py");
    if (! server.existsAsFile())
    {
        std::cerr << "service/server.py not found under " << repo.getFullPathName() << "\n";
        return 2;
    }

    // Hermetic HOME: asset store, experience log and exports land in a scratch tree.
    const auto home = juce::File::getSpecialLocation (juce::File::tempDirectory)
                          .getNonexistentChildFile ("mosh-m1-e2e", "", false);
    home.createDirectory();
    setEnv ("HOME", home.getFullPathName());
    setEnv ("MOSH_REIMAGINE_HOME", home.getFullPathName());   // macOS JUCE ignores $HOME
    const auto port = 18700 + juce::Random::getSystemRandom().nextInt (900);
    setEnv ("MOSH_SERVICE_HOST", "127.0.0.1");
    setEnv ("MOSH_SERVICE_PORT", juce::String (port));
    setEnv ("MOSH_SERVICE_SCRIPT", home.getChildFile ("no-helper/server.py").getFullPathName());   // never auto-spawn
    setEnv ("MOSH_REIMAGINE_ADAPTER", "fake");
    setEnv ("MOSH_DIRECT_RENDER_TEST_FIXTURE", "1");
    setEnv ("PYTHONDONTWRITEBYTECODE", "1");

    juce::ScopedJuceInitialiser_GUI juceInit;
    const auto source = home.getChildFile ("keys-8bars.wav");
    if (! writeFixtureWav (source, 4.0))
    {
        std::cerr << "could not write fixture WAV\n";
        return 2;
    }
    const auto sourceHashBefore = sha256 (source);

    std::cout << "backend down\n";
    auto p = importedProcessor (source);
    check (takeCount (*p) == 1, "import creates a region with its import take");
    {
        const auto messages = p->setSelectedContext ("F minor", "1:Fm7 2:Db", "Verse", "chord-change timing");
        check (messages.isEmpty(), "valid context is stored");
        check (! p->setSelectedContext ("F minor", "2:Db 1:Fm7", "", "").isEmpty(), "invalid chord order is refused");
        const auto ctx = p->selectedContext();
        check (ctx.key == "F minor" && ctx.keyFrom == Provenance::user && ctx.chords.size() == 2,
               "refused edit leaves the stored context unchanged");
        check (! ctx.bpm.has_value(), "assumed import tempo is not reported as known");
    }
    p->generateCandidates (request (2));
    waitFor ([&] { return idle (*p) && p->statusText().contains ("unavailable"); }, 20.0);
    check (p->statusText().contains ("no remote fallback"), "helper down is reported without fallback: " + p->statusText());
    check (takeCount (*p) == 1, "no version is created while the helper is down");
    for (const auto& item : p->stateSnapshot().intentions)
        check (intentionFromVar (item).attempts == 0, "no attempts are spent while the helper is down");

    std::cout << "LAN host refused\n";
    setEnv ("MOSH_SERVICE_HOST", "10.20.30.40");
    {
        auto lan = importedProcessor (source);
        lan->generateCandidates (request (1));
        waitFor ([&] { return idle (*lan) && lan->statusText().contains ("not this machine"); }, 10.0);
        check (lan->statusText().contains ("not this machine"), "non-loopback helper is refused: " + lan->statusText());
    }
    setEnv ("MOSH_SERVICE_HOST", "127.0.0.1");

    std::cout << "helper up (TEST FIXTURE adapter)\n";
    juce::ChildProcess helper;
    if (! helper.start (juce::StringArray { "python3", server.getFullPathName() }, 0))
    {
        std::cerr << "could not start service/server.py\n";
        return 2;
    }
    const auto healthy = waitFor ([&]
    {
        auto options = juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inAddress).withConnectionTimeoutMs (500);
        auto stream = juce::URL ("http://127.0.0.1:" + juce::String (port) + "/health").createInputStream (options);
        return stream != nullptr && stream->readEntireStreamAsString().contains ("\"ok\": true");
    }, 30.0);
    check (healthy, "service/server.py is healthy on loopback");

    const auto first = takeCount (*p);
    const auto warnings = p->generateCandidates (request (2, 100));
    check (warnings.joinIntoString ("|").contains ("not enforced"), "chord conditioning is reported as text-only");
    juce::Thread::sleep (100);
    waitFor ([&] { return idle (*p) && takeCount (*p) >= first + 2; }, 120.0);
    auto state = p->stateSnapshot();
    const auto* region = selectedRegion (state);
    check (region != nullptr && region->takes.size() == first + 2, "two candidates were created: " + p->statusText());
    juce::String intentionId, versionB;
    if (region != nullptr && region->takes.size() == first + 2)
    {
        const auto a = lineageOf (region->takes[first]);
        const auto b = lineageOf (region->takes[first + 1]);
        intentionId = a.intentionId;
        versionB = region->takes[first + 1].id;
        check (a.role == "candidate" && a.intentionId == b.intentionId && a.parentTakeId.isEmpty(), "candidates share one intention");
        check (a.testFixture && b.testFixture, "fixture output is labelled as test output");
        check (region->takes[first].seed == 100 && region->takes[first + 1].seed == 101, "distinct candidate seeds");
        check (region->selectedTakeId == region->takes[first].id, "first candidate is auditioned when nothing is kept");
        const auto checks = region->takes[first].manifest["m1"]["checks"];
        check (static_cast<bool> (checks["usable"]), "technical checks recorded on the version");
        check (region->takes[first].manifest["m1"]["request"]["conditioning"].size() >= 6, "conditioning report stored with the version");
    }
    check (intention (*p, intentionId).attempts == 2, "two attempts counted");

    std::cout << "revise version B\n";
    p->setSelectedTake (static_cast<int> (first + 1));
    auto revisionInput = request (2);
    revisionInput.revision = "roughen the texture, preserve the chord-change timing";
    runGeneration (*p, [&] { return p->reviseSelected (revisionInput, true); }, first + 4);
    state = p->stateSnapshot();
    region = selectedRegion (state);
    check (region != nullptr && region->takes.size() == first + 4, "two revisions were created: " + p->statusText());
    if (region != nullptr && region->takes.size() == first + 4)
    {
        const auto r = lineageOf (region->takes[first + 2]);
        check (r.role == "revision" && r.parentTakeId == versionB && r.intentionId == intentionId, "revision links to version B");
        check (region->takes[first + 2].manifest["m1"]["inputRole"].toString() == "parent-take", "revision started from B's audio");
        check (region->takes[first + 2].manifest["m1"]["request"]["prompt"].toString().contains ("roughen"), "revision text reached the prompt");
    }
    check (intention (*p, intentionId).attempts == 4, "four attempts counted");

    std::cout << "keep, budget, export\n";
    p->keepSelected();
    const auto keptId = p->stateSnapshot().regions.front().selectedTakeId;
    {
        state = p->stateSnapshot();
        region = selectedRegion (state);
        bool kept = false;
        for (const auto& take : region->takes)
            if (take.id == keptId)
                kept = lineageOf (take).kept;
        check (kept, "selected version is kept");
    }
    auto more = request (4);
    more.revision = "even hazier";
    runGeneration (*p, [&] { return p->reviseSelected (more, true); }, first + 8);
    check (takeCount (*p) == first + 8, "four more revisions within budget");
    check (p->stateSnapshot().regions.front().selectedTakeId == keptId, "new versions do not displace the kept selection");
    check (intention (*p, intentionId).attempts == 8, "budget fully used (8/8)");
    auto over = request (1);
    over.revision = "one more";
    const auto refused = p->reviseSelected (over, true);
    check (refused.joinIntoString ("|").contains ("Budget"), "ninth attempt is refused by the budget");
    check (idle (*p) && takeCount (*p) == first + 8, "nothing queued past the budget");

    juce::String exportError;
    const auto exported = p->exportSelected (exportError);
    check (exported.existsAsFile() && exported.isAChildOf (home.getChildFile ("Music/Mosh Exports")), "export wrote a durable WAV: " + exported.getFullPathName() + exportError);
    {
        state = p->stateSnapshot();
        region = selectedRegion (state);
        juce::String keptHash;
        for (const auto& take : region->takes)
            if (take.id == keptId)
                keptHash = take.assetHash;
        check (sha256 (exported) == keptHash, "export is byte-identical to the kept version");
        check (exported.withFileExtension ("json").existsAsFile(), "export sidecar written");
        const auto again = p->exportSelected (exportError);
        check (again == exported, "re-export is idempotent");
    }

    std::cout << "cancel\n";
    {
        auto c = importedProcessor (source);
        const auto before = takeCount (*c);
        c->generateCandidates (request (4, 7));
        c->cancelGeneration();
        waitFor ([&] { return idle (*c); }, 60.0);
        juce::Thread::sleep (1500);   // let any in-flight helper work finish; its result must be discarded
        check (takeCount (*c) < before + 4, "cancel stops the batch (" + juce::String (static_cast<int> (takeCount (*c) - before)) + " published)");
    }

    std::cout << "two instances, one helper\n";
    {
        auto x = importedProcessor (source);
        auto y = importedProcessor (source);
        x->generateCandidates (request (1, 11));
        y->generateCandidates (request (1, 22));
        waitFor ([&] { return idle (*x) && idle (*y) && takeCount (*x) == 2 && takeCount (*y) == 2; }, 120.0);
        const auto xs = x->stateSnapshot(), ys = y->stateSnapshot();
        check (takeCount (*x) == 2 && takeCount (*y) == 2, "each instance received exactly its own result: x="
               + juce::String (static_cast<int> (takeCount (*x))) + " (" + x->statusText() + ") y="
               + juce::String (static_cast<int> (takeCount (*y))) + " (" + y->statusText() + ")");
        if (takeCount (*x) == 2 && takeCount (*y) == 2)
        {
            check (xs.regions.front().takes[1].seed == 11 && ys.regions.front().takes[1].seed == 22, "results did not cross instances");
            check (xs.regions.front().takes[1].manifest["m1"]["requestId"].toString()
                       .startsWith (lineageOf (xs.regions.front().takes[1]).intentionId), "request ids are bound to the intention");
        }
    }

    std::cout << "save / reopen / missing asset\n";
    juce::MemoryBlock saved;
    p->getStateInformation (saved);
    {
        ReImagineProcessor reopened;
        reopened.setStateInformation (saved.getData(), static_cast<int> (saved.getSize()));
        reopened.prepareToPlay (48000.0, 512);
        waitFor ([&] { return reopened.statusText().contains ("loaded"); }, 10.0);
        const auto s = reopened.stateSnapshot();
        check (s.regions.size() == 1 && s.regions.front().takes.size() == first + 8, "versions restored");
        check (s.regions.front().selectedTakeId == keptId, "kept selection restored");
        check (intention (reopened, intentionId).attempts == 8, "budget restored");
        check (contextFromVar (s.regions.front().context).chords.size() == 2, "region context restored");
        check (reopened.statusText() == "Selected takes loaded", "selected version audio loads: " + reopened.statusText());
    }
    {
        state = p->stateSnapshot();
        region = selectedRegion (state);
        juce::String keptHash;
        for (const auto& take : region->takes)
            if (take.id == keptId)
                keptHash = take.assetHash;
        home.getChildFile ("Library/Mosh/ReImagine/assets/renders/" + keptHash + ".wav").deleteFile();
        ReImagineProcessor missing;
        missing.setStateInformation (saved.getData(), static_cast<int> (saved.getSize()));
        missing.prepareToPlay (48000.0, 512);
        waitFor ([&] { return missing.statusText().contains ("missing"); }, 10.0);
        check (missing.statusText().contains ("missing"), "missing asset is reported, audio stays dry: " + missing.statusText());
        check (exported.existsAsFile() && sha256 (exported) == keptHash, "exported copy survives the cache loss");
    }

    std::cout << "source protection and experience log\n";
    check (sha256 (source) == sourceHashBefore, "the user's source file is byte-identical");
    const auto log = home.getChildFile ("Library/Mosh/ReImagine/experience.jsonl").loadFileAsString();
    for (const auto* needle : { "\"intention.compiled\"", "\"revision.requested\"", "\"generation.unavailable\"",
                                "\"version.kept\"", "\"version.exported\"", "\"version.auditioned\"", "\"context.edited\"" })
        check (log.contains (needle), juce::String ("experience log has ") + needle);
    check (log.contains ("\"signal\": \"explicit\"") && log.contains ("\"signal\": \"implicit\""), "explicit and implicit signals are distinguished");

    p.reset();
    helper.kill();
    if (failures == 0)
        home.deleteRecursively();
    else
        std::cout << "evidence kept in " << home.getFullPathName() << "\n";
    std::cout << (failures == 0 ? "PASS" : "FAIL") << " (" << failures << " failures)\n";
    return failures == 0 ? 0 : 1;
}
