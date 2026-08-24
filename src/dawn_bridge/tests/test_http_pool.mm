#import <Foundation/Foundation.h>

#include <arpa/inet.h>
#include <catch2/catch_test_macros.hpp>
#include <sys/socket.h>
#include <unistd.h>

#include "dawn_bridge/Servers.h"

using namespace mosh::dawn;

namespace
{
std::string exchange (uint16_t port)
{
    int fd = ::socket (AF_INET, SOCK_STREAM, 0);
    sockaddr_in address {};
    address.sin_family = AF_INET;
    address.sin_port = htons (port);
    inet_pton (AF_INET, "127.0.0.1", &address.sin_addr);
    if (::connect (fd, reinterpret_cast<sockaddr*> (&address), sizeof (address)) != 0)
    { ::close (fd); return {}; }
    const std::string request = "GET /web HTTP/1.1\r\n\r\n";
    if (::send (fd, request.data(), request.size(), 0) != static_cast<ssize_t> (request.size()))
    { ::close (fd); return {}; }
    std::string response;
    char buffer[512];
    while (const ssize_t count = ::recv (fd, buffer, sizeof (buffer), 0))
    { if (count < 0) break; response.append (buffer, static_cast<size_t> (count)); }
    ::close (fd);
    return response;
}
}

TEST_CASE ("HTTP uses bounded worker bookkeeping under sequential load", "[dawn][http-pool]")
{
    BridgeCore core (@"token");
    HttpServer server (core, @"page");
    NSError* error = nil;
    REQUIRE (server.start (&error));
    for (int request = 0; request < 96; ++request)
        REQUIRE (exchange (server.port()).find ("200 OK") != std::string::npos);
    REQUIRE (server.workerThreadCount() <= 8);
    server.stop();
    REQUIRE (server.workerThreadCount() == 0);
}
