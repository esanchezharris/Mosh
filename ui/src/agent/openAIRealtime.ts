import {
  OpenAIRealtimeWebRTC,
  RealtimeAgent,
  RealtimeSession,
  tool,
} from "@openai/agents/realtime";
import { isRealNative } from "../bridge";
import { PushToTalkController, type RealtimeSessionPort } from "./realtimeVoice";
import type { DraftReportInput } from "./ownerCockpit";

export type OpenAIRealtimeDependencies = {
  readonly getClientSecret: () => Promise<string>;
  readonly runDirectSafe: (command: string, args: Readonly<Record<string, unknown>>) => Promise<string>;
  readonly draftReport: (report: DraftReportInput) => Promise<string>;
  readonly delegateSupervisor: (message: string) => Promise<string>;
  readonly isRecording: () => boolean;
  readonly onFailure: (error: unknown) => void;
};

export function createOpenAIRealtimeController(
  dependencies: OpenAIRealtimeDependencies,
): PushToTalkController {
  const audioElement = document.createElement("audio");
  audioElement.autoplay = true;
  const useNativeTranscript = isRealNative();
  let silentAudio: { stream: MediaStream; close: () => Promise<void> } | null = null;
  return new PushToTalkController({
    getClientSecret: dependencies.getClientSecret,
    getMediaStream: async () => {
      if (!useNativeTranscript)
        return navigator.mediaDevices.getUserMedia({ audio: true });
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const destination = context.createMediaStreamDestination();
      gain.gain.value = 0;
      oscillator.connect(gain);
      gain.connect(destination);
      oscillator.start();
      silentAudio = {
        stream: destination.stream,
        close: async () => {
          try { oscillator.stop(); } catch {}
          await context.close();
        },
      };
      return destination.stream;
    },
    releaseMediaStream: async (stream) => {
      if (silentAudio?.stream !== stream) return;
      const resource = silentAudio;
      silentAudio = null;
      await resource.close();
    },
    inputMode: useNativeTranscript ? "native-transcript" : "webrtc-microphone",
    audioElement,
    onFailure: dependencies.onFailure,
    createSession: ({ mediaStream, historyStoreAudio }) => {
      const recordingRefusal = () => {
        if (!dependencies.isRecording()) return null;
        return "Recording is active. Stop recording before asking Moshi to speak or edit.";
      };
      const directSafe = tool({
        name: "run_direct_safe_command",
        description: "Run one deterministic transport, locate, loop, metronome, undo, or read-only command.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
            args: { type: "object", additionalProperties: true },
          },
          required: ["command", "args"],
          additionalProperties: true,
        } as const,
        strict: false,
        execute: async (input) => {
          const command = typeof input === "object" && input !== null
            && typeof (input as { command?: unknown }).command === "string"
            ? (input as { command: string }).command
            : "";
          const args = typeof input === "object" && input !== null
            && typeof (input as { args?: unknown }).args === "object"
            && (input as { args?: unknown }).args !== null
            ? (input as { args: Readonly<Record<string, unknown>> }).args
            : {};
          if (!command) return "That command was not valid.";
          return recordingRefusal() ?? dependencies.runDirectSafe(command, args);
        },
      });
      const draftReport = tool({
        name: "draft_playtest_report",
        description: "Persist a local blocker, bug, or note for owner approval.",
        parameters: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["blocker", "bug", "note"] },
            title: { type: "string" },
            body: { type: "string" },
          },
          required: ["kind", "title", "body"],
          additionalProperties: false,
        } as const,
        execute: async (input) => {
          const report = input as DraftReportInput;
          return dependencies.draftReport(report);
        },
      });
      const supervisor = tool({
        name: "delegate_to_supervisor",
        description: "Delegate a complex request to the host supervisor and validated MoshOps executor.",
        parameters: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        } as const,
        execute: async (input) => {
          const message = typeof input === "object" && input !== null
            && typeof (input as { message?: unknown }).message === "string"
            ? (input as { message: string }).message
            : "";
          if (!message) return "That request was not valid.";
          return recordingRefusal() ?? dependencies.delegateSupervisor(message);
        },
      });
      const agent = new RealtimeAgent({
        name: "Moshi",
        instructions: "Be terse. Use only the provided tools. Never mutate outside the validated MoshOps executor.",
        tools: [directSafe, draftReport, supervisor],
      });
      const transport = new OpenAIRealtimeWebRTC({ mediaStream, audioElement });
      const session = new RealtimeSession(agent, {
        model: "gpt-realtime-2.1",
        transport,
        historyStoreAudio,
        config: {
          outputModalities: ["audio"],
          audio: { input: { turnDetection: null } },
        },
        workflowName: "mosh-owner-playtest-realtime",
      });
      return {
        connect: ({ apiKey }) => session.connect({ apiKey }),
        mute: (muted) => session.mute(muted),
        sendMessage: (message) => session.sendMessage(message),
        close: () => session.close(),
        interrupt: () => session.interrupt(),
        onError: (listener) => { session.on("error", listener); },
      } satisfies RealtimeSessionPort;
    },
  });
}
