#include <catch2/catch_test_macros.hpp>

#include "moshops/RenderSourceWindow.h"

TEST_CASE ("render source window rejects an unlooped exact-EOF start", "[export][source-window]")
{
    CHECK_FALSE (mosh::hasRenderableAudioSourceWindow (7.484458333, 7.484458333, 2.0, false));
}

TEST_CASE ("render source window rejects an unlooped beyond-EOF start", "[export][source-window]")
{
    CHECK_FALSE (mosh::hasRenderableAudioSourceWindow (7.484458333, 9.0, 2.0, false));
}

TEST_CASE ("render source window permits a tail that extends past EOF", "[export][source-window]")
{
    CHECK (mosh::hasRenderableAudioSourceWindow (7.484458333, 7.0, 2.0, false));
}

TEST_CASE ("render source window permits a looping virtual phase", "[export][source-window]")
{
    CHECK (mosh::hasRenderableAudioSourceWindow (7.484458333, 123.0, 2.0, true));
}

TEST_CASE ("render source window permits a negative lead-in with real overlap", "[export][source-window]")
{
    CHECK (mosh::hasRenderableAudioSourceWindow (7.484458333, -0.5, 1.0, false));
}
