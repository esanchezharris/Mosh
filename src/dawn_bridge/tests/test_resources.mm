#import <Foundation/Foundation.h>

#include <catch2/catch_test_macros.hpp>
#include <sys/stat.h>
#include <unistd.h>

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

TEST_CASE ("descriptor cannot replace competing or linked state", "[dawn][resources]")
{
    NSFileManager* files = NSFileManager.defaultManager;
    NSString* root = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
    [files createDirectoryAtPath:root withIntermediateDirectories:YES attributes:nil error:nil];
    NSString* path = [root stringByAppendingPathComponent:@"remote-script.json"];
    [@"competitor" writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil];
    NSError* error = nil;
    REQUIRE_FALSE (writeDescriptor (path, 1, @"ours", &error));
    REQUIRE ([[NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:nil] isEqual:@"competitor"]);
    [files removeItemAtPath:path error:nil];
    NSString* target = [root stringByAppendingPathComponent:@"target"];
    [@"keep" writeToFile:target atomically:YES encoding:NSUTF8StringEncoding error:nil];
    REQUIRE (::symlink (target.fileSystemRepresentation, path.fileSystemRepresentation) == 0);
    REQUIRE_FALSE (writeDescriptor (path, 1, @"ours", &error));
    [files removeItemAtPath:path error:nil];
    REQUIRE (::link (target.fileSystemRepresentation, path.fileSystemRepresentation) == 0);
    REQUIRE_FALSE (writeDescriptor (path, 1, @"ours", &error));
    [files removeItemAtPath:root error:nil];
}

