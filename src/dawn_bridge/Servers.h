#pragma once

#import <Foundation/Foundation.h>

#include <memory>

#include "Protocol.h"

namespace mosh::dawn
{
class ScriptServer
{
public:
    ScriptServer (BridgeCore& core, NSString* descriptorPath);
    ~ScriptServer();
    bool start (NSError** error);
    void stop();
    uint16_t port() const;

private:
    class Impl;
    std::unique_ptr<Impl> impl;
};

class HttpServer
{
public:
    HttpServer (BridgeCore& core, NSString* webPage);
    ~HttpServer();
    bool start (NSError** error);
    void stop();
    uint16_t port() const;
    size_t workerThreadCount() const;

private:
    class Impl;
    std::unique_ptr<Impl> impl;
};

NSString* preferredLanAddress();
} // namespace mosh::dawn
