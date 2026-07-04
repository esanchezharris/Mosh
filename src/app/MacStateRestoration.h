#pragma once

namespace mosh
{
// Headless / automated CLI launches (selftest, run-script, voice/live smoke, deep scan,
// scripted demos) must NEVER inherit AppKit's window-restoration "reopen windows after
// crash" modal. After a repeated-crash history (e.g. the speech-TCC crash this fixes),
// macOS runs NSPersistentUIRestorer's promptToIgnorePersistentStateWithCrashHistory:
// modal during launch — headless, with no one to dismiss it, that blocks forever
// (it once hung the gate's selftest for 2h at 0% CPU).
//
// This sets ApplePersistenceIgnoreState=YES (the same lever as launching with
// `-ApplePersistenceIgnoreState YES`) so restoration is skipped. Call it BEFORE the
// first run-loop pump — i.e. before constructing the engine in initialise() — since the
// finish-launching notification that evaluates restoration fires on the first pump.
// No-op off macOS.
#if defined(__APPLE__)
    void disableAppKitStateRestoration();
#else
    inline void disableAppKitStateRestoration() {}
#endif
}
