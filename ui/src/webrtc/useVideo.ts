// Collaborator video state (redesign shell). Owns ONE VideoRoom, wired to the live
// multiplayer relay: outbound signaling goes through the `mp_send_signal` command;
// inbound `webrtc_signal` events are routed in by the main store. Camera is OFF by
// default (privacy) — `toggleCamera` is the only thing that calls getUserMedia, and the
// track is stopped (light goes off) on toggle-off / teardown. UI-local; the media itself
// never crosses the command seam — only the opaque SDP/ICE handshake does.

import { create } from "zustand";
import { useStore } from "../store";
import { VideoRoom } from "./videoRoom";
import type { SignalMessage } from "./signal";

let room: VideoRoom | null = null;

function ensureRoom(): VideoRoom {
  if (room) return room;
  const selfId = useStore.getState().mp.selfPeer ?? "self";
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
  return room;
}

interface VideoState {
  cameraOn: boolean;
  localStream: MediaStream | null;
  remoteStreams: Record<string, MediaStream>; // peerId → their video
  toggleCamera: () => Promise<void>;
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

  onSignal: (from, payload) => ensureRoom().onSignal(from, payload),

  // Only spin up the room when there's something to do (we're sharing or a peer exists).
  syncPeers: (peerIds) => {
    if (room) room.syncPeers(peerIds);
    else if (get().cameraOn) ensureRoom().syncPeers(peerIds);
  },

  teardown: () => {
    get().localStream?.getTracks().forEach((t) => t.stop());
    room?.close();
    room = null;
    set({ cameraOn: false, localStream: null, remoteStreams: {} });
  },
}));
