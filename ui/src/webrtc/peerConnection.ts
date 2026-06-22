// One peer-to-peer video link, using the WHATWG "perfect negotiation" pattern so two
// peers can both add tracks at once without glare. Politeness is decided deterministically
// from the peer ids (both sides agree who yields), so there's no central authority. All
// SDP/ICE leaves via the injected `send`; remote video arrives via `onRemoteStream`.

import type { SignalMessage } from "./signal";

export class PeerConn {
  readonly pc: RTCPeerConnection;
  private makingOffer = false;
  private ignoreOffer = false;

  constructor(
    private readonly polite: boolean,
    private readonly send: (msg: SignalMessage) => void,
    private readonly onRemoteStream: (stream: MediaStream | null) => void,
    config: RTCConfiguration,
  ) {
    this.pc = new RTCPeerConnection(config);

    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        if (this.pc.localDescription) this.send({ kind: "offer", sdp: this.pc.localDescription.sdp });
      } catch {
        /* transient negotiation race — the next negotiationneeded retries */
      } finally {
        this.makingOffer = false;
      }
    };

    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.send({ kind: "ice", candidate: candidate.toJSON() });
    };

    this.pc.ontrack = ({ streams }) => this.onRemoteStream(streams[0] ?? null);

    this.pc.onconnectionstatechange = () => {
      if (["failed", "disconnected", "closed"].includes(this.pc.connectionState)) this.onRemoteStream(null);
    };
  }

  /** Add / swap / drop our outgoing camera track. Adding the first track renegotiates. */
  setLocalStream(stream: MediaStream | null): void {
    const track = stream?.getVideoTracks()[0] ?? null;
    const sender = this.pc.getSenders().find((s) => !s.track || s.track.kind === "video");
    if (sender) {
      void sender.replaceTrack(track); // swap (camera flip) or drop (track=null) — no renegotiation
    } else if (track && stream) {
      this.pc.addTrack(track, stream); // first track → onnegotiationneeded fires
    }
  }

  async onSignal(msg: SignalMessage): Promise<void> {
    if (msg.kind === "offer" || msg.kind === "answer") {
      const offerCollision = msg.kind === "offer" && (this.makingOffer || this.pc.signalingState !== "stable");
      this.ignoreOffer = !this.polite && offerCollision;
      if (this.ignoreOffer) return; // impolite peer wins the glare — drop the colliding offer
      await this.pc.setRemoteDescription({ type: msg.kind, sdp: msg.sdp });
      if (msg.kind === "offer") {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        if (this.pc.localDescription) this.send({ kind: "answer", sdp: this.pc.localDescription.sdp });
      }
    } else if (msg.kind === "ice") {
      try {
        await this.pc.addIceCandidate(msg.candidate);
      } catch (e) {
        if (!this.ignoreOffer) throw e; // candidates for an ignored offer are expected to fail
      }
    } else if (msg.kind === "bye") {
      this.onRemoteStream(null);
    }
  }

  close(): void {
    this.pc.onnegotiationneeded = null;
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onconnectionstatechange = null;
    this.pc.close();
  }
}
