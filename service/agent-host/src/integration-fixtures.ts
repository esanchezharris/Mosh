import type { Session, UserMessageItem } from "@openai/agents-core";
import type { SupervisorModelAdapter } from "./openai.js";
import type {
  AppServerAdapter,
  AppServerEvent,
  EvidenceAdapter,
  GitAdapter,
  GitHubAdapter,
  ProcessAdapter,
  RepairArtifactPolicy,
} from "./orchestration.js";

export const INTEGRATION_CAPABILITY = "task-5-local-fixture-capability";
export const INTEGRATION_BUILD_SHA = "1".repeat(40);
export const INTEGRATION_SCREENSHOT_SHA = "a".repeat(64);
export const INTEGRATION_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

export type IntegrationCalls = {
  evidence: string[];
  github: string[];
  app: string[];
  git: string[];
  process: string[];
};

export function createIntegrationCalls(): IntegrationCalls {
  return { evidence: [], github: [], app: [], git: [], process: [] };
}

export function createFixtureAdapters(calls: IntegrationCalls) {
  const evidence: EvidenceAdapter = {
    uploadPng: async (input) => {
      calls.evidence.push(input.evidenceId);
      return {
        evidenceId: input.evidenceId,
        sha256: INTEGRATION_SCREENSHOT_SHA,
        objectPath: `${input.playtestId}/${input.reportId}/${input.evidenceId}.png`,
        previewUrl: "https://fixture.invalid/signed-preview",
        previewExpiresAt: "2030-01-01T00:00:00.000Z",
      };
    },
  };
  const github: GitHubAdapter = {
    syncApprovedReport: async (input) => {
      calls.github.push(input.reportId);
      return {
        status: "synced",
        issueNumber: 42,
        issueUrl: "https://fixture.invalid/issues/42",
      };
    },
  };
  const appServer: AppServerAdapter = {
    initialize: async () => undefined,
    startThread: async (input, onEvent) => {
      calls.app.push(`thread:${input.mode}`);
      const event: AppServerEvent = {
        type: "progress",
        data: { phase: input.mode === "read-only" ? "triage" : "focused-red" },
      };
      await onEvent?.(event);
      return `${input.mode}-thread`;
    },
    startTurn: async (input) => {
      calls.app.push(`turn:${input.mode}`);
      return `${input.mode}-turn`;
    },
  };
  const git: GitAdapter = {
    inspectBase: async () => ({ sha: INTEGRATION_BUILD_SHA, clean: true }),
    createWorktree: async (input) => {
      calls.git.push(`${input.branch}:${input.path}`);
    },
    removeWorktree: async (input) => {
      calls.git.push(`remove:${input.branch}:${input.path}`);
    },
  };
  const processes: ProcessAdapter = {
    checkpoint: async () => {
      calls.process.push("checkpoint");
      return { checkpointPath: "/fixture/checkpoint.mosh", priorAppPath: "/fixture/Mosh.app" };
    },
    stopTransport: async () => { calls.process.push("stop_transport"); },
    releaseAudio: async () => { calls.process.push("release_audio"); },
    handoffRepairBuild: async () => { calls.process.push("handoff_repair"); },
    handoffPriorApp: async () => { calls.process.push("handoff_prior"); },
  };
  const artifacts: RepairArtifactPolicy = {
    validateResult: async (_worktreePath, result) => result,
    validateBuild: async (_worktreePath, buildPath) => buildPath,
  };
  return { evidence, github, appServer, git, processes, artifacts };
}

export class FixtureSupervisor implements SupervisorModelAdapter {
  async run(_input: string, session: Session): Promise<unknown> {
    const item: UserMessageItem = {
      role: "user",
      content: "fixture supervisor turn",
    };
    await session.addItems([item]);
    return {
      intent: "Toggle metronome",
      say: "Metronome ready.",
      commands: [{ capabilityId: "set_metronome", arguments: { enabled: true } }],
      needsClarification: false,
      selectedCapabilityIds: ["set_metronome"],
    };
  }
}
