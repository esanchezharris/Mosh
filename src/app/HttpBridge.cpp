#include "HttpBridge.h"

#if JUCE_WINDOWS
 #include <windows.h>
#endif

namespace mosh
{
    // Stop child processes (the generative service is spawned via juce::ChildProcess
    // with handle inheritance) from inheriting our listening socket — otherwise a
    // force-killed/crashed Mosh leaves an orphan holding the port, and the next
    // launch can't bind it. (Clean shutdown closes the socket; this covers crashes.)
    static void makeSocketNonInheritable (int rawHandle)
    {
       #if JUCE_WINDOWS
        if (rawHandle >= 0)
            SetHandleInformation (reinterpret_cast<HANDLE> ((juce::pointer_sized_int) rawHandle),
                                  HANDLE_FLAG_INHERIT, 0);
       #else
        juce::ignoreUnused (rawHandle);   // POSIX: covered by spawning with O_CLOEXEC elsewhere
       #endif
    }

    static void hbLog (const juce::String& line)
    {
        static const bool on = juce::SystemStats::getEnvironmentVariable ("MOSH_HTTP_DEBUG", {}).isNotEmpty();
        if (! on) return;
        juce::File::getSpecialLocation (juce::File::tempDirectory)
            .getChildFile ("mosh-http.log").appendText (line + "\n");
    }

    HttpBridge::HttpBridge (DslExecutor& executor, juce::File uiDirToServe, int portToUse)
        : juce::Thread ("MoshHttpBridge"), exec (executor), uiDir (std::move (uiDirToServe)), port (portToUse)
    {
        exec.addListener (this);
        startThread();
    }

    HttpBridge::~HttpBridge()
    {
        exec.removeListener (this);
        shuttingDown = true;              // marshaling returns early; in-flight waits time out
        signalThreadShouldExit();         // stop the accept loop
        stopThread (3000);
        connCv.notify_all();              // wake idle workers so they can exit
        for (auto& w : workers)
            if (w.joinable())
                w.join();
    }

    void HttpBridge::onMoshEvent (const MoshEvent& e)
    {
        std::lock_guard<std::mutex> lock (eventMutex);
        eventLog.push_back ({ ++lastSeq, e.toVar() });
        while ((int) eventLog.size() > maxRetained)   // bounded ring
            eventLog.pop_front();
    }

    // ── message-thread marshaling (Tracktion mutates on the message thread) ────
    // Called from worker threads. Uses shared state + a bounded wait so a worker
    // never dangles or blocks shutdown: if the message loop is gone (teardown) the
    // wait times out and the (still-alive, shared) result is harmlessly abandoned.
    // `exec` outlives this bridge (Main.cpp resets the executor AFTER the bridge).
    juce::var HttpBridge::snapshotOnMessageThread()
    {
        if (shuttingDown) return {};
        auto result = std::make_shared<juce::var>();
        auto done = std::make_shared<juce::WaitableEvent>();
        auto& e = exec;
        juce::MessageManager::callAsync ([result, done, &e] { *result = e.getSnapshot(); done->signal(); });
        done->wait (4000);
        return *result;
    }

    juce::var HttpBridge::executeOnMessageThread (const juce::String& name, const juce::String& argsJson)
    {
        if (shuttingDown) return {};
        auto result = std::make_shared<juce::var>();
        auto done = std::make_shared<juce::WaitableEvent>();
        auto& e = exec;
        juce::MessageManager::callAsync ([result, done, &e, name, argsJson]
        {
            *result = e.execute (MoshCommand::fromJsonArgs (name, argsJson)).toVar();
            done->signal();
        });
        done->wait (4000);
        return *result;
    }

    // ── server ────────────────────────────────────────────────────────────────
    static void writeResponse (juce::StreamingSocket& s, int status, const juce::String& mime,
                               const juce::MemoryBlock& body)
    {
        juce::String head;
        head << "HTTP/1.1 " << status << (status == 200 ? " OK" : " ERR") << "\r\n"
             << "Content-Type: " << mime << "\r\n"
             << "Content-Length: " << (int) body.getSize() << "\r\n"
             << "Cache-Control: no-store\r\n"
             << "Access-Control-Allow-Origin: *\r\n"
             << "Connection: close\r\n\r\n";
        const auto utf8 = head.toRawUTF8();
        s.write (utf8, (int) head.getNumBytesAsUTF8());
        if (body.getSize() > 0)
            s.write (body.getData(), (int) body.getSize());
    }

    static void writeJson (juce::StreamingSocket& s, const juce::var& v)
    {
        const auto json = juce::JSON::toString (v);
        juce::MemoryBlock mb (json.toRawUTF8(), json.getNumBytesAsUTF8());
        writeResponse (s, 200, "application/json", mb);
    }

