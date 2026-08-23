#import <AppKit/AppKit.h>

#import "AppDelegate.h"
#include <csignal>

int main (int argc, const char* argv[])
{
    @autoreleasepool
    {
        NSApplication* app = [NSApplication sharedApplication];
        DawnAppDelegate* delegate = [DawnAppDelegate new];
        app.delegate = delegate;
        [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
        std::signal (SIGTERM, SIG_IGN);
        dispatch_source_t termination = dispatch_source_create (DISPATCH_SOURCE_TYPE_SIGNAL,
                                                                 SIGTERM, 0,
                                                                 dispatch_get_main_queue());
        dispatch_source_set_event_handler (termination, ^{ [app terminate:nil]; });
        dispatch_resume (termination);
        [app run];
    }
    return argc > 0 && argv != nullptr ? 0 : 1;
}
