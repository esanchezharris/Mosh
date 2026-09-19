#pragma once

#include "PhoneLoopProtocol.h"

#include <juce_core/juce_core.h>

#include <atomic>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <vector>

namespace mosh
{

/** GET /api/state and POST /api/action for the phone pad, with no engine in sight.

    Every user-visible mutation leaves here as a MoshOps command (`loop_<action>`)
    handed to the injected executor — this class never touches Tracktion, and the
    executor is what carries the call onto the message thread. That keeps the HTTP
    surface testable against a fake executor and keeps the one-mutation-path
    invariant intact.

    It owns exactly three pieces of state the transport needs and MoshOps does not:
    the phone session id (so a re-pair invalidates in-flight commands), the receipt
    ledger the pad renders, and the requestId dedup barrier that makes a retried
    POST replay its receipt instead of recording twice.
*/
class PhoneLoopEndpoint
{
public:
    /** {command, args} -> the MoshOps result envelope {ok, error?, data?}. */
    using Execute = std::function<juce::var (const juce::var& command)>;

    explicit PhoneLoopEndpoint (Execute executeCommand);

    /** New session id, empty receipt ledger, empty dedup barrier. Called whenever
        pairing changes, so a phone holding a stale page cannot resubmit into it. */
    void resetSession();

    /** GET /api/state. Always HTTP 200: an unreachable host is reported inside the
        state (hostAlive:false) rather than as a transport failure, because the pad
        distinguishes "Mac is quiet" from "pair again" by status code. */
    juce::var state (int& httpStatus);

    /** POST /api/action. HTTP 200 for every outcome the phone can act on: a parse
        failure is `{error}`, everything else is `{version, receipt, state}`. */
    juce::var action (const juce::var& body, int& httpStatus);

    juce::String sessionId() const;

private:
    struct Record
    {
        phoneloop::Receipt receipt;
        juce::String fingerprint;
    };

    /** The most recent receipts, oldest first, as the pad's ledger. */
    static constexpr int maxReceiptsShown = 64;
    /** Dedup barrier capacity; oldest completed record is evicted at the ceiling. */
    static constexpr size_t maxRecords = 1024;

    juce::var buildState();
    juce::var respond (const phoneloop::Receipt& receipt);
    void runCommand (const phoneloop::Request& request, phoneloop::Receipt& receipt);

    Execute execute;

    mutable std::mutex ledgerMutex;      // guards session, records and order
    std::mutex admissionMutex;           // one POST at a time
    std::atomic<bool> executing { false };

    juce::String session;
    std::map<std::string, Record> records;
    std::vector<std::string> order;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (PhoneLoopEndpoint)
};

} // namespace mosh
