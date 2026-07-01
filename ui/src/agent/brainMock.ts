// Demo mock-brain — a tiny heuristic that maps a few phrases to real commands so
// the whole loop (talk → edits → Monster changes → undo) is demoable in the preview
// BEFORE any LLM keys are configured. Once ui/.env.local has a key, the real brain
// takes over and this is never called. Deliberately small — not a parser, a stub.

import type { Snapshot } from "../types";
import type { BrainReply } from "./brain";
import type { AgentCommandCall } from "./executor";

const NAMES = "drums?|bass|vocals?|synth|lead|chords?|guitar|keys|piano|track";
const BEAT_MOODS = ["dark", "emotional", "aggressive", "melodic", "sad", "hard"];

function findTrack(snap: Snapshot | null, name: string) {
  const n = name.toLowerCase().replace(/s$/, "");
  return snap?.tracks?.find((t) => t.name.toLowerCase().includes(n));
}

function extractTempo(t: string): number | undefined {
  const m = t.match(/tempo[^0-9]*([0-9]{2,3})|\b([0-9]{2,3})\s*bpm/);
  if (!m) return undefined;
  const v = Number(m[1] || m[2]);
  return v >= 20 && v <= 300 ? v : undefined;
}

function extractKey(t: string): string | undefined {
  const m = t.match(/\b([a-g])\s*(#|sharp|b|flat)?\s+(major|minor)\b/);
  if (!m) return undefined;
  const accidental = m[2] === "sharp" ? "#" : m[2] === "flat" ? "b" : m[2] ?? "";
  return `${m[1].toUpperCase()}${accidental} ${m[3]}`;
}

function extractMood(t: string): string | undefined {
  return BEAT_MOODS.find((mood) => t.includes(mood));
}

function isBeatRequest(t: string): boolean {
  if (/\bbeatbox\b/.test(t)) return false;
  return /\b(make|add|create|new|give me|generate|start|build|cook up|write)\b/.test(t)
    && /\b(beat|beats|trap|drill|instrumental|loop)\b/.test(t);
}

function beatArgs(t: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const mood = extractMood(t);
  const tempo = extractTempo(t);
  const key = extractKey(t);
  const seed = t.match(/\bseed\s+([0-9]+)\b/);
  if (mood) args.mood = mood;
  if (tempo !== undefined) args.tempo = tempo;
  if (key) args.key = key;
  if (seed) args.seed = Number(seed[1]);
  if (/\b(with|add|include)\s+(a\s+)?lead\b/.test(t)) args.lead = true;
  return args;
}

export function mockBrainReply(text: string, snap: Snapshot | null): BrainReply {
  const t = text.toLowerCase();
  const cmds: AgentCommandCall[] = [];

  if (isBeatRequest(t)) {
    cmds.push({ command: "generate_beat_recipe", args: beatArgs(t) });
    return { intent: "ACK_GOT_IT", say: "beat coming up", commands: cmds };
  }

  // make / add a track
  const mk = t.match(new RegExp(`\\b(?:make|add|create|new|give me)\\b[^.]*?\\b(${NAMES})\\b`));
  if (mk) {
    const w = mk[1];
    const name = w === "track" ? "Audio" : w.charAt(0).toUpperCase() + w.slice(1).replace(/s$/, "");
    cmds.push({ command: "create_track", args: { name } });
    return { intent: "ACK_GOT_IT", say: `${name}, coming up`, commands: cmds };
  }

  // tempo
  const tempo = extractTempo(t);
  if (tempo !== undefined) {
    cmds.push({ command: "set_tempo", args: { bpm: tempo } });
    return { intent: "ACK_GOT_IT", say: `${tempo} BPM`, commands: cmds };
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
