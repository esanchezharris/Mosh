#include "TrainerRegistry.h"

#include <algorithm>
#include <juce_cryptography/juce_cryptography.h>

namespace mosh
{
using namespace juce;

namespace
{
    String utcNow()
    {
        return Time::getCurrentTime().toISO8601 (true);
    }

    String claimedLicense (const var& src)
    {
        const auto canonical = src.getProperty ("user_claimed_license", var()).toString();
        if (canonical.isNotEmpty())
            return canonical;
        return src.getProperty ("license_name", var()).toString();
    }

    Array<var> toArray (const var& value)
    {
        Array<var> out;
        if (auto* arr = value.getArray())
            for (auto& v : *arr) out.add (v);
        return out;
    }

}

TrainerRegistry::TrainerRegistry (File sessionDir)
    : root (sessionDir.getChildFile ("training"))
{
    root.createDirectory();
    corporaDir().createDirectory();
    adaptersDir().createDirectory();
    if (! registryFile().existsAsFile())
        saveRegistry (var (new DynamicObject()));
    if (! stateFile().existsAsFile())
        saveState (var (new DynamicObject()));
}

var TrainerRegistry::loadJson (const File& file) const
{
    if (! file.existsAsFile())
        return var (new DynamicObject());
    auto parsed = JSON::parse (file.loadFileAsString());
    return parsed.isVoid() ? var (new DynamicObject()) : parsed;
}

void TrainerRegistry::saveJson (const File& file, const var& data) const
{
    file.getParentDirectory().createDirectory();
    file.replaceWithText (JSON::toString (data, true));
}

var TrainerRegistry::state() const
{
    auto v = loadJson (stateFile());
    if (! v.isObject())
        v = var (new DynamicObject());
    auto* o = v.getDynamicObject();
    o->setProperty ("activeAdapterId", o->getProperty ("activeAdapterId"));
    o->setProperty ("activeAdapterPath", o->getProperty ("activeAdapterPath"));
    o->setProperty ("activeCorpusHash", o->getProperty ("activeCorpusHash"));
    if (! o->hasProperty ("jobs"))    o->setProperty ("jobs", Array<var>());
    if (! o->hasProperty ("adapters")) o->setProperty ("adapters", Array<var>());
    if (! o->hasProperty ("lastCorpus")) o->setProperty ("lastCorpus", var());
    return v;
}

void TrainerRegistry::saveState (const var& s) const
{
    auto stateVar = s;
    if (! stateVar.isObject())
        stateVar = var (new DynamicObject());
    saveJson (stateFile(), stateVar);
}

var TrainerRegistry::registry() const
{
    auto v = loadJson (registryFile());
    if (! v.isObject())
        v = var (new DynamicObject());
    auto* o = v.getDynamicObject();
    if (! o->hasProperty ("version")) o->setProperty ("version", 1);
    if (! o->hasProperty ("sources")) o->setProperty ("sources", Array<var>());
    return v;
}

void TrainerRegistry::saveRegistry (const var& reg) const
{
    auto regVar = reg;
    if (! regVar.isObject())
        regVar = var (new DynamicObject());
    auto* o = regVar.getDynamicObject();
    o->setProperty ("version", 1);
    if (! o->hasProperty ("sources")) o->setProperty ("sources", Array<var>());
    o->setProperty ("updated_at", utcNow());
    saveJson (registryFile(), regVar);
}

String TrainerRegistry::nextSourceId (const Array<var>& sources) const
{
    int maxN = 0;
    for (auto& src : sources)
    {
        const auto sid = src.getProperty ("source_id", var()).toString();
        if (sid.startsWith ("beat-"))
        {
            const auto tail = sid.fromLastOccurrenceOf ("-", false, false);
            if (tail.containsOnly ("0123456789"))
                maxN = std::max (maxN, tail.getIntValue());
        }
    }
    return "beat-" + String (maxN + 1).paddedLeft ('0', 3);
}

String TrainerRegistry::sanitize (const String& s) const
{
    auto out = s;
    // replaceCharacters requires matching lengths: 6 path-hostile chars -> 6 dashes.
    out = out.replaceCharacters ("\\/:\r\n\t", "------");
    out = out.retainCharacters ("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-");
    return out.isNotEmpty() ? out : "item";
}

String TrainerRegistry::sha256File (const File& file) const
{
    // AL-016 — stream the file in fixed-size chunks via JUCE's File-constructor
    // overload (SHA256Processor::processStream reads 64 bytes at a time through a
    // FileInputStream) instead of loading the whole file into one MemoryBlock; a
    // multi-GB corpus source no longer has to fit in memory just to be hashed.
    // Produces a byte-identical digest to the old full-read approach (see the
    // equivalence test in tests/test_training.cpp) -- preserve the old
    // missing-file contract (empty string, not the zeroed-hash JUCE would
    // otherwise report) with an explicit existence check.
    if (! file.existsAsFile())
        return {};
    return SHA256 (file).toHexString();
}

bool TrainerRegistry::sourceEligible (const var& src, String& reason) const
{
    reason.clear();
    auto sid = src.getProperty ("source_id", var()).toString();
    if (sid.isEmpty()) reason = "missing source_id";
    if (reason.isNotEmpty()) return false;
    if (src.getProperty ("title", var()).toString().isEmpty()) reason = "missing title";
    else if (src.getProperty ("creator", var()).toString().isEmpty()) reason = "missing creator";
    else if (claimedLicense (src).isEmpty()) reason = "missing user_claimed_license";
    else if (src.getProperty ("proof_of_rights", var()).toString().isEmpty()) reason = "missing proof_of_rights";
    else if (! src.hasProperty ("source_url") && ! src.hasProperty ("local_path")) reason = "missing source_url or local_path";
    else if (! (bool) src.getProperty ("approved_for_training", false)) reason = "not approved_for_training";
    else
    {
        auto path = src.getProperty ("local_path", var()).toString();
        if (path.isEmpty()) reason = "missing local_path";
        else if (! File (path).existsAsFile()) reason = "missing local file: " + path;
    }
    return reason.isEmpty();
}

var TrainerRegistry::sourceSummary (const var& src, int index, bool includeEligibility) const
{
    auto* o = new DynamicObject();
    o->setProperty ("index", index);
    o->setProperty ("source_id", src.getProperty ("source_id", var()));
    o->setProperty ("title", src.getProperty ("title", var()));
    o->setProperty ("creator", src.getProperty ("creator", var()));
    o->setProperty ("source_url", src.getProperty ("source_url", var()));
    o->setProperty ("local_path", src.getProperty ("local_path", var()));
    o->setProperty ("user_claimed_license", claimedLicense (src));
    o->setProperty ("proof_of_rights", src.getProperty ("proof_of_rights", var()));
    o->setProperty ("approved_for_training", src.getProperty ("approved_for_training", false));
    o->setProperty ("expiration", src.getProperty ("expiration", var()));
    o->setProperty ("notes", src.getProperty ("notes", var()));
    o->setProperty ("license_name", src.getProperty ("license_name", claimedLicense (src)));
    if (includeEligibility)
    {
        String reason;
        const bool ok = sourceEligible (src, reason);
        o->setProperty ("eligible", ok);
        o->setProperty ("blocked_reason", reason);
    }
    return var (o);
}

var TrainerRegistry::snapshot()
{
    auto* rootObj = new DynamicObject();
    rootObj->setProperty ("registryPath", registryFile().getFullPathName());
    rootObj->setProperty ("statePath", stateFile().getFullPathName());
    rootObj->setProperty ("activeAdapterId", activeAdapterId());
    rootObj->setProperty ("activeAdapterPath", activeAdapterPath());
    rootObj->setProperty ("activeCorpusHash", activeCorpusHash());
    rootObj->setProperty ("sources", listSources().getProperty ("sources", Array<var>()));
    rootObj->setProperty ("adapters", listAdapters().getProperty ("adapters", Array<var>()));
    rootObj->setProperty ("jobs", listJobs().getProperty ("jobs", Array<var>()));
    return var (rootObj);
}

var TrainerRegistry::listSources()
{
    auto reg = registry();
    Array<var> sources = toArray (reg.getProperty ("sources", Array<var>()));
    Array<var> items;
    for (int i = 0; i < sources.size(); ++i)
        items.add (sourceSummary (sources.getReference (i), i, true));
    auto* out = new DynamicObject();
    out->setProperty ("registryPath", registryFile().getFullPathName());
    out->setProperty ("sources", items);
    out->setProperty ("sourceCount", items.size());
    return var (out);
}

var TrainerRegistry::importSource (const var& args, String& error)
{
    error.clear();
    auto reg = registry();
    auto sources = toArray (reg.getProperty ("sources", Array<var>()));
    const auto requestedId = args.getProperty ("sourceId", var()).toString();
    const auto sid = requestedId.isNotEmpty() ? requestedId : nextSourceId (sources);
    const auto sourceUrl = args.getProperty ("sourceUrl", var()).toString();
    const auto localPath = args.getProperty ("localPath", var()).toString();
    if (sourceUrl.isEmpty() && localPath.isEmpty())
    {
        error = "missing sourceUrl or localPath";
        return {};
    }
    // Allocate only after validation passes: on the early-return path above the
    // raw DynamicObject would never be adopted into a var and would leak.
    auto* o = new DynamicObject();
    o->setProperty ("source_id", sid);
    o->setProperty ("title", args.getProperty ("title", "Untitled Type Beat"));
    o->setProperty ("creator", args.getProperty ("creator", "Unknown"));
    o->setProperty ("source_url", sourceUrl);
    o->setProperty ("local_path", localPath);
    const auto license = args.getProperty ("userClaimedLicense",
                                           args.getProperty ("licenseName",
                                                             args.getProperty ("license_name", "")));
    o->setProperty ("user_claimed_license", license);
    o->setProperty ("proof_of_rights", args.getProperty ("proofOfRights", args.getProperty ("proof_of_rights", "")));
    o->setProperty ("approved_for_training", args.getProperty ("approvedForTraining", false));
    o->setProperty ("expiration", args.getProperty ("expiration", var()));
    o->setProperty ("notes", args.getProperty ("notes", ""));
    o->setProperty ("created_at", utcNow());
    o->setProperty ("updated_at", utcNow());

    bool replaced = false;
    int landedIndex = -1;
    for (int i = 0; i < sources.size(); ++i)
    {
        if (sources.getReference (i).getProperty ("source_id", var()).toString() == sid)
        {
            sources.set (i, var (o));
            replaced = true;
            landedIndex = i;
            break;
        }
    }
    if (! replaced)
    {
        sources.add (var (o));
        landedIndex = sources.size() - 1;
    }
    reg.getDynamicObject()->setProperty ("sources", sources);
    saveRegistry (reg);
    // AL-013 — landedIndex is the slot the record actually occupies: for a fresh
    // import that's the newly-appended last slot, but for a replacement it is the
    // EXISTING slot found above, which is not necessarily sources.size()-1.
    return sourceSummary (var (o), landedIndex, true);
}

var TrainerRegistry::approveSource (const String& sourceId, bool approved, String& error)
{
    error.clear();
    auto reg = registry();
    auto sources = toArray (reg.getProperty ("sources", Array<var>()));
    for (int i = 0; i < sources.size(); ++i)
    {
        auto src = sources.getReference (i);
        if (src.getProperty ("source_id", var()).toString() == sourceId)
        {
            auto* o = src.getDynamicObject();
            if (o == nullptr)
            {
                error = "source record not editable";
                return {};
            }
            o->setProperty ("approved_for_training", approved);
            o->setProperty ("updated_at", utcNow());
            sources.set (i, src);
            reg.getDynamicObject()->setProperty ("sources", sources);
            saveRegistry (reg);
            return sourceSummary (src, i, true);
        }
    }
    error = "source not found: " + sourceId;
    return {};
}

var TrainerRegistry::buildCorpus (const var& args, String& error)
{
    error.clear();
    auto reg = registry();
    auto sources = toArray (reg.getProperty ("sources", Array<var>()));
    Array<var> eligible;
    Array<var> skipped;
    for (int i = 0; i < sources.size(); ++i)
    {
        auto src = sources.getReference (i);
        String reason;
        if (sourceEligible (src, reason))
            eligible.add (src);
        else
        {
            auto* s = new DynamicObject();
            s->setProperty ("source_id", src.getProperty ("source_id", var()));
            s->setProperty ("reason", reason);
            skipped.add (var (s));
        }
    }
    if (eligible.isEmpty())
    {
        error = "no approved local sources available for training";
        return {};
    }

    StringArray eligibleIds;
    for (auto& s : eligible)
        eligibleIds.add (s.getProperty ("source_id", var()).toString());
    eligibleIds.sort (true);

    String bundleName = sanitize (args.getProperty ("bundleName", String()));
    if (bundleName.isEmpty())
    {
        const auto ids = eligibleIds.joinIntoString ("|");
        bundleName = "corpus-" + juce::SHA256 (ids.toUTF8()).toHexString().substring (0, 12);
    }
    auto bundleDir = corporaDir().getChildFile (bundleName);
    if (bundleDir.exists())
        bundleDir.deleteRecursively();
    bundleDir.createDirectory();
    auto sourcesDir = bundleDir.getChildFile ("sources");
    sourcesDir.createDirectory();

    Array<var> manifestSources;
    String bundleSeed = bundleName + "|" + reg.getProperty ("version", 1).toString();
    for (int i = 0; i < eligibleIds.size(); ++i)
    {
        auto sourceId = eligibleIds[i];
        auto src = eligible[0];
        for (auto& candidate : eligible)
            if (candidate.getProperty ("source_id", var()).toString() == sourceId) { src = candidate; break; }
        const auto localPath = File (src.getProperty ("local_path", var()).toString());
        if (! localPath.existsAsFile())
            continue;
        const auto copiedName = String (i).paddedLeft ('0', 3) + "-" + sourceId + "-" + localPath.getFileName();
        auto copied = sourcesDir.getChildFile (sanitize (copiedName));
        if (! localPath.copyFileTo (copied))
        {
            error = "could not copy source file: " + localPath.getFullPathName();
            return {};
        }
        auto* s = new DynamicObject();
        s->setProperty ("index", i);
        s->setProperty ("source_id", src.getProperty ("source_id", var()));
        s->setProperty ("title", src.getProperty ("title", var()));
        s->setProperty ("creator", src.getProperty ("creator", var()));
        s->setProperty ("source_url", src.getProperty ("source_url", var()));
        s->setProperty ("local_path", localPath.getFullPathName());
        s->setProperty ("copied_path", copied.getFullPathName());
        s->setProperty ("user_claimed_license", claimedLicense (src));
        s->setProperty ("license_name", claimedLicense (src));
        s->setProperty ("proof_of_rights", src.getProperty ("proof_of_rights", var()));
        s->setProperty ("approved_for_training", true);
        s->setProperty ("expiration", src.getProperty ("expiration", var()));
        s->setProperty ("notes", src.getProperty ("notes", var()));
        s->setProperty ("sha256", sha256File (copied));
        s->setProperty ("bytes", (int64) copied.getSize());
        manifestSources.add (var (s));
        bundleSeed << "|" << JSON::toString (var (s), true);
    }

    const auto bundleHash = juce::SHA256 (bundleSeed.toUTF8()).toHexString();
    auto manifest = var (new DynamicObject());
    manifest.getDynamicObject()->setProperty ("schema_version", 1);
    manifest.getDynamicObject()->setProperty ("bundle_id", bundleName);
    manifest.getDynamicObject()->setProperty ("bundle_hash", bundleHash);
    manifest.getDynamicObject()->setProperty ("created_at", utcNow());
    manifest.getDynamicObject()->setProperty ("registry_path", registryFile().getFullPathName());
    manifest.getDynamicObject()->setProperty ("source_count", manifestSources.size());
    manifest.getDynamicObject()->setProperty ("skipped_sources", skipped);
    manifest.getDynamicObject()->setProperty ("sources", manifestSources);

    auto manifestFile = bundleDir.getChildFile ("corpus.manifest.json");
    saveJson (manifestFile, manifest);
    auto indexFile = bundleDir.getChildFile ("bundle.index.json");
    auto* idx = new DynamicObject();
    idx->setProperty ("bundle_id", bundleName);
    idx->setProperty ("bundle_hash", bundleHash);
    idx->setProperty ("manifest", manifestFile.getFullPathName());
    idx->setProperty ("sources_dir", sourcesDir.getFullPathName());
    saveJson (indexFile, var (idx));

    auto st = state();
    auto* stObj = st.getDynamicObject();
    auto* lastCorpus = new DynamicObject();
    lastCorpus->setProperty ("bundleId", bundleName);
    lastCorpus->setProperty ("bundleHash", bundleHash);
    lastCorpus->setProperty ("bundlePath", bundleDir.getFullPathName());
    lastCorpus->setProperty ("manifestPath", manifestFile.getFullPathName());
    lastCorpus->setProperty ("sourceCount", manifestSources.size());
    stObj->setProperty ("lastCorpus", var (lastCorpus));
    saveState (st);

    auto* out = new DynamicObject();
    out->setProperty ("bundleId", bundleName);
    out->setProperty ("bundleHash", bundleHash);
    out->setProperty ("bundlePath", bundleDir.getFullPathName());
    out->setProperty ("manifestPath", manifestFile.getFullPathName());
    out->setProperty ("indexPath", indexFile.getFullPathName());
    out->setProperty ("sourceCount", manifestSources.size());
    out->setProperty ("skippedSources", skipped);
    out->setProperty ("sources", manifestSources);
    return var (out);
}

var TrainerRegistry::listAdapters()
{
    Array<var> adapters;
    auto st = state();
    const auto activeId = activeAdapterId();
    for (auto& sub : adaptersDir().findChildFiles (File::findDirectories, false))
    {
        auto manifest = sub.getChildFile ("adapter.manifest.json");
        auto artifact = sub.getChildFile ("adapter.lora.json");
        if (! manifest.existsAsFile() || ! artifact.existsAsFile())
            continue;
        auto data = loadJson (manifest);
        auto* o = new DynamicObject();
        o->setProperty ("adapterId", data.getProperty ("adapter_id", sub.getFileName()));
        o->setProperty ("bundleHash", data.getProperty ("bundle_hash", String()));
        o->setProperty ("bundlePath", data.getProperty ("corpus_bundle", String()));
        o->setProperty ("artifactPath", artifact.getFullPathName());
        o->setProperty ("manifestPath", manifest.getFullPathName());
        o->setProperty ("active", activeId == o->getProperty ("adapterId").toString());
        o->setProperty ("quality", data.getProperty ("quality", var()));
        adapters.add (var (o));
    }

    auto* out = new DynamicObject();
    out->setProperty ("activeAdapterId", activeId);
    out->setProperty ("activeAdapterPath", activeAdapterPath());
    out->setProperty ("activeCorpusHash", activeCorpusHash());
    out->setProperty ("adapters", adapters);
    return var (out);
}

var TrainerRegistry::importAdapter (const String& artifactPath, const String& manifestPath,
                                    const String& adapterId, String& error)
{
    error.clear();
    File artifact (artifactPath);
    if (! artifact.existsAsFile())
    {
        error = "artifact file not found: " + artifactPath;
        return {};
    }
    File manifest (manifestPath);
    if (! manifest.existsAsFile())
        manifest = artifact.getSiblingFile ("adapter.manifest.json");
    if (! manifest.existsAsFile())
    {
        error = "manifest file not found";
        return {};
    }
    auto manifestData = loadJson (manifest);
    const auto finalId = adapterId.isNotEmpty()
        ? adapterId
        : manifestData.getProperty ("adapter_id", artifact.getFileNameWithoutExtension()).toString();
    auto destDir = adaptersDir().getChildFile (sanitize (finalId));
    destDir.createDirectory();
    auto destArtifact = destDir.getChildFile ("adapter.lora.json");
    auto destManifest = destDir.getChildFile ("adapter.manifest.json");
    if (! artifact.copyFileTo (destArtifact))
    {
        error = "could not copy artifact";
        return {};
    }
    if (! manifest.copyFileTo (destManifest))
    {
        error = "could not copy manifest";
        return {};
    }

    auto* rec = new DynamicObject();
    rec->setProperty ("adapterId", finalId);
    rec->setProperty ("artifactPath", destArtifact.getFullPathName());
    rec->setProperty ("manifestPath", destManifest.getFullPathName());
    rec->setProperty ("bundleHash", manifestData.getProperty ("bundle_hash", String()));
    rec->setProperty ("bundlePath", manifestData.getProperty ("corpus_bundle", String()));
    rec->setProperty ("quality", manifestData.getProperty ("quality", var()));
    rec->setProperty ("createdAt", utcNow());

    auto st = state();
    auto* stObj = st.getDynamicObject();
    auto adapters = toArray (stObj->getProperty ("adapters"));
    bool replaced = false;
    for (int i = 0; i < adapters.size(); ++i)
    {
        if (adapters.getReference (i).getProperty ("adapterId", var()).toString() == finalId)
        {
            adapters.set (i, var (rec));
            replaced = true;
            break;
        }
    }
    if (! replaced)
        adapters.add (var (rec));
    stObj->setProperty ("adapters", adapters);
    stObj->setProperty ("activeAdapterId", finalId);
    stObj->setProperty ("activeAdapterPath", destArtifact.getFullPathName());
    stObj->setProperty ("activeCorpusHash", manifestData.getProperty ("bundle_hash", String()));
    saveState (st);
    return var (rec);
}

var TrainerRegistry::activateAdapter (const String& adapterId, const String& adapterPath,
                                     const String& corpusHash, String& error)
{
    error.clear();
    if (adapterId.isEmpty())
    {
        error = "missing adapterId";
        return {};
    }
    auto st = state();
    auto* stObj = st.getDynamicObject();
    stObj->setProperty ("activeAdapterId", adapterId);
    stObj->setProperty ("activeAdapterPath", adapterPath);
    stObj->setProperty ("activeCorpusHash", corpusHash);
    saveState (st);
    auto* rec = new DynamicObject();
    rec->setProperty ("adapterId", adapterId);
    rec->setProperty ("adapterPath", adapterPath);
    rec->setProperty ("corpusHash", corpusHash);
    return var (rec);
}

var TrainerRegistry::listJobs()
{
    auto st = state();
    auto* out = new DynamicObject();
    out->setProperty ("jobs", st.getProperty ("jobs", Array<var>()));
    return var (out);
}

void TrainerRegistry::updateJob (const var& job)
{
    auto st = state();
    auto* stObj = st.getDynamicObject();
    auto jobs = toArray (stObj->getProperty ("jobs"));
    const auto jobId = job.getProperty ("jobId", var()).toString();
    bool replaced = false;
    for (int i = 0; i < jobs.size(); ++i)
    {
        if (jobs.getReference (i).getProperty ("jobId", var()).toString() == jobId)
        {
            jobs.set (i, job);
            replaced = true;
            break;
        }
    }
    if (! replaced)
        jobs.add (job);
    stObj->setProperty ("jobs", jobs);
    saveState (st);
}

String TrainerRegistry::activeAdapterId() const
{
    return state().getProperty ("activeAdapterId", var()).toString();
}

String TrainerRegistry::activeAdapterPath() const
{
    return state().getProperty ("activeAdapterPath", var()).toString();
}

String TrainerRegistry::activeCorpusHash() const
{
    return state().getProperty ("activeCorpusHash", var()).toString();
}

} // namespace mosh
