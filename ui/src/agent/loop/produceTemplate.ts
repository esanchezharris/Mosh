// W2.5 — the produce-lane PREFLIGHT: deterministic track/instrument/sound setup
// that runs ONCE, before the model ever sees the session, inside the task's undo
// transaction (runTask.ts, between createTaskExecutor and runAgentLoop). Nothing
// here is model-authored — every command is constructed from the ask's parsed
// tempo/key plus the seeded picks from drumPalette.ts, so the model's job shrinks
// to exactly what it's good at: writing NOTES onto a template that already has
// real sounds. This is the mechanism the design facts in the plan point at — the
// loop model never sees a command's result `data` (loopSeam.ts's StepCommandResult
// is {command, ok, error}), so anything the model must know structurally (which
// trackId is which, which preset loaded) has to be BUILT before the loop starts and
// then rendered into the system prompt (producePrompt.ts's renderProduceTemplate).
//
// Octave convention (verbatim from the plan, repeated in producePrompt.ts too):
// MDSL/MIDI is scientific pitch, C4 = 60. A palette-v2 one-shot's measured
// `rootNote` is the pitch it plays UNTRANSPOSED; assign_sample's melodic mode plays
// the file unrepitched AT `note`, so to make the reference 808 range (MIDI 62-70)
// reachable, the pad must be assigned at keyNote = rootNote + 36 (lab 808 root 24 ->
// keyNote 60; palette-v2 bass roots 17-34 -> keyNote 53-70) — see drumPalette.ts's
// `pickDrumPalette` for the actual math.

import { pickDrumPalette, pickSynthPresets, type DrumPadPick, type PaletteItem, type PresetItem, type PresetMenu, type SynthRole } from "./drumPalette";

export type ExecResult = { ok: boolean; error?: string; data?: unknown };
export type ProduceExec = (command: string, args?: Record<string, unknown>) => Promise<ExecResult>;

export type ProduceSynth = {
  readonly trackId: string;
  readonly role: SynthRole;
  /** Display name of the loaded preset (empty when the load failed). */
  readonly preset: string;
  readonly file: string;
  /** Set when load_plugin or load_preset failed after retries — the track still
   *  exists (renamed to just its role) but carries no real sound. */
  readonly presetError?: string;
};

/** Round 2 correction note 5 ("mix also isn't great") — the preflight's fixed
 *  gain map + master-bus dynamics, recorded here so a run's template.json is
 *  the honest record of what was actually asked for (not necessarily what
 *  stuck — a failed set_track_volume/load_master_builtin call is recorded but
 *  never aborts the preflight, same posture as a synth's presetError). */
export type ProduceMix = {
  /** trackId -> the dB requested via set_track_volume, keyed by the SAME role
   *  labels as `roles` below ("drums", "808", plus the 7 SynthRole names). */
  readonly gainsDb: Readonly<Record<string, number>>;
  /** MIDI note -> the dB requested via set_drum_pad's gainDb (a subset of
   *  DEFAULT_DRUM_LANES's own gainDb entries — recorded here too so a run's
   *  mix is readable from template.json alone, without cross-referencing
   *  drumPalette.ts's lane table). */
  readonly padGainsDb: Readonly<Record<number, number>>;
  /** load_master_builtin's type vocabulary (MoshOpsInternal.h's kBuiltins) has
   *  no "limiter" entry today — this always tries it first anyway (so the
   *  mix upgrades for free the day one ships) and falls back to "compressor". */
  readonly master: { readonly requested: "limiter"; readonly loaded: "limiter" | "compressor" | null; readonly error?: string };
};

export type ProduceTemplate = {
  readonly bpm: number;
  readonly key: { readonly tonic: string; readonly mode: string };
  readonly seed: number;
  readonly drums: { readonly trackId: string; readonly pads: readonly DrumPadPick[] };
  readonly bass: { readonly trackId: string; readonly keyNote: number; readonly file: string };
  readonly synths: readonly ProduceSynth[];
  readonly mix: ProduceMix;
  readonly constants: { readonly eightBarsSeconds: number };
};

