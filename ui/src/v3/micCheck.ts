import type { MicrophonePermissionStatus } from "../bridge";

// What the Start page says about the microphone, in a friend's words. Two sources:
//
// - the macOS permission, read and requested through the bridge's NON-blocking calls
//   (microphone_permission_status / request_microphone_permission run off the message
//   thread) BEFORE "Start a new song" creates anything. Asking first keeps the macOS prompt
//   out of new_project, whose vocal template arms the Vocal track synchronously: a prompt
//   there would freeze the app for up to two minutes with no way to paint "waiting".
// - the engine's own arm_track / loop_setup refusals (MoshEngine::activateAudioInput and
//   MacMicrophonePermission.h), matched by their stable leading words.

export type MicProblem =
  | "ok"
  | "ask"          // not decided yet: macOS will ask
  | "denied"
  | "restricted"
  | "timed-out"
  | "no-device"
  | "device-failed";

export interface MicReport {
  problem: MicProblem;
  /** One or two sentences for the singer. Empty when nothing is wrong. */
  text: string;
  /** Offer the Audio settings dialog (a device problem). */
  audioSettings: boolean;
  /** Retry is meaningful (it re-asks or re-opens). */
  retry: boolean;
}

const OK: MicReport = { problem: "ok", text: "", audioSettings: false, retry: false };

export const MIC_COPY: Record<Exclude<MicProblem, "ok">, string> = {
  ask: "macOS may ask to use the microphone. Choose OK.",
  denied: "Mosh isn't allowed to use the microphone. Open System Settings, then Privacy & Security, then Microphone, turn Mosh on, and press Retry.",
  restricted: "This Mac doesn't allow microphone access. You can still load beats and listen; recording needs another Mac.",
  "timed-out": "macOS asked about the microphone and nobody answered. Press Retry and choose OK.",
  "no-device": "No microphone found. Plug one in, or pick the built-in mic in Audio settings.",
  "device-failed": "The microphone didn't open.",
};

/** From the bridge's permission status. */
export function micFromPermission(status: MicrophonePermissionStatus | "unknown"): MicReport {
  switch (status) {
    case "granted": return OK;
    case "not-determined": return { problem: "ask", text: MIC_COPY.ask, audioSettings: false, retry: false };
    case "denied": return { problem: "denied", text: MIC_COPY.denied, audioSettings: false, retry: true };
    case "restricted": return { problem: "restricted", text: MIC_COPY.restricted, audioSettings: false, retry: false };
    case "timed-out": return { problem: "timed-out", text: MIC_COPY["timed-out"], audioSettings: false, retry: true };
    default: return OK;   // unknown (an older bridge): let the engine's answers speak
  }
}

/** From an engine refusal string (arm_track's error, or set_input_monitor/loop_setup's
 *  `reason`). Unknown strings are passed through verbatim under a friendly lead. */
export function micFromEngineError(error: string | null | undefined): MicReport {
  const e = (error ?? "").trim();
  if (!e) return OK;
  if (/^Microphone access is off/i.test(e)) return { problem: "denied", text: MIC_COPY.denied, audioSettings: false, retry: true };
  if (/^Microphone access is not available/i.test(e)) return { problem: "restricted", text: MIC_COPY.restricted, audioSettings: false, retry: false };
  if (/^The microphone permission request did not finish/i.test(e)) {
    return { problem: "timed-out", text: MIC_COPY["timed-out"], audioSettings: false, retry: true };
  }
  if (/no audio input device|no input device/i.test(e)) return { problem: "no-device", text: MIC_COPY["no-device"], audioSettings: true, retry: true };
  if (/^Audio input ".*" did not open within/i.test(e)) {
    return { problem: "device-failed", text: `${MIC_COPY["device-failed"]} It took too long to start. Press Retry, or pick another input in Audio settings.`, audioSettings: true, retry: true };
  }
  if (/^Audio input ".*" could not open/i.test(e)) {
    return { problem: "device-failed", text: `${MIC_COPY["device-failed"]} ${e}`, audioSettings: true, retry: true };
  }
  if (/safety probe|setup is invalid or too large/i.test(e)) {
    return { problem: "device-failed", text: `${MIC_COPY["device-failed"]} Pick another input in Audio settings, then press Retry.`, audioSettings: true, retry: true };
  }
  return { problem: "device-failed", text: `${MIC_COPY["device-failed"]} ${e}`, audioSettings: true, retry: true };
}
