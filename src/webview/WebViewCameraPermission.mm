#include "WebViewCameraPermission.h"

#include <juce_gui_extra/juce_gui_extra.h>

#import <WebKit/WebKit.h>
#import <objc/runtime.h>

namespace
{
// Recursively find the first WKWebView under an NSView tree (JUCE embeds the
// WKWebView as a descendant of the component peer's NSView).
WKWebView* findWKWebView (NSView* v)
{
    if ([v isKindOfClass:[WKWebView class]])
        return (WKWebView*) v;
    for (NSView* sub in v.subviews)
        if (WKWebView* found = findWKWebView (sub))
            return found;
    return nil;
}

// Association key so the delegate's lifetime tracks the WKWebView, and install is idempotent.
const void* kMoshUIDelegateKey = &kMoshUIDelegateKey;
}

// Interposing UI delegate: handles ONLY media-capture, forwards everything else to the
// delegate JUCE may have installed (JS dialogs, etc.) so we never break it.
API_AVAILABLE(macos(12.0))
@interface MoshWebViewUIDelegate : NSObject <WKUIDelegate>
@property (nonatomic, weak) id<WKUIDelegate> previous;
@end

@implementation MoshWebViewUIDelegate
- (void)webView:(WKWebView *)webView
    requestMediaCapturePermissionForOrigin:(WKSecurityOrigin *)origin
    initiatedByFrame:(WKFrameInfo *)frame
    type:(WKMediaCaptureType)type
    decisionHandler:(void (^)(WKPermissionDecision))decisionHandler
{
    decisionHandler (type == WKMediaCaptureTypeCamera ? WKPermissionDecisionGrant
                                                       : WKPermissionDecisionDeny);
}
- (BOOL)respondsToSelector:(SEL)aSelector
{
    return [super respondsToSelector:aSelector] || [self.previous respondsToSelector:aSelector];
}
- (id)forwardingTargetForSelector:(SEL)aSelector
{
    return [self.previous respondsToSelector:aSelector] ? self.previous
                                                        : [super forwardingTargetForSelector:aSelector];
}
@end

namespace mosh
{
bool installWebViewCameraPermission (juce::WebBrowserComponent& web)
{
    if (@available (macOS 12.0, *))
    {
        auto* peer = web.getPeer();
        if (peer == nullptr)
            return false;

        NSView* root = (__bridge NSView*) peer->getNativeHandle();
        WKWebView* wk = (root != nil) ? findWKWebView (root) : nil;
        if (wk == nil)
            return false;

        if (objc_getAssociatedObject (wk, kMoshUIDelegateKey) != nil)
            return true; // already installed

        MoshWebViewUIDelegate* d = [MoshWebViewUIDelegate new];
        d.previous = wk.UIDelegate;
        wk.UIDelegate = d;
        objc_setAssociatedObject (wk, kMoshUIDelegateKey, d, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        juce::Logger::writeToLog ("[webview] camera permission delegate installed");
        return true;
    }
    return false; // macOS < 12: graceful no-op, no regression
}
}
