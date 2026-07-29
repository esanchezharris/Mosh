# Crash reporting & telemetry — privacy contract

*Module: `src/telemetry/`. Settings: **Settings → Privacy → "Share crash reports & usage"**
(`ui/src/settings/schema.ts`, id `telemetryOptIn`). Default: **OFF**.*

This document is the exact contract the code in `src/telemetry/` implements. If a
behavior isn't described here, treat it as unintended — file a bug against
`src/telemetry/`, don't assume it's "probably fine."

## The one-sentence version

**With the toggle off (the default), Mosh writes crash reports to your own disk
and nothing else — no network request of any kind, ever, from this module.**
Turning the toggle on additionally starts anonymous local counters and, only if
the app has also been separately configured with an upload endpoint (which it
is **not**, out of the box), sends batched summaries there.

## What gets collected, and when

There are two independent pieces. Both are implemented in `src/telemetry/` and
both are gated the same way (see "The opt-in gate," below).

### 1. Crash reports — always written locally, uploaded only if you opt in

When Mosh crashes (a signal — SIGSEGV/SIGABRT/SIGBUS/SIGILL/SIGFPE — or an
uncaught C++ exception), the crash handler (`CrashHandler.cpp`, installed at the
very first line of `MoshApplication::initialise()`) writes **one small text
file** to `~/Library/Mosh/diagnostics/crash-<pid>-<unixtime>.txt` containing:

| Field | Example | Notes |
|---|---|---|
| Signal | `SIGSEGV (11)` | which signal (or `uncaught_exception`) |
| Timestamp | `2026-07-17T21:34:56Z` | UTC, second precision |
| App version | `0.0.1` | `MOSH_VERSION_STRING` |
| macOS version | `macOS 15.1` | `juce::SystemStats::getOperatingSystemName()` |
| Backtrace | `0 Mosh 0x104f2a3d0 mosh::foo() + 32` | raw `backtrace()`/`backtrace_symbols()` output: binary names, memory offsets, and symbol names where resolvable. No memory *contents* — just where the crash happened in the code. |
| Recent commands | `move_clip`, `render_layer`, … | the last **16** MoshOps command **names**, oldest-first — see "Redaction," below |

This file is written **unconditionally** — whether or not you've opted in. It
never causes a network request by itself. "Always written" means "always
written to `~/Library/Mosh/diagnostics/` on your machine," never "always sent
anywhere." Opting out doesn't delete existing report files (see "Retention").

If (and only if) you've opted in, Mosh will *also*, on a **later, non-crashing**
launch, attempt to upload not-yet-uploaded reports the same way it uploads the
usage counters below (same gate, same pluggable endpoint). Nothing is ever
uploaded from inside the crash handler itself — no network I/O runs in a signal
handler.

### 2. Usage counters — nothing happens unless you opt in

When opted in, `Telemetry.cpp` tracks, in `~/Library/Mosh/telemetry/state.json`:

| Field | Example | Notes |
|---|---|---|
| `installId` | a random UUID | see "The install id," below — not tied to your Apple ID, email, or hardware serial |
| `launches` | `12` | how many times the app has started with telemetry on |
| `totalSessionSeconds` | `4230` | cumulative time the app has been open |
| `commandCounts` | `{"move_clip": 40, "render_layer": 3, …}` | how many times each MoshOps command **name** has run |

With the toggle off (the default), **none of this exists** — the counters are
never computed, `~/Library/Mosh/telemetry/` is never created, and
`~/Library/Mosh/telemetry.optin` (the flag file itself) is absent. See "The
opt-in gate," below, for how this is enforced in the actual code, not just
promised in this document.

## What is NEVER collected, by construction

- **Audio.** No waveform, sample, or rendered/exported audio ever leaves the
  crash/telemetry path. Neither module touches an audio buffer.
- **Lyrics or any typed text content.** Command *names* only (`set_lyric_line`),
  never a command's *arguments* (the actual lyric text you typed).
- **File paths, project names, or track/clip names.** Same reasoning — those are
  command arguments, never names.
- **Anything content-shaped at all.** The crash-report formatter
  (`CrashReportFormatter.h`) doesn't even have a field for "extra data" on a
  breadcrumb — there is structurally nowhere to put it.
- **Precise location, contacts, account identity, or any Apple/system
  identifier.** The per-install id (below) is a random value Mosh mints itself.

The one caveat worth stating plainly: **if** you opt in **and** an upload
endpoint has been configured (neither is true by default — see "Endpoints"),
the HTTP request that carries the JSON payload necessarily also carries your
IP address, the same way any web request does. Mosh doesn't log or forward it
anywhere itself; it's just an inherent property of making an HTTP request.

## Redaction: how "command names only" is actually enforced

Every MoshOps command that runs passes through exactly one native chokepoint —
`WebBridge.cpp`'s `execute_command` handler, the same function the whole
frontend/backend "swappable seam" is built on. That's where a raw command
object like

```json
{ "command": "set_lyric_line", "args": { "text": "my unreleased lyrics", "trackId": "abc123" } }
```

