#include <catch2/catch_test_macros.hpp>
#include "app/InstancePolicy.h"

TEST_CASE ("interactive Mosh is single-instance while harness children remain independent",
           "[app][instance-policy]")
{
    REQUIRE_FALSE (mosh::instancepolicy::allowsMultipleInstances ({}));
    REQUIRE_FALSE (mosh::instancepolicy::allowsMultipleInstances ({ "--mosh-repair-id", "repair-id" }));
    REQUIRE_FALSE (mosh::instancepolicy::allowsMultipleInstances ({ "--demo3" }));
    REQUIRE_FALSE (mosh::instancepolicy::allowsMultipleInstances ({ "/tmp/--selftest-project.tracktionedit" }));

    REQUIRE (mosh::instancepolicy::allowsMultipleInstances ({ "--selftest" }));
    REQUIRE (mosh::instancepolicy::allowsMultipleInstances ({ "--selftest-undo" }));
    REQUIRE (mosh::instancepolicy::allowsMultipleInstances ({ "--run-script" }));
    REQUIRE (mosh::instancepolicy::allowsMultipleInstances ({ "--audio-probe", "nonce" }));
    REQUIRE (mosh::instancepolicy::allowsMultipleInstances ({ "--audio-recovery-smoke" }));
    REQUIRE (mosh::instancepolicy::allowsMultipleInstances ({ "--PluginScan:pipe-token" }));
}
