#pragma once

#include <juce_core/juce_core.h>

namespace mosh::telemetry
{

/**
    Paths + opt-in state for the telemetry/crash module. Everything here lives
    under `~/Library/Mosh/` (the same root MoshEngine's session dir uses — see
    src/engine/MoshEngine.cpp), in locations dedicated to THIS module:

      ~/Library/Mosh/telemetry.optin   — presence = opted in; absence (default) =
                                          opted out. A plain flag file (not JSON):
                                          trivially inspectable/removable by a
                                          privacy-conscious user, and its mere
                                          existence is the one bit that gates
                                          every network-touching code path.
      ~/Library/Mosh/diagnostics/      — local-only crash reports (CrashHandler).
      ~/Library/Mosh/telemetry/        — this module's own small state: the
                                          per-install id + batched counters
                                          (Telemetry.h). Never touched unless
                                          opted in.

    MOSH_TELEMETRY_DIR overrides the `~/Library/Mosh` root for ALL THREE of the
    above (tests + hermetic harnesses only — unset in normal/production runs).

    This header does the "safe" (non-signal-handler) path/config resolution — it
    is read once at CrashHandler::installCrashHandler() time and never again from
    inside a signal handler (see CrashHandler.cpp).
*/
class TelemetryConfig
{
public:
    /** `~/Library/Mosh` (or MOSH_TELEMETRY_DIR, when set — test/harness override). */
    static juce::File root();

    /** `<root>/diagnostics` — local crash reports. Created on first use. */
    static juce::File diagnosticsDir();

    /** `<root>/telemetry` — this module's own counters/identity state. Created on
        first use IFF the caller is about to write into it (never created just by
        calling isOptedIn()/optInFile(), so an opted-out install never gains a
        single new file beyond nothing). */
    static juce::File telemetryStateDir();

    /** `<root>/telemetry.optin` — the opt-in flag file itself. */
    static juce::File optInFile();

    /** True iff the opt-in flag file exists. Cheap (a single stat()); safe to
        call frequently. This is the ONE gate every network-touching / counter-
        persisting code path in this module checks first. */
    static bool isOptedIn();

    /** Create/remove the opt-in flag file. Called from the native
        `set_telemetry_optin` bridge function (WebBridge.cpp) — the UI writes this
        through that seam; nothing else in the module ever asks the user. */
    static void setOptedIn (bool optIn);

    /** The per-install anonymous id used to bucket counters (NOT a machine/user
        identifier — see PRIVACY.md). Resolution order:
          1. Reuse `~/Library/Mosh/session/identity.json`'s "installId" field, IF
             that file exists and carries one (read-only probe — this module never
             writes into session/, which belongs to the engine).
          2. Reuse this module's own persisted id (`<root>/telemetry/identity.json`),
             if a previous run already minted one.
          3. Mint a fresh juce::Uuid and persist it under (2) for next time.
        Only ever called on the opted-in path (Telemetry::onAppLaunch()) — an
        opted-out install never resolves or persists an id. */
    static juce::String installId();
};

} // namespace mosh::telemetry
