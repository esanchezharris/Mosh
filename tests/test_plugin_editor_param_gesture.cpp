#include <catch2/catch_test_macros.hpp>
#include "plugins/hosting/PluginEditorParamGesture.h"

using mosh::PluginEditorParamGesture;

TEST_CASE ("plugin editor parameter changes retain their exact before and after values")
{
    PluginEditorParamGesture gesture (0.50f);

    const auto change = gesture.valueChanged (0.20f);
    REQUIRE (change.has_value());
    CHECK (change->before == 0.50f);
    CHECK (change->after == 0.20f);
    CHECK_FALSE (gesture.valueChanged (0.20f).has_value());
}

TEST_CASE ("plugin editor drag gesture coalesces to one undoable change")
{
    PluginEditorParamGesture gesture (0.50f);

    gesture.begin();
    CHECK_FALSE (gesture.valueChanged (0.40f).has_value());
    CHECK_FALSE (gesture.valueChanged (0.30f).has_value());
    CHECK_FALSE (gesture.valueChanged (0.20f).has_value());

    const auto change = gesture.end();
    REQUIRE (change.has_value());
    CHECK (change->before == 0.50f);
    CHECK (change->after == 0.20f);
}

TEST_CASE ("closing an editor flushes an unfinished parameter gesture")
{
    PluginEditorParamGesture gesture (0.75f);

    gesture.begin();
    CHECK_FALSE (gesture.valueChanged (0.10f).has_value());

    const auto change = gesture.finish();
    REQUIRE (change.has_value());
    CHECK (change->before == 0.75f);
    CHECK (change->after == 0.10f);
    CHECK_FALSE (gesture.finish().has_value());
}

TEST_CASE ("application teardown cancels an unfinished editor gesture")
{
    PluginEditorParamGesture gesture (0.75f);

    gesture.begin();
    CHECK_FALSE (gesture.valueChanged (0.10f).has_value());
    gesture.cancel();

    CHECK_FALSE (gesture.finish().has_value());
}

TEST_CASE ("rejected plugin editor change resynchronizes to the restored value")
{
    PluginEditorParamGesture gesture (0.50f);

    REQUIRE (gesture.valueChanged (0.20f).has_value());
    gesture.sync (0.50f);

    const auto retried = gesture.valueChanged (0.20f);
    REQUIRE (retried.has_value());
    CHECK (retried->before == 0.50f);
    CHECK (retried->after == 0.20f);
}