export type ProduceTemplateDeps = {
  exec: ProduceExec;
  /** Unused by the deterministic preflight itself today (kept for signature
   *  symmetry with AgentEnv/TaskExecDeps and for a future idempotency check). */
  getSnapshot?: () => Promise<unknown>;
  /** Test seam: inject the palette directly, skipping list_palette entirely. */
  palette?: readonly PaletteItem[];
  /** Production seam: `() => exec("list_palette", {}).then(r => r.data.items)`. */
  listPalette?: () => Promise<readonly PaletteItem[]>;
  /** Test seam: inject the Vital preset menu directly, skipping list_presets. */
  presets?: PresetMenu;
  seed?: number;
  /** Retry backoff for load_plugin/load_preset's "instance not available" — tests
   *  pass 0 so the retry path is provable without actually sleeping. */
  retryDelayMs?: number;
};

const VITAL_PLUGIN_ID = "Vital"; // PluginHost::findDescription matches `d.name == pluginId` CASE-SENSITIVELY (the catalog entry is name="Vital"); the mock lowercases. Was "vital" — every synth track failed with "unknown plugin" on the first live smoke. // matches bridge.mock.ts's catalog id and (case-
                                  // insensitively) native's PluginHost name lookup

const SECTION_A = { name: "A", startBeat: 0, endBeat: 16 };
const SECTION_B = { name: "B", startBeat: 16, endBeat: 32 };

// Round 2 correction note 5 ("mix also isn't great") — every Mosh render
// peaked at 0 dBFS while sitting 6-8dB quieter than the owner's reference; a
// fixed headroom map applied right after each track is created (not a
// creative choice the model gets to make) plus a master-bus glue stage.
const DRUMS_GAIN_DB = 0;
const BASS_GAIN_DB = 3;
const SYNTH_GAIN_DB: Record<SynthRole, number> = {
  chords_pad: -9,
  drone: -12,
  ambient: -12,
  lead: -6,
  counter: -8,
  stab: -6,
  arp: -10,
};

/** Exported so producePrompt.ts's renderProduceTemplate can name a synth track the
 *  SAME way the preflight itself named it — one label table, not two. */
export const SYNTH_ROLE_LABEL: Record<SynthRole, string> = {
  lead: "Lead",
  chords_pad: "Chords",
  drone: "Drone Pad",
  counter: "Sustained Counter",
  arp: "Arp",
  ambient: "Ambient Pad",
  stab: "Stabs",
};

