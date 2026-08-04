#include "SentryReporter.h"
#include "TelemetryConfig.h"

#if MOSH_HAVE_SENTRY
 #include <sentry.h>
 #include <atomic>
#endif

namespace mosh::telemetry
{

namespace
{
    /** Collapse "<prefix><username>" to "~" everywhere it appears. Written as an
        explicit scan rather than a regex so it is allocation-predictable and has no
        catastrophic-backtracking surface — this runs on strings that came out of a
        crashing process. */
    juce::String collapseHomePrefix (const juce::String& text, const juce::String& prefix)
    {
        if (! text.contains (prefix))
            return text;

        juce::String out;
        const int n = text.length();
        int i = 0;

        while (i < n)
        {
            const int hit = text.indexOf (i, prefix);

            if (hit < 0)
            {
                out += text.substring (i);
                break;
            }

            out += text.substring (i, hit);

            // Skip the prefix AND the user-name segment that follows it, up to the
            // next separator (or end of string, for a bare "/Users/alice").
            int j = hit + prefix.length();
            while (j < n && text[j] != '/')
                ++j;

            out += "~";
            i = j;
        }

        return out;
    }
}

juce::String scrubText (const juce::String& text)
{
    return collapseHomePrefix (collapseHomePrefix (text, "/Users/"), "/home/");
}

bool isSensitiveKey (const juce::String& key)
{
    const auto k = key.toLowerCase();

    return k.endsWith ("_key") || k == "key" || k.contains ("apikey")
        || k.contains ("token")
        || k.contains ("secret")
        || k.contains ("password")
        || k.contains ("credential")
        || k == "authorization"
        || k.contains ("cookie")
        || k == "installid" || k == "install_id";
}

juce::var scrubEvent (const juce::var& event)
{
    if (auto* obj = event.getDynamicObject())
    {
        auto* out = new juce::DynamicObject();

        for (const auto& prop : obj->getProperties())
        {
            // DROP, don't blank: an empty-but-present field still discloses that the
            // field existed, and "" would satisfy a naive "!= the secret" check.
            if (isSensitiveKey (prop.name.toString()))
                continue;

            out->setProperty (prop.name, scrubEvent (prop.value));
        }

        return juce::var (out);
    }

    if (const auto* arr = event.getArray())
    {
        juce::Array<juce::var> out;
        out.ensureStorageAllocated (arr->size());

        for (const auto& item : *arr)
            out.add (scrubEvent (item));

        return juce::var (out);
    }

    if (event.isString())
        return juce::var (scrubText (event.toString()));

    // Numbers, bools, null, and binary blobs carry no name to match on and no path
    // to collapse — passed through unchanged.
    return event;
}

juce::String sentryDsn()
{
    // 1. Environment override — how a developer or the induced-crash gate points a
    //    build at a scratch project without rebuilding.
    const auto fromEnv = juce::SystemStats::getEnvironmentVariable ("MOSH_SENTRY_DSN", {}).trim();

    if (fromEnv.isNotEmpty())
        return fromEnv;

    // 2. A bundled, NON-SECRET Resources/sentry.dsn. A DSN is a public client ingest
    //    key; the dSYM-upload auth token is the secret, and it never enters the
    //    bundle (scripts/release/upload-dsyms.sh keeps it env-only).
    const auto app = juce::File::getSpecialLocation (juce::File::currentApplicationFile);
    const auto bundled = app.getChildFile ("Contents/Resources/sentry.dsn");

    if (bundled.existsAsFile())
        return bundled.loadFileAsString().trim();

    return {};
}

bool wouldInitialise()
{
    // BOTH terms are load-bearing. isOptedIn() is PR #406's single consent bit
    // (flag file absent by default => opted out), so a stranger who never opts in
    // can never start the handler, DSN or no DSN.
    return TelemetryConfig::isOptedIn() && sentryDsn().isNotEmpty();
}

bool isSentryCompiledIn()
{
   #if MOSH_HAVE_SENTRY
    return true;
   #else
    return false;
   #endif
}

juce::File crashpadDatabaseDir()
{
    // TelemetryConfig::root() is ~/Library/Mosh (or MOSH_TELEMETRY_DIR under test).
    return TelemetryConfig::root().getChildFile ("crashpad");
}

#if MOSH_HAVE_SENTRY

namespace
{
    std::atomic<bool> g_started { false };

