# THE MOSHI LAB

One deliverable lives here: **Moshi** — the agent as a beautiful, interactive,
PlayStation-2-register character. Everything else this lab ever built (the DAW
skins, the arrangement views, the scene rail) was retired on 2026-06-12
("THE MOSHI PASS: scorched earth"); git history before that commit keeps all of it.
The app build (`/src`, `/ui`, CMake) remains untouched by anything in here.

> Everybody meets the same Moshi. What he becomes is up to what you make.

## Run it

```sh
cd design-lab/playground
npm install   # first time only (vite is the only dep)
npm run dev   # → http://localhost:5180 — the stage
```

The stage is **THE LOOKBOOK** ([LOOKBOOK.md](LOOKBOOK.md) is its catalog): ◀ ▶ or
the wheel turn pages through curated looks (personality × state × seed, captioned),
the state chips re-pose the current look, **R** rerolls the seed inside a family,
**C** = a take lands. Click = poke, hold = pet, drag = spin. He blinks, glances
around, migrates his own lobes, and falls asleep if you ignore him long enough.
RES (top right) walks the console dial — PS1 / PS2 / PS2+ — and SIGNAL A/Bs the
whole-page signal chain.

## The component — `playground/moshi.js`

One classic script, zero deps, WebGL1. Drop it next to a host element in any page
(or any WebView, in any app, in any language) and he lives in it — from a 24px
presence orb to a full stage. The crunch (quarter-res, Bayer dither, banded light,
faceted normals, on-twos) is all in-shader, so the look ports wherever GLSL does.

```js
const m = Moshi(hostEl, {
  personality: 'TAR',   // TAR · DISCO · MOLTEN · GHOST · SILK · BREAKS · CHROME · BUBBLE · PORCELAIN
  seed: 0.5,            // bounded variation inside the family
  interactive: true,    // gaze/poke/drag/pet + idle life; false = API-driven only
  room: false,          // ground + contact glow + aura (the stage turns this on)
  quality: 'ps2',       // the console dial: 'ps1' | 'ps2' | 'ps2+'
});

m.set('energy', v);     // 0..1 — how hard the work is going (waves, veins)
m.set('mood', v);       // 0..1 — resting grin + liveliness
m.set('heat', v);       // 0..1 — REC/excitement: ember core, lime eyes
m.setState('LISTENING'); // IDLE · LISTENING · RECORDING · PAUSED · RENDERING · SLEEPING
m.setPose('ARMS_UP');    // NEUTRAL · SPLAY · ARMS_UP · TUCK · DROOP · WAVE · REACH
m.setStyle('baked');     // 'ps2' crunch · 'toon' sticker · 'baked' soft adventure-game clay
m.celebrate();           // one-shot: a take landed
m.setPersonality('GHOST' | 0.37 [, seed] [, { snap: true }]);  // crossfades
m.setQuality('ps2+'); m.reroll(); m.poke(); m.lookAt(nx, ny);
m.state(); m.onPersonality(fn); m.destroy();
```

**Drives are semantic, not sources.** The component never knows about transports,
meters or agents — the host wires whatever it has into the same three scalars.
That's the swappable seam: the future UI (whatever language it's written in)
keeps Moshi by feeding three numbers and a canvas.

**Two channels, one being** (the doctrine that survived every era of this lab):
the FACE is the agent — eyes, grin, blink, gaze, ember; the BODY is the work —
waves, skin, veins, palette. They never compete for the same pixels.

