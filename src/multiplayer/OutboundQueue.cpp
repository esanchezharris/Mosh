#include "OutboundQueue.h"

namespace mosh
{

void OutboundQueue::pushCoalesced (const juce::String& key, juce::var msg)
{
    const std::lock_guard<std::mutex> lk (m_);
    coalesced_[key] = std::move (msg);   // latest-per-key wins
}

void OutboundQueue::pushFifo (juce::var msg)
{
    const std::lock_guard<std::mutex> lk (m_);
    fifo_.push_back (std::move (msg));
}

std::vector<juce::var> OutboundQueue::drain()
{
    std::deque<juce::var>             fifo;
    std::map<juce::String, juce::var> coalesced;
    {
        const std::lock_guard<std::mutex> lk (m_);
        fifo.swap (fifo_);
        coalesced.swap (coalesced_);
    }

    std::vector<juce::var> out;
    out.reserve (fifo.size() + coalesced.size());
    for (auto& v : fifo)            out.push_back (std::move (v));        // FIFO, in order
    for (auto& kv : coalesced)      out.push_back (std::move (kv.second)); // then coalesced, key-sorted
    return out;
}

int OutboundQueue::pending() const
{
    const std::lock_guard<std::mutex> lk (m_);
    return (int) fifo_.size() + (int) coalesced_.size();
}

} // namespace mosh
