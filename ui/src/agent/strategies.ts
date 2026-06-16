// The production-approach spectrum for the arena: same brief, same real DAW + real
// command seam — only the STRATEGY the agent follows changes, from fully-generative
// (text-to-audio stems) to fully-agentic (samples + MIDI + FX, no generation).
// Pure module (no bridge/store) so the arena harness and tests can both use it.
import { commandCatalogPrompt } from "./commands";

export type Rung = {
  id: string;
  label: string;
  usesSA3: boolean; // generative rungs need the SA3 service (Fake in stage 1, real in stage 2)
  directive: string;
};

export const RUNGS: Rung[] = [
  {
    id: "R0-generative-single",
    label: "Pure generative — one render",
    usesSA3: true,
    directive:
      "PURE GENERATIVE (single render). Produce the ENTIRE brief as ONE ~8s generative audio render. " +
      "Steps: create_track; add_test_tone_clip on it (a placeholder the generator replaces); create_render_layer on that clip; " +
      "set_render_param with a vivid `prompt` describing the WHOLE brief (do NOT set `nl` — leaving it unset means text-to-audio from scratch); " +
      "render_layer with wait=true; accept_render. Then set a sensible track/master volume. Do not program MIDI or import samples.",
  },
  {
    id: "R1-generative-stems",
    label: "Generative stems",
    usesSA3: true,
    directive:
      "GENERATIVE STEMS. Split the brief into 2-3 stems (e.g. drums, bass, melody/chords). For EACH stem: create_track; add_test_tone_clip host; " +
      "create_render_layer; set_render_param with a `prompt` describing ONLY that stem (no `nl`); render_layer wait=true; accept_render. " +
      "Then balance the stems with set_track_volume so nothing clips. No MIDI, no samples.",
  },
  {
    id: "R2-hybrid-gendrums-midi",
    label: "Hybrid — generated drums + played instruments",
    usesSA3: true,
    directive:
      "HYBRID (generated drums + played instruments). Drums = ONE generative render (create_track → add_test_tone_clip → create_render_layer → " +
      "set_render_param prompt 'drums only, <style>' → render_layer wait=true → accept_render). Bass & melody = create tracks, load_builtin a synth " +
      "instrument (use an EXACT type from the available built-ins), add_midi_clip, and add_note to play a bassline and chords/melody in the brief's key. Balance volumes.",
  },
  {
    id: "R3-hybrid-sampled-gentexture",
    label: "Hybrid — sampled core + generated texture",
    usesSA3: true,
    directive:
      "HYBRID (sampled + played core, generated texture). Drums = use list_samples to find kick/snare/hat one-shots, then import_clip them onto a track at the " +
      "right beat positions (compute startSeconds from the bpm: one beat = 60/bpm seconds) to build a pattern of several hits. Bass/melody = load_builtin a synth, " +
      "add_midi_clip + add_note in the key. Add ONE generative texture/atmosphere layer (host clip → create_render_layer → render_layer wait=true → accept). " +
      "Optionally add a neural insert for tone. Balance volumes so nothing clips.",
  },
  {
    id: "R4-fully-agentic",
    label: "Fully agentic — in the box",
    usesSA3: false,
    directive:
      "FULLY AGENTIC (no generative audio at all). Build everything in the box. Drums = list_samples to pick kick/snare/hat/perc one-shots, then import_clip each " +
      "at computed beat positions (60/bpm seconds per beat) to lay a full pattern (many hits across a bar or two). Bass & melody/chords = load_builtin synth " +
      "instruments, add_midi_clip + add_note in the key. Add FX via load_builtin (e.g. reverb, compressor) into the chain. Mix with set_track_volume/set_track_pan so " +
      "it's balanced and never clips. Do NOT use create_render_layer or render_layer.",
  },
];

const PROTOCOL = [
  "You are Moshi, an autonomous music producer driving a real DAW to fulfil a brief.",
  "Work in steps. On each turn reply with ONE JSON object and NOTHING else:",
  '{ "commands": [ { "command": string, "args": object } ], "note": string (<=14 words), "done": boolean }',
  "- Emit a few commands per turn; you will see each result + a fresh session snapshot, then continue.",
  "- Use ONLY the commands below, with REAL ids from the snapshot. Never invent ids or commands.",
  "- Set done=true only when the track fully realises the brief and is mixed (balanced, not clipping).",
  "- Keep it to roughly 8 seconds of music (one short loop).",
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
