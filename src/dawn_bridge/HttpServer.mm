#import "Servers.h"

#import "SocketSupport.h"

#include <atomic>
#include <arpa/inet.h>
#include <ifaddrs.h>
#include <map>
#include <net/if.h>
#include <netinet/in.h>
#include <sstream>
#include <thread>

namespace mosh::dawn
{
namespace
{
NSString* statusText (NSInteger status)
{
    switch (status)
    {
        case 200: return @"OK";
        case 400: return @"Bad Request";
        case 401: return @"Unauthorized";
        case 404: return @"Not Found";
        case 409: return @"Conflict";
        case 413: return @"Payload Too Large";
        case 503: return @"Service Unavailable";
        case 504: return @"Gateway Timeout";
        default: return @"Internal Server Error";
    }
}

struct Request
{
    NSString* method = @"";
    NSString* path = @"";
    NSString* authorization = @"";
    NSData* body = [NSData data];
    bool oversized = false;
};

bool readRequest (int fd, Request& request)
{
    std::string headers;
    char value = 0;
    while (headers.size() <= 16 * 1024 && headers.find ("\r\n\r\n") == std::string::npos)
    {
        if (::recv (fd, &value, 1, 0) <= 0)
            return false;
        headers.push_back (value);
    }
    if (headers.find ("\r\n\r\n") == std::string::npos)
        return false;
    std::istringstream input (headers);
    std::string method, path, version, line;
    if (!(input >> method >> path >> version))
        return false;
    std::getline (input, line);
    size_t contentLength = 0;
    while (std::getline (input, line) && line != "\r")
    {
        if (!line.empty() && line.back() == '\r')
            line.pop_back();
        const auto colon = line.find (':');
        if (colon == std::string::npos)
            continue;
        std::string name = line.substr (0, colon);
        std::string field = line.substr (colon + 1);
        while (!field.empty() && field.front() == ' ')
            field.erase (field.begin());
        if (strcasecmp (name.c_str(), "Content-Length") == 0)
            contentLength = std::strtoull (field.c_str(), nullptr, 10);
        else if (strcasecmp (name.c_str(), "Authorization") == 0)
            request.authorization = [NSString stringWithUTF8String:field.c_str()];
    }
    request.method = [NSString stringWithUTF8String:method.c_str()];
    const auto query = path.find ('?');
    request.path = [NSString stringWithUTF8String:path.substr (0, query).c_str()];
    if (contentLength > maxRequestBodyBytes)
    {
        request.oversized = true;
        return true;
    }
    NSMutableData* body = [NSMutableData dataWithLength:contentLength];
    size_t received = 0;
    while (received < contentLength)
    {
        const auto count = ::recv (fd, static_cast<uint8_t*> (body.mutableBytes) + received,
                                   contentLength - received, 0);
        if (count <= 0)
            return false;
        received += static_cast<size_t> (count);
    }
    request.body = body;
    return true;
}

void writeReply (int fd, const HttpReply& reply)
{
    NSString* header = [NSString stringWithFormat:
        @"HTTP/1.1 %ld %@\r\nContent-Type: %@\r\nContent-Length: %lu\r\n"
         "Cache-Control: no-store\r\nConnection: close\r\n\r\n",
        (long) reply.status, statusText (reply.status), reply.contentType,
        (unsigned long) reply.body.length];
    NSData* headerBytes = [header dataUsingEncoding:NSUTF8StringEncoding];
    socketSupport::sendAll (fd, headerBytes.bytes, headerBytes.length);
    socketSupport::sendAll (fd, reply.body.bytes, reply.body.length);
}
} // namespace

class HttpServer::Impl
{
public:
    Impl (BridgeCore& bridgeCore, NSString* page) : core (bridgeCore), webPage ([page copy]) {}
    bool start (NSError** error)
    {
        listener = socketSupport::makeListener (INADDR_ANY, boundPort, error);
        if (listener < 0)
            return false;
        running = true;
        worker = std::thread ([this] { run(); });
        return true;
    }
    void stop()
    {
        running = false;
        socketSupport::closeSocket (listener);
        if (worker.joinable())
            worker.join();
    }
    void run()
    {
        while (running)
        {
            int client = ::accept (listener, nullptr, nullptr);
            if (client < 0)
                continue;
            socketSupport::setTimeoutSeconds (client, 2);
            Request request;
            if (readRequest (client, request))
            {
                NSData* body = request.oversized
                    ? [NSMutableData dataWithLength:maxRequestBodyBytes + 1] : request.body;
                HttpReply reply = core.handleHttp (request.method, request.path,
                                                    request.authorization, body, webPage);
                writeReply (client, reply);
            }
            socketSupport::closeSocket (client);
        }
    }
    BridgeCore& core;
    NSString* webPage;
    std::atomic<bool> running { false };
    uint16_t boundPort = 0;
    int listener = -1;
    std::thread worker;
};

HttpServer::HttpServer (BridgeCore& core, NSString* webPage)
    : impl (std::make_unique<Impl> (core, webPage)) {}
HttpServer::~HttpServer() { stop(); }
bool HttpServer::start (NSError** error) { return impl->start (error); }
void HttpServer::stop() { if (impl) impl->stop(); }
uint16_t HttpServer::port() const { return impl->boundPort; }

NSString* preferredLanAddress()
{
    ifaddrs* interfaces = nullptr;
    if (::getifaddrs (&interfaces) == 0)
    {
        for (auto* item = interfaces; item != nullptr; item = item->ifa_next)
        {
            if (item->ifa_addr == nullptr || item->ifa_addr->sa_family != AF_INET
                || (item->ifa_flags & IFF_LOOPBACK) != 0 || (item->ifa_flags & IFF_UP) == 0)
                continue;
            char address[INET_ADDRSTRLEN] {};
            auto* ipv4 = reinterpret_cast<sockaddr_in*> (item->ifa_addr);
            if (inet_ntop (AF_INET, &ipv4->sin_addr, address, sizeof (address)) != nullptr)
            {
                NSString* result = [NSString stringWithUTF8String:address];
                ::freeifaddrs (interfaces);
                return result;
            }
        }
        ::freeifaddrs (interfaces);
    }
    return NSProcessInfo.processInfo.hostName ?: @"localhost";
}
} // namespace mosh::dawn
