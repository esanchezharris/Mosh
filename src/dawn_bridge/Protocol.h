#pragma once

#import <Foundation/Foundation.h>

#include <functional>
#include <memory>
#include <string>

namespace mosh::dawn
{
constexpr NSUInteger maxRequestBodyBytes = 64 * 1024;
constexpr NSUInteger maxNdjsonLineBytes = 64 * 1024;

struct HttpReply
{
    NSInteger status = 500;
    NSString* contentType = @"application/json";
    NSData* body = nil;
};

bool isLoopbackPeer (NSString* address);
NSString* randomSecret();

class BridgeCore
{
public:
    using ActionSender = std::function<bool (const std::string&)>;

    explicit BridgeCore (NSString* bearerToken);
    ~BridgeCore();

    void setActionSender (ActionSender sender);
    void setScriptConnected (bool connected);
    bool ingestScriptLine (NSData* line);
    HttpReply handleHttp (NSString* method, NSString* path,
                          NSString* authorization, NSData* body,
                          NSString* webPage);
    NSUInteger revision() const;

private:
    class Impl;
    std::unique_ptr<Impl> impl;
};
} // namespace mosh::dawn
