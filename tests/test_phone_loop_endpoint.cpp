#include <catch2/catch_test_macros.hpp>

#include "remote/PhoneLoopEndpoint.h"

using namespace mosh;

namespace
{
juce::var obj (std::initializer_list<std::pair<const char*, juce::var>> fields)
{
    auto* o = new juce::DynamicObject();
    for (const auto& field : fields)
        o->setProperty (juce::Identifier (field.first), field.second);
    return juce::var (o);
}

juce::var okEnvelope (const juce::var& data)
{
    return obj ({ { "ok", true }, { "data", data } });
}

juce::var errEnvelope (const juce::String& message)
{
    return obj ({ { "ok", false }, { "error", message } });
}

juce::var contribution (const char* id, const char* label, bool keeper, bool rejected)
{
    // The extra field stands in for everything loop_state knows and the pad must
    // never see (file paths, durations, engine ids).
    return obj ({ { "id", id }, { "label", label }, { "keeper", keeper },
                  { "rejected", rejected }, { "sourceFile", "/Users/secret/take.wav" } });
}

juce::var loopStateData()
{
    juce::Array<juce::var> parts;
    parts.add (contribution ("part-1", "Verse", true, false));
    parts.add (contribution ("part-2", "Chorus", false, true));

    return obj ({ { "projectId", "proj-1" },
                  { "host", "host-epoch-7" },
                  { "engaged", true },
                  { "leadTrackId", "track-lead" },
                  { "takesTrackId", "track-takes" },
                  { "phase", "idle" },
                  { "transport", obj ({ { "recording", false }, { "playing", true } }) },
                  { "listening", obj ({ { "qn", 16.0 }, { "bar", 5 }, { "entryQn", juce::var() }, { "leadQn", 4.0 } }) },
                  { "currentId", "part-2" },
                  { "lastId", "part-2" },
                  { "reviewId", "part-1" },
                  { "auditionedId", juce::var() },
                  { "contributions", juce::var (parts) },
                  { "blockReason", "" } });
}

/** A scriptable stand-in for MoshOps: records every command the endpoint sends and
    answers loop_state / loop_<action> from fields the case can rewrite. */
struct FakeHost
{
    juce::Array<juce::var> commands;
    juce::var stateEnvelope { okEnvelope (loopStateData()) };
    juce::var actionEnvelope { okEnvelope (obj ({ { "detail", "Recording armed" }, { "actionId", "act-1" } })) };

    PhoneLoopEndpoint::Execute executor()
    {
        return [this] (const juce::var& command) {
            commands.add (command);
            return command.getProperty ("command", {}).toString() == "loop_state" ? stateEnvelope : actionEnvelope;
        };
    }

    int mutations() const
    {
        int count = 0;
        for (const auto& command : commands)
            if (command.getProperty ("command", {}).toString() != "loop_state")
                ++count;
        return count;
    }

    juce::var lastMutation() const
    {
        for (int i = commands.size(); --i >= 0;)
            if (commands[i].getProperty ("command", {}).toString() != "loop_state")
                return commands[i];
        return {};
    }
};

juce::var actionBody (const PhoneLoopEndpoint& endpoint,
                      const juce::String& requestId,
                      const char* action,
                      std::initializer_list<std::pair<const char*, juce::var>> extra = {})
{
    auto body = obj ({ { "version", 1 },
                       { "requestId", requestId },
                       { "sessionId", endpoint.sessionId() },
                       { "projectId", "proj-1" },
                       { "authority", "{}" },
                       { "action", action } });
    for (const auto& field : extra)
        body.getDynamicObject()->setProperty (juce::Identifier (field.first), field.second);
    return body;
}
} // namespace

