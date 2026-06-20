// REAPER .rpp → MoshIR.
//
// RPP is plain text: nested `<TAG ...>` blocks with `TOKEN values` attribute
// lines, closed by a lone `>`. We parse it into a small block tree, then walk
// the tree pulling the fields that map to agent commands (TEMPO, TRACK
// NAME/VOLPAN/MUTESOLO, ITEM POSITION/LENGTH/NAME/SOURCE). Everything else (FX
// chains, envelopes, sends) is logged as unmappable.

import { emptyIR, type ImportIR, type IRTrack, type IRClip } from "./moshIR";

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
        const clip: IRClip = { kind: "midi", name: iname, start, length, notes: [] };
        track.clips.push(clip);
        ir.unmappable.push(`RPP MIDI item "${iname ?? "?"}": note extraction not implemented`);
      } else {
        track.clips.push({ kind: "wave", name: iname, start, length, sourceFile: src ? attr(src, "FILE")?.[0] : undefined });
      }
    }

    if (child(tn, "FXCHAIN")) ir.unmappable.push(`track "${name ?? "?"}": FX chain not imported (no agent plugin-by-name command)`);
    ir.session.tracks.push(track);
  }

  return ir;
}
