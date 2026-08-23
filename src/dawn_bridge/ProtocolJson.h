#pragma once
#import <Foundation/Foundation.h>
#include "Protocol.h"

namespace mosh::dawn::protocol
{
NSData* jsonData (NSDictionary* object);
HttpReply jsonReply (NSInteger status, NSDictionary* object);
NSDictionary* envelope (bool ok, NSString* requestId, NSUInteger revision,
                        NSDictionary* state, NSString* error = nil);
bool isInteger (id value);
bool isBoolean (id value);
NSDictionary* parseObject (NSData* data);
bool validAction (NSDictionary* body, NSString** error);
}