TEST_CASE ("phone loop state renders every field the pad's schema requires", "[phoneloop][endpoint]")
{
    FakeHost host;
    PhoneLoopEndpoint endpoint (host.executor());
    endpoint.resetSession();

    int status = 0;
    const auto state = endpoint.state (status);

    CHECK (status == 200);
    REQUIRE (host.commands.size() == 1);
    CHECK (host.commands[0].getProperty ("command", {}).toString() == "loop_state");
    CHECK ((bool) host.commands[0].getProperty ("args", {}).getProperty ("phonePoll", false));

    CHECK ((int) state.getProperty ("version", 0) == 1);
    CHECK (state.getProperty ("sessionId", {}).toString() == endpoint.sessionId());
    CHECK (endpoint.sessionId().isNotEmpty());
    CHECK (state.getProperty ("projectId", {}).toString() == "proj-1");
    CHECK (state.getProperty ("authority", {}).toString()
           == phoneloop::authorityFor (host.stateEnvelope.getProperty ("data", {})));
    CHECK (state.getProperty ("phase", {}).toString() == "idle");
    CHECK ((bool) state.getProperty ("engaged", false));
    CHECK ((bool) state.getProperty ("hostAlive", false));
    CHECK_FALSE ((bool) state.getProperty ("busy", true));
    CHECK_FALSE ((bool) state.getProperty ("recording", true));
    CHECK ((bool) state.getProperty ("playing", false));
    CHECK (state.getProperty ("playbackScope", {}).toString() == "arrangement");

    const auto listening = state.getProperty ("listening", {});
    CHECK ((double) listening.getProperty ("bar", 0.0) == 5.0);
    CHECK ((double) listening.getProperty ("qn", 0.0) == 16.0);
    CHECK (listening.getProperty ("entryQn", "sentinel").isVoid());
    CHECK ((double) listening.getProperty ("leadQn", 0.0) == 4.0);

    CHECK (state.getProperty ("currentId", {}).toString() == "part-2");
    CHECK (state.getProperty ("lastId", {}).toString() == "part-2");
    CHECK (state.getProperty ("reviewId", {}).toString() == "part-1");
    CHECK (state.getProperty ("auditionedId", "sentinel").isVoid());
    CHECK (state.getProperty ("error", "sentinel").toString().isEmpty());

    // Contributions are stripped to what the pad renders — nothing about where the
    // audio lives leaves the Mac.
    const auto* parts = state.getProperty ("contributions", {}).getArray();
    REQUIRE (parts != nullptr);
    REQUIRE (parts->size() == 2);
    CHECK ((*parts)[0].getProperty ("id", {}).toString() == "part-1");
    CHECK ((*parts)[0].getProperty ("label", {}).toString() == "Verse");
    CHECK ((bool) (*parts)[0].getProperty ("keeper", false));
    CHECK_FALSE ((bool) (*parts)[0].getProperty ("rejected", true));
    CHECK ((*parts)[0].getDynamicObject()->getProperties().size() == 4);
    CHECK ((bool) (*parts)[1].getProperty ("rejected", false));
    CHECK (juce::JSON::toString (state).contains ("secret") == false);

    const auto* receipts = state.getProperty ("receipts", {}).getArray();
    REQUIRE (receipts != nullptr);
    CHECK (receipts->isEmpty());
}

TEST_CASE ("phone loop state reports a labelless take and the two non-arrangement playback scopes", "[phoneloop][endpoint]")
{
    FakeHost host;
    PhoneLoopEndpoint endpoint (host.executor());
    endpoint.resetSession();

    auto data = loopStateData();
    data.getDynamicObject()->setProperty ("auditionedId", "part-1");
    juce::Array<juce::var> parts;
    parts.add (obj ({ { "id", "part-1" }, { "keeper", false }, { "rejected", false } }));
    data.getDynamicObject()->setProperty ("contributions", juce::var (parts));
    host.stateEnvelope = okEnvelope (data);

    int status = 0;
    auto state = endpoint.state (status);
    CHECK (state.getProperty ("playbackScope", {}).toString() == "selected");
    CHECK (state.getProperty ("auditionedId", {}).toString() == "part-1");
    CHECK (state.getProperty ("contributions", {})[0].getProperty ("label", {}).toString() == "Part 1");

    data.getDynamicObject()->setProperty ("transport", obj ({ { "recording", false }, { "playing", false } }));
    host.stateEnvelope = okEnvelope (data);
    state = endpoint.state (status);
    CHECK (state.getProperty ("playbackScope", {}).toString() == "none");
}

