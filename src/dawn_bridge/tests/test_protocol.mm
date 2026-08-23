#import <Foundation/Foundation.h>

#include <catch2/catch_test_macros.hpp>

#include <atomic>
#include <future>
#include <thread>

#include "dawn_bridge/Protocol.h"

using namespace mosh::dawn;

namespace
{
NSData* bytes (NSString* value)
{
    return [value dataUsingEncoding:NSUTF8StringEncoding];
}

NSString* text (const HttpReply& reply)
{
    return [[NSString alloc] initWithData:reply.body encoding:NSUTF8StringEncoding];
}
} // namespace

TEST_CASE ("bridge accepts only exact loopback script peers", "[dawn][protocol]")
{
    REQUIRE (isLoopbackPeer (@"127.0.0.1"));
    REQUIRE_FALSE (isLoopbackPeer (@"192.168.1.9"));
    REQUIRE_FALSE (isLoopbackPeer (@"0.0.0.0"));
}

TEST_CASE ("LAN actions require bearer auth and semantic request fields", "[dawn][protocol]")
{
    BridgeCore core (@"launch-token");
    core.setScriptConnected (true);

    auto unauthorized = core.handleHttp (@"POST", @"/v1/action", @"Bearer wrong",
        bytes (@R"({"requestId":"r1","expectedRevision":0,"action":"put"})"), @"page");
    REQUIRE (unauthorized.status == 401);

    auto raw = core.handleHttp (@"POST", @"/v1/action", @"Bearer launch-token",
        bytes (@R"({"requestId":"r2","expectedRevision":0,"action":"call","method":"undo"})"), @"page");
    REQUIRE (raw.status == 400);
    REQUIRE ([text (raw) containsString:@"unsupported_action"]);

    auto booleanSeek = core.handleHttp (@"POST", @"/v1/action", @"Bearer launch-token",
        bytes (@R"({"requestId":"r3","expectedRevision":0,"action":"seek","positionBeats":true})"), @"page");
    REQUIRE (booleanSeek.status == 400);
}

TEST_CASE ("duplicate action returns the script result without forwarding twice", "[dawn][protocol]")
{
    BridgeCore core (@"launch-token");
    core.setScriptConnected (true);
    REQUIRE (core.ingestScriptLine (bytes (@R"({"protocol":1,"type":"snapshot","state":{"revision":4,"transport":"stopped"}})")));
    int sends = 0;
    core.setActionSender ([&] (const std::string&) {
        ++sends;
        return core.ingestScriptLine (bytes (@R"({"protocol":1,"type":"result","ok":true,"requestId":"same","revision":5,"state":{"revision":5,"transport":"recording"}})"));
    });
    auto body = bytes (@R"({"requestId":"same","expectedRevision":4,"action":"put"})");

    auto first = core.handleHttp (@"POST", @"/v1/action", @"Bearer launch-token", body, @"page");
    auto duplicate = core.handleHttp (@"POST", @"/v1/action", @"Bearer launch-token", body, @"page");

    REQUIRE (first.status == 200);
    REQUIRE (duplicate.status == 200);
    REQUIRE (sends == 1);
    REQUIRE ([text (duplicate) containsString:@"\"revision\":5"]);
}

TEST_CASE ("simultaneous duplicate actions share one in-flight request", "[dawn][protocol]")
{
    BridgeCore core (@"launch-token");
    core.setScriptConnected (true);
    REQUIRE (core.ingestScriptLine (bytes (@R"({"protocol":1,"type":"snapshot","state":{"revision":1}})")));
    std::atomic<int> sends { 0 };
    std::thread responder;
    core.setActionSender ([&] (const std::string&) {
        if (++sends == 1)
            responder = std::thread ([&] {
                std::this_thread::sleep_for (std::chrono::milliseconds (40));
                core.ingestScriptLine (bytes (@R"({"protocol":1,"type":"result","ok":true,"requestId":"tap","revision":2,"state":{"revision":2}})"));
            });
        return true;
    });
    NSData* body = bytes (@R"({"requestId":"tap","expectedRevision":1,"action":"keep"})");

    auto first = std::async (std::launch::async, [&] {
        return core.handleHttp (@"POST", @"/v1/action", @"Bearer launch-token", body, @"page");
    });
    auto second = std::async (std::launch::async, [&] {
        return core.handleHttp (@"POST", @"/v1/action", @"Bearer launch-token", body, @"page");
    });

    REQUIRE (first.get().status == 200);
    REQUIRE (second.get().status == 200);
    responder.join();
    REQUIRE (sends == 1);
}

TEST_CASE ("stale action is rejected locally and disconnect fails closed", "[dawn][protocol]")
{
    BridgeCore core (@"launch-token");
    core.setScriptConnected (true);
    REQUIRE (core.ingestScriptLine (bytes (@R"({"protocol":1,"type":"snapshot","state":{"revision":3}})")));

    auto stale = core.handleHttp (@"POST", @"/v1/action", @"Bearer launch-token",
        bytes (@R"({"requestId":"old","expectedRevision":2,"action":"stop"})"), @"page");
    REQUIRE (stale.status == 409);
    REQUIRE ([text (stale) containsString:@"stale_revision"]);

    core.setScriptConnected (false);
    auto disconnected = core.handleHttp (@"POST", @"/v1/action", @"Bearer launch-token",
        bytes (@R"({"requestId":"new","expectedRevision":3,"action":"stop"})"), @"page");
    REQUIRE (disconnected.status == 503);
    REQUIRE ([text (disconnected) containsString:@"script_disconnected"]);
}

TEST_CASE ("malformed script results cannot advance bridge state", "[dawn][protocol]")
{
    BridgeCore core (@"launch-token");
    REQUIRE_FALSE (core.ingestScriptLine (bytes (@R"({"protocol":1,"type":"result","ok":7,"requestId":"x","revision":2,"state":{"revision":3}})")));
    REQUIRE (core.revision() == 0);
}

TEST_CASE ("HTTP surface is exactly web snapshot and action", "[dawn][protocol]")
{
    BridgeCore core (@"launch-token");
    auto web = core.handleHttp (@"GET", @"/web", @"", [NSData data], @"<html>dawn</html>");
    REQUIRE (web.status == 200);
    REQUIRE ([text (web) isEqualToString:@"<html>dawn</html>"]);

    auto raw = core.handleHttp (@"POST", @"/command", @"Bearer launch-token", [NSData data], @"page");
    REQUIRE (raw.status == 404);
}
