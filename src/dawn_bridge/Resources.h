#pragma once

#import <Foundation/Foundation.h>

namespace mosh::dawn
{
NSString* defaultDescriptorPath();
NSString* bundledControllerPath (NSString* resourcesPath);
NSString* bundledCompanionPath (NSString* resourcesPath);
NSString* controllerInstallPath (NSString* userLibraryPath);
bool writeDescriptor (NSString* path, uint16_t port, NSString* secret, NSError** error);
bool installController (NSString* resourcesPath, NSString* userLibraryPath, NSError** error);
} // namespace mosh::dawn
