import type { CommandResult, Snapshot, Track } from "../types";
import { acceptsTrackPreset, trackPresetLabel } from "./MixInspector";

// The Booth's first-run defaults for a singer: one vocal chain, and no live mic into
// laptop speakers. Kept free of React so the rules are testable on their own.
//
// The Booth's setup button and the Start page run the SAME recipe (setupVocalLoop), so a
// friend who starts from either place ends up with the same Lead, Takes, chain and
// monitoring.

/** The track-chain preset a fresh Booth setup starts with (list_presets names file stems). */
export const DEFAULT_VOCAL_CHAIN = "mosh-clean-lead-v0";

/** The tuned alternative the Start page offers one tap away (Mosh AutoTune first). */
export const TUNED_VOCAL_CHAIN = "mosh-tuned-lead-v0";

/** True when the output is a loudspeaker the mic will hear ("MacBook Pro Speakers",
 *  "iMac Speakers", older macOS's "Built-in Output"). Live monitoring there feeds back. */
export function looksLikeSpeakers(outputDevice: string | null | undefined): boolean {
  const name = (outputDevice ?? "").trim();
  return /speakers?\b/i.test(name) || /^built-in output$/i.test(name);
}

/** Which of the loop's two tracks get the default chain: both, so what you hear while
 *  singing (through Takes) matches what a kept pass plays back with (on Lead). Never
 *  when the Lead already carries effects -- that is the producer's own chain, and a
 *  default must not sit on top of it -- and never on a track that already has any. */
export function defaultChainTargets(tracks: readonly Track[], leadId: string, takesId: string): Track[] {
  const lead = tracks.find((t) => t.id === leadId);
  if (!lead || (lead.plugins ?? []).length > 0) return [];
  const takes = tracks.find((t) => t.id === takesId);
  return [lead, takes].filter((t): t is Track =>
    t !== undefined && acceptsTrackPreset(t) && (t.plugins ?? []).length === 0);
}

/** How the recipe talks to the engine. `run` is for edits (the Booth's wrapper also shows
 *  each result's detail); `query` is for reads that must not touch that status line;
 *  `setMonitor` is the caller's own monitoring change, so the Booth keeps its
 *  pending-until-the-take-ends display. */
export interface VocalSetupIO {
  run: (command: string, args?: Record<string, unknown>) => Promise<CommandResult | null>;
  query: (command: string, args?: Record<string, unknown>) => Promise<CommandResult | null>;
  snapshot: () => Snapshot | null;
  setMonitor: (takesTrackId: string, mode: "off" | "automatic") => Promise<boolean>;
}

/** The bundled track-chain preset file for `name` (a file stem), or undefined when this
 *  build does not ship it. A failed listing reads as "not shipped": the caller's setup
 *  still stands without a chain. */
export async function findPresetFile(io: Pick<VocalSetupIO, "query">, name: string): Promise<string | undefined> {
  try {
    const listed = await io.query("list_presets", { plugin: "track-chain" });
    const presets = (listed?.data as { presets?: { name: string; file: string }[] } | undefined)?.presets ?? [];
    return presets.find((p) => p.name === name)?.file;
  } catch {
    return undefined;
  }
}

/** The default vocal chain for a fresh setup. Each preset application is its own undo
 *  step (apply_track_preset), so ⌘Z peels it off without touching the setup itself.
 *  Returns a line for the status note, or null when nothing was added. */
export async function addDefaultChain(io: VocalSetupIO, leadId: string, takesId: string,
  fallback: Snapshot): Promise<string | null> {
  const tracks = (io.snapshot() ?? fallback).tracks;
  const targets = defaultChainTargets(tracks, leadId, takesId);
  if (targets.length === 0) return null;
  const file = await findPresetFile(io, DEFAULT_VOCAL_CHAIN);
  if (!file) return null;   // a build without the bundled chain: the setup still stands
  for (const target of targets) {
    const applied = await io.run("apply_track_preset", { trackId: target.id, file });
    if (!applied?.ok) return `Vocal chain not added to ${target.name}: ${applied?.error ?? "apply_track_preset failed"}`;
  }
  return `Added the ${trackPresetLabel(DEFAULT_VOCAL_CHAIN)} vocal chain; change it in Mix`;
}

export interface VocalLoopSetup {
  /** loop_setup's own answer (null when the bridge threw). */
  setup: CommandResult | null;
  leadId: string;
  takesId: string | null;
  /** loop_setup's `armed` (the Takes lane took the input). False when the mic is denied or
   *  no input device opened; undefined from an engine that does not report it. */
  armed: boolean | undefined;
  /** Lines for the status note, in order. */
  notes: string[];
}

/** loop_setup on `leadId`, then the first-run defaults: Hear myself off when the Mac is on
 *  its speakers, and the default chain on Lead and Takes. Three kinds of command, each its
 *  own undo step, so a producer can peel back exactly what they don't want. */
export async function setupVocalLoop(io: VocalSetupIO, leadId: string, fallback: Snapshot): Promise<VocalLoopSetup> {
  const setup = await io.run("loop_setup", { trackId: leadId });
  const data = setup?.data as { takesTrackId?: unknown; armed?: unknown } | undefined;
  const takesId = typeof data?.takesTrackId === "string" && data.takesTrackId ? data.takesTrackId : null;
  const armed = typeof data?.armed === "boolean" ? data.armed : undefined;
  const notes: string[] = [];
  if (!setup?.ok || !takesId) return { setup, leadId, takesId, armed, notes };
  if (looksLikeSpeakers((io.snapshot() ?? fallback).audio?.outputDevice)
    && await io.setMonitor(takesId, "off")) {
    notes.push("Hear myself is off: plug in headphones first");
  }
  const chain = await addDefaultChain(io, leadId, takesId, fallback);
  if (chain) notes.push(chain);
  return { setup, leadId, takesId, armed, notes };
}

/** One monitoring change through `exec`, honest about its outcome: true when it applied or
 *  is pending until the take ends. For callers without the Booth's pending display. */
export async function setInputMonitor(
  exec: (command: string, args?: Record<string, unknown>) => Promise<CommandResult | null>,
  takesTrackId: string, mode: "off" | "automatic",
): Promise<{ ok: boolean; deferred: boolean; reason: string | null }> {
  const result = await exec("set_input_monitor", { trackId: takesTrackId, mode });
  const data = result?.ok ? result.data as { applied?: unknown; deferred?: unknown; reason?: unknown } | undefined : undefined;
  if (data?.deferred === true) return { ok: true, deferred: true, reason: null };
  if (data?.applied === false) {
    return { ok: false, deferred: false, reason: typeof data.reason === "string" && data.reason ? data.reason : "the engine did not apply it" };
  }
  return { ok: !!result?.ok, deferred: false, reason: result?.ok ? null : (result?.error ?? "set_input_monitor failed") };
}
