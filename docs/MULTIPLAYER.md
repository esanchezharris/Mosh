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
auto-frees after a ~90 s lease.

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

**These blob endpoints exist only on the cloud relay.** The local self-host relay
(`relay/server.py`) has none — so on the local relay, MIDI/structure sync but audio clips
do **not** transfer. The cloud relay is the **built-in default**, so audio sync works out of
the box; just know that sharing audio (incl. SA3 renders) rides the cloud path.

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
  `PORT=8771 python3 relay/server.py`. Note: **no blob endpoints** → no audio-clip sync.
- `MOSH_RELAY_APIKEY` overrides the cloud relay's anon key (rarely needed).

## Known limits (true as of 2026-06-21)

- **Bootstrap audio not wired:** a guest who joins an in-progress session gets the project
  *structure*, but pre-existing **audio clips** land as `sourceMissing` until the host
  re-commits the track that holds them (re-select it / nudge it). MIDI/instrument parts
  appear immediately. Workaround: host touches each audio-bearing track after the guest joins.
- **Stem transfer briefly blocks the UI:** upload/download runs on the message thread, so a
  large audio file can freeze the window for a few seconds. Keep imported clips modest.
- **Stale lock badge (~250 ms):** after a peer disconnects, their lock chip can linger
  briefly until the relay sweeps it. Self-corrects.
- **Buses/groups don't replicate yet:** tracks sync; aux/group buses do not.
- **Tempo is last-writer-wins, not hard-locked:** if both set tempo at once, the later one
  wins. Agree on tempo verbally (Discord) to avoid tug-of-war.

## Verification status

- `Mosh --selftest` with `MOSH_SELFTEST_MP=1` (two simulated peers, one process) passes
  against both the local relay (`relay/run-mp-selftest.sh`) and the cloud relay — **911/911**.
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
