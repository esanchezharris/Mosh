#import "Resources.h"

#include <fcntl.h>
#include <cstdlib>
#include <sys/stat.h>
#include <unistd.h>

namespace mosh::dawn
{
NSString* defaultDescriptorPath()
{
    const char* overridePath = std::getenv ("MOSH_DAWN_DESCRIPTOR");
    if (overridePath != nullptr && overridePath[0] != '\0')
        return [NSString stringWithUTF8String:overridePath];
    return [NSHomeDirectory() stringByAppendingPathComponent:
        @"Library/Application Support/Mosh/DAWN Bridge/remote-script.json"];
}

NSString* bundledControllerPath (NSString* resourcesPath)
{
    return [resourcesPath stringByAppendingPathComponent:@"MoshDawnController"];
}

NSString* bundledCompanionPath (NSString* resourcesPath)
{
    return [resourcesPath stringByAppendingPathComponent:@"companion/index.html"];
}

NSString* controllerInstallPath (NSString* userLibraryPath)
{
    return [userLibraryPath stringByAppendingPathComponent:@"Remote Scripts/MoshDawnController"];
}

bool writeDescriptor (NSString* path, uint16_t port, NSString* secret, NSError** error)
{
    NSFileManager* files = [NSFileManager defaultManager];
    NSString* parent = [path stringByDeletingLastPathComponent];
    if (![files createDirectoryAtPath:parent withIntermediateDirectories:YES
                           attributes:@{ NSFilePosixPermissions: @0700 } error:error])
        return false;
    NSDictionary* descriptor = @{ @"protocol": @1, @"host": @"127.0.0.1",
        @"port": @(port), @"secret": secret ?: @"" };
    NSData* data = [NSJSONSerialization dataWithJSONObject:descriptor options:0 error:error];
    if (data == nil)
        return false;
    const int fd = ::open (path.fileSystemRepresentation,
                           O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0600);
    if (fd < 0)
    {
        if (error != nullptr)
            *error = [NSError errorWithDomain:NSPOSIXErrorDomain code:errno userInfo:nil];
        return false;
    }
    const ssize_t written = ::write (fd, data.bytes, data.length);
    const bool ok = written == static_cast<ssize_t> (data.length)
        && ::fchmod (fd, 0600) == 0 && ::fsync (fd) == 0;
    const int savedErrno = errno;
    ::close (fd);
    if (!ok && error != nullptr)
        *error = [NSError errorWithDomain:NSPOSIXErrorDomain code:savedErrno userInfo:nil];
    return ok;
}

bool installController (NSString* resourcesPath, NSString* userLibraryPath, NSError** error)
{
    NSFileManager* files = [NSFileManager defaultManager];
    NSString* source = bundledControllerPath (resourcesPath);
    BOOL isDirectory = NO;
    if (![files fileExistsAtPath:source isDirectory:&isDirectory] || !isDirectory)
    {
        if (error != nullptr)
            *error = [NSError errorWithDomain:NSCocoaErrorDomain code:NSFileNoSuchFileError userInfo:nil];
        return false;
    }
    NSString* destination = controllerInstallPath (userLibraryPath);
    NSString* parent = [destination stringByDeletingLastPathComponent];
    if (![files createDirectoryAtPath:parent withIntermediateDirectories:YES attributes:nil error:error])
        return false;
    NSString* staging = [parent stringByAppendingPathComponent:
        [@".MoshDawnController-" stringByAppendingString:NSUUID.UUID.UUIDString]];
    if (![files copyItemAtPath:source toPath:staging error:error])
        return false;
    if ([files fileExistsAtPath:destination] && ![files removeItemAtPath:destination error:error])
    {
        [files removeItemAtPath:staging error:nil];
        return false;
    }
    if (![files moveItemAtPath:staging toPath:destination error:error])
    {
        [files removeItemAtPath:staging error:nil];
        return false;
    }
    return true;
}
} // namespace mosh::dawn
