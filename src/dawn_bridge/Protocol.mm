#import "Protocol.h"
#import "ProtocolJson.h"

#import <Security/Security.h>

#include <condition_variable>
#include <mutex>
#include <unordered_map>

namespace mosh::dawn
{
using namespace protocol;

bool isLoopbackPeer (NSString* address)
{
    return [address isEqualToString:@"127.0.0.1"];
}

NSString* randomSecret()
{
    uint8_t bytes[32] {};
    if (SecRandomCopyBytes (kSecRandomDefault, sizeof (bytes), bytes) != errSecSuccess)
        return nil;
    NSMutableString* secret = [NSMutableString stringWithCapacity:64];
    for (const auto byte : bytes)
        [secret appendFormat:@"%02x", byte];
    return secret;
}

class BridgeCore::Impl
{
public:
    explicit Impl (NSString* value) : token ([value copy]) {}

    std::mutex mutex;
    std::condition_variable changed;
    NSString* token;
    NSDictionary* state = @{};
    NSUInteger currentRevision = 0;
    bool connected = false;
    ActionSender sender;
    std::unordered_map<std::string, NSData*> results;
    std::unordered_map<std::string, NSUInteger> pending;
    uint64_t cancellation = 0;
};

BridgeCore::BridgeCore (NSString* token) : impl (std::make_unique<Impl> (token)) {}
BridgeCore::~BridgeCore() = default;

void BridgeCore::setActionSender (ActionSender sender)
{
    std::lock_guard lock (impl->mutex);
    impl->sender = std::move (sender);
}

void BridgeCore::setScriptConnected (bool connected)
{
    {
        std::lock_guard lock (impl->mutex);
        impl->connected = connected;
        if (!connected)
            impl->pending.clear();
    }
    impl->changed.notify_all();
}

void BridgeCore::cancelPendingWaits()
{
    {
        std::lock_guard lock (impl->mutex);
        ++impl->cancellation;
        impl->pending.clear();
    }
    impl->changed.notify_all();
}

bool BridgeCore::authorize (NSString* authorization) const
{
    NSString* expected = [@"Bearer " stringByAppendingString:impl->token ?: @""];
    return [authorization isEqualToString:expected];
}

bool BridgeCore::ingestScriptLine (NSData* line)
{
    if (line.length == 0 || line.length > maxNdjsonLineBytes)
        return false;
    NSDictionary* object = parseObject (line);
    if (![object[@"protocol"] isEqual:@1] || ![object[@"type"] isKindOfClass:[NSString class]])
        return false;
    NSString* type = object[@"type"];
    NSDictionary* state = object[@"state"];
    if (![state isKindOfClass:[NSDictionary class]] || !isInteger (state[@"revision"])
        || [state[@"revision"] integerValue] < 0)
        return false;

    NSData* cached = nil;
    NSString* requestId = nil;
    if ([type isEqualToString:@"result"])
    {
        requestId = object[@"requestId"];
        if (![requestId isKindOfClass:[NSString class]] || requestId.length == 0
            || !isBoolean (object[@"ok"]) || !isInteger (object[@"revision"])
            || ![object[@"revision"] isEqual:state[@"revision"]]
            || (object[@"error"] != nil && ![object[@"error"] isKindOfClass:[NSString class]])
            || object.count != (object[@"error"] == nil ? 6u : 7u))
            return false;
        NSString* error = [object[@"error"] isKindOfClass:[NSString class]] ? object[@"error"] : nil;
        cached = jsonData (envelope ([object[@"ok"] boolValue], requestId,
                                     [object[@"revision"] unsignedIntegerValue], state, error));
    }
    else if (![type isEqualToString:@"snapshot"] || object.count != 3)
    {
        return false;
    }

    {
        std::lock_guard lock (impl->mutex);
        const NSUInteger messageRevision = [state[@"revision"] unsignedIntegerValue];
        if (cached != nil)
        {
            const auto key = std::string (requestId.UTF8String);
            const auto pending = impl->pending.find (key);
            if (pending == impl->pending.end() || messageRevision < pending->second)
                return false;
            impl->results[key] = cached;
            impl->pending.erase (pending);
        }
        else
        {
            if (messageRevision < impl->currentRevision)
                return false;
            impl->state = [state copy];
            impl->currentRevision = messageRevision;
        }
    }
    impl->changed.notify_all();
    return true;
}

HttpReply BridgeCore::handleHttp (NSString* method, NSString* path,
                                  NSString* authorization, NSData* body, NSString* webPage)
{
    return handleHttpCancelable (method, path, authorization, body, webPage, {});
}

HttpReply BridgeCore::handleHttpCancelable (NSString* method, NSString* path,
                                  NSString* authorization, NSData* body, NSString* webPage,
                                  std::function<bool()> cancelled)
{
    if ([method isEqualToString:@"GET"] && [path isEqualToString:@"/web"])
        return { 200, @"text/html; charset=utf-8", [webPage dataUsingEncoding:NSUTF8StringEncoding] };
    const bool snapshotRoute = [method isEqualToString:@"GET"] && [path isEqualToString:@"/v1/snapshot"];
    const bool actionRoute = [method isEqualToString:@"POST"] && [path isEqualToString:@"/v1/action"];
    if (!snapshotRoute && !actionRoute)
        return jsonReply (404, envelope (false, @"", revision(), @{}, @"not_found"));
    if (!authorize (authorization))
        return jsonReply (401, envelope (false, @"", revision(), @{}, @"unauthorized"));

    if (snapshotRoute)
    {
        std::lock_guard lock (impl->mutex);
        return jsonReply (200, envelope (true, @"", impl->currentRevision, impl->state));
    }
    if (body.length > maxRequestBodyBytes)
        return jsonReply (413, envelope (false, @"", revision(), @{}, @"request_too_large"));
    NSDictionary* request = parseObject (body);
    NSString* requestId = request[@"requestId"];
    id revisionValue = request[@"expectedRevision"];
    if (request == nil || ![requestId isKindOfClass:[NSString class]] || requestId.length == 0
        || requestId.length > 128 || !isInteger (revisionValue) || [revisionValue integerValue] < 0)
        return jsonReply (400, envelope (false, @"", revision(), @{}, @"malformed_request"));
    NSString* actionError = nil;
    if (!validAction (request, &actionError))
        return jsonReply (400, envelope (false, requestId, revision(), @{}, actionError));

    ActionSender sender;
    bool alreadyPending = false;
    const auto key = std::string (requestId.UTF8String);
    {
        std::lock_guard lock (impl->mutex);
        if (auto found = impl->results.find (key); found != impl->results.end())
            return { 200, @"application/json", found->second };
        if ([revisionValue unsignedIntegerValue] != impl->currentRevision)
            return jsonReply (409, envelope (false, requestId, impl->currentRevision,
                                              impl->state, @"stale_revision"));
        if (!impl->connected || !impl->sender)
            return jsonReply (503, envelope (false, requestId, impl->currentRevision,
                                              impl->state, @"script_disconnected"));
        sender = impl->sender;
        alreadyPending = impl->pending.contains (key);
        impl->pending.emplace (key, [revisionValue unsignedIntegerValue]);
    }

    if (!alreadyPending)
    {
        NSMutableDictionary* outbound = [request mutableCopy];
        outbound[@"protocol"] = @1;
        outbound[@"type"] = @"action";
        NSData* serialized = jsonData (outbound);
        std::string line ((const char*) serialized.bytes, serialized.length);
        line.push_back ('\n');
        if (!sender (line))
        {
            std::lock_guard lock (impl->mutex);
            impl->pending.erase (key);
            return jsonReply (503, envelope (false, requestId, impl->currentRevision,
                                              impl->state, @"script_disconnected"));
        }
    }

    std::unique_lock lock (impl->mutex);
    const auto cancellation = impl->cancellation;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds (5);
    while (!impl->results.contains (key) && impl->connected
           && impl->cancellation == cancellation && !(cancelled && cancelled())
           && std::chrono::steady_clock::now() < deadline)
        impl->changed.wait_for (lock, std::chrono::milliseconds (50));
    if (auto found = impl->results.find (key); found != impl->results.end())
        return { 200, @"application/json", found->second };
    impl->pending.erase (key);
    const auto status = impl->connected && impl->cancellation == cancellation
        && !(cancelled && cancelled()) ? 504 : 503;
    return jsonReply (status, envelope (false, requestId, impl->currentRevision, impl->state,
                                        impl->connected ? @"action_timeout" : @"script_disconnected"));
}

NSUInteger BridgeCore::revision() const
{
    std::lock_guard lock (impl->mutex);
    return impl->currentRevision;
}
} // namespace mosh::dawn
