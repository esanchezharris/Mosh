// Ableton .als → MoshIR.
//
// ALS is gzipped XML. We gunzip, parse with fast-xml-parser, then tolerantly
// walk the tree (Ableton's schema is deep and version-specific): tempo from the
// first Tempo>Manual, tracks from LiveSet.Tracks.{Audio,Midi}Track with
// Name/Mixer (Volume→dB, Pan, Speaker→mute), and arrangement clips by
// CurrentStart/CurrentEnd (beats → seconds). Return/group tracks, devices,
// automation and MIDI notes are logged as unmappable (best-effort v1).

import { gunzipSync } from "node:zlib";
import { XMLParser } from "fast-xml-parser";
import { emptyIR, type ImportIR, type IRTrack, type IRClip, type IRNote } from "./moshIR";

/* eslint-disable @typescript-eslint/no-explicit-any */
type XmlNode = Record<string, any>;

const VAL = "@_Value";

function asArray(x: unknown): XmlNode[] {
  if (x == null) return [];
  return (Array.isArray(x) ? x : [x]) as XmlNode[];
}

// Collect every descendant stored under key `tag`.
function deepFind(node: unknown, tag: string, out: XmlNode[] = []): XmlNode[] {
  if (!node || typeof node !== "object") return out;
  for (const [k, v] of Object.entries(node as XmlNode)) {
    if (k === tag) for (const item of Array.isArray(v) ? v : [v]) out.push(item as XmlNode);
    if (Array.isArray(v)) for (const item of v) deepFind(item, tag, out);
    else if (v && typeof v === "object") deepFind(v, tag, out);
  }
  return out;
}

const manualVal = (n: XmlNode | undefined): string | undefined => n?.Manual?.[VAL];

function linToDb(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return -120;
  return Math.round(20 * Math.log10(v) * 100) / 100;
}
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// Ableton groups a MIDI clip's notes by pitch: Notes>KeyTracks>KeyTrack, each
// KeyTrack carrying a MidiKey (the pitch) and its MidiNoteEvents. Time/Duration
// are already in beats relative to the clip; Velocity is a float we round+clamp.
function notesFromMidiClip(clip: XmlNode): IRNote[] {
  const notes: IRNote[] = [];
  for (const kt of asArray(clip?.Notes?.KeyTracks?.KeyTrack)) {
    const pitch = Number(kt?.MidiKey?.[VAL]);
    if (!Number.isFinite(pitch)) continue;
    for (const ev of asArray(kt?.Notes?.MidiNoteEvent)) {
      const time = Number(ev?.["@_Time"]);
      const dur = Number(ev?.["@_Duration"]);
      if (!Number.isFinite(time) || !Number.isFinite(dur)) continue;
      const velocity = clamp(Math.round(Number(ev?.["@_Velocity"]) || 0), 1, 127);
      notes.push({ pitch, start: time, length: Math.max(0, dur), velocity });
    }
  }
  return notes;
}

// An AudioClip's sample lives in SampleRef>FileRef. Prefer the absolute Path; fall
// back to the project-relative RelativePath (emit resolves it against the project dir).
function sampleRefPath(clip: XmlNode): string | undefined {
  const fileRef = clip?.SampleRef?.FileRef;
  const abs = fileRef?.Path?.[VAL];
  const rel = fileRef?.RelativePath?.[VAL];
  if (typeof abs === "string" && abs.length) return abs;
  if (typeof rel === "string" && rel.length) return rel;
  return undefined;
}

function clipsFrom(track: XmlNode, tempo: number, ir: ImportIR, trackName: string): IRClip[] {
  const out: IRClip[] = [];
  const beatsToSec = (b: number) => (b * 60) / (tempo || 120);
  for (const [tag, kind] of [
    ["AudioClip", "wave"],
    ["MidiClip", "midi"],
  ] as const) {
    for (const clip of deepFind(track, tag)) {
      const cs = clip?.CurrentStart?.[VAL];
      const ce = clip?.CurrentEnd?.[VAL];
      if (cs == null || ce == null) continue; // not an arrangement clip
      const start = beatsToSec(Number(cs));
      const length = Math.max(0, beatsToSec(Number(ce) - Number(cs)));
      const name = clip?.Name?.[VAL];
      if (kind === "midi") {
        const notes = notesFromMidiClip(clip);
        out.push({ kind: "midi", name, start, length, notes });
        if (notes.length === 0) ir.unmappable.push(`ALS MIDI clip "${name ?? "?"}" on "${trackName}": no notes parsed`);
      } else {
        out.push({ kind: "wave", name, start, length, sourceFile: sampleRefPath(clip) });
      }
    }
  }
  return out;
}

export function parseAls(buf: Buffer | Uint8Array, source = "project.als"): ImportIR {
  const ir = emptyIR("als", source);

  let xml: string;
  try {
    xml = gunzipSync(buf).toString("utf8");
  } catch {
    xml = Buffer.from(buf).toString("utf8"); // already-plain XML (tests / pre-gunzipped)
  }

  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" }).parse(xml) as XmlNode;
  const ls = doc?.Ableton?.LiveSet;
  if (!ls) {
    ir.unmappable.push("not an Ableton LiveSet");
    return ir;
  }

  const tempo = deepFind(ls, "Tempo")
    .map(manualVal)
    .find((v) => v != null);
  if (tempo != null) ir.session.tempo = Number(tempo);
  const tempoVal = ir.session.tempo ?? 120;

  const tracksNode: XmlNode = ls.Tracks ?? {};
  for (const t of asArray(tracksNode.ReturnTrack)) ir.unmappable.push(`return track "${t?.Name?.EffectiveName?.[VAL] ?? "?"}" not imported (no agent send/return command)`);
  for (const t of asArray(tracksNode.GroupTrack)) ir.unmappable.push(`group track "${t?.Name?.EffectiveName?.[VAL] ?? "?"}" flattened (no agent group command)`);

  // audio + midi tracks, restored to document order via the @_Id attribute
  const trackId = (t: XmlNode): number => Number(t["@_Id"] ?? 0);
  const tagged = [
    ...asArray(tracksNode.AudioTrack).map((t) => ({ t, type: "audio" as const })),
    ...asArray(tracksNode.MidiTrack).map((t) => ({ t, type: "audio" as const })),
  ].sort((a, b) => trackId(a.t) - trackId(b.t));

  for (const { t, type } of tagged) {
    const name = t?.Name?.EffectiveName?.[VAL];
    const mixer: XmlNode | undefined = t?.DeviceChain?.Mixer;
    const track: IRTrack = { name: name || undefined, type, clips: [] };
    if (mixer) {
      const vol = manualVal(mixer.Volume);
      if (vol != null) track.volumeDb = linToDb(Number(vol));
      const pan = manualVal(mixer.Pan);
      if (pan != null) track.pan = clamp(Number(pan), -1, 1);
      const speaker = manualVal(mixer.Speaker);
      if (speaker != null) track.mute = speaker === "false"; // Speaker on = audible
    }
    track.clips = clipsFrom(t, tempoVal, ir, name ?? "?");
    ir.session.tracks.push(track);
  }

  return ir;
}
