#include "PhoneLoopEndpoint.h"

#include <algorithm>

namespace mosh
{
namespace
{
    /** The pad's schema types every id as `string | null`, so an absent or empty id
        has to go out as JSON null rather than "". */
    juce::var optionalId (const juce::String& id)
    {
        return id.isNotEmpty() ? juce::var (id) : juce::var();
    }

    juce::var optionalNumber (const juce::var& value)
    {
        return value.isVoid() || value.isUndefined() ? juce::var() : juce::var ((double) value);
    }

    juce::var phoneError (const juce::String& message)
    {
        auto* error = new juce::DynamicObject();
        error->setProperty ("error", message);
        return juce::var (error);
    }
} // namespace

PhoneLoopEndpoint::PhoneLoopEndpoint (Execute executeCommand)
    : execute (std::move (executeCommand))
{
    resetSession();
}

void PhoneLoopEndpoint::resetSession()
{
    const std::lock_guard<std::mutex> ledger (ledgerMutex);
    session = juce::Uuid().toString(); // 32 hex characters, no dashes
    records.clear();
    order.clear();
}

juce::String PhoneLoopEndpoint::sessionId() const
{
    const std::lock_guard<std::mutex> ledger (ledgerMutex);
    return session;
}

juce::var PhoneLoopEndpoint::buildState()
{
    auto* args = new juce::DynamicObject();
    args->setProperty ("phonePoll", true);
    auto* poll = new juce::DynamicObject();
    poll->setProperty ("command", "loop_state");
    poll->setProperty ("args", juce::var (args));

    const auto result = execute ? execute (juce::var (poll)) : juce::var();

    // A command that never came back is reported inside the state, not as an HTTP
    // failure: the pad shows "Mosh is not responding" and keeps polling, where a
    // non-2xx would send the user back to the QR code for no reason.
    const bool hostAlive = (bool) result.getProperty ("ok", false);
    const auto loop = hostAlive ? result.getProperty ("data", juce::var()) : juce::var();

    const auto phase = hostAlive ? loop.getProperty ("phase", {}).toString() : juce::String ("offline");
    const bool engaged = hostAlive && (bool) loop.getProperty ("engaged", false);
    const auto transport = loop.getProperty ("transport", {});
    const bool playing = (bool) transport.getProperty ("playing", false);
    const auto auditionedId = loop.getProperty ("auditionedId", {}).toString();

    const auto sourceListening = loop.getProperty ("listening", {});
    auto* listening = new juce::DynamicObject();
    // Bars are 1-based and displayed, so an absent bar reads as the project start
    // rather than a bar 0 the pad would happily render.
    listening->setProperty ("bar", (double) sourceListening.getProperty ("bar", 1.0));
    listening->setProperty ("qn", (double) sourceListening.getProperty ("qn", 0.0));
    listening->setProperty ("entryQn", optionalNumber (sourceListening.getProperty ("entryQn", juce::var())));
    listening->setProperty ("leadQn", (double) sourceListening.getProperty ("leadQn", 0.0));

    // Stripped to exactly what the pad renders: no file paths, no engine ids.
    juce::Array<juce::var> contributions;
    if (const auto* source = loop.getProperty ("contributions", {}).getArray())
    {
        int number = 0;
        for (const auto& part : *source)
        {
            ++number;
            const auto label = part.getProperty ("label", {}).toString();
            auto* entry = new juce::DynamicObject();
            entry->setProperty ("id", part.getProperty ("id", {}).toString());
            entry->setProperty ("label", label.isNotEmpty() ? label : "Part " + juce::String (number));
            entry->setProperty ("keeper", (bool) part.getProperty ("keeper", false));
            entry->setProperty ("rejected", (bool) part.getProperty ("rejected", false));
            contributions.add (juce::var (entry));
        }
    }

    juce::Array<juce::var> receipts;
    {
        const std::lock_guard<std::mutex> ledger (ledgerMutex);
        const auto shown = (size_t) maxReceiptsShown;
        for (auto i = order.size() > shown ? order.size() - shown : (size_t) 0; i < order.size(); ++i)
            if (const auto found = records.find (order[i]); found != records.end())
                receipts.add (phoneloop::receiptJson (found->second.receipt));
    }

    auto* state = new juce::DynamicObject();
    state->setProperty ("version", 1);
    state->setProperty ("sessionId", sessionId());
    state->setProperty ("projectId", loop.getProperty ("projectId", {}).toString());
    state->setProperty ("authority", phoneloop::authorityFor (loop));
    state->setProperty ("phase", phase);
    state->setProperty ("engaged", engaged);
    state->setProperty ("hostAlive", hostAlive);
    state->setProperty ("busy", executing.load() || phase == "count_in");
    state->setProperty ("recording", (bool) transport.getProperty ("recording", false));
    state->setProperty ("playing", playing);
    state->setProperty ("playbackScope", ! playing ? "none" : auditionedId.isNotEmpty() ? "selected" : "arrangement");
    state->setProperty ("listening", juce::var (listening));
    state->setProperty ("currentId", optionalId (loop.getProperty ("currentId", {}).toString()));
    state->setProperty ("lastId", optionalId (loop.getProperty ("lastId", {}).toString()));
    state->setProperty ("reviewId", optionalId (loop.getProperty ("reviewId", {}).toString()));
    state->setProperty ("auditionedId", optionalId (auditionedId));
    state->setProperty ("contributions", contributions);
    state->setProperty ("receipts", receipts);
    state->setProperty ("error", ! hostAlive ? juce::String ("Mosh is not responding on the Mac.")
                                : ! engaged  ? juce::String ("Pick a track on the Mac first (Setup).")
                                             : loop.getProperty ("blockReason", {}).toString());
    return juce::var (state);
}

juce::var PhoneLoopEndpoint::respond (const phoneloop::Receipt& receipt)
{
    auto* response = new juce::DynamicObject();
    response->setProperty ("version", 1);
    response->setProperty ("receipt", phoneloop::receiptJson (receipt));
    response->setProperty ("state", buildState());
    return juce::var (response);
}

void PhoneLoopEndpoint::runCommand (const phoneloop::Request& request, phoneloop::Receipt& receipt)
{
    auto* args = new juce::DynamicObject();
    args->setProperty ("requestId", request.id);
    args->setProperty ("projectId", request.project);
    args->setProperty ("authority", request.authority);
    if (request.target)
        args->setProperty ("targetId", *request.target);
    if (request.bar)
        args->setProperty ("bar", *request.bar);
    if (request.leadQn)
        args->setProperty ("leadQn", *request.leadQn);

    auto* command = new juce::DynamicObject();
    command->setProperty ("command", "loop_" + request.action);
    command->setProperty ("args", juce::var (args));

    executing = true;
    const auto result = execute ? execute (juce::var (command)) : juce::var();
    executing = false;

    const bool applied = (bool) result.getProperty ("ok", false);
    const auto error = result.getProperty ("error", {}).toString();
    const auto data = result.getProperty ("data", {});

    if (! applied && error.contains ("timed out"))
    {
        // The Mac never answered, but the command may still be running there — the
        // phone must not conclude "nothing happened", only "I cannot confirm it".
        receipt.status = "cancelled";
        receipt.detail = "No confirmation from the Mac within the time limit; the state shown is authoritative.";
    }
    else if (! applied)
    {
        receipt.status = "rejected";
        receipt.detail = error;
    }
    else if (data.hasProperty ("applied") && ! (bool) data.getProperty ("applied", true))
    {
        receipt.status = "rejected";
        receipt.detail = data.getProperty ("reason", {}).toString();
    }
    else
    {
        const auto detail = data.getProperty ("detail", {}).toString();
        const auto actionId = data.getProperty ("actionId", {}).toString();
        receipt.status = "completed";
        receipt.detail = detail.isNotEmpty() ? detail : request.action + ": completed";
        receipt.actionId = actionId.isNotEmpty() ? actionId : request.id;
    }

    receipt.completedMs = phoneloop::steadyMs();
}

juce::var PhoneLoopEndpoint::state (int& httpStatus)
{
    httpStatus = 200;
    return buildState();
}

juce::var PhoneLoopEndpoint::action (const juce::var& body, int& httpStatus)
{
    httpStatus = 200;

    // One phone command at a time. The pad is a single screen in one hand; serialising
    // admission here is what lets the dedup barrier below be a simple lookup rather
    // than a race between two POSTs carrying the same request id.
    const std::lock_guard<std::mutex> admission (admissionMutex);

    const auto parsed = phoneloop::parseRequest (body);
    if (! parsed.request)
        return phoneError (parsed.error); // nothing stored: the id stays usable

    const auto& request = *parsed.request;
    const auto cue = request.id.toStdString();
    const auto fingerprint = juce::JSON::toString (body, true);

    phoneloop::Receipt receipt;
    receipt.requestId = request.id;
    receipt.action = request.action;
    receipt.target = request.target;
    receipt.submittedMs = phoneloop::steadyMs();

    auto refuse = [&receipt] (const juce::String& reason) {
        receipt.status = "rejected";
        receipt.detail = reason;
        receipt.completedMs = phoneloop::steadyMs();
    };

    bool duplicate = false;
    {
        const std::lock_guard<std::mutex> ledger (ledgerMutex);
        if (const auto found = records.find (cue); found != records.end())
        {
            duplicate = true;
            if (found->second.fingerprint == fingerprint)
                receipt = found->second.receipt; // a retried POST replays, it does not re-run
            else
                refuse ("Request ID was already used for different content; refresh state.");
        }
        else
        {
            while (records.size() >= maxRecords)
            {
                const auto oldest = std::find_if (order.begin(), order.end(), [this] (const auto& id) {
                    const auto record = records.find (id);
                    return record != records.end() && record->second.receipt.completedMs.has_value();
                });
                if (oldest == order.end())
                    break; // everything still in flight; keep the barrier intact

                records.erase (*oldest);
                order.erase (oldest);
            }
        }
    }

    if (duplicate)
        return respond (receipt);

    if (request.session != sessionId())
        refuse ("Phone session changed; refresh state.");
    else
        runCommand (request, receipt);

    {
        const std::lock_guard<std::mutex> ledger (ledgerMutex);
        records.emplace (cue, Record { receipt, fingerprint });
        order.push_back (cue);
    }

    return respond (receipt);
}

} // namespace mosh
