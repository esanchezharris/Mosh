#import <Foundation/Foundation.h>

#include <catch2/catch_test_macros.hpp>

#include <atomic>
#include <future>
#include <thread>

#include "dawn_bridge/Protocol.h"

using namespace mosh::dawn;

namespace
{
NSData* json (NSString* value)
{
    return [value dataUsingEncoding:NSUTF8StringEncoding];
}

bool waitFor (const std::atomic<int>& value, int expected)
{
    for (int attempt = 0; attempt < 100; ++attempt)
    {
        if (value == expected)
            return true;
        std::this_thread::sleep_for (std::chrono::milliseconds (5));
    }
    return false;
}
} // namespace

TEST_CASE ("unsolicited script result cannot mutate global snapshot", "[dawn][correlation]")
{
    BridgeCore core (@"token");
    REQUIRE (core.ingestScriptLine (json (@R"({"protocol":1,"type":"snapshot","state":{"revision":2,"transport":"stopped"}})")));

    REQUIRE_FALSE (core.ingestScriptLine (json (@R"({"protocol":1,"type":"result","ok":true,"requestId":"never-forwarded","revision":9,"state":{"revision":9,"transport":"recording"}})")));
    REQUIRE (core.revision() == 2);
}

TEST_CASE ("correlated historical result satisfies waiter without rolling back snapshot", "[dawn][correlation]")
{
    BridgeCore core (@"token");
    core.setScriptConnected (true);
    REQUIRE (core.ingestScriptLine (json (@R"({"protocol":1,"type":"snapshot","state":{"revision":4}})")));
    std::atomic<int> sends { 0 };
    core.setActionSender ([&] (const std::string&) { ++sends; return true; });
    NSData* body = json (@R"({"requestId":"historical","expectedRevision":4,"action":"stop"})");
    auto pending = std::async (std::launch::async, [&] {
        return core.handleHttp (@"POST", @"/v1/action", @"Bearer token", body, @"");
    });
    REQUIRE (waitFor (sends, 1));
    REQUIRE (core.ingestScriptLine (json (@R"({"protocol":1,"type":"snapshot","state":{"revision":6,"transport":"playing"}})")));

    REQUIRE (core.ingestScriptLine (json (@R"({"protocol":1,"type":"result","ok":true,"requestId":"historical","revision":5,"state":{"revision":5,"transport":"stopped"}})")));
    REQUIRE (pending.get().status == 200);
    REQUIRE (core.revision() == 6);
    REQUIRE (core.handleHttp (@"POST", @"/v1/action", @"Bearer token", body, @"").status == 200);
    REQUIRE (sends == 1);
}

TEST_CASE ("bridge restart rejects prior lifecycle result", "[dawn][correlation]")
{
    BridgeCore restarted (@"token");
    REQUIRE_FALSE (restarted.ingestScriptLine (json (@R"({"protocol":1,"type":"result","ok":true,"requestId":"old","revision":1,"state":{"revision":1}})")));
    REQUIRE (restarted.revision() == 0);
}

TEST_CASE ("mismatched result cannot satisfy correlated waiter", "[dawn][correlation]")
{
    BridgeCore core (@"token");
    core.setScriptConnected (true);
    std::atomic<int> sends { 0 };
    core.setActionSender ([&] (const std::string&) { ++sends; return true; });
    NSData* body = json (@R"({"requestId":"wanted","expectedRevision":0,"action":"put"})");
    auto pending = std::async (std::launch::async, [&] {
        return core.handleHttp (@"POST", @"/v1/action", @"Bearer token", body, @"");
    });
    REQUIRE (waitFor (sends, 1));
    REQUIRE_FALSE (core.ingestScriptLine (json (@R"({"protocol":1,"type":"result","ok":true,"requestId":"other","revision":1,"state":{"revision":1}})")));
    core.setScriptConnected (false);
    REQUIRE (pending.get().status == 503);
    REQUIRE (core.revision() == 0);
}

TEST_CASE ("snapshot revisions are monotonic", "[dawn][correlation]")
{
    BridgeCore core (@"token");
    REQUIRE (core.ingestScriptLine (json (@R"({"protocol":1,"type":"snapshot","state":{"revision":5}})")));
    REQUIRE_FALSE (core.ingestScriptLine (json (@R"({"protocol":1,"type":"snapshot","state":{"revision":4}})")));
    REQUIRE (core.revision() == 5);
}
