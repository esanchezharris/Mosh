// G10 — write_automation_curve's bulk point-array validator golden vectors.
#include <catch2/catch_test_macros.hpp>
#include "moshops/AutomationCurveWrite.h"

using namespace mosh;

static juce::var pointObj (double t, double v, juce::var curve = {})
{
    auto* o = new juce::DynamicObject();
    o->setProperty ("t", t);
    o->setProperty ("v", v);
    if (! curve.isVoid()) o->setProperty ("curve", curve);
    return juce::var (o);
}

static juce::var pointsArray (std::initializer_list<juce::var> pts)
{
    juce::Array<juce::var> a;
    for (auto& p : pts) a.add (p);
    return juce::var (a);
}

TEST_CASE ("parseAutomationCurvePoints accepts a valid ascending array", "[automationcurvewrite]")
{
    auto r = parseAutomationCurvePoints (pointsArray ({ pointObj (0.0, 0.1), pointObj (1.0, 0.5), pointObj (2.0, 0.9) }));
    REQUIRE (r.ok);
    REQUIRE (r.points.size() == 3);
    REQUIRE (r.points[0].t == 0.0);
    REQUIRE (r.points[0].v == 0.1f);
    REQUIRE (r.points[2].t == 2.0);
    REQUIRE (r.points[2].v == 0.9f);
    // curve defaults to 0 when omitted
    REQUIRE (r.points[0].curve == 0.0f);
}

TEST_CASE ("parseAutomationCurvePoints carries an explicit curve amount", "[automationcurvewrite]")
{
    auto r = parseAutomationCurvePoints (pointsArray ({ pointObj (0.0, 0.5, -0.4), pointObj (1.0, 0.5, 0.7) }));
    REQUIRE (r.ok);
    REQUIRE (r.points[0].curve == -0.4f);
    REQUIRE (r.points[1].curve == 0.7f);
}

TEST_CASE ("parseAutomationCurvePoints rejects an empty array", "[automationcurvewrite]")
{
    auto r = parseAutomationCurvePoints (juce::var (juce::Array<juce::var>()));
    REQUIRE_FALSE (r.ok);
    REQUIRE (r.error.isNotEmpty());
}

TEST_CASE ("parseAutomationCurvePoints rejects a non-array", "[automationcurvewrite]")
{
    auto r = parseAutomationCurvePoints (juce::var (5.0));
    REQUIRE_FALSE (r.ok);
}

TEST_CASE ("parseAutomationCurvePoints rejects a point missing t or v", "[automationcurvewrite]")
{
    auto* missingV = new juce::DynamicObject(); missingV->setProperty ("t", 0.0);
    auto r = parseAutomationCurvePoints (pointsArray ({ juce::var (missingV) }));
    REQUIRE_FALSE (r.ok);
}

TEST_CASE ("parseAutomationCurvePoints rejects negative t", "[automationcurvewrite]")
{
    auto r = parseAutomationCurvePoints (pointsArray ({ pointObj (-0.1, 0.5) }));
    REQUIRE_FALSE (r.ok);
    REQUIRE (r.error.contains (">= 0"));
}

TEST_CASE ("parseAutomationCurvePoints rejects non-ascending t (including equal)", "[automationcurvewrite]")
{
    auto descending = parseAutomationCurvePoints (pointsArray ({ pointObj (1.0, 0.2), pointObj (0.5, 0.4) }));
    REQUIRE_FALSE (descending.ok);
    REQUIRE (descending.error.contains ("ascending"));

    auto equalTimes = parseAutomationCurvePoints (pointsArray ({ pointObj (1.0, 0.2), pointObj (1.0, 0.4) }));
    REQUIRE_FALSE (equalTimes.ok);
}

TEST_CASE ("parseAutomationCurvePoints rejects v outside 0..1", "[automationcurvewrite]")
{
    auto tooHigh = parseAutomationCurvePoints (pointsArray ({ pointObj (0.0, 1.5) }));
    REQUIRE_FALSE (tooHigh.ok);
    REQUIRE (tooHigh.error.contains ("0..1"));

    auto tooLow = parseAutomationCurvePoints (pointsArray ({ pointObj (0.0, -0.1) }));
    REQUIRE_FALSE (tooLow.ok);
}

TEST_CASE ("parseAutomationCurvePoints rejects curve outside -1..1", "[automationcurvewrite]")
{
    auto r = parseAutomationCurvePoints (pointsArray ({ pointObj (0.0, 0.5, 1.5) }));
    REQUIRE_FALSE (r.ok);
    REQUIRE (r.error.contains ("-1..1"));
}

