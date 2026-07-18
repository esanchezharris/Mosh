// G10 — automation record-arm mode string parser golden vectors.
#include <catch2/catch_test_macros.hpp>
#include "moshops/AutomationMode.h"

using namespace mosh;

TEST_CASE ("parseAutomationRecordMode accepts all 4 values, case-insensitive + trimmed", "[automationmode]")
{
    auto r = parseAutomationRecordMode ("read");
    REQUIRE (r.ok);
    REQUIRE (r.mode == AutomationRecordMode::read);

    auto t = parseAutomationRecordMode ("Touch");
    REQUIRE (t.ok);
    REQUIRE (t.mode == AutomationRecordMode::touch);

    auto l = parseAutomationRecordMode ("  LATCH  ");
    REQUIRE (l.ok);
    REQUIRE (l.mode == AutomationRecordMode::latch);

    auto w = parseAutomationRecordMode ("write");
    REQUIRE (w.ok);
    REQUIRE (w.mode == AutomationRecordMode::write);
}

TEST_CASE ("parseAutomationRecordMode rejects an unknown mode with a helpful error", "[automationmode]")
{
    auto r = parseAutomationRecordMode ("bogus");
    REQUIRE_FALSE (r.ok);
    REQUIRE (r.error.contains ("read|touch|latch|write"));
    REQUIRE (r.error.contains ("bogus"));
}

TEST_CASE ("parseAutomationRecordMode rejects empty string", "[automationmode]")
{
    auto r = parseAutomationRecordMode ("");
    REQUIRE_FALSE (r.ok);
}

TEST_CASE ("automationRecordModeToString round-trips every value", "[automationmode]")
{
    REQUIRE (juce::String (automationRecordModeToString (AutomationRecordMode::read))  == "read");
    REQUIRE (juce::String (automationRecordModeToString (AutomationRecordMode::touch)) == "touch");
    REQUIRE (juce::String (automationRecordModeToString (AutomationRecordMode::latch)) == "latch");
    REQUIRE (juce::String (automationRecordModeToString (AutomationRecordMode::write)) == "write");

    for (auto s : { "read", "touch", "latch", "write" })
    {
        auto parsed = parseAutomationRecordMode (s);
        REQUIRE (parsed.ok);
        REQUIRE (juce::String (automationRecordModeToString (parsed.mode)) == juce::String (s));
    }
}
