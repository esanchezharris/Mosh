// M1 contextual loop, end to end, headless: the real ReImagineProcessor driving the real
// service/server.py over loopback with the direct-render TEST FIXTURE adapter (no model,
// no weights, no musical evidence). Proves the plumbing: import -> context -> generate ->
// revise -> keep -> export -> save/reopen, plus backend-down, LAN refusal, cancellation,
// budget exhaustion, missing assets, source immutability and two-instance isolation.
// Conform and free audition run before the helper starts and need no service: a fake
// playhead stands in for host timing (no real host, no listening).
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

// A 121 BPM style click (12 ms decaying 1 kHz burst per beat), for conform.
bool writeClickWav (const juce::File& file, double bpm, double seconds)
{
    const int rate = 48000;
    const auto frames = static_cast<int> (seconds * rate);
    juce::AudioBuffer<float> audio (2, frames);
    audio.clear();
    for (double t = 0.0137; t < seconds; t += 60.0 / bpm)
    {
        const auto start = static_cast<int> (std::llround (t * rate));
        for (int i = 0; i < static_cast<int> (0.012 * rate) && start + i < frames; ++i)
        {
            const auto x = static_cast<float> (i) / static_cast<float> (rate);
            const auto v = 0.8f * std::exp (-x / 0.003f) * std::sin (juce::MathConstants<float>::twoPi * 1000.0f * x);
            audio.setSample (0, start + i, v);
            audio.setSample (1, start + i, v);
        }
    }
    juce::WavAudioFormat wav;
    std::unique_ptr<juce::OutputStream> stream (file.createOutputStream().release());
    if (stream == nullptr)
        return false;
    auto writer = wav.createWriterFor (stream, juce::AudioFormatWriterOptions().withSampleRate (rate)
                                                   .withNumChannels (2).withBitsPerSample (24));
    return writer != nullptr && writer->writeFromAudioSampleBuffer (audio, 0, frames);
}

// Host timing for the headless processor: 120 BPM 4/4, stopped or playing at a ppq.
struct FakePlayHead final : juce::AudioPlayHead
{
    bool playing = false;
    double ppq = 0.0;
    double bpm = 120.0;
    juce::Optional<PositionInfo> getPosition() const override
    {
        PositionInfo info;
        info.setBpm (bpm);
        info.setTimeSignature (TimeSignature { 4, 4 });
        info.setPpqPosition (ppq);
        info.setTimeInSamples (static_cast<int64_t> (ppq * 0.5 * 48000.0));
        info.setIsPlaying (playing);
        return info;
    }
};

// Host timing from an exact sample counter, 120 BPM 4/4 (a ppq accumulated in floating
// point drifts by a sample, and a Transfer correctly aborts on that discontinuity).
struct SamplePlayHead final : juce::AudioPlayHead
{
    explicit SamplePlayHead (double r) : rate (r) {}
    double rate;
    bool playing = false;
    bool looping = false;
    int64_t samples = 0;
    juce::Optional<PositionInfo> getPosition() const override
    {
        PositionInfo info;
        info.setBpm (120.0);
        info.setTimeSignature (TimeSignature { 4, 4 });
        info.setPpqPosition (static_cast<double> (samples) * 2.0 / rate);
        info.setTimeInSamples (samples);
        info.setIsPlaying (playing);
        info.setIsLooping (looping);
        return info;
    }
};

bool writeToneWav (const juce::File& file, double rate, double seconds)
{
    const auto frames = static_cast<int> (seconds * rate);
    juce::AudioBuffer<float> audio (2, frames);
    for (int i = 0; i < frames; ++i)
    {
        const auto t = static_cast<double> (i) / rate;
        const auto v = static_cast<float> (0.3 * std::sin (juce::MathConstants<double>::twoPi * 330.0 * t)
                                           + 0.1 * std::sin (juce::MathConstants<double>::twoPi * 0.5 * t));
        audio.setSample (0, i, v);
        audio.setSample (1, i, -v);
    }
    juce::WavAudioFormat wav;
    std::unique_ptr<juce::OutputStream> stream (file.createOutputStream().release());
    auto writer = stream ? wav.createWriterFor (stream, juce::AudioFormatWriterOptions().withSampleRate (rate)
                                                            .withNumChannels (2).withBitsPerSample (24))
                         : nullptr;
    return writer != nullptr && writer->writeFromAudioSampleBuffer (audio, 0, frames);
}

