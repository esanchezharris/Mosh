#include "WebViewCursor.h"

#import <AppKit/AppKit.h>
#import <dispatch/dispatch.h>

namespace
{
NSCursor* cursorForKind (mosh::EditorCursorKind kind)
{
    switch (kind)
    {
        case mosh::EditorCursorKind::defaultCursor:  return NSCursor.arrowCursor;
        case mosh::EditorCursorKind::crosshair:      return NSCursor.crosshairCursor;
        case mosh::EditorCursorKind::openHand:       return NSCursor.openHandCursor;
        case mosh::EditorCursorKind::closedHand:     return NSCursor.closedHandCursor;
        case mosh::EditorCursorKind::resizeLeftRight:return NSCursor.resizeLeftRightCursor;
    }

    jassertfalse;
    return NSCursor.arrowCursor;
}

mosh::EditorCursorKind desiredCursor = mosh::EditorCursorKind::defaultCursor;
id cursorEventMonitor = nil;
bool cursorRefreshPending = false;
bool cursorOverrideActive = false;

void applyDesiredCursorAfterWebKit()
{
    if (! cursorOverrideActive || cursorRefreshPending)
        return;

    cursorRefreshPending = true;
    dispatch_after (dispatch_time (DISPATCH_TIME_NOW, 16 * NSEC_PER_MSEC),
                    dispatch_get_main_queue(), ^{
        cursorRefreshPending = false;
        if (cursorOverrideActive)
            [cursorForKind (desiredCursor) set];
    });
}

void removeCursorEventMonitor()
{
    if (cursorEventMonitor == nil)
        return;

    [NSEvent removeMonitor:cursorEventMonitor];
    cursorEventMonitor = nil;
}

void installCursorEventMonitor()
{
    if (cursorEventMonitor != nil)
        return;

    const auto mask = NSEventMaskMouseMoved
                    | NSEventMaskLeftMouseDragged
                    | NSEventMaskLeftMouseDown
                    | NSEventMaskLeftMouseUp;

    cursorEventMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:mask
                                                               handler:^NSEvent* (NSEvent* event) {
        applyDesiredCursorAfterWebKit();
        return event;
    }];
}
}

namespace mosh
{
void setMacEditorCursor (EditorCursorKind kind)
{
    jassert ([NSThread isMainThread]);
    desiredCursor = kind;

    if (! editorCursorNeedsNativeRefresh (kind))
    {
        cursorOverrideActive = false;
        removeCursorEventMonitor();
        [cursorForKind (kind) set];
        return;
    }

    cursorOverrideActive = true;
    installCursorEventMonitor();
    [cursorForKind (kind) set];
    applyDesiredCursorAfterWebKit();
}
}
