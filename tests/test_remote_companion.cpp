#include <catch2/catch_test_macros.hpp>

#include "remote/RemoteCompanionProtocol.h"
#include "remote/RemoteCompanionServer.h"

using namespace mosh;

namespace
{
/** A port the OS has just told us is free.

    Binding a listener on port 0 makes the kernel pick an unused ephemeral port;
    getBoundPort() reports which one. We close it immediately and hand that number
    to startPairing. A listening socket that never accepted a connection leaves no
    TIME_WAIT entry, so the rebind that follows succeeds. Returns 0 if even the
    probe cannot bind. */
int probeFreePort()
{
    juce::StreamingSocket probe;
    if (! probe.createListener (0, {}))
        return 0;

    const int bound = probe.getBoundPort();
    probe.close();
    return bound;
}

/** startPairing() on a port that is free RIGHT NOW, retrying if we lose the race.

    These cases used to hardcode 47874-47879. Whenever one of those was already
    held — a concurrent CI job, another checkout running the same suite, a
    lingering socket — startPairing failed and the test reported it as a bare
    `REQUIRE((bool) ...getProperty ("ok", false))` against `false`, which reads
    exactly like a product regression. That took the linux-x64 job down on
    2026-07-28 and then passed on a plain re-run with no code change.

    We deliberately do NOT pass port 0 through to startPairing: isRestrictedPort()
    refuses everything below 1024, including 0, and that guard is production
    behaviour worth keeping honest. Resolving a concrete free port first keeps the
    server under test on exactly the path it takes in production.

    A port can still be taken in the window between probing and binding it, so on
    failure we just probe again — the kernel hands out a different ephemeral port
    each time, so a repeated collision is vanishingly unlikely. `boundPort` reports
    which port won, for the one case that needs a second server to collide with it
    on purpose. */
juce::var startPairingOnFreePort (RemoteCompanionServer& server, int* boundPort = nullptr)
{
    juce::var result;

    for (int attempt = 0; attempt < 16; ++attempt)
    {
        const int candidate = probeFreePort();
        if (candidate <= 0 || RemoteCompanionProtocol::isRestrictedPort (candidate))
            continue;

        auto* args = new juce::DynamicObject();
        args->setProperty ("port", candidate);
        result = server.startPairing (juce::var (args));

        if ((bool) result.getProperty ("ok", false))
        {
            if (boundPort != nullptr)
                *boundPort = candidate;

            return result;
        }
    }

    return result; // the caller's REQUIRE reports the last failure
}
} // namespace

TEST_CASE ("remote companion pairing requires an unexpired token", "[remote][pairing]")
{
    RemoteCompanionProtocol protocol;

    const auto issued = protocol.beginPairing ("MacBook-Pro.local", 47873, 1000, "pair-token");

    REQUIRE (RemoteCompanionProtocol::defaultPort() == 47873);
    REQUIRE (! RemoteCompanionProtocol::isRestrictedPort (47873));
    REQUIRE (issued.token == "pair-token");
    REQUIRE (issued.pairingUrl.contains ("mosh://pair"));
    REQUIRE (protocol.authorize ("pair-token", 1000).ok);
    REQUIRE_FALSE (protocol.authorize ("wrong-token", 1000).ok);
    REQUIRE_FALSE (protocol.authorize ("pair-token", 1000 + RemoteCompanionProtocol::pairingTtlMs() + 1).ok);
}

TEST_CASE ("phone take store writes sequenced PCM chunks to a WAV on finish", "[remote][takes]")
{
    auto root = juce::File::getSpecialLocation (juce::File::tempDirectory)
                    .getChildFile ("mosh-remote-take-test");
    root.deleteRecursively();

    RemotePhoneTakeStore store (root);
    auto started = store.startTake ({ "track-1", "Phone Sketch", 44100.0, 1 });
    REQUIRE (started.ok);
    REQUIRE (started.takeId.isNotEmpty());

    REQUIRE (store.appendPcm16Chunk (started.takeId, 0, juce::MemoryBlock ("\x00\x00\x00\x40", 4)).ok);
    REQUIRE_FALSE (store.appendPcm16Chunk (started.takeId, 2, juce::MemoryBlock ("\x00\x00", 2)).ok);
    REQUIRE (store.appendPcm16Chunk (started.takeId, 1, juce::MemoryBlock ("\x00\x80\xff\x7f", 4)).ok);

    auto finished = store.finishTake (started.takeId);
    REQUIRE (finished.ok);
    REQUIRE (finished.file.existsAsFile());
    REQUIRE (finished.trackId == "track-1");
    REQUIRE (finished.name == "Phone Sketch");
    REQUIRE (finished.file.getSize() > 44);
}

