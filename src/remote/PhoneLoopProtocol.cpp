#include "PhoneLoopProtocol.h"

#include <chrono>
#include <cmath>

namespace mosh::phoneloop
{
namespace
{
    /** The identifier charset the pad's zod contract allows, plus the 1..128 length
        bound. Deliberately narrow: these strings end up in command args and in the
        authority fingerprint, so anything that could be mistaken for JSON structure
        or a path separator is refused at the door. */
    bool isIdentifier (const juce::var& value)
    {
        if (! value.isString())
            return false;

        const auto text = value.toString();
        return text.isNotEmpty()
            && text.length() <= 128
            && text.containsOnly ("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.:{}");
    }

    bool isInteger (const juce::var& value) { return value.isInt() || value.isInt64(); }
    bool isNumber (const juce::var& value)  { return isInteger (value) || value.isDouble(); }

    bool isTargetedAction (const juce::String& action)
    {
        return action == "keep" || action == "again" || action == "hear";
    }

    /** A missing property, an explicit JSON null and an empty string all read back
        as "" — the authority is a change detector, not a record of which of those
        three the Mac happened to send. */
    juce::String textOf (const juce::var& value)
    {
        return value.toString();
    }

    juce::String partsOf (const juce::var& loopState)
    {
        const auto* contributions = loopState.getProperty ("contributions", juce::var()).getArray();
        if (contributions == nullptr)
            return {};

        juce::StringArray parts;
        for (const auto& part : *contributions)
            parts.add (textOf (part.getProperty ("id", juce::var()))
                       + ":" + ((bool) part.getProperty ("keeper", false) ? "k"
                                : (bool) part.getProperty ("rejected", false) ? "r" : "-"));
        return parts.joinIntoString (",");
    }
} // namespace

ParseResult parseRequest (const juce::var& body)
{
    auto fail = [] (const char* message) { return ParseResult { {}, message }; };

    if (! body.isObject() || ! isInteger (body["version"]) || (int) body["version"] != 1)
        return fail ("Unsupported phone protocol");

    for (auto field : { "requestId", "sessionId", "projectId" })
        if (! isIdentifier (body[field]))
            return fail ("Missing or invalid request identity");

    if (! body["authority"].isString() || body["authority"].toString().length() > 4096)
        return fail ("Missing state authority");

    if (! body["action"].isString())
        return fail ("Missing action");

    Request request;
    request.id = body["requestId"].toString();
    request.session = body["sessionId"].toString();
    request.project = body["projectId"].toString();
    request.authority = body["authority"].toString();
    request.action = body["action"].toString();

    if (request.action != "record" && request.action != "keep" && request.action != "again"
        && request.action != "hear" && request.action != "play_all" && request.action != "stop"
        && request.action != "navigate" && request.action != "home" && request.action != "lead_in")
        return fail ("Unknown action");

    if (body.hasProperty ("targetId"))
    {
        if (! isIdentifier (body["targetId"]))
            return fail ("Invalid selected take");
        request.target = body["targetId"].toString();
    }

    if (isTargetedAction (request.action) && ! request.target)
        return fail ("Select the exact take first");
    if (request.target && ! isTargetedAction (request.action))
        return fail ("Target supplied for an untargeted action");

    if (request.action == "navigate")
    {
        if (! isInteger (body["bar"])
            || (juce::int64) body["bar"] < 1
            || (juce::int64) body["bar"] > 1000000)
            return fail ("Enter a valid displayed bar");
        request.bar = (int) body["bar"];
    }
    else if (body.hasProperty ("bar"))
    {
        return fail ("Bar supplied for a non-navigation action");
    }

    if (request.action == "lead_in")
    {
        if (! isNumber (body["leadQn"]))
            return fail ("Enter a valid lead-in in quarter-note beats");

        const auto lead = (double) body["leadQn"];
        if (! std::isfinite (lead) || lead < 0.0 || lead > 256.0)
            return fail ("Enter a valid lead-in in quarter-note beats");
        request.leadQn = lead;
    }
    else if (body.hasProperty ("leadQn"))
    {
        return fail ("Lead-in supplied for a different action");
    }

    return { request, {} };
}

double steadyMs()
{
    return std::chrono::duration<double, std::milli> (
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

juce::String authorityFor (const juce::var& loopState)
{
    // Insertion order is the serialisation order, and the serialisation order is the
    // contract — the phone only ever compares whole strings.
    juce::DynamicObject::Ptr authority = new juce::DynamicObject();
    authority->setProperty ("project",     textOf (loopState.getProperty ("projectId", {})));
    authority->setProperty ("host",        textOf (loopState.getProperty ("host", {})));
    authority->setProperty ("lead",        textOf (loopState.getProperty ("leadTrackId", {})));
    authority->setProperty ("takes",       textOf (loopState.getProperty ("takesTrackId", {})));
    authority->setProperty ("phase",       textOf (loopState.getProperty ("phase", {})));
    authority->setProperty ("current",     textOf (loopState.getProperty ("currentId", {})));
    authority->setProperty ("last",        textOf (loopState.getProperty ("lastId", {})));
    authority->setProperty ("review",      textOf (loopState.getProperty ("reviewId", {})));
    authority->setProperty ("auditioned",  textOf (loopState.getProperty ("auditionedId", {})));

    const auto listening = loopState.getProperty ("listening", {});
    authority->setProperty ("listeningQn", textOf (listening.getProperty ("qn", {})));
    authority->setProperty ("leadQn",      textOf (listening.getProperty ("leadQn", {})));
    authority->setProperty ("parts",       partsOf (loopState));

    return juce::JSON::toString (juce::var (authority.get()), true);
}

bool compatibleAuthority (const juce::String& observed, const juce::var& loopState, bool stopOnly)
{
    if (! stopOnly)
        return observed == authorityFor (loopState);

    // Stop is the panic button: it must survive the state moving under the user, so
    // it only insists that the phone is still talking about the same loop on the
    // same host — not that the take list, phase or playhead are unchanged.
    const auto parsed = juce::JSON::parse (observed);
    if (! parsed.isObject())
        return false;

    const auto current = juce::JSON::parse (authorityFor (loopState));
    for (auto key : { "project", "host", "lead", "takes" })
        if (! parsed[key].isString() || parsed[key].toString() != current[key].toString())
            return false;

    return true;
}

juce::var receiptJson (const Receipt& receipt)
{
    auto* json = new juce::DynamicObject();
    json->setProperty ("requestId", receipt.requestId);
    json->setProperty ("action", receipt.action);
    json->setProperty ("status", receipt.status);
    json->setProperty ("detail", receipt.detail);
    json->setProperty ("submittedMs", receipt.submittedMs);
    json->setProperty ("completedMs", receipt.completedMs ? juce::var (*receipt.completedMs) : juce::var());
    json->setProperty ("actionId", receipt.actionId);
    json->setProperty ("targetId", receipt.target ? juce::var (*receipt.target) : juce::var());
    return juce::var (json);
}

} // namespace mosh::phoneloop
