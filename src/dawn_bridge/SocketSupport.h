#pragma once

#import <Foundation/Foundation.h>

#include <cstddef>
#include <cstdint>
#include <string>

namespace mosh::dawn::socketSupport
{
int makeListener (uint32_t bindAddress, uint16_t& port, NSError** error);
bool sendAll (int fd, const void* data, size_t size);
bool readLine (int fd, std::string& line, size_t limit);
void closeSocket (int& fd);
void setTimeoutSeconds (int fd, int seconds);
NSString* peerAddress (int fd);
} // namespace mosh::dawn::socketSupport
