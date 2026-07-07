// Pure mapping: a pad button (given the current snapshot) -> the MoshOps command(s) to POST.
// Mirrors the proven native mapping in ios/MoshCompanion/.../CompanionStore.swift, plus the
// explicit RECORD start that the DAWN single-pad has and the native CAPTURE/JUDGMENT UI lacks.
// No Date/Math.random here — deterministic so vitest can assert exact payloads; the net layer
// stamps issuedAtPhoneMs.

import type { Button, Cmd, Snap } from "./types";

const SRC = "phone_controller";

export type Plan = { cmds: Cmd[]; blockedReason?: string };

/** The track we record onto: the take's track, else the first armed track, else the first track. */
export function targetTrackId(snap: Snap | null): string | undefined {
  const takeTrack = snap?.controller?.take?.trackId;
  if (takeTrack) return takeTrack;
  const tracks = snap?.tracks ?? [];
  const armed = tracks.find((t) => t.armed);
  if (armed) return armed.id;
  return tracks[0]?.id;
}

function isArmed(snap: Snap | null, trackId: string | undefined): boolean {
  if (!trackId) return false;
  return (snap?.tracks ?? []).some((t) => t.id === trackId && t.armed === true);
}

function recordCmds(snap: Snap | null): Cmd[] {
  const tid = targetTrackId(snap);
  const cmds: Cmd[] = [];
  if (tid && !isArmed(snap, tid))
    cmds.push({ command: "arm_track", args: { trackId: tid, armed: true, source: SRC } });
  cmds.push({ command: "set_transport", args: { action: "record", source: SRC } });
  return cmds;
}

/** Button -> command plan. `blockedReason` set (with empty cmds) when the button can't act yet. */
export function planFor(button: Button, snap: Snap | null): Plan {
  const take = snap?.controller?.take;
  const transport = snap?.transport;

  switch (button) {
    case "record": // PUT ME IN
      return { cmds: recordCmds(snap) };

    case "keep": // KEEP — commit the current take lane, discard the rest (native keep_take)
      if (!take?.exists || !take.clipId || take.canKeep === false)
        return { cmds: [], blockedReason: "no take to keep yet" };
      return {
        cmds: [{ command: "keep_take", args: { clipId: take.clipId, source: SRC, controllerLabel: "kept" } }],
      };

    case "again": // AGAIN — drop the last take, roll again (undo + re-record)
      return {
        cmds: [
          { command: "undo", args: { source: SRC, controllerLabel: "undone" } },
          ...recordCmds(snap),
        ],
      };

    case "hear": // HEAR IT — play from the take start (else the current playhead)
      return {
        cmds: [
          {
            command: "set_transport",
            args: { action: "play", position: take?.start ?? transport?.position ?? 0, source: SRC },
          },
        ],
      };

    case "stop": // STOP — stop the transport (lands the take if recording)
      return { cmds: [{ command: "set_transport", args: { action: "stop", source: SRC } }] };
  }
}

/** Navigator drag -> seek. */
export function seekPlan(positionSec: number): Plan {
  const pos = Number.isFinite(positionSec) && positionSec > 0 ? positionSec : 0;
  return { cmds: [{ command: "set_transport", args: { position: pos, source: SRC } }] };
}
