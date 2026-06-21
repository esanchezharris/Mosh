// MoshIR → agent-callable MoshOps command program.
//
// Only the agent-callable subset is emitted (Moshi can only call that subset).
// Engine-assigned ids aren't known until create time, so commands reference
// tracks/clips by LOGICAL refs ("$t0", "$c0_1") that the binder (bindReplay.ts)
// resolves at replay time — mirroring the native --run-script ${VAR} capture.
//
// Lossy by design where no agent command exists: there is no agent audio-import
// command, so wave clips become positioned test-tone placeholders (logged), and
// plugins/automation/sends carried by the IR's `unmappable` list pass through.

import type { ImportIR } from "./moshIR";

export type BoundCommand = {
  command: string;
  args: Record<string, unknown>;
  bind?: string; // logical id to capture from the result (trackId/clipId)
};

export type ImportProgram = {
  commands: BoundCommand[];
  unmappable: string[];
};

export function emitCommands(ir: ImportIR): ImportProgram {
  const commands: BoundCommand[] = [];
  const unmappable = [...ir.unmappable];
  const s = ir.session;

  if (s.tempo != null) commands.push({ command: "set_tempo", args: { bpm: s.tempo } });
  if (s.timeSig)
    commands.push({ command: "set_time_signature", args: { numerator: s.timeSig.numerator, denominator: s.timeSig.denominator } });
  if (s.key) commands.push({ command: "set_key", args: { tonic: s.key.tonic, mode: s.key.mode } });

  s.tracks.forEach((t, i) => {
    const tref = `t${i}`;
    commands.push({ command: "create_track", args: { name: t.name ?? `Track ${i + 1}`, type: t.type }, bind: tref });
    if (t.volumeDb != null) commands.push({ command: "set_track_volume", args: { trackId: `$${tref}`, db: t.volumeDb } });
    if (t.pan != null) commands.push({ command: "set_track_pan", args: { trackId: `$${tref}`, pan: t.pan } });
    if (t.mute) commands.push({ command: "set_track_mute", args: { trackId: `$${tref}`, mute: true } });
    if (t.solo) commands.push({ command: "set_track_solo", args: { trackId: `$${tref}`, solo: true } });

    t.clips.forEach((c, j) => {
      const cref = `c${i}_${j}`;
      if (c.kind === "midi") {
        commands.push({ command: "add_midi_clip", args: { trackId: `$${tref}`, start: c.start, length: c.length }, bind: cref });
        for (const n of c.notes ?? [])
          commands.push({
            command: "add_note",
            args: { clipId: `$${cref}`, pitch: n.pitch, start: n.start, length: n.length, velocity: n.velocity },
          });
      } else {
        // No agent audio-import command → positioned test-tone placeholder (content lost).
        commands.push({ command: "add_test_tone_clip", args: { trackId: `$${tref}`, start: c.start, seconds: c.length } });
        unmappable.push(`audio clip "${c.name ?? c.sourceFile ?? "?"}" → test-tone placeholder (no agent audio-import command)`);
      }
    });
  });

  return { commands, unmappable };
}
