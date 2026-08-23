#import "ProtocolJson.h"
#include <cmath>

namespace mosh::dawn::protocol
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
                        NSDictionary* state, NSString* error)
{
    NSMutableDictionary* value = [@{ @"ok": @(ok), @"requestId": requestId ?: @"",
        @"revision": @(revision), @"state": state ?: @{} } mutableCopy];
    if (error != nil) value[@"error"] = error;
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
    if (data == nil) return nil;
    id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    return [value isKindOfClass:[NSDictionary class]] ? value : nil;
}
bool validAction (NSDictionary* body, NSString** error)
{
    NSSet* common = [NSSet setWithArray:@[ @"requestId", @"expectedRevision", @"action" ]];
    NSString* action = body[@"action"];
    NSSet* actions = [NSSet setWithArray:@[ @"put", @"keep", @"again", @"hear", @"stop", @"seek" ]];
    if (![action isKindOfClass:[NSString class]] || ![actions containsObject:action])
    { *error = @"unsupported_action"; return false; }
    NSMutableSet* allowed = [common mutableCopy];
    if ([action isEqualToString:@"seek"]) [allowed addObject:@"positionBeats"];
    for (NSString* key in body) if (![allowed containsObject:key])
    { *error = @"malformed_request"; return false; }
    id position = body[@"positionBeats"];
    if ([action isEqualToString:@"seek"] && (![position isKindOfClass:[NSNumber class]]
        || isBoolean (position) || !std::isfinite ([position doubleValue])
        || [position doubleValue] < 0.0))
    { *error = @"invalid_position"; return false; }
    return true;
}
}
