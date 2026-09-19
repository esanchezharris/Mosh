#include <catch2/catch_test_macros.hpp>

#include "remote/PhoneLoopProtocol.h"

using namespace mosh;

namespace
{
juce::var obj (std::initializer_list<std::pair<const char*, juce::var>> fields)
{
    auto* o = new juce::DynamicObject();
    for (const auto& field : fields)
        o->setProperty (juce::Identifier (field.first), field.second);
    return juce::var (o);
}

/** A well-formed `record` body; cases below mutate one field at a time so a
    failure names the field that broke rather than "the whole body is wrong". */
juce::var recordBody()
{
    return obj ({ { "version", 1 },
                  { "requestId", "req-1" },
                  { "sessionId", "sess-1" },
                  { "projectId", "proj-1" },
                  { "authority", "{}" },
                  { "action", "record" } });
}

juce::var withField (juce::var body, const char* name, const juce::var& value)
{
    body.getDynamicObject()->setProperty (juce::Identifier (name), value);
    return body;
}

juce::var withoutField (juce::var body, const char* name)
{
    body.getDynamicObject()->removeProperty (juce::Identifier (name));
    return body;
}

juce::var contribution (const char* id, bool keeper, bool rejected)
{
    return obj ({ { "id", id }, { "keeper", keeper }, { "rejected", rejected } });
}

/** A loop_state `data` payload with every authority-bearing field populated. */
juce::var loopState (const juce::var& contributions)
{
    return obj ({ { "projectId", "proj-1" },
                  { "host", "host-epoch-7" },
                  { "leadTrackId", "track-lead" },
                  { "takesTrackId", "track-takes" },
                  { "phase", "idle" },
                  { "currentId", "part-3" },
                  { "lastId", "part-3" },
                  { "reviewId", "part-2" },
                  { "auditionedId", juce::var() },
                  { "listening", obj ({ { "bar", 5 }, { "qn", 16.0 }, { "entryQn", juce::var() }, { "leadQn", 4.0 } }) },
                  { "contributions", contributions } });
}

juce::var threeParts()
{
    juce::Array<juce::var> parts;
    parts.add (contribution ("part-1", true, false));
    parts.add (contribution ("part-2", false, true));
    parts.add (contribution ("part-3", false, false));
    return juce::var (parts);
}
} // namespace

TEST_CASE ("phone loop parseRequest accepts the three shapes the pad can send", "[phoneloop][protocol]")
{
    const auto record = phoneloop::parseRequest (recordBody());
    REQUIRE (record.request.has_value());
    CHECK (record.error.isEmpty());
    CHECK (record.request->id == "req-1");
    CHECK (record.request->session == "sess-1");
    CHECK (record.request->project == "proj-1");
    CHECK (record.request->action == "record");
    CHECK_FALSE (record.request->target.has_value());
    CHECK_FALSE (record.request->bar.has_value());
    CHECK_FALSE (record.request->leadQn.has_value());

    const auto navigate = phoneloop::parseRequest (
        withField (withField (recordBody(), "action", "navigate"), "bar", 12));
    REQUIRE (navigate.request.has_value());
    REQUIRE (navigate.request->bar.has_value());
    CHECK (*navigate.request->bar == 12);

    const auto leadIn = phoneloop::parseRequest (
        withField (withField (recordBody(), "action", "lead_in"), "leadQn", 2.5));
    REQUIRE (leadIn.request.has_value());
    REQUIRE (leadIn.request->leadQn.has_value());
    CHECK (*leadIn.request->leadQn == 2.5);

    const auto keep = phoneloop::parseRequest (
        withField (withField (recordBody(), "action", "keep"), "targetId", "part-2"));
    REQUIRE (keep.request.has_value());
    REQUIRE (keep.request->target.has_value());
    CHECK (*keep.request->target == "part-2");
}

