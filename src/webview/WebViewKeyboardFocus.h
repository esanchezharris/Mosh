#pragma once

namespace juce { class WebBrowserComponent; }

namespace mosh
{
/** Make the WebBrowserComponent's underlying WKWebView the NSWindow's first
    responder, so key events actually reach the DOM in the packaged app. The only
    handoff JUCE 8 offers (focusGainedWithDirection → makeFirstResponder) requires
    JUCE keyboard focus on the component, which nothing grants — this installs it
    directly, once the WKWebView is realized inside a window.

    Returns true once the WKWebView is first responder (or already was); false when
    it is not yet realized / not yet in a window — the caller should retry (same
    retry discipline as installWebViewCameraPermission). Idempotent.
    macOS only — defined in WebViewKeyboardFocus.mm, compiled under APPLE. */
bool installWebViewKeyboardFocus (juce::WebBrowserComponent& webView);
}
