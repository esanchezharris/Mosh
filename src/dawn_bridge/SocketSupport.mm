#import "SocketSupport.h"

#include <arpa/inet.h>
#include <cerrno>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

namespace mosh::dawn::socketSupport
{
int makeListener (uint32_t bindAddress, uint16_t& port, NSError** error)
{
    int fd = ::socket (AF_INET, SOCK_STREAM, 0);
    if (fd < 0)
        return -1;
    int reuse = 1;
    ::setsockopt (fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof (reuse));
    sockaddr_in address {};
    address.sin_family = AF_INET;
    address.sin_port = 0;
    address.sin_addr.s_addr = htonl (bindAddress);
    if (::bind (fd, reinterpret_cast<sockaddr*> (&address), sizeof (address)) != 0
        || ::listen (fd, 8) != 0)
    {
        const int code = errno;
        ::close (fd);
        if (error != nullptr)
            *error = [NSError errorWithDomain:NSPOSIXErrorDomain code:code userInfo:nil];
        return -1;
    }
    socklen_t length = sizeof (address);
    if (::getsockname (fd, reinterpret_cast<sockaddr*> (&address), &length) != 0)
    {
        ::close (fd);
        return -1;
    }
    port = ntohs (address.sin_port);
    return fd;
}

bool sendAll (int fd, const void* data, size_t size)
{
    const auto* bytes = static_cast<const uint8_t*> (data);
    size_t sent = 0;
    while (sent < size)
    {
        const auto count = ::send (fd, bytes + sent, size - sent, MSG_NOSIGNAL);
        if (count <= 0)
            return false;
        sent += static_cast<size_t> (count);
    }
    return true;
}

bool readLine (int fd, std::string& line, size_t limit)
{
    line.clear();
    char value = 0;
    while (line.size() <= limit)
    {
        const auto count = ::recv (fd, &value, 1, 0);
        if (count <= 0)
            return false;
        if (value == '\n')
            return true;
        if (value != '\r')
            line.push_back (value);
    }
    return false;
}

void closeSocket (int& fd)
{
    if (fd < 0)
        return;
    ::shutdown (fd, SHUT_RDWR);
    ::close (fd);
    fd = -1;
}

void setTimeoutSeconds (int fd, int seconds)
{
    timeval timeout { seconds, 0 };
    ::setsockopt (fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof (timeout));
    ::setsockopt (fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof (timeout));
}

NSString* peerAddress (int fd)
{
    sockaddr_in address {};
    socklen_t size = sizeof (address);
    if (::getpeername (fd, reinterpret_cast<sockaddr*> (&address), &size) != 0)
        return nil;
    char text[INET_ADDRSTRLEN] {};
    return inet_ntop (AF_INET, &address.sin_addr, text, sizeof (text)) != nullptr
        ? [NSString stringWithUTF8String:text] : nil;
}
} // namespace mosh::dawn::socketSupport