TEST_CASE ("phone loop parseRequest rejects malformed bodies with the phone-facing sentence", "[phoneloop][protocol]")
{
    auto rejects = [] (const juce::var& body, const char* expected) {
        const auto parsed = phoneloop::parseRequest (body);
        INFO ("body: " << juce::JSON::toString (body, true));
        CHECK_FALSE (parsed.request.has_value());
        CHECK (parsed.error == juce::String (expected));
    };

    rejects (withoutField (recordBody(), "version"), "Unsupported phone protocol");
    rejects (withField (recordBody(), "version", 2), "Unsupported phone protocol");
    rejects (withField (recordBody(), "version", "1"), "Unsupported phone protocol");
    rejects (withField (recordBody(), "requestId", "req 1!"), "Missing or invalid request identity");
    rejects (withField (recordBody(), "sessionId", ""), "Missing or invalid request identity");
    rejects (withoutField (recordBody(), "authority"), "Missing state authority");
    rejects (withField (recordBody(), "action", "delete_everything"), "Unknown action");

    // Targets: required for the three take-scoped actions, forbidden everywhere else.
    rejects (withField (recordBody(), "targetId", "part-2"), "Target supplied for an untargeted action");
    rejects (withField (recordBody(), "action", "keep"), "Select the exact take first");
    rejects (withField (withField (recordBody(), "action", "hear"), "targetId", "part 2!"), "Invalid selected take");

    // Bars belong to navigate only, and must be a positive integer.
    rejects (withField (recordBody(), "bar", 4), "Bar supplied for a non-navigation action");
    rejects (withField (withField (recordBody(), "action", "navigate"), "bar", 0), "Enter a valid displayed bar");
    rejects (withField (withField (recordBody(), "action", "navigate"), "bar", 1000001), "Enter a valid displayed bar");
    rejects (withField (recordBody(), "action", "navigate"), "Enter a valid displayed bar");

    // Lead-in belongs to lead_in only, and is clamped to a musical range.
    rejects (withField (recordBody(), "leadQn", 2.0), "Lead-in supplied for a different action");
    rejects (withField (withField (recordBody(), "action", "lead_in"), "leadQn", 300.0),
             "Enter a valid lead-in in quarter-note beats");
    rejects (withField (withField (recordBody(), "action", "lead_in"), "leadQn", -1.0),
             "Enter a valid lead-in in quarter-note beats");
    rejects (withField (recordBody(), "action", "lead_in"), "Enter a valid lead-in in quarter-note beats");
}

TEST_CASE ("phone loop authorityFor is stable, ordered, and moves with the take flags", "[phoneloop][protocol]")
{
    const auto state = loopState (threeParts());
    const auto authority = phoneloop::authorityFor (state);

    // Key order is part of the contract: the phone compares authority strings
    // verbatim, so a reordered serialisation would look like a state change.
    const char* const keys[] { "\"project\"", "\"host\"", "\"lead\"", "\"takes\"", "\"phase\"",
                               "\"current\"", "\"last\"", "\"review\"", "\"auditioned\"",
                               "\"listeningQn\"", "\"leadQn\"", "\"parts\"" };
    int previous = -1;
    for (const auto* key : keys)
    {
        const int at = authority.indexOf (juce::String (key));
        INFO ("key: " << key << " in " << authority);
        REQUIRE (at > previous);
        previous = at;
    }

    const auto parsed = juce::JSON::parse (authority);
    REQUIRE (parsed.isObject());
    CHECK (parsed.getProperty ("project", {}).toString() == "proj-1");
    CHECK (parsed.getProperty ("host", {}).toString() == "host-epoch-7");
    CHECK (parsed.getProperty ("lead", {}).toString() == "track-lead");
    CHECK (parsed.getProperty ("takes", {}).toString() == "track-takes");
    CHECK (parsed.getProperty ("review", {}).toString() == "part-2");
    CHECK (parsed.getProperty ("auditioned", {}).toString().isEmpty()); // absent/null -> ""
    CHECK (parsed.getProperty ("parts", {}).toString() == "part-1:k,part-2:r,part-3:-");

    // Stability: the same state twice is byte-identical.
    CHECK (phoneloop::authorityFor (state) == authority);

    // A flipped keeper flag must change the fingerprint, or "refresh before you
    // choose a target" would never fire for the edit the user is most likely to race.
    juce::Array<juce::var> flipped;
    flipped.add (contribution ("part-1", false, false));
    flipped.add (contribution ("part-2", false, true));
    flipped.add (contribution ("part-3", false, false));
    const auto after = phoneloop::authorityFor (loopState (juce::var (flipped)));
    CHECK (after != authority);
    CHECK (juce::JSON::parse (after).getProperty ("parts", {}).toString() == "part-1:-,part-2:r,part-3:-");
}

