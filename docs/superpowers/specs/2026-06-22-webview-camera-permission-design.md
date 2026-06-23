# WKWebView Camera Permission Delegate + Two-Machine Video Runbook — Design

**Date:** 2026-06-22
**Branch:** off `main` (fresh branch, e.g. `claude/webview-camera-permission`)
**Scope:** Make collaborator-video `getUserMedia` actually work in the packaged macOS
app by installing a `WKUIDelegate` that answers WebKit's media-capture permission
request, and document a two-machine test runbook. **macOS only** (Windows/WebView2 is
a flagged follow-up). The live camera grant and the two-machine peer-video proof are
**hardware steps the owner runs** — this session delivers the native code (built +
compile-verified, no selftest regression) and the runbook.

---

## 1. Background — why the camera is dead in the packaged app

The collaborator-video feature (shipped behind `redesignShell`) calls
`navigator.mediaDevices.getUserMedia({ video: true })` from
[`ui/src/webrtc/useVideo.ts`](../../../ui/src/webrtc/useVideo.ts) when the user toggles
the camera on (off by default). In Chromium (the Playwright/e2e path) a fake device
auto-grants. But in the **packaged app** the UI runs inside a JUCE 8
`WebBrowserComponent`, which wraps a macOS `WKWebView`. WebKit asks its `WKUIDelegate`
to decide camera/mic requests via
`webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:`
(macOS 12+). **Mosh sets no `WKUIDelegate`**, so the request is never answered and
`getUserMedia` fails — the camera never turns on.

