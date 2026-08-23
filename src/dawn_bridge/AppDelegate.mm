#import "AppDelegate.h"

#import <CoreImage/CoreImage.h>
#import <os/log.h>

#include "Protocol.h"
#include "Resources.h"
#include "Servers.h"

#include <memory>

using namespace mosh::dawn;

@interface DawnAppDelegate ()
@property(nonatomic, strong) NSStatusItem* statusItem;
@property(nonatomic, strong) NSMenuItem* bridgeItem;
@property(nonatomic, strong) NSMenuItem* liveItem;
@property(nonatomic, strong) NSMenuItem* recordingItem;
@property(nonatomic, strong) NSMenuItem* pairingItem;
@property(nonatomic, strong) NSTimer* refreshTimer;
@property(nonatomic, copy) NSString* pairingURL;
@end

@implementation DawnAppDelegate
{
    std::unique_ptr<BridgeCore> _core;
    std::unique_ptr<ScriptServer> _script;
    std::unique_ptr<HttpServer> _http;
    NSString* _token;
}

- (void)applicationDidFinishLaunching:(NSNotification*)notification
{
    (void) notification;
    _token = randomSecret();
    _core = std::make_unique<BridgeCore> (_token);
    NSString* resources = NSBundle.mainBundle.resourcePath;
    NSString* page = [NSString stringWithContentsOfFile:bundledCompanionPath (resources)
                                                encoding:NSUTF8StringEncoding error:nil];
    if (page == nil)
        page = @"<!doctype html><meta name=viewport content='width=device-width'><h1>DAWN Bridge</h1>";
    _script = std::make_unique<ScriptServer> (*_core, defaultDescriptorPath());
    _http = std::make_unique<HttpServer> (*_core, page);
    NSError* error = nil;
    const bool scriptStarted = _script->start (&error);
    const bool httpStarted = _http->start (&error);
    if (httpStarted)
    {
        NSString* encoded = [_token stringByAddingPercentEncodingWithAllowedCharacters:
            NSCharacterSet.URLFragmentAllowedCharacterSet];
        self.pairingURL = [NSString stringWithFormat:@"http://%@:%u/web#token=%@",
            preferredLanAddress(), _http->port(), encoded];
    }
    [self buildMenu];
    self.bridgeItem.title = scriptStarted && httpStarted ? @"Bridge: Ready" : @"Bridge: Start failed";
    self.refreshTimer = [NSTimer scheduledTimerWithTimeInterval:1.0 target:self
        selector:@selector(refreshStatus:) userInfo:nil repeats:YES];
    os_log_info (OS_LOG_DEFAULT, "Mosh DAWN Bridge started");
}

- (void)applicationWillTerminate:(NSNotification*)notification
{
    (void) notification;
    [self.refreshTimer invalidate];
    if (_http)
        _http->stop();
    if (_script)
        _script->stop();
}

- (NSMenuItem*)statusLine:(NSString*)title menu:(NSMenu*)menu
{
    NSMenuItem* item = [[NSMenuItem alloc] initWithTitle:title action:nil keyEquivalent:@""];
    item.enabled = NO;
    [menu addItem:item];
    return item;
}

