// SparkleUpdater.mm — Obj-C++ (ARC) host for Sparkle 2. Same shape as
// src/voice/NativeSpeech.mm: a thin C++ facade over an Objective-C object, so exactly
// one translation unit in the app speaks Objective-C to this framework.
//
// Compiled on every Apple build. MOSH_HAVE_SPARKLE (set by cmake/Sparkle.cmake only
// when the framework was fetched and embedded) decides whether the body is real or a
// no-op, so callers never need their own #ifs and -DMOSH_ENABLE_SPARKLE=OFF stays a
// one-flag change with no ripple.

#include "SparkleUpdater.h"

#if MOSH_HAVE_SPARKLE
 #import <Foundation/Foundation.h>
 #import <Sparkle/Sparkle.h>

// Obj-C declarations cannot live inside a C++ namespace — file scope, prefixed.
//
// The delegate exists for ONE job: let a test run point the updater at a different
// appcast without rebuilding. Sparkle reads SUFeedURL from Info.plist, and returning
// nil here means "use that" — so the default path is byte-for-byte the stock one.
//
// Why an env override is safe: it can only be set by whoever already launches the
// process, i.e. someone who could replace the binary outright. It cannot weaken the
// EdDSA check — SUPublicEDKey stays in the signed Info.plist, so an update served from
// an override feed still has to be signed by the private key in the owner's Keychain.
// It changes WHERE we look, never WHETHER we verify. (This is the mechanism the FS-K2
// round-trip gate uses to prove the install path against a local static server.)
@interface MoshSparkleDelegate : NSObject <SPUUpdaterDelegate>
@property (nonatomic, copy, nullable) NSString* feedOverride;
@end

@implementation MoshSparkleDelegate
- (nullable NSString *)feedURLStringForUpdater:(SPUUpdater *)updater
{
    (void) updater;
    return self.feedOverride;   // nil ⇒ Sparkle falls back to Info.plist SUFeedURL
}
@end
#endif // MOSH_HAVE_SPARKLE

namespace mosh
{

struct SparkleUpdater::Impl
{
   #if MOSH_HAVE_SPARKLE
    SPUStandardUpdaterController* controller = nil;
    MoshSparkleDelegate*          delegate   = nil;
   #endif
    juce::String feed;
};

SparkleUpdater::SparkleUpdater() : impl (std::make_unique<Impl>())
{
   #if MOSH_HAVE_SPARKLE
    const auto override_ = juce::SystemStats::getEnvironmentVariable ("MOSH_SPARKLE_FEED_URL", {}).trim();

    juce::String plistFeed;
    if (id v = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"SUFeedURL"])
        if ([v isKindOfClass:[NSString class]])
            plistFeed = juce::String::fromUTF8 ([(NSString*) v UTF8String]);

    impl->feed = override_.isNotEmpty() ? override_ : plistFeed;

    // No feed ⇒ no updater object at all. Constructing one that cannot ever find an
    // appcast would log an error on every launch and give the menu an item that does
    // nothing — worse than not offering it.
    if (impl->feed.isEmpty())
        return;

    impl->delegate = [[MoshSparkleDelegate alloc] init];
    if (override_.isNotEmpty())
        impl->delegate.feedOverride = [NSString stringWithUTF8String: override_.toRawUTF8()];

    impl->controller = [[SPUStandardUpdaterController alloc]
                            initWithStartingUpdater: YES
                                    updaterDelegate: impl->delegate
                                 userDriverDelegate: nil];
   #endif
}

SparkleUpdater::~SparkleUpdater() = default;

bool SparkleUpdater::isAvailable() const
{
   #if MOSH_HAVE_SPARKLE
    return impl->controller != nil;
   #else
    return false;
   #endif
}

juce::String SparkleUpdater::feedUrl() const
{
    return isAvailable() ? impl->feed : juce::String();
}

void SparkleUpdater::checkForUpdates()
{
   #if MOSH_HAVE_SPARKLE
    if (impl->controller != nil)
        [impl->controller checkForUpdates: nil];
   #endif
}

} // namespace mosh