`NSCameraUsageDescription` is **already** injected into the bundle Info.plist
([`CMakeLists.txt:170`](../../../CMakeLists.txt)). The only missing piece is the native
delegate. JUCE 8 exposes no handle to its internal `WKWebView`, so we reach it through
Objective-C++ — mirroring the existing [`src/voice/NativeSpeech.mm`](../../../src/voice/NativeSpeech.mm)
pattern (the repo's one precedent for native macOS code).

---

## 2. New unit — `src/webview/WebViewCameraPermission.{h,mm}`

A focused, single-purpose unit: find the WKWebView, install an interposing UI delegate
that auto-grants media capture.

### 2.1 Header (plain C++ — includable from `WebViewShell.cpp`)

```cpp
#pragma once
namespace juce { class WebBrowserComponent; }

namespace mosh
{
/** Install a WKUIDelegate on the WebBrowserComponent's underlying WKWebView that
    auto-grants WebKit media-capture (camera/mic) requests, so getUserMedia works in
    the packaged app. Returns true once installed; false if the WKWebView is not yet
    realized (caller should retry) or on macOS < 12 (graceful no-op — camera stays
    unsupported there, exactly as before). Idempotent. macOS only. */
bool installWebViewCameraPermission (juce::WebBrowserComponent& webView);
}
```

### 2.2 Implementation (`.mm`) — three pieces

1. **WKWebView discovery.** From `webView.getPeer()->getNativeHandle()` (an `NSView*` on
   macOS), recursively walk `.subviews` for the first `WKWebView` instance. Returns
   `false` (retry) if the peer/handle/WKWebView isn't realized yet.

2. **Interposing delegate `MoshWebViewUIDelegate : NSObject <WKUIDelegate>`** —
   non-destructive so it never breaks any delegate JUCE itself installs (JS dialogs,
   etc.):
   - Holds a `weak` ref to the WKWebView's **existing** `UIDelegate` as `previous`.
   - Implements **only** the media-capture method →
     `decisionHandler(WKPermissionDecisionGrant)` (camera **and** mic; the requested
     `type` is granted).
   - Forwards every other selector to `previous` via `respondsToSelector:` +
     `forwardingTargetForSelector:`.
   - Annotated `API_AVAILABLE(macos(12.0))`.

3. **Install + ownership.** Set `wk.UIDelegate = delegate`, then retain the delegate on
   the WKWebView via `objc_setAssociatedObject(wk, key, delegate,
   OBJC_ASSOCIATION_RETAIN_NONATOMIC)` so its lifetime tracks the WKWebView (no
   bookkeeping in `WebViewShell`). Idempotent: if the associated object already exists,
   return `true` without reinstalling. Log one line on success
   (`"[webview] camera permission delegate installed"`). Wrapped in
   `if (@available(macOS 12.0, *)) { … } return false;`.

Sketch:

```objc
#include "WebViewCameraPermission.h"
#include <juce_gui_extra/juce_gui_extra.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

namespace {
WKWebView* findWKWebView (NSView* v) {
    if ([v isKindOfClass:[WKWebView class]]) return (WKWebView*) v;
    for (NSView* sub in v.subviews)
        if (WKWebView* found = findWKWebView (sub)) return found;
    return nil;
}
const void* kMoshUIDelegateKey = &kMoshUIDelegateKey;
}

API_AVAILABLE(macos(12.0))
@interface MoshWebViewUIDelegate : NSObject <WKUIDelegate>
@property (nonatomic, weak) id<WKUIDelegate> previous;
@end

@implementation MoshWebViewUIDelegate
- (void)webView:(WKWebView *)webView
   requestMediaCapturePermissionForOrigin:(WKSecurityOrigin *)origin
   initiatedByFrame:(WKFrameInfo *)frame
   type:(WKMediaCaptureType)type
   decisionHandler:(void (^)(WKPermissionDecision))decisionHandler {
    decisionHandler (WKPermissionDecisionGrant);   // in-app toggle + macOS TCC are the real gates
}
- (BOOL)respondsToSelector:(SEL)s {
    return [super respondsToSelector:s] || [self.previous respondsToSelector:s];
}
- (id)forwardingTargetForSelector:(SEL)s {
    return [self.previous respondsToSelector:s] ? self.previous : [super forwardingTargetForSelector:s];
}
@end

namespace mosh {
bool installWebViewCameraPermission (juce::WebBrowserComponent& web) {
    if (@available (macOS 12.0, *)) {
        auto* peer = web.getPeer();
        if (peer == nullptr) return false;
        NSView* root = (NSView*) peer->getNativeHandle();
        WKWebView* wk = (root != nil) ? findWKWebView (root) : nil;
        if (wk == nil) return false;
        if (objc_getAssociatedObject (wk, kMoshUIDelegateKey) != nil) return true; // already installed
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
```

---

## 3. Install timing — `WebViewShell` retry

The WKWebView only exists once the component is realized on a window, so install can't
happen at construction. `WebViewShell` ([`src/app/WebViewShell.h`](../../../src/app/WebViewShell.h))
gains a private `juce::Timer` that retries.

**Cross-platform guard (important):** `WebViewShell.cpp` compiles on all platforms, but
`installWebViewCameraPermission` is defined only in the APPLE-gated `.mm`. Calling it
unconditionally would break the Windows/WebView2 link (undefined symbol). So the timer
**start** and the install **call** are `#if JUCE_MAC`-guarded; on non-mac there's no
timer and no call (Windows camera permission is the flagged follow-up). The base class
and `timerCallback` are declared unconditionally (cheap, harmless), but the body only
does work under `JUCE_MAC`.

- `class WebViewShell : public juce::Component, private juce::Timer` — add the base.
- Members: `int camPermAttempts = 0;` and `void timerCallback() override;`.
- In the constructor, after `addAndMakeVisible (*webView)`:
  ```cpp
  #if JUCE_MAC
      startTimer (150);  // retry until the WKWebView is realized, then install the delegate
  #endif
  ```
- `timerCallback()`:

```cpp
void WebViewShell::timerCallback()
{
#if JUCE_MAC
    if (webView != nullptr && mosh::installWebViewCameraPermission (*webView)) { stopTimer(); return; }
    if (++camPermAttempts >= 20) { stopTimer(); juce::Logger::writeToLog ("[webview] camera permission delegate: WKWebView not found (camera disabled)"); }
#else
    stopTimer();
#endif
}
```

~20 × 150 ms ≈ 3 s of retry, then give up quietly (camera just stays off — no crash, no
regression). `#include "webview/WebViewCameraPermission.h"` in `WebViewShell.cpp`
(the header is a plain-C++ declaration, safe to include everywhere).

---

## 4. Permission policy — auto-grant (approved)

`getUserMedia` is only ever called after the user clicks the camera toggle (off by
default in `useVideo`). The genuine consent gates remain: **(a)** the in-app toggle and
**(b)** macOS's own TCC prompt on first hardware access (backed by the existing
`NSCameraUsageDescription`). The delegate returns `WKPermissionDecisionGrant` so WebKit
doesn't add a redundant third prompt. (Returning `Prompt` would double-prompt.)

---

## 5. macOS version — 12+ (approved)

