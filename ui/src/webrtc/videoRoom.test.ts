import { describe, it, expect, beforeEach, vi } from "vitest";
import { VideoRoom } from "./videoRoom";
import type { SignalMessage, SignalTransport } from "./signal";

// A minimal fake RTCPeerConnection: enough of the SDP/ICE state machine to exercise the
// perfect-negotiation wrapper + the room's routing/teardown, without a real RTC stack.
// Every offer carries a track (offers only originate from onnegotiationneeded, which only
// fires on addTrack), so receiving an offer models "the peer shared video" → fire ontrack.
class FakePC {
  signalingState = "stable";
  connectionState = "new";
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: ((e: { candidate: RTCIceCandidate | null }) => void) | null = null;
  ontrack: ((e: { streams: MediaStream[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  private senders: { track: MediaStreamTrack | null; replaceTrack: (t: MediaStreamTrack | null) => Promise<void> }[] = [];
  closed = false;

  // SDP carries a "+track" marker iff this side has added a local track — so the receiver
  // fires ontrack for both offers AND answers, modelling real bidirectional negotiation.
  private mark() { return this.senders.some((s) => s.track) ? "+track" : ""; }
  async createOffer() { return { type: "offer", sdp: "v=offer" + this.mark() }; }
  async createAnswer() { return { type: "answer", sdp: "v=answer" + this.mark() }; }
  async setLocalDescription(d: { type: string; sdp: string }) {
    this.localDescription = d;
    this.signalingState = d.type === "offer" ? "have-local-offer" : "stable";
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    this.remoteDescription = d;
    this.signalingState = d.type === "offer" ? "have-remote-offer" : "stable";
    if (d.sdp.includes("track")) this.ontrack?.({ streams: [{ id: "remote" } as unknown as MediaStream] });
  }
  async addIceCandidate() { /* recorded by not throwing */ }
  addTrack(track: MediaStreamTrack) {
    const sender: { track: MediaStreamTrack | null; replaceTrack: (t: MediaStreamTrack | null) => Promise<void> } =
      { track, replaceTrack: async (t) => { sender.track = t; } };
    this.senders.push(sender);
    queueMicrotask(() => this.onnegotiationneeded?.());
  }
  getSenders() { return this.senders; }
  close() { this.closed = true; }
}

const stream = () => ({ getVideoTracks: () => [{ kind: "video" } as MediaStreamTrack] }) as unknown as MediaStream;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = FakePC;
});

// Wire two rooms back-to-back: A's transport.send(to,msg) delivers to B.onSignal("A",msg).
function pair() {
  const remote: Record<string, MediaStream | null> = {};
  let A!: VideoRoom, B!: VideoRoom;
  const tA: SignalTransport = { send: (_to, msg) => B.onSignal("A", msg) };
  const tB: SignalTransport = { send: (_to, msg) => A.onSignal("B", msg) };
  A = new VideoRoom("A", tA, (id, s) => (remote["A>" + id] = s), {});
  B = new VideoRoom("B", tB, (id, s) => (remote["B>" + id] = s), {});
  A.syncPeers(["A", "B"]);
  B.syncPeers(["A", "B"]);
  return { A, B, remote };
}

describe("VideoRoom", () => {
  it("one peer sharing → the other receives a remote stream", async () => {
    const { A, remote } = pair();
    A.setLocalStream(stream()); // A turns its camera on → offers to B
    await flush();
    expect(remote["B>A"]).toBeTruthy(); // B sees A's video
  });

  it("both sharing at once (glare) still connects both, no deadlock", async () => {
    const { A, B, remote } = pair();
    A.setLocalStream(stream());
    B.setLocalStream(stream());
    await flush();
    await flush();
    expect(remote["B>A"]).toBeTruthy();
    expect(remote["A>B"]).toBeTruthy();
  });

  it("routes signaling only to the addressed peer", () => {
    const sent: { to: string; msg: SignalMessage }[] = [];
    const room = new VideoRoom("self", { send: (to, msg) => sent.push({ to, msg }) }, () => {}, {});
    room.syncPeers(["self", "p1", "p2"]);
    room.setLocalStream(stream());
    // offers go to each peer individually (point-to-point), never to self
    expect(sent.every((s) => s.to === "p1" || s.to === "p2")).toBe(true);
  });

  it("a peer leaving tears down its link and clears its tile", async () => {
    const { A, remote } = pair();
    A.setLocalStream(stream());
    await flush();
    expect(remote["B>A"]).toBeTruthy(); // link is up (B sees A's video)
    A.syncPeers(["A"]); // B left
    expect(remote["A>B"]).toBeNull(); // A's link to B torn down → tile cleared
  });

  it("ignores signals addressed from self (echo guard)", () => {
    const onRemote = vi.fn();
    const room = new VideoRoom("self", { send: () => {} }, onRemote, {});
    room.onSignal("self", { kind: "offer", sdp: "x" });
    expect(onRemote).not.toHaveBeenCalled();
  });

  it("close() tears down every link", async () => {
    const { A, remote } = pair();
    A.setLocalStream(stream());
    await flush();
    A.close();
    expect(remote["A>B"]).toBeNull();
  });
});
