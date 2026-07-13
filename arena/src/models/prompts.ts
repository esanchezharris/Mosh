// Prompt construction for the model designers. Each candidate is generated against the
// shared kit (tokens injected so var(--v2-*) resolves) with a two-pass brief. Output is
// forced to be JUST the artifact (fragment / GLSL) — fences are stripped client-side.

import { tokensCss, type Theme } from "../kit/tokens";
import { designSizeFor, type CandidateKind, type Pass, type Target } from "./types";

const PASS_BRIEF: Record<Pass, string> = {
  elevate:
    "PASS = ELEVATE. Keep the MOSH identity intact — the near-black 'Midnight Drive' surfaces, the sacred lime accent (#ccff36), the cream light option, the calm minimalism. Do NOT reinvent it. Make it exquisite: considered depth, real materiality (glass, subtle shadows, hairline highlights), refined type and spacing, and one or two delightful micro-interactions. It should look instantly recognizable as Mosh — just far more premium. Think: the iPhone of DAWs.",
  bolder:
    "PASS = BOLDER. Push the look further than the current shell — richer materials, more dramatic light, a more distinctive type or motion treatment, a stronger point of view. BUT: lime stays the signature accent and MOSH stays MOSH — this is NOT a full reinvention, it is Mosh turned up to cinematic. Surprise me while staying on-brand.",
};

export const TARGET_BRIEF: Record<Target, string> = {
  shell: "Render a complete Mosh arrangement SHELL: a top bar (brand 'MOSH', centered transport with play/stop/record + a bars·beats time readout), a thin left tool rail, a centered timeline stage with a ruler and the 4 tracks below (Drums, Bass, Keys, Vox) each holding a couple of clips with little waveforms, an AI agent composer pill at the bottom-center, and a right rail with a character presence orb + a small inspector. Make the whole frame feel alive.",
  moshi: "Render a VISION for how MOSHI — the agent creature — lives inside the Mosh interface. This is the headline question. See the MOSHI GROUND TRUTH below and mount the REAL creature. Show where it lives, how present it is, and how it relates to the work and the agent's state.",
  stage: "Render an AMBIENT STAGE: the customizable backdrop/visualizer layer the whole interface sits on — session-tinted background, generative visuals, and a small Moshi presence. Show how the 'song's coat' could tint the entire surface at a chosen intensity (minimal → full-ambient) without drowning the work. Mount the REAL Moshi small within it.",
  waveform: "Render the CLIP MATERIAL — the signature look of a clip's contents as a liquid/physical MATERIAL. It must work for ALL THREE clip kinds (uMode 0 audio, 1 midi, 2 drums): audio as a spectral body, MIDI notes as gooey SDF capsules that weld into chords, drum hits as metaballs. Same material rules, different geometry. Legible, alive at the playhead, performant.",
  transport: "Render a TRANSPORT control cluster: previous, play (the hero, lime), stop, record (red), a bars·beats·ticks time readout, and a tempo (BPM). Tactile and premium.",
  trackHeader: "Render a single TRACK HEADER: a type icon, an editable-looking name + chain label, mute/solo toggles, and a subtle live level indication. It sits in a stack of lanes.",
  composer: "Render the AI AGENT COMPOSER — Mosh's smart centerpiece: a prompt input ('Ask Mosh to…'), a mic button, a send button, a listening state, and a row of suggestion chips (Finish this section / Re-imagine the drums / Write a hook). Make the intelligence feel present and calm.",
  inspector: "Render an INSPECTOR card: a track's mix (volume in dB, pan, output routing, mute/solo) as clean rows, or a small FX rack. Data-dense but elegant; use tabular-nums for values.",
  clip: "Render a single audio CLIP on a lane: rounded, with an inline waveform, a name, and a selection/hover treatment.",
  button: "Render a set of Mosh CONTROLS: primary + ghost buttons, a segmented control, a toggle switch, and a small icon button — the interaction vocabulary, in the Mosh style.",
  companion: "Render the MOSH iPHONE COMPANION — the pocket remote for a live Mosh desktop session, as a NATIVE-FEELING iOS app screen. This is a MOBILE surface (390×844, portrait): design for THUMBS — generous touch targets (≥44px), bottom-weighted primary controls, an iOS status bar at the top and a home-indicator + safe-area at the bottom. Include: a session header (song name · tempo BPM · musical key · a bars·beats readout), the HERO TRANSPORT (a big lime play, a stop, a red record, and a scrub/jog you can drag), a compact per-track MIX strip or two (fader + mute/solo + a live level meter), a quick 'Ask Mosh' / mic action (the agent, on mobile), a small MOSHI presence as the connection's face/status, and a subtle 'paired to MacBook Pro · 12ms' connection line. Optionally a bottom tab bar (Transport · Mixer · Agent). It should feel like the most beautiful remote you've ever held — instantly Mosh, instantly iOS-native. It will be demoed on a REAL iPhone, so it must look right at 1:1.",
};