Body language is Blob Mixer's grammar, credited — 14islands' Blob Mixer
(https://blobmixer.14islands.com/, source via github.com/connorhvnsen/blob-mixer):
two displacement layers with face protection, and named personality presets
translated into our raymarched, dithered register. The SHAPE is the brand
splat: a core with five gooey limbs that pose.

**The brain (built — 2026-06-13).** Type to Moshi on the stage and a real LLM
drives him. Doctrine holds: `moshi.js` stays pure; the brain is host wiring
([playground/brain.js](playground/brain.js)) that turns a chat turn into a
**behaviour directive** and applies it through the public API:

```json
{ "say": "<=12 words", "state": "RECORDING", "pose": "ARMS_UP",
  "mood": 0.9, "energy": 0.8, "heat": 0.7, "celebrate": false }
```

Every field is validated against Moshi's own enums (`Moshi.STATES` / `.POSES`)
and the drives are clamped — a hallucinated value is ignored, never thrown.

**Keys never touch the browser.** A Vite dev plugin ([vite.config.js](playground/vite.config.js))
holds them server-side and proxies same-origin `/api/brain/{providers,chat}`.
Three providers ship, all OpenAI-compatible, switchable live on the stage to
A/B the same prompt:

| provider | base | default model | note |
|---|---|---|---|
| DeepSeek | `api.deepseek.com` | `deepseek-v4-flash` | fastest (~0.4–2s); the default |
| OpenAI | `api.openai.com/v1` | `gpt-5.4-mini` | GPT-5/o-series → `max_completion_tokens`, no custom temp |
| xAI / Grok | `api.x.ai/v1` | `grok-4.3` | |

Setup: `cp playground/.env.example playground/.env.local`, fill any subset of
keys, set `MOSHI_BRAIN_PROVIDER`. `.env.local` is gitignored. v4/GPT-5/Grok are
reasoning models — the proxy budgets tokens for hidden reasoning + the JSON so
short replies aren't clipped mid-object. (Legacy `MOSHI_BRAIN_URL/_KEY/_MODEL`
single-endpoint shape is superseded by this multi-provider proxy.)

**The voice + events (v9, 2026-06-13).** Moshi doesn't speak in words — he
communicates in **sound**, like a small cute creature (Wall-E register: sine/
triangle coos + chirps, gentle chorus + portamento, no bit-crush).
[playground/voice.js](playground/voice.js) (`MoshiVoice`, Web Audio, zero-dep)
synthesizes one earcon per INTENT (`ACK_GOT_IT · ACK_WORKING · DONE · HUH · NUH ·
UHOH · GREET · IDLE_MURMUR`), each affect-coloured (`{valence,arousal}`) and
seeded so it varies but never goes ugly. A host `utter(intent, {affect, say})`
funnel co-fires the sound + the intent's pose/face; a **text bubble pops only
when words are essential** (e.g. an error detail).

**He sings IN THE SONG'S KEY.** Every earcon is written in scale degrees and
snapped to the current key, so he's always consonant with the track.
`voice.setKey(tonic, mode)` (e.g. `'A','minor'`) — the stage cycles demo keys on
the KEY chip. **Stub:** the engine doesn't track a musical key yet (it has tempo
+ time-sig; `tempoKeyContext` in `src/state/RenderLayer.h` is a placeholder) —
when a real key lands on the `mosh_event` feed, call `setKey` from that event.

The lab is **event-driven** (no chat box): a panel of simulated agent/engine
events — keyed to mirror the real `mosh_event` contract (`layer_render_progress`,
`layer_status`, `error`, …) — runs through an `EVENT_INTENT` translator into
`utter()`. The same `fireEvent(type)` call later sits on the live feed unchanged.
The LLM brain above stays available and is now intent-aware (it emits an `intent`
+ optional `say`, routed through the same funnel via `MoshiBrain(stage,{onUtter})`)
— it's just de-surfaced in the lab this pass. Autoplay: the AudioContext unlocks
on the first user gesture (a primer + every event button calls `voice.unlock()`).

## Map

| path | what |
|---|---|
| [HANDOFF.md](HANDOFF.md) | **Start here if you're new** — the full state, systems, open threads |
| [playground/moshi.js](playground/moshi.js) | THE COMPONENT — self-contained, portable |
| [playground/index.html](playground/index.html) | THE LOOKBOOK — the curated stage + 220px max-res corner twin + the event panel + the `utter()` funnel |
| [playground/voice.js](playground/voice.js) | THE VOICE — `MoshiVoice`: procedural PS2-astromech earcons (Web Audio, zero-dep) |
| [playground/brain.js](playground/brain.js) | THE BRAIN — host wiring: chat turn → intent directive → `utter()` (intent-aware) |
| [playground/vite.config.js](playground/vite.config.js) | dev server + the brain proxy (keys server-side; OpenAI-compatible) |
| [playground/.env.example](playground/.env.example) | brain provider config template (copy to gitignored `.env.local`) |
| [LOOKBOOK.md](LOOKBOOK.md) | The catalog: every look, state, family, steal, and version |
| [HOUSE_STYLE.md](HOUSE_STYLE.md) | The register: PS2 crunch, signal chain, face doctrine, morph rule, color doctrine |
| [BRIEF.md](BRIEF.md) | The fiction — who Moshi is |
| [tokens/moshi.css](tokens/moshi.css) | Palette + the NanumSquareRound display face |
| [tokens/ps2-pass.css](tokens/ps2-pass.css) | The whole-page signal chain (canonical copy) |
