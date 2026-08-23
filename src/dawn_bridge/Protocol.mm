#import "Protocol.h"

#import <Security/Security.h>

#include <cmath>
#include <condition_variable>
#include <mutex>
#include <unordered_map>
#include <unordered_set>

namespace mosh::dawn
{
namespace
{
NSData* jsonData (NSDictionary* object)
{
    return [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
}

HttpReply jsonReply (NSInteger status, NSDictionary* object)
{
    return { status, @"application/json", jsonData (object) };
}

NSDictionary* envelope (bool ok, NSString* requestId, NSUInteger revision,
                        NSDictionary* state, NSString* error = nil)
{
    NSMutableDictionary* value = [@{ @"ok": @(ok), @"requestId": requestId ?: @"",
        @"revision": @(revision), @"state": state ?: @{} } mutableCopy];
    if (error != nil)
        value[@"error"] = error;
    return value;
}

bool isInteger (id value)
{
    return [value isKindOfClass:[NSNumber class]]
        && CFGetTypeID ((__bridge CFTypeRef) value) != CFBooleanGetTypeID()
        && std::floor ([value doubleValue]) == [value doubleValue];
}

bool isBoolean (id value)
{
    return value != nil && CFGetTypeID ((__bridge CFTypeRef) value) == CFBooleanGetTypeID();
}

NSDictionary* parseObject (NSData* data)
{
    if (data == nil)
        return nil;
    id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    return [value isKindOfClass:[NSDictionary class]] ? value : nil;
}

bool validAction (NSDictionary* body, NSString** error)
{
    NSSet* common = [NSSet setWithArray:@[ @"requestId", @"expectedRevision", @"action" ]];
    NSString* action = body[@"action"];
    NSSet* actions = [NSSet setWithArray:@[ @"put", @"keep", @"again", @"hear", @"stop", @"seek" ]];
    if (![action isKindOfClass:[NSString class]] || ![actions containsObject:action])
    {
        *error = @"unsupported_action";
        return false;
    }
    NSMutableSet* allowed = [common mutableCopy];
    if ([action isEqualToString:@"seek"])
        [allowed addObject:@"positionBeats"];
    for (NSString* key in body)
        if (![allowed containsObject:key])
        {
            *error = @"malformed_request";
            return false;
        }
    id position = body[@"positionBeats"];
    if ([action isEqualToString:@"seek"]
        && (![position isKindOfClass:[NSNumber class]] || isBoolean (position)
            || !std::isfinite ([position doubleValue])
            || [position doubleValue] < 0.0))
    {
        *error = @"invalid_position";
        return false;
    }
    return true;
}
} // namespace

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
    std::unordered_set<std::string> pending;
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
        impl->state = [state copy];
        impl->currentRevision = [state[@"revision"] unsignedIntegerValue];
        if (cached != nil)
        {
            impl->results[requestId.UTF8String] = cached;
            impl->pending.erase (requestId.UTF8String);
        }
    }
    impl->changed.notify_all();
    return true;
}

HttpReply BridgeCore::handleHttp (NSString* method, NSString* path,
                                  NSString* authorization, NSData* body, NSString* webPage)
{
    if ([method isEqualToString:@"GET"] && [path isEqualToString:@"/web"])
        return { 200, @"text/html; charset=utf-8", [webPage dataUsingEncoding:NSUTF8StringEncoding] };
    const bool snapshotRoute = [method isEqualToString:@"GET"] && [path isEqualToString:@"/v1/snapshot"];
    const bool actionRoute = [method isEqualToString:@"POST"] && [path isEqualToString:@"/v1/action"];
    if (!snapshotRoute && !actionRoute)
        return jsonReply (404, envelope (false, @"", revision(), @{}, @"not_found"));
    NSString* expectedAuth = [@"Bearer " stringByAppendingString:impl->token ?: @""];
    if (![authorization isEqualToString:expectedAuth])
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
        impl->pending.insert (key);
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
    impl->changed.wait_for (lock, std::chrono::seconds (5), [&] {
        return impl->results.contains (key) || !impl->connected;
    });
    if (auto found = impl->results.find (key); found != impl->results.end())
        return { 200, @"application/json", found->second };
    impl->pending.erase (key);
    const auto status = impl->connected ? 504 : 503;
    return jsonReply (status, envelope (false, requestId, impl->currentRevision, impl->state,
                                        impl->connected ? @"action_timeout" : @"script_disconnected"));
}

NSUInteger BridgeCore::revision() const
{
    std::lock_guard lock (impl->mutex);
    return impl->currentRevision;
}
} // namespace mosh::dawn