- (void)buildMenu
{
    self.statusItem = [NSStatusBar.systemStatusBar statusItemWithLength:NSVariableStatusItemLength];
    self.statusItem.button.title = @"DAWN";
    NSMenu* menu = [NSMenu new];
    self.bridgeItem = [self statusLine:@"Bridge: Starting…" menu:menu];
    self.liveItem = [self statusLine:@"Ableton Live: Not detected" menu:menu];
    self.recordingItem = [self statusLine:@"Recording: Stopped" menu:menu];
    self.pairingItem = [self statusLine:(self.pairingURL ?: @"Pairing URL: Unavailable") menu:menu];
    [menu addItem:NSMenuItem.separatorItem];
    NSMenuItem* copy = [[NSMenuItem alloc] initWithTitle:@"Copy Pairing URL"
        action:@selector(copyPairingURL:) keyEquivalent:@""];
    copy.target = self;
    copy.enabled = self.pairingURL != nil;
    [menu addItem:copy];
    NSMenuItem* qr = [[NSMenuItem alloc] initWithTitle:@"Show Pairing QR…"
        action:@selector(showPairingQR:) keyEquivalent:@""];
    qr.target = self;
    qr.enabled = self.pairingURL != nil;
    [menu addItem:qr];
    [menu addItem:NSMenuItem.separatorItem];
    NSMenuItem* install = [[NSMenuItem alloc] initWithTitle:@"Install / Update MoshDawnController…"
        action:@selector(installController:) keyEquivalent:@""];
    install.target = self;
    [menu addItem:install];
    [self statusLine:@"Then Live Preferences → Link/MIDI" menu:menu];
    [self statusLine:@"Control Surface: MoshDawnController" menu:menu];
    [self statusLine:@"Input: None · Output: None" menu:menu];
    [menu addItem:NSMenuItem.separatorItem];
    NSMenuItem* quit = [[NSMenuItem alloc] initWithTitle:@"Quit DAWN Bridge"
        action:@selector(terminate:) keyEquivalent:@"q"];
    [menu addItem:quit];
    self.statusItem.menu = menu;
}

- (void)refreshStatus:(NSTimer*)timer
{
    (void) timer;
    self.liveItem.title = [NSRunningApplication runningApplicationsWithBundleIdentifier:
        @"com.ableton.live"].count > 0 ? @"Ableton Live: Detected" : @"Ableton Live: Not detected";
    if (!_core)
        return;
    HttpReply reply = _core->handleHttp (@"GET", @"/v1/snapshot",
        [@"Bearer " stringByAppendingString:_token], [NSData data], @"");
    NSDictionary* envelope = [NSJSONSerialization JSONObjectWithData:reply.body options:0 error:nil];
    NSDictionary* state = envelope[@"state"];
    NSString* transport = state[@"transport"];
    self.bridgeItem.title = [state[@"connection"] isEqualToString:@"connected"]
        ? @"Bridge: Live script connected" : @"Bridge: Waiting for Live script";
    self.recordingItem.title = [transport isEqualToString:@"recording"]
        ? @"Recording: Active" : @"Recording: Stopped";
}

- (void)copyPairingURL:(id)sender
{
    (void) sender;
    if (self.pairingURL == nil)
        return;
    [NSPasteboard.generalPasteboard clearContents];
    [NSPasteboard.generalPasteboard setString:self.pairingURL forType:NSPasteboardTypeString];
}

- (void)showPairingQR:(id)sender
{
    (void) sender;
    CIFilter* filter = [CIFilter filterWithName:@"CIQRCodeGenerator"];
    [filter setValue:[self.pairingURL dataUsingEncoding:NSUTF8StringEncoding] forKey:@"inputMessage"];
    [filter setValue:@"M" forKey:@"inputCorrectionLevel"];
    CIImage* output = [filter.outputImage imageByApplyingTransform:CGAffineTransformMakeScale (8, 8)];
    NSCIImageRep* representation = [NSCIImageRep imageRepWithCIImage:output];
    NSImage* image = [[NSImage alloc] initWithSize:representation.size];
    [image addRepresentation:representation];
    NSImageView* view = [[NSImageView alloc] initWithFrame:NSMakeRect (0, 0, 240, 240)];
    view.image = image;
    NSAlert* alert = [NSAlert new];
    alert.messageText = @"Scan to open DAWN";
    alert.informativeText = self.pairingURL ?: @"Pairing is unavailable.";
    alert.accessoryView = view;
    [alert runModal];
}

- (void)installController:(id)sender
{
    (void) sender;
    NSString* userLibrary = [NSHomeDirectory() stringByAppendingPathComponent:@"Music/Ableton/User Library"];
    NSError* error = nil;
    const bool installed = mosh::dawn::installController (NSBundle.mainBundle.resourcePath,
                                                           userLibrary, &error);
    NSAlert* alert = [NSAlert new];
    alert.messageText = installed ? @"MoshDawnController installed" : @"Install failed";
    alert.informativeText = installed
        ? @"In Live Preferences → Link/MIDI, select MoshDawnController with Input None and Output None."
        : (error.localizedDescription ?: @"The bundled controller could not be installed.");
    [alert runModal];
}
@end
