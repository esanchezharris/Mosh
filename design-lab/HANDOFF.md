# HANDOFF — THE MOSHI LAB, v9 state (2026-06-13)

*Written for the next agent (Codex or anyone) to continue this work cold.
Everything here was built and verified in the design lab; the app build
(`/src`, `/ui`, CMake) is untouched by all of it. Read this first, then
[README.md](README.md) (run + API), [HOUSE_STYLE.md](HOUSE_STYLE.md) (the
rules), [LOOKBOOK.md](LOOKBOOK.md) (the catalog + version record).*

## What this is

**Moshi** — Mosh's agent — as a portable, interactive, PS2-register 3D
character with a procedural voice. The lab is now four host-wired files (the
pattern: `moshi.js` is pure; everything else couples to it through its public
API):

- **`playground/moshi.js`** — THE COMPONENT. One classic script, zero deps,
  WebGL1. `Moshi(hostEl, opts)` → a living creature in any canvas-capable
  host, 24px to full-stage. The portability seam (GLSL + semantic-drives API).
  **Stays pure — no audio, no network inside it.**
- **`playground/voice.js`** — THE VOICE (`MoshiVoice`). Procedural R2-D2-style
  earcons (Web Audio, zero-dep), one per INTENT, affect-coloured + seeded.
- **`playground/brain.js`** — THE BRAIN (`MoshiBrain`). LLM → `intent` + opt
  `say`, via a key-safe Vite proxy. Intent-aware; routes through `utter()`.
- **`playground/index.html`** — THE STAGE. Curated looks + chips (STATE / POSE /
  ANAT / STYLE / RES / SIGNAL), the **event panel** (drives him by simulated
  agent/engine events), and the **`utter()` funnel** (sound + pose + opt bubble).
  `npm run dev` in `playground/` → http://localhost:5180.

## The design, in one paragraph

Everyone meets the same Moshi (the covenant). He is ONE being with two
channels: the FACE is the agent (big `> <` chevron eyes, one-dial open grin
with tongue + gleam, heat ember — attention, blinks, reactions), the BODY is
the work (the splat anatomy, displacement skin, palettes, veins — personality
and drives). He is **3D at rest and 2D when he speaks**: five limbs (left
arm, head, right arm, two legs) sit absorbed at seeded fore/aft depths in a
round blob; when he emotes they extend and the body flattens into the flat
sticker plane (the user's reference art — see the brand splat images in the
chat record / their web-Claude artifact). The face is ON the body — spin him
and it goes with him; he eases home because he wants to face you, eyes
counter-rotating to hold your gaze.

## The systems (all in moshi.js, in reading order)

1. **FRAG shader** — raymarched SDF: core sphere + 5 capsule limbs
   (`u_limb[5]`: angle/len/rad/z-tilt, CPU-computed), dynamic z-flatten
   (`u_zflat`) with matching Lipschitz correction, core lean/breath
   (`u_lean`/`u_coreS`), two Blob-Mixer displacement layers (body waves +
   skin, face-protected, near-field gated), iq cosine palette per family,
   banded key/fill light + clearcoat glint + iridescent fresnel, lime veins
   as noise iso-curves, flow bands (state light), face decals (eyes/grin/
   tongue/gleam/ember), the ROOM (stage mode), and the TOON branch
   (`u_toon`: dither starved, 2 bands, smooth normals, thin outline ring).
2. **Families** (9): TAR DISCO MOLTEN GHOST SILK BREAKS CHROME BUBBLE
   PORCELAIN — material + displacement voice + temperament + seeded limb
   anatomy. `makeSpec(name, seed)` resolves fixed endpoints; crossfades lerp
   specs (MORPH RULE: never re-derive from a blend; time-RATES integrate as
   phases in JS, never lerp).
3. **Drives** — `set('energy'|'mood'|'heat', 0..1)`. Semantic, source-free:
   the host wires engine meters / agent state / nothing into the same
   scalars. THE integration seam for the product.
4. **States** — IDLE LISTENING RECORDING PAUSED RENDERING SLEEPING: bundles
   of face pose, tempo, and LIGHT (flow/ember). Doctrine: agent states may
   light the body, never deform it. + `celebrate()` one-shot.
