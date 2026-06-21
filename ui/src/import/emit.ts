// MoshIR → agent-callable MoshOps command program.
//
// Only the agent-callable subset is emitted (Moshi can only call that subset).
// Engine-assigned ids aren't known until create time, so commands reference
// tracks/clips by LOGICAL refs ("$t0", "$c0_1") that the binder (bindReplay.ts)
// resolves at replay time — mirroring the native --run-script ${VAR} capture.
//
// Lossy only where no agent command exists: a wave clip with a captured source
// path becomes a real positioned import_clip; one without a path falls back to a
// positioned test-tone placeholder (logged). import_clip models no trim (the
// engine imports the whole file), so a clip's `length` is not carried over.
// Plugins/automation/sends in the IR's `unmappable` list pass through.

import { dirname, isAbsolute, resolve } from "node:path";
import type { ImportIR } from "./moshIR";

export type BoundCommand = {
  command: string;
  args: Record<string, unknown>;
  bind?: string; // logical id to capture from the result (trackId/clipId)
};

// Resolve an audio clip's source path to something the engine can open: an
// absolute path passes through; a project-relative one (REAPER "Media/x.wav",
// Ableton RelativePath) resolves against the project file's directory. Format
// frontends that already produce absolute paths (the FLP carve) are unaffected.
// Projects authored on Windows carry backslash separators and drive-letter
// absolutes (e.g. "D:\\x.wav") — a foreign absolute path can't be relocated here,
// so it passes through; a relative one has its separators normalized first.
function resolveAudioPath(projectSource: string, sourceFile: string): string {
  if (/^[A-Za-z]:[\\/]/.test(sourceFile)) return sourceFile; // foreign Windows drive-letter absolute
  if (/^[\\/]{2}/.test(sourceFile)) return sourceFile; // foreign UNC path (\\server\share) — backslash form would be corrupted by normalize
  if (isAbsolute(sourceFile)) return sourceFile; // POSIX absolute
  return resolve(dirname(projectSource), sourceFile.replace(/\\/g, "/"));
}

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
      } else if (c.sourceFile) {
        // Real positioned audio import. import_clip honors startSeconds but not a
        // clip length (cmdImportClip imports the whole file, and `length` isn't in
        // the catalog), so c.length is intentionally dropped — the clip spans the
        // file. Trimmed-clip fidelity would need real trim support in cmdImportClip.
        commands.push({
          command: "import_clip",
          args: { trackId: `$${tref}`, file: resolveAudioPath(ir.source, c.sourceFile), startSeconds: c.start, name: c.name },
        });
      } else {
        // No source path captured → positioned test-tone placeholder (content lost, logged).
        commands.push({ command: "add_test_tone_clip", args: { trackId: `$${tref}`, start: c.start, seconds: c.length } });
        unmappable.push(`audio clip "${c.name ?? "?"}" → test-tone placeholder (no source path captured)`);
      }
    });
  });

  return { commands, unmappable };
}
