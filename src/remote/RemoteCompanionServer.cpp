#include "RemoteCompanionServer.h"

#include <cerrno>
#include <cstring>
#include <memory>

#if ! JUCE_WINDOWS
 #include <arpa/inet.h>
 #include <netinet/in.h>
 #include <sys/socket.h>
 #include <unistd.h>
#endif

#if JUCE_MAC
 #include <dlfcn.h>
#endif

namespace mosh
{
namespace
{
    juce::String statusText (int status)
    {
        if (status == 200) return "OK";
        if (status == 400) return "Bad Request";
        if (status == 401) return "Unauthorized";
        if (status == 404) return "Not Found";
        return "Internal Server Error";
    }

    juce::var parseBody (const juce::String& body)
    {
        if (body.trim().isEmpty())
            return juce::var (new juce::DynamicObject());
        return juce::JSON::parse (body);
    }

    juce::String propString (const juce::var& v, const juce::Identifier& id)
    {
        return v.getProperty (id, juce::var()).toString();
    }

    int propInt (const juce::var& v, const juce::Identifier& id, int fallback)
    {
        auto p = v.getProperty (id, juce::var());
        return p.isVoid() ? fallback : (int) p;
    }

    double propDouble (const juce::var& v, const juce::Identifier& id, double fallback)
    {
        auto p = v.getProperty (id, juce::var());
        return p.isVoid() ? fallback : (double) p;
    }

