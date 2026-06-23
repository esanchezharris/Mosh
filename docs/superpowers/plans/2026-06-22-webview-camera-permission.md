# WKWebView Camera Permission Delegate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make collaborator-video `getUserMedia` work in the packaged macOS app by installing a `WKUIDelegate` that auto-grants WebKit media-capture, and document a two-machine test runbook.

**Architecture:** A new macOS-only Obj-C++ unit (`src/webview/WebViewCameraPermission.mm`) walks the WebBrowserComponent's native NSView tree to find the internal `WKWebView`, then installs a non-destructive interposing `WKUIDelegate` (auto-grants media capture, forwards every other selector to JUCE's original delegate). `WebViewShell` drives a short retry timer (the WKWebView only exists once realized). Everything macOS-12-gated; the install call is `#if JUCE_MAC`-guarded so the Windows build still links.

**Tech Stack:** C++17, JUCE 8 (`WebBrowserComponent`), Objective-C++ (`-fobjc-arc`), WebKit framework, CMake + Ninja, `Mosh --selftest` headless harness.

## Global Constraints

- **macOS only.** The `.mm` is added under the existing `if (APPLE)` CMake block; the call site in `WebViewShell.cpp` is `#if JUCE_MAC`-guarded (Windows/WebView2 camera permission is a deferred follow-up).
- **macOS 12.0+** for the API; whole unit under `if (@available(macOS 12.0, *))` / `API_AVAILABLE(macos(12.0))`. App deployment target stays 11.0; on macOS 11 the installer is a graceful no-op (returns false), camera stays unsupported — no regression.
- **Auto-grant** the WebKit media permission (`WKPermissionDecisionGrant`): the in-app camera toggle (off by default) + macOS's own TCC prompt (existing `NSCameraUsageDescription`) are the real consent gates.
- **No selftest regression.** The delegate lives only in the GUI WebView path, which `Mosh --selftest` never instantiates — the count must be unchanged. Determinism bar: 0 failures, identical across 3 runs (isolate with `MOSH_SELFTEST_SESSION`).
- **No new dependencies** beyond the `-framework WebKit` link. Mirror the existing `src/voice/NativeSpeech.mm` build pattern.
- Spec: `docs/superpowers/specs/2026-06-22-webview-camera-permission-design.md`.
- **Build:** `cmake --preset macos-arm64-debug` (configure, Ninja, `build-macos-arm64/`) then `cmake --build --preset macos-arm64-app`. The worktree already has `build-macos-arm64/` (incremental). If a fresh configure can't resolve deps, add `-DCPM_SOURCE_CACHE=/Users/emiliosanchez-harris/Documents/ClaudeMosh/.cpm-cache` to the configure.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/webview/WebViewCameraPermission.h` | plain-C++ decl of `installWebViewCameraPermission` | 1 |
| `src/webview/WebViewCameraPermission.mm` | WKWebView discovery + interposing `WKUIDelegate` + install | 1 |
| `CMakeLists.txt` (APPLE block, ~150) | add the `.mm` source + `-fobjc-arc` + `-framework WebKit` | 1 |
| `src/app/WebViewShell.h` | add `private juce::Timer`, `camPermAttempts`, `timerCallback` | 1 |
| `src/app/WebViewShell.cpp` | include header; guarded `startTimer`; `timerCallback` | 1 |
| `docs/VERIFICATION.md` | append the two-machine video runbook | 2 |

This is a single tightly-coupled native change (Task 1) + a doc (Task 2) + a verification gate (Task 3). Splitting the `.mm` from the `WebViewShell` wiring would leave a non-functional intermediate (the unit unused), so they land together.

---

### Task 1: Camera-permission delegate + install

**Files:**
- Create: `src/webview/WebViewCameraPermission.h`
- Create: `src/webview/WebViewCameraPermission.mm`
- Modify: `CMakeLists.txt` (inside `if (APPLE)`, right after the `NativeSpeech.mm` block at ~150)
- Modify: `src/app/WebViewShell.h`
- Modify: `src/app/WebViewShell.cpp`

**Interfaces:**
- Consumes: `juce::WebBrowserComponent` (the `webView` member of `WebViewShell`), `juce::ComponentPeer::getNativeHandle()` (→ `NSView*` on macOS), `juce::Timer`.
- Produces: `bool mosh::installWebViewCameraPermission (juce::WebBrowserComponent&)` — returns true once the delegate is installed on the realized WKWebView; false if not yet realized (retry) or macOS < 12. Idempotent.

- [ ] **Step 1: Establish the build + selftest baseline (before any change).**

Confirm the binary builds clean on this branch and capture the baseline selftest count, so "no regression" is provable.