TEST_CASE ("parseAutomationCurvePoints accepts a JSON-encoded string (the agent-catalog form)", "[automationcurvewrite]")
{
    auto r = parseAutomationCurvePoints (juce::var (juce::String ("[{\"t\":0,\"v\":0.2},{\"t\":2,\"v\":0.8}]")));
    REQUIRE (r.ok);
    REQUIRE (r.points.size() == 2);
    REQUIRE (r.points[0].t == 0.0);
    REQUIRE (r.points[1].v == 0.8f);
}

TEST_CASE ("parseAutomationCurvePoints rejects a malformed JSON string", "[automationcurvewrite]")
{
    auto r = parseAutomationCurvePoints (juce::var (juce::String ("not json")));
    REQUIRE_FALSE (r.ok);
}

TEST_CASE ("parseAutomationCurvePoints rejects a JSON string that isn't an array", "[automationcurvewrite]")
{
    auto r = parseAutomationCurvePoints (juce::var (juce::String ("{\"t\":0,\"v\":0.2}")));
    REQUIRE_FALSE (r.ok);
}

// ADVERSARIAL-REVIEW FIX — juce::var's numeric cast silently coerces a non-numeric value
// (string/bool/null) to 0.0 instead of failing; a rejected-BEFORE-mutating validator must not
// let a typo'd "t"/"v" silently become 0.0. Mirrors the mock's `typeof rec.t === "number"`
// (ui/src/bridge.mock.ts write_automation_curve).
TEST_CASE ("parseAutomationCurvePoints rejects a non-numeric t (string coerces to 0.0 otherwise)", "[automationcurvewrite]")
{
    auto* o = new juce::DynamicObject();
    o->setProperty ("t", "oops");
    o->setProperty ("v", 0.5);
    auto r = parseAutomationCurvePoints (pointsArray ({ juce::var (o) }));
    REQUIRE_FALSE (r.ok);
    REQUIRE (r.error.contains ("\"t\""));
    REQUIRE (r.error.contains ("numeric"));
}

TEST_CASE ("parseAutomationCurvePoints rejects a non-numeric v (string coerces to 0.0 otherwise)", "[automationcurvewrite]")
{
    auto* o = new juce::DynamicObject();
    o->setProperty ("t", 0.0);
    o->setProperty ("v", "half");
    auto r = parseAutomationCurvePoints (pointsArray ({ juce::var (o) }));
    REQUIRE_FALSE (r.ok);
    REQUIRE (r.error.contains ("\"v\""));
    REQUIRE (r.error.contains ("numeric"));
}

TEST_CASE ("parseAutomationCurvePoints rejects a bool t/v (bool is not numeric here)", "[automationcurvewrite]")
{
    auto* boolT = new juce::DynamicObject();
    boolT->setProperty ("t", juce::var (true));
    boolT->setProperty ("v", 0.5);
    auto r1 = parseAutomationCurvePoints (pointsArray ({ juce::var (boolT) }));
    REQUIRE_FALSE (r1.ok);

    auto* boolV = new juce::DynamicObject();
    boolV->setProperty ("t", 0.0);
    boolV->setProperty ("v", juce::var (false));
    auto r2 = parseAutomationCurvePoints (pointsArray ({ juce::var (boolV) }));
    REQUIRE_FALSE (r2.ok);
}

TEST_CASE ("parseAutomationCurvePoints rejects a null t/v", "[automationcurvewrite]")
{
    auto* nullT = new juce::DynamicObject();
    nullT->setProperty ("t", juce::var());
    nullT->setProperty ("v", 0.5);
    auto r = parseAutomationCurvePoints (pointsArray ({ juce::var (nullT) }));
    REQUIRE_FALSE (r.ok);
}

TEST_CASE ("parseAutomationCurvePoints still accepts an integer-valued t/v (isInt(), not just isDouble())", "[automationcurvewrite]")
{
    // JSON::parse yields an int var for "0"/"1" (no decimal point) rather than a double one —
    // the numeric guard must accept isInt()/isInt64() too, not just isDouble().
    auto r = parseAutomationCurvePoints (juce::var (juce::String ("[{\"t\":0,\"v\":0},{\"t\":1,\"v\":1}]")));
    REQUIRE (r.ok);
    REQUIRE (r.points.size() == 2);
}
