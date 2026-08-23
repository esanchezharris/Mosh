#import <Foundation/Foundation.h>

#include <arpa/inet.h>
#include <catch2/catch_test_macros.hpp>
#include <future>
#include <sys/socket.h>
#include <unistd.h>

#include "dawn_bridge/Resources.h"
#include "dawn_bridge/Servers.h"

using namespace mosh::dawn;

namespace
{
int connectTo (uint16_t port)
{
    int fd = ::socket (AF_INET, SOCK_STREAM, 0);
    sockaddr_in address {};
    address.sin_family = AF_INET;
    address.sin_port = htons (port);
    inet_pton (AF_INET, "127.0.0.1", &address.sin_addr);
    if (::connect (fd, reinterpret_cast<sockaddr*> (&address), sizeof (address)) != 0)
    {
        ::close (fd);
        return -1;
    }
    return fd;
}

std::string exchange (uint16_t port, const std::string& request)
{
    int fd = connectTo (port);
    REQUIRE (fd >= 0);
    REQUIRE (::send (fd, request.data(), request.size(), 0) == static_cast<ssize_t> (request.size()));
    ::shutdown (fd, SHUT_WR);
    std::string response;
    char buffer[4096];
    while (const auto count = ::recv (fd, buffer, sizeof (buffer), 0))
    {
        if (count < 0)
            break;
        response.append (buffer, static_cast<size_t> (count));
    }
    ::close (fd);
    return response;
}

bool waitForRevision (BridgeCore& core, NSUInteger value)
{
    for (int attempt = 0; attempt < 100; ++attempt)
    {
        if (core.revision() == value)
            return true;
        usleep (10'000);
    }
    return false;
}

std::string receiveLine (int fd)
{
    std::string line;
    char value = 0;
    while (::recv (fd, &value, 1, 0) == 1 && value != '\n')
        line.push_back (value);
    return line;
}
} // namespace

TEST_CASE ("script server requires authenticated hello before snapshots", "[dawn][server]")
{
    NSString* root = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
    NSString* descriptor = [root stringByAppendingPathComponent:@"remote-script.json"];
    BridgeCore core (@"http-token");
    ScriptServer server (core, descriptor);
    NSError* error = nil;
    REQUIRE (server.start (&error));

    int unauthenticated = connectTo (server.port());
    REQUIRE (unauthenticated >= 0);
    const std::string snapshot = R"({"protocol":1,"type":"snapshot","state":{"revision":7}})" "\n";
    REQUIRE (::send (unauthenticated, snapshot.data(), snapshot.size(), 0)
             == static_cast<ssize_t> (snapshot.size()));
    ::close (unauthenticated);
    usleep (30'000);
    REQUIRE (core.revision() == 0);

    NSDictionary* config = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:descriptor]
                                                            options:0 error:&error];
    NSString* hello = [NSString stringWithFormat:
        @"{\"protocol\":1,\"type\":\"hello\",\"secret\":\"%@\"}\n", config[@"secret"]];
    int authenticated = connectTo (server.port());
    REQUIRE (authenticated >= 0);
    NSData* helloBytes = [hello dataUsingEncoding:NSUTF8StringEncoding];
    REQUIRE (::send (authenticated, helloBytes.bytes, helloBytes.length, 0)
             == static_cast<ssize_t> (helloBytes.length));
    REQUIRE (::send (authenticated, snapshot.data(), snapshot.size(), 0)
             == static_cast<ssize_t> (snapshot.size()));
    REQUIRE (waitForRevision (core, 7));
    ::close (authenticated);
    server.stop();
    REQUIRE_FALSE ([[NSFileManager defaultManager] fileExistsAtPath:descriptor]);
    [[NSFileManager defaultManager] removeItemAtPath:root error:nil];
}

