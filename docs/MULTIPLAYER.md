# Multiplayer — the collaboration model

*How two people make a song together in Mosh. Read this before a live session.*

Mosh multiplayer is **shared project state + independent local playback**. You and your
peer edit one logical project; each of you hears it through your **own** transport and
speakers. There is **no synchronized streaming audio** between apps — for talking and
real-time monitoring you use a **separate voice channel (Discord, etc.)**. This is by
design, and it's why latency between two machines doesn't smear the groove: nothing about
*your* playback waits on the network.

## The one-paragraph mental model

> You each run Mosh locally. When one of you changes the project — adds a track, writes
> MIDI, loads a plugin, sets the tempo — that change is published to the other through a
> relay. Each person presses play on their **own** machine and hears the **current shared
> arrangement** locally. You talk over Discord. The only thing that travels as real audio
> is *clip files* (recorded/imported/AI-generated audio), and only when needed (see
> [Audio clips](#audio-clips-the-one-real-file-transfer)).

## What syncs vs. what's local

The split is enforced in one place — `LockManager::classify()`
([src/multiplayer/LockManager.cpp:13](src/multiplayer/LockManager.cpp:13)).

**LOCAL — never sent to your peer (Unguarded):**
- **Transport / playhead** (`set_transport`) — independent playheads. You scrub and play
  on your own. ([LockManager.cpp:24](src/multiplayer/LockManager.cpp:24))
- **Playback, level meters** — local audio, never networked.
- **Undo / redo** — each person has their own undo stack.
- **File I/O & project lifecycle** — `save`, `reload`, `save_as`, `new_project`,
  `open_project`, `export_audio`.
- **Machine prefs** — audio device, buffer size, plugin catalog/scan, `open_plugin_editor`.

**SYNCED — published to your peer:**
- **Track edits** (rename, volume/pan/mute/solo, load/remove/reorder plugins, plugin
  params, add MIDI clip, drum kit, sends, automation…) — track-scoped commands. They reach
  the peer when the track is **committed** (see [commit-on-move](#track-locks--commit-on-move)).
- **Clip edits** (move, trim, split, add/remove/edit notes, quantize, create render
  layer…) — clip-scoped, committed with their track.
- **Session-global ops** — `create_track` / bus / group, **tempo**, **key**, master
  volume/pan, metronome, tempo-map. Scalars (tempo/key/master) use **last-writer-wins**
  ([MultiplayerSession.cpp:182](src/multiplayer/MultiplayerSession.cpp:182)).
- **Locks + presence** — who's editing which track, name, colour, online status.

## Track locks & commit-on-move

Only **one person edits a given track at a time**. Mosh claims a lock the moment you start
working on a track and, when you move to a different track, it **commits** the old one
(serializes it + publishes) and releases the lock so your peer can take it. There's also an
idle checkpoint (~5 s) so edits get published even if you don't switch tracks. Locks carry a
monotonic **epoch** (fencing token); a stale commit is rejected (409). A crashed peer's lock
auto-frees after a ~90 s lease. Presence uses the same grace: an active peer's poll keeps its
membership alive, while a peer that stays silent for 90 s is removed from the roster, releases
its locks, and stops occupying one of the two room slots. Rejoining with the same peer id inside
the grace window is idempotent; after expiry the peer must join the room again.

**Practical consequence:** your peer sees your work on a track **when you finish with it /
move off it**, not keystroke-by-keystroke. Park on a track and your changes checkpoint after
a few seconds; switch tracks and they flush immediately.

## Audio clips — the one real file transfer

MIDI notes, instrument/plugin choices, mixer settings, automation — all of that is **data**.
It serializes into the project and syncs with **zero audio transfer**. So a **MIDI-only jam
needs no audio-over-internet at all.**

**Real audio clips are different.** A recorded take, an imported `.wav`, or a **Stable
Audio 3 render** is an actual audio *file*. To appear on your peer's machine it is:
1. hashed (SHA-256), content-addressed,
2. uploaded to the relay's blob store, and
3. downloaded by the peer on demand
([MultiplayerClient.cpp:231](src/multiplayer/MultiplayerClient.cpp:231) — `/mp/blob/head`,
`/mp/blob/put-url`, `/mp/blob/get-url` signed URLs).

**The blob store is content-addressed and self-healing.** Every `uploadBlob`/`downloadBlob`
call is best-effort (a transient network hiccup no longer strands a clip forever): the
**`mp_fetch_missing_stems`** command re-derives the missing hash/ext straight from a wave
clip's own by-hash source path and retries the fetch — it runs **automatically** right after
a guest adopts a bootstrap (`mp_apply_bootstrap`), and is available as a manual retry
otherwise. **The local self-host relay (`relay/server.py`) now mirrors the cloud's blob
contract too** (head/put-url/get-url + raw PUT/GET), so the whole stem round-trip — including
the self-heal path — is exercisable **hermetically** by `Mosh --selftest`
(`MOSH_SELFTEST_MP=1`) without any network. That local blob store is an **in-memory, dev/test
posture only** (no persistence, no real signed-URL security, loopback-bound): the cloud relay
remains the one that matters for an actual two-machine session — a `127.0.0.1` relay can't
reach a peer's machine anyway.

## Connecting (the UX)

The session control lives in the topbar's **2-player (B-5) pop**
([ui/src/ui/MultiplayerPanel.tsx](ui/src/ui/MultiplayerPanel.tsx)).

- **Host:** open the pop → set your name + colour → **Create session** → a **room code**
  appears (read-only, click to select). Share it (paste into Discord).
- **Guest:** open the pop → set name + colour → paste the code → **Join**.
- Once connected, both see a **roster** (peer name, colour swatch, online dot) and a **Leave**
  control. Session state rides the `mp_state` event, off-snapshot.

## Relay configuration

- **Default (zero setup):** the cloud relay
  `https://tpvkqaqydafpgockzchm.supabase.co/functions/v1/relay`
  ([MultiplayerClient.cpp:12](src/multiplayer/MultiplayerClient.cpp:12)). A double-clicked
  app reaches multiplayer with no config — this is what you want for the playtest.
- **Self-host (dev/offline):** `MOSH_RELAY_URL=http://127.0.0.1:8771` + run
  `PORT=8771 python3 relay/server.py`. It now HAS blob endpoints (an in-memory dev/test store,
  mirroring the cloud contract — see [Audio clips](#audio-clips-the-one-real-file-transfer)
  above), so audio syncs on it too — but it only binds `127.0.0.1`, so it's for same-machine
  dev/CI use, not an actual two-machine session (use the cloud relay for that).
- `MOSH_RELAY_APIKEY` overrides the cloud relay's anon key (rarely needed).
- `MOSH_MP_SYNC_TRANSFER=1` (native, not a relay env) pins every stem transfer back to the
  original fully synchronous/inline behaviour (PR-2's kill switch) — a cheap way to rule the
  async transfer path in/out if something looks off live.
- `MOSH_RELAY_BLOB_DELAY_MS` (dev relay only) artificially delays every raw stem PUT/GET —
  a test hook (used by the hermetic "no-freeze proxy" selftest check) to make a transfer slow
  enough to observe the message thread staying responsive during it.

## Known limits (updated 2026-07-17 — self-healing stems)

- **Bootstrap audio is now self-healing.** A guest who joins an in-progress session receives
  pre-existing **audio clips** automatically — on serialize the host content-addresses +
  uploads each stem, and the joiner downloads them as it adopts the bundle (the same by-hash
  path as a commit). Previously, every upload/download call ignored its success/failure —
  **one transient HTTP hiccup left a clip `sourceMissing` forever**, and the only recovery was
  the host manually re-committing that track (a "nudge"). That gap is closed:
  - `mp_fetch_missing_stems` (backend-only, non-undoable) scans every wave clip whose source
    is missing, recognizes the ones referencing a content-addressed by-hash stem (a 64-hex-char
    filename under `audio/by-hash/`), and retries the download for exactly those — it can't
    "fix" an unrelated missing local file (that's `relink_clip`'s job).
  - It fires **automatically** right after `mp_apply_bootstrap` lands the guest's tracks (fire-
    and-forget, off the `wait` arg — it runs synchronously only when nothing is actually
    missing, which is a cheap no-op; a genuine miss takes the background-thread path below), so
    a late-joiner's audio catches up on its own within moments — no manual nudge needed.
  - It is also a manual command: `{wait:true}` for a synchronous retry (e.g. from a script or
    the future UI); otherwise (the default, and what the bootstrap auto-trigger uses) it runs
    the download on a background thread and reports completion by re-invalidating the
    snapshot — never blocking the caller on the network round-trip.
  - Every downloaded stem's bytes are verified against its own content-address (SHA-256) before
    being accepted — a dropped/truncated transfer is rejected and left genuinely missing (for a
    future retry) rather than silently blessed as resolved.
  - The **local self-host relay now has a blob store** too (mirroring the cloud contract), so
    this whole path — including the self-heal — is covered by the hermetic `--selftest` gate
    (`MOSH_SELFTEST_MP=1`), not just the cloud-gated smoke check.
- **Stem transfer is now off the message thread too (PR-2).** Every upload/download used to
  run wherever it was called from — the message thread for an outbound commit's upload; INSIDE
  the poll loop's callAsync for a received commit's download or the host's bootstrap-answer
  upload — so a large file froze the UI for as long as the transfer took. A dedicated
  **TransferQueue** worker thread now does all of it:
  - `mp_commit_track` does its synchronous engine work (hash/copy/repoint/serialize — an
    immutable content-addressed snapshot, so further edits during the upload are safe by
    construction) and returns **immediately** with `status:"uploading"`; the upload + publish +
    lock release run on the worker, reported via an additive `mp_commit_done {logicalId, ok,
    error?}` event.
  - A received `commit` / `bootstrap_state` / `structural` frame is turned into a worker job
    (download any missing stems, then apply) routed through the SAME single-worker FIFO — even
    `structural` (which has nothing to download) — so a fast tempo change enqueued right after a
    slow commit upload can never apply before it: **global apply order is preserved** end-to-end.
  - The host's bootstrap answer is split: the engine-touching content-address/serialize step
    stays on the message thread; the worker uploads every stem and THEN publishes
    `bootstrap_state`.
  - Why a **dedicated** worker (not the existing poll thread): a multi-minute transfer on the
    poll thread would stop it from calling `/mp/events` and so from refreshing this peer's own
    held lock leases — the relay auto-frees a lock after **90s of silence**
    (`supabase/migrations/0001_mp_relay.sql`, `relay/room.py`'s `LOCK_LEASE_S`) — which could let
    a peer steal a lock this user is still actively using, mid-slow-transfer. The dedicated
    worker keeps the poll loop (and the lease) alive throughout.
  - `leaveSession()` aborts any in-flight/queued transfer and its `downloadBlob`/`uploadBlob`
    calls are abort-aware (chunked, checked between steps) — a stale transfer for a session
    you've already left doesn't keep running.
  - **Kill switch:** `MOSH_MP_SYNC_TRANSFER=1` reverts every path above to the original fully
    synchronous/inline behaviour — cheap insurance if the async path ever misbehaves live.
  - **Consolidated fix batch (2026-07-17, adversarial review of PR-2):** two BLOCKERs + three
    should-fixes closed. **BLOCKER — a rejected upload was reported as a false success:**
    `uploadBlob`'s raw PUT never checked the HTTP status (`createInputStream()` returns
    non-null for 4xx/5xx on macOS — the same caveat `poll()` already documents), so a
    quota/auth/transient-5xx rejection looked identical to a real success; `httpPost` now
    threads an optional status-code out-param and every blob call site (`head`/`put-url`/the
    raw PUT/`get-url`/the raw GET) checks it explicitly. Proven by a dedicated `mp_commit_done{ok:false}`
    selftest section driving `MultiplayerSession` directly against `relay/server.py`'s new
    ext-scoped `MOSH_RELAY_BLOB_FAIL` hook (armed for the whole gate run, safe like
    `MOSH_RELAY_BLOB_CORRUPT`). **BLOCKER — mp_commit_done had no frontend consumer:** the
    event was silently dropped by `store.ts`'s dispatch chain; a failed upload left a track
    `sourceMissing` for the peer with no visible signal. Fixed: a new `mp_commit_done` reducer
    surfaces `ok:false` via the shared `lastError` toast + `console.warn`, and `MultiplayerPanel`
    shows a per-track "failed to sync — Retry" row (`pendingCommits`/`failedCommits`, keyed by
    `logicalId`) alongside a "Syncing N…" line while an upload is in flight.
    **Should-fix — the worker's own prefetch bypassed the in-flight-stem guard:**
    `prefetchAudioRefs` (worker thread) called `downloadBlob` directly without consulting the
    self-heal pass's in-flight registry, so the two could race a `downloadBlob` into the same
    dest file concurrently; the registry moved from a `MoshOps`-local, message-thread-only
    `std::set` to a thread-safe `claimStem`/`releaseStem` pair on `MultiplayerSession` itself,
    shared by both callers. **Should-fix — job.apply closures lacked the `running_` teardown
    guard:** `pollLoop`'s own callAsync already drops a stale tick after `leaveSession()`
    (`if (! running_.load()) return;`); the TransferQueue job.apply closures
    (`emitCommitDone`/`applyCommit_`/`applyBootstrap_`/`applyStructural_`) now carry the same
    guard, so a job already handed to `callAsync` before a `leaveSession()` can't fire stale
    engine mutations after teardown. **Should-fix — `stemBaseDir` was re-read per-job instead
    of captured at enqueue:** a slow job ahead of it in the FIFO could let `stemBaseDir()` drift
    (a `save_as`/`new_project`/`open_project` in between) before the worker actually ran the
    prefetch; the base directory is now captured on the message thread at enqueue time and
    threaded through explicitly.
- **Stale lock badge (~250 ms):** after a peer disconnects, their lock chip can linger
  briefly until the relay sweeps it. Self-corrects.
- **Buses/groups don't replicate yet:** tracks sync; aux/group buses do not.
- **Tempo is last-writer-wins, not hard-locked:** if both set tempo at once, the later one
  wins. Agree on tempo verbally (Discord) to avoid tug-of-war.

## Verification status

- `Mosh --selftest` with `MOSH_SELFTEST_MP=1` (`relay/run-mp-selftest.sh`, two/four
  simulated peers across several in-process engines) passes against the **local**
  relay — **1374/1374 ×3 deterministic** (2026-07-17, re-verified after merging
  main's #343/#347/#348/#350/#351/#353 into this branch: self-healing stems PR +
  async transfer PR + the consolidated fix batch above: corruption-rejection +
  upload-rejection coverage). Also verified ×3 under `MOSH_MP_SYNC_TRANSFER=1`
  (**1382/1382** — the kill switch's own section adds checks, hence the higher
  count) and ×3 with `MOSH_RELAY_BLOB_DELAY_MS=600` armed (**1383/1383**). The
  default `--selftest` (no MP env) is unaffected — **1280/1280**. This is the
  FIRST time the whole stem round-trip (upload/download/self-heal/bootstrap) runs
  hermetically, since the local relay previously had no blob store at all.
  **Honest flake note:** in a 7-run sample of the `MOSH_RELAY_BLOB_DELAY_MS=600`
  gate, one run scored 1381/1383 (2 failures, both in the same "audio stems"
  commit-completion wait) while the machine was under heavy concurrent load
  (several other Claude Code sessions building in parallel, load average >9 on
  a 10-core box); 6 immediately-subsequent runs (3 before, 4 after) were clean.
  Treated as an environmental flake, not a logic bug — the SAME 20s bound
  already covers the exact scenario cleanly elsewhere in this file, and the
  **kill-switch dual-run itself was clean 3/3 in both modes**, which is the
  claim that actually matters for the playtest.
- **Corrupted-transfer rejection is now executable, not just "correct by
  inspection":** `relay/server.py`'s `MOSH_RELAY_BLOB_CORRUPT` hook (ext-scoped —
  it only flips bytes for a reserved `.corrupttest` extension, so it's armed for
  the WHOLE gate run by `run-mp-selftest.sh` without corrupting any real `.wav`
  stem) backs a dedicated selftest section proving `MultiplayerClient::downloadBlob`
  rejects a corrupted transfer (returns `false`, deletes the partial/corrupt
  `dest` file, reports a hash-mismatch error) and that the rejection is retryable
  (a clean download right after still succeeds) — see `SelfTest.cpp`'s
  "downloadBlob rejects a corrupted transfer" section.
- `scripts/playtest/mp-live-smoke.sh` (two SEPARATE OS processes, real HTTP) run
  against the **real cloud relay** — **PASS** (re-run twice, 2026-07-17 post-merge):
  process B received A's MIDI + audio tracks, downloaded the stem, and
  `mp_fetch_missing_stems` confirmed nothing was left `sourceMissing` (fetched:0
  failed:0 — the original download had already succeeded, so the self-heal ran
  as the harmless no-op it's designed to be).
- Full local gate (2026-07-17, post-merge-with-main + review-fixes): Catch2
  **622 assertions / 110 test cases**; relay `pytest` **58/58 ×3 deterministic**;
  `verify.py --gate` **17/17**; `tsc --noEmit` clean; `vitest` **1056 passed / 1
  skipped (1057)**; Playwright e2e (isolated config) **140/140**.
- **Not yet proven:** two *separate* app instances, two humans, live, hearing the results.
  **Tonight's playtest is the first real two-machine test.** Do a two-window dry run on one
  Mac first (see `docs/PLAYTEST_SETUP.md`).

## Running a live session (cloud, recommended)

1. Both install Mosh (`docs/PLAYTEST_SETUP.md`).
2. Host: B-5 pop → Create → copy room code → paste into Discord.
3. Guest: B-5 pop → paste code → Join.
4. Agree on a tempo/key over Discord. Build the song — MIDI parts sync instantly; commit a
   track (move off it) to flush; share audio/SA3 clips knowing they ride the cloud relay.
5. Each person plays back locally. Talk over Discord.