TEST_CASE ("phone loop authorityFor treats missing loop state as empty rather than failing", "[phoneloop][protocol]")
{
    const auto empty = phoneloop::authorityFor (juce::var());
    const auto parsed = juce::JSON::parse (empty);
    REQUIRE (parsed.isObject());
    CHECK (parsed.getProperty ("project", {}).toString().isEmpty());
    CHECK (parsed.getProperty ("parts", {}).toString().isEmpty());
    CHECK (phoneloop::authorityFor (juce::var()) == empty);
}

TEST_CASE ("phone loop compatibleAuthority is exact for mutations and a subset for stop", "[phoneloop][protocol]")
{
    const auto state = loopState (threeParts());
    const auto observed = phoneloop::authorityFor (state);

    CHECK (phoneloop::compatibleAuthority (observed, state, false));
    CHECK (phoneloop::compatibleAuthority (observed, state, true));

    auto movedPhase = state.clone();
    movedPhase.getDynamicObject()->setProperty ("phase", "recording");
    CHECK_FALSE (phoneloop::compatibleAuthority (observed, movedPhase, false));
    CHECK (phoneloop::compatibleAuthority (observed, movedPhase, true)); // stop still works

    auto movedLead = state.clone();
    movedLead.getDynamicObject()->setProperty ("leadTrackId", "track-other");
    CHECK_FALSE (phoneloop::compatibleAuthority (observed, movedLead, false));
    CHECK_FALSE (phoneloop::compatibleAuthority (observed, movedLead, true)); // a different track is a different loop

    CHECK_FALSE (phoneloop::compatibleAuthority ("not json", state, true));
    CHECK_FALSE (phoneloop::compatibleAuthority ("not json", state, false));
}

TEST_CASE ("phone loop receiptJson carries nulls the pad's schema expects", "[phoneloop][protocol]")
{
    phoneloop::Receipt running;
    running.requestId = "req-1";
    running.action = "record";
    running.submittedMs = 1234.5;

    const auto inFlight = phoneloop::receiptJson (running);
    CHECK (inFlight.getProperty ("requestId", {}).toString() == "req-1");
    CHECK (inFlight.getProperty ("action", {}).toString() == "record");
    CHECK (inFlight.getProperty ("status", {}).toString() == "accepted");
    CHECK (inFlight.getProperty ("detail", {}).toString().isEmpty());
    CHECK ((double) inFlight.getProperty ("submittedMs", 0.0) == 1234.5);
    CHECK (inFlight.getProperty ("completedMs", "sentinel").isVoid()); // null while running
    CHECK (inFlight.getProperty ("targetId", "sentinel").isVoid());    // null when untargeted
    CHECK (inFlight.getProperty ("actionId", {}).toString().isEmpty());

    phoneloop::Receipt done = running;
    done.action = "keep";
    done.status = "completed";
    done.detail = "Kept part 2";
    done.actionId = "act-9";
    done.target = juce::String ("part-2");
    done.completedMs = 2000.0;

    const auto terminal = phoneloop::receiptJson (done);
    CHECK (terminal.getProperty ("status", {}).toString() == "completed");
    CHECK (terminal.getProperty ("detail", {}).toString() == "Kept part 2");
    CHECK (terminal.getProperty ("actionId", {}).toString() == "act-9");
    CHECK (terminal.getProperty ("targetId", {}).toString() == "part-2");
    CHECK ((double) terminal.getProperty ("completedMs", 0.0) == 2000.0);
}

TEST_CASE ("phone loop steadyMs advances monotonically", "[phoneloop][protocol]")
{
    const auto first = phoneloop::steadyMs();
    const auto second = phoneloop::steadyMs();
    CHECK (first > 0.0);
    CHECK (second >= first);
}
