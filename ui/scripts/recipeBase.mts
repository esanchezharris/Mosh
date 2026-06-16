// The controlled BASE arrangement for the in-the-box flywheel: a fixed, deterministic
// session built through the real `Engine.exec` seam, exposing the affordances each
// seeded technique card needs (a drum clip to fill, straight hats to swing, keys to
// humanize, an EQ to automate, a track to send). buildBase returns a BaseBindings table
// of the REAL ids it created, which bindRecipe substitutes into a card's $token slots.
// No generate_audio / SA3 — the ONLY variable a card introduces is its own commands.
import type { Engine } from "./agentEngine.mts";

export type BaseSpec = { baseId: string; tempo: number; key: string };

export type BaseBindings = {
  baseId: string;
  tempo: number;
  key: string;
  drumTrackId: string;
  drumClipId: string;            // an EMPTY midi clip the drum-pattern card fills
  hatsTrackId: string;
  hatsClipId: string;            // straight 8th hats for the swing card to swing
  keysTrackId: string;
  keysClipId: string;            // an arpeggio for the humanize card to jitter
  keysFilterPluginIndex: number; // the EQ on the keys chain (automation target)
  keysFilterParamIndex: number;  // a frequency-ish EQ param, resolved from the snapshot
};

async function ex(eng: Engine, command: string, args: Record<string, unknown>): Promise<any> {
  const r = await eng.exec(command, args);
  if (!r?.ok) throw new Error(`base build: ${command} failed — ${r?.error || "no error"}`);
  return r.data ?? {};
}

export async function buildBase(eng: Engine, spec: BaseSpec): Promise<BaseBindings> {
  await ex(eng, "set_tempo", { bpm: spec.tempo });
  const [tonic, mode] = spec.key.split(/\s+/);
  await ex(eng, "set_key", { tonic, mode: mode || "minor" });

  // Drums: a track + an EMPTY midi clip (notes:[] → no default arpeggio) for the pattern card.
  const drumTrackId = (await ex(eng, "create_track", { name: "Drums" })).trackId;
  const drumClipId = (await ex(eng, "add_midi_clip", { trackId: drumTrackId, notes: [] })).clipId;

  // Hats: straight 8th-note hats (pitch 42 at beats 0,0.5,…,3.5) for the swing card.
  const hatsTrackId = (await ex(eng, "create_track", { name: "Hats" })).trackId;
  const hatNotes = Array.from({ length: 8 }, (_, s) => ({ pitch: 42, start: s * 0.5, length: 0.25, velocity: 90 }));
  const hatsClipId = (await ex(eng, "add_midi_clip", { trackId: hatsTrackId, notes: hatNotes })).clipId;

  // Keys: a 4osc instrument + a 3-note arpeggio (distinct pitches, all starts > 0 so jitter
  // never clamps) for the humanize card, and a 4-band EQ for the automation card.
  const keysTrackId = (await ex(eng, "create_track", { name: "Keys" })).trackId;
  await ex(eng, "load_builtin", { trackId: keysTrackId, type: "4osc" });
  await ex(eng, "set_4osc_patch", { trackId: keysTrackId, patch: "warm_keys" });
  const keyArp = [
    { pitch: 57, start: 0.5, length: 1, velocity: 80 },
    { pitch: 60, start: 1.5, length: 1, velocity: 80 },
    { pitch: 64, start: 2.5, length: 1, velocity: 80 },
  ];
  const keysClipId = (await ex(eng, "add_midi_clip", { trackId: keysTrackId, notes: keyArp })).clipId;
  const keysFilterPluginIndex = (await ex(eng, "load_builtin", { trackId: keysTrackId, type: "4bandEq" })).index;

  // Resolve a frequency-ish EQ param index from the snapshot — never hardcode (the EQ's
  // param layout is the engine's, and automation needs the numeric index).
  const snap = await eng.snapshot();
  const keysTrack = (snap?.tracks || []).find((t: any) => t.id === keysTrackId);
  const eqPlugin = (keysTrack?.plugins || []).find((p: any) => p.index === keysFilterPluginIndex);
  const params: any[] = eqPlugin?.params || [];
  const freq = params.find((p) => /freq/i.test(p.name)) ?? params[0];
  if (!freq) throw new Error(`base build: keys EQ (index ${keysFilterPluginIndex}) exposes no automatable param`);

  return {
    baseId: spec.baseId, tempo: spec.tempo, key: spec.key,
    drumTrackId, drumClipId, hatsTrackId, hatsClipId,
    keysTrackId, keysClipId, keysFilterPluginIndex, keysFilterParamIndex: freq.index,
  };
}
