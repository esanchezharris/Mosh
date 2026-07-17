# Known limits — v0 playtest

*What to expect going in. Everything here came out of a 42-finding bug sweep of the
multiplayer/generative surface ahead of the remote two-Mac playtest — the full ledger with
severity, file:line, and disposition for every finding is
[`SWEEP_2026-07-17.md`](SWEEP_2026-07-17.md). This doc is the distilled, tester-facing
version: what's actually still true about the shipped build, and what to do about it.
`docs/MULTIPLAYER.md` has its own "Known limits" section for the collaboration model in
general (locks, buses, tempo) — read that too; this doc doesn't repeat it, it adds the
sweep-specific items and the "why" behind each one.*

## Mitigated this pass (safe to proceed, but know the shape of it)

- **Joining replaces your current project.** The host's bootstrap adopts wholesale — the
  guest's local tracks are non-undoably swapped out for the host's. **PR #350 added a
  confirm dialog** ("Joining adopts the host's project and replaces yours — continue?")
  whenever the joiner's project already has tracks, so this can no longer happen silently.
  The underlying mechanism (no snapshot/backup of the pre-join project, no
  `clearUndoHistory()` call) is unchanged — see the next section. **Guidance: join on an
  empty or throwaway project** so the confirm dialog is a formality, not a real choice
  between two pieces of work.

## Still open — deferred post-playtest (documented, not code-fixed)

- **Undo after a remote change is local-only and can look wrong.** A peer's applied edit
  (tempo/key/master, or the bootstrap resync itself) lands on *your* local undo stack —
  pressing Cmd+Z right after someone else's change lands can revert *their* change, locally,
  on your machine only (it does not corrupt the shared session — a resync/re-commit
  straightens it back out). **Guidance:** don't reach for Cmd+Z immediately after you see a
  peer's change arrive; if something looks off, keep working — the next commit/resync
  corrects it.
- **If your app crashes, wait ~90 seconds before rejoining.** A crashed peer's row lingers in
  the relay's peer table and counts against the 2-person room cap until a lease sweep clears
  it. Rejoining immediately can read as "room full" or a stale roster entry.
- **Selecting a peer's idle track can silently claim it after ~90 seconds.** Lock leases
  aren't renewed just because you're still looking at (not actively editing) a track — if
  your peer merely clicks the same track after your lease lapses, they can take it out from
  under you. **Guidance:** one person per track for the session; if you park somewhere for a
  while, say so out loud.
- **A network drop can be invisible.** The session panel can keep showing a healthy roster
  while the relay is actually unreachable — edits sent during the outage are silently
  dropped rather than queued/retried. **Guidance:** if edits stop showing up on the other
  Mac, both of you leave and rejoin the room.
- **Custom drum samples don't transfer yet.** The **built-in kit** (`add_drum_pattern` /
  KIT-based tracks) transfers fine as long as both Macs run `Mosh.app` from
  `/Applications` (see the Host Checklist). Your *own* sample files (dragged in from
  `~/Music` or anywhere else) are referenced by an absolute path that only exists on
  whichever Mac loaded them — the peer gets a silent pad, not an error. **Guidance:** for
  the shared drum jam, stick to the built-in kit.
- **Long jams grow the session folder.** Every render and every commit writes a fresh
  durable audio copy on disk; nothing prunes superseded ones yet. Not a crash risk for a
  single evening's session — if disk space gets tight, you can clear
  `~/Library/Mosh/session/{renders,audio}` between sessions (not mid-session).
- **Brain / Moshi agent features use the first configured provider with no automatic
  failover.** If that provider is down or over its quota mid-session, agent/chat features
  error out rather than falling back to a different configured provider. **Not
  playtest-blocking** — the core DAW, multiplayer, and generative-render loop don't depend
  on the brain at all; this only affects the conversational agent surface.
- **A guest editing a host's already re-imagined clip can silently compound a lower-quality
  render.** If the host's clip has an in-place SA3 render applied, and the path back to the
  *original* (pre-render) audio doesn't resolve on the guest's Mac, a guest-triggered
  re-render falls back to re-imagining the *already-rendered* audio through the
  preview/FakeAdapter engine instead of erroring out — the result can look like a normal
  render but is quietly degraded and gets committed back to the host. **Guidance:** if
  you're the guest, avoid re-triggering "re-imagine" on a clip the host already rendered;
  let the host manage renders on clips they created.
- A few lower-severity UI papercuts remain open (a raw peer-ID string in some lock-conflict
  messages, the multiplayer overflow menu not closing on Escape, join failures showing only
  in the global error bar rather than inline in the join panel) — none of these block or
  corrupt anything, they're just rough edges. Full list in the sweep ledger.

## Being replaced right now — async stem transfer (#354, pending merge)

**Already true today (mitigated by #345/TESTER_QUICKSTART, not a code fix):** a brief
freeze right after a peer adds or commits an audio clip is **normal** — a stem is
transferring over the relay on the message thread, and it unsticks itself in a few seconds.
This is called out in `docs/TESTER_QUICKSTART.md` §8 already; don't be alarmed by it.

**What's changing:** PR **#354** ("async stem transfer off the message thread") moves that
transfer to a dedicated background worker so the freeze goes away entirely, and closes two
defects an adversarial review caught in the process: `uploadBlob`'s PUT never checked the
HTTP status code (a rejected/failed upload could read back as a false success), and a failed
transfer previously had no UI-visible signal at all (silently left a track `sourceMissing`
with the peer none the wiser). **As of this doc, #354 is open and not yet merged to `main`**
— it ships behind a `MOSH_MP_SYNC_TRANSFER=1` kill switch that reverts to the current
synchronous behavior if anything about the async path misbehaves. If #354 has landed by the
time you read this, the brief-freeze item above is resolved; if not, the freeze is still
expected and still harmless.
