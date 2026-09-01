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

void applyDesiredCursorAfterWebKit()
{
    if (cursorRefreshPending)
        return;

    cursorRefreshPending = true;
    dispatch_after (dispatch_time (DISPATCH_TIME_NOW, 16 * NSEC_PER_MSEC),
                    dispatch_get_main_queue(), ^{
        cursorRefreshPending = false;
        [cursorForKind (desiredCursor) set];
    });
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
    installCursorEventMonitor();
    desiredCursor = kind;
    [cursorForKind (kind) set];
    applyDesiredCursorAfterWebKit();
}
}
