import { useEffect, useLayoutEffect, useRef } from "react";
import { useStore } from "../store";
import { useSettings } from "../settings/store";
import type { Snapshot } from "../types";
import { micLaneOf, resolveIds, songReady } from "./startFlow";
import { useStartMemory } from "./startMemory";
import { createRecordingSong, speakerGuard, startIO } from "./startSong";
import { speakerMutedNote, useSpeakerGuard } from "./useSpeakerGuard";
import { setupVocalLoop } from "./vocalSetup";

// The part of the friends-first setup that must keep working when the checklist is closed.
// Mounted with the V3 workspace for the whole app run; renders nothing.
//
//  - LAUNCH: with "Show this when Mosh opens" on, the checklist opens (unless it was
//    finished or closed before) and an EMPTY session becomes the recording template
//    (Beat, Lead vocal, Ad-libs). A session that already has tracks is never replaced.
//  - SPEAKERS: headphones pulled out mid-song turn Hear myself off before the mic howls.
//  - PHONE: a phone that is already paired when a new song opens gets its remote set up on
//    the new Lead vocal (with the Lead's chain on the Takes lane), so Record on the phone
//    never lands on a lane the rapper hears dry.

// The launch decision is made ONCE per app run (not per shell mount), so switching shells
// and back never makes a second song.
let launchDecided = false;
/** Test hook: forget the launch decision. */
export function __resetLaunchForTests() { launchDecided = false; }

export function RecordingSetup({ snapshot }: { snapshot: Snapshot }) {
  const projectEpoch = useStore((s) => s.projectEpoch);
  const transitioning = useStore((s) => s.projectTransitioning);
  const remembered = useStartMemory((s) => s.ids);
  const epoch = useStartMemory((s) => s.epoch);
  const settingUp = useStartMemory((s) => s.settingUp);
  const open = useStartMemory((s) => s.open);

  // Before paint, so the checklist never pops in a frame after the workspace. Settings
  // hydrate in main.tsx before the first render.
  useLayoutEffect(() => {
    if (launchDecided) return;
    launchDecided = true;
    const state = useStore.getState();
    if (useSettings.getState().get("startOnLaunch") !== true) return;
    useStartMemory.getState().openAtLaunch();
    if ((state.snapshot?.tracks.length ?? 0) > 0 || state.mp.active) return;
    void createRecordingSong();
  }, []);

  // Someone else replaced the project (⌘N, Open, a multiplayer join): the remembered
  // tracks belonged to the old song.
  useEffect(() => {
    if (epoch === null || settingUp || transitioning) return;
    if (projectEpoch !== epoch) useStartMemory.getState().reset();
  }, [projectEpoch, epoch, settingUp, transitioning]);

  // The guard only speaks for a song this setup knows: the template's tracks, the phone
  // remote's pair, or whatever the open checklist is showing. A producer's own session with
  // the checklist closed is left alone.
  const known = !!remembered.leadTrackId || !!snapshot.loop?.engaged || open;
  const ids = resolveIds(snapshot, remembered);
  const lane = known ? micLaneOf(snapshot, ids) : undefined;
  const hearingMyself = lane ? lane.armed === true && lane.monitor !== "off" : false;
  const { markOverride } = useSpeakerGuard({
    outputDevice: snapshot.audio?.outputDevice ?? "",
    hearingMyself,
    takesTrackId: lane?.id,
    pendingMonitor: false,
    turnOff: (id) => startIO.setMonitor(id, "off"),
    onMuted: (device) => useStartMemory.getState().setNote(speakerMutedNote(device)),
  });
  speakerGuard.markOverride = markOverride;

  const preparedFor = useRef<string | null>(null);
  const phoneConnected = snapshot.loop?.phoneConnected === true;
  const recording = !!snapshot.transport?.recording;
  useEffect(() => {
    const leadId = remembered.leadTrackId;
    if (!phoneConnected || !leadId || settingUp || transitioning || recording) return;
    const snap = useStore.getState().snapshot;
    if (!snap || songReady(snap, resolveIds(snap, remembered))) return;
    const key = `${projectEpoch}:${leadId}`;
    if (preparedFor.current === key) return;   // once per song: never fight an Undo of it
    preparedFor.current = key;
    void setupVocalLoop(startIO, leadId, snap);
  }, [phoneConnected, remembered, settingUp, transitioning, recording, projectEpoch]);

  return null;
}