TEST_CASE ("phone loop state maps the three blocking reasons in priority order", "[phoneloop][endpoint]")
{
    FakeHost host;
    PhoneLoopEndpoint endpoint (host.executor());
    endpoint.resetSession();

    auto data = loopStateData();
    data.getDynamicObject()->setProperty ("blockReason", "Arm the take track.");
    host.stateEnvelope = okEnvelope (data);
    int status = 0;
    CHECK (endpoint.state (status).getProperty ("error", {}).toString() == "Arm the take track.");

    data.getDynamicObject()->setProperty ("engaged", false);
    host.stateEnvelope = okEnvelope (data);
    CHECK (endpoint.state (status).getProperty ("error", {}).toString() == "Pick a track on the Mac first (Setup).");

    // A dead host outranks everything: the state behind it cannot be trusted.
    host.stateEnvelope = errEnvelope ("engine is not running");
    const auto offline = endpoint.state (status);
    CHECK (status == 200); // still a 200 — the phone must not treat this as "pair again"
    CHECK (offline.getProperty ("error", {}).toString() == "Mosh is not responding on the Mac.");
    CHECK_FALSE ((bool) offline.getProperty ("hostAlive", true));
    CHECK_FALSE ((bool) offline.getProperty ("engaged", true));
    CHECK (offline.getProperty ("phase", {}).toString() == "offline");
    CHECK (offline.getProperty ("projectId", "sentinel").toString().isEmpty());
    REQUIRE (offline.getProperty ("contributions", {}).getArray() != nullptr);
    CHECK (offline.getProperty ("contributions", {}).getArray()->isEmpty());
    CHECK ((int) offline.getProperty ("version", 0) == 1);
}

TEST_CASE ("phone loop state is busy through a count-in", "[phoneloop][endpoint]")
{
    FakeHost host;
    PhoneLoopEndpoint endpoint (host.executor());
    endpoint.resetSession();

    auto data = loopStateData();
    data.getDynamicObject()->setProperty ("phase", "count_in");
    host.stateEnvelope = okEnvelope (data);

    int status = 0;
    CHECK ((bool) endpoint.state (status).getProperty ("busy", false));
}

TEST_CASE ("phone loop action sends loop_<action> with the phone's request envelope", "[phoneloop][endpoint]")
{
    FakeHost host;
    PhoneLoopEndpoint endpoint (host.executor());
    endpoint.resetSession();

    int status = 0;
    const auto response = endpoint.action (actionBody (endpoint, "req-1", "record"), status);

    CHECK (status == 200);
    CHECK ((int) response.getProperty ("version", 0) == 1);
    REQUIRE (host.mutations() == 1);

    const auto command = host.lastMutation();
    CHECK (command.getProperty ("command", {}).toString() == "loop_record");
    const auto args = command.getProperty ("args", {});
    CHECK (args.getProperty ("requestId", {}).toString() == "req-1");
    CHECK (args.getProperty ("projectId", {}).toString() == "proj-1");
    CHECK (args.getProperty ("authority", {}).toString() == "{}");
    CHECK (args.getProperty ("targetId", "sentinel").toString() == "sentinel"); // untargeted -> absent
    CHECK (args.getProperty ("bar", "sentinel").toString() == "sentinel");
    CHECK (args.getProperty ("leadQn", "sentinel").toString() == "sentinel");

    const auto receipt = response.getProperty ("receipt", {});
    CHECK (receipt.getProperty ("requestId", {}).toString() == "req-1");
    CHECK (receipt.getProperty ("action", {}).toString() == "record");
    CHECK (receipt.getProperty ("status", {}).toString() == "completed");
    CHECK (receipt.getProperty ("detail", {}).toString() == "Recording armed");
    CHECK (receipt.getProperty ("actionId", {}).toString() == "act-1");
    CHECK_FALSE (receipt.getProperty ("completedMs", {}).isVoid());

    // The response carries a freshly polled state, and the receipt is now in its ledger.
    const auto* receipts = response.getProperty ("state", {}).getProperty ("receipts", {}).getArray();
    REQUIRE (receipts != nullptr);
    REQUIRE (receipts->size() == 1);
    CHECK ((*receipts)[0].getProperty ("requestId", {}).toString() == "req-1");
}