gets reduced, **before** anything else touches it, to the single token
`set_lyric_line` via `sanitizeCommandName()` — the leading run of
`[A-Za-z0-9_]` characters, truncated to 63 chars, with anything else (a space, a
`{`, a `"`, a `/`, …) never surviving past the first non-identifier character.
That sanitized token is the *only* thing handed to:

- `Breadcrumbs::record()` — the in-memory ring the crash handler reads, and
- `Telemetry::onCommand()` — the in-memory usage histogram.

Both of those **also** re-run `sanitizeCommandName()` on their input themselves
(belt-and-suspenders — a second, independent redaction pass), and the crash
report *formatter* re-runs it a third time on whatever ends up in a breadcrumb
slot before rendering the final report text. So a bug would have to defeat
redaction at three independent call sites to leak anything beyond a command
name. This is pinned by `tests/test_telemetry.cpp`'s
`"crash report formatter redacts breadcrumbs to command names only"` case (a
deliberately adversarial fake breadcrumb carrying a full args blob — a track
id, a snippet of lyric text, and a file path — none of which survive) and by
the live fork+SIGSEGV test, which proves the *actual signal handler*, not just
a test-only code path, redacts too.

Headless harnesses (`--selftest`, `--run-script`) call `MoshOps::execute()`
directly and never pass through `WebBridge.cpp` — by design, those are test
harnesses, not real user sessions, so they never populate breadcrumbs or
counters.

### The local command log now contains your own words (FS-B2a)

`~/Library/Mosh/session/mosh-log.jsonl` records every command with its full
`args`. Since FS-B2a, an **agent turn** opens with a `batch_begin` whose args
carry the utterance that triggered it — what you typed or said — so that a
turn's edits can be traced back to the ask. That is a genuine escalation in what
the file holds, and it is bounded on purpose:

- **The file never leaves the machine.** Nothing in `src/telemetry/` reads it.
  Breadcrumbs are populated from the live command *name* at the `WebBridge`
  chokepoint, not by parsing this log, so the three redaction passes above sit
  upstream of it and the utterance can't reach a crash report. Pinned by
  `tests/test_telemetry.cpp`'s `"crash report never leaks a turn utterance"`.
- **`get_command_log`** — the in-app command-log window — projects only
  `{ts, seq, command, ok, undoable, error}` and **drops `args` entirely**, so
  the utterance never reaches that surface either. Pinned in `--selftest`
  (`get_command_log projects NO args`).
- **Only asks addressed to Moshi are recorded** — typed, hold-to-talk, or a
  hands-free phrase that matched a command. Hands-free speech that *didn't*
  match is dropped without being written anywhere; an always-on mic never
  transcribes ambient conversation into this file.
- **Direct manipulation carries no ask.** A clip drag or a fader move writes a
  line with no `utterance` and no `turn_id` — the key is **absent**, not empty —
  so the log stays honest about which edits were agent-driven.

## The opt-in gate

The entire opt-in state is **one flag file**: `~/Library/Mosh/telemetry.optin`.
Its *presence* is the only thing that matters — there's no JSON to parse, no
"enabled: false but the file still exists" ambiguity. Absent (the default,
and the state on a fresh install) = opted out.

- **Turning it on/off** happens in **Settings → Privacy → "Share crash reports
  & usage"** (`ui/src/settings/schema.ts`). Like every other UI-local setting
  (`uiShell`, `theme`, …), the toggle's own on/off state persists in the
  browser's `localStorage` via the existing settings store
  (`ui/src/settings/store.ts`) — that part is pure UI state, same as always.
  Its *one* side effect is a native call, `setTelemetryOptIn()`
  (`ui/src/bridge.ts` → the native `set_telemetry_optin` function in
  `WebBridge.cpp`), which just creates or deletes the flag file. This is
  **deliberately not a MoshOps command** — it doesn't validate, doesn't open an
  undo transaction, doesn't appear in the command log, and doesn't touch
  `MoshOps.cpp` at all. It's infrastructure, not an edit to your project.
- **Every** file-writing or network-attempting code path in `TelemetryConfig`,
  `Telemetry`, and `CrashHandler` checks this flag file **first** and returns
  immediately if it's absent — before resolving an install id, before touching
  `~/Library/Mosh/telemetry/`, before anything. This is what
  `tests/test_telemetry.cpp`'s `"Telemetry touches no file and no network when
  opted out (the default)"` case pins: it calls the full launch → command →
  flush sequence with an **injected** uploader spy and asserts the spy is never
  invoked and no `state.json` is ever written.
- **Turning it off mid-session** (flipping the Settings toggle while the app is
  running) takes effect within one flush interval (production: ~60s) — the
  background loop re-checks the flag file on every pass and stops cleanly
  (clears its in-memory counters, makes no further writes or requests) the
  moment it sees the file is gone. You don't have to quit the app for opting
  out to actually stop something.
- Crash-report *writing* is the one exception to "the gate controls
  everything" — see "1. Crash reports," above, for why (it's local-only by
  construction, so there's nothing to gate).

### The install id

