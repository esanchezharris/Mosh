#pragma once

#include "AgentTxn.h"
#include <optional>

namespace mosh::agentrequest
{
inline bool validId (const juce::String& id)
{
    return id.isNotEmpty() && id.length() <= 128
        && id.containsOnly ("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.");
}

inline bool allowedCommand (const juce::String& command)
{
    return command == "set_track_volume" || command == "set_plugin_param"
        || command == "bypass_plugin";
}

inline bool faultAllowed (bool ownedHarness, const juce::String& session,
                          const juce::String& armedId, const juce::String& requestId)
{
    return ownedHarness && session.startsWith ("_harness/") && validId (requestId)
        && armedId == requestId;
}

inline juce::String removeOwnedJournalRows (const juce::String& text, const juce::String& requestId,
                                            const juce::String& projectId)
{
    juce::String retained;
    for (int start = 0; start < text.length();)
    {
        const int newline = text.indexOfChar (start, '\n');
        const int end = newline < 0 ? text.length() : newline + 1;
        const auto line = text.substring (start, end);
        const auto row = juce::JSON::parse (line);
        if (row["agentRequestId"].toString() != requestId || row["agentProjectId"].toString() != projectId)
            retained += line;
        start = end;
    }
    return retained;
}

inline juce::var comparisonSnapshot (const juce::var& snapshot, const juce::String& transactionId)
{
    // Recovery adds operational notices: compare copies without empty residue or this
    // request's own orphan notice; real recording residue and foreign orphans remain significant.
    auto copy = snapshot.clone();
    auto* session = copy["session"].getDynamicObject();
    if (session == nullptr) return copy;
    const auto residue = session->getProperty ("recordingResidue");
    if (residue.isArray() && residue.size() == 0) session->removeProperty ("recordingResidue");
    const auto unresolved = session->getProperty ("unresolvedTransactions");
    auto* metadata = unresolved.getDynamicObject();
    const auto ids = unresolved["ids"];
    if (transactionId.isNotEmpty() && metadata != nullptr && metadata->getProperties().size() == 2
        && ids.isArray() && unresolved["count"].isInt() && (int) unresolved["count"] == ids.size())
    {
        juce::Array<juce::var> foreign;
        bool allStrings = true;
        for (int i = 0; i < ids.size(); ++i)
        {
            allStrings = allStrings && ids[i].isString();
            if (ids[i].toString() != transactionId) foreign.add (ids[i]);
        }
        if (allStrings && foreign.size() != ids.size())
        {
            if (foreign.isEmpty()) session->removeProperty ("unresolvedTransactions");
            else
            {
                metadata->setProperty ("ids", foreign);
                metadata->setProperty ("count", foreign.size());
            }
        }
    }
    return copy;
}

inline juce::String fingerprint (const juce::var& snapshot, const juce::String& transactionId)
{
    return agenttxn::fingerprint (comparisonSnapshot (snapshot, transactionId));
}

struct Record
{
    juce::String requestId, projectId, payloadDigest, patchDigest, status;
    juce::String preFingerprint, postFingerprint, historyTxn, epoch, transactionId;
    int appliedCount = 0;
    juce::Array<juce::var> results;
    bool loaded = false;
    bool nativeCommitted = false;
};

inline juce::var toLedger (const Record& record)
{
    auto* object = new juce::DynamicObject();
    object->setProperty ("v", 1);
    object->setProperty ("kind", "agent_request");
    object->setProperty ("requestId", record.requestId);
    object->setProperty ("projectId", record.projectId);
    object->setProperty ("payloadDigest", record.payloadDigest);
    object->setProperty ("patchDigest", record.patchDigest);
    object->setProperty ("status", record.status);
    object->setProperty ("appliedCount", record.appliedCount);
    object->setProperty ("preFingerprint", record.preFingerprint);
    object->setProperty ("postFingerprint", record.postFingerprint);
    object->setProperty ("transactionKey", record.transactionId);
    object->setProperty ("nativeCommitted", record.nativeCommitted);
    return juce::var (object);
}

inline std::optional<Record> fromLedger (const juce::var& value)
{
    if (! value.isObject() || value["kind"].toString() != "agent_request"
        || (int) value["v"] != 1 || ! validId (value["requestId"].toString()))
        return std::nullopt;
    Record record;
    record.requestId = value["requestId"].toString();
    record.projectId = value["projectId"].toString();
    record.payloadDigest = value["payloadDigest"].toString();
    record.patchDigest = value["patchDigest"].toString();
    record.status = value["status"].toString();
    if (record.projectId.isEmpty() || record.payloadDigest.isEmpty()) return std::nullopt;
    if (record.status != "prepared" && record.status != "committed" && record.status != "cancelled"
        && record.status != "rolled_back" && record.status != "undone") record.status = "unresolved";
    record.appliedCount = (int) value["appliedCount"];
    record.preFingerprint = value["preFingerprint"].toString();
    record.postFingerprint = value["postFingerprint"].toString();
    record.transactionId = value["transactionKey"].toString();
    record.nativeCommitted = (bool) value.getProperty ("nativeCommitted", record.status == "committed");
    record.loaded = true;
    return record;
}
}