TEST_CASE ("phone loop action forwards the optional per-action arguments", "[phoneloop][endpoint]")
{
    FakeHost host;
    PhoneLoopEndpoint endpoint (host.executor());
    endpoint.resetSession();

    int status = 0;
    endpoint.action (actionBody (endpoint, "req-keep", "keep", { { "targetId", "part-2" } }), status);
    auto args = host.lastMutation().getProperty ("args", {});
    CHECK (host.lastMutation().getProperty ("command", {}).toString() == "loop_keep");
    CHECK (args.getProperty ("targetId", {}).toString() == "part-2");

    endpoint.action (actionBody (endpoint, "req-nav", "navigate", { { "bar", 12 } }), status);
    args = host.lastMutation().getProperty ("args", {});
    CHECK (host.lastMutation().getProperty ("command", {}).toString() == "loop_navigate");
    CHECK ((int) args.getProperty ("bar", 0) == 12);

    endpoint.action (actionBody (endpoint, "req-lead", "lead_in", { { "leadQn", 2.5 } }), status);
    args = host.lastMutation().getProperty ("args", {});
    CHECK (host.lastMutation().getProperty ("command", {}).toString() == "loop_lead_in");
    CHECK ((double) args.getProperty ("leadQn", 0.0) == 2.5);
}

TEST_CASE ("phone loop action turns every command outcome into a terminal receipt", "[phoneloop][endpoint]")
{
    SECTION ("a refused command is rejected with the command's own reason")
    {
        FakeHost host;
        PhoneLoopEndpoint endpoint (host.executor());
        endpoint.resetSession();
        host.actionEnvelope = okEnvelope (obj ({ { "applied", false }, { "reason", "Stop before choosing a take." } }));

        int status = 0;
        const auto receipt = endpoint.action (actionBody (endpoint, "req-1", "record"), status).getProperty ("receipt", {});
        CHECK (receipt.getProperty ("status", {}).toString() == "rejected");
        CHECK (receipt.getProperty ("detail", {}).toString() == "Stop before choosing a take.");
        CHECK_FALSE (receipt.getProperty ("completedMs", {}).isVoid());
    }

    SECTION ("a failed command is rejected with its error text")
    {
        FakeHost host;
        PhoneLoopEndpoint endpoint (host.executor());
        endpoint.resetSession();
        host.actionEnvelope = errEnvelope ("unknown command: loop_record");

        int status = 0;
        const auto receipt = endpoint.action (actionBody (endpoint, "req-1", "record"), status).getProperty ("receipt", {});
        CHECK (receipt.getProperty ("status", {}).toString() == "rejected");
        CHECK (receipt.getProperty ("detail", {}).toString() == "unknown command: loop_record");
    }

    SECTION ("a message-thread timeout is cancelled, not rejected")
    {
        FakeHost host;
        PhoneLoopEndpoint endpoint (host.executor());
        endpoint.resetSession();
        // The exact envelope RemoteCompanionServer::callOnMessageThread returns when
        // the Mac does not answer in time — the action may still be running there.
        host.actionEnvelope = errEnvelope ("message-thread call timed out");

        int status = 0;
        const auto receipt = endpoint.action (actionBody (endpoint, "req-1", "record"), status).getProperty ("receipt", {});
        CHECK (receipt.getProperty ("status", {}).toString() == "cancelled");
        CHECK (receipt.getProperty ("detail", {}).toString()
               == "No confirmation from the Mac within the time limit; the state shown is authoritative.");
    }

    SECTION ("a bare ok falls back to a readable detail and the request id")
    {
        FakeHost host;
        PhoneLoopEndpoint endpoint (host.executor());
        endpoint.resetSession();
        host.actionEnvelope = okEnvelope (juce::var (new juce::DynamicObject()));

        int status = 0;
        const auto receipt = endpoint.action (actionBody (endpoint, "req-1", "stop"), status).getProperty ("receipt", {});
        CHECK (receipt.getProperty ("status", {}).toString() == "completed");
        CHECK (receipt.getProperty ("detail", {}).toString() == "stop: completed");
        CHECK (receipt.getProperty ("actionId", {}).toString() == "req-1");
    }
}