5. **Poses** — NEUTRAL SPLAY ARMS_UP TUCK DROOP WAVE REACH: per-limb configs
   + meta (flat/lean/core) blended through **second-order dynamics**
   (t3ssel8r's controller, credited) with per-pose f/ζ temperament; triggers
   within 140ms queue; auto-return after settle to the state's base pose.
   Pokes/celebrate/sleep/glances all hit poses.
6. **Attention** — he watches the VIEWER by default (center-biased ballistic
   saccades with held fixations + micro-saccades); the cursor earns a glance
   by passing near with speed; 25% deliberate ignores; return-with-cooldown;
   habituation. Blinks punctuate big saccades and state changes. Eyes lead,
   body follows ~150ms.
7. **Poke repertoire** — startle-hop / squash-oof / double-take / delight-
   bounce, temperament-weighted; escalation: 3+ pokes = real startle, 5+ =
   ANNOYED (squint, sulked grin via mouth-tilt flatten, turned back, DROOP,
   6s ignore). Petting (hold 550ms still) forgives.
8. **Dials** — `setQuality('ps1'|'ps2'|'ps2+')` (res + wobble inverse),
   `setStyle('ps2'|'toon'|'baked')` (render language: crunch · sticker · soft
   baked adventure-game clay — see HOUSE_STYLE "STYLE dial"; a point-cloud
   style was built and cut, the user didn't like it),
   `setAnatomy('A'|'B'|'C')` (3D-vs-flat balance — user choosing),
   `interactive`, `room`, `preserve` (pixel-readback for tests).

## Perf rules (hard-won — do not regress)

- **Pose/rotation updates at full frame rate; only the wobble + texture
  clock live on the 12fps on-twos.** (Easing rotation on twos read as
  dropped frames — the v3 bug.)
- **The page SVG filter must never wrap the animating canvases** (Chromium
  re-rasterizes the whole filtered subtree per frame). The cable carries
  chrome only; the GL crunch is in-shader.
- **`bayer()` must floor `gl_FragCoord`** (pixel centers otherwise push the
  matrix past 1.0 → column-lattice rain; latent since the first Pit).
- Frame-constant shader math lives on the CPU as uniforms; no
  getBoundingClientRect in the loop (cached, invalidated on resize/scroll);
  `preserveDrawingBuffer` off by default; opaque context in room mode;
  step-starved grazing rays hit at closest approach (never fall through);
  thin features come from noise iso-curves, never near-zero fold-field
  thresholds.

## The user's standing taste (synthesized; full record in LOOKBOOK + memory)

PS2-era console crunch, anti-slop; curated lookbook over slider panels;
notes arrive as natural language. Specifics: splat = the brand anatomy; 3D
at rest / 2D emotes; no static center (core leans, face rides it); face BIG;
SOD motion law (hand-eased = "jerky, unprofessional"); drag =
grab-the-surface; attention must read intelligent (glance + look back +
occasional snub — never servo-follow); reactions must vary + escalate; no
thick "oil" border; **frontrunner render: STYLE·TOON at RES·PS2+, SIGNAL·PS2
on chrome** (current stage default).

## OPEN THREADS (the work continues here)

1. **Anatomy pick** — user is choosing between ANAT A / B / C live on the
   stage chip. Bake the winner, retire the chip (keep `setAnatomy`).
2. **Edge ringing** — at TOON + PS2+ there's faint concentric ringing at the
   silhouette (grazing-ray rescue shells + edge fill + outline interacting).
   Improved from the "oil" but not perfect. Ideas: shade rescued hits with
   pulled-back normals; widen the rescue epsilon with res; outline from a
   screen-space silhouette test instead of fres.
3. **The brain + the voice + events** — ✅ BUILT (2026-06-13, v8→v9).
   - **Brain** (`brain.js`): an LLM classifies a turn into an `intent` (+ optional
     `say`); keys live server-side in a Vite plugin (`vite.config.js`) proxying
     `/api/brain/*` (browser never sees one). Three providers, switchable:
     DeepSeek `deepseek-v4-flash` (default/fastest), OpenAI `gpt-5.4-mini`
     (GPT-5/o-series → `max_completion_tokens`, no custom temp), xAI `grok-4.3`.
     Reasoning models need a generous token budget or the JSON clips. Config:
     `.env.example` → gitignored `.env.local`. The brain is now intent-aware and
     routes through `utter()` via `MoshiBrain(stage, {onUtter})` — de-surfaced in
     the lab (no chat box) but ready for the product "talk to him" path.
   - **Voice** (`voice.js` = `MoshiVoice`): procedural earcons, Web Audio,
     zero-dep. Timbre = a **cute creature** (sine/triangle coos, chorus +
     portamento; an astromech take was tried then softened — user's call). 8
     intents (ACK_GOT_IT/ACK_WORKING loop/DONE/HUH/NUH/UHOH/GREET/IDLE_MURMUR),
     affect-coloured + seeded. **IN-KEY:** contours are scale degrees snapped to
     the song's key via `voice.setKey(tonic,mode)` — STUB: the engine has no key
     yet (tempo/time-sig only; `tempoKeyContext` placeholder in RenderLayer.h);
     feed a real key from `mosh_event` when it exists. A host
     `utter(intent,{affect,say})` funnel co-fires sound + the intent's pose/face;
     bubble only when `say` is set. Autoplay unlocks on first gesture. CAP=6
     concurrent + onended teardown (no leaks). DONE/non-working intents clear the
     RENDERING work-state; any event wakes him from SLEEPING.
   - **Events**: the lab is event-driven — buttons fire mock events keyed to the
     real `mosh_event` contract through an `EVENT_INTENT` translator into
     `utter()`. NEXT: point `fireEvent`/the translator at the LIVE feed
     (`ui/src/store.ts` `mosh_event`, or RemoteCompanionServer `/events` poll via
     `startLabFeed`) and add the agent-activity events the product still lacks
     (task-received, ambiguous, declined). Optional: a real *spoken* lane later.
4. **Parked (user-blessed):** bitmap HUD-numeral face
   (github.com/ianhan/BitmapFonts); real per-band spectral feed in
   `src/RemoteCompanionServer` (~50 lines, approved, next time src/ is
   touched); finished-track one-shot smile; audio listening lane (the
   2000s-visualization-expert skill is installed for when it returns).
5. **Pose growth** — the vocabulary wants more entries (POINT at things,
   LEAN-IN curiosity, a proper sleep curl); each needs a face beat + an SOD
   temperament.
6. **Product integration** — when the new UI lands (any language):
   embed the component, feed three drives + setState from real engine
   events. The component never learns about transports.

## Verification conventions (the preview harness lies — know how)

rAF + timers are throttled except during screenshot runs: use `m._step()`
(one synchronous frame), `m._move()` (force a lobe fidget), spaced-eval
loops for time-dependent behavior; pixel sampling needs `preserve: true` at
construction; the viewport collapses randomly — resize before screenshot
runs; stills constantly catch mid-blink frames (eyes look closed — they
aren't). Always: console sweep + state() probes + screenshots, and never
claim feel from stills — springs need live eyes.

## Credits

14islands' Blob Mixer (body-language grammar + named personalities; via
github.com/connorhvnsen/blob-mixer) · the user's web-Claude SYMBIOTE LAB
artifact (limb migration, flow bands, mouth tilt, tongue, GHOST→PORCELAIN)
· t3ssel8r (second-order dynamics) · Inigo Quilez (cosine palettes, SDF
canon) · NanumSquareRound (Naver, OFL).

## Branch topology — CONSOLIDATED (2026-06-12)

**`main` is now the single source of truth.** The Moshi work (v1→v6) and
Codex's app build (`/src`, `/ui`, gates) live together on `main`. All work
continues here, in the main checkout (`~/Documents/ClaudeMosh`); the next
phase is a full UI rebuild that integrates the Moshi component. Run the
lookbook with `npm run dev` from the repo root (`.claude/launch.json` →
`design-lab/playground`, port 5180; `npm install` there first).

The **`design-lab`** branch (on origin) is now a frozen ARCHIVE of the
fine-grained v1→v6 history: v1 THE MOSHI PASS (`a73f3e7`/`2d4ef28`) → v2 THE
LOOKBOOK (`a36df11`) → v3 mind+60fps (`685edfb`) → v4 THE SPLAT (`8facebe`) →
v5 IN THE ROUND (`97dd50c`) → v6 FLUID & FACE-ON (`0e4ea68`). Don't develop
on it — it's there to read how a decision was reached. Its worktree
(`~/Documents/ClaudeMosh-lab`) is redundant now; safe to `git worktree
remove`, but it holds gitignored extras (node_modules, fetched inspiration
media), so it was left in place rather than deleted unprompted.
