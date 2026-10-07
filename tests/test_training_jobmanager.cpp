#include <catch2/catch_test_macros.hpp>
#include "training/TrainingJobManager.h"
#include <cstdlib>

// TrainingJobManager::cancelJob() used to be `void`: it POSTed /training/cancel and
// threw the answer away, so the command above it reported "cancelled" whether the
// service had stopped a run, had never heard of the id, or was not running at all.
// It now hands back what the service said, and these pin the three answers the
// command has to tell apart — against a fake service, on a private port, so the
// suite stays hermetic.
namespace
{
    struct ScopedEnv
    {
        const char* key;
        juce::String prev;
        bool had = false;
        ScopedEnv (const char* k, const juce::String& v) : key (k)
        {
            if (auto* p = std::getenv (k)) { prev = p; had = true; }
           #if JUCE_WINDOWS
            _putenv_s (k, v.toRawUTF8());
           #else
            ::setenv (k, v.toRawUTF8(), 1);
           #endif
        }
        ~ScopedEnv()
        {
           #if JUCE_WINDOWS
            _putenv_s (key, had ? prev.toRawUTF8() : "");
           #else
            if (had) ::setenv (key, prev.toRawUTF8(), 1); else ::unsetenv (key);
           #endif
        }
    };

    // The service's two training routes this class talks to, with a fixed job table.
    // FAKE_LEGACY_CANCEL=1 answers /training/cancel the way the service did before it
    // reported anything: {"ok": true} for every id, known or not.
    const char* const fakeServiceScript =
        "import http.server, json, os\n"
        "port = int(os.environ['MOSH_SERVICE_PORT'])\n"
        "legacy = os.environ.get('FAKE_LEGACY_CANCEL') == '1'\n"
        "JOBS = {'job-running': {'status': 'running', 'progress': 0.25},\n"
        "        'job-ready': {'status': 'ready', 'progress': 1.0}}\n"
        "class H(http.server.BaseHTTPRequestHandler):\n"
        "    def _send(self, code, payload):\n"
        "        body = json.dumps(payload).encode()\n"
        "        self.send_response(code)\n"
        "        self.send_header('Content-Type', 'application/json')\n"
        "        self.send_header('Content-Length', str(len(body)))\n"
        "        self.end_headers()\n"
        "        self.wfile.write(body)\n"
        "    def do_GET(self):\n"
        "        jid = self.path.split('jobId=')[-1] if 'jobId=' in self.path else ''\n"
        "        job = JOBS.get(jid)\n"
        "        if not self.path.startswith('/training/status') or job is None:\n"
        "            return self._send(404, {'ok': False, 'error': 'unknown jobId'})\n"
        "        self._send(200, {'ok': True, 'jobId': jid, 'status': job['status'], 'progress': job['progress']})\n"
        "    def do_POST(self):\n"
        "        data = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')\n"
        "        jid = data.get('jobId', '')\n"
        "        if legacy:\n"
        "            return self._send(200, {'ok': True})\n"
        "        job = JOBS.get(jid)\n"
        "        if job is None:\n"
        "            return self._send(404, {'ok': False, 'error': 'unknown jobId'})\n"
        "        live = job['status'] in ('queued', 'running')\n"
        "        self._send(200, {'ok': True, 'jobId': jid, 'status': job['status'],\n"
        "                         'progress': job['progress'], 'cancelRequested': live})\n"
        "    def log_message(self, *a): pass\n"
        "http.server.HTTPServer(('127.0.0.1', port), H).serve_forever()\n";

    struct FakeTrainingService
    {
        juce::File dir;
        juce::ChildProcess proc;
        bool ready = false;