// ── The Moshi ground truth + the owner's resolved framework, injected for moshi/stage. ──
const MOSHI_BRIEF = `
MOSHI GROUND TRUTH (obey this — it is the brand and the relationship):
- WHO: Moshi is a living creature — an organic, gooey blob that has latched onto the producer like a cute symbiote that just wants to make music. Music-culture, under-30, a little feral ("mosh" = the pit), confident, alive. NOT corporate SaaS. Cute with range; the music earns the menace.
- THE SYMBIOTE DOCTRINE (never violate): TWO CHANNELS, ONE BEING. The FACE is the agent (chevron > < eyes with gaze/blink, a one-dial lime grin, a heat ember) — expression, attention, recording heat. The BODY is the work (gooey lobes, displacement, veins, palette). Neither channel ever touches the other's pixels. Agent STATES may LIGHT the body (ember, flow bands) but never DEFORM it.
- PALETTE (exact): INK #0B0B0B · LIME #CCFF23 · GLOW #D9FF4C · BONE #F6F2EB · MIST #E5E5E1.
- REGISTER: a PS2 creature — flat-shaded, dithered, quarter-res, who happens to be alive. Bounce/springs/squash-&-stretch, never robotic steps(). Styles: 'ps2' (dithered crunch, default), 'toon' (clean sticker), 'baked' (soft Humongous render). Idle life is the product: blinks, gaze wander, antics, sleeps if ignored; he watches the VIEWER by default and the cursor must EARN a glance.
- STATES: IDLE · LISTENING (holds your eye, slow flow) · RECORDING (ember, lime eyes) · PAUSED (heavy lids) · RENDERING (working, eyes half-closed, fast flow) · SLEEPING.
- VOICE: R2-D2 — non-verbal earcons co-fired with a body pose, sung IN THE SONG'S KEY.
- TODAY he lives as a small live character in the right-rail dock (~120–218px), with a mood glow (box-shadow: lime=listen, orange=work, red=rec) and a one-word caption ("vibe/cook/rec/chill"), plus a 30px SVG splat mark in the topbar/composer.

THE REAL CREATURE IS LOADED. Mount it: const m = window.Moshi(hostEl, { personality:'TAR', seed:0.5, quality:'ps2', style:'toon', interactive:true, room:false }); — it creates its own canvas inside hostEl. Drive it: m.setState('LISTENING'); m.set('mood',0.7); m.set('energy',0.5); m.set('heat',0.2); m.setStyle('ps2'|'toon'|'baked'); m.setPersonality('TAR'). Families: TAR (canonical) · DISCO · MOLTEN · GHOST · SILK · BREAKS · CHROME · BUBBLE · PORCELAIN. Give it a real host element with real size in your layout and let it be alive.

THE OWNER'S FRAMEWORK (design within it — this is his resolved thinking):
Three separate layers, do not fuse them:
1) MOSHI CORE — invariant. Silhouette, chevron eyes, animation grammar NEVER change. This is the brand and the relationship. Same character every session.
2) SESSION PATINA — the song's "COAT". As you make a song, its statistics (key, tempo, spectral balance, arrangement density) grow Moshi's texture / palette / aura / particles — a slow, peripheral drift (aging, not a mirror). The generative space is BOUNDED so no point in it is ugly. Same character, a wardrobe of songs. The coat doubles as the song's LIBRARY THUMBNAIL — recognizable across the whole library, distinct per song.
3) THE STAGE — fully customizable decor (backgrounds, visualizers, videos). The patina TINTS the stage so the whole UI subtly carries the song, with a minimal→full-ambient INTENSITY dial. Fast reactive visuals ride playback (when listening, not deciding). The character stays SMALL; the aura SCALES.

EXPLORE THESE TENSIONS (the owner is genuinely undecided — surface real options, don't just re-skin the dock):
- PROMINENCE: omnipresent companion vs. subtle/summoned presence that recedes.
- ROLE: charming mascot (personality, lore) vs. functional agent-face (status, attention, controls) vs. a fusion.
- PLACEMENT: fixed right-rail dock vs. floating/contextual (moves with focus) vs. woven into the composer/the work.
- EMBODIMENT: the PS2 blob vs. more ambient forms (a glow, an aura, a coat over the UI) — staying on-brand.
On the BOLDER pass especially, feel free to explore the ALTERNATIVE the owner is torn about: Moshi's BODY ITSELF morphing with the song (not just a coat) — show it so he can compare it head-to-head against the invariant-core+patina model.`;

