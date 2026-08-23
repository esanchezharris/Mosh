#import <AppKit/AppKit.h>

#import "AppDelegate.h"

int main (int argc, const char* argv[])
{
    @autoreleasepool
    {
        NSApplication* app = [NSApplication sharedApplication];
        DawnAppDelegate* delegate = [DawnAppDelegate new];
        app.delegate = delegate;
        [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
        [app run];
    }
    return argc > 0 && argv != nullptr ? 0 : 1;
}
