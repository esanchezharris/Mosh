#pragma once

#import <Foundation/Foundation.h>
#include <functional>

namespace mosh::dawn
{
NSString* defaultDescriptorPath();
NSString* bundledControllerPath (NSString* resourcesPath);
NSString* bundledCompanionPath (NSString* resourcesPath);
NSString* controllerInstallPath (NSString* userLibraryPath);
bool writeDescriptor (NSString* path, uint16_t port, NSString* secret, NSError** error);
bool removeDescriptorIfOwned (NSString* path, uint16_t port, NSString* secret);
struct InstallHooks
{
    std::function<bool (NSString*, NSString*, NSError**)> copy;
    std::function<bool (NSString*, NSString*, NSError**)> move;
};
bool installController (NSString* resourcesPath, NSString* userLibraryPath, NSError** error);
bool installControllerWithHooks (NSString* resourcesPath, NSString* userLibraryPath,
                                 const InstallHooks& hooks, NSError** error);
} // namespace mosh::dawn