TEST_CASE ("remote companion server rejects unauthenticated commands and routes authenticated commands", "[remote][server]")
{
    juce::ScopedJuceInitialiser_GUI juce;

    auto root = juce::File::getSpecialLocation (juce::File::tempDirectory)
                    .getChildFile ("mosh-remote-server-test");
    root.deleteRecursively();

    RemoteCompanionServer server (root);
    int calls = 0;
    juce::String routedCommand;
    juce::String routedAction;
    juce::String routedSource;
    bool routedArgsObject = false;
    server.setCommandHandler ([&] (const juce::var& command) {
        ++calls;
        routedCommand = command.getProperty ("command", {}).toString();
        const auto routedArgs = command.getProperty ("args", {});
        routedArgsObject = routedArgs.isObject();
        routedAction = routedArgs.getProperty ("action", {}).toString();
        routedSource = routedArgs.getProperty ("source", {}).toString();
        auto* result = new juce::DynamicObject();
        result->setProperty ("ok", true);
        result->setProperty ("command", routedCommand);
        return juce::var (result);
    });

    auto pairingResult = startPairingOnFreePort (server);
    REQUIRE ((bool) pairingResult.getProperty ("ok", false));
    auto pairing = pairingResult.getProperty ("data", {}).getProperty ("pairing", {});
    const auto token = pairing.getProperty ("token", {}).toString();
    REQUIRE (token.isNotEmpty());

    auto* commandObject = new juce::DynamicObject();
    juce::var command (commandObject);
    commandObject->setProperty ("command", "set_transport");
    auto* args = new juce::DynamicObject();
    args->setProperty ("action", "record");
    args->setProperty ("source", "phone_controller");
    commandObject->setProperty ("args", juce::var (args));

    auto* unauthBody = new juce::DynamicObject();
    unauthBody->setProperty ("command", command);
    auto unauth = server.handleTestRequest ("POST", "/command", juce::var (unauthBody));
    REQUIRE_FALSE ((bool) unauth.getProperty ("ok", true));
    REQUIRE (calls == 0);

    auto* authedBody = new juce::DynamicObject();
    authedBody->setProperty ("token", token);
    authedBody->setProperty ("command", command);
    auto authed = server.handleTestRequest ("POST", "/command", juce::var (authedBody));
    REQUIRE ((bool) authed.getProperty ("ok", false));
    REQUIRE (calls == 1);
    REQUIRE (routedCommand == "set_transport");
    REQUIRE (routedArgsObject);
    REQUIRE (routedAction == "record");
    REQUIRE (routedSource == "phone_controller");
    server.stopServer();
}