Run:
```bash
cd /Users/emiliosanchez-harris/Documents/ClaudeMosh/.claude/worktrees/cranky-tesla-dc897a
cmake --preset macos-arm64-debug
cmake --build --preset macos-arm64-app
BIN="$(find build-macos-arm64 -name 'Mosh.app' -type d | head -1)/Contents/MacOS/Mosh"
echo "BIN=$BIN"
MOSH_SELFTEST_SESSION=cam-baseline "$BIN" --selftest 2>&1 | tail -3
```
Expected: build succeeds; the last selftest line reports a total like `NNN/NNN checks pass` with 0 failures. **Record that NNN as the baseline.**

- [ ] **Step 2: Create the header `src/webview/WebViewCameraPermission.h`.**

```cpp
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
```

- [ ] **Step 3: Create the implementation `src/webview/WebViewCameraPermission.mm`.**

```objc
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
    // The in-app camera toggle (off by default) + the macOS TCC prompt are the real
    // gates; auto-grant here so WebKit doesn't add a redundant third prompt.
    decisionHandler (WKPermissionDecisionGrant);
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

        NSView* root = (NSView*) peer->getNativeHandle();
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
```

- [ ] **Step 4: Wire the CMake build.** In `CMakeLists.txt`, inside the existing `if (APPLE)` block, immediately after the three `NativeSpeech.mm` lines (currently lines 148-150), add:

```cmake
        # Native WKWebView media-capture permission delegate (collaborator video
        # getUserMedia) — Obj-C++ with ARC; mirrors the NativeSpeech.mm pattern.
        target_sources(Mosh PRIVATE src/webview/WebViewCameraPermission.mm)
        set_source_files_properties(src/webview/WebViewCameraPermission.mm PROPERTIES COMPILE_FLAGS "-fobjc-arc")
        target_link_libraries(Mosh PRIVATE "-framework WebKit")
```

- [ ] **Step 5: Update `src/app/WebViewShell.h`.** Add the `Timer` base, the attempts counter, and the override. Replace the class declaration:

```cpp
class WebViewShell : public juce::Component,
                     private juce::Timer
{
public:
    WebViewShell();
    ~WebViewShell() override;

    WebBridge& bridge() { return webBridge; }

    void load();
    void resized() override;

private:
    void timerCallback() override;

    bool loaded = false;
    int camPermAttempts = 0;
    WebBridge webBridge;
    std::unique_ptr<juce::WebBrowserComponent> webView;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (WebViewShell)
};
```

- [ ] **Step 6: Update `src/app/WebViewShell.cpp`.** Add the include, start the timer in the constructor (guarded), and implement `timerCallback`.

Change the top include block to add:
```cpp
#include "WebViewShell.h"
#include "webview/WebViewCameraPermission.h"
```

Change the constructor to start the retry timer (macOS only):
```cpp
WebViewShell::WebViewShell()
{
    webView = std::make_unique<juce::WebBrowserComponent> (webBridge.buildOptions());
    webBridge.attach (*webView);
    addAndMakeVisible (*webView);
   #if JUCE_MAC
    startTimer (150); // retry until the WKWebView is realized, then install the camera delegate
   #endif
}
```

Add the `timerCallback` implementation (e.g. after `resized()`):
```cpp
void WebViewShell::timerCallback()
{
   #if JUCE_MAC
    if (webView != nullptr && mosh::installWebViewCameraPermission (*webView)) { stopTimer(); return; }
    if (++camPermAttempts >= 20)
    {
        stopTimer();
        juce::Logger::writeToLog ("[webview] camera permission delegate: WKWebView not found (camera disabled)");
    }
   #else
    stopTimer();
   #endif
}
```

- [ ] **Step 7: Reconfigure + build to verify it compiles and links.**

Run:
```bash
cmake --preset macos-arm64-debug
cmake --build --preset macos-arm64-app
```
Expected: clean build. Specifically the new `WebViewCameraPermission.mm` compiles (WebKit header found, `-fobjc-arc`, the `@available`/`API_AVAILABLE` guards satisfy the 12.0 symbols against the 11.0 deployment target) and `Mosh` links with `-framework WebKit`. No warnings-as-errors from the delegate.

If the build errors on a missing dep during configure, re-run the configure with `-DCPM_SOURCE_CACHE=/Users/emiliosanchez-harris/Documents/ClaudeMosh/.cpm-cache` appended.

- [ ] **Step 8: Commit.**

```bash
git add src/webview/WebViewCameraPermission.h src/webview/WebViewCameraPermission.mm \
        CMakeLists.txt src/app/WebViewShell.h src/app/WebViewShell.cpp
git commit -m "feat(webview): WKWebView camera permission delegate (collaborator video)"
```

---

### Task 2: Two-machine video runbook

**Files:**
- Modify: `docs/VERIFICATION.md` (append a new section)

**Interfaces:** none (documentation).

- [ ] **Step 1: Append the runbook.** Add this section to the end of `docs/VERIFICATION.md`:

