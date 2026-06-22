// Collaborator video state (redesign shell). Owns ONE VideoRoom, wired to the live
// multiplayer relay: outbound signaling goes through the `mp_send_signal` command;
// inbound `webrtc_signal` events are routed in by the main store. Camera is OFF by
// default (privacy) — `toggleCamera` is the only user entry to getUserMedia, and the
// track is stopped (light goes off) on toggle-off / tab-hidden / teardown. UI-local; the
// media itself never crosses the command seam — only the opaque SDP/ICE handshake does.

import { create } from "zustand";
import { useStore } from "../store";
import { VideoRoom } from "./videoRoom";
import type { SignalMessage } from "./signal";

let room: VideoRoom | null = null;

function ensureRoom(): VideoRoom {
  const selfId = useStore.getState().mp.selfPeer ?? "self";
  if (room && room.selfId === selfId) return room;
  // selfId changed (the common case: previewing the camera before joining captures the
  // "self" placeholder, then the join assigns the real peer UUID). Politeness/glare hinge
  // on a stable self id matching what the peer addresses us by — rebuild with the real one.
  if (room) room.close();
  room = new VideoRoom(
    selfId,
    { send: (to, msg) => void useStore.getState().exec("mp_send_signal", { to, payload: msg }) },
    (peerId, stream) =>
      useVideo.setState((s) => {
        const remoteStreams = { ...s.remoteStreams };
        if (stream) remoteStreams[peerId] = stream;
        else delete remoteStreams[peerId];
        return { remoteStreams };
      }),
  );
  room.syncPeers(Object.keys(useStore.getState().peers));
  const ls = useVideo.getState().localStream;
  if (ls) room.setLocalStream(ls); // carry a live preview stream across the rebuild
  return room;
}

interface VideoState {
  cameraOn: boolean;
  localStream: MediaStream | null;
  remoteStreams: Record<string, MediaStream>; // peerId → their video
  toggleCamera: () => Promise<void>;
  setHidden: (hidden: boolean) => Promise<void>; // release the camera while the tab is hidden
  onSignal: (from: string, payload: SignalMessage) => void; // inbound, from the store
  syncPeers: (peerIds: string[]) => void; // presence changed
  teardown: () => void; // leaving the session / unmount
}

export const useVideo = create<VideoState>((set, get) => ({
  cameraOn: false,
  localStream: null,
  remoteStreams: {},

  toggleCamera: async () => {
    if (get().cameraOn) {
      get().localStream?.getTracks().forEach((t) => t.stop()); // turn the camera light OFF
      room?.setLocalStream(null);
      set({ cameraOn: false, localStream: null });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      ensureRoom().setLocalStream(stream);
      set({ cameraOn: true, localStream: stream });
    } catch {
      set({ cameraOn: false, localStream: null }); // permission denied / no camera — stay off
    }
  },

  // Defense-in-depth privacy (mirrors the mic in AgentComposer): stop the camera track
  // when the WebView is hidden so the hardware light goes off; re-acquire on return if the
  // user still had it on. cameraOn stays true while hidden so we know to restore.
  setHidden: async (hidden) => {
    const { cameraOn, localStream } = get();
    if (hidden) {
      if (!localStream) return;
      localStream.getTracks().forEach((t) => t.stop());
      room?.setLocalStream(null);
      set({ localStream: null });
    } else if (cameraOn && !localStream) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        ensureRoom().setLocalStream(stream);
        set({ localStream: stream });
      } catch {
        set({ cameraOn: false, localStream: null });
      }
    }
  },

  onSignal: (from, payload) => ensureRoom().onSignal(from, payload),

  // Only spin up the room when there's something to do (we're sharing or a room exists);
  // route through ensureRoom so a stale-selfId room is rebuilt on join.
  syncPeers: (peerIds) => {
    if (room || get().cameraOn) ensureRoom().syncPeers(peerIds);
  },

  teardown: () => {
    get().localStream?.getTracks().forEach((t) => t.stop());
    room?.close();
    room = null;
    set({ cameraOn: false, localStream: null, remoteStreams: {} });
  },
}));