TEST_CASE ("remote companion server accepts standard Base64 phone take chunks", "[remote][takes]")
{
    juce::ScopedJuceInitialiser_GUI juce;

    auto root = juce::File::getSpecialLocation (juce::File::tempDirectory)
                    .getChildFile ("mosh-remote-server-take-test");
    root.deleteRecursively();

    RemoteCompanionServer server (root);
    int importCalls = 0;
    juce::String importedFile;
    server.setCommandHandler ([&] (const juce::var& command) {
        ++importCalls;
        REQUIRE (command.getProperty ("command", {}).toString() == "import_clip");
        const auto args = command.getProperty ("args", {});
        importedFile = args.getProperty ("file", {}).toString();
        REQUIRE (juce::File (importedFile).existsAsFile());
        REQUIRE (args.getProperty ("name", {}).toString() == "Phone Gate");
        auto* result = new juce::DynamicObject();
        result->setProperty ("ok", true);
        result->setProperty ("command", "import_clip");
        return juce::var (result);
    });

    auto pairingResult = startPairingOnFreePort (server);
    REQUIRE ((bool) pairingResult.getProperty ("ok", false));
    const auto token = pairingResult.getProperty ("data", {})
                           .getProperty ("pairing", {})
                           .getProperty ("token", {})
                           .toString();
    REQUIRE (token.isNotEmpty());

    auto* takeStart = new juce::DynamicObject();
    takeStart->setProperty ("token", token);
    takeStart->setProperty ("trackId", "track-1");
    takeStart->setProperty ("name", "Phone Gate");
    takeStart->setProperty ("sampleRate", 44100.0);
    takeStart->setProperty ("channels", 1);
    auto started = server.handleTestRequest ("POST", "/take/start", juce::var (takeStart));
    REQUIRE ((bool) started.getProperty ("ok", false));
    const auto takeId = started.getProperty ("data", {}).getProperty ("takeId", {}).toString();
    REQUIRE (takeId.isNotEmpty());

    auto* chunk0 = new juce::DynamicObject();
    chunk0->setProperty ("token", token);
    chunk0->setProperty ("takeId", takeId);
    chunk0->setProperty ("sequence", 0);
    chunk0->setProperty ("pcm16Base64", "6APoA+gD6APoA+gD6APoAw==");
    auto chunked = server.handleTestRequest ("POST", "/take/chunk", juce::var (chunk0));
    REQUIRE ((bool) chunked.getProperty ("ok", false));

    auto* finish = new juce::DynamicObject();
    finish->setProperty ("token", token);
    finish->setProperty ("takeId", takeId);
    finish->setProperty ("startSeconds", 0.0);
    auto finished = server.handleTestRequest ("POST", "/take/finish", juce::var (finish));
    REQUIRE ((bool) finished.getProperty ("ok", false));
    REQUIRE (importCalls == 1);
    REQUIRE (juce::File (importedFile).existsAsFile());
    REQUIRE (juce::File (importedFile).getSize() > 44);
    server.stopServer();
}

TEST_CASE ("remote health status does not expose pairing secrets", "[remote][server]")
{
    juce::ScopedJuceInitialiser_GUI juce;

    auto root = juce::File::getSpecialLocation (juce::File::tempDirectory)
                    .getChildFile ("mosh-remote-health-test");
    root.deleteRecursively();

    RemoteCompanionServer server (root);
    auto pairingResult = startPairingOnFreePort (server);
    REQUIRE ((bool) pairingResult.getProperty ("ok", false));

    auto health = server.handleTestRequest ("GET", "/health", juce::var());
    REQUIRE ((bool) health.getProperty ("ok", false));
    auto data = health.getProperty ("data", {});
    REQUIRE ((bool) data.getProperty ("running", false));
    REQUIRE (data.getProperty ("pairing", juce::var()).isVoid());
    REQUIRE (juce::JSON::toString (health).contains ("pairingUrl") == false);
    REQUIRE (juce::JSON::toString (health).contains ("token") == false);
    server.stopServer();
}

TEST_CASE ("remote pairing exposes a Safari web companion URL through trusted status only", "[remote][web]")
{
    juce::ScopedJuceInitialiser_GUI juce;

    auto root = juce::File::getSpecialLocation (juce::File::tempDirectory)
                    .getChildFile ("mosh-remote-web-test");
    root.deleteRecursively();

    RemoteCompanionServer server (root);
    auto pairingResult = startPairingOnFreePort (server);
    REQUIRE ((bool) pairingResult.getProperty ("ok", false));

    auto pairing = pairingResult.getProperty ("data", {}).getProperty ("pairing", {});
    const auto token = pairing.getProperty ("token", {}).toString();
    const auto webUrl = pairing.getProperty ("webUrl", {}).toString();
    REQUIRE (token.isNotEmpty());
    REQUIRE (webUrl.startsWith ("http://"));
    REQUIRE (webUrl.contains ("/web?payload="));

    auto health = server.handleTestRequest ("GET", "/health", juce::var());
    REQUIRE ((bool) health.getProperty ("ok", false));
    REQUIRE (juce::JSON::toString (health).contains ("webUrl") == false);
    REQUIRE (juce::JSON::toString (health).contains (token) == false);
    server.stopServer();
}

