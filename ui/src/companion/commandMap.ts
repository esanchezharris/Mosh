// Pure mapping: a pad button (given the current snapshot) -> the MoshOps command(s) to POST.
// Mirrors the proven native mapping in ios/MoshCompanion/.../CompanionStore.swift, plus the
// explicit RECORD start that the DAWN single-pad has and the native CAPTURE/JUDGMENT UI lacks.
// No Date/Math.random here — deterministic so vitest can assert exact payloads; the net layer
// stamps issuedAtPhoneMs.

import type { Button, Cmd, ControllerTake, Snap } from "./types";

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

/**
 * Lead-in kept in front of the next punch, in seconds — the port of DAWN's
 * `buffer_zone` (see `KeepTake.lua`, which scoots the record cursor to
 * `playhead - buffer_zone` rather than exactly to the take end). 0 means the next
 * take starts flush against the one you just kept.
 */
export const LEAD_IN_SEC = 0;

/** End of the pending take, or undefined when the snapshot has no measurable take. */
function takeEndSec(take: ControllerTake | undefined): number | undefined {
  if (!take?.exists) return undefined;
  if (typeof take.start !== "number" || typeof take.length !== "number") return undefined;
  return take.start + take.length;
}

function seekCmd(position: number): Cmd {
  return { command: "set_transport", args: { position: Math.max(0, position), source: SRC } };
}

/** Button -> command plan. `blockedReason` set (with empty cmds) when the button can't act yet. */
export function planFor(button: Button, snap: Snap | null): Plan {
  const take = snap?.controller?.take;
  const transport = snap?.transport;

  switch (button) {
    case "record": // PUT ME IN
      return { cmds: recordCmds(snap) };

    case "keep": {
      // DAWN's KeepTake.lua does THREE things, and the last two are where the loop's
      // forward momentum actually comes from: it commits the take, scoots the record
      // cursor forward, and immediately punches back in. `keep_take` alone (which is
      // all this used to send) moves nothing — it only collapses stacked take lanes.
      if (!take?.exists || !take.clipId) return { cmds: [], blockedReason: "no take to keep yet" };

      const cmds: Cmd[] = [];
      // Only meaningful once lanes exist (i.e. you re-recorded over the same span).
      // A single pass has nothing to discard and the native command errors with
      // "no takes to keep", so sending it unconditionally would fail the whole plan.
      if (take.canKeep)
        cmds.push({ command: "keep_take", args: { clipId: take.clipId, source: SRC, controllerLabel: "kept" } });

      const end = takeEndSec(take);
      if (end !== undefined) cmds.push(seekCmd(end - LEAD_IN_SEC));
      cmds.push(...recordCmds(snap));
      return { cmds };
    }

    case "again": {
      // DAWN's RedoTake.lua deletes the take and re-records with an explicit
      // "do NOT change time selection" — it can get away with that because REAPER
      // leaves the edit cursor where recording STARTED. Mosh does the opposite: the
      // playhead ends up at the end of the take, so re-recording without seeking
      // back drops the retake a whole take-length late and leaves a silent hole
      // where the line should be. The seek is the port of REAPER's cursor behaviour,
      // not an embellishment.
      const cmds: Cmd[] = [{ command: "undo", args: { source: SRC, controllerLabel: "undone" } }];
      if (typeof take?.start === "number") cmds.push(seekCmd(take.start));
      cmds.push(...recordCmds(snap));
      return { cmds };
    }

    case "hear": // HEAR IT — play from the take start (else the current playhead)
      return {
        cmds: [
          {
            command: "set_transport",
            args: { action: "play", position: take?.start ?? transport?.position ?? 0, source: SRC },
          },
        ],
      };

    case "marker":
      return {
        cmds: [
          {
            command: "mark_take",
            args: {
              ...(take?.clipId ? { clipId: take.clipId } : {}),
              position: transport?.position ?? 0,
              source: SRC,
              controllerLabel: "flagged",
            },
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