    // Bind diagnostic. JUCE's createListener returns a bare bool and, on failure, runs a
    // cleanup shutdown()/close() that overwrites errno (ENOTCONN) before it returns — so the
    // real cause (e.g. EADDRINUSE) can't be read back here. Instead we probe the port
    // ourselves BEFORE handing it to JUCE: a raw bind that fails tells us accurately whether
    // something already holds the port. Names the port either way (the observability fix for
    // the PR #267 misdiagnosis, where a bare "could not start" hid whether the port was even
    // the problem). Returns e.g. " (port 47873 already in use)".
    juce::String probeBindFailure (int requestedPort)
    {
        juce::String detail = juce::String (" (port ") + juce::String (requestedPort);
       #if ! JUCE_WINDOWS
        const int probe = ::socket (AF_INET, SOCK_STREAM, 0);
        if (probe >= 0)
        {
            int reuse = 1;
            ::setsockopt (probe, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof (reuse));
            sockaddr_in addr {};
            addr.sin_family = AF_INET;
            addr.sin_addr.s_addr = htonl (INADDR_ANY);
            addr.sin_port = htons ((uint16_t) requestedPort);
            errno = 0;
            if (::bind (probe, reinterpret_cast<sockaddr*> (&addr), sizeof (addr)) != 0 && errno != 0)
                detail += juce::String (": ") + juce::String (strerror (errno));
            ::close (probe);
        }
       #endif
        return detail + ")";
    }
}

RemoteCompanionServer::RemoteCompanionServer (juce::File takeRoot)
    : Thread ("Mosh Remote Companion"),
      takeStore (takeRoot),
      monitorStore (takeRoot.getSiblingFile ("diagnostics").getChildFile ("monitoring"))
{
}

RemoteCompanionServer::~RemoteCompanionServer()
{
    stopServer();
}

juce::var RemoteCompanionServer::startPairing (const juce::var& args)
{
    const int requestedPort = (int) args.getProperty ("port", RemoteCompanionProtocol::defaultPort());
    if (RemoteCompanionProtocol::isRestrictedPort (requestedPort))
        return err ("refusing restricted companion port");

    const juce::ScopedLock sl (lock);
    if (! running)
    {
        listener = std::make_unique<juce::StreamingSocket>();
        if (! listener->createListener (requestedPort, {}))
        {
            listener.reset();
            return err ("could not start remote companion server" + probeBindFailure (requestedPort));
        }

        port = listener->getBoundPort();
        running = true;
        startBonjour();
        startThread();
    }

    const auto info = protocol.beginPairing (localBonjourHost(), port, juce::Time::currentTimeMillis());
    auto* data = new juce::DynamicObject();
    data->setProperty ("running", true);
    data->setProperty ("pairing", toVar (info));
    return ok (juce::var (data));
}

juce::var RemoteCompanionServer::startLabFeed (const juce::String& token)
{
    const int requestedPort = RemoteCompanionProtocol::defaultPort();

    const juce::ScopedLock sl (lock);
    if (! running)
    {
        listener = std::make_unique<juce::StreamingSocket>();
        if (! listener->createListener (requestedPort, {}))
        {
            listener.reset();
            return err ("could not start lab feed server" + probeBindFailure (requestedPort));
        }

        port = listener->getBoundPort();
        running = true;
        startBonjour();
        startThread();
    }

    const auto info = protocol.beginPairing (localBonjourHost(), port,
                                             juce::Time::currentTimeMillis(),
                                             token,
                                             24 * 60 * 60 * 1000LL);
    juce::ignoreUnused (info);
    auto* data = new juce::DynamicObject();
    data->setProperty ("running", true);
    data->setProperty ("labFeed", true);
    data->setProperty ("port", port);
    return ok (juce::var (data));
}

juce::var RemoteCompanionServer::startOwnerControl (const juce::String& token)
{
    if (token.isEmpty())
        return err ("owner control token is required");

    const juce::ScopedLock sl (lock);
    if (running && ! ownerControl)
        return err ("remote companion server is already running");
    if (! running)
    {
        listener = std::make_unique<juce::StreamingSocket>();
        if (! listener->createListener (0, "127.0.0.1"))
        {
            listener.reset();
            return err ("could not start owner control server");
        }
        port = listener->getBoundPort();
        running = true;
        ownerControl = true;
        startThread();
    }

    protocol.beginPairing ("127.0.0.1", port, juce::Time::currentTimeMillis(),
                           token, 24 * 60 * 60 * 1000LL);
    auto* data = new juce::DynamicObject();
    data->setProperty ("running", true);
    data->setProperty ("port", port);
    data->setProperty ("origin", "http://127.0.0.1:" + juce::String (port));
    return ok (juce::var (data));
}

juce::var RemoteCompanionServer::stopServer()
{
    {
        const juce::ScopedLock sl (lock);
        running = false;
        ownerControl = false;
        protocol.clearPairing();
        stopBonjour();
        if (listener != nullptr)
            listener->close();
    }

    stopThread (2000);
    const juce::ScopedLock sl (lock);
    listener.reset();
    eventQueue.clear();
    eventSeq = 0;
    return ok();
}

juce::var RemoteCompanionServer::status (bool includePairingSecrets) const
{
    const juce::ScopedLock sl (lock);
    auto* data = new juce::DynamicObject();
    data->setProperty ("running", running);
    data->setProperty ("port", port);
    auto info = protocol.currentPairing();
    if (includePairingSecrets && info.token.isNotEmpty())
        data->setProperty ("pairing", toVar (info, true));
    return ok (juce::var (data));
}

void RemoteCompanionServer::pushEvent (const juce::var& event)
{
    const juce::ScopedLock sl (lock);
    if (! running)
        return;

    auto* wrapped = new juce::DynamicObject();
    wrapped->setProperty ("seq", ++eventSeq);
    wrapped->setProperty ("event", event);
    eventQueue.add (juce::var (wrapped));
    while (eventQueue.size() > 256)
        eventQueue.remove (0);
}

#if MOSH_TESTING
juce::var RemoteCompanionServer::handleTestRequest (const juce::String& method,
                                                    const juce::String& path,
                                                    const juce::var& body)
{
    Request request;
    request.method = method;
    request.path = path;
    request.body = juce::JSON::toString (body);
    return handleRequest (request);
}
#endif

void RemoteCompanionServer::run()
{
    while (! threadShouldExit())
    {
        std::unique_ptr<juce::StreamingSocket> client;
        juce::StreamingSocket* activeListener = nullptr;
        {
            const juce::ScopedLock sl (lock);
            if (listener == nullptr)
                break;
            activeListener = listener.get();
        }

        client.reset (activeListener->waitForNextConnection());
        if (client != nullptr)
            handleClient (std::move (client));
    }
}

void RemoteCompanionServer::handleClient (std::unique_ptr<juce::StreamingSocket> client)
{
    Request request;
    if (! parseRequest (*client, request))
    {
        writeJsonResponse (*client, 400, err ("malformed request"));
        return;
    }

    bool isOwnerControl = false;
    {
        const juce::ScopedLock sl (lock);
        isOwnerControl = ownerControl;
    }
    if (! isOwnerControl && request.method == "GET" && request.path == "/web")
    {
        writeTextResponse (*client, 200, "text/html; charset=utf-8", webCompanionHtml());
        return;
    }

    const auto result = handleRequest (request);
    const int code = result.getProperty ("ok", false) ? 200
        : (result.getProperty ("error", {}).toString().containsIgnoreCase ("token") ? 401 : 400);
    writeJsonResponse (*client, code, result);
}

juce::var RemoteCompanionServer::handleRequest (const Request& request)
{
    bool isOwnerControl = false;
    {
        const juce::ScopedLock sl (lock);
        isOwnerControl = ownerControl;
    }
    if (! isOwnerControl && request.method == "GET" && request.path == "/web")
    {
        auto* data = new juce::DynamicObject();
        data->setProperty ("html", webCompanionHtml());
        return ok (juce::var (data));
    }

    if (request.method == "GET" && request.path == "/health")
        return status (false);

    const auto body = parseBody (request.body);
    if (body.isVoid())
        return err ("invalid json");

    const auto auth = authorizeRequest (request, body);
    if (! auth.ok)
        return err (auth.error);

    if (isOwnerControl && request.path != "/snapshot" && request.path != "/command")
        return err ("unknown owner control endpoint");

    if (request.method == "POST" && request.path == "/snapshot")
        return ok (callOnMessageThread ([this] { return snapshotProvider ? snapshotProvider() : juce::var(); }));

    if (request.method == "POST" && request.path == "/command")
    {
        const auto command = body.getProperty ("command", juce::var());
        if (! command.isObject())
            return err ("missing command object");
        return ok (callOnMessageThread ([this, command] { return commandHandler ? commandHandler (command) : juce::var(); }));
    }

    if (request.method == "POST" && request.path == "/events")
        return ok (eventsSince (propInt (body, "since", 0)));

    if (request.method == "POST" && request.path == "/monitor/ping")
    {
        auto* data = new juce::DynamicObject();
        data->setProperty ("macTimeMs", (double) juce::Time::currentTimeMillis());
        data->setProperty ("phoneTimeMs", body.getProperty ("phoneTimeMs", 0.0));
        return ok (juce::var (data));
    }

    if (request.method == "POST" && request.path == "/monitor/start")
    {
        auto started = monitorStore.startMonitor (propString (body, "mode"));
        if (! started.ok)
            return err (started.error);
        auto* data = new juce::DynamicObject();
        data->setProperty ("sessionId", started.sessionId);
        data->setProperty ("sampleRate", started.sampleRate);
        data->setProperty ("chunkFrames", started.chunkFrames);
        return ok (juce::var (data));
    }

    if (request.method == "POST" && request.path == "/monitor/chunk")
    {
        auto chunk = monitorStore.nextProbeChunk (propString (body, "sessionId"),
                                                 propInt (body, "sequence", -1));
        if (! chunk.ok)
            return err (chunk.error);

        auto* data = new juce::DynamicObject();
        data->setProperty ("sessionId", chunk.sessionId);
        data->setProperty ("sequence", chunk.sequence);
        data->setProperty ("sampleRate", chunk.sampleRate);
        data->setProperty ("chunkFrames", chunk.chunkFrames);
        data->setProperty ("sentAtMacMs", (double) chunk.sentAtMacMs);
        data->setProperty ("pcm16Base64", juce::Base64::toBase64 (chunk.pcm16.getData(), chunk.pcm16.getSize()));
        return ok (juce::var (data));
    }

    if (request.method == "POST" && request.path == "/monitor/report")
    {
        RemoteMonitorReportRequest report;
        report.sessionId = propString (body, "sessionId");
        report.networkMedianMs = propDouble (body, "networkMedianMs", 0.0);
        report.networkP95Ms = propDouble (body, "networkP95Ms", 0.0);
        report.networkJitterMs = propDouble (body, "networkJitterMs", 0.0);
        report.acousticMedianMs = propDouble (body, "acousticMedianMs", 0.0);
        report.acousticP95Ms = propDouble (body, "acousticP95Ms", 0.0);
        report.acousticJitterMs = propDouble (body, "acousticJitterMs", 0.0);
        auto written = monitorStore.writeReport (report, juce::Time::currentTimeMillis());
        if (! written.ok)
            return err (written.error);
        auto* data = new juce::DynamicObject();
        data->setProperty ("reportFile", written.reportFile.getFullPathName());
        return ok (juce::var (data));
    }

    if (request.method == "POST" && request.path == "/monitor/stop")
    {
        auto stopped = monitorStore.stopMonitor (propString (body, "sessionId"));
        return stopped.ok ? ok() : err (stopped.error);
    }

    if (request.method == "POST" && request.path == "/take/start")
    {
        RemoteTakeStartRequest take;
        take.trackId = propString (body, "trackId");
        take.name = propString (body, "name");
        take.sampleRate = (double) body.getProperty ("sampleRate", 44100.0);
        take.channels = propInt (body, "channels", 1);
        auto started = takeStore.startTake (take);
        if (! started.ok)
            return err (started.error);
        auto* data = new juce::DynamicObject();
        data->setProperty ("takeId", started.takeId);
        return ok (juce::var (data));
    }

    if (request.method == "POST" && request.path == "/take/chunk")
    {
        juce::MemoryOutputStream decodedPcm;
        if (! juce::Base64::convertFromBase64 (decodedPcm, propString (body, "pcm16Base64")))
            return err ("invalid pcm16Base64");
        juce::MemoryBlock pcm (decodedPcm.getData(), decodedPcm.getDataSize());
        auto appended = takeStore.appendPcm16Chunk (propString (body, "takeId"),
                                                   propInt (body, "sequence", -1), pcm);
        return appended.ok ? ok() : err (appended.error);
    }

    if (request.method == "POST" && request.path == "/take/cancel")
    {
        auto cancelled = takeStore.cancelTake (propString (body, "takeId"));
        return cancelled.ok ? ok() : err (cancelled.error);
    }

    if (request.method == "POST" && request.path == "/take/finish")
    {
        auto finished = takeStore.finishTake (propString (body, "takeId"));
        if (! finished.ok)
            return err (finished.error);

        auto* args = new juce::DynamicObject();
        args->setProperty ("file", finished.file.getFullPathName());
        args->setProperty ("name", finished.name);
        if (finished.trackId.isNotEmpty())
            args->setProperty ("trackId", finished.trackId);
        args->setProperty ("startSeconds", body.getProperty ("startSeconds", 0.0));

        auto* command = new juce::DynamicObject();
        command->setProperty ("command", "import_clip");
        command->setProperty ("args", juce::var (args));

        auto imported = callOnMessageThread ([this, commandVar = juce::var (command)] {
            return commandHandler ? commandHandler (commandVar) : juce::var();
        });

        auto* data = new juce::DynamicObject();
        data->setProperty ("takeId", finished.takeId);
        data->setProperty ("file", finished.file.getFullPathName());
        data->setProperty ("import", imported);
        return ok (juce::var (data));
    }

    return err ("unknown remote endpoint");
}

bool RemoteCompanionServer::parseRequest (juce::StreamingSocket& socket, Request& request)
{
    const auto headers = readHeaders (socket);
    if (headers.isEmpty())
        return false;

    auto lines = juce::StringArray::fromLines (headers);
    if (lines.isEmpty())
        return false;

    auto first = juce::StringArray::fromTokens (lines[0], " ", {});
    if (first.size() < 2)
        return false;
    request.method = first[0].trim();
    const auto target = first[1].trim();
    request.path = target.upToFirstOccurrenceOf ("?", false, false).trim();
    request.query = target.fromFirstOccurrenceOf ("?", false, false).trim();
    request.contentLength = headerValue (lines, "content-length").getIntValue();
    auto auth = headerValue (lines, "authorization");
    if (auth.startsWithIgnoreCase ("bearer "))
        request.authToken = auth.substring (7).trim();

    if (request.contentLength > 0)
    {
        juce::MemoryBlock body ((size_t) request.contentLength, true);
        int offset = 0;
        while (offset < request.contentLength)
        {
            const int bytes = socket.read ((char*) body.getData() + offset, request.contentLength - offset, true);
            if (bytes <= 0)
                return false;
            offset += bytes;
        }
        request.body = juce::String::fromUTF8 ((const char*) body.getData(), (int) body.getSize());
    }

    return true;
}

juce::String RemoteCompanionServer::readHeaders (juce::StreamingSocket& socket)
{
    juce::String headers;
    char c = 0;
    while (headers.getNumBytesAsUTF8() < 64 * 1024)
    {
        const auto ready = socket.waitUntilReady (true, 2500);
        if (ready <= 0)
            break;
        if (socket.read (&c, 1, true) != 1)
            break;
        headers += juce::String::charToString ((juce::juce_wchar) c);
        if (headers.endsWith ("\r\n\r\n"))
            break;
    }
    return headers;
}

juce::String RemoteCompanionServer::headerValue (const juce::StringArray& lines, const juce::String& name)
{
    for (auto line : lines)
    {
        const auto key = line.upToFirstOccurrenceOf (":", false, false).trim();
        if (key.equalsIgnoreCase (name))
            return line.fromFirstOccurrenceOf (":", false, false).trim();
    }
    return {};
}

void RemoteCompanionServer::writeJsonResponse (juce::StreamingSocket& socket,
                                               int statusCode,
                                               const juce::var& body)
{
    const auto json = juce::JSON::toString (body, true);
    const auto headers = "HTTP/1.1 " + juce::String (statusCode) + " " + statusText (statusCode) + "\r\n"
        + "Content-Type: application/json\r\n"
        + "Access-Control-Allow-Origin: *\r\n"
        + "Connection: close\r\n"
        + "Content-Length: " + juce::String (json.getNumBytesAsUTF8()) + "\r\n\r\n";
    socket.write (headers.toRawUTF8(), (int) headers.getNumBytesAsUTF8());
    socket.write (json.toRawUTF8(), (int) json.getNumBytesAsUTF8());
}

void RemoteCompanionServer::writeTextResponse (juce::StreamingSocket& socket,
                                               int statusCode,
                                               const juce::String& contentType,
                                               const juce::String& body)
{
    const auto headers = "HTTP/1.1 " + juce::String (statusCode) + " " + statusText (statusCode) + "\r\n"
        + "Content-Type: " + contentType + "\r\n"
        + "Cache-Control: no-store\r\n"
        + "Connection: close\r\n"
        + "Content-Length: " + juce::String (body.getNumBytesAsUTF8()) + "\r\n\r\n";
    socket.write (headers.toRawUTF8(), (int) headers.getNumBytesAsUTF8());
    socket.write (body.toRawUTF8(), (int) body.getNumBytesAsUTF8());
}

juce::String RemoteCompanionServer::webCompanionHtml()
{
    // Prefer the built DAWN-style controller page staged into the bundle by cmake/BuildCompanion.cmake
    // (ui/companion → Contents/Resources/companion/index.html), mirroring how WebBridge serves the UI.
    // Falls back to the inline page below when the build isn't staged (dev, or a bare build).
    auto appFile = juce::File::getSpecialLocation (juce::File::currentApplicationFile);
    auto staged = appFile.getChildFile ("Contents/Resources/companion/index.html"); // macOS bundle
    if (! staged.existsAsFile())
        staged = juce::File::getSpecialLocation (juce::File::currentExecutableFile)
                     .getParentDirectory().getChildFile ("companion/index.html");     // Windows/flat
    if (staged.existsAsFile())
    {
        const auto html = staged.loadFileAsString();
        if (html.isNotEmpty())
            return html;
    }
    return legacyWebCompanionHtml();
}

juce::String RemoteCompanionServer::legacyWebCompanionHtml()
{
    return R"HTML(<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>MOSH Web Companion</title>
<style>
:root{color-scheme:dark;background:#111318;color:#f4f1ea;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}body{margin:0;padding:18px;background:#111318;color:#f4f1ea}
main{max-width:520px;margin:0 auto;display:grid;gap:14px}.top{display:flex;justify-content:space-between;align-items:center;gap:12px}
h1{font-size:21px;line-height:1.15;margin:0;font-weight:750}button,select,input{font:inherit}
.status{font-size:13px;color:#b8c1ca}.panel{border:1px solid #2b3038;background:#171b22;border-radius:8px;padding:12px;display:grid;gap:10px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.stack{display:grid;gap:8px}
button{border:1px solid #343b45;background:#222832;color:#f4f1ea;border-radius:7px;padding:10px 12px;font-weight:650}
button.primary{background:#d7ff61;color:#111318;border-color:#d7ff61}button.danger{background:#3a2023;border-color:#5d3137}
button:disabled{opacity:.45}select,input[type=file]{width:100%;border:1px solid #343b45;background:#0f1217;color:#f4f1ea;border-radius:7px;padding:10px}
.receipt{font-size:13px;color:#b8c1ca;min-height:18px}.warn{font-size:13px;color:#ffd27a}.small{font-size:12px;color:#8d98a6}.targets{display:grid;gap:6px}
</style>
</head>
<body>
<main>
  <div class="top">
    <h1>MOSH Web Companion</h1>
    <button id="refresh">Refresh</button>
  </div>
  <div id="status" class="status">Pairing...</div>
  <section class="panel">
    <div class="row">
      <button id="play" class="primary">Play</button>
      <button id="stop">Stop</button>
    </div>
    <div class="small" id="session">No snapshot yet.</div>
  </section>
  <section class="panel">
    <label class="small" for="track">Take target</label>
    <select id="track"></select>
    <div class="row">
      <button id="record" class="primary">Record Take</button>
      <button id="finish" disabled>Finish</button>
    </div>
    <input id="fileTake" type="file" accept="audio/*" capture>
    <div id="micWarn" class="warn"></div>
  </section>
  <section class="panel">
    <label class="small" for="renderTarget">Rendered layer target</label>
    <select id="renderTarget"></select>
    <div class="row">
      <button id="accept">Accept</button>
      <button id="reject" class="danger">Reject</button>
    </div>
  </section>
  <section class="panel">
    <div class="small">Recent action</div>
    <div id="receipt" class="receipt"></div>
  </section>
</main>
<script>
const statusEl = document.getElementById('status');
const receiptEl = document.getElementById('receipt');
const sessionEl = document.getElementById('session');
const trackEl = document.getElementById('track');
const renderEl = document.getElementById('renderTarget');
const recordBtn = document.getElementById('record');
const finishBtn = document.getElementById('finish');
const fileTake = document.getElementById('fileTake');
const micWarn = document.getElementById('micWarn');
let pairing = null;
let snapshot = null;
let selectedTrackId = '';
let selectedRenderClipId = '';
let recording = null;

function say(text){ receiptEl.textContent = text; }
function parsePairing(){
  const payload = new URL(location.href).searchParams.get('payload');
  if (!payload) throw new Error('Missing pairing payload. Scan the Safari Web QR from the Mac popover.');
  return JSON.parse(atob(decodeURIComponent(payload)));
}
async function post(path, body={}){
  const res = await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,token:pairing.token})});
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || path + ' failed');
  return json.data;
}
function render(){
  const tracks = snapshot?.tracks || [];
  trackEl.innerHTML = '';
  tracks.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.id; opt.textContent = t.name || t.id;
    trackEl.appendChild(opt);
  });
  if (!selectedTrackId && tracks[0]) selectedTrackId = tracks[0].id;
  trackEl.value = selectedTrackId;

  const targets = [];
  tracks.forEach(t => (t.clips || []).forEach(c => {
    if (c.renderLayer && c.renderLayer.hasArtifact) targets.push({clipId:c.id,label:(t.name||'Track') + ' / ' + (c.name||c.id)});
  }));
  renderEl.innerHTML = '';
  targets.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.clipId; opt.textContent = t.label;
    renderEl.appendChild(opt);
  });
  if (!targets.some(t => t.clipId === selectedRenderClipId)) selectedRenderClipId = targets[0]?.clipId || '';
  renderEl.value = selectedRenderClipId;
  document.getElementById('accept').disabled = !selectedRenderClipId;
  document.getElementById('reject').disabled = !selectedRenderClipId;
  sessionEl.textContent = tracks.length + ' track(s), ' + targets.length + ' rendered target(s)';
}
async function refresh(){
  snapshot = await post('/snapshot');
  render();
  statusEl.textContent = 'Connected to ' + pairing.host + ':' + pairing.port;
}
async function command(name,args={}){
  const result = await post('/command',{command:{command:name,args}});
  say(result.ok ? name : (result.error || name + ' failed'));
  await refresh();
}
function pcm16Base64(float32){
  const bytes = new Uint8Array(float32.length * 2);
  for (let i=0;i<float32.length;i++){
    const s = Math.max(-1, Math.min(1, float32[i]));
    const v = s < 0 ? s * 32768 : s * 32767;
    const n = Math.round(v);
    bytes[i*2] = n & 255;
    bytes[i*2+1] = (n >> 8) & 255;
  }
  let out = '';
  for (let i=0;i<bytes.length;i+=8192) out += String.fromCharCode.apply(null, bytes.subarray(i,i+8192));
  return btoa(out);
}
async function startTake(sampleRate){
  const data = await post('/take/start',{trackId:selectedTrackId,name:'Safari Take',sampleRate,channels:1});
  return data.takeId;
}
async function startLiveTake(){
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Live mic is unavailable in this browser context.');
  const stream = await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:false,noiseSuppression:false}});
  const ctx = new AudioContext();
  const takeId = await startTake(ctx.sampleRate);
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096,1,1);
  let sequence = 0;
  let queue = Promise.resolve();
  processor.onaudioprocess = ev => {
    const samples = new Float32Array(ev.inputBuffer.getChannelData(0));
    const seq = sequence++;
    const pcm16Base64 = pcm16Base64FromSamples(samples);
    queue = queue.then(() => post('/take/chunk',{takeId,sequence:seq,pcm16Base64}));
  };
  source.connect(processor);
  processor.connect(ctx.destination);
  recording = {takeId,ctx,stream,source,processor,get queue(){return queue;}};
  recordBtn.disabled = true;
  finishBtn.disabled = false;
  say('Recording live take...');
}
function pcm16Base64FromSamples(samples){ return pcm16Base64(samples); }
async function finishLiveTake(){
  if (!recording) return;
  const current = recording;
  recording = null;
  current.processor.disconnect();
  current.source.disconnect();
  current.stream.getTracks().forEach(t => t.stop());
  await current.queue;
  await current.ctx.close();
  await post('/take/finish',{takeId:current.takeId,startSeconds:0});
  recordBtn.disabled = false;
  finishBtn.disabled = true;
  say('Phone take imported');
  await refresh();
}
async function uploadFileTake(file){
  const data = await file.arrayBuffer();
  const ctx = new AudioContext();
  const audio = await ctx.decodeAudioData(data);
  const samples = audio.getChannelData(0);
  const takeId = await startTake(audio.sampleRate);
  const frames = 4096;
  for (let offset=0, sequence=0; offset<samples.length; offset+=frames, sequence++){
    await post('/take/chunk',{takeId,sequence,pcm16Base64:pcm16Base64(samples.slice(offset,offset+frames))});
  }
  await post('/take/finish',{takeId,startSeconds:0});
  await ctx.close();
  say('Uploaded recorded audio take');
  await refresh();
}
document.getElementById('refresh').onclick = () => refresh().catch(e => say(e.message));
document.getElementById('play').onclick = () => command('set_transport',{action:'play'}).catch(e => say(e.message));
document.getElementById('stop').onclick = () => command('set_transport',{action:'stop'}).catch(e => say(e.message));
document.getElementById('accept').onclick = () => command('accept_render',{clipId:selectedRenderClipId}).catch(e => say(e.message));
document.getElementById('reject').onclick = () => command('reject_render',{clipId:selectedRenderClipId}).catch(e => say(e.message));
trackEl.onchange = () => selectedTrackId = trackEl.value;
renderEl.onchange = () => selectedRenderClipId = renderEl.value;
recordBtn.onclick = () => startLiveTake().catch(e => { micWarn.textContent = e.message + ' Use the file recorder fallback below.'; say(e.message); });
finishBtn.onclick = () => finishLiveTake().catch(e => say(e.message));
fileTake.onchange = () => fileTake.files?.[0] && uploadFileTake(fileTake.files[0]).catch(e => say(e.message));
try {
  pairing = parsePairing();
  if (!window.isSecureContext) micWarn.textContent = 'Live mic may be blocked on local HTTP; file capture remains available.';
  refresh().catch(e => say(e.message));
} catch (e) {
  statusEl.textContent = e.message;
}
</script>
</body>
</html>)HTML";
}

