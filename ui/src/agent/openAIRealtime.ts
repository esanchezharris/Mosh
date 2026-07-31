import {
  OpenAIRealtimeWebRTC,
  RealtimeAgent,
  RealtimeSession,
  tool,
} from "@openai/agents/realtime";
import { z } from "zod";
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
  return new PushToTalkController({
    getClientSecret: dependencies.getClientSecret,
    getMediaStream: () => navigator.mediaDevices.getUserMedia({ audio: true }),
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
        parameters: z.object({
          command: z.string(),
          args: z.record(z.string(), z.unknown()),
        }),
        execute: async ({ command, args }) =>
          recordingRefusal() ?? dependencies.runDirectSafe(command, args),
      });
      const draftReport = tool({
        name: "draft_playtest_report",
        description: "Persist a local blocker, bug, or note for owner approval.",
        parameters: z.object({
          kind: z.enum(["blocker", "bug", "note"]),
          title: z.string(),
          body: z.string(),
        }),
        execute: async (report) => dependencies.draftReport(report),
      });
      const supervisor = tool({
        name: "delegate_to_supervisor",
        description: "Delegate a complex request to the host supervisor and validated MoshOps executor.",
        parameters: z.object({ message: z.string() }),
        execute: async ({ message }) =>
          recordingRefusal() ?? dependencies.delegateSupervisor(message),
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
        close: () => session.close(),
        interrupt: () => session.interrupt(),
        onError: (listener) => { session.on("error", listener); },
      } satisfies RealtimeSessionPort;
    },
  });
}
