#include "WebBridge.h"
#include "UiResourcePathGuard.h"
#include "WebViewCursor.h"
#include "../agent/CertifiedSkillLoader.h"
#include "../brain/BrainProxy.h"
#include "../voice/NativeSpeech.h"
// Crash/telemetry module (src/telemetry/) — opt-in, privacy-respecting. This is
// the ONE chokepoint every UI- and agent-issued command passes through, so it is
// where the redacted command-NAME-ONLY breadcrumb trail + the anonymous usage
// histogram are recorded (see docs/telemetry/PRIVACY.md). Headless harnesses
// (--selftest/--run-script) call MoshOps::execute() directly and never reach
// here — by design, those aren't real user sessions.
#include "../telemetry/Breadcrumbs.h"
#include "../telemetry/CrashReportFormatter.h"
#include "../telemetry/Telemetry.h"
#include "../telemetry/TelemetryConfig.h"

namespace mosh
{
using Resource = juce::WebBrowserComponent::Resource;

WebBridge::WebBridge() = default;
WebBridge::~WebBridge() = default;   // NativeSpeech is complete here → unique_ptr can destroy it

namespace
{
   #if ! JUCE_MAC
    juce::MouseCursor juceCursorForKind (EditorCursorKind kind)
    {
        switch (kind)
        {
            case EditorCursorKind::defaultCursor:   return juce::MouseCursor::NormalCursor;
            case EditorCursorKind::crosshair:       return juce::MouseCursor::CrosshairCursor;
            case EditorCursorKind::openHand:        return juce::MouseCursor::DraggingHandCursor;
            case EditorCursorKind::closedHand:      return juce::MouseCursor::DraggingHandCursor;
            case EditorCursorKind::resizeLeftRight: return juce::MouseCursor::LeftRightResizeCursor;
        }

        jassertfalse;
        return juce::MouseCursor::NormalCursor;
    }
   #endif

    juce::String mimeForExtension (const juce::String& ext)
    {
        static const std::map<juce::String, juce::String> types {
            { "html", "text/html" },        { "htm",  "text/html" },
            { "js",   "text/javascript" },  { "mjs",  "text/javascript" },
            { "css",  "text/css" },         { "json", "application/json" },
            { "svg",  "image/svg+xml" },    { "png",  "image/png" },
            { "jpg",  "image/jpeg" },       { "jpeg", "image/jpeg" },
            { "gif",  "image/gif" },        { "ico",  "image/x-icon" },
            { "wasm", "application/wasm" },  { "map",  "application/json" },
            { "woff", "font/woff" },        { "woff2","font/woff2" },
            { "ttf",  "font/ttf" },         { "txt",  "text/plain" },
        };
        auto it = types.find (ext.toLowerCase());
        return it != types.end() ? it->second : juce::String ("application/octet-stream");
    }

    /** Locate the staged UI bundle: env override -> app bundle Resources -> exe dir. */
    const juce::File& getUiDir()
    {
        static const auto uiDir = []
        {
            if (auto env = juce::SystemStats::getEnvironmentVariable ("MOSH_UI_DIR", {});
                env.isNotEmpty())
            {
                juce::File f (env);
                if (f.isDirectory())
                    return f;
            }

            auto appFile = juce::File::getSpecialLocation (juce::File::currentApplicationFile);
            auto bundled = appFile.getChildFile ("Contents/Resources/ui");
            if (bundled.isDirectory())
                return bundled;

            auto exeDir = juce::File::getSpecialLocation (juce::File::currentExecutableFile)
                              .getParentDirectory();
            return exeDir.getChildFile ("ui");
        }();

        return uiDir;
    }

    std::vector<std::byte> toBytes (const juce::MemoryBlock& mb)
    {
        std::vector<std::byte> out (mb.getSize());
        std::memcpy (out.data(), mb.getData(), mb.getSize());
        return out;
    }

