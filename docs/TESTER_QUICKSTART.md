# Tester quickstart — welcome to Mosh

Someone invited you to jam on **Mosh**, a little Mac music app they're building. This page
gets you from "just got a zip file" to "making sound together" in about ten minutes. No
coding, no accounts, nothing to sign up for.

> Keep **Discord** (or any voice call) open the whole time — that's how you'll talk to your
> host. Mosh syncs the *song*, not your voices.

## 1. What you need

- **Any Mac** — Apple Silicon (M1/M2/M3/M4) or Intel. Mosh ships as a Universal app.
  On an Intel Mac everything in the DAW works; the one difference is that the on-device
  AI engine (step 7) needs Apple Silicon, so generative renders use the fast **preview**
  engine instead. Mosh labels which one you're hearing, so you're never guessing.
- **macOS 11 (Big Sur) or newer.**
- About **1 GB** of free disk space for the app itself. If you later opt into the real AI
  engine (step 7, totally optional), budget another **~10 GB**.
- **Discord**, or any way to voice-call your host, open on the side.

## 2. Install

1. Get **Mosh.app** from your host — AirDrop, Dropbox, a zip, however they send it.
2. Drag **Mosh.app** into your **Applications** folder.
3. This build isn't signed by Apple, so the first time you open it, macOS will refuse:
   *"Apple could not verify Mosh is free of malware."* That's expected — clear it once,
   any one of these three ways:

   **Easiest — paste this into Terminal** (Applications → Utilities → Terminal):
   ```bash
   xattr -dr com.apple.quarantine /Applications/Mosh.app
   ```
   Then just double-click Mosh like any other app.

   **Or — right-click instead of double-click:** in Finder, right-click **Mosh.app** →
   **Open** → **Open** again in the dialog. (The right-click menu has an "Open" option that
   plain double-clicking doesn't offer.)

   **Or — if macOS still won't budge:** open **System Settings → Privacy & Security**,
   scroll down, and click **Open Anyway** next to the Mosh warning.

## 3. First launch

- The very first launch can take a **moment longer than usual** — Mosh is quietly scanning
  your Mac for audio plugins (instruments/effects) in the background. Just give it a few
  seconds; you don't need to do anything.
- macOS will ask permission for **Microphone** and **Speech Recognition** — click **Allow**
  on both if you want to talk to Mosh's voice assistant. If you'd rather just type or click,
  it's safe to skip these; nothing else breaks.

## 4. Sound check

1. Make sure the right **output device** is selected — check both macOS's own **Sound**
   settings and Mosh's own audio-device picker in its **Settings** panel (they can differ,
   e.g. a laptop's speakers vs. connected headphones).
2. Play the **built-in drum kit** or any seeded track to confirm you hear sound.
3. If it crackles or stutters, raise the **buffer size** in Mosh's audio settings — a bigger
   buffer trades a little latency for stability, which is the right trade for a first jam.

## 5. Join the session

1. Open the **2-player panel** (top-right of the Mosh window).
2. Your host clicks **Create session** there and pastes you a **room code** (send it over
   Discord).
3. In your own 2-player panel: type your name, pick a colour, **paste the room code**, hit
   **Join**.
4. You should both see two names in the roster with a green "online" dot next to them.
   You're in — same song, two windows.

## 6. What to try first

- Start with **MIDI clips + Mosh's built-in instruments** (the drum kit, the 4OSC synth) —
  this is the most solid, best-tested path, and it syncs between you two instantly with no
  file transfer at all.
- Have **each person take one track** — you can both work at once without stepping on each
  other (a small lock badge shows who's currently editing a track).
- Try a **Re-imagine** on a clip — it's Mosh's AI re-render of a take. The little **engine
  badge** at the top of the generative panel shows which engine **your Mac will use for your
  next render**: **SA3** for the real Stable Audio 3 model, or **preview** for a fast
  stand-in (normal on a guest Mac that hasn't installed the real model yet — see step 7 if
  you want the real thing). Once a render finishes, look just below its status for a small
  **"rendered by preview engine"** note — that's the truth for *that specific render* (the
  badge up top can only tell you what's about to happen, not what already happened, e.g. if
  the real model went down mid-session).

## 7. Optional: real AI on your Mac (10–30 minutes, ~10 GB)

By default, Mosh's AI re-renders run on a fast **preview engine** — good enough to get a
feel for the feature, but not the real model. If you want the genuine Stable Audio 3 model
running locally on your own Mac:

1. Make sure Apple's command-line developer tools are installed (one-time, if you don't
   already have them):
   ```bash
   xcode-select --install
   ```
2. Run the one setup command (this downloads and installs the real model — it's the ~10 GB
   and 10–30 minutes mentioned above):
   ```bash
   bash /Applications/Mosh.app/Contents/Resources/setup-guest.sh --all
   ```
3. **Quit Mosh completely and reopen it.**
4. Try another Re-imagine and check the engine badge again — it should now say **SA3**
   instead of **preview**. That's your confirmation the real model is live.

This step is entirely optional — everything else in Mosh works fine on the preview engine.

## 8. Tips (a few known quirks)

- **Export from MIDI/instrument tracks, not audio clips.** Recorded or AI-rendered audio
  clips are great for listening together, but treat them as *auditioning* — build whatever
  you plan to export or bounce out of MIDI + instruments.
- **If a clip says "source missing,"** it just means the audio hasn't finished transferring
  to you yet — ask your host to nudge (re-select / touch) that track so it re-sends.
- **Agree on tempo out loud, up front.** If you both change the tempo at the same moment,
  whoever's change lands last wins — so just say it over Discord instead of fighting over
  it in-app.
- **A brief freeze right after your host adds an audio clip is normal** — a stem is
  transferring in the background. It'll unstick itself in a few seconds.
- Each of you has your **own playhead** — pressing play on your machine doesn't move your
  host's cursor (or vice versa). That's by design; just talk over Discord to stay in sync.

## 9. If something breaks

Don't worry about diagnosing it yourself — just grab the diagnostics bundle and send it to
your host:

```bash
bash /Applications/Mosh.app/Contents/Resources/collect-diagnostics.sh
```

This drops a zip file on your **Desktop**. Send that zip to your host (Discord, email,
whatever's easiest) along with a quick note about what you were doing when it happened.

---

That's it — have fun. If you get stuck anywhere above, your host would rather you ask a
"dumb" question over Discord than quietly give up.