TEST_CASE ("HTTP semantic action crosses authenticated script channel", "[dawn][server]")
{
    NSString* root = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
    NSString* descriptor = [root stringByAppendingPathComponent:@"remote-script.json"];
    BridgeCore core (@"launch-token");
    ScriptServer server (core, descriptor);
    NSError* error = nil;
    REQUIRE (server.start (&error));
    NSDictionary* config = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:descriptor]
                                                            options:0 error:&error];
    int script = connectTo (server.port());
    REQUIRE (script >= 0);
    NSString* handshake = [NSString stringWithFormat:
        @"{\"protocol\":1,\"type\":\"hello\",\"secret\":\"%@\"}\n"
         "{\"protocol\":1,\"type\":\"snapshot\",\"state\":{\"revision\":9}}\n",
        config[@"secret"]];
    NSData* handshakeBytes = [handshake dataUsingEncoding:NSUTF8StringEncoding];
    REQUIRE (::send (script, handshakeBytes.bytes, handshakeBytes.length, 0)
             == static_cast<ssize_t> (handshakeBytes.length));
    REQUIRE (waitForRevision (core, 9));
    NSData* body = [@R"({"requestId":"net","expectedRevision":9,"action":"stop"})"
        dataUsingEncoding:NSUTF8StringEncoding];
    auto result = std::async (std::launch::async, [&] {
        return core.handleHttp (@"POST", @"/v1/action", @"Bearer launch-token", body, @"page");
    });

    const auto actionLine = receiveLine (script);
    NSString* actionText = [NSString stringWithUTF8String:actionLine.c_str()];
    REQUIRE ([actionText containsString:@"\"action\":\"stop\""]);
    REQUIRE_FALSE ([actionText containsString:@"method"]);
    const std::string response = R"({"protocol":1,"type":"result","ok":true,"requestId":"net","revision":10,"state":{"revision":10}})" "\n";
    REQUIRE (::send (script, response.data(), response.size(), 0)
             == static_cast<ssize_t> (response.size()));
    REQUIRE (result.get().status == 200);
    ::close (script);
    server.stop();
    [[NSFileManager defaultManager] removeItemAtPath:root error:nil];
}

TEST_CASE ("HTTP server exposes only bounded authenticated routes", "[dawn][server]")
{
    BridgeCore core (@"launch-token");
    REQUIRE (core.ingestScriptLine ([[NSString stringWithUTF8String:
        R"({"protocol":1,"type":"snapshot","state":{"revision":2}})"] dataUsingEncoding:NSUTF8StringEncoding]));
    HttpServer server (core, @"<html>DAWN</html>");
    NSError* error = nil;
    REQUIRE (server.start (&error));

    const auto web = exchange (server.port(), "GET /web HTTP/1.1\r\nHost: phone\r\n\r\n");
    REQUIRE (web.find ("200 OK") != std::string::npos);
    REQUIRE (web.find ("<html>DAWN</html>") != std::string::npos);
    const auto denied = exchange (server.port(), "GET /v1/snapshot HTTP/1.1\r\nHost: phone\r\n\r\n");
    REQUIRE (denied.find ("401 Unauthorized") != std::string::npos);
    const auto snapshot = exchange (server.port(),
        "GET /v1/snapshot HTTP/1.1\r\nHost: phone\r\nAuthorization: Bearer launch-token\r\n\r\n");
    REQUIRE (snapshot.find ("200 OK") != std::string::npos);
    REQUIRE (snapshot.find ("\"revision\":2") != std::string::npos);
    const auto hidden = exchange (server.port(),
        "POST /command HTTP/1.1\r\nHost: phone\r\nContent-Length: 0\r\n\r\n");
    REQUIRE (hidden.find ("404 Not Found") != std::string::npos);
    const auto oversized = exchange (server.port(),
        "POST /v1/action HTTP/1.1\r\nHost: phone\r\nAuthorization: Bearer launch-token\r\nContent-Length: 65537\r\n\r\n");
    REQUIRE (oversized.find ("413 Payload Too Large") != std::string::npos);
    server.stop();
}