    void HttpBridge::handleConnection (juce::StreamingSocket& s)
    {
        // Read the full request (headers + optional body).
        juce::MemoryBlock buf;
        char tmp[8192];
        int headerEnd = -1;
        const int maxBytes = 1 << 20;

        // Short read timeout: a real request's bytes arrive on localhost in <1ms (the
        // wait returns the instant data is ready), but browsers open SPECULATIVE
        // preconnections that send nothing — those must free their worker fast, not
        // hold it for seconds, or the pool starves under a browser's parallel sockets.
        while (headerEnd < 0 && (int) buf.getSize() < maxBytes)
        {
            if (s.waitUntilReady (true, 700) != 1) break;
            const int n = s.read (tmp, sizeof (tmp), false);
            if (n <= 0) break;
            buf.append (tmp, (size_t) n);
            headerEnd = buf.toString().indexOf ("\r\n\r\n");
        }
        if (headerEnd < 0) { hbLog ("handle: no headerEnd (idle/closed conn), bytes=" + juce::String ((int) buf.getSize())); return; }

        const auto headerStr = buf.toString().substring (0, headerEnd);
        const auto firstLine = headerStr.upToFirstOccurrenceOf ("\r\n", false, false);
        const auto method = firstLine.upToFirstOccurrenceOf (" ", false, false);
        const auto target = firstLine.fromFirstOccurrenceOf (" ", false, false).upToFirstOccurrenceOf (" ", false, false);
        const auto path  = target.upToFirstOccurrenceOf ("?", false, false);
        const auto query = target.fromFirstOccurrenceOf ("?", false, false);   // "" when no query
        hbLog ("handle: " + method + " " + path);

        // Body (for POST) — read up to Content-Length.
        juce::String body;
        {
            int contentLength = 0;
            for (auto& line : juce::StringArray::fromLines (headerStr))
                if (line.startsWithIgnoreCase ("content-length:"))
                    contentLength = line.fromFirstOccurrenceOf (":", false, false).trim().getIntValue();

            const int already = (int) buf.getSize() - (headerEnd + 4);
            juce::MemoryBlock bodyBuf;
            if (already > 0)
                bodyBuf.append (static_cast<const char*> (buf.getData()) + headerEnd + 4, (size_t) already);
            while ((int) bodyBuf.getSize() < contentLength && (int) bodyBuf.getSize() < maxBytes)
            {
                if (s.waitUntilReady (true, 2000) != 1) break;
                const int n = s.read (tmp, sizeof (tmp), false);
                if (n <= 0) break;
                bodyBuf.append (tmp, (size_t) n);
            }
            body = bodyBuf.toString();
        }

        // ── routes ────────────────────────────────────────────────────────────
        if (method == "OPTIONS")
        {
            writeResponse (s, 200, "text/plain", {});
            return;
        }

        if (path == "/api/diag")
        {
            // Diagnostic (does NOT set uiConnected): report whether a UI client has
            // initialized against this backend yet.
            auto* o = new juce::DynamicObject();
            o->setProperty ("uiConnected", uiConnected.load());
            o->setProperty ("listening", listening.load());
            writeJson (s, juce::var (o));
            return;
        }

        if (path == "/api/snapshot")
        {
            uiConnected = true;   // the frontend initialized against this backend
            writeJson (s, snapshotOnMessageThread());
            return;
        }

        if (path == "/api/command" && method == "POST")
        {
            const auto cmd = juce::JSON::parse (body);
            const auto name = cmd["name"].toString();
            const auto argsJson = juce::JSON::toString (cmd["args"].isVoid() ? juce::var (new juce::DynamicObject()) : cmd["args"]);
            writeJson (s, executeOnMessageThread (name, argsJson));
            return;
        }

        if (path == "/api/events")
        {
            // Non-destructive cursor read: return events with seq > ?since=N.
            juce::int64 since = 0;
            if (const auto idx = query.indexOf ("since="); idx >= 0)
                since = query.substring (idx + 6).upToFirstOccurrenceOf ("&", false, false).getLargeIntValue();

            juce::Array<juce::var> events;
            juce::int64 cursor = since;
            bool resync = false;
            {
                std::lock_guard<std::mutex> lock (eventMutex);
                const juce::int64 oldest = eventLog.empty() ? lastSeq : eventLog.front().seq;
                if (since + 1 < oldest)
                {
                    // Client fell behind the retained window → it missed trimmed
                    // events. Tell it to resync (refetch snapshot) and skip the gap.
                    resync = true;
                    cursor = lastSeq;
                }
                else
                {
                    for (const auto& se : eventLog)
                        if (se.seq > since)
                        {
                            events.add (se.data);
                            cursor = se.seq;
                        }
                }
            }

            auto* o = new juce::DynamicObject();
            o->setProperty ("events", events);
            o->setProperty ("seq", cursor);
            o->setProperty ("resync", resync);
            writeJson (s, juce::var (o));
            return;
        }

        // Static files from the UI bundle.
        auto rel = (path == "/" || path.isEmpty()) ? juce::String ("index.html")
                                                   : path.trimCharactersAtStart ("/");
        auto file = uiDir.getChildFile (rel);
        if (file.existsAsFile())
        {
            // For the HTML document, inject a marker so the bridge selects the HTTP
            // transport (against this real backend) rather than the in-browser mock.
            if (file.getFileName().endsWithIgnoreCase (".html"))
            {
                auto html = file.loadFileAsString();
                const juce::String marker = "<script>window.__MOSH_BACKEND__=\"http\";</script>";
                // Inject as the FIRST thing in <head> so the marker is set before the
                // deferred module script runs selectBridge() (ordering matters).
                if (html.contains ("<head>"))        html = html.replace ("<head>", "<head>" + marker);
                else if (html.contains ("</head>"))  html = html.replace ("</head>", marker + "</head>");
                else                                  html = marker + html;
                // Defensive for the in-app WebView2: drop Vite's `crossorigin` attr
                // (unnecessary same-origin, can trip CORS in some embedders) and
                // neutralize the CSP meta (local trusted content).
                html = html.replace (" crossorigin", "");
                html = html.replace ("http-equiv=\"Content-Security-Policy\"", "http-equiv=\"x-mosh-csp-off\"");
                juce::MemoryBlock mb (html.toRawUTF8(), html.getNumBytesAsUTF8());
                writeResponse (s, 200, "text/html", mb);
                return;
            }

            juce::MemoryBlock mb;
            if (file.loadFileAsData (mb))
            {
                writeResponse (s, 200, mimeFor (file.getFileName()), mb);
                return;
            }
        }

        writeResponse (s, 404, "text/plain", juce::MemoryBlock ("Not found", 9));
    }

