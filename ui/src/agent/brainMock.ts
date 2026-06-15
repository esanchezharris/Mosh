// Demo mock-brain — a tiny heuristic that maps a few phrases to real commands so
// the whole loop (talk → edits → Monster changes → undo) is demoable in the preview
// BEFORE any LLM keys are configured. Once ui/.env.local has a key, the real brain
// takes over and this is never called. Deliberately small — not a parser, a stub.

import type { Snapshot } from "../types";
import type { BrainReply } from "./brain";
import type { AgentCommandCall } from "./executor";

const NAMES = "drums?|bass|vocals?|synth|lead|chords?|guitar|keys|piano|track";

function findTrack(snap: Snapshot | null, name: string) {
  const n = name.toLowerCase().replace(/s$/, "");
  return snap?.tracks?.find((t) => t.name.toLowerCase().includes(n));
}

export function mockBrainReply(text: string, snap: Snapshot | null): BrainReply {
  const t = text.toLowerCase();
  const cmds: AgentCommandCall[] = [];

  // make / add a track
  const mk = t.match(new RegExp(`\\b(?:make|add|create|new|give me)\\b[^.]*?\\b(${NAMES})\\b`));
  if (mk) {
    const w = mk[1];
    const name = w === "track" ? "Audio" : w.charAt(0).toUpperCase() + w.slice(1).replace(/s$/, "");
    cmds.push({ command: "create_track", args: { name } });
    return { intent: "ACK_GOT_IT", say: `${name}, coming up`, commands: cmds };
  }

  // tempo
  const bpm = t.match(/tempo[^0-9]*([0-9]{2,3})|\b([0-9]{2,3})\s*bpm/);
  if (bpm) {
    const v = Number(bpm[1] || bpm[2]);
    if (v >= 20 && v <= 300) { cmds.push({ command: "set_tempo", args: { bpm: v } }); return { intent: "ACK_GOT_IT", say: `${v} BPM`, commands: cmds }; }
  }

  // louder / quieter on a named track (or master)
  const lvl = t.match(new RegExp(`(louder|quieter|turn up|turn down|boost|pull down)[^.]*?\\b(${NAMES}|master)\\b|\\b(${NAMES}|master)\\b[^.]*?(louder|quieter|up|down)`));
  if (lvl) {
    const up = /louder|turn up|boost|up/.test(t);
    const who = (lvl[2] || lvl[3] || "").toLowerCase();
    if (who === "master") cmds.push({ command: "set_master_volume", args: { db: up ? 0 : -6 } });
    else { const tr = findTrack(snap, who); if (tr) cmds.push({ command: "set_track_volume", args: { trackId: tr.id, db: (tr.volumeDb ?? 0) + (up ? 3 : -3) } }); }
    if (cmds.length) return { intent: "ACK_GOT_IT", say: up ? "louder" : "softer", commands: cmds };
  }

  // mute / unmute
  const mu = t.match(new RegExp(`\\b(mute|unmute)\\b[^.]*?\\b(${NAMES})\\b`));
  if (mu) {
    const tr = findTrack(snap, mu[2]);
    if (tr) { const on = mu[1] === "mute"; cmds.push({ command: "set_track_mute", args: { trackId: tr.id, mute: on } }); return { intent: "ACK_GOT_IT", say: on ? "muted" : "back on", commands: cmds }; }
  }

  // metronome
  if (/metronome|click/.test(t)) {
    const on = !/off|stop|disable|no/.test(t);
    cmds.push({ command: "set_metronome", args: { enabled: on } });
    return { intent: "ACK_GOT_IT", say: on ? "click on" : "click off", commands: cmds };
  }

  return { intent: "HUH", say: "add my keys and I'll really think" };
}