    // ── juce::var <-> sentry_value_t ─────────────────────────────────────────────
    // The scrubber that actually runs in before_send is the SAME scrubEvent() the
    // Catch2 case pins — the event is converted to a juce::var, scrubbed, and
    // converted back. That is the point: no second, untested copy of the redaction
    // logic can drift away from the tested one.

    juce::var toVar (sentry_value_t v)
    {
        switch (sentry_value_get_type (v))
        {
            case SENTRY_VALUE_TYPE_NULL:   return {};
            case SENTRY_VALUE_TYPE_BOOL:   return juce::var (sentry_value_is_true (v) != 0);
            case SENTRY_VALUE_TYPE_INT32:  return juce::var (sentry_value_as_int32 (v));
            case SENTRY_VALUE_TYPE_DOUBLE: return juce::var (sentry_value_as_double (v));

            case SENTRY_VALUE_TYPE_STRING:
            {
                const auto* s = sentry_value_as_string (v);
                return juce::var (juce::String::fromUTF8 (s != nullptr ? s : ""));
            }

            case SENTRY_VALUE_TYPE_LIST:
            {
                juce::Array<juce::var> out;
                const auto len = sentry_value_get_length (v);

                for (size_t i = 0; i < len; ++i)
                    out.add (toVar (sentry_value_get_by_index (v, i)));

                return juce::var (out);
            }

            case SENTRY_VALUE_TYPE_OBJECT:
            default:
            {
                // The C API exposes no key iterator, so round-trip through JSON —
                // the one supported way to enumerate an object's members.
                if (auto* json = sentry_value_to_json (v))
                {
                    const auto parsed = juce::JSON::parse (juce::String::fromUTF8 (json));
                    sentry_free (json);
                    return parsed;
                }

                return {};
            }
        }
    }

    sentry_value_t toSentry (const juce::var& v)
    {
        if (auto* obj = v.getDynamicObject())
        {
            auto out = sentry_value_new_object();

            for (const auto& prop : obj->getProperties())
                sentry_value_set_by_key (out,
                                         prop.name.toString().toRawUTF8(),
                                         toSentry (prop.value));

            return out;
        }

        if (const auto* arr = v.getArray())
        {
            auto out = sentry_value_new_list();

            for (const auto& item : *arr)
                sentry_value_append (out, toSentry (item));

            return out;
        }

        if (v.isBool())   return sentry_value_new_bool (static_cast<bool> (v) ? 1 : 0);
        if (v.isInt())    return sentry_value_new_int32 (static_cast<int> (v));
        if (v.isInt64() || v.isDouble())
                          return sentry_value_new_double (static_cast<double> (v));
        if (v.isString()) return sentry_value_new_string (v.toString().toRawUTF8());

        return sentry_value_new_null();
    }

    sentry_value_t beforeSend (sentry_value_t event, void*, void*)
    {
        const auto scrubbed = scrubEvent (toVar (event));
        sentry_value_decref (event);
        return toSentry (scrubbed);
    }

