#include "MultiplayerAudioRefSelfTest.h"
#include "engine/MoshEngine.h"
#include "moshops/MoshOps.h"
#include "multiplayer/MultiplayerClient.h"
#include "multiplayer/LogicalId.h"
#include <juce_cryptography/juce_cryptography.h>
#include <iostream>

namespace mosh
{
namespace
{
juce::var object (std::initializer_list<std::pair<const char*, juce::var>> fields)
{
    auto* value = new juce::DynamicObject();
    for (const auto& [name, field] : fields)
        value->setProperty (name, field);
    return juce::var (value);
}

juce::var command (MoshOps& ops, const juce::String& name, juce::var args = {})
{
    auto* value = new juce::DynamicObject();
    value->setProperty ("command", name);
    if (! args.isVoid())
        value->setProperty ("args", args);
    return ops.execute (juce::var (value));
}

void pumpFor (int milliseconds)
{
    auto* manager = juce::MessageManager::getInstanceWithoutCreating();
    const auto deadline = juce::Time::getMillisecondCounter() + (juce::uint32) milliseconds;
    while (juce::Time::getMillisecondCounter() < deadline)
    {
        if (manager != nullptr)
            manager->runDispatchLoopUntil (25);
        else
            juce::Thread::sleep (25);
    }
}

juce::String sha256 (const juce::File& file)
{
    juce::FileInputStream input (file);
    return input.openedOk() ? juce::SHA256 (input).toHexString() : juce::String();
}

juce::String blobNamed (const juce::String& blob, const juce::String& name)
{
    auto xml = juce::parseXML (blob);
    if (xml == nullptr)
        return {};
    auto track = juce::ValueTree::fromXml (*xml);
    if (! track.isValid())
        return {};
    track.setProperty ("name", name, nullptr);
    if (auto renamed = track.createXml())
        return renamed->toString();
    return {};
}

juce::String trackName (MoshEngine& engine, const juce::String& logicalId)
{
    return logicalid::findTrack (engine.edit().state, logicalId).getProperty ("name").toString();
}

bool waitForTrackName (MoshEngine& engine, const juce::String& logicalId,
                       const juce::String& expected)
{
    const auto deadline = juce::Time::getMillisecondCounter() + (juce::uint32) 5000;
    while (juce::Time::getMillisecondCounter() < deadline)
    {
        if (trackName (engine, logicalId) == expected)
            return true;
        pumpFor (25);
    }
    return false;
}

bool waitForEventCount (const MultiplayerAudioRefSelfTestCallbacks& callbacks,
                        const juce::String& type, int expected)
{
    const auto deadline = juce::Time::getMillisecondCounter() + (juce::uint32) 5000;
    while (juce::Time::getMillisecondCounter() < deadline)
    {
        const auto count = callbacks.eventCount (type);
        if (count == expected)
            return true;
        if (count > expected)
            return false;
        pumpFor (25);
    }
    return false;
}

juce::String editXml (MoshEngine& engine)
{
    if (auto xml = engine.edit().state.createXml())
        return xml->toString();
    return {};
}

void settleMutationEvents (const MultiplayerAudioRefSelfTestCallbacks& callbacks)
{
    int stableCount = 0;
    auto previous = callbacks.eventCount ("snapshot_invalidated");
    const auto deadline = juce::Time::getMillisecondCounter() + (juce::uint32) 2000;
    while (stableCount < 3 && juce::Time::getMillisecondCounter() < deadline)
    {
        pumpFor (100);
        const auto current = callbacks.eventCount ("snapshot_invalidated");
        stableCount = current == previous ? stableCount + 1 : 0;
        previous = current;
    }
}
}

void runMultiplayerAudioRefSelfTest (MoshEngine& engine, MoshOps& ops,
                                     const MultiplayerAudioRefSelfTestCallbacks& callbacks)
{
    callbacks.section ("Multiplayer C012: live audioRef containment");

    const auto createdTrack = command (ops, "create_track", object ({ { "name", "C012 Barrier" } }));
    const auto trackId = createdTrack.getProperty ("data", juce::var())
                                     .getProperty ("trackId", juce::var()).toString();
    callbacks.check ((bool) createdTrack.getProperty ("ok", false) && trackId.isNotEmpty(),
                     "C012 fixture created a real victim track");
    const auto serialized = command (ops, "mp_serialize_track", object ({ { "trackId", trackId } }));
    const auto data = serialized.getProperty ("data", juce::var());
    const auto blob = data.getProperty ("blob", juce::var()).toString();
    const auto logicalId = data.getProperty ("logicalId", juce::var()).toString();
    const auto validBlob = blobNamed (blob, "C012 Valid Applied");
    const auto absentBlob = blobNamed (blob, "C012 Absent Applied");
    const auto barrierBlob = blobNamed (blob, "C012 Final Barrier");
    callbacks.check (blob.isNotEmpty() && logicalId.isNotEmpty()
                         && validBlob.isNotEmpty() && absentBlob.isNotEmpty() && barrierBlob.isNotEmpty(),
                     "C012 fixture serialized three distinct observable commit blobs");

    const auto session = command (ops, "mp_create_session",
                                  object ({ { "name", "C012 Victim" }, { "color", "#335577" } }));
    const auto code = session.getProperty ("data", juce::var()).getProperty ("code", juce::var()).toString();
    MultiplayerClient attacker;
    callbacks.check (code.isNotEmpty() && attacker.joinSession (code, "C012 Attacker", "#773355"),
                     "C012 attacker joined the owned local-relay room");
    settleMutationEvents (callbacks);

    const auto payload = engine.sessionDir().getChildFile ("c012-payload.bin");
    payload.replaceWithData ("C012 owned traversal payload", 28);
    const auto hash = sha256 (payload);
    callbacks.check (hash.length() == 64, "C012 valid payload hash computed");

    const auto byHashDir = engine.editFile().getParentDirectory().getChildFile ("audio").getChildFile ("by-hash");
    const auto sentinelName = "c012-escaped-" + juce::Uuid().toString() + ".bin";
    const auto traversalExt = "x/../../" + sentinelName;
    const auto sentinel = byHashDir.getChildFile (hash + "." + traversalExt);
    callbacks.check (! sentinel.existsAsFile() && ! sentinel.isAChildOf (byHashDir),
                     "C012 escaped sentinel starts absent outside audio/by-hash");
    callbacks.check (attacker.uploadBlob (hash, traversalExt, payload),
                     "C012 traversal-spelled blob uploaded with valid payload hash");

    callbacks.check (trackName (engine, logicalId) == "C012 Barrier",
                     "C012 victim starts in the known pre-commit state");
    settleMutationEvents (callbacks);
    const auto editBefore = editXml (engine);
    const auto snapshotBefore = juce::JSON::toString (ops.snapshot());
    const auto mutationEventsBefore = callbacks.eventCount ("snapshot_invalidated");
    const auto selectionEventsBefore = callbacks.eventCount ("peer_selection");
    const auto logBytesBefore = engine.sessionDir().getChildFile ("mosh-log.jsonl").getSize();
    const auto undoDescriptionsBefore = engine.edit().getUndoManager().getUndoDescriptions();

    juce::Array<juce::var> maliciousRefs;
    maliciousRefs.add (object ({ { "hash", hash }, { "ext", traversalExt } }));
    attacker.publish (object ({ { "type", "commit" }, { "logicalId", "" }, { "blob", validBlob },
                               { "audioRefs", juce::var (maliciousRefs) } }));
    attacker.publish (object ({ { "type", "selection" }, { "trackId", logicalId },
                               { "clipId", "c012-fifo-barrier" } }));
    callbacks.check (waitForEventCount (callbacks, "peer_selection", selectionEventsBefore + 1),
                     "C012 same-peer selection proves the malformed frame window drained");

    const bool escaped = sentinel.existsAsFile();
    std::cerr << "C012 escaped sentinel " << (escaped ? "created" : "absent") << "\n";
    callbacks.check (! escaped, "C012 escaped sentinel remains absent");
    callbacks.check (editXml (engine) == editBefore,
                     "C012 malformed frame leaves the live Edit XML unchanged");
    callbacks.check (juce::JSON::toString (ops.snapshot()) == snapshotBefore,
                     "C012 malformed frame leaves snapshot JSON unchanged");
    callbacks.check (callbacks.eventCount ("snapshot_invalidated") == mutationEventsBefore,
                     "C012 malformed frame emits no snapshot_invalidated event");
    callbacks.check (engine.sessionDir().getChildFile ("mosh-log.jsonl").getSize() == logBytesBefore,
                     "C012 malformed frame writes no JSONL record");
    callbacks.check (engine.edit().getUndoManager().getUndoDescriptions() == undoDescriptionsBefore,
                     "C012 malformed frame leaves undo descriptions unchanged");

    juce::Array<juce::var> validRefs;
    validRefs.add (object ({ { "hash", hash }, { "ext", "wav" } }));
    callbacks.check (attacker.uploadBlob (hash, "wav", payload), "C012 valid wav blob uploaded");
    attacker.publish (object ({ { "type", "commit" }, { "logicalId", logicalId }, { "blob", validBlob },
                               { "audioRefs", juce::var (validRefs) } }));
    callbacks.check (waitForTrackName (engine, logicalId, "C012 Valid Applied"),
                     "C012 valid-ref commit applied its distinct track state");
    const auto validDestination = byHashDir.getChildFile (hash + ".wav");
    callbacks.check (validDestination.existsAsFile(), "C012 valid audioRef landed directly under audio/by-hash");
    callbacks.check (callbacks.eventCount ("snapshot_invalidated") == mutationEventsBefore + 1,
                     "C012 valid-ref commit emitted exactly one mutation event");

    attacker.publish (object ({ { "type", "commit" }, { "logicalId", logicalId }, { "blob", absentBlob } }));
    callbacks.check (waitForTrackName (engine, logicalId, "C012 Absent Applied"),
                     "C012 absent audioRefs commit applied its distinct track state");
    callbacks.check (callbacks.eventCount ("snapshot_invalidated") == mutationEventsBefore + 2,
                     "C012 absent audioRefs commit emitted exactly one apply event");

    attacker.publish (object ({ { "type", "commit" }, { "logicalId", logicalId }, { "blob", barrierBlob },
                               { "audioRefs", juce::var (validRefs) } }));
    callbacks.check (waitForTrackName (engine, logicalId, "C012 Final Barrier"),
                     "C012 later valid barrier proves the absent-ref frame window drained");
    callbacks.check (callbacks.eventCount ("snapshot_invalidated") == mutationEventsBefore + 3,
                     "C012 three valid applies each emitted exactly one mutation event");
    std::cerr << "C012 malformed commit no Edit/snapshot/event/JSONL/undo mutation; positive controls completed\n";

    attacker.leave();
    command (ops, "mp_leave_session");
    payload.deleteFile();
    validDestination.deleteFile();
    if (sentinel.existsAsFile())
        sentinel.deleteFile();
}
}