    std::vector<std::byte> toBytes (const juce::String& s)
    {
        auto utf8 = s.toRawUTF8();
        auto len  = std::strlen (utf8);
        std::vector<std::byte> out (len);
        std::memcpy (out.data(), utf8, len);
        return out;
    }
} // namespace

Resource WebBridge::serveUiResource (const juce::String& url)
{
    const auto& uiDir = getUiDir();

    auto rel = ui_resource_guard::normalisePath (url);
    if (! rel || ! ui_resource_guard::isSafePath (uiDir, url))
        return { toBytes ("blocked UI resource path"), "text/plain" };

    auto file = uiDir.getChildFile (*rel);

    if (! file.existsAsFile())
    {
        // SPA fallback: unknown non-asset paths serve index.html.
        if (! rel->containsChar ('.'))
            file = uiDir.getChildFile ("index.html");
    }

    // The Vite single-file build (vite-plugin-singlefile) inlines all JS+CSS into
    // index.html, so there are no external sub-resources to rewrite — serve files
    // verbatim. (External <script type=module>/<link> would not load under JUCE's
    // resource-provider scheme; single-file sidesteps that entirely.)
    if (file.existsAsFile())
    {
        juce::MemoryBlock mb;
        if (file.loadFileAsData (mb))
            return { toBytes (mb), mimeForExtension (file.getFileExtension().removeCharacters (".")) };
    }

    // Bundle missing (e.g. UI not built) → a clear in-WebView diagnostic page.
    auto html = juce::String (
        "<!doctype html><html><body style='font-family:system-ui;background:#111;"
        "color:#eee;padding:2rem'><h2>Mosh</h2><p>UI bundle not found at<br><code>")
        + uiDir.getFullPathName()
        + "</code></p><p>Build it: <code>cd ui &amp;&amp; npm install &amp;&amp; npm run build</code>, "
          "or set <code>MOSH_UI_DEV_SERVER</code>.</p></body></html>";
    return { toBytes (html), "text/html" };
}

bool WebBridge::isSafeUiResourcePath (const juce::String& url)
{
    return ui_resource_guard::isSafePath (url);
}

bool WebBridge::isSafeUiResourcePath (const juce::File& uiDir, const juce::String& url)
{
    return ui_resource_guard::isSafePath (uiDir, url);
}

juce::WebBrowserComponent::Options WebBridge::buildOptions()
{
    return juce::WebBrowserComponent::Options{}
        .withNativeIntegrationEnabled()
        .withResourceProvider (
            [this] (const auto& url) -> std::optional<Resource>
            {
                return serveUiResource (url);
            })
        // Stage 0 bridge proof: UI can call window.__JUCE__ ping → app identity.
        .withNativeFunction (
            juce::Identifier ("ping"),
            [] (const juce::Array<juce::var>&,
                juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                completion (appInfo());
            })
        .withNativeFunction (
            juce::Identifier ("ui_ready"),
            [this] (const juce::Array<juce::var>&,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                browserReadyForEvents = true;
               #if JUCE_MAC
                setMacEditorCursor (EditorCursorKind::defaultCursor);
               #else
                if (webView != nullptr)
                    webView->setMouseCursor (juce::MouseCursor::NormalCursor);
               #endif
                // A page (re)load orphans any note the previous page was holding: its
                // keyup handlers are gone, so nothing will ever send the note-off. Fire a
                // panic through the ordinary command seam — this is the one moment we know
                // for certain that no UI state survives.
                if (commandHandler)
                {
                    auto* panic = new juce::DynamicObject();
                    panic->setProperty ("command", "all_notes_off");
                    commandHandler (juce::var (panic));
                }
                auto* ok = new juce::DynamicObject();
                ok->setProperty ("ok", true);
                completion (juce::var (ok));
            })
        .withNativeFunction (
            juce::Identifier ("set_editor_cursor"),
            [this] (const juce::Array<juce::var>& args,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                auto* result = new juce::DynamicObject();
                const auto rawKind = args.size() == 1
                    ? args[0].getProperty ("kind", juce::var()).toString()
                    : juce::String();
                const auto kind = parseEditorCursorKind (rawKind);

                if (! kind.has_value())
                {
                    result->setProperty ("ok", false);
                    result->setProperty ("error", "invalid editor cursor kind");
                    completion (juce::var (result));
                    return;
                }

               #if JUCE_MAC
                juce::ignoreUnused (this);
                setMacEditorCursor (*kind);
               #else
                if (webView != nullptr)
                    webView->setMouseCursor (juceCursorForKind (*kind));
               #endif

                result->setProperty ("ok", true);
                result->setProperty ("kind", rawKind);
                completion (juce::var (result));
            })
        // The single mutation entry point (MoshOps, 02). Wired in Stage 1.
        .withNativeFunction (
            juce::Identifier ("execute_command"),
            [this] (const juce::Array<juce::var>& args,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                if (commandHandler && args.size() > 0)
                {
                    // Redact ONCE, here, to a bare command-name token — Breadcrumbs
                    // (crash context) and Telemetry (opt-in usage histogram) both
                    // receive ONLY this sanitized name, never the raw command object
                    // (which carries args — trackIds, file paths, lyric text, …).
                    // Both sinks independently re-sanitize on top of this (defense in
                    // depth), but neither is ever handed anything BUT this token.
                    const auto safeName = mosh::telemetry::sanitizeCommandName (
                        args[0].getProperty ("command", juce::var()).toString());
                    mosh::telemetry::Breadcrumbs::record (safeName);
                    mosh::telemetry::Telemetry::onCommand (safeName);

                    // A directory iterator can block on a large folder, a cloud
                    // placeholder, or a disconnected volume. list_directory is the
                    // one MoshOps command explicitly implemented as engine-free,
                    // bounded read-only I/O, so dispatch it on a worker and resolve
                    // its native Promise back on the message thread. All mutations
                    // remain on the ordinary synchronous MoshOps seam below.
                    if (safeName == "list_directory" && asyncCommandHandler != nullptr)
                    {
                        auto handler = asyncCommandHandler;
                        const auto command = args[0];
                        juce::Thread::launch ([handler, command, completion]() mutable
                        {
                            auto result = handler (command);
                            juce::MessageManager::callAsync ([completion, result]() mutable
                            {
                                completion (result);
                            });
                        });
                        return;
                    }
                    completion (commandHandler (args[0]));
                }
                else
                {
                    auto* err = new juce::DynamicObject();
                    err->setProperty ("ok", false);
                    err->setProperty ("error", "no command handler bound (Stage 1+)");
                    completion (juce::var (err));
                }
            })
        .withNativeFunction (
            juce::Identifier ("get_snapshot"),
            [this] (const juce::Array<juce::var>&,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                completion (snapshotProvider ? snapshotProvider() : juce::var());
            })
        // Telemetry opt-in (default OFF; see docs/telemetry/PRIVACY.md). Deliberately
        // NOT a MoshOps command — it's a UI-local setting (mirrors uiShell/theme,
        // ui/src/settings/schema.ts) whose one side effect is this native call, which
        // just creates/removes a small flag file (TelemetryConfig::optInFile(),
        // ~/Library/Mosh/telemetry.optin by default) that the crash handler and
        // Telemetry counters read directly. Synchronous — a stat()+touch/delete, no
        // async dialog or service call needed, unlike pick_files/escalate_candidates.
        .withNativeFunction (
            juce::Identifier ("set_telemetry_optin"),
            [] (const juce::Array<juce::var>& args,
                juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                const auto optInVar = args.size() > 0 ? args[0].getProperty ("optIn", false) : juce::var (false);
                const bool optIn = (bool) optInVar;
                mosh::telemetry::TelemetryConfig::setOptedIn (optIn);
                auto* ok = new juce::DynamicObject();
                ok->setProperty ("ok", true);
                ok->setProperty ("optIn", optIn);
                completion (juce::var (ok));
            })
        // Moshi's brain, server side (the native equivalent of the Vite /api/brain
        // proxy). Keys live in the environment, never in the WebView. The HTTP call
        // blocks, so it runs off the message thread and resolves the promise back on
        // it. Returns { ok, content, ... } or { ok:false, error } — bridge.ts throws
        // on the error shape so packaged callers fail visibly without commands.
        .withNativeFunction (
            juce::Identifier ("brain_chat"),
            [] (const juce::Array<juce::var>& args,
                juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                const auto req      = args.size() > 0 ? args[0] : juce::var();
                const auto messages = req.getProperty ("messages", juce::var());
                const auto provider = req.getProperty ("provider", juce::var()).toString();
                juce::Thread::launch ([messages, provider, completion]() mutable
                {
                    auto result = BrainProxy::chat (messages, provider);
                    juce::MessageManager::callAsync ([completion, result]() mutable { completion (result); });
                });
            })
        .withNativeFunction (
            juce::Identifier ("brain_runtime_status"),
            [this] (const juce::Array<juce::var>&,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                completion (brainRuntimeStatusProvider ? brainRuntimeStatusProvider() : juce::var());
            })
        // WP-11 best-of-n relays (UI → generative service via native — the WebView
        // cannot reach the service port). Threaded like brain_chat: the escalation
        // blocks up to ~60s in GenerativeJobManager, so it must never run on the
        // message thread. Unbound handler ⇒ { ok:false } and the UI keeps its
        // single-shot reply (graceful degrade, zero extra cloud calls).
        .withNativeFunction (
            juce::Identifier ("escalate_candidates"),
            [this] (const juce::Array<juce::var>& args,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                const auto payload = args.size() > 0 ? args[0] : juce::var();
                if (escalateHandler == nullptr)
                {
                    auto* err = new juce::DynamicObject();
                    err->setProperty ("ok", false);
                    err->setProperty ("error", "escalation relay not bound");
                    completion (juce::var (err));
                    return;
                }
                auto handler = escalateHandler;
                juce::Thread::launch ([handler, payload, completion]() mutable
                {
                    auto result = handler (payload);
                    if (! result.isObject())
                    {
                        auto* err = new juce::DynamicObject();
                        err->setProperty ("ok", false);
                        err->setProperty ("error", "escalation service unreachable");
                        result = juce::var (err);
                    }
                    juce::MessageManager::callAsync ([completion, result]() mutable { completion (result); });
                });
            })
        .withNativeFunction (
            juce::Identifier ("archive_pair"),
            [this] (const juce::Array<juce::var>& args,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                const auto row = args.size() > 0 ? args[0] : juce::var();
                if (archivePairHandler == nullptr)
                {
                    auto* err = new juce::DynamicObject();
                    err->setProperty ("ok", false);
                    completion (juce::var (err));
                    return;
                }
                auto handler = archivePairHandler;
                juce::Thread::launch ([handler, row, completion]() mutable
                {
                    auto result = handler (row);
                    juce::MessageManager::callAsync ([completion, result]() mutable { completion (result); });
                });
            })
        // Native speech-to-text (packaged-app voice). isSupported() does NOT imply
        // permission — that is requested on the first voice_start. Transcripts flow
        // to the UI on the dedicated `voice_event` channel.
        .withNativeFunction (
            juce::Identifier ("voice_supported"),
            [] (const juce::Array<juce::var>&,
                juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                auto* o = new juce::DynamicObject();
                o->setProperty ("supported", NativeSpeech::isSupported());
                completion (juce::var (o));
            })
        .withNativeFunction (
            juce::Identifier ("voice_start"),
            [this] (const juce::Array<juce::var>&,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                if (speech == nullptr)
                    speech = std::make_unique<NativeSpeech>();

                auto emit = [this] (const char* type, const juce::String& text, bool hasText)
                {
                    auto* o = new juce::DynamicObject();
                    o->setProperty ("type", juce::String (type));
                    if (hasText) o->setProperty ("text", text);
                    emitEvent (juce::Identifier ("voice_event"), juce::var (o));
                };

                NativeSpeech::Callbacks cb;
                cb.onStart   = [emit] { emit ("start", {}, false); };
                cb.onInterim = [emit] (const juce::String& t) { emit ("interim", t, true); };
                cb.onFinal   = [emit] (const juce::String& t) { emit ("final", t, true); };
                cb.onStop    = [emit] { emit ("stop", {}, false); };
                cb.onError   = [emit] (const juce::String& e) { emit ("error", e, true); };
                speech->start (std::move (cb));

                auto* ok = new juce::DynamicObject();
                ok->setProperty ("ok", true);
                completion (juce::var (ok));
            })
        .withNativeFunction (
            juce::Identifier ("voice_stop"),
            [this] (const juce::Array<juce::var>&,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                if (speech != nullptr) speech->stop();
                auto* ok = new juce::DynamicObject();
                ok->setProperty ("ok", true);
                completion (juce::var (ok));
            })
        // Always-on (hands-free) speech. Same `voice_event` channel + five types as
        // hold-to-talk, but a continuous session yields MANY `final`s and only stops on
        // voice_listen_stop / a fatal error — so the UI's continuous controller keeps its
        // subscription open and treats each `final` as one command candidate.
        .withNativeFunction (
            juce::Identifier ("voice_listen_start"),
            [this] (const juce::Array<juce::var>&,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                if (speech == nullptr)
                    speech = std::make_unique<NativeSpeech>();

                auto emit = [this] (const char* type, const juce::String& text, bool hasText)
                {
                    auto* o = new juce::DynamicObject();
                    o->setProperty ("type", juce::String (type));
                    if (hasText) o->setProperty ("text", text);
                    emitEvent (juce::Identifier ("voice_event"), juce::var (o));
                };

                NativeSpeech::Callbacks cb;
                cb.onStart   = [emit] { emit ("start", {}, false); };
                cb.onInterim = [emit] (const juce::String& t) { emit ("interim", t, true); };
                cb.onFinal   = [emit] (const juce::String& t) { emit ("final", t, true); };
                cb.onStop    = [emit] { emit ("stop", {}, false); };
                cb.onError   = [emit] (const juce::String& e) { emit ("error", e, true); };
                speech->startContinuous (std::move (cb));

                auto* ok = new juce::DynamicObject();
                ok->setProperty ("ok", true);
                completion (juce::var (ok));
            })
        .withNativeFunction (
            juce::Identifier ("voice_listen_stop"),
            [this] (const juce::Array<juce::var>&,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                if (speech != nullptr) speech->stopContinuous();
                auto* ok = new juce::DynamicObject();
                ok->setProperty ("ok", true);
                completion (juce::var (ok));
            })
        .withNativeFunction (
            juce::Identifier ("remote_start_pairing"),
            [this] (const juce::Array<juce::var>& args,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                completion (remoteStartHandler ? remoteStartHandler (args.size() > 0 ? args[0] : juce::var())
                                               : juce::var());
            })
        .withNativeFunction (
            juce::Identifier ("remote_stop"),
            [this] (const juce::Array<juce::var>& args,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                completion (remoteStopHandler ? remoteStopHandler (args.size() > 0 ? args[0] : juce::var())
                                              : juce::var());
            })
        .withNativeFunction (
            juce::Identifier ("remote_status"),
            [this] (const juce::Array<juce::var>&,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                completion (remoteStatusProvider ? remoteStatusProvider() : juce::var());
            })
        // Native file-open picker (wave: settings). Async on the message thread; the
        // FileChooser is held in a member so the callback outlives the dialog. The
        // NativeFunctionCompletion is resolved EXACTLY ONCE, including the cancel path
        // ({ok:false, files:[]}). The mutation (import_clip / open_project) still runs
        // via execute_command afterwards — this only resolves paths.
        .withNativeFunction (
            juce::Identifier ("pick_files"),
            [this] (const juce::Array<juce::var>& args,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                // Re-entry guard: a dialog is already in flight. Resolve immediately
                // ({ok:false}) rather than replacing the live FileChooser (which would
                // destroy its in-flight completion and hang that Promise forever).
                if (pickerBusy)
                {
                    auto* busy = new juce::DynamicObject();
                    busy->setProperty ("ok", false);
                    busy->setProperty ("files", juce::Array<juce::var>());
                    completion (juce::var (busy));
                    return;
                }

                const auto opts   = args.size() > 0 ? args[0] : juce::var();
                const bool multi  = (bool) opts.getProperty ("multiple", false);
                auto       title  = opts.getProperty ("title", "Open").toString();
                auto       filter = opts.getProperty ("filters", "").toString();

                int flags = juce::FileBrowserComponent::openMode
                          | juce::FileBrowserComponent::canSelectFiles;
                if (multi) flags |= juce::FileBrowserComponent::canSelectMultipleItems;

                pickerBusy = true;
                fileChooser = std::make_unique<juce::FileChooser> (title, juce::File(), filter);
                fileChooser->launchAsync (flags,
                    [this, completion] (const juce::FileChooser& fc) mutable
                    {
                        auto results = fc.getResults();
                        juce::Array<juce::var> files;
                        for (auto& f : results)
                            files.add (f.getFullPathName());

                        auto* o = new juce::DynamicObject();
                        o->setProperty ("ok", files.size() > 0);
                        o->setProperty ("files", files);
                        completion (juce::var (o));            // resolved once (incl. cancel → empty)
                        pickerBusy = false;                    // allow the next dialog
                    });
            })
        // Native file-save picker (wave: settings). Same lifetime/resolve-once rules;
        // returns {ok, file}. save_as runs via execute_command afterwards.
        .withNativeFunction (
            juce::Identifier ("pick_save_file"),
            [this] (const juce::Array<juce::var>& args,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                // Re-entry guard (see pick_files): never replace a live chooser.
                if (pickerBusy)
                {
                    auto* busy = new juce::DynamicObject();
                    busy->setProperty ("ok", false);
                    busy->setProperty ("file", juce::String());
                    completion (juce::var (busy));
                    return;
                }

                const auto opts     = args.size() > 0 ? args[0] : juce::var();
                auto       title    = opts.getProperty ("title", "Save As").toString();
                auto       filter   = opts.getProperty ("filters", "").toString();
                auto       defName  = opts.getProperty ("defaultName", "").toString();

                const int flags = juce::FileBrowserComponent::saveMode
                                | juce::FileBrowserComponent::canSelectFiles
                                | juce::FileBrowserComponent::warnAboutOverwriting;

                juce::File start = defName.isNotEmpty()
                    ? juce::File::getSpecialLocation (juce::File::userDocumentsDirectory).getChildFile (defName)
                    : juce::File();

                pickerBusy = true;
                fileChooser = std::make_unique<juce::FileChooser> (title, start, filter);
                fileChooser->launchAsync (flags,
                    [this, completion] (const juce::FileChooser& fc) mutable
                    {
                        auto result = fc.getResult();
                        auto* o = new juce::DynamicObject();
                        o->setProperty ("ok", result != juce::File());
                        o->setProperty ("file", result.getFullPathName());
                        completion (juce::var (o));            // resolved once (incl. cancel → empty)
                        pickerBusy = false;                    // allow the next dialog
                    });
            })
        // Skill Foundry Task 4 — three DEDICATED, non-MoshOps native reads for the
        // certified skill loader (src/agent/CertifiedSkillLoader.{h,cpp}). Each is its
        // OWN top-level `.withNativeFunction` entry, threaded EXACTLY like brain_chat /
        // escalate_candidates / archive_pair above: the loader does blocking
        // lstat/fstat/read syscalls (bounded, but still real I/O), so it must never run
        // on the message thread. Deliberately NOT the `list_directory` shape further up
        // (dispatched *inside* execute_command via asyncCommandHandler, still passing
        // through commandHandler and telemetry's command-name redaction) — these three
        // NEVER touch commandHandler, never appear in AGENT_COMMANDS or MoshOps, and are
        // never reachable via execute_command's `args[0].command` dispatch. See
        // ui/src/agent/skillFoundry/nativeBridgeBoundary.test.ts for the durable guard on
        // both the TS and native-source sides of that boundary.
        .withNativeFunction (
            juce::Identifier ("read_certified_skill_packages"),
            [] (const juce::Array<juce::var>&,
                juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                juce::Thread::launch ([completion]() mutable
                {
                    auto result = CertifiedSkillLoader::readFromEnvironment();
                    juce::MessageManager::callAsync ([completion, result]() mutable { completion (result); });
                });
            })
        .withNativeFunction (
            juce::Identifier ("read_skill_source_status"),
            [] (const juce::Array<juce::var>&,
                juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                juce::Thread::launch ([completion]() mutable
                {
                    auto result = CertifiedSkillLoader::readSourceStatusFromEnvironment();
                    juce::MessageManager::callAsync ([completion, result]() mutable { completion (result); });
                });
            })
        .withNativeFunction (
            juce::Identifier ("read_certified_native_skills"),
            [] (const juce::Array<juce::var>&,
                juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                juce::Thread::launch ([completion]() mutable
                {
                    auto result = CertifiedSkillLoader::readBundledNativeFromApplication();
                    juce::MessageManager::callAsync ([completion, result]() mutable { completion (result); });
                });
            });
}

void WebBridge::emitEvent (const juce::Identifier& eventId, const juce::var& payload)
{
    if (webView != nullptr && browserReadyForEvents)
        webView->emitEventIfBrowserIsVisible (eventId, payload);
}

juce::var WebBridge::appInfo()
{
    auto* o = new juce::DynamicObject();
    o->setProperty ("ok", true);
    o->setProperty ("app", "Mosh");
    o->setProperty ("version", MOSH_VERSION_STRING);
    o->setProperty ("stage", 0);
    o->setProperty ("backend", "juce");
    return juce::var (o);
}

} // namespace mosh
