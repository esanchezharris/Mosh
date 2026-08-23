#import "Servers.h"
#import "SocketSupport.h"

#include <algorithm>
#include <atomic>
#include <arpa/inet.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <poll.h>
#include <mutex>
#include <sstream>
#include <thread>
#include <unordered_set>
#include <vector>

namespace mosh::dawn
{
namespace
{
struct Request { NSString* method=@""; NSString* path=@""; NSString* auth=@"";
    size_t length=0; bool oversized=false; };
using Clock = std::chrono::steady_clock;

bool receiveUntil (int fd, std::string& value, size_t limit, Clock::time_point deadline)
{
    char chunk[2048];
    while (value.find ("\r\n\r\n") == std::string::npos && value.size() <= limit)
    {
        const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>
            (deadline - Clock::now()).count();
        if (remaining <= 0) return false;
        pollfd event { fd, POLLIN, 0 };
        if (::poll (&event, 1, static_cast<int> (remaining)) <= 0) return false;
        const ssize_t count = ::recv (fd, chunk, sizeof (chunk), 0);
        if (count <= 0) return false;
        value.append (chunk, static_cast<size_t> (count));
    }
    return value.size() <= limit && value.find ("\r\n\r\n") != std::string::npos;
}

bool parseHeaders (const std::string& raw, Request& request, size_t& bodyOffset)
{
    bodyOffset = raw.find ("\r\n\r\n") + 4;
    std::istringstream input (raw.substr (0, bodyOffset));
    std::string method, path, version, line;
    if (!(input >> method >> path >> version) || version != "HTTP/1.1") return false;
    std::getline (input, line);
    unsigned lengths = 0;
    while (std::getline (input, line) && line != "\r")
    {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        const auto colon = line.find (':');
        if (colon == std::string::npos) return false;
        std::string name=line.substr(0,colon), field=line.substr(colon+1);
        while (!field.empty() && (field.front()==' ' || field.front()=='\t')) field.erase(0,1);
        if (strcasecmp (name.c_str(), "Content-Length") == 0)
        {
            ++lengths;
            if (field.empty() || field.find_first_not_of ("0123456789") != std::string::npos)
                return false;
            try { request.length = std::stoull (field); } catch (...) { return false; }
        }
        else if (strcasecmp (name.c_str(), "Authorization") == 0)
            request.auth = [NSString stringWithUTF8String:field.c_str()];
    }
    request.method=[NSString stringWithUTF8String:method.c_str()];
    request.path=[NSString stringWithUTF8String:path.substr(0,path.find('?')).c_str()];
    if (([request.method isEqual:@"POST"] && lengths != 1) || lengths > 1) return false;
    request.oversized = request.length > maxRequestBodyBytes;
    return true;
}

bool receiveBody (int fd, std::string& raw, size_t offset, size_t length, Clock::time_point deadline)
{
    char chunk[4096];
    while (raw.size() - offset < length)
    {
        const auto remaining=std::chrono::duration_cast<std::chrono::milliseconds>(deadline-Clock::now()).count();
        if (remaining <= 0) return false;
        pollfd event { fd, POLLIN, 0 };
        if (::poll(&event,1,static_cast<int>(remaining)) <= 0) return false;
        const size_t wanted=std::min(sizeof(chunk), length-(raw.size()-offset));
        const ssize_t count=::recv(fd,chunk,wanted,0);
        if (count <= 0) return false;
        raw.append(chunk,static_cast<size_t>(count));
    }
    return true;
}

NSString* statusText (NSInteger s) { switch(s) { case 200:return @"OK"; case 400:return @"Bad Request";
 case 401:return @"Unauthorized"; case 404:return @"Not Found"; case 409:return @"Conflict";
 case 413:return @"Payload Too Large"; case 503:return @"Service Unavailable";
 case 504:return @"Gateway Timeout"; default:return @"Internal Server Error"; } }
void writeReply (int fd,const HttpReply& r) { NSString* h=[NSString stringWithFormat:
 @"HTTP/1.1 %ld %@\r\nContent-Type: %@\r\nContent-Length: %lu\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
 (long)r.status,statusText(r.status),r.contentType,(unsigned long)r.body.length]; NSData* d=[h dataUsingEncoding:NSUTF8StringEncoding];
 socketSupport::sendAll(fd,d.bytes,d.length); socketSupport::sendAll(fd,r.body.bytes,r.body.length); }
bool disconnected (int fd) { char c; return ::recv(fd,&c,1,MSG_PEEK|MSG_DONTWAIT)==0; }
} // namespace

class HttpServer::Impl
{
public:
 Impl(BridgeCore& c,NSString* p):core(c),page([p copy]){}
 bool start(NSError** e) { std::lock_guard lock(mutex); if(running) return false;
   listener=socketSupport::makeListener(INADDR_ANY,boundPort,e); if(listener<0)return false;
   running=true; acceptThread=std::thread([this]{acceptLoop();}); return true; }
 void stop() { { std::lock_guard lock(mutex); if(!running && !acceptThread.joinable())return;
   running=false; socketSupport::closeSocket(listener); for(int fd:clients)::shutdown(fd,SHUT_RDWR); }
   core.cancelPendingWaits(); if(acceptThread.joinable())acceptThread.join();
   for(auto& t:workers)if(t.joinable())t.join(); workers.clear(); }
 void acceptLoop() { while(running) { @autoreleasepool { int listening=-1; {std::lock_guard lock(mutex); listening=listener;}
   int fd=listening>=0?::accept(listening,nullptr,nullptr):-1; if(fd<0)continue;
   std::lock_guard lock(mutex); if(!running){::close(fd);continue;} if(clients.size()>=8){::close(fd);continue;}
   clients.insert(fd); workers.emplace_back([this,fd]{serve(fd);}); }} }
 void serve(int fd) { @autoreleasepool { const auto deadline=Clock::now()+std::chrono::seconds(2);
   std::string raw; Request request; size_t offset=0; HttpReply reply;
   if(!receiveUntil(fd,raw,16*1024,deadline)||!parseHeaders(raw,request,offset)) reply={400,@"application/json",[@"{\"error\":\"malformed_request\"}" dataUsingEncoding:NSUTF8StringEncoding]};
   else if(!([request.method isEqual:@"GET"]&&[request.path isEqual:@"/web"]) && !core.authorize(request.auth))
     reply=core.handleHttp(request.method,request.path,request.auth,nil,page);
   else if(request.oversized) reply=core.handleHttp(request.method,request.path,request.auth,[NSMutableData dataWithLength:maxRequestBodyBytes+1],page);
   else if(!receiveBody(fd,raw,offset,request.length,deadline)) reply={400,@"application/json",[@"{}" dataUsingEncoding:NSUTF8StringEncoding]};
   else { NSData* body=[NSData dataWithBytes:raw.data()+offset length:request.length];
     reply=core.handleHttpCancelable(request.method,request.path,request.auth,body,page,[fd]{return disconnected(fd);}); }
   writeReply(fd,reply); }
   {std::lock_guard lock(mutex); clients.erase(fd);} ::close(fd); }
 BridgeCore& core; NSString* page; std::atomic<bool> running{false}; uint16_t boundPort=0; int listener=-1;
 std::mutex mutex; std::unordered_set<int> clients; std::thread acceptThread; std::vector<std::thread> workers;
};
HttpServer::HttpServer(BridgeCore& c,NSString* p):impl(std::make_unique<Impl>(c,p)){}
HttpServer::~HttpServer(){stop();} bool HttpServer::start(NSError** e){return impl->start(e);}
void HttpServer::stop(){if(impl)impl->stop();} uint16_t HttpServer::port()const{return impl->boundPort;}

NSString* preferredLanAddress() { ifaddrs* list=nullptr; if(::getifaddrs(&list)==0) { for(auto* i=list;i;i=i->ifa_next)
 { if(!i->ifa_addr||i->ifa_addr->sa_family!=AF_INET||(i->ifa_flags&IFF_LOOPBACK)||(i->ifa_flags&IFF_UP)==0)continue;
 char value[INET_ADDRSTRLEN]{}; auto* a=reinterpret_cast<sockaddr_in*>(i->ifa_addr);
 if(inet_ntop(AF_INET,&a->sin_addr,value,sizeof(value))){NSString* r=[NSString stringWithUTF8String:value];::freeifaddrs(list);return r;} }
 ::freeifaddrs(list);} return NSProcessInfo.processInfo.hostName?:@"localhost"; }
} // namespace mosh::dawn