const htmlRules = (w: number, h: number) => `OUTPUT RULES (strict):
- Return ONLY an HTML fragment. No markdown, no code fences, no explanation.
- NO <!doctype>, <html>, <head> or <body> tags — just the fragment (markup + at most one <style> and one <script>).
- Self-contained: NO external URLs, imports, fonts, or network (a strict CSP blocks them). Inline everything. Images only as data: URIs (prefer CSS/SVG).
- Use the Mosh design tokens below via var(--v2-*). Fonts are already available: var(--font-display), var(--font-body), var(--font-mono).
- Your fragment renders at EXACTLY ${w}×${h}px — design at that real resolution (it is scaled to fit the viewer). Fill it; position elements absolutely inset:0 if you need a full-bleed frame.
- If you animate, you MAY read window.__mosh.playhead (0..1) and window.__mosh.time (seconds) — the shared transport clock — for a moving playhead / reactivity.`;

const GLSL_RULES = `OUTPUT RULES (strict):
- Return ONLY a GLSL ES 3.00 fragment shader. No markdown, no fences, no prose.
- First line MUST be: #version 300 es
- Declare: out vec4 O; and write to O. precision highp float;
- You receive these uniforms (declare the ones you use): uRes(vec2), uTime,uPlayhead,uPlaying(float), uMode,uCount,uColorMode(int), uNCols,uBeats(float), uData(sampler2D), and the palette/surface uniforms uLow,uMid,uHigh,uGlow,uBg(vec3) etc.
- uMode selects the clip kind: 0 = AUDIO (uData = NCOLS×1, texture(uData,vec2(x01,.5)).r = amp, .gba = low/mid/high bands), 1 = MIDI (uData[i] = start,dur,pitch01,velocity via texelFetch; render notes as gooey SDF capsules that weld), 2 = DRUMS (uData[i] = x01,lane,velocity; render hits as metaballs). Support all three. uPlayhead is the play position (0..1).
- ALL for-loops MUST be bounded by a constant integer literal <= 128. No while loops. Keep it performant.`;

export function buildMessages(
  target: Target,
  pass: Pass,
  kind: CandidateKind,
  theme: Theme,
  seed: string,
  extra?: string,
) {
  const { w, h } = designSizeFor({ target });
  const rules = kind === "glsl" ? GLSL_RULES : htmlRules(w, h);
  const tokenBlock =
    kind === "html"
      ? `\n\nMOSH DESIGN TOKENS (already injected as :root variables — reference them):\n${tokensCss(theme)}`
      : "";
  const moshiBlock =
    target === "moshi" || target === "stage" || target === "companion" ? `\n${MOSHI_BRIEF}\n` : "";
  // Panel brief from the cross-critique round — carry the field's best ideas forward, fix its
  // weaknesses. NOT a copy instruction: the designer must still make its OWN candidate.
  const panelBlock = extra
    ? `\n\nDESIGN PANEL FEEDBACK (the other designers audited the wall — synthesize the strongest ideas and fix the noted weaknesses; stay on-brand, and do NOT copy any single candidate verbatim):\n${extra}\n`
    : "";
  const system =
    "You are one of several elite product designers auditioning for Mosh — a DAW that wants to be 'the iPhone of DAWs': smart, beautiful, and unlike any DAW before it. You produce a single, self-contained, rendered design candidate. You have exquisite taste and you sweat every detail. You never explain — you only output the artifact.";
  const user =
    `TARGET: ${TARGET_BRIEF[target]}\n\n${PASS_BRIEF[pass]}${moshiBlock}${panelBlock}\n\n${rules}${tokenBlock}\n\n` +
    `Variation seed: ${seed} (make this candidate meaningfully different from an obvious default). Output the ${kind === "glsl" ? "shader" : "HTML fragment"} now.`;
  return { system, user };
}
