#include "HttpBridge.h"

namespace mosh
{
    HttpBridge::HttpBridge (DslExecutor& executor, juce::File uiDirToServe, int portToUse)
        : juce::Thread ("MoshHttpBridge"), exec (executor), uiDir (std::move (uiDirToServe)), port (portToUse)
    {
        exec.addListener (this);
        startThread();
    }

    HttpBridge::~HttpBridge()
    {
        exec.removeListener (this);
        signalThreadShouldExit();
        stopThread (3000);
    }

    void HttpBridge::onMoshEvent (const MoshEvent& e)
    {
        std::lock_guard<std::mutex> lock (eventMutex);
        eventLog.push_back ({ ++lastSeq, e.toVar() });
        while ((int) eventLog.size() > maxRetained)   // bounded ring
            eventLog.pop_front();
    }

    // ── message-thread marshaling (Tracktion mutates on the message thread) ────
    juce::var HttpBridge::snapshotOnMessageThread()
    {
        juce::var out;
        juce::WaitableEvent done;
        juce::MessageManager::callAsync ([&] { out = exec.getSnapshot(); done.signal(); });
        done.wait();
        return out;
    }

    juce::var HttpBridge::executeOnMessageThread (const juce::String& name, const juce::String& argsJson)
    {
        juce::var out;
        juce::WaitableEvent done;
        juce::MessageManager::callAsync ([&]
        {
            out = exec.execute (MoshCommand::fromJsonArgs (name, argsJson)).toVar();
            done.signal();
        });
        done.wait();
        return out;
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

        while (headerEnd < 0 && (int) buf.getSize() < maxBytes)
        {
            if (s.waitUntilReady (true, 3000) != 1) break;
            const int n = s.read (tmp, sizeof (tmp), false);
            if (n <= 0) break;
            buf.append (tmp, (size_t) n);
            headerEnd = buf.toString().indexOf ("\r\n\r\n");
        }
        if (headerEnd < 0) return;

        const auto headerStr = buf.toString().substring (0, headerEnd);
        const auto firstLine = headerStr.upToFirstOccurrenceOf ("\r\n", false, false);
        const auto method = firstLine.upToFirstOccurrenceOf (" ", false, false);
        const auto target = firstLine.fromFirstOccurrenceOf (" ", false, false).upToFirstOccurrenceOf (" ", false, false);
        const auto path  = target.upToFirstOccurrenceOf ("?", false, false);
        const auto query = target.fromFirstOccurrenceOf ("?", false, false);   // "" when no query

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
                if (s.waitUntilReady (true, 3000) != 1) break;
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

        if (path == "/api/snapshot")
        {
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

    void HttpBridge::run()
    {
        juce::StreamingSocket server;
        if (! server.createListener (port))
        {
            listening = false;
            return;
        }
        listening = true;

        while (! threadShouldExit())
        {
            if (server.waitUntilReady (true, 200) == 1)
            {
                if (auto* client = server.waitForNextConnection())
                {
                    std::unique_ptr<juce::StreamingSocket> c (client);
                    handleConnection (*c);
                    c->close();
                }
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
