#import "Servers.h"

#import "Resources.h"
#import "SocketSupport.h"

#include <atomic>
#include <mutex>
#include <netinet/in.h>
#include <thread>
#include <unistd.h>

namespace mosh::dawn
{
namespace
{
bool validHello (const std::string& line, NSString* secret)
{
    NSData* data = [NSData dataWithBytes:line.data() length:line.size()];
    id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![value isKindOfClass:[NSDictionary class]])
        return false;
    NSDictionary* object = value;
    return [object[@"protocol"] isEqual:@1] && [object[@"type"] isEqual:@"hello"]
        && [object[@"secret"] isEqual:secret] && object.count == 3;
}
} // namespace

class ScriptServer::Impl
{
public:
    Impl (BridgeCore& bridgeCore, NSString* path)
        : core (bridgeCore), descriptorPath ([path copy]) {}

    bool start (NSError** error)
    {
        secret = randomSecret();
        if (secret == nil)
            return false;
        listener = socketSupport::makeListener (INADDR_LOOPBACK, boundPort, error);
        if (listener < 0 || !writeDescriptor (descriptorPath, boundPort, secret, error))
        {
            socketSupport::closeSocket (listener);
            return false;
        }
        running = true;
        core.setActionSender ([this] (const std::string& line) { return sendAction (line); });
        worker = std::thread ([this] { run(); });
        return true;
    }

    void stop()
    {
        running = false;
        {
            std::lock_guard lock (clientMutex);
            socketSupport::closeSocket (client);
        }
        socketSupport::closeSocket (listener);
        if (worker.joinable())
            worker.join();
        core.setScriptConnected (false);
        [[NSFileManager defaultManager] removeItemAtPath:descriptorPath error:nil];
    }

    void run()
    {
        while (running)
        {
            int accepted = ::accept (listener, nullptr, nullptr);
            if (accepted < 0)
                continue;
            socketSupport::setTimeoutSeconds (accepted, 2);
            if (!isLoopbackPeer (socketSupport::peerAddress (accepted)))
            {
                socketSupport::closeSocket (accepted);
                continue;
            }
            {
                std::lock_guard lock (clientMutex);
                socketSupport::closeSocket (client);
                client = accepted;
            }
            std::string line;
            if (!socketSupport::readLine (accepted, line, maxNdjsonLineBytes)
                || !validHello (line, secret))
            {
                std::lock_guard lock (clientMutex);
                if (client == accepted)
                    socketSupport::closeSocket (client);
                continue;
            }
            core.setScriptConnected (true);
            while (running && socketSupport::readLine (accepted, line, maxNdjsonLineBytes))
            {
                NSData* data = [NSData dataWithBytes:line.data() length:line.size()];
                if (!core.ingestScriptLine (data))
                    break;
            }
            {
                std::lock_guard lock (clientMutex);
                if (client == accepted)
                    socketSupport::closeSocket (client);
            }
            core.setScriptConnected (false);
        }
    }

    bool sendAction (const std::string& line)
    {
        std::lock_guard lock (clientMutex);
        return client >= 0 && socketSupport::sendAll (client, line.data(), line.size());
    }

    BridgeCore& core;
    NSString* descriptorPath;
    NSString* secret = nil;
    std::atomic<bool> running { false };
    uint16_t boundPort = 0;
    int listener = -1;
    int client = -1;
    std::mutex clientMutex;
    std::thread worker;
};

ScriptServer::ScriptServer (BridgeCore& core, NSString* path)
    : impl (std::make_unique<Impl> (core, path)) {}
ScriptServer::~ScriptServer() { stop(); }
bool ScriptServer::start (NSError** error) { return impl->start (error); }
void ScriptServer::stop() { if (impl) impl->stop(); }
uint16_t ScriptServer::port() const { return impl->boundPort; }
} // namespace mosh::dawn
