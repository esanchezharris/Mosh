#include "Breadcrumbs.h"
#include "CrashReportFormatter.h"
#include <cstring>

namespace mosh::telemetry
{

std::mutex Breadcrumbs::mutex_;
Breadcrumbs::Slot Breadcrumbs::ring_[Breadcrumbs::kCapacity];
int Breadcrumbs::count_ = 0;
int Breadcrumbs::next_  = 0;

void Breadcrumbs::record (const juce::String& rawCommandName)
{
    // Redact BEFORE taking the lock / touching the ring — sanitizeCommandName()
    // never allocates unboundedly and is pure, so this is cheap either way.
    const auto safe = sanitizeCommandName (rawCommandName);
    const auto utf8  = safe.toRawUTF8();

    std::lock_guard<std::mutex> lock (mutex_);
    auto& slot = ring_[next_];
    std::memset (slot.name, 0, sizeof (slot.name));
    std::strncpy (slot.name, utf8, kMaxNameLen);
    slot.name[kMaxNameLen] = '\0';

    next_ = (next_ + 1) % kCapacity;
    if (count_ < kCapacity)
        ++count_;
}

int Breadcrumbs::snapshot (Slot* out, int outCapacity) noexcept
{
    std::unique_lock<std::mutex> lock (mutex_, std::try_to_lock);
    if (! lock.owns_lock())
        return 0; // never block in a signal-handler caller — see class comment

    const int n = juce::jmin (count_, outCapacity);
    // Oldest-first: when the ring is full, the oldest slot is `next_` (about to be
    // overwritten); when it isn't full yet, the oldest slot is simply index 0.
    const int start = (count_ < kCapacity) ? 0 : next_;
    for (int i = 0; i < n; ++i)
        out[i] = ring_[(start + i) % kCapacity];
    return n;
}

void Breadcrumbs::resetForTests()
{
    std::lock_guard<std::mutex> lock (mutex_);
    for (auto& slot : ring_)
        std::memset (slot.name, 0, sizeof (slot.name));
    count_ = 0;
    next_  = 0;
}

} // namespace mosh::telemetry
