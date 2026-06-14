#pragma once

#include <juce_core/juce_core.h>

namespace mosh
{
class TrainerRegistry
{
public:
    explicit TrainerRegistry (juce::File sessionDir);

    juce::File rootDir() const { return root; }
    juce::File registryFile() const { return root.getChildFile ("rights_registry.json"); }
    juce::File stateFile() const { return root.getChildFile ("training_state.json"); }
    juce::File corporaDir() const { return root.getChildFile ("corpora"); }
    juce::File adaptersDir() const { return root.getChildFile ("adapters"); }

    juce::var snapshot();
    juce::var listSources();
    juce::var importSource (const juce::var& args, juce::String& error);
    juce::var approveSource (const juce::String& sourceId, bool approved, juce::String& error);
    juce::var buildCorpus (const juce::var& args, juce::String& error);
    juce::var listAdapters();
    juce::var importAdapter (const juce::String& artifactPath,
                             const juce::String& manifestPath,
                             const juce::String& adapterId,
                             juce::String& error);
    juce::var activateAdapter (const juce::String& adapterId,
                               const juce::String& adapterPath,
                               const juce::String& corpusHash,
                               juce::String& error);
    juce::var listJobs();
    void updateJob (const juce::var& job);

    juce::String activeAdapterId() const;
    juce::String activeAdapterPath() const;
    juce::String activeCorpusHash() const;

private:
    juce::var loadJson (const juce::File& file) const;
    void      saveJson (const juce::File& file, const juce::var& data) const;
    juce::var  state() const;
    void       saveState (const juce::var& state) const;
    juce::var  registry() const;
    void       saveRegistry (const juce::var& reg) const;
    juce::String nextSourceId (const juce::Array<juce::var>& sources) const;
    juce::String sanitize (const juce::String& s) const;
    juce::String sha256File (const juce::File& file) const;
    juce::var    sourceSummary (const juce::var& src, int index, bool includeEligibility) const;
    bool         sourceEligible (const juce::var& src, juce::String& reason) const;

    juce::File root;
};

} // namespace mosh