// Plays [from, from + length) of the host timeline through `p` in blocks of `block`
// samples with silent input, writing each output sample at its timeline index in `out`.
void playRange (ReImagineProcessor& p, SamplePlayHead& head, int64_t from, int64_t length, int block,
                std::vector<float>& left, std::vector<float>& right, int64_t origin)
{
    juce::AudioBuffer<float> buffer (2, block);
    juce::MidiBuffer midi;
    head.playing = true;
    for (int64_t done = 0; done < length; done += block)
    {
        const auto n = static_cast<int> (std::min<int64_t> (block, length - done));
        buffer.setSize (2, n, false, false, true);
        buffer.clear();
        head.samples = from + done;
        p.processBlock (buffer, midi);
        for (int i = 0; i < n; ++i)
        {
            const auto index = static_cast<size_t> (from + done + i - origin);
            left[index] = buffer.getSample (0, i);
            right[index] = buffer.getSample (1, i);
        }
    }
}

float processPeak (ReImagineProcessor& p, int blockSamples = 512)
{
    juce::AudioBuffer<float> buffer (2, blockSamples);
    buffer.clear();
    juce::MidiBuffer midi;
    p.processBlock (buffer, midi);
    return buffer.getMagnitude (0, blockSamples);
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

    std::cout << "conform and free audition (no helper, no model)\n";
    {
        const auto clickWav = home.getChildFile ("click-121bpm.wav");
        check (writeClickWav (clickWav, 121.0, 8.0), "121 BPM click fixture written");
        const auto clickHash = sha256 (clickWav);

        // Imported with no host timing: the tempo map is assumed, so conform refuses.
        auto assumed = importedProcessor (clickWav);
        check (assumed->conformSelected().contains ("assumed"), "conform refuses an assumed tempo map: " + assumed->statusText());

        // Imported while the host reports 120 BPM: the region carries host tempo.
        auto c = std::make_unique<ReImagineProcessor>();
        FakePlayHead head;
        c->setPlayHead (&head);
        c->prepareToPlay (48000.0, 512);
        processPeak (*c);                                   // the plug-in learns the host position
        c->importTakeFromFile (clickWav, 1.0);
        waitFor ([&] { return takeCount (*c) == 1 && c->statusText().contains ("loaded"); }, 10.0);
        check (c->selectedContext().bpm.has_value() && c->selectedContext().bpmFrom == Provenance::host,
               "import under host timing has a host BPM");
        const auto originalId = c->stateSnapshot().regions.front().selectedTakeId;
        const auto originalHash = c->stateSnapshot().regions.front().takes.front().assetHash;

        check (c->conformSelected().isEmpty(), "conform is queued: " + c->statusText());
        waitFor ([&] { return ! c->conformActive() && takeCount (*c) == 2; }, 60.0);
        auto cs = c->stateSnapshot();
        check (cs.regions.front().takes.size() == 2, "conform created a new version: " + c->statusText());
        if (cs.regions.front().takes.size() == 2)
        {
            const auto& conformed = cs.regions.front().takes[1];
            const auto lineage = lineageOf (conformed);
            check (lineage.role == "conform" && lineage.parentTakeId == originalId && lineage.conformedFrom == originalId,
                   "conform lineage links to the original version");
            check (lineage.stretchRatio.has_value() && std::abs (*lineage.stretchRatio - 121.0 / 120.0) < 0.002,
                   "stretch ratio is measured/session: " + juce::String (lineage.stretchRatio.value_or (0.0), 5));
            check (conformed.manifest["m1"]["tempoConformance"]["verdict"].toString() == "conforms",
                   "conformed version now conforms: " + conformed.manifest["m1"]["tempoConformance"]["summary"].toString());
            check (cs.regions.front().selectedTakeId == conformed.id, "the conformed version is selected");
            {
                // Same length as the parent, so "Replace" never lets the dry source through
                // at the end of the region; the trim (121 -> 120 BPM lengthens) is recorded.
                juce::AudioFormatManager formats;
                formats.registerBasicFormats();
                const auto lengthOf = [&] (const juce::String& hash)
                {
                    std::unique_ptr<juce::AudioFormatReader> r (formats.createReaderFor (
                        home.getChildFile ("Library/Mosh/ReImagine/assets/renders/" + hash + ".wav")));
                    return r ? r->lengthInSamples : juce::int64 { -1 };
                };
                const auto parentLength = lengthOf (originalHash);
                check (parentLength > 0 && lengthOf (conformed.assetHash) == parentLength,
                       "conformed version keeps the parent's exact length");
                check (static_cast<int> (conformed.manifest["m1"]["conform"]["trimmedFrames"]) > 0
                           && static_cast<int> (conformed.manifest["m1"]["conform"]["paddedFrames"]) == 0,
                       "the trim to the parent's length is recorded");
                check (conformed.manifest["m1"]["checks"]["usable"] == juce::var (true),
                       "technical checks describe the conformed audio");
                check (! takeLabel (cs.regions.front(), 1).contains ("import") && takeLabel (cs.regions.front(), 1).contains ("conform of v1"),
                       "a conform of an import is labelled as a conform: " + takeLabel (cs.regions.front(), 1));
            }
            check (cs.regions.front().takes.front().assetHash == originalHash
                       && home.getChildFile ("Library/Mosh/ReImagine/assets/renders/" + originalHash + ".wav").existsAsFile(),
                   "the original version is not overwritten");
            check (c->selectedReport().contains ("timing only"), "report says conform is timing only");
        }
        // Conforming the conformed version is refused after measuring (already conforms).
        waitFor ([&] { return c->statusText().contains ("loaded"); }, 10.0);
        c->conformSelected();
        waitFor ([&] { return ! c->conformActive() && c->statusText().contains ("refused"); }, 60.0);
        check (c->statusText().contains ("already conforms") && takeCount (*c) == 2,
               "a conforming version is not stretched again: " + c->statusText());

        // Free audition with no host timing: plays the selection, free-running.
        c->setPlayHead (nullptr);
        check (c->startFreeAudition().isEmpty(), "free audition starts without host timing");
        waitFor ([&] { return c->freeAuditionPlaying(); }, 10.0);
        check (c->freeAuditionPlaying() && c->selectedReport().contains ("FREE-RUNNING"), "report says the preview is free-running");
        float previewPeak = 0.0f;
        for (int block = 0; block < 40; ++block)
            previewPeak = std::max (previewPeak, processPeak (*c));
        check (previewPeak > 0.1f, "the preview is audible: peak " + juce::String (previewPeak, 3));
        // The host starts playing over the region: the preview stops, the synced route plays once.
        head.playing = true;
        head.ppq = 0.0;
        c->setPlayHead (&head);
        float syncedPeak = 0.0f;
        for (int block = 0; block < 40; ++block)
        {
            syncedPeak = std::max (syncedPeak, processPeak (*c));
            head.ppq += 512.0 / 48000.0 * 2.0;
        }
        check (! c->freeAuditionPlaying(), "host playback stops the free preview");
        // The status line follows the stop the audio thread made (it used to keep saying
        // "Free audition playing" after the host took over).
        waitFor ([&] { return c->statusText().contains ("took over"); }, 5.0);
        check (c->statusText().contains ("Free audition stopped") && c->statusText().contains ("took over")
                   && ! c->statusText().contains ("playing - local preview"),
               "status reports the host took over the preview: " + c->statusText());
        check (syncedPeak > 0.1f && syncedPeak < 0.85f, "host-synced playback alone, no second copy: peak " + juce::String (syncedPeak, 3));
        check (c->startFreeAudition().contains ("host is playing"), "free audition is refused while the host plays");
        head.playing = false;
        processPeak (*c);

        // A host tempo change makes the region stale: playback passes the dry input, and the
        // report must say so instead of naming the selected version as audible.
        head.bpm = 100.0;
        head.ppq = 0.0;
        head.playing = true;
        for (int block = 0; block < 4; ++block)
        {
            processPeak (*c);
            head.ppq += 512.0 / 48000.0 * (100.0 / 60.0);
        }
        head.playing = false;
        processPeak (*c);
        waitFor ([&] { return c->statusText().contains ("stale"); }, 5.0);
        check (c->selectedReport().contains ("Audible: dry"), "a stale region's report says playback is dry: "
                   + c->statusText() + " / "
                   + c->selectedReport().fromFirstOccurrenceOf ("Audible:", true, false).upToFirstOccurrenceOf ("\n", false, false));
        head.bpm = 120.0;

        check (c->undoLastConform(), "the conform can be undone");
        cs = c->stateSnapshot();
        check (cs.regions.front().takes.size() == 1 && cs.regions.front().selectedTakeId == originalId,
               "undo removes the conformed version and reselects the original");
        check (! c->undoLastConform(), "undo refuses a version that is not a conform");
        check (sha256 (clickWav) == clickHash, "the click source file is byte-identical");

        const auto log = home.getChildFile ("Library/Mosh/ReImagine/experience.jsonl").loadFileAsString();
        check (log.contains ("\"version.conformed\", \"signal\": \"explicit\""), "experience log: conform is an explicit signal");
        for (const auto* needle : { "\"conform.requested\"", "\"conform.refused\"", "\"version.conform-undone\"", "free-running",
                                    "\"version.audition-stopped\"" })
            check (log.contains (needle), juce::String ("experience log has ") + needle);

        c->setPlayHead (nullptr);
    }

    std::cout << "transfer survives a host re-prepare (R1 P2)\n";
    for (int round = 0; round < 5; ++round)
    {
        auto t = std::make_unique<ReImagineProcessor>();
        SamplePlayHead head (48000.0);
        t->setPlayHead (&head);
        t->prepareToPlay (48000.0, 512);
        processPeak (*t);
        t->toggleTransfer();
        processPeak (*t);                                   // armed while stopped
        head.playing = true;
        head.samples = static_cast<int64_t> (8 + round) * 24000;
        const int blocks = 200;                             // ~2.1 s
        juce::AudioBuffer<float> block (2, 512);
        juce::MidiBuffer midi;
        for (int b = 0; b < blocks; ++b)
        {
            for (int i = 0; i < 512; ++i)
            {
                const auto v = 0.25f * std::sin (juce::MathConstants<float>::twoPi * 220.0f
                                                 * static_cast<float> (b * 512 + i) / 48000.0f);
                block.setSample (0, i, v);
                block.setSample (1, i, v);
            }
            t->processBlock (block, midi);
            head.samples += 512;
        }
        head.playing = false;
        processPeak (*t);                                   // the stop requests the WAV write
        t->prepareToPlay (44100.0, 256);                    // the host re-prepares at once
        waitFor ([&] { return ! t->stateSnapshot().regions.empty(); }, 10.0);
        const auto state = t->stateSnapshot();
        bool intact = false;
        juce::String detail = t->statusText();
        if (! state.regions.empty())
        {
            juce::AudioFormatManager formats;
            formats.registerBasicFormats();
            std::unique_ptr<juce::AudioFormatReader> r (formats.createReaderFor (
                home.getChildFile ("Library/Mosh/ReImagine/assets/sources/" + state.regions.front().sourceHash + ".wav")));
            intact = r != nullptr && r->sampleRate == 48000.0 && r->lengthInSamples == static_cast<juce::int64> (blocks) * 512;
            detail = r ? juce::String (r->sampleRate) + " Hz, " + juce::String (r->lengthInSamples) + " frames" : "unreadable";
        }
        check (intact, "round " + juce::String (round + 1) + ": the Transfer is saved whole at the rate it was captured: " + detail);
        t->setPlayHead (nullptr);
    }

    std::cout << "host-synced playback: sample rates, block sizes, seeks, loop wrap\n";
    for (const double rate : { 44100.0, 48000.0, 96000.0 })
    {
        const auto tone = home.getChildFile ("tone-" + juce::String (static_cast<int> (rate)) + ".wav");
        writeToneWav (tone, rate, 4.0);                     // 8 beats at 120 BPM
        auto pb = std::make_unique<ReImagineProcessor>();
        SamplePlayHead head (rate);
        pb->setPlayHead (&head);
        pb->prepareToPlay (rate, 512);
        processPeak (*pb);                                  // learns the (stopped) host position
        pb->importTakeFromFile (tone, 2.0);                 // region: ppq 4..12
        const auto label = juce::String (rate / 1000.0, 1) + " kHz";
        check (waitFor ([&] { return takeCount (*pb) == 1 && pb->statusText().contains ("loaded"); }, 10.0),
               label + ": import loads under host timing: " + pb->statusText());
        // Timeline from ppq 2 to ppq 14: two beats of silence either side of the region.
        const auto origin = static_cast<int64_t> (rate);           // ppq 2
        const auto total = static_cast<int64_t> (6.0 * rate);      // 12 beats
        const auto regionStart = static_cast<int64_t> (2.0 * rate), regionEnd = static_cast<int64_t> (6.0 * rate);
        std::vector<float> refL (static_cast<size_t> (total)), refR (static_cast<size_t> (total));
        playRange (*pb, head, origin, total, 2048, refL, refR, origin);

        double outside = 0.0, inside = 0.0;
        for (int64_t i = 0; i < total; ++i)
        {
            const auto timeline = origin + i;
            const auto v = std::abs (refL[static_cast<size_t> (i)]);
            if (timeline < regionStart || timeline >= regionEnd)
                outside = std::max (outside, static_cast<double> (v));
            else
                inside = std::max (inside, static_cast<double> (v));
        }
        check (outside == 0.0 && inside > 0.2, label + ": the version plays inside its region only (peak inside "
               + juce::String (inside, 3) + ", outside " + juce::String (outside, 6) + ")");
        {
            // Sample-accurate alignment against the tone itself, away from the 10 ms edge
            // fades: a one-sample offset at 330 Hz is an error of ~0.01, far above 24-bit noise.
            double worst = 0.0;
            for (auto t = regionStart + static_cast<int64_t> (0.1 * rate); t < regionEnd - static_cast<int64_t> (0.1 * rate); t += 997)
            {
                const auto k = static_cast<double> (t - regionStart) / rate;
                const auto expected = 0.3 * std::sin (juce::MathConstants<double>::twoPi * 330.0 * k)
                                    + 0.1 * std::sin (juce::MathConstants<double>::twoPi * 0.5 * k);
                worst = std::max (worst, std::abs (refL[static_cast<size_t> (t - origin)] - expected));
                worst = std::max (worst, std::abs (refR[static_cast<size_t> (t - origin)] + expected));
            }
            check (worst < 2.0e-5, label + ": region audio is sample-aligned with the version (max error "
                   + juce::String (worst, 7) + ")");
        }

        const auto compare = [&] (const std::vector<float>& l, const std::vector<float>& r, int64_t from, int64_t length)
        {
            double worst = 0.0;
            for (int64_t i = from - origin; i < from - origin + length; ++i)
            {
                worst = std::max (worst, static_cast<double> (std::abs (l[static_cast<size_t> (i)] - refL[static_cast<size_t> (i)])));
                worst = std::max (worst, static_cast<double> (std::abs (r[static_cast<size_t> (i)] - refR[static_cast<size_t> (i)])));
            }
            return worst;
        };
        for (const int block : { 32, 128, 441, 512, 4096 })
        {
            std::vector<float> l (refL.size()), r (refR.size());
            playRange (*pb, head, origin, total, block, l, r, origin);
            check (compare (l, r, origin, total) < 1.0e-6, label + ", block " + juce::String (block)
                   + ": output matches the reference sample for sample");
        }
        {
            // Seeks: start mid-region at unaligned positions, and across each region edge.
            std::vector<float> l (refL.size()), r (refR.size());
            double worst = 0.0;
            for (const double seconds : { 2.3719, 3.0, 4.99991, 1.95, 5.97 })
            {
                const auto at = static_cast<int64_t> (seconds * rate);
                playRange (*pb, head, at, 3000, 256, l, r, origin);
                worst = std::max (worst, compare (l, r, at, 3000));
            }
            check (worst < 1.0e-6, label + ": seeks land on the same samples as continuous play");
        }
        {
            // Loop wrap: play a 1-beat loop inside the region three times; each pass repeats
            // the reference exactly (no stale position, no click from the wrap itself).
            std::vector<float> l (refL.size()), r (refR.size());
            const auto loopStart = static_cast<int64_t> (3.25 * rate), loopLength = static_cast<int64_t> (0.5 * rate);
            head.looping = true;
            double worst = 0.0;
            for (int pass = 0; pass < 3; ++pass)
            {
                playRange (*pb, head, loopStart, loopLength, 300, l, r, origin);
                worst = std::max (worst, compare (l, r, loopStart, loopLength));
            }
            head.looping = false;
            check (worst < 1.0e-6, label + ": loop wraps repeat the region exactly");
        }
        head.playing = false;
        processPeak (*pb);
        pb->setPlayHead (nullptr);
    }

    // Cloud planner: off until the opt-in file exists; its "python" is a stand-in script
    // that records what it was sent and answers with a canned plan (no network, no key).
    const auto plannerEnv = home.getChildFile ("planner/reimagine-planner.env");
    const auto plannerInput = home.getChildFile ("planner/received.json");
    const auto plannerStandIn = home.getChildFile ("planner/fake-python");
    plannerEnv.getParentDirectory().createDirectory();
    plannerStandIn.replaceWithText ("#!/bin/sh\ncat > '" + plannerInput.getFullPathName() + "'\n"
        "printf '%s' '{\"plan\": {\"prompt\": \"hazy sampled keyboard loop, worn tape, sparse voicings\", "
        "\"strength\": 0.3, \"candidate_count\": 1, \"interpretation\": \"A sparser tape-worn keys loop.\", "
        "\"unsupported\": [\"follow the chord changes exactly\"]}, \"usage\": {\"input_tokens\": 900, "
        "\"output_tokens\": 300}, \"model\": \"claude-opus-5-5\", \"request_id\": \"req_e2e\", "
        "\"stop_reason\": \"end_turn\"}'\n", false, false, "\n");   // LF: a CRLF shebang does not run
    plannerStandIn.setExecutePermission (true);
    setEnv ("MOSH_REIMAGINE_PLANNER_ENV", plannerEnv.getFullPathName());
    setEnv ("MOSH_REIMAGINE_PLANNER_PYTHON", plannerStandIn.getFullPathName());

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

    std::cout << "cloud planner (stand-in subprocess, no network)\n";
    {
        auto q = importedProcessor (source);
        q->setSelectedContext ("F minor", "1:Fm7 2:Db", "Verse", "chord-change timing");
        auto planned = request (2, 300);
        planned.useCloudPlanner = true;
        runGeneration (*q, [&] { return q->generateCandidates (planned); }, 3);
        auto qs = q->stateSnapshot();
        check (takeCount (*q) == 3, "planner off: the template still renders both candidates: " + q->statusText());
        if (takeCount (*q) == 3)
        {
            const auto req = qs.regions.front().takes[1].manifest["m1"]["request"];
            check (req["controller"].toString().startsWith ("template") && req["controllerRecord"]["reason"].toString() == "disabled",
                   "planner off: the template is used and the reason is recorded");
            check (q->selectedReport().contains ("cloud planner not used: disabled"), "report says why the planner was not used");
        }
        check (! plannerInput.existsAsFile(), "planner off: nothing is sent");

        plannerEnv.replaceWithText ("MOSH_REIMAGINE_PLANNER=anthropic\nANTHROPIC_API_KEY=sk-e2e-not-real\n");
        runGeneration (*q, [&] { return q->generateCandidates (planned); }, 4);
        qs = q->stateSnapshot();
        check (takeCount (*q) == 4, "planner on: its plan (1 candidate) is rendered: " + q->statusText());
        if (takeCount (*q) == 4)
        {
            const auto req = qs.regions.front().takes[3].manifest["m1"]["request"];
            check (req["controller"].toString() == "cloud-planner" && req["prompt"].toString().contains ("worn tape")
                       && std::abs (static_cast<double> (req["strength"]) - 0.3) < 1.0e-6 && req["seeds"].size() == 1,
                   "the planner's prompt, strength and count reach the render request");
            check (req["controllerRecord"]["model"].toString() == "claude-opus-5-5"
                       && static_cast<double> (req["controllerRecord"]["costUsd"]) > 0.0,
                   "controller provenance and cost are stored with the version");
            check (q->selectedReport().contains ("Prompt by: claude-opus-5-5") && q->selectedReport().contains ("never heard"),
                   "report names the planner and says it never heard the audio");
        }
        const auto sent = plannerInput.loadFileAsString();
        check (sent.contains ("hazy sampled-keyboard loop") && sent.contains ("Fm7") && sent.contains ("F minor"),
               "the planner receives the request and the text context");
        check (! sent.contains (home.getFullPathName()) && ! sent.contains (".wav") && ! sent.contains (sha256 (source)),
               "the planner never receives paths, file names or hashes");
        check (home.getChildFile ("Library/Mosh/ReImagine/planner-ledger.jsonl").loadFileAsString().contains ("req_e2e"),
               "the call is priced into the local ledger");
        const auto qlog = home.getChildFile ("Library/Mosh/ReImagine/experience.jsonl").loadFileAsString();
        check (qlog.contains ("\"controller.plan-unavailable\"") && qlog.contains ("\"controller.planned\""),
               "experience log records planner use and non-use");
        check (qlog.contains ("\"controlsTouched\"") && qlog.contains ("\"firstCandidateSeconds\""),
               "experience log records controls touched and time to first candidate");
        plannerEnv.deleteFile();
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