TEST_CASE ("web companion page is served without exposing a server-side token", "[remote][web]")
{
    juce::ScopedJuceInitialiser_GUI juce;

    auto root = juce::File::getSpecialLocation (juce::File::tempDirectory)
                    .getChildFile ("mosh-remote-web-page-test");
    root.deleteRecursively();

    RemoteCompanionServer server (root);
    auto page = server.handleTestRequest ("GET", "/web", juce::var());
    REQUIRE ((bool) page.getProperty ("ok", false));
    const auto html = page.getProperty ("data", {}).getProperty ("html", {}).toString();
    REQUIRE (html.contains ("MOSH Web Companion"));
    REQUIRE (html.contains ("/snapshot"));
    REQUIRE (html.contains ("/command"));
    REQUIRE (html.contains ("/take/start"));
    REQUIRE (html.contains ("navigator.mediaDevices"));
    REQUIRE_FALSE (html.contains ("pair-token"));
}

TEST_CASE ("companion bind failure surfaces a diagnostic port + errno detail", "[remote][server][bind]")
{
    juce::ScopedJuceInitialiser_GUI juce;

    auto root = juce::File::getSpecialLocation (juce::File::tempDirectory)
                    .getChildFile ("mosh-remote-bind-test");
    root.deleteRecursively();

    // First server binds the port; a second server on the SAME port must fail with a
    // message that names the port (and, on a real errno, the "Address already in use"
    // cause) rather than a bare "could not start" — the observability fix for the
    // PR #267 misdiagnosis, where a silent generic failure looked like a code bug.
    // This case needs a COLLISION, so the shared port is the point — but it still must
    // not be a fixed number, or the first server is the one that fails to bind and the
    // test proves nothing. Let the first server take a free port, then aim the second at
    // whatever it got.
    RemoteCompanionServer first (root);
    int sharedPort = 0;
    auto firstResult = startPairingOnFreePort (first, &sharedPort);
    REQUIRE ((bool) firstResult.getProperty ("ok", false));
    REQUIRE (sharedPort > 0);

    RemoteCompanionServer second (root.getSiblingFile ("mosh-remote-bind-test-2"));
    auto* secondArgs = new juce::DynamicObject();
    secondArgs->setProperty ("port", sharedPort);
    auto secondResult = second.startPairing (juce::var (secondArgs));
    REQUIRE_FALSE ((bool) secondResult.getProperty ("ok", true));
    const auto error = secondResult.getProperty ("error", {}).toString();
    INFO ("bind error: " << error);
    REQUIRE (error.contains (juce::String (sharedPort)));
    // The self-probe re-binds the same port and surfaces the ACCURATE cause (JUCE's
    // createListener has already clobbered errno by this point). "in use" is EADDRINUSE's
    // strerror text on macOS/Linux ("Address already in use").
    REQUIRE (error.containsIgnoreCase ("in use"));

    first.stopServer();
    second.stopServer();
}

