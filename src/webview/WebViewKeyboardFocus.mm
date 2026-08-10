#include "WebViewKeyboardFocus.h"

#include <juce_gui_extra/juce_gui_extra.h>

#import <WebKit/WebKit.h>

namespace
{
// Recursively find the first WKWebView under an NSView tree (JUCE embeds the
// WKWebView as a descendant of the component peer's NSView). Same tiny helper as
// WebViewCameraPermission.mm — kept per-file so either .mm can change without
// touching the other.
WKWebView* findWKWebView (NSView* v)
{
    if ([v isKindOfClass:[WKWebView class]])
        return (WKWebView*) v;
    for (NSView* sub in v.subviews)
        if (WKWebView* found = findWKWebView (sub))
            return found;
    return nil;
}
}

namespace mosh
{
bool installWebViewKeyboardFocus (juce::WebBrowserComponent& web)
{
    auto* peer = web.getPeer();
    if (peer == nullptr)
        return false;

    NSView* root = (__bridge NSView*) peer->getNativeHandle();
    WKWebView* wk = (root != nil) ? findWKWebView (root) : nil;
    if (wk == nil || wk.window == nil)
        return false;

    if (wk.window.firstResponder == wk)
        return true; // already first responder — done (and idempotent)

    // mustBeFirstResponder guards "window not key / app not active" — in those
    // states AppKit's makeFirstResponder silently no-ops, so the caller's retry
    // timer keeps this cheap and correct instead of adding a windowDidBecomeKey
    // observer (deliberately not built: one retry loop covers both cases).
    if (! [wk.window makeFirstResponder: wk])
        return false;

    if (wk.window.firstResponder != wk)
        return false;

    juce::Logger::writeToLog ("[webview] WKWebView made first responder (keyboard input enabled)");
    return true;
}
}
