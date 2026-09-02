#pragma once

namespace juce { class WebBrowserComponent; }

namespace mosh
{
enum class WebViewMediaCaptureKind
{
    camera,
    microphone,
    cameraAndMicrophone
};

constexpr bool shouldGrantWebViewMediaCapture (WebViewMediaCaptureKind kind)
{
    return kind == WebViewMediaCaptureKind::camera;
}

/** Install a WKUIDelegate on the WebBrowserComponent's underlying WKWebView that
    grants camera-only capture and rejects microphone capture. Returns true once
    installed; false if the WKWebView is not yet
    realized (caller should retry) or on macOS < 12 (graceful no-op). Idempotent.
    macOS only — defined in WebViewCameraPermission.mm, which is compiled under APPLE. */
bool installWebViewCameraPermission (juce::WebBrowserComponent& webView);
}
