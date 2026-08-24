#include <catch2/catch_test_macros.hpp>

#include "telemetry/SentryReporter.h"
#include "telemetry/TelemetryConfig.h"
#include "util/Env.h"

using namespace mosh::telemetry;

// ─────────────────────────────────────────────────────────────────────────────
// FS-K3 — Sentry crash reporting (opt-in, build-gated OFF by default).
//
// These cases run in the DEFAULT build, where MOSH_HAVE_SENTRY is undefined and
// no sentry-native is linked (MoshTests never defines it — same arrangement as
// RaveEngine.cpp/anira). That is deliberate: the two things K3 must not get
// wrong are both pure logic and are therefore provable with no DSN, no network,
// no crashpad handler and no Sentry account:
//
//   (a) PII SCRUBBING — a field named like a secret is DROPPED (absent, not
//       blanked), and every surviving string has the user's home path collapsed
//       to "~". Must hold at arbitrary nesting depth, inside arrays too.
//   (b) OPT-OUT IS HONORED — wouldInitialise() is false whenever the #406 opt-in
//       flag file is absent, EVEN IF a DSN is configured. Absent is the default
//       (fresh install), so a stranger who never opts in starts no handler and
//       sends nothing.
//
// Both are RED-provable: neuter scrubEvent() and (a) fails; drop the isOptedIn()
// term from wouldInitialise() and (b) fails. See docs/archive/first-stranger-program-2026-08-23/
// lanes/fs-k3.md (gates G2/G3) for the recorded RED output.
// ─────────────────────────────────────────────────────────────────────────────

namespace
{
    // Points MOSH_TELEMETRY_DIR at a fresh scratch dir so nothing here can read or
    // write the real ~/Library/Mosh (JUCE ignores $HOME — there is no sandbox; see
    // CLAUDE.md). Cleans up on BOTH paths: a failed REQUIRE unwinds via an
    // exception, which would otherwise leak a dirty opt-in flag into the next case.
    struct SentryTestFixture
    {
        juce::File dir;

        explicit SentryTestFixture (const juce::String& leaf)
            : dir (juce::File::getSpecialLocation (juce::File::tempDirectory).getChildFile (leaf))
        {
            dir.deleteRecursively();
            dir.createDirectory();
            mosh::setEnvVar ("MOSH_TELEMETRY_DIR", dir.getFullPathName().toRawUTF8());
            mosh::unsetEnvVar ("MOSH_SENTRY_DSN");
        }

        ~SentryTestFixture()
        {
            TelemetryConfig::setOptedIn (false);
            mosh::unsetEnvVar ("MOSH_SENTRY_DSN");
            mosh::unsetEnvVar ("MOSH_TELEMETRY_DIR");
            dir.deleteRecursively();
        }
    };

    juce::var objectWith (std::initializer_list<std::pair<const char*, juce::var>> members)
    {
        auto* o = new juce::DynamicObject();
        for (const auto& m : members)
            o->setProperty (juce::Identifier (m.first), m.second);
        return juce::var (o);
    }
}

TEST_CASE ("sentry scrub: home paths collapse to ~", "[sentry][crashscrub]")
{
    // The exact shape a real minidump/module path or a project path arrives in.
    REQUIRE (scrubText ("/Users/alice/Mosh/session/edit.tracktionedit")
                 == "~/Mosh/session/edit.tracktionedit");
    REQUIRE (scrubText ("/home/alice/mosh/x.wav") == "~/mosh/x.wav");

    // Mid-string, not just at the start — backtrace lines embed paths after an offset.
    REQUIRE (scrubText ("loaded module at /Users/bob/Library/Mosh/plug.vst3")
                 == "loaded module at ~/Library/Mosh/plug.vst3");

    // Two different users in one string: both collapse, and neither name survives.
    const auto both = scrubText ("/Users/alice/a and /Users/bob/b");
    REQUIRE (! both.contains ("alice"));
    REQUIRE (! both.contains ("bob"));

    // Non-path text is left alone (the scrubber must not mangle ordinary messages).
    REQUIRE (scrubText ("EXC_BAD_ACCESS at 0x10") == "EXC_BAD_ACCESS at 0x10");
}

TEST_CASE ("sentry scrub: secret-shaped field NAMES are recognised", "[sentry][crashscrub]")
{
    REQUIRE (isSensitiveKey ("MOSH_BRAIN_KEY"));
    REQUIRE (isSensitiveKey ("OPENAI_API_KEY"));
    REQUIRE (isSensitiveKey ("Authorization"));
    REQUIRE (isSensitiveKey ("authorization"));      // case-insensitive
    REQUIRE (isSensitiveKey ("Set-Cookie"));
    REQUIRE (isSensitiveKey ("access_token"));
    REQUIRE (isSensitiveKey ("client_secret"));
    REQUIRE (isSensitiveKey ("password"));
    REQUIRE (isSensitiveKey ("installId"));          // correlation handle, deliberately withheld
    REQUIRE (isSensitiveKey ("install_id"));

    // Ordinary event fields must NOT be dropped, or the report becomes useless.
    REQUIRE (! isSensitiveKey ("message"));
    REQUIRE (! isSensitiveKey ("level"));
    REQUIRE (! isSensitiveKey ("release"));
    REQUIRE (! isSensitiveKey ("breadcrumbs"));
}