juce::var RemoteCompanionServer::ok (juce::var data)
{
    auto* o = new juce::DynamicObject();
    o->setProperty ("ok", true);
    if (! data.isVoid())
        o->setProperty ("data", data);
    return juce::var (o);
}

juce::var RemoteCompanionServer::err (const juce::String& message)
{
    auto* o = new juce::DynamicObject();
    o->setProperty ("ok", false);
    o->setProperty ("error", message);
    return juce::var (o);
}

juce::var RemoteCompanionServer::toVar (const RemotePairingInfo& info, bool includeSecrets)
{
    auto* o = new juce::DynamicObject();
    o->setProperty ("host", info.host);
    o->setProperty ("port", info.port);
    o->setProperty ("expiresAtMs", (double) info.expiresAtMs);
    if (includeSecrets)
    {
        o->setProperty ("token", info.token);
        o->setProperty ("pairingUrl", info.pairingUrl);
        o->setProperty ("webUrl", info.webUrl);
    }
    return juce::var (o);
}

juce::String RemoteCompanionServer::localBonjourHost()
{
    auto name = juce::SystemStats::getComputerName().trim();
    if (name.isEmpty())
        name = "Mosh-Mac";
    name = name.retainCharacters ("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-");
    return name + ".local";
}

juce::var RemoteCompanionServer::callOnMessageThread (const std::function<juce::var()>& fn,
                                                      int timeoutMs) const
{
    if (juce::MessageManager::getInstance()->isThisTheMessageThread())
        return fn();

    // On a timeout we return WITHOUT joining the queued job — the message thread
    // may still be blocked (e.g. a long cmdExportAudio) and run the lambda well
    // after this stack frame is gone. Capturing `done`/`result` BY REFERENCE (the
    // old code) is a cross-thread use-after-free the moment that happens: the
    // async lambda later writes through &result/&done into a freed stack frame,
    // and calls the dangling `fn` too. Fix: give the shared state HEAP lifetime via
    // shared_ptr, and capture a BY-VALUE copy of `fn` (not a reference to the
    // caller's temporary) into the async lambda — both copies keep the state (and
    // the callable) alive for as long as either side still needs them. If we time
    // out, our shared_ptr just drops; the lambda's own copy keeps Shared alive
    // until it actually runs, then the lambda's copy drops too and Shared is freed
    // — never while anything still references it. `result` is only read by the
    // waiter AFTER `done.wait()` returns true, i.e. after the message-thread side
    // has already signalled — no data race on the value itself.
    struct Shared { juce::WaitableEvent done; juce::var result; };
    auto shared = std::make_shared<Shared>();
    std::function<juce::var()> fnCopy = fn;
    juce::MessageManager::callAsync ([shared, fnCopy] {
        shared->result = fnCopy();
        shared->done.signal();
    });
    if (! shared->done.wait (timeoutMs))
        return err ("message-thread call timed out");
    return shared->result;
}

