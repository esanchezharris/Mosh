#import <Foundation/Foundation.h>

#include <catch2/catch_test_macros.hpp>
#include <sys/stat.h>

#include "dawn_bridge/Resources.h"

using namespace mosh::dawn;

TEST_CASE ("descriptor is exact owner-only loopback contract", "[dawn][resources]")
{
    NSString* root = [NSTemporaryDirectory() stringByAppendingPathComponent:[[NSUUID UUID] UUIDString]];
    NSString* path = [root stringByAppendingPathComponent:@"remote-script.json"];
    NSError* error = nil;

    REQUIRE (writeDescriptor (path, 4567, @"0123456789abcdef0123456789abcdef", &error));
    struct stat details {};
    REQUIRE (::stat ([path fileSystemRepresentation], &details) == 0);
    REQUIRE ((details.st_mode & 0777) == 0600);
    NSDictionary* json = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:path]
                                                          options:0 error:&error];
    REQUIRE ([json[@"protocol"] integerValue] == 1);
    REQUIRE ([json[@"host"] isEqualToString:@"127.0.0.1"]);
    REQUIRE ([json[@"port"] integerValue] == 4567);
    REQUIRE ([json[@"secret"] length] >= 32);
    [[NSFileManager defaultManager] removeItemAtPath:root error:nil];
}

TEST_CASE ("controller install changes only its temporary destination", "[dawn][resources]")
{
    NSFileManager* files = [NSFileManager defaultManager];
    NSString* root = [NSTemporaryDirectory() stringByAppendingPathComponent:[[NSUUID UUID] UUIDString]];
    NSString* resources = [root stringByAppendingPathComponent:@"Resources"];
    NSString* source = bundledControllerPath (resources);
    NSString* library = [root stringByAppendingPathComponent:@"User Library"];
    NSString* unrelated = [library stringByAppendingPathComponent:@"Remote Scripts/AbletonOSC/sentinel"];
    [files createDirectoryAtPath:source withIntermediateDirectories:YES attributes:nil error:nil];
    [files createDirectoryAtPath:[unrelated stringByDeletingLastPathComponent]
     withIntermediateDirectories:YES attributes:nil error:nil];
    [@"new" writeToFile:[source stringByAppendingPathComponent:@"__init__.py"]
             atomically:YES encoding:NSUTF8StringEncoding error:nil];
    [@"keep" writeToFile:unrelated atomically:YES encoding:NSUTF8StringEncoding error:nil];
    NSError* error = nil;

    REQUIRE (installController (resources, library, &error));
    REQUIRE ([[NSString stringWithContentsOfFile:unrelated encoding:NSUTF8StringEncoding error:nil]
              isEqualToString:@"keep"]);
    REQUIRE ([files fileExistsAtPath:[controllerInstallPath (library)
                                      stringByAppendingPathComponent:@"__init__.py"]]);
    [files removeItemAtPath:root error:nil];
}
