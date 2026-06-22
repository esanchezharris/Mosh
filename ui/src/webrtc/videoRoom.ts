// Coordinates one peer link per collaborator: opens a PeerConn when we start sharing
// (to offer) or when a peer's offer arrives (to receive), tears them down as peers leave,
// and fans our local camera track out to all of them. Pure over injected transport +
// callbacks, so it unit-tests with a fake RTCPeerConnection and a loopback transport.

import { PeerConn } from "./peerConnection";
import { DEFAULT_RTC_CONFIG, type SignalMessage, type SignalTransport } from "./signal";

export class VideoRoom {
  private peers = new Map<string, PeerConn>();
  private known = new Set<string>();
  private localStream: MediaStream | null = null;

  constructor(
    readonly selfId: string,
    private readonly transport: SignalTransport,
    private readonly onRemoteStream: (peerId: string, stream: MediaStream | null) => void,
    private readonly config: RTCConfiguration = DEFAULT_RTC_CONFIG,
  ) {}

  private ensure(peerId: string): PeerConn {
    let pc = this.peers.get(peerId);
    if (!pc) {
      // Deterministic politeness: the lexicographically-smaller id yields on glare.
      pc = new PeerConn(this.selfId < peerId, (msg) => this.transport.send(peerId, msg),
        (stream) => this.onRemoteStream(peerId, stream), this.config);
      this.peers.set(peerId, pc);
      if (this.localStream) pc.setLocalStream(this.localStream); // offer our camera to a fresh peer
    }
    return pc;
  }

  private drop(peerId: string): void {
    const pc = this.peers.get(peerId);
    if (pc) { pc.close(); this.peers.delete(peerId); this.onRemoteStream(peerId, null); }
  }

  /** Reconcile the live peer set (from presence). Opens links to share with new peers;
      tears down links for peers who left. */
  syncPeers(peerIds: string[]): void {
    this.known = new Set(peerIds.filter((id) => id !== this.selfId));
    if (this.localStream) for (const id of this.known) this.ensure(id); // proactively offer when sharing
    for (const id of [...this.peers.keys()]) if (!this.known.has(id)) this.drop(id);
  }

  /** Set (or clear) the local camera stream and fan it out to every peer link. */
  setLocalStream(stream: MediaStream | null): void {
    this.localStream = stream;
    if (stream) for (const id of this.known) this.ensure(id); // create links so we can offer
    for (const pc of this.peers.values()) pc.setLocalStream(stream);
  }

  /** Handle an inbound signaling message from a peer (creates the link on demand). */
  onSignal(from: string, msg: SignalMessage): void {
    if (from === this.selfId) return;
    void this.ensure(from).onSignal(msg);
  }

  close(): void {
    for (const id of [...this.peers.keys()]) this.drop(id);
    this.known.clear();
    this.localStream = null;
  }
}
