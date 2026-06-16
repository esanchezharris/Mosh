// The production-approach spectrum for the arena: same brief, same real DAW + real
// command seam — only the STRATEGY the agent follows changes, from fully-generative
// (text-to-audio stems) to fully-agentic (samples + MIDI + FX, no generation).
// Pure module (no bridge/store) so the arena harness and tests can both use it.
import { commandCatalogPrompt } from "./commands";
import { promptGuidance } from "./promptcraft";

export type Rung = {
  id: string;
  label: string;
  usesSA3: boolean; // generative rungs need the SA3 service (Fake in stage 1, real in stage 2)
  directive: string;
};

// Note the generative pattern's gotcha, baked into the directives below: a render
// needs a host WAVE clip (add_test_tone_clip — a SINE), SA3 ignores its sound in
// text-to-audio mode, but accept_render lands the result as a NEW clip and the sine
// host KEEPS PLAYING — so you MUST remove_clip the host after accepting.
export const RUNGS: Rung[] = [
  {
    id: "R0-generative-single",
    label: "Pure generative — one render",
    usesSA3: true,
    directive:
      "PURE GENERATIVE (one render for the whole brief). ONE call: generate_audio {prompt:'<full-brief metadata-tag description naming EVERY instrument>', seed}. " +
      "It makes a track, renders Stable Audio text-to-audio, and lands the clip — no host-clip / accept / remove steps. Then set_track_volume if needed. No MIDI, no samples.",
  },
  {
    id: "R1-generative-stems",
    label: "Generative stems",
    usesSA3: true,
    directive:
      "GENERATIVE STEMS. For EACH of 2-3 stems (drums, bass, chords): create_track; add_test_tone_clip (read the clipId); create_render_layer {clipId}; " +
      "set_render_param {clipId, prompt:'just the <stem>, <style>'} (no nl); render_layer {clipId, wait:true}; accept_render {clipId}; then remove_clip the host " +
      "test-tone clip so only the generated stem plays. Finally balance with set_track_volume (~-7dB each). No MIDI, no samples.",
  },
  {
    id: "R2-hybrid-gendrums-midi",
    label: "Hybrid — generated drums + played instruments",
    usesSA3: true,
    directive:
      "HYBRID (generated drums + PLAYED instruments). Drums = ONE generative render: create_track → add_test_tone_clip (read clipId) → create_render_layer {clipId} → " +
      "set_render_param {clipId, prompt:'boom-bap drum loop, <style>'} → render_layer {clipId, wait:true} → accept_render {clipId} → remove_clip the host tone. " +
      "Bass + chords = create 2 tracks, load_builtin {type:'4osc'} on each, add_midi_clip on each (READ each returned clipId), then add_note {clipId, pitch, start, length} " +
      "MANY times to actually play a bassline and chords IN KEY (an empty MIDI clip is SILENT — you MUST add notes). Balance volumes.",
  },
  {
    id: "R3-hybrid-sampled-gentexture",
    label: "Hybrid — sampled core + generated texture",
    usesSA3: true,
    directive:
      "HYBRID (SAMPLED drums + PLAYED keys + generated texture). Drums: list_samples {category:'kick'} (and 'snare','hat') — then for the chosen samples, call " +
      "import_clip {trackId, file:'<the EXACT file path from list_samples>', startSeconds} REPEATEDLY to lay a full 2-bar pattern (kick on each beat, snare on 2 & 4, " +
      "hats between; startSeconds = beatIndex × 60/bpm). You MUST actually call import_clip — listing is not enough. Keys/bass: load_builtin {type:'4osc'}, add_midi_clip " +
      "(read clipId), add_note several times IN KEY. ONE generative texture: create_track → add_test_tone_clip → create_render_layer → set_render_param prompt 'warm vinyl " +
      "ambience' → render_layer wait → accept_render → remove the host tone. Balance volumes.",
  },
  {
    id: "R4-fully-agentic",
    label: "Fully agentic — in the box",
    usesSA3: false,
    directive:
      "FULLY AGENTIC (no generation). Drums: list_samples {category:'kick'} / 'snare' / 'hat' / 'perc', then import_clip {trackId, file:'<EXACT file path>', startSeconds} " +
      "REPEATEDLY to lay a FULL 2-bar pattern — kick on every beat, snare on 2 & 4, hats on the off-beats (startSeconds = beatIndex × 60/bpm), re-importing the same kick at " +
      "each kick position. LISTING IS NOT ENOUGH — you must call import_clip for every hit, no silent gaps. Bass + Rhodes chords: load_builtin {type:'4osc'}, add_midi_clip " +
      "(read clipId), add_note MANY times IN KEY (empty clips are silent). FX: load_builtin {type:'reverb'} / 'compressor'. Mix with set_track_volume/set_track_pan, no " +
      "clipping. Do NOT use create_render_layer.",
  },
];