RemoteAuthResult RemoteCompanionServer::authorizeRequest (const Request& request,
                                                          const juce::var& body) const
{
    const auto token = request.authToken.isNotEmpty() ? request.authToken : propString (body, "token");
    const juce::ScopedLock sl (lock);
    return protocol.authorize (token, juce::Time::currentTimeMillis());
}

juce::var RemoteCompanionServer::eventsSince (int sinceSeq) const
{
    const juce::ScopedLock sl (lock);
    juce::Array<juce::var> events;
    for (const auto& e : eventQueue)
        if ((int) e.getProperty ("seq", 0) > sinceSeq)
            events.add (e);

    auto* data = new juce::DynamicObject();
    data->setProperty ("events", events);
    data->setProperty ("latestSeq", eventSeq);
    return juce::var (data);
}

void RemoteCompanionServer::startBonjour()
{
#if JUCE_MAC
    stopBonjour();
    using DNSServiceRef = void*;
    using DNSServiceFlags = uint32_t;
    using DNSServiceErrorType = int32_t;
    using DNSServiceRegisterReply = void (*)(DNSServiceRef, DNSServiceFlags, DNSServiceErrorType,
                                             const char*, const char*, const char*, void*);
    using RegisterFn = DNSServiceErrorType (*) (DNSServiceRef*, DNSServiceFlags, uint32_t,
                                                const char*, const char*, const char*, const char*,
                                                uint16_t, uint16_t, const void*,
                                                DNSServiceRegisterReply, void*);

    auto* registerFn = reinterpret_cast<RegisterFn> (dlsym (RTLD_DEFAULT, "DNSServiceRegister"));
    if (registerFn == nullptr)
        return;

    DNSServiceRef ref = nullptr;
    const auto errCode = registerFn (&ref, 0, 0, "Mosh Companion", "_moshcompanion._tcp",
                                     nullptr, nullptr, htons ((uint16_t) port),
                                     0, nullptr, nullptr, nullptr);
    if (errCode == 0)
        bonjourRef = ref;
#endif
}

void RemoteCompanionServer::stopBonjour()
{
#if JUCE_MAC
    if (bonjourRef != nullptr)
    {
        using DeallocateFn = void (*) (void*);
        auto* deallocateFn = reinterpret_cast<DeallocateFn> (dlsym (RTLD_DEFAULT, "DNSServiceRefDeallocate"));
        if (deallocateFn != nullptr)
            deallocateFn (bonjourRef);
        bonjourRef = nullptr;
    }
#endif
}

} // namespace mosh
