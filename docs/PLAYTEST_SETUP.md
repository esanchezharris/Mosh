# Playtest setup — for your friend (the guest)

Mosh is an unsigned app shared directly between friends, so macOS needs one manual
"yes, I trust this" the first time. ~2 minutes, once per machine.

> You'll also want **Discord** (or any voice call) open — that's how you talk and hear each
> other. Mosh syncs the *project*; it does **not** stream your voices. See `docs/MULTIPLAYER.md`.

## 1. Requirements
- A **Mac** (Apple Silicon — M1 or newer — recommended; this build is arm64).
- The **Mosh.app** the host sends you (via AirDrop, Dropbox, or a zip).
- An internet connection (multiplayer uses a built-in cloud relay — no setup).

## 2. Install
1. Put **Mosh.app** in `/Applications` (or anywhere; `/Applications` is tidiest).
2. Because it's unsigned, macOS will block the first open ("Apple could not verify…").
   Clear that **once**, either way:

   **Easiest — Terminal one-liner:**
   ```bash
   xattr -dr com.apple.quarantine /Applications/Mosh.app
   ```
   Then double-click normally.

   **Or — Finder:** right-click **Mosh.app → Open → Open** (the right-click menu has an
   "Open" that the plain double-click doesn't). If macOS still refuses, go
   **System Settings → Privacy & Security**, scroll down, and click **Open Anyway**.

3. (Optional, for voice control) On first use of the mic, macOS will ask for **Microphone**
   and **Speech Recognition** permission — click **Allow**. Not needed if you'll type/click.

## 3. Join the session
1. Host clicks **Create session** in the **2-player** panel (top-right of the Mosh window)
   and pastes you the **room code** (in Discord).
2. You open the same **2-player** panel → type your name, pick a colour → **paste the room
   code** → **Join**.
3. You should see both names appear in the roster with a green "online" dot. You're in.

## 4. How it feels (so nothing surprises you)
- **You each have your own playhead.** Press play on your machine to hear the song; the host
  pressing play doesn't move your cursor. Keep in sync verbally over Discord.
- **One person edits a track at a time.** A lock badge shows who holds a track. The other
  person's edits appear when they **move off** that track (or after a few idle seconds).
- **MIDI & instrument parts appear instantly.** Recorded/imported/AI-generated **audio**
  clips take a few seconds to transfer (and may briefly freeze the window — that's normal).
- **Agree on tempo/key up front.** Tempo is last-writer-wins; don't both change it at once.

## 5. Troubleshooting
| Symptom | Fix |
|---|---|
| "Mosh can't be opened / Apple could not verify" | Run the `xattr` line above, or right-click → Open. |
| 2-player panel won't connect | Check internet; re-copy the room code (no extra spaces). |
| A clip shows "source missing" | Ask the host to re-select / nudge that track so it re-commits the audio. |
| No sound on play | Check macOS output device + Mosh's audio device in Settings; raise buffer if it crackles. |
| Window freezes a few seconds after host adds audio | Normal — a stem is transferring. It'll come back. |

That's it — once you're both in the roster, start making noise.