        FakeTrainingService (int port, bool legacyCancel)
        {
            dir = juce::File::createTempFile ("mosh-training-cancel");
            dir.deleteFile();
            dir.createDirectory();
            auto script = dir.getChildFile ("server.py");
            script.replaceWithText (fakeServiceScript);

            const juce::String shell = "MOSH_SERVICE_PORT=" + juce::String (port)
                                     + " FAKE_LEGACY_CANCEL=" + (legacyCancel ? "1" : "0")
                                     + " exec python3 " + script.getFullPathName().quoted();
            if (! proc.start (juce::StringArray { "/bin/sh", "-c", shell }))
                return;
            // Wait for the socket rather than assuming a fixed interpreter startup time.
            for (int attempt = 0; attempt < 100 && proc.isRunning(); ++attempt)
            {
                juce::StreamingSocket probe;
                if (probe.connect ("127.0.0.1", port, 100))
                {
                    ready = true;
                    probe.close();
                    break;
                }
                juce::Thread::sleep (50);
            }
        }

        ~FakeTrainingService()
        {
            if (proc.isRunning()) proc.kill();
            dir.deleteRecursively();
        }
    };

    bool answeredOk (const juce::var& answer) { return (bool) answer.getProperty ("ok", false); }
}

TEST_CASE ("cancelJob returns the service's answer instead of discarding it", "[training][cancel]")
{
    SECTION ("no service listening — there is no answer, so nothing may be claimed")
    {
        ScopedEnv host ("MOSH_SERVICE_HOST", "127.0.0.1");
        ScopedEnv port ("MOSH_SERVICE_PORT", "59981");   // nothing listens here

        mosh::TrainingJobManager mgr;
        const auto answer = mgr.cancelJob ("job-running");
        CHECK_FALSE (answer.isObject());
    }

    SECTION ("the service says which ids it knows and what state the job was in")
    {
        FakeTrainingService service (59982, false);
        REQUIRE (service.ready);
        ScopedEnv host ("MOSH_SERVICE_HOST", "127.0.0.1");
        ScopedEnv port ("MOSH_SERVICE_PORT", "59982");
        mosh::TrainingJobManager mgr;

        // The refusal arrives as a 404 with a JSON body; it has to survive the trip.
        const auto unknown = mgr.cancelJob ("no-such-job");
        REQUIRE (unknown.isObject());
        CHECK_FALSE (answeredOk (unknown));
        CHECK (unknown.getProperty ("error", juce::var()).toString() == "unknown jobId");

        const auto running = mgr.cancelJob ("job-running");
        REQUIRE (running.isObject());
        CHECK (answeredOk (running));
        CHECK (running.getProperty ("status", juce::var()).toString() == "running");
        CHECK ((double) running.getProperty ("progress", -1.0) == 0.25);
        CHECK ((bool) running.getProperty ("cancelRequested", false));

        const auto finished = mgr.cancelJob ("job-ready");
        REQUIRE (finished.isObject());
        CHECK (answeredOk (finished));
        CHECK (finished.getProperty ("status", juce::var()).toString() == "ready");
        CHECK (finished.hasProperty ("cancelRequested"));
        CHECK_FALSE ((bool) finished.getProperty ("cancelRequested", true));
    }

    // The app adopts whatever healthy service already owns the port, which can be one
    // started from an older build. That one answers {"ok": true} to every cancel, so
    // known-vs-unknown has to come from its status route (which has always refused an
    // unknown id) rather than being read as "stopped".
    SECTION ("a service that predates the cancel answer is asked for the job's status")
    {
        FakeTrainingService service (59983, true);
        REQUIRE (service.ready);
        ScopedEnv host ("MOSH_SERVICE_HOST", "127.0.0.1");
        ScopedEnv port ("MOSH_SERVICE_PORT", "59983");
        mosh::TrainingJobManager mgr;

        const auto unknown = mgr.cancelJob ("no-such-job");
        REQUIRE (unknown.isObject());
        CHECK_FALSE (answeredOk (unknown));
        CHECK (unknown.getProperty ("error", juce::var()).toString() == "unknown jobId");

        const auto running = mgr.cancelJob ("job-running");
        REQUIRE (running.isObject());
        CHECK (answeredOk (running));
        CHECK (running.getProperty ("status", juce::var()).toString() == "running");
    }
}
