// REAPER .rpp → MoshIR.
//
// RPP is plain text: nested `<TAG ...>` blocks with `TOKEN values` attribute
// lines, closed by a lone `>`. We parse it into a small block tree, then walk
// the tree pulling the fields that map to agent commands (TEMPO, TRACK
// NAME/VOLPAN/MUTESOLO, ITEM POSITION/LENGTH/NAME/SOURCE). Everything else (FX
// chains, envelopes, sends) is logged as unmappable.

import { emptyIR, type ImportIR, type IRTrack, type IRNote } from "./moshIR";

type Attr = { token: string; vals: string[] };
type Node = { tag: string; head: string[]; attrs: Attr[]; children: Node[] };

// Split a line into tokens, honoring REAPER's "double", 'single' and `backtick`
// quoting (a quoted span may contain spaces).
function tokenize(line: string): string[] {
  const out: string[] = [];
  const s = line.trim();
  let i = 0;
  while (i < s.length) {
    while (i < s.length && s[i] === " ") i++;
    if (i >= s.length) break;
    const ch = s[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      let buf = "";
      while (j < s.length && s[j] !== ch) buf += s[j++];
      out.push(buf);
      i = j + 1;
    } else {
      let j = i;
      let buf = "";
      while (j < s.length && s[j] !== " ") buf += s[j++];
      out.push(buf);
      i = j;
    }
  }
  return out;
}

// Parse the block whose opener is at lines[cur.i]; consume through its `>`.
function parseBlock(lines: string[], cur: { i: number }): Node {
  const open = tokenize(lines[cur.i]);
  const node: Node = { tag: open[0].replace(/^</, ""), head: open.slice(1), attrs: [], children: [] };
  cur.i++;
  while (cur.i < lines.length) {
    const t = lines[cur.i].trim();
    if (t === ">") {
      cur.i++;
      break;
    }
    if (t.startsWith("<")) {
      node.children.push(parseBlock(lines, cur));
    } else {
      const toks = tokenize(lines[cur.i]);
      if (toks.length) node.attrs.push({ token: toks[0], vals: toks.slice(1) });
      cur.i++;
    }
  }
  return node;
}

const attr = (n: Node, token: string): string[] | undefined => n.attrs.find((a) => a.token === token)?.vals;
const child = (n: Node, tag: string): Node | undefined => n.children.find((c) => c.tag === tag);

function linToDb(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return -120;
  return Math.round(20 * Math.log10(v) * 100) / 100;
}
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// REAPER stores MIDI inside a <SOURCE MIDI> block as delta-PPQ event lines:
//   E/e <deltaTicks(dec)> <statusHex> <data1Hex> <data2Hex>
// `E` = unselected, `e` = selected — both are real events. The status high-nibble
// is 0x9 (note-on) or 0x8 (note-off); a note-on with velocity 0 is a note-off.
// Deltas are relative to the previous event, so we keep a running tick. PPQ comes
// from `HASDATA <flag> <ppq> QN` (default 960). Times convert ticks→beats; the
// emitter (emit.ts) turns each note into an add_note relative to the clip start.
function notesFromMidiSource(src: Node, ppq: number): IRNote[] {
  const notes: IRNote[] = [];
  const pending = new Map<number, { tick: number; velocity: number }[]>(); // pitch → FIFO of onsets
  let tick = 0;
  for (const a of src.attrs) {
    if (a.token !== "E" && a.token !== "e") continue; // only channel-voice events carry the delta clock we track
    const vals = a.vals;
    if (vals.length < 4) continue;
    tick += Number(vals[0]) || 0;
    const status = parseInt(vals[1], 16);
    const hi = status & 0xf0;
    if (hi !== 0x90 && hi !== 0x80) continue; // CC / pitch-bend / etc. — advance the clock, emit nothing
    const pitch = parseInt(vals[2], 16);
    const velocity = parseInt(vals[3], 16);
    const isOn = hi === 0x90 && velocity > 0;
    if (isOn) {
      const q = pending.get(pitch) ?? [];
      q.push({ tick, velocity });
      pending.set(pitch, q);
    } else {
      const q = pending.get(pitch);
      const on = q?.shift();
      if (on) notes.push({ pitch, start: on.tick / ppq, length: Math.max(0, (tick - on.tick) / ppq), velocity: on.velocity });
    }
  }
  return notes;
}

export function parseRpp(text: string, source = "project.rpp"): ImportIR {
  const ir = emptyIR("rpp", source);
  const lines = text.split(/\r?\n/);

  const cur = { i: 0 };
  while (cur.i < lines.length && !lines[cur.i].trim().startsWith("<REAPER_PROJECT")) cur.i++;
  if (cur.i >= lines.length) {
    ir.unmappable.push("not a REAPER project (no <REAPER_PROJECT>)");
    return ir;
  }
  const root = parseBlock(lines, cur);

  const tempo = attr(root, "TEMPO");
  if (tempo) {
    ir.session.tempo = Number(tempo[0]);
    if (tempo[1] && tempo[2]) ir.session.timeSig = { numerator: Number(tempo[1]), denominator: Number(tempo[2]) };
  }

  for (const tn of root.children.filter((c) => c.tag === "TRACK")) {
    const name = attr(tn, "NAME")?.[0];
    const track: IRTrack = { name: name || undefined, type: "audio", clips: [] };

    const volpan = attr(tn, "VOLPAN");
    if (volpan) {
      track.volumeDb = linToDb(Number(volpan[0]));
      track.pan = clamp(Number(volpan[1]), -1, 1);
    }
    const ms = attr(tn, "MUTESOLO");
    if (ms) {
      track.mute = Number(ms[0]) > 0;
      track.solo = Number(ms[1]) > 0;
    }

    for (const it of tn.children.filter((c) => c.tag === "ITEM")) {
      const start = Number(attr(it, "POSITION")?.[0] ?? 0);
      const length = Number(attr(it, "LENGTH")?.[0] ?? 0);
      const iname = attr(it, "NAME")?.[0];
      const src = child(it, "SOURCE");
      if (src?.head[0] === "MIDI") {
        const ppq = Number(attr(src, "HASDATA")?.[1]) || 960;
        const notes = notesFromMidiSource(src, ppq);
        track.clips.push({ kind: "midi", name: iname, start, length, notes });
        if (notes.length === 0) ir.unmappable.push(`RPP MIDI item "${iname ?? "?"}": no notes parsed`);
      } else {
        track.clips.push({ kind: "wave", name: iname, start, length, sourceFile: src ? attr(src, "FILE")?.[0] : undefined });
      }
    }

    if (child(tn, "FXCHAIN")) ir.unmappable.push(`track "${name ?? "?"}": FX chain not imported (no agent plugin-by-name command)`);
    ir.session.tracks.push(track);
  }

  return ir;
}
