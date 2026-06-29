#include "app/MacStateRestoration.h"

#if defined(__APPLE__)
#import <Foundation/Foundation.h>

namespace mosh
{
void disableAppKitStateRestoration()
{
    // Write the app (persistent) domain — the domain AppKit actually consults for
    // ApplePersistenceIgnoreState during launch. registerDefaults (registration domain)
    // is NOT reliably honored for this key, and the volatile NSArgumentDomain can't be
    // re-set after launch, so a plain setBool: is the dependable equivalent of the
    // proven `-ApplePersistenceIgnoreState YES` argv flag. Idempotent; only called on
    // headless/automated CLI launches, where suppressing window restoration is correct.
    [[NSUserDefaults standardUserDefaults] setBool:YES forKey:@"ApplePersistenceIgnoreState"];
}
}
#endif
