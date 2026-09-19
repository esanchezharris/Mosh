#pragma once

#include <juce_core/juce_core.h>

#include <optional>

/** Wire contract for the Moshi phone pad (the iPhone Safari page served at /pad).

    Pure, engine-free request/receipt/authority logic shared by the HTTP endpoint and
    its tests: nothing here touches Tracktion, MoshOps, or the message thread. The
    shapes mirror ui/phone's zod contract exactly — a field renamed here is a phone
    that stops parsing, not a compile error, so the tests pin the JSON.
*/
namespace mosh::phoneloop
{

/** One validated phone command. `action` is already known-good; the optional
    fields are present only for the actions that are allowed to carry them. */
struct Request
{
    juce::String id;
    juce::String session;
    juce::String project;
    juce::String authority;
    juce::String action;
    std::optional<juce::String> target;
    std::optional<int> bar;
    std::optional<double> leadQn;
};

struct ParseResult
{
    std::optional<Request> request;
    juce::String error;
};

/** Validates a phone POST body. On failure `request` is empty and `error` carries
    the phone-facing sentence to echo back as `{error}` with HTTP 200. */
ParseResult parseRequest (const juce::var& body);

/** The phone's record of one submitted action. `status` starts "accepted" and ends
    at one of completed / rejected / cancelled; `completedMs` is set exactly once. */
struct Receipt
{
    juce::String requestId;
    juce::String action;
    juce::String status { "accepted" };
    juce::String detail;
    juce::String actionId;
    std::optional<juce::String> target;
    double submittedMs = 0.0;
    std::optional<double> completedMs;
};

/** {requestId, action, status, detail, submittedMs, completedMs|null, actionId, targetId|null} */
juce::var receiptJson (const Receipt& receipt);

/** Monotonic milliseconds, for receipt timings the phone can subtract. */
double steadyMs();

/** A compact fingerprint of everything the phone had on screen when it chose an
    action. The phone echoes it back with each command; a mismatch means the Mac
    moved on and the request targets a state the user never saw.

    Key order is fixed and part of the contract (the phone compares strings). */
juce::String authorityFor (const juce::var& loopState);

/** Non-stop actions require an exact authority match. Stop is deliberately looser:
    it only requires the same project/host/lead/takes, so the panic button still
    works after the state has moved under the user. */
bool compatibleAuthority (const juce::String& observed, const juce::var& loopState, bool stopOnly);

} // namespace mosh::phoneloop