TEST_CASE ("monitoring endpoints require auth and persist reports", "[remote][monitor]")
{
    juce::ScopedJuceInitialiser_GUI juce;

    auto root = juce::File::getSpecialLocation (juce::File::tempDirectory)
                    .getChildFile ("mosh-remote-monitor-test");
    root.deleteRecursively();

    RemoteCompanionServer server (root);
    auto pairingResult = startPairingOnFreePort (server);
    REQUIRE ((bool) pairingResult.getProperty ("ok", false));
    auto pairing = pairingResult.getProperty ("data", {}).getProperty ("pairing", {});
    const auto token = pairing.getProperty ("token", {}).toString();
    REQUIRE (token.isNotEmpty());

    auto* unauthBody = new juce::DynamicObject();
    auto unauth = server.handleTestRequest ("POST", "/monitor/start", juce::var (unauthBody));
    REQUIRE_FALSE ((bool) unauth.getProperty ("ok", true));

    auto* authedStart = new juce::DynamicObject();
    authedStart->setProperty ("token", token);
    authedStart->setProperty ("mode", "both");
    auto started = server.handleTestRequest ("POST", "/monitor/start", juce::var (authedStart));
    REQUIRE ((bool) started.getProperty ("ok", false));
    auto startData = started.getProperty ("data", {});
    const auto sessionId = startData.getProperty ("sessionId", {}).toString();
    REQUIRE (sessionId.isNotEmpty());
    REQUIRE ((int) startData.getProperty ("sampleRate", 0) == 48000);

    auto* chunk0 = new juce::DynamicObject();
    chunk0->setProperty ("token", token);
    chunk0->setProperty ("sessionId", sessionId);
    chunk0->setProperty ("sequence", 0);
    auto chunked = server.handleTestRequest ("POST", "/monitor/chunk", juce::var (chunk0));
    REQUIRE ((bool) chunked.getProperty ("ok", false));
    auto chunkData = chunked.getProperty ("data", {});
    REQUIRE ((int) chunkData.getProperty ("sequence", -1) == 0);
    REQUIRE (chunkData.getProperty ("pcm16Base64", {}).toString().isNotEmpty());

    auto* chunk2 = new juce::DynamicObject();
    chunk2->setProperty ("token", token);
    chunk2->setProperty ("sessionId", sessionId);
    chunk2->setProperty ("sequence", 2);
    auto outOfOrder = server.handleTestRequest ("POST", "/monitor/chunk", juce::var (chunk2));
    REQUIRE_FALSE ((bool) outOfOrder.getProperty ("ok", true));

    auto* report = new juce::DynamicObject();
    report->setProperty ("token", token);
    report->setProperty ("sessionId", sessionId);
    report->setProperty ("networkMedianMs", 42.0);
    report->setProperty ("networkP95Ms", 55.0);
    report->setProperty ("networkJitterMs", 4.0);
    report->setProperty ("acousticMedianMs", 118.0);
    report->setProperty ("acousticP95Ms", 140.0);
    report->setProperty ("acousticJitterMs", 11.0);
    auto reported = server.handleTestRequest ("POST", "/monitor/report", juce::var (report));
    REQUIRE ((bool) reported.getProperty ("ok", false));
    const auto reportFile = reported.getProperty ("data", {}).getProperty ("reportFile", {}).toString();
    REQUIRE (juce::File (reportFile).existsAsFile());
    REQUIRE (juce::File (reportFile).loadFileAsString().contains ("networkMedianMs"));
    server.stopServer();
}

TEST_CASE ("owner control is loopback-only and routes only snapshot and MoshOps commands", "[remote][owner]")
{
    juce::ScopedJuceInitialiser_GUI juce;
    const auto root = juce::File::getSpecialLocation (juce::File::tempDirectory)
        .getChildFile ("mosh-owner-control-test");
    RemoteCompanionServer server (root);
    server.setCommandHandler ([] (const juce::var& command) {
        auto* result = new juce::DynamicObject();
        result->setProperty ("ok", command.getProperty ("command", {}).toString() == "set_transport");
        return juce::var (result);
    });

    const auto started = server.startOwnerControl ("owner-token");
    REQUIRE ((bool) started.getProperty ("ok", false));
    REQUIRE (started.getProperty ("data", {}).getProperty ("origin", {}).toString()
        .startsWith ("http://127.0.0.1:"));

    auto* bodyObject = new juce::DynamicObject();
    bodyObject->setProperty ("token", "owner-token");
    auto* command = new juce::DynamicObject();
    command->setProperty ("command", "set_transport");
    command->setProperty ("args", juce::var (new juce::DynamicObject()));
    bodyObject->setProperty ("command", juce::var (command));
    const juce::var body (bodyObject);
    const auto routed = server.handleTestRequest ("POST", "/command", body);
    REQUIRE ((bool) routed.getProperty ("ok", false));
    REQUIRE ((bool) routed.getProperty ("data", {}).getProperty ("ok", false));
    REQUIRE_FALSE ((bool) server.handleTestRequest ("POST", "/events", body)
        .getProperty ("ok", true));
    REQUIRE_FALSE ((bool) server.handleTestRequest ("GET", "/web", body)
        .getProperty ("ok", true));
    server.stopServer();
}