    /** Crashpad ships its own out-of-process executable. Resolve it from the RUNNING
        bundle at runtime — never from a configure-time absolute path, which would
        bake this build machine's directory layout into the shipped binary. */
    juce::File resolveHandlerPath()
    {
        const auto app = juce::File::getSpecialLocation (juce::File::currentApplicationFile);

        const juce::File candidates[] = {
            app.getChildFile ("Contents/MacOS/crashpad_handler"),
            app.getSiblingFile ("crashpad_handler"),
        };

        for (const auto& c : candidates)
            if (c.existsAsFile())
                return c;

        return {};
    }
}

void initSentryReporter()
{
    if (g_started.load())
        return;

    // The consent gate. Opted out (the default) => we return before creating a
    // directory, starting a process, or opening a socket.
    if (! wouldInitialise())
        return;

    const auto handler = resolveHandlerPath();

    if (handler == juce::File())
    {
        // Fail closed and silent: without the out-of-process handler the crashpad
        // backend cannot work, and starting a degraded reporter is worse than none.
        jassertfalse;
        return;
    }

    const auto db = crashpadDatabaseDir();
    db.createDirectory();

    auto* options = sentry_options_new();
    sentry_options_set_dsn (options, sentryDsn().toRawUTF8());
    sentry_options_set_database_path (options, db.getFullPathName().toRawUTF8());
    sentry_options_set_handler_path (options, handler.getFullPathName().toRawUTF8());
    // Same version macro CrashHandler.cpp uses (see currentAppVersion() there);
    // "mosh@<version>" is the release identifier Sentry matches uploaded dSYMs
    // against, so it MUST agree with what upload-dsyms.sh tags a build with.
   #ifdef MOSH_VERSION_STRING
    const juce::String release = juce::String ("mosh@") + MOSH_VERSION_STRING;
   #else
    const juce::String release = "mosh@dev";
   #endif
    sentry_options_set_release (options, release.toRawUTF8());

    // MINIMISE AT SOURCE — see the long note in SentryReporter.h. With the crashpad
    // backend the minidump is written and uploaded out-of-process, so no callback of
    // ours can rewrite it; the only reliable control is never attaching PII in the
    // first place.
    //
    // NOTE: there is deliberately no sentry_options_set_send_default_pii() call
    // here. That setter exists ONLY under `#ifdef SENTRY_PLATFORM_NX` in sentry.h
    // (0.15.4) — it is Nintendo-Switch-only, and calling it on macOS is a compile
    // error. On this platform "don't send default PII" is not an option to set, it
    // is the SDK's behaviour: it adds no user identity of its own. What we control,
    // and what actually matters, is what WE attach — and below, that is the release
    // tag and nothing else. No user context, no environment block, no attachments.
    // (Found by compiling, not by reading the declaration's line number.)

    // Scrubs every event we CAN reach: before_send runs for all non-crash
    // (explicitly captured) events. It is deliberately the same tested scrubEvent().
    sentry_options_set_before_send (options, beforeSend, nullptr);

    if (sentry_init (options) == 0)
        g_started.store (true);

    // Drop the SDK's OWN per-installation identifier.
    //
    // MEASURED, not assumed: with crashpad, sentry-native mints a random UUID in
    // <db>/installation_id and attaches it as the event's `user.id`. It reached the
    // wire in the first G5 run (see lanes/fs-k3.md, G5 arm 2) — and `before_send`
    // cannot strip it, because that callback does not run on the crashpad crash
    // path. So the only place to remove it is here, in-process, right after init.
    //
    // It is NOT derived from the machine, the account, or Mosh's own #406 installId
    // (verified: different values) — but it IS a stable handle that correlates every
    // crash from this installation, which is precisely the class of identifier
    // scrubEvent() already drops by name. Withholding it via the SDK's front door
    // and shipping it via its back door would be incoherent.
    //
    // COST, stated plainly: Sentry's "N users affected" count degrades to an event
    // count — you can no longer tell one user crashing fifty times from fifty users
    // crashing once. That is a real product tradeoff and it is the OWNER's call, not
    // this lane's; the privacy-preserving side is the correct DEFAULT while no
    // decision exists. Reverting is deleting this one line.
    sentry_remove_user();

    // ── Induced-crash hook for FS-K3 gate G5 (see lanes/fs-k3.md) ────────────────
    // Proving the crashpad path needs a REAL hardware fault, not `kill -SEGV`: a
    // signal delivered by kill() travels the BSD path, whereas crashpad on macOS
    // catches EXC_BAD_ACCESS on a Mach exception port. Only an actual bad
    // dereference exercises the thing under test.
    //
    // This entire hook lives inside `#if MOSH_HAVE_SENTRY`, so it does not exist in
    // the default build — the shipped binary gains no crash path, not even an
    // env-guarded one. It is deliberately NOT a CLI flag: a flag would be a surface
    // in --help and one typo away from a user finding it.
    if (juce::SystemStats::getEnvironmentVariable ("MOSH_SENTRY_INDUCE_CRASH", {}) == "1")
    {
        volatile int* boom = nullptr;
        *boom = 42; // EXC_BAD_ACCESS — the fault crashpad's Mach handler is for.
    }
}

void shutdownSentryReporter()
{
    if (g_started.exchange (false))
        sentry_close();
}

#else // ── default build: no SDK linked, both entry points are no-ops ─────────────

void initSentryReporter()     {}
void shutdownSentryReporter() {}

#endif

} // namespace mosh::telemetry
