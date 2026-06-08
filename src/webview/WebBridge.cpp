#include "WebBridge.h"

namespace mosh
{
using Resource = juce::WebBrowserComponent::Resource;

namespace
{
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

    // Strip query/fragment; map "/" → index.html (SPA).
    auto path = url.upToFirstOccurrenceOf ("?", false, false)
                   .upToFirstOccurrenceOf ("#", false, false);
    if (path.isEmpty() || path == "/")
        path = "/index.html";

    auto rel = path.startsWith ("/") ? path.substring (1) : path;
    auto file = uiDir.getChildFile (rel);

    if (! file.existsAsFile())
    {
        // SPA fallback: unknown non-asset paths serve index.html.
        if (! rel.containsChar ('.'))
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
        // The single mutation entry point (MoshOps, 02). Wired in Stage 1.
        .withNativeFunction (
            juce::Identifier ("execute_command"),
            [this] (const juce::Array<juce::var>& args,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                if (commandHandler && args.size() > 0)
                    completion (commandHandler (args[0]));
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
            });
}

void WebBridge::emitEvent (const juce::Identifier& eventId, const juce::var& payload)
{
    if (webView != nullptr)
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
