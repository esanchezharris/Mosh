// WebRTC signaling — the small message vocabulary peers exchange to set up a direct
// video link, plus the transport abstraction. The transport is injected (the real one
// rides the multiplayer relay via the native bridge; tests use a loopback) so the room
// logic is fully unit-testable without a network or a browser RTC stack.

export type SignalMessage =
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string }
  | { kind: "ice"; candidate: RTCIceCandidateInit }
  | { kind: "bye" };

/** Sends a signaling message to one peer (point-to-point, via the relay). */
export type SignalTransport = {
  send: (toPeer: string, msg: SignalMessage) => void;
};

// A couple of public STUN servers get most peers connected without a TURN relay;
// media is peer-to-peer regardless of the signaling path.
export const DEFAULT_RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }],
};
