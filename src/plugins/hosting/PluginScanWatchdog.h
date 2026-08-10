#pragma once

#include <atomic>

namespace mosh
{

/** Cross-thread hand-off for one hung plug-in scan.
    The watchdog requests cancellation; the scan thread consumes the request after
    KnownPluginList::scanAndAddFile returns and resets the custom scanner before the
    next bundle begins. */
class PluginScanWatchdogState
{
public:
    void requestAbort() noexcept
    {
        abortRequested.store (true, std::memory_order_release);
    }

    bool consumeAbortRequest() noexcept
    {
        return abortRequested.exchange (false, std::memory_order_acq_rel);
    }

    bool isAbortRequested() const noexcept
    {
        return abortRequested.load (std::memory_order_acquire);
    }

private:
    std::atomic<bool> abortRequested { false };
};

} // namespace mosh
