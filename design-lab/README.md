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
translated into our raymarched, dithered register.

## Map

| path | what |
|---|---|
| [playground/moshi.js](playground/moshi.js) | THE COMPONENT — self-contained, portable |
| [playground/index.html](playground/index.html) | THE LOOKBOOK — the curated stage + a 76px corner twin |
| [LOOKBOOK.md](LOOKBOOK.md) | The catalog: every look, state, family, steal, and version |
| [HOUSE_STYLE.md](HOUSE_STYLE.md) | The register: PS2 crunch, signal chain, face doctrine, morph rule, color doctrine |
| [BRIEF.md](BRIEF.md) | The fiction — who Moshi is |
| [tokens/moshi.css](tokens/moshi.css) | Palette + the NanumSquareRound display face |
| [tokens/ps2-pass.css](tokens/ps2-pass.css) | The whole-page signal chain (canonical copy) |
