#pragma once

namespace juce { class WebBrowserComponent; }

namespace mosh
{
/** Install a WKUIDelegate on the WebBrowserComponent's underlying WKWebView that
    auto-grants WebKit media-capture (camera/mic) requests, so getUserMedia works in
    the packaged app. Returns true once installed; false if the WKWebView is not yet
    realized (caller should retry) or on macOS < 12 (graceful no-op). Idempotent.
    macOS only — defined in WebViewCameraPermission.mm, which is compiled under APPLE. */
bool installWebViewCameraPermission (juce::WebBrowserComponent& webView);
}
