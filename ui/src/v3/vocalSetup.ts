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

// ── Switching the voice: Clean Lead ↔ Tuned Lead (the Start page's one-tap choice) ──────

/** The preset ids the bundled chains tag their stages with. */
export const VOCAL_PRESET_IDS = ["mosh.clean-lead", "mosh.tuned-lead"] as const;

/** Indices of every stage a bundled vocal preset put on `track`, highest first, so
 *  removing them one by one never shifts an index still to be removed. */
export function vocalPresetStageIndices(track: Track | undefined): number[] {
  return (track?.plugins ?? [])
    .filter((p) => !!p.preset && (VOCAL_PRESET_IDS as readonly string[]).includes(p.preset.id))
    .map((p) => p.index)
    .sort((a, b) => b - a);
}

export interface VoiceKey {
  /** An AutoTune Key label ("C", "C#/Db", …). */
  keyLabel: string;
  /** "Chromatic" keeps it loose: no key written anywhere. */
  scale: "Chromatic" | "Major" | "Minor";
}

const AUTOTUNE_KEY_LABELS = ["C", "C#/Db", "D", "D#/Eb", "E", "F", "F#/Gb", "G", "G#/Ab", "A", "A#/Bb", "B"];
const AUTOTUNE_SCALE_LABELS = ["Chromatic", "Major", "Minor"];

const norm = (index: number, count: number) => (count < 2 ? 0 : Math.min(count - 1, Math.max(0, index)) / (count - 1));

/** Replace whatever bundled vocal chain Lead and Takes carry with `to`, as ONE undo step:
 *  inside batch_begin/batch_end, every bundled-preset stage on each lane is removed
 *  (highest index first: this also clears a stacked or half-lost chain), the chosen preset
 *  is applied, and for Tuned Lead the AutoTune Key and Scale are set.
 *
 *  Failure rule: an ok:false inside the batch ends it and undoes it ONLY when something in
 *  it actually landed. A legacy batch is a lazy transaction, so undoing an empty one would
 *  revert the singer's PREVIOUS edit instead (the rule beats.ts dropChords follows).
 *
 *  `io.run` must refresh the snapshot after each ok command: the AutoTune stage's index is
 *  read back after it is applied. */
export async function switchVocalPreset(io: VocalSetupIO, opts: {
  leadId: string;
  takesId: string;
  to: "clean" | "tuned";
  key?: VoiceKey;
}): Promise<{ ok: boolean; error: string | null }> {
  const stem = opts.to === "tuned" ? TUNED_VOCAL_CHAIN : DEFAULT_VOCAL_CHAIN;
  const file = await findPresetFile(io, stem);
  if (!file) return { ok: false, error: `This build doesn't include ${trackPresetLabel(stem)}.` };

  const begun = await io.run("batch_begin", { name: opts.to === "tuned" ? "Tuned Lead" : "Clean Lead" });
  if (!begun?.ok) return { ok: false, error: "Moshi is in the middle of something. Try again in a moment." };

  let landed = false;
  const fail = async (error: string) => {
    await io.run("batch_end", {});
    if (landed) await io.run("undo", {});
    return { ok: false, error };
  };

  for (const laneId of [opts.leadId, opts.takesId]) {
    const lane = io.snapshot()?.tracks.find((t) => t.id === laneId);
    if (!lane) return fail("The vocal track went missing. Start the song again.");
    for (const index of vocalPresetStageIndices(lane)) {
      const removed = await io.run("remove_plugin", { trackId: laneId, index });
      if (!removed?.ok) return fail(removed?.error ?? "Couldn't remove the old vocal chain");
      landed = true;
    }
    const applied = await io.run("apply_track_preset", { trackId: laneId, file });
    if (!applied?.ok) return fail(applied?.error ?? "Couldn't add the vocal chain");
    landed = true;

    if (opts.to === "tuned") {
      // Tuned Lead without its AutoTune is not Tuned Lead (a build or project that drops the
      // type): refuse and roll back rather than announce a voice the singer won't hear.
      const tuner = io.snapshot()?.tracks.find((t) => t.id === laneId)?.plugins?.find((p) => p.type === "moshAutoTune");
      if (!tuner) return fail("The tuner didn't load. Try again.");
      if (!opts.key || opts.key.scale === "Chromatic") continue;
      const keyIdx = AUTOTUNE_KEY_LABELS.indexOf(opts.key.keyLabel);
      const scaleIdx = AUTOTUNE_SCALE_LABELS.indexOf(opts.key.scale);
      for (const [paramIndex, value] of [[0, norm(keyIdx, 12)], [1, norm(scaleIdx, 3)]] as const) {
        const set = await io.run("set_plugin_param", { trackId: laneId, index: tuner.index, paramIndex, value });
        if (!set?.ok) return fail(set?.error ?? "Couldn't set the key");
      }
    }
  }

  const ended = await io.run("batch_end", {});
  if (!ended?.ok) return { ok: false, error: ended?.error ?? "Couldn't finish switching the voice" };
  return { ok: true, error: null };
}