When opted in, counters are bucketed under a random id (`TelemetryConfig::installId()`):
it reuses `~/Library/Mosh/session/identity.json`'s id if the engine has already
minted one there (read-only — this module never writes into `session/`, which
belongs to the engine), otherwise it mints a fresh `juce::Uuid` and persists it
to `~/Library/Mosh/telemetry/identity.json`. It identifies *an installation*,
not a person — it's not derived from your Apple ID, hardware serial, MAC
address, or any other stable device/account identifier, and nothing this
module does ties it back to one.

## Endpoints

Both the crash-report upload path and the counter-upload path in `Telemetry.cpp`
are **pluggable, not hardcoded**: they read the destination URL from the
`MOSH_TELEMETRY_URL` environment variable at flush time. **This repository does
not set that variable anywhere**, so out of the box — even with the Settings
toggle on — there is nowhere to upload *to*, and `Telemetry::flush()` writes
its local `state.json` and returns without attempting a network call (checked
explicitly: `urlToUpload.isEmpty()` short-circuits before the uploader is ever
invoked). Wiring up a real collection endpoint is a deliberately separate,
future decision — it is not part of what this module ships. Every test in
`tests/test_telemetry.cpp` that exercises the "opted in AND a URL is
configured" path injects a fake in-process uploader function; none of them,
and nothing in this module's default configuration, makes a real HTTP request.

## Retention

- **Local files** (`~/Library/Mosh/diagnostics/crash-*.txt`,
  `~/Library/Mosh/telemetry/state.json`, `~/Library/Mosh/telemetry/identity.json`)
  persist on your disk until *you* delete them. This version of the module does
  not implement automatic pruning or expiry — that's a known limitation, not an
  oversight to be surprised by. Delete the `diagnostics/` or `telemetry/`
  folders (or the whole `~/Library/Mosh/telemetry.optin` flag) any time; nothing
  reconstructs them except your next crash or your next opted-in launch,
  respectively.
- **Server-side retention** isn't this module's concern, because — see
  "Endpoints" — there is no server this module ships with or points at by
  default. Whatever collects `MOSH_TELEMETRY_URL` traffic in the future owns
  its own retention policy; that's out of scope for this document until such a
  service exists.

## Inspecting or deleting your own data

Everything this module writes is plain text/JSON on your own disk, at:

```
~/Library/Mosh/telemetry.optin              # presence = opted in (delete to opt out instantly)
~/Library/Mosh/diagnostics/crash-*.txt       # local crash reports (always written, opt-in or not)
~/Library/Mosh/telemetry/state.json          # usage counters (opted-in only)
~/Library/Mosh/telemetry/identity.json       # the per-install id (opted-in only; not written if
                                              # ~/Library/Mosh/session/identity.json already had one)
```

`cat` any of them; `rm` any of them (or the whole `~/Library/Mosh/diagnostics/`
and `~/Library/Mosh/telemetry/` folders) whenever you like.

## For engineers: where the code lives

| File | Responsibility |
|---|---|
| `src/telemetry/TelemetryConfig.{h,cpp}` | paths, the opt-in flag file, the install id |
| `src/telemetry/Breadcrumbs.{h,cpp}` | the fixed-size, allocation-free ring of recent command names |
| `src/telemetry/CrashReportFormatter.{h,cpp}` | `sanitizeCommandName()` + pure report-text rendering (no I/O) |
| `src/telemetry/CrashHandler.{h,cpp}` | `installCrashHandler()`, the POSIX signal handlers, `std::set_terminate` |
| `src/telemetry/Telemetry.{h,cpp}` | the opt-in-gated counters, batching, the pluggable uploader |
| `ui/src/settings/schema.ts` (`telemetryOptIn`) | the Settings → Privacy toggle descriptor |
| `ui/src/settings/effects.ts` | syncs the toggle's value to native on every change + on boot |
| `ui/src/bridge.ts` (`setTelemetryOptIn`) | the native call the toggle's effect uses |
| `src/webview/WebBridge.cpp` (`execute_command`, `set_telemetry_optin`) | the redaction chokepoint + the native handler for the toggle |
| `tests/test_telemetry.cpp` | the Catch2 coverage for all of the above, including a real fork+SIGSEGV crash |

`installCrashHandler()` is called exactly once, as the first statement of
`MoshApplication::initialise()` in `src/Main.cpp` — see the comment there.

### Signal-safety note

`CrashHandler.cpp`'s signal path uses `backtrace()` / `backtrace_symbols()` and
`snprintf()` for formatting. POSIX does not officially guarantee either is safe
to call from inside a signal handler (`backtrace_symbols()` calls `malloc`
internally); both are nonetheless extremely widely used in shipped
crash-handler code in practice, and that pragmatic tradeoff — a MINIMAL,
"good enough to get a useful local report out" handler rather than a
textbook-strict async-signal-safe one — is a deliberate scope decision for this
module, not an oversight. The one piece of shared mutable state the handler
touches (`Breadcrumbs`' ring) is protected with a `try_lock`, specifically so a
crash can never deadlock waiting on it — degrading to an empty breadcrumb
section is an acceptable outcome; hanging forever inside a signal handler is
not.