TEST_CASE ("phone loop action replays a retried request instead of recording twice", "[phoneloop][endpoint]")
{
    FakeHost host;
    PhoneLoopEndpoint endpoint (host.executor());
    endpoint.resetSession();

    int status = 0;
    const auto body = actionBody (endpoint, "req-1", "record");
    const auto first = endpoint.action (body, status);
    REQUIRE (host.mutations() == 1);

    // A dropped response and a retry: the phone re-POSTs the identical body.
    const auto replay = endpoint.action (body, status);
    CHECK (host.mutations() == 1); // no second recording
    CHECK (status == 200);
    CHECK (juce::JSON::toString (replay.getProperty ("receipt", {}))
           == juce::JSON::toString (first.getProperty ("receipt", {})));

    // The same id carrying different content is a phone bug, not a retry.
    const auto conflicting = endpoint.action (actionBody (endpoint, "req-1", "stop"), status);
    CHECK (host.mutations() == 1);
    const auto receipt = conflicting.getProperty ("receipt", {});
    CHECK (receipt.getProperty ("status", {}).toString() == "rejected");
    CHECK (receipt.getProperty ("detail", {}).toString()
           == "Request ID was already used for different content; refresh state.");
}

TEST_CASE ("phone loop action refuses a request from a previous phone session", "[phoneloop][endpoint]")
{
    FakeHost host;
    PhoneLoopEndpoint endpoint (host.executor());
    endpoint.resetSession();

    auto body = actionBody (endpoint, "req-1", "record");
    body.getDynamicObject()->setProperty ("sessionId", "sess-from-a-previous-pairing");

    int status = 0;
    const auto receipt = endpoint.action (body, status).getProperty ("receipt", {});
    CHECK (status == 200);
    CHECK (host.mutations() == 0);
    CHECK (receipt.getProperty ("status", {}).toString() == "rejected");
    CHECK (receipt.getProperty ("detail", {}).toString() == "Phone session changed; refresh state.");
}

TEST_CASE ("phone loop resetSession issues a new id and clears the ledger", "[phoneloop][endpoint]")
{
    FakeHost host;
    PhoneLoopEndpoint endpoint (host.executor());
    endpoint.resetSession();
    const auto before = endpoint.sessionId();

    int status = 0;
    endpoint.action (actionBody (endpoint, "req-1", "record"), status);
    REQUIRE (endpoint.state (status).getProperty ("receipts", {}).getArray()->size() == 1);

    endpoint.resetSession();
    CHECK (endpoint.sessionId() != before);
    CHECK (endpoint.sessionId().isNotEmpty());
    CHECK (endpoint.state (status).getProperty ("receipts", {}).getArray()->isEmpty());

    // The cleared barrier means the same request id is admissible again in the new session.
    endpoint.action (actionBody (endpoint, "req-1", "record"), status);
    CHECK (host.mutations() == 2);
}

TEST_CASE ("phone loop action rejects an unparseable body without a receipt", "[phoneloop][endpoint]")
{
    FakeHost host;
    PhoneLoopEndpoint endpoint (host.executor());
    endpoint.resetSession();

    auto body = actionBody (endpoint, "req-1", "record");
    body.getDynamicObject()->setProperty ("action", "self_destruct");

    int status = 0;
    const auto response = endpoint.action (body, status);
    CHECK (status == 200);
    CHECK (host.commands.isEmpty()); // no command, and no state poll either
    CHECK (response.getProperty ("error", {}).toString() == "Unknown action");
    CHECK (response.getProperty ("receipt", "sentinel").toString() == "sentinel");
    CHECK (response.getProperty ("state", "sentinel").toString() == "sentinel");

    // Nothing was stored, so the same id is still usable for a corrected request.
    endpoint.action (actionBody (endpoint, "req-1", "record"), status);
    CHECK (host.mutations() == 1);
}

TEST_CASE ("phone loop state shows only the most recent receipts", "[phoneloop][endpoint]")
{
    FakeHost host;
    PhoneLoopEndpoint endpoint (host.executor());
    endpoint.resetSession();

    int status = 0;
    for (int i = 0; i < 70; ++i)
        endpoint.action (actionBody (endpoint, "req-" + juce::String (i), "record"), status);

    const auto state = endpoint.state (status); // held: the array below belongs to it
    const auto* receipts = state.getProperty ("receipts", {}).getArray();
    REQUIRE (receipts != nullptr);
    REQUIRE (receipts->size() == 64);
    // Submission order, oldest first, ending at the newest.
    CHECK ((*receipts)[0].getProperty ("requestId", {}).toString() == "req-6");
    CHECK ((*receipts)[63].getProperty ("requestId", {}).toString() == "req-69");
}