TEST_CASE ("descriptor removal is instance-owned", "[dawn][resources]")
{
    NSString* root = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
    NSString* path = [root stringByAppendingPathComponent:@"remote-script.json"];
    NSError* error = nil;
    REQUIRE (writeDescriptor (path, 4321, @"secret-a", &error));
    REQUIRE_FALSE (removeDescriptorIfOwned (path, 4321, @"secret-b"));
    REQUIRE ([[NSFileManager defaultManager] fileExistsAtPath:path]);
    REQUIRE (removeDescriptorIfOwned (path, 4321, @"secret-a"));
    REQUIRE_FALSE ([[NSFileManager defaultManager] fileExistsAtPath:path]);
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

TEST_CASE ("controller update swaps atomically and preserves AbletonOSC", "[dawn][resources]")
{
    NSFileManager* files=NSFileManager.defaultManager;
    NSString* root=[NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
    NSString* resources=[root stringByAppendingPathComponent:@"Resources"];
    NSString* source=bundledControllerPath(resources), *library=[root stringByAppendingPathComponent:@"User Library"];
    NSString* destination=controllerInstallPath(library), *sentinel=[library stringByAppendingPathComponent:@"Remote Scripts/AbletonOSC/sentinel"];
    [files createDirectoryAtPath:source withIntermediateDirectories:YES attributes:nil error:nil];
    [files createDirectoryAtPath:destination withIntermediateDirectories:YES attributes:nil error:nil];
    [files createDirectoryAtPath:sentinel.stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:nil];
    [@"new" writeToFile:[source stringByAppendingPathComponent:@"version"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
    [@"old" writeToFile:[destination stringByAppendingPathComponent:@"version"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
    [@"keep" writeToFile:sentinel atomically:YES encoding:NSUTF8StringEncoding error:nil];
    NSError* error=nil; REQUIRE(installController(resources,library,&error));
    REQUIRE([[[NSString alloc] initWithContentsOfFile:[destination stringByAppendingPathComponent:@"version"] encoding:NSUTF8StringEncoding error:nil] isEqual:@"new"]);
    REQUIRE([[[NSString alloc] initWithContentsOfFile:sentinel encoding:NSUTF8StringEncoding error:nil] isEqual:@"keep"]);
    [files removeItemAtPath:root error:nil];
}

TEST_CASE ("controller install rejects symlink and rolls back activation failure", "[dawn][resources]")
{
    NSFileManager* files=NSFileManager.defaultManager;
    NSString* root=[NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
    NSString* resources=[root stringByAppendingPathComponent:@"Resources"], *source=bundledControllerPath(resources);
    NSString* library=[root stringByAppendingPathComponent:@"User Library"], *outside=[root stringByAppendingPathComponent:@"outside"];
    [files createDirectoryAtPath:source withIntermediateDirectories:YES attributes:nil error:nil];
    [files createDirectoryAtPath:library withIntermediateDirectories:YES attributes:nil error:nil];
    [files createDirectoryAtPath:outside withIntermediateDirectories:YES attributes:nil error:nil];
    [@"new" writeToFile:[source stringByAppendingPathComponent:@"version"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
    NSString* scripts=[library stringByAppendingPathComponent:@"Remote Scripts"];
    REQUIRE(::symlink(outside.fileSystemRepresentation,scripts.fileSystemRepresentation)==0);
    NSError* error=nil; REQUIRE_FALSE(installController(resources,library,&error));
    [files removeItemAtPath:scripts error:nil];
    NSString* destination=controllerInstallPath(library);
    [files createDirectoryAtPath:destination withIntermediateDirectories:YES attributes:nil error:nil];
    [@"old" writeToFile:[destination stringByAppendingPathComponent:@"version"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
    int moves=0;
    InstallHooks hooks {
      [files](NSString* a,NSString* b,NSError** e){return [files copyItemAtPath:a toPath:b error:e];},
      [files,&moves](NSString* a,NSString* b,NSError** e){ if(++moves==2){if(e)*e=[NSError errorWithDomain:NSPOSIXErrorDomain code:EIO userInfo:nil];return false;} return [files moveItemAtPath:a toPath:b error:e]; }
    };
    REQUIRE_FALSE(installControllerWithHooks(resources,library,hooks,&error));
    REQUIRE([[[NSString alloc] initWithContentsOfFile:[destination stringByAppendingPathComponent:@"version"] encoding:NSUTF8StringEncoding error:nil] isEqual:@"old"]);
    REQUIRE([[files contentsOfDirectoryAtPath:scripts error:nil] count]==1);
    [files removeItemAtPath:root error:nil];
}

TEST_CASE ("controller copy and backup failures leave working install untouched", "[dawn][resources]")
{
    NSFileManager* files=NSFileManager.defaultManager;
    NSString* root=[NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
    NSString* resources=[root stringByAppendingPathComponent:@"Resources"], *source=bundledControllerPath(resources);
    NSString* library=[root stringByAppendingPathComponent:@"User Library"], *destination=controllerInstallPath(library);
    [files createDirectoryAtPath:source withIntermediateDirectories:YES attributes:nil error:nil];
    [files createDirectoryAtPath:destination withIntermediateDirectories:YES attributes:nil error:nil];
    [@"old" writeToFile:[destination stringByAppendingPathComponent:@"version"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
    NSError* error=nil;
    InstallHooks copyFailure { [](NSString*,NSString*,NSError**){return false;}, {} };
    REQUIRE_FALSE(installControllerWithHooks(resources,library,copyFailure,&error));
    InstallHooks moveFailure {
      [files](NSString* a,NSString* b,NSError** e){return [files copyItemAtPath:a toPath:b error:e];},
      [](NSString*,NSString*,NSError**){return false;}
    };
    REQUIRE_FALSE(installControllerWithHooks(resources,library,moveFailure,&error));
    REQUIRE([[[NSString alloc] initWithContentsOfFile:[destination stringByAppendingPathComponent:@"version"] encoding:NSUTF8StringEncoding error:nil] isEqual:@"old"]);
    for(NSString* item in [files contentsOfDirectoryAtPath:destination.stringByDeletingLastPathComponent error:nil])
        REQUIRE_FALSE([item hasPrefix:@".MoshDawnController-"]);
    [files removeItemAtPath:root error:nil];
}

TEST_CASE ("controller activation failure never removes working destination", "[dawn][resources]")
{
    NSFileManager* files=NSFileManager.defaultManager;
    NSString* root=[NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
    NSString* resources=[root stringByAppendingPathComponent:@"Resources"], *source=bundledControllerPath(resources);
    NSString* library=[root stringByAppendingPathComponent:@"User Library"], *destination=controllerInstallPath(library);
    [files createDirectoryAtPath:source withIntermediateDirectories:YES attributes:nil error:nil];
    [files createDirectoryAtPath:destination withIntermediateDirectories:YES attributes:nil error:nil];
    [@"new" writeToFile:[source stringByAppendingPathComponent:@"version"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
    [@"old" writeToFile:[destination stringByAppendingPathComponent:@"version"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
    bool observedMissing=false;
    InstallHooks hooks {
      [files](NSString* a,NSString* b,NSError** e){return [files copyItemAtPath:a toPath:b error:e];},
      [files,destination,&observedMissing](NSString* a,NSString* b,NSError** e){
        if (![files fileExistsAtPath:destination]) observedMissing=true;
        if ([b isEqual:destination]) { if(e)*e=[NSError errorWithDomain:NSPOSIXErrorDomain code:EIO userInfo:nil]; return false; }
        return [files moveItemAtPath:a toPath:b error:e];
      }
    };
    NSError* error=nil;
    REQUIRE_FALSE(installControllerWithHooks(resources,library,hooks,&error));
    REQUIRE_FALSE(observedMissing);
    REQUIRE([files fileExistsAtPath:destination]);
    REQUIRE([[[NSString alloc] initWithContentsOfFile:[destination stringByAppendingPathComponent:@"version"] encoding:NSUTF8StringEncoding error:nil] isEqual:@"old"]);
    [files removeItemAtPath:root error:nil];
}