```markdown
## Collaborator video — two machines (hardware-gated)

The WebRTC + signaling layer is built and unit-tested (`ui/src/webrtc/*.test.ts`,
`relay/run-mp-selftest.sh`); the camera permission delegate (macOS 12+) unblocks
`getUserMedia` in the packaged app. This is the operator procedure to prove peer video
on real hardware.

1. **Build/deploy** Mosh on both Macs: `./run-mosh.sh deploy` (or copy `/Applications/Mosh.app`).
2. **Relay** — pick one:
   - *Cloud (default, zero-config):* nothing to do; the Supabase relay is baked in.
   - *Local:* on Mac A run `PORT=8771 python3 relay/server.py`; on **both** Macs
     `export MOSH_RELAY_URL=http://<MacA-LAN-IP>:8771` before launching.
3. **Session** — host creates a session (gets a room code); guest joins with that code.
   Confirm each Mac shows the other in the presence cluster.
4. **Camera** — on each Mac, accept the macOS camera prompt (first time), then click the
   camera toggle. Expect: each sees the other's live tile in the Session rail; toggling
   off removes the remote tile and the camera light goes out.
5. **Same-Mac smoke (optional)** — two Mosh instances on one Mac (sharing the one camera)
   partially checks signaling + tiles without a second machine.
6. **Troubleshooting** — no remote video:
   - System Settings → Privacy & Security → Camera → ensure Mosh is enabled.
   - Relay reachability: `curl <MOSH_RELAY_URL>` from both Macs.
   - The Console log line `[webview] camera permission delegate installed` confirms the
     delegate attached (absent → the delegate didn't find the WKWebView; camera will fail).
   - Same-LAN works with STUN only; cross-NAT may need a TURN server (out of scope).
```

- [ ] **Step 2: Commit.**

```bash
git add docs/VERIFICATION.md
git commit -m "docs(verify): two-machine collaborator-video runbook"
```

---

### Task 3: Verification gate

**Files:** none (verification only).

- [ ] **Step 1: No-regression selftest, 3× deterministic.**

Run:
```bash
BIN="$(find build-macos-arm64 -name 'Mosh.app' -type d | head -1)/Contents/MacOS/Mosh"
for i in 1 2 3; do
  MOSH_SELFTEST_SESSION="cam-verify-$i" "$BIN" --selftest 2>&1 | tail -1
done
```
Expected: each run reports the **same total** as the Task 1 Step 1 baseline (NNN), 0 failures, identical across all three. (The delegate is GUI-only; the headless harness can't exercise it, so the count must be unchanged — this confirms the new `.mm` links into the binary without disturbing anything.)

- [ ] **Step 2: Confirm the install code path is in the binary.**

Run:
```bash
strings "$BIN" | grep -c "camera permission delegate installed"
```
Expected: `1` (or more) — the log string is compiled in, confirming `WebViewCameraPermission.mm` was linked into `Mosh` (not dead-stripped).

- [ ] **Step 3: Confirm zero unintended footprint.**

Run:
```bash
git diff --name-only main...HEAD
```
Expected: only `src/webview/WebViewCameraPermission.{h,mm}`, `CMakeLists.txt`, `src/app/WebViewShell.{h,cpp}`, `docs/VERIFICATION.md`, and the two `docs/superpowers/{specs,plans}/2026-06-22-webview-camera-permission*` files. No frontend (`ui/**`), service, or relay changes.

- [ ] **Step 4: Report the hardware-gated steps as explicitly NOT verified here.**

State in the final summary that the live camera grant (self/remote tiles) and the
two-machine peer-video flow require the owner's hardware per the §7 runbook, and that the
automated gate proved: compiles + links + `--selftest` NNN×3 unchanged + the delegate
string present in the binary.

---

## Self-Review

**1. Spec coverage:**
- §2 unit (`.h`/`.mm`, discovery, interposing delegate, install) → Task 1 Steps 2-3. ✓
- §3 `WebViewShell` retry timer + JUCE_MAC guard → Task 1 Steps 5-6. ✓
- §4 auto-grant → the delegate returns `WKPermissionDecisionGrant` (Task 1 Step 3). ✓
- §5 macOS 12 gate → `@available`/`API_AVAILABLE` (Task 1 Step 3). ✓
- §6 CMake → Task 1 Step 4. ✓
- §7 runbook → Task 2. ✓
- §8 verification (compile + selftest no-regression + install-log) → Task 1 Step 7, Task 3. ✓
- §9 out-of-scope (Windows, WebRTC layer, TURN) → not touched; Task 3 Step 3 asserts no `ui/**`/service/relay diff. ✓

**2. Placeholder scan:** No TBD/TODO. `<MacA-LAN-IP>` and `NNN` are operator/baseline values captured at runtime, not plan placeholders. Every code step shows the full code; every command has expected output.

**3. Type consistency:** `installWebViewCameraPermission (juce::WebBrowserComponent&) -> bool` is identical across the header (Step 2), the `.mm` definition (Step 3), and the call site (Step 6). `camPermAttempts`/`timerCallback` names match between `WebViewShell.h` (Step 5) and `.cpp` (Step 6). The `kMoshUIDelegateKey` association key is used consistently for both the idempotency check and the retain. ✓
