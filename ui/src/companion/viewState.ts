import type { AbletonSnapshot } from "./abletonSchema";
import * as nav from "./navMath";
import { targetTrackId } from "./commandMap";
import type { ControllerStatus, ControllerView, TimelineRegion } from "./adapter";
import type { Snap } from "./types";

function abletonStatuses(snapshot: AbletonSnapshot, busy: boolean): readonly ControllerStatus[] {
  const statuses: ControllerStatus[] = [];
  if (snapshot.connection === "disconnected") statuses.push("disconnected");
  if (busy) statuses.push("busy");
  if (snapshot.blockedReason !== null || snapshot.ownershipUncertain) statuses.push("blocked");
  if (snapshot.transport === "recording") statuses.push("recording");
  if (snapshot.transport === "playing") statuses.push("playing");
  if (snapshot.pendingClip !== null) statuses.push("pending");
  if (statuses.length === 0) statuses.push("paused");
  return statuses;
}

export function abletonView(snapshot: AbletonSnapshot, busy: boolean): ControllerView {
  const clips = snapshot.pendingClip === null
    ? snapshot.archiveClips
    : [snapshot.pendingClip, ...snapshot.archiveClips];
  const regions: readonly TimelineRegion[] = clips.map((clip) => ({ start: clip.startBeats, end: clip.endBeats }));
  const ends = regions.map((region) => region.end);
  const boundaries = [snapshot.editMarkerBeats, snapshot.passStartBeats ?? 0, snapshot.savedStopBeats ?? 0, ...ends];
  const blocked = snapshot.blockedReason !== null || snapshot.ownershipUncertain;
  return {
    mode: "ableton",
    unit: "beats",
    revision: snapshot.revision,
    position: snapshot.editMarkerBeats,
    length: Math.max(1, ...boundaries),
    regions,
    statuses: abletonStatuses(snapshot, busy),
    seekEnabled: snapshot.connection === "connected" && snapshot.transport !== "recording" && !blocked,
    ...(snapshot.blockedReason === null ? {} : { blockedReason: snapshot.blockedReason }),
  };
}

export function moshView(snapshot: Snap): ControllerView {
  const trackId = targetTrackId(snapshot);
  const regions = nav.regionsForTrack(snapshot, trackId).map((region) => ({ start: region.s, end: region.e }));
  const statuses: ControllerStatus[] = [];
  if (snapshot.transport?.recording) statuses.push("recording");
  else if (snapshot.transport?.playing) statuses.push("playing");
  if (snapshot.controller?.take?.exists) statuses.push("pending");
  if (statuses.length === 0) statuses.push("paused");
  return {
    mode: "mosh",
    unit: "seconds",
    revision: 0,
    position: snapshot.transport?.position ?? 0,
    length: nav.songLength(snapshot),
    regions,
    statuses,
    seekEnabled: true,
    tempo: snapshot.session?.tempo ?? 120,
    timeSigNumerator: snapshot.session?.timeSigNumerator ?? 4,
  };
}

export function disconnectedView(mode: "mosh" | "ableton", reason: string): ControllerView {
  return {
    mode,
    unit: mode === "ableton" ? "beats" : "seconds",
    revision: 0,
    position: 0,
    length: 1,
    regions: [],
    statuses: ["disconnected"],
    seekEnabled: false,
    blockedReason: reason,
  };
}
