import type { Snapshot } from "./types";

// Optional AI tools (docs/AI-TOOLS-OPTIONAL-BRIEF-2026-11-02.md). Mosh records and mixes
// without them; the generative extras need a local Python service, and Re-Imagine and LoRA
// training also need the Stable Audio 3 setup that Mosh never installs for anyone.
//
// Native reports `snapshot.aiTools` from file checks alone (src/generative/AiTools.h). A
// snapshot WITHOUT the field comes from a build older than this gate (or a fixture), so
// everything stays available — exactly the behaviour before the gate existed.

export interface AiToolsView {
  /** Python and Beatbox → beat are installed: the opt-in pack is on. */
  on: boolean;
  /** Audio → MIDI / words transcription is installed (only the agent reaches it). */
  transcribe: boolean;
  /** Stable Audio 3 is set up on this Mac: Re-Imagine and LoRA training. */
  sa3: boolean;
}

const ALL_AVAILABLE: AiToolsView = { on: true, transcribe: true, sa3: true };

export function aiToolsOf(snapshot: Snapshot | null | undefined): AiToolsView {
  const t = snapshot?.aiTools;
  if (!t) return ALL_AVAILABLE;
  return { on: t.state === "on", transcribe: t.pack?.transcribe === "ok", sa3: t.sa3 === true };
}

/** What Moshi says when a request needs a tool this Mac doesn't have. */
export const AI_TOOLS_NEEDED = "That needs AI tools, which aren't installed on this Mac. Recording and mixing work without them.";
export const SA3_NEEDED = "Re-Imagine needs the Stable Audio 3 setup, which isn't on this Mac.";

// Agent catalog entries that reach the generative service, grouped by what they need.
// The brain never sees a command this Mac can't run (and native refuses it anyway).
const NEEDS_PACK = [
  "sketch_beatbox", "generate_beat_recipe",
  "get_rhymes", "complete_lyrics", "fill_lyric_gap", "suggest_next_line", "regenerate_lyric",
  "analyze_lyrics",
] as const;
const NEEDS_TRANSCRIBE = ["transcribe_clip", "build_skeleton_from_clip"] as const;
const NEEDS_SA3 = [
  "create_render_layer", "set_render_param", "render_layer", "cancel_render", "compile_render",
  "accept_render", "reject_render", "reset_render_layer", "bypass_layer", "freeze_layer",
  "unfreeze_layer", "bounce_layer_to_clip", "remove_render_layer",
] as const;

/** Agent commands to leave out of the brain's catalog on this Mac. Empty when every tool
 *  is present — and always empty for a snapshot without `aiTools`, so prompts built for
 *  datasets and benches stay byte-identical. */
export function unavailableAgentCommands(snapshot: Snapshot | null | undefined): ReadonlySet<string> {
  const t = aiToolsOf(snapshot);
  const out = new Set<string>();
  if (!t.on) NEEDS_PACK.forEach((c) => out.add(c));
  if (!t.on || !t.transcribe) NEEDS_TRANSCRIBE.forEach((c) => out.add(c));
  if (!t.sa3) NEEDS_SA3.forEach((c) => out.add(c));
  return out;
}

/** The refusal for one command, or null when this Mac can run it. */
export function aiToolsRefusal(snapshot: Snapshot | null | undefined, command: string): string | null {
  if (!unavailableAgentCommands(snapshot).has(command)) return null;
  return (NEEDS_SA3 as readonly string[]).includes(command) ? SA3_NEEDED : AI_TOOLS_NEEDED;
}
