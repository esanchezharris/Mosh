#import "Resources.h"

#include <fcntl.h>
#include <cstdlib>
#include <cerrno>
#include <cstdio>
#include <limits.h>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

namespace mosh::dawn
{
namespace
{
void setPosixError (NSError** error, int code)
{
    if (error != nullptr)
        *error = [NSError errorWithDomain:NSPOSIXErrorDomain code:code userInfo:nil];
}

bool writeAll (int fd, const void* bytes, size_t length)
{
    const auto* cursor = static_cast<const uint8_t*> (bytes);
    while (length > 0)
    {
        const ssize_t count = ::write (fd, cursor, length);
        if (count < 0 && errno == EINTR)
            continue;
        if (count <= 0)
            return false;
        cursor += count;
        length -= static_cast<size_t> (count);
    }
    return true;
}

bool atomicActivate (NSString* staging, NSString* destination, NSError** error)
{
    struct stat existing {};
    const int status = ::lstat (destination.fileSystemRepresentation, &existing);
    const unsigned int flags = status == 0 ? RENAME_SWAP : RENAME_EXCL;
    if (status != 0 && errno != ENOENT)
    { setPosixError (error, errno); return false; }
    if (::renamex_np (staging.fileSystemRepresentation,
                      destination.fileSystemRepresentation, flags) == 0)
        return true;
    setPosixError (error, errno);
    return false;
}
}

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
    struct stat existing {};
    const int targetStatus = ::lstat (path.fileSystemRepresentation, &existing);
    if (targetStatus == 0 || errno != ENOENT)
    {
        setPosixError (error, targetStatus == 0 ? EEXIST : errno);
        return false;
    }
    NSString* pattern = [parent stringByAppendingPathComponent:@".remote-script.XXXXXX"];
    std::string temporary (pattern.fileSystemRepresentation);
    temporary.push_back ('\0');
    const int fd = ::mkstemp (temporary.data());
    if (fd < 0)
    {
        setPosixError (error, errno);
        return false;
    }
    const bool ok = ::fchmod (fd, 0600) == 0 && writeAll (fd, data.bytes, data.length)
        && ::fsync (fd) == 0;
    const int savedErrno = errno;
    ::close (fd);
    if (!ok || ::renamex_np (temporary.data(), path.fileSystemRepresentation, RENAME_EXCL) != 0)
    {
        const int code = ok ? errno : savedErrno;
        ::unlink (temporary.data());
        setPosixError (error, code);
        return false;
    }
    const int parentFd = ::open (parent.fileSystemRepresentation, O_RDONLY | O_DIRECTORY);
    const bool durable = parentFd >= 0 && ::fsync (parentFd) == 0;
    const int parentError = errno;
    if (parentFd >= 0)
        ::close (parentFd);
    if (!durable)
    {
        ::unlink (path.fileSystemRepresentation);
        setPosixError (error, parentError);
    }
    return durable;
}

bool removeDescriptorIfOwned (NSString* path, uint16_t port, NSString* secret)
{
    struct stat before {};
    if (::lstat (path.fileSystemRepresentation, &before) != 0 || !S_ISREG (before.st_mode)
        || before.st_uid != ::geteuid() || before.st_nlink != 1
        || (before.st_mode & 0777) != 0600)
        return false;
    const int fd = ::open (path.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW);
    struct stat opened {};
    if (fd < 0 || ::fstat (fd, &opened) != 0 || before.st_dev != opened.st_dev
        || before.st_ino != opened.st_ino)
    {
        if (fd >= 0) ::close (fd);
        return false;
    }
    NSMutableData* data = [NSMutableData data];
    uint8_t buffer[1024];
    for (;;)
    {
        const ssize_t count = ::read (fd, buffer, sizeof (buffer));
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) break;
        [data appendBytes:buffer length:static_cast<NSUInteger> (count)];
        if (data.length > 4096) break;
    }
    ::close (fd);
    NSDictionary* value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    const bool match = [value isKindOfClass:[NSDictionary class]] && value.count == 4
        && [value[@"protocol"] isEqual:@1] && [value[@"host"] isEqual:@"127.0.0.1"]
        && [value[@"port"] unsignedIntegerValue] == port && [value[@"secret"] isEqual:secret];
    struct stat current {};
    if (!match || ::lstat (path.fileSystemRepresentation, &current) != 0
        || current.st_dev != before.st_dev || current.st_ino != before.st_ino)
        return false;
    return ::unlink (path.fileSystemRepresentation) == 0;
}

bool installController (NSString* resourcesPath, NSString* userLibraryPath, NSError** error)
{
    NSFileManager* files = [NSFileManager defaultManager];
    InstallHooks hooks {
        [files] (NSString* a, NSString* b, NSError** e) { return [files copyItemAtPath:a toPath:b error:e]; },
        [] (NSString* a, NSString* b, NSError** e) { return atomicActivate (a, b, e); }
    };
    return installControllerWithHooks (resourcesPath, userLibraryPath, hooks, error);
}

bool installControllerWithHooks (NSString* resourcesPath, NSString* userLibraryPath,
                                 const InstallHooks& hooks, NSError** error)
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
    char resolved[PATH_MAX] {};
    struct stat rootDetails {};
    if (::realpath (userLibraryPath.fileSystemRepresentation, resolved) == nullptr
        || ::lstat (userLibraryPath.fileSystemRepresentation, &rootDetails) != 0
        || !S_ISDIR (rootDetails.st_mode) || S_ISLNK (rootDetails.st_mode))
    {
        setPosixError (error, ELOOP);
        return false;
    }
    NSString* destination = controllerInstallPath ([NSString stringWithUTF8String:resolved]);
    NSString* parent = [destination stringByDeletingLastPathComponent];
    struct stat parentDetails {};
    if (::lstat (parent.fileSystemRepresentation, &parentDetails) != 0)
    {
        if (errno != ENOENT || ![files createDirectoryAtPath:parent withIntermediateDirectories:NO
                                                   attributes:nil error:error]) return false;
    }
    else if (!S_ISDIR (parentDetails.st_mode) || S_ISLNK (parentDetails.st_mode))
    { setPosixError (error, ELOOP); return false; }
    struct stat destinationDetails {};
    if (::lstat (destination.fileSystemRepresentation, &destinationDetails) == 0
        && (!S_ISDIR (destinationDetails.st_mode) || S_ISLNK (destinationDetails.st_mode)))
    { setPosixError (error, ELOOP); return false; }
    NSString* staging = [parent stringByAppendingPathComponent:
        [@".MoshDawnController-" stringByAppendingString:NSUUID.UUID.UUIDString]];
    if (!hooks.copy || !hooks.copy (source, staging, error))
    {
        [files removeItemAtPath:staging error:nil];
        return false;
    }
    struct stat staged {}, parentAfter {};
    if (::lstat (staging.fileSystemRepresentation, &staged) != 0
        || ::lstat (parent.fileSystemRepresentation, &parentAfter) != 0
        || !S_ISDIR (staged.st_mode) || S_ISLNK (staged.st_mode)
        || staged.st_dev != parentAfter.st_dev)
    {
        [files removeItemAtPath:staging error:nil];
        setPosixError (error, EINVAL);
        return false;
    }
    if (!hooks.move || !hooks.move (staging, destination, error))
    {
        [files removeItemAtPath:staging error:nil];
        return false;
    }
    [files removeItemAtPath:staging error:nil];
    return true;
}
} // namespace mosh::dawn