const PROTOCOL = [
  "You are Moshi, an autonomous music producer driving a real DAW to fulfil a brief.",
  "Work in steps. On each turn reply with ONE JSON object and NOTHING else:",
  '{ "commands": [ { "command": string, "args": object } ], "note": string (<=14 words), "done": boolean }',
  "RULES — follow exactly:",
  "- ID DISCIPLINE: use the EXACT ids shown under 'Session now' and echoed in results (e.g. `ok (clipId=1012)`). After you create a track/clip/layer its id appears in BOTH the result and the snapshot — reuse it. NEVER invent or guess an id, and never reuse a stale one.",
  "- Emit 2-4 commands per turn, then read the results + fresh snapshot before continuing. Do not re-send a command that already succeeded.",
  "- DRUMS = REAL SAMPLES, NEVER A SYNTH: call list_samples for kick AND snare AND hat (category:'kick' / 'snare' / 'hat'), then import_clip {trackId, file:'<exact path>', startSeconds} for EACH hit. You MUST include a SNARE (on beats 2 & 4) and HI-HATS (on the off-beats) — the snare + hats are the broadband sounds that make it READ as a beat; kicks/808s alone sound tonal. Listing without importing produces NO drums.",
  "- A FRESH 4osc SYNTH IS A BARE SINE: after load_builtin {type:'4osc'} you MUST call set_4osc_patch {trackId, patch} BEFORE adding notes — 'sub_bass' for bass, 'warm_keys'/'soft_pad' for chords/keys, 'pluck'/'saw_lead' for leads. (4osc is for bass/keys/leads only — NEVER drums.)",
  "- FILL THE LOOP: make ~8 seconds of CONTINUOUS music — no long silent gaps. Place a drum hit on every beat/off-beat across ~2 bars (startSeconds = beatIndex × 60/bpm), re-importing the sample at each position.",
  "- MIX — DRUMS ON TOP, with HEADROOM (never clip): the DRUMS are the loudest element and the sub/synth must not drown them — set_track_volume drums≈-4 dB, bass≈-11 dB, chords/keys≈-14 dB, pads/textures≈-17 dB, and set_master_volume to -4 dB for headroom. Keep sub-bass restrained. Pan for space.",
  "- " + promptGuidance().replace(/\n/g, "\n  "),
  "- Use ONLY the commands below. Set done=true only when the loop fully realises the brief AND is mixed.",
].join("\n");

/** Compose the full system prompt for a rung from the live session context. */
export function buildSystemPrompt(
  rung: Rung,
  ctx: { builtins?: string[]; plugins?: string[]; bpm: number; key?: string },
): string {
  const lines = [
    PROTOCOL,
    "",
    `BRIEF TEMPO: ${ctx.bpm} BPM${ctx.key ? ` · KEY: ${ctx.key}` : ""} (one beat = ${(60 / ctx.bpm).toFixed(3)} s).`,
    `PRODUCTION STRATEGY — ${rung.label}: ${rung.directive}`,
    "",
    "Commands you may use (a trailing ? marks an optional arg):",
    commandCatalogPrompt(),
  ];
  if (ctx.builtins?.length) lines.push("", `Built-in instruments/effects (exact load_builtin types): ${ctx.builtins.join(", ")}`);
  if (ctx.plugins?.length) lines.push(`Installed plugins (exact load_plugin names): ${ctx.plugins.slice(0, 30).join(", ")}`);
  return lines.join("\n");
}