    void HttpBridge::run()   // accept loop — hands each connection to a worker
    {
        juce::StreamingSocket server;
        if (! server.createListener (port))
        {
            listening = false;
            return;
        }
        makeSocketNonInheritable (server.getRawSocketHandle());
        listening = true;

        // Start the worker pool. A browser holds several parallel sockets (Chrome
        // preconnects up to ~6 per host) — size for those plus spares for real
        // requests so the UI never starves.
        const int n = juce::jlimit (12, 24, (int) std::thread::hardware_concurrency() + 4);
        for (int i = 0; i < n; ++i)
            workers.emplace_back ([this] { workerLoop(); });
        hbLog ("run: listening on " + juce::String (port) + " workers=" + juce::String (n));

        while (! threadShouldExit())
        {
            const int ready = server.waitUntilReady (true, 200);
            if (ready == 1)
            {
                if (auto* client = server.waitForNextConnection())
                {
                    {
                        std::lock_guard<std::mutex> lk (connMutex);
                        connQueue.emplace_back (client);
                    }
                    connCv.notify_one();
                }
            }
            else if (ready < 0)
            {
                hbLog ("accept: waitUntilReady error");
            }
        }
    }

    void HttpBridge::workerLoop()
    {
        for (;;)
        {
            std::unique_ptr<juce::StreamingSocket> c;
            {
                std::unique_lock<std::mutex> lk (connMutex);
                connCv.wait (lk, [this] { return shuttingDown.load() || ! connQueue.empty(); });
                if (! connQueue.empty())
                {
                    c = std::move (connQueue.front());
                    connQueue.pop_front();
                }
                else if (shuttingDown)
                {
                    return;
                }
            }
            if (c != nullptr)
            {
                handleConnection (*c);
                c->close();
            }
        }
    }

    juce::String HttpBridge::mimeFor (const juce::String& path)
    {
        const auto ext = path.fromLastOccurrenceOf (".", false, false).toLowerCase();
        if (ext == "html") return "text/html";
        if (ext == "js" || ext == "mjs") return "text/javascript";
        if (ext == "css") return "text/css";
        if (ext == "json" || ext == "map") return "application/json";
        if (ext == "svg") return "image/svg+xml";
        if (ext == "png") return "image/png";
        if (ext == "woff2") return "font/woff2";
        if (ext == "ico") return "image/x-icon";
        return "application/octet-stream";
    }
}
