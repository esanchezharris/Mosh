#include <catch2/catch_test_macros.hpp>
#include "plugins/transform/RaveEngine.h"

// AL-022 — RaveEngine::lastError() is an additive diagnostic surface for a
// failed prepare()/loadModel() (both previously swallowed the failure into a
// bare `false`/silent no-op with no way to learn why). The Route C.2 anira+
// LibTorch path itself is gated behind -DMOSH_ENABLE_ANIRA=ON (a large,
// separately-built dependency; the default build and this test target never
// define MOSH_HAVE_ANIRA), so this test cannot exercise a REAL model-load
// failure here -- it proves the additive API is compile-safe and behaves
// correctly in the default (anira-off) configuration, where RaveEngine is a
// graceful no-op stub. The real failure-diagnostic path (bad model file,
// tensor-shape mismatch, backend init failure) is exercised by hand when
// building with -DMOSH_ENABLE_ANIRA=ON (see RaveEngine.cpp's catch blocks).

TEST_CASE ("RaveEngine::lastError() compiles and is empty on a fresh, anira-off engine", "[rave]")
{
    mosh::RaveEngine engine;
    REQUIRE (engine.lastError().empty());
    REQUIRE_FALSE (engine.ready());
    REQUIRE (engine.latencySamples() == 0);
}

TEST_CASE ("RaveEngine::lastError() stays empty after a no-op loadModel()/prepare() (anira-off stub)", "[rave]")
{
    mosh::RaveEngine engine;
    engine.prepare (44100.0, 512);
    const bool loaded = engine.loadModel ("/nonexistent/model.ts");
    // The anira-off stub always fails to load (no backend to load into) --
    // exactly like the real build failing on a bad path -- but never THROWS,
    // so there's nothing for the stub to have caught; lastError() legitimately
    // stays empty here (see RaveEngine.cpp's `#else` branch). This pins that
    // the additive method itself never crashes/UB's when called on a fresh,
    // anira-less engine, in any order.
    REQUIRE_FALSE (loaded);
    REQUIRE (engine.lastError().empty());
    engine.reset();
    engine.setNonRealtime (true);
    REQUIRE (engine.lastError().empty());
}
