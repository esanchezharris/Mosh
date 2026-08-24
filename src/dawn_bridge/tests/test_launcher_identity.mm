#import <Foundation/Foundation.h>
#include <catch2/catch_test_macros.hpp>
#include <cstdlib>
#include "dawn_bridge/Servers.h"

using namespace mosh::dawn;

TEST_CASE ("launcher-provided secret identifies exact bridge session", "[dawn][launcher]")
{
    NSString* root=[NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
    NSString* descriptor=[root stringByAppendingPathComponent:@"remote-script.json"];
    const char* expected="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const bool environmentSet=::setenv("MOSH_DAWN_SECRET",expected,1)==0;
    BridgeCore core(@"token"); ScriptServer server(core,descriptor); NSError* error=nil;
    const bool started=environmentSet&&server.start(&error);
    NSDictionary* value=started?[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:descriptor]
                                                                  options:0 error:&error]:nil;
    const bool matched=[value[@"secret"] isEqual:@(expected)];
    server.stop(); ::unsetenv("MOSH_DAWN_SECRET");
    [[NSFileManager defaultManager] removeItemAtPath:root error:nil];
    REQUIRE(environmentSet); REQUIRE(started); REQUIRE(matched);
}