`requestMediaCapturePermissionForOrigin:` and `WKPermissionDecision` are macOS 12.0+.
The whole unit is under `@available(macOS 12.0, *)` / `API_AVAILABLE(macos(12.0))`; the
app keeps its 11.0 deployment target. On macOS 11 the installer returns `false` and the
camera stays unsupported — identical to today, so no regression.

---

## 6. CMake

Mirror the `NativeSpeech.mm` block, immediately after it, inside the existing
`if (APPLE)` ([`CMakeLists.txt:147`](../../../CMakeLists.txt)):

```cmake
        target_sources(Mosh PRIVATE src/webview/WebViewCameraPermission.mm)
        set_source_files_properties(src/webview/WebViewCameraPermission.mm PROPERTIES COMPILE_FLAGS "-fobjc-arc")
        target_link_libraries(Mosh PRIVATE "-framework WebKit")
```

No Info.plist change — `NSCameraUsageDescription` is already injected.

---

## 7. Two-machine video runbook → `docs/VERIFICATION.md`

Append a **"Collaborator video — two machines"** section. The WebRTC + signaling layer
already exists (`mp_send_signal` → `MultiplayerSession::sendSignal` → relay → poll →
`webrtc_signal`; Google STUN for P2P); this is the operator procedure to prove it on
hardware:

1. **Build/deploy** Mosh on both Macs (`./run-mosh.sh deploy`, or copy `/Applications/Mosh.app`).
2. **Relay** — either:
   - *Cloud (default, zero-config):* nothing to do (the Supabase relay is baked in).
   - *Local:* on Mac A run `PORT=8771 python3 relay/server.py`; on **both** Macs
     `export MOSH_RELAY_URL=http://<MacA-LAN-IP>:8771` before launching.
3. **Session** — host creates a session (gets a room code); guest joins with that code.
   Confirm each shows the other in the presence cluster.
4. **Camera** — on each Mac, accept the macOS camera prompt (first time), then click the
   camera toggle. **Expect:** each sees the other's live tile in the Session rail;
   toggling off removes the remote tile; the camera light goes out on toggle-off.
5. **Optional same-Mac smoke** — two Mosh instances on one Mac (sharing the one camera)
   as a partial local check that signaling + tiles work without a second machine.
6. **Troubleshooting** — no remote video: check **System Settings → Privacy & Security →
   Camera** (Mosh enabled); relay reachability (`curl` the URL); ICE/NAT (both on the same
   LAN works without TURN; cross-NAT may need a TURN server — out of scope); the Console
   log line `[webview] camera permission delegate installed` confirms the delegate is live.

---

## 8. Verification

### What this session proves (here)
- The native app **compiles + links** with the new `.mm` and the `WebViewShell` timer
  (build via `./run-mosh.sh build` or the `macos-arm64-*` preset; reuse the main
  checkout's CPM cache + tracktion source-dir as the worktree convention requires).
- **`Mosh --selftest` stays green at its current count** — the delegate lives only in the
  GUI WebView path, which `--selftest` (headless command-surface harness) never
  instantiates. This is the no-regression gate, and it confirms the new translation unit
  links cleanly.
- The install log line exists in code (manual Console confirmation on launch).

### Hardware steps (owner runs — explicitly gated)
- The camera grant (self-tile appears on toggle) — a real display session + TCC prompt.
- Two-machine peer video — two physical Macs, per the §7 runbook.

There is no unit test for an Obj-C `WKUIDelegate`; correctness rests on the compile +
no-selftest-regression gate plus the hardware runbook.

---

## 9. Out of scope (flagged)

- **Windows / WebView2** camera permission (`CoreWebView2.PermissionRequested`) — the
  parallel additive path; the owner verifies on the PC box if/when wanted.
- Any change to the WebRTC/signaling/relay layer — already built and tested; this only
  unblocks the camera at the native boundary.
- TURN-server support for cross-NAT two-machine video (LAN works with STUN only).

---

## 10. File summary

| File | Change |
|---|---|
| `src/webview/WebViewCameraPermission.h` | **new** — `installWebViewCameraPermission` decl |
| `src/webview/WebViewCameraPermission.mm` | **new** — discovery + interposing WKUIDelegate + install |
| `src/app/WebViewShell.h` | add `private juce::Timer`, `camPermAttempts`, `timerCallback` |
| `src/app/WebViewShell.cpp` | include header; `startTimer(150)`; implement `timerCallback` |
| `CMakeLists.txt` | add the `.mm` source + `-fobjc-arc` + `-framework WebKit` (APPLE block) |
| `docs/VERIFICATION.md` | append the two-machine video runbook (§7) |
