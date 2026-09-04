#include <catch2/catch_test_macros.hpp>

#include "webview/WebViewCameraPermission.h"

TEST_CASE ("embedded web content receives camera-only capture permission",
           "[webview][privacy]")
{
    using mosh::WebViewMediaCaptureKind;
    using mosh::shouldGrantWebViewMediaCapture;

    CHECK (shouldGrantWebViewMediaCapture (WebViewMediaCaptureKind::camera));
    CHECK_FALSE (shouldGrantWebViewMediaCapture (WebViewMediaCaptureKind::microphone));
    CHECK_FALSE (shouldGrantWebViewMediaCapture (
        WebViewMediaCaptureKind::cameraAndMicrophone));
}
