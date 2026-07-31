import { classifyReportTrigger } from "./ownerCockpit";

type AudioTrack = Pick<MediaStreamTrack, "enabled" | "stop">;

export type RealtimeSessionPort = {
  connect(options: { apiKey: string }): Promise<void>;
  mute(muted: boolean): void | Promise<void>;
  close(): void;
  interrupt(): void;
};

export type RealtimeSessionFactoryOptions = {
  readonly mediaStream: MediaStream;
  readonly audioElement: HTMLAudioElement;
  readonly historyStoreAudio: false;
};

export type PushToTalkDependencies = {
  readonly getClientSecret: () => Promise<string>;
  readonly getMediaStream: () => Promise<MediaStream>;
  readonly createSession: (options: RealtimeSessionFactoryOptions) => RealtimeSessionPort;
  readonly audioElement: HTMLAudioElement;
};

export class PushToTalkController {
  readonly sessionOptions = { historyStoreAudio: false as const };
  private session: RealtimeSessionPort | null = null;
  private tracks: AudioTrack[] = [];

  constructor(private readonly dependencies: PushToTalkDependencies) {}

  async connect(): Promise<void> {
    const mediaStream = await this.dependencies.getMediaStream();
    this.tracks = mediaStream.getAudioTracks();
    this.disableInput();
    const apiKey = await this.dependencies.getClientSecret();
    this.session = this.dependencies.createSession({
      mediaStream,
      audioElement: this.dependencies.audioElement,
      historyStoreAudio: false,
    });
    await this.session.connect({ apiKey });
    await this.session.mute(true);
  }

  async press(state: { readonly recording: boolean }): Promise<
    { ok: true } | { ok: false; reason: string }
  > {
    if (state.recording) {
      await this.disable();
      return { ok: false, reason: "Stop recording before talking to Moshi." };
    }
    for (const track of this.tracks) track.enabled = true;
    await this.session?.mute(false);
    return { ok: true };
  }

  async release(): Promise<void> {
    await this.disable();
  }

  async cancel(): Promise<void> {
    await this.disable();
    this.session?.interrupt();
  }

  async fail(): Promise<void> {
    await this.disable();
  }

  setPlaybackActive(playing: boolean): void {
    this.dependencies.audioElement.volume = playing ? 0.3 : 1;
  }

  async dispose(): Promise<void> {
    await this.disable();
    for (const track of this.tracks) track.stop();
    this.tracks = [];
    this.session?.close();
    this.session = null;
  }

  private disableInput(): void {
    for (const track of this.tracks) track.enabled = false;
  }

  private async disable(): Promise<void> {
    this.disableInput();
    await this.session?.mute(true);
  }
}

const SAFE_FALLBACK = /\b(?:play|pause|stop|undo|redo|metronome|click|loop|locate|seek|go to)\b/i;

export function realtimeFallbackFor(text: string):
  | { kind: "apple-speech"; allowed: true }
  | { kind: "text-only"; allowed: false; message: string } {
  if (classifyReportTrigger(text) || SAFE_FALLBACK.test(text))
    return { kind: "apple-speech", allowed: true };
  return {
    kind: "text-only",
    allowed: false,
    message: "Realtime unavailable — type complex requests.",
  };
}

export function playMoshiEarcon(kind: "ready" | "report" | "error"): void {
  try {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = kind === "error" ? 180 : kind === "report" ? 520 : 420;
    gain.gain.setValueAtTime(0.04, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.09);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.1);
    oscillator.addEventListener("ended", () => void context.close(), { once: true });
  } catch {
    return;
  }
}