TEST_CASE ("sentry scrub: secrets are DROPPED and paths scrubbed, at depth",
           "[sentry][crashscrub]")
{
    // A synthetic event shaped like the real thing: a top-level secret, a nested
    // contexts object with another secret and a home path, and an array of
    // breadcrumb objects (arrays must be walked, not passed through).
    const auto event = objectWith ({
        { "message",       juce::var ("crash in /Users/alice/Mosh/x.wav") },
        { "MOSH_BRAIN_KEY", juce::var ("sk-live-abcdef0123456789") },
        { "contexts", objectWith ({
              { "Authorization", juce::var ("Bearer sk-live-topsecret") },
              { "cwd",           juce::var ("/Users/alice/Mosh") },
              { "installId",     juce::var ("6f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b") },
          }) },
        { "breadcrumbs", juce::var (juce::Array<juce::var> {
              objectWith ({ { "name",         juce::var ("create_track") },
                            { "access_token", juce::var ("sk-live-crumb") },
                            { "path",         juce::var ("/Users/alice/t.wav") } }),
          }) },
    });

    const auto scrubbed = scrubEvent (event);
    auto* obj = scrubbed.getDynamicObject();
    REQUIRE (obj != nullptr);

    // Secrets are ABSENT — not present-and-empty. A blanked key still tells an
    // attacker the field existed, and "" would pass a naive != secret assertion.
    REQUIRE (! obj->hasProperty ("MOSH_BRAIN_KEY"));

    // Ordinary fields survive, with paths collapsed.
    REQUIRE (obj->getProperty ("message").toString() == "crash in ~/Mosh/x.wav");

    auto* ctx = obj->getProperty ("contexts").getDynamicObject();
    REQUIRE (ctx != nullptr);
    REQUIRE (! ctx->hasProperty ("Authorization"));
    REQUIRE (! ctx->hasProperty ("installId"));
    REQUIRE (ctx->getProperty ("cwd").toString() == "~/Mosh");

    // Arrays are walked: the crumb keeps its command name, loses its token, and has
    // its path collapsed.
    const auto crumbs = scrubbed.getProperty ("breadcrumbs", juce::var());
    REQUIRE (crumbs.isArray());
    REQUIRE (crumbs.size() == 1);
    auto* crumb = crumbs[0].getDynamicObject();
    REQUIRE (crumb != nullptr);
    REQUIRE (crumb->getProperty ("name").toString() == "create_track");
    REQUIRE (! crumb->hasProperty ("access_token"));
    REQUIRE (crumb->getProperty ("path").toString() == "~/t.wav");

    // Whole-payload belt-and-braces: no secret substring and no user name survives
    // anywhere in the serialised result, however it was nested.
    const auto json = juce::JSON::toString (scrubbed);
    REQUIRE (! json.contains ("sk-live"));
    REQUIRE (! json.contains ("alice"));
    REQUIRE (! json.contains ("6f1e2d3c"));
}

TEST_CASE ("sentry: opt-out is honored even when a DSN is configured", "[sentry][crashscrub]")
{
    SentryTestFixture fx ("mosh-sentry-optout-test");

    // A DSN is present for the whole case — so every result below is driven purely
    // by the opt-in bit, which is the thing under test.
    mosh::setEnvVar ("MOSH_SENTRY_DSN", "https://publickey@o0.ingest.sentry.io/1");
    REQUIRE (sentryDsn().isNotEmpty());

    // Fresh install: the #406 flag file does not exist. This is the default state a
    // first stranger is in, and it must mean "start nothing, send nothing".
    REQUIRE (! TelemetryConfig::isOptedIn());
    REQUIRE (! wouldInitialise());

    // Explicit opt-in flips it on.
    TelemetryConfig::setOptedIn (true);
    REQUIRE (wouldInitialise());

    // Mid-session opt-out flips it back off.
    TelemetryConfig::setOptedIn (false);
    REQUIRE (! wouldInitialise());
}

TEST_CASE ("sentry: no DSN means no init, even when opted in", "[sentry][crashscrub]")
{
    SentryTestFixture fx ("mosh-sentry-nodsn-test");

    // The current real state of this repo: FS-K3's Sentry project is
    // BLOCKED-ON-OWNER, so no DSN is configured anywhere.
    TelemetryConfig::setOptedIn (true);
    REQUIRE (sentryDsn().isEmpty());
    REQUIRE (! wouldInitialise());
}

TEST_CASE ("sentry: init is a no-op in the default (SDK-absent) build", "[sentry][crashscrub]")
{
    SentryTestFixture fx ("mosh-sentry-noop-test");

    // MoshTests never defines MOSH_HAVE_SENTRY, so this pins the gated-off branch:
    // calling the lifecycle must be safe and must create nothing on disk.
    REQUIRE (! isSentryCompiledIn());

    TelemetryConfig::setOptedIn (true);
    mosh::setEnvVar ("MOSH_SENTRY_DSN", "https://publickey@o0.ingest.sentry.io/1");

    initSentryReporter();
    shutdownSentryReporter();

    REQUIRE (! crashpadDatabaseDir().exists());
}

TEST_CASE ("sentry: crashpad database lives under the Mosh root, never ~/Documents",
           "[sentry][crashscrub]")
{
    SentryTestFixture fx ("mosh-sentry-dbpath-test");

    const auto db = crashpadDatabaseDir();
    REQUIRE (db.isAChildOf (TelemetryConfig::root()));
    // iCloud evicts file contents under ~/Documents while leaving plausible stat
    // sizes — nothing a build or a crash handler reads may live there (CLAUDE.md).
    REQUIRE (! db.getFullPathName().contains ("/Documents/"));
}
