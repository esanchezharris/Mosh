#pragma once

namespace mosh
{

struct PluginScanPlan
{
    bool runSynchronously = true;
    bool preScanVST3 = false;
    bool asyncClearFirst = false;
    bool asyncIncludeVST3 = false;
    bool asyncIncludeAU = false;
    bool asyncSlowVST3 = false;
};

inline PluginScanPlan planPluginScan (bool clearFirst,
                                      bool includeVST3,
                                      bool includeAU,
                                      bool wait,
                                      bool deepVST3)
{
    const bool deepVST3Requested = deepVST3 && includeVST3;
    if (! includeAU && ! deepVST3Requested)
        return {};

    // Preserve the legacy wait:true AU posture: catalog the cheap VST3 metadata
    // synchronously, then sweep AU in the isolated worker. A requested deep VST3
    // pass must stay in that worker instead of being consumed by this pre-scan.
    const bool preScanVST3 = wait && includeAU && includeVST3 && ! deepVST3Requested;
    return {
        false,
        preScanVST3,
        clearFirst && ! preScanVST3,
        includeVST3 && ! preScanVST3,
        includeAU,
        deepVST3Requested || includeAU,
    };
}

} // namespace mosh