// ── ask parsing (deliberately conservative — a miss falls back to the flywheel
// reference beat's tempo/key, never a guess pulled from an unrelated number) ────
const TEMPO_RE = /\b(?:at\s+)?(\d{2,3})\s*bpm\b/i;
const TEMPO_AT_RE = /\bat\s+(\d{2,3})\b/i;
const KEY_RE = /\b([A-G](?:#|b)?)\s*(major|minor|dorian|mixolydian|pentatonic|chromatic)\b/i;
const DEFAULT_BPM = 148;
const DEFAULT_KEY = { tonic: "D", mode: "minor" } as const;

export function parseTempo(ask: string): number {
  const m = ask.match(TEMPO_RE) ?? ask.match(TEMPO_AT_RE);
  const bpm = m ? parseInt(m[1]!, 10) : NaN;
  return Number.isFinite(bpm) && bpm >= 40 && bpm <= 300 ? bpm : DEFAULT_BPM;
}

export function parseKey(ask: string): { tonic: string; mode: string } {
  const m = ask.match(KEY_RE);
  if (!m) return { ...DEFAULT_KEY };
  const tonic = m[1]!;
  return { tonic: tonic[0]!.toUpperCase() + tonic.slice(1), mode: m[2]!.toLowerCase() };
}

async function withRetry(
  fn: () => Promise<ExecResult>,
  { tries = 3, delayMs = 500 }: { tries?: number; delayMs?: number } = {},
): Promise<ExecResult> {
  let last: ExecResult = { ok: false, error: "withRetry: fn never ran" };
  for (let attempt = 0; attempt < tries; attempt++) {
    last = await fn();
    if (last.ok || !/instance not available/i.test(last.error ?? "")) return last;
    if (attempt < tries - 1 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  return last;
}

/** Round 2 correction note 6 — `sub_energy_db` (the 30-120 Hz band-RMS field
 *  the manifest generators write onto "bass" items) is projected onto
 *  PaletteItem defensively: today's native list_palette (MoshOps.Plugins.cpp's
 *  cmdListPalette) doesn't forward it yet, so this accepts either casing
 *  (camelCase from a test/production seam that already normalized it, or the
 *  manifest's own snake_case) and simply omits the field when neither is a
 *  number — pickDrumPalette's fallback to the nearest-root rule handles that
 *  the same way it always has. */
function projectPaletteItem(raw: Record<string, unknown>): PaletteItem {
  const subEnergyDb = typeof raw.subEnergyDb === "number" ? raw.subEnergyDb
    : typeof raw.sub_energy_db === "number" ? raw.sub_energy_db : undefined;
  return {
    path: raw.path as string,
    role: raw.role as string,
    ...(typeof raw.rootNote === "number" ? { rootNote: raw.rootNote } : {}),
    ...(subEnergyDb !== undefined ? { subEnergyDb } : {}),
  };
}

async function resolvePalette(deps: ProduceTemplateDeps): Promise<readonly PaletteItem[]> {
  if (deps.palette) return deps.palette;
  if (deps.listPalette) return deps.listPalette();
  const r = await deps.exec("list_palette", {});
  const items = (r.data as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? [];
  return items.map(projectPaletteItem);
}

async function resolvePresets(deps: ProduceTemplateDeps): Promise<PresetMenu> {
  if (deps.presets) return deps.presets;
  const r = await deps.exec("list_presets", { plugin: "vital" });
  return (r.data as { presets?: PresetItem[] } | undefined)?.presets ?? [];
}

function trackIdOf(r: ExecResult): string {
  const id = (r.data as { trackId?: unknown } | undefined)?.trackId;
  if (typeof id !== "string" || !id) throw new Error("produceTemplate: create_track returned no trackId");
  return id;
}

/** Run the deterministic produce-lane preflight: tempo/key, two sections, the
 *  10-pad drum track, the sustained 808 track, and 7 Vital synth tracks — every
 *  track loaded with a REAL sound before the model writes a single note. Throws
 *  on a structural failure (no track id, no usable palette); a per-synth preset
 *  failure is recorded on that synth's `presetError` instead, since a beat with
 *  one thin track still beats no beat. */
export async function runProduceTemplate(ask: string, deps: ProduceTemplateDeps): Promise<ProduceTemplate> {
  const { exec, seed = 0, retryDelayMs = 500 } = deps;
  const bpm = parseTempo(ask);
  const key = parseKey(ask);

  const tempoRes = await exec("set_tempo", { bpm });
  if (!tempoRes.ok) throw new Error(`produceTemplate: set_tempo failed: ${tempoRes.error ?? "unknown"}`);
  const keyRes = await exec("set_key", { tonic: key.tonic, mode: key.mode });
  if (!keyRes.ok) throw new Error(`produceTemplate: set_key failed: ${keyRes.error ?? "unknown"}`);

  await exec("create_section", { name: SECTION_A.name, startBeat: SECTION_A.startBeat, endBeat: SECTION_A.endBeat });
  await exec("create_section", { name: SECTION_B.name, startBeat: SECTION_B.startBeat, endBeat: SECTION_B.endBeat });

  // ── drums: one track, 10 fixed pads (plan W2.3's Drum Rack decision) ─────────
  const palette = await resolvePalette(deps);
  const pick = pickDrumPalette(palette, { seed });

  const drumsTrackRes = await exec("create_track", { name: "Drums", type: "drum" });
  if (!drumsTrackRes.ok) throw new Error(`produceTemplate: create_track (drums) failed: ${drumsTrackRes.error ?? "unknown"}`);
  const drumsTrackId = trackIdOf(drumsTrackRes);
  // Gain map applied right after each track is created (round 2 note 5) —
  // best-effort, same posture as the pad gain/choke calls below: a mix level
  // that fails to apply must never abort a preflight that otherwise built a
  // whole beat.
  await exec("set_track_volume", { trackId: drumsTrackId, db: DRUMS_GAIN_DB });

  for (const pad of pick.pads) {
    await exec("assign_sample", { trackId: drumsTrackId, note: pad.note, file: pad.file, name: pad.name });
    // set_drum_pad only carries what assign_sample cannot express (chokeGroup) or
    // a layer-gain override — best-effort: a real kit always has a pad to target
    // here, but this must never abort the preflight over cosmetic gain/choke.
    if (pad.gainDb !== undefined || pad.chokeGroup !== undefined) {
      await exec("set_drum_pad", {
        trackId: drumsTrackId, note: pad.note,
        ...(pad.gainDb !== undefined ? { gainDb: pad.gainDb } : {}),
        ...(pad.chokeGroup !== undefined ? { chokeGroup: pad.chokeGroup } : {}),
      });
    }
  }
  // The stock drum-track default kit can seed a few GM pads (mid/hi tom-ish notes)
  // our 10-lane layout doesn't use; best-effort clear — a fresh/empty kit simply
  // has nothing there and clear_drum_pad errors, which is fine.
  for (const note of [45, 47, 49]) await exec("clear_drum_pad", { trackId: drumsTrackId, note });

  // ── the sustained 808 — its OWN track, melodic-mode sample assignment ────────
  const bassTrackRes = await exec("create_track", { name: "808" });
  if (!bassTrackRes.ok) throw new Error(`produceTemplate: create_track (808) failed: ${bassTrackRes.error ?? "unknown"}`);
  const bassTrackId = trackIdOf(bassTrackRes);
  await exec("assign_sample", {
    trackId: bassTrackId, note: pick.bass.keyNote, file: pick.bass.file, name: "808", mode: "melodic",
  });
  await exec("set_track_volume", { trackId: bassTrackId, db: BASS_GAIN_DB });

  // ── 7 Vital synth tracks — real sounds before the model ever gets a turn ────
  const presets = await resolvePresets(deps);
  const synthPicks = pickSynthPresets(presets, seed);
  const synths: ProduceSynth[] = [];
  for (const role of Object.keys(SYNTH_ROLE_LABEL) as SynthRole[]) {
    const label = SYNTH_ROLE_LABEL[role];
    const trackRes = await exec("create_track", { name: label });
    if (!trackRes.ok) throw new Error(`produceTemplate: create_track (${label}) failed: ${trackRes.error ?? "unknown"}`);
    const trackId = trackIdOf(trackRes);
    await exec("set_track_volume", { trackId, db: SYNTH_GAIN_DB[role] });

    const picked = synthPicks.find((p) => p.role === role);
    if (!picked) {
      synths.push({ trackId, role, preset: "", file: "", presetError: "no Vital preset available for this role" });
      continue;
    }

    const loadPlugin = await withRetry(
      () => exec("load_plugin", { trackId, pluginId: VITAL_PLUGIN_ID, replaceInstrument: true }),
      { delayMs: retryDelayMs },
    );
    if (!loadPlugin.ok) {
      synths.push({ trackId, role, preset: "", file: picked.file, presetError: loadPlugin.error ?? "load_plugin failed" });
      continue;
    }
    const loadPreset = await withRetry(
      () => exec("load_preset", { trackId, file: picked.file }),
      { delayMs: retryDelayMs },
    );
    if (!loadPreset.ok) {
      synths.push({ trackId, role, preset: "", file: picked.file, presetError: loadPreset.error ?? "load_preset failed" });
      continue;
    }
    await exec("rename_track", { trackId, name: `${label} · ${picked.name}` });
    synths.push({ trackId, role, preset: picked.name, file: picked.file });
  }

  // ── master-bus glue (round 2 note 5) — try "limiter" first (not in
  // MoshOpsInternal.h's kBuiltins today, so this always falls through to
  // "compressor" as of this writing, but costs nothing to keep trying: the
  // day a limiter type ships, this upgrades with no code change here). ──────
  const padGainsDb: Record<number, number> = {};
  for (const pad of pick.pads) if (pad.gainDb !== undefined) padGainsDb[pad.note] = pad.gainDb;
  const gainsDb: Record<string, number> = { drums: DRUMS_GAIN_DB, "808": BASS_GAIN_DB, ...SYNTH_GAIN_DB };

  let master: ProduceMix["master"];
  const limiterRes = await exec("load_master_builtin", { type: "limiter" });
  if (limiterRes.ok) {
    master = { requested: "limiter", loaded: "limiter" };
  } else {
    const compressorRes = await exec("load_master_builtin", { type: "compressor" });
    master = compressorRes.ok
      ? { requested: "limiter", loaded: "compressor" }
      : { requested: "limiter", loaded: null, error: compressorRes.error ?? limiterRes.error ?? "load_master_builtin failed" };
  }

  return {
    bpm,
    key,
    seed,
    drums: { trackId: drumsTrackId, pads: pick.pads },
    bass: { trackId: bassTrackId, keyNote: pick.bass.keyNote, file: pick.bass.file },
    synths,
    mix: { gainsDb, padGainsDb, master },
    constants: { eightBarsSeconds: (32 * 60) / bpm }, // 32 beats @ 4/4 = 8 bars
  };
}
