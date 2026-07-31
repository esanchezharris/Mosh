import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentInputItem, Session } from "@openai/agents-core";
import type { SupervisorModelAdapter } from "./openai.js";
import {
  OwnerOrchestrator,
  type AppServerAdapter,
  type AppServerEvent,
  type EvidenceAdapter,
  type GitAdapter,
  type GitHubAdapter,
  type ProcessAdapter,
} from "./orchestration.js";
import { PlaytestStore } from "./persistence.js";
import { startAgentHost } from "./server.js";
import { AgentHostService } from "./service.js";

const CAPABILITY = "task-5-local-fixture-capability";
const BUILD_SHA = "1".repeat(40);
const SCREENSHOT_SHA = "a".repeat(64);
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

type JsonRecord = Record<string, unknown>;

export type OwnerCockpitIntegrationResult = {
  verdict: "passed";
  host: "127.0.0.1";
  externalWrites: {
    beforeApproval: number;
    evidence: number;
    github: number;
    codexThreads: number;
    gitWorktrees: number;
    processActions: number;
    live: 0;
  };
  supervisor: JsonRecord;
  repair: JsonRecord;
  events: string[];
  retention: {
    transcriptPurged: boolean;
    sdkSessionPurged: boolean;
    reportRetained: boolean;
    repairRetained: boolean;
    auditRetained: boolean;
  };
};

function object(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as JsonRecord;
}

function stringProperty(value: JsonRecord, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`Missing ${key}`);
  }
  return candidate;
}

async function missing(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function json(response: Response, expectedStatus: number): Promise<JsonRecord> {
  if (response.status !== expectedStatus) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  return object(await response.json(), "HTTP response");
}

function fakeAdapters(calls: {
  evidence: string[];
  github: string[];
  app: string[];
  git: string[];
  process: string[];
}) {
  const evidence: EvidenceAdapter = {
    uploadPng: async (input) => {
      calls.evidence.push(input.evidenceId);
      return {
        evidenceId: input.evidenceId,
        sha256: SCREENSHOT_SHA,
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
    inspectBase: async () => ({ sha: BUILD_SHA, clean: true }),
    createWorktree: async (input) => {
      calls.git.push(`${input.branch}:${input.path}`);
    },
  };
  const processes: ProcessAdapter = {
    checkpoint: async () => {
      calls.process.push("checkpoint");
      return { checkpointPath: "/fixture/checkpoint.mosh", priorAppPath: "/fixture/Mosh.app" };
    },
    stopTransport: async () => { calls.process.push("stop_transport"); },
    releaseAudio: async () => { calls.process.push("release_audio"); },
    closeMosh: async () => { calls.process.push("close_mosh"); },
    launchRepairBuild: async () => { calls.process.push("launch_repair"); },
    closeRepairBuild: async () => { calls.process.push("close_repair"); },
    restoreCheckpoint: async () => { calls.process.push("restore_checkpoint"); },
    launchPriorApp: async () => { calls.process.push("launch_prior"); },
  };
  return { evidence, github, appServer, git, processes };
}

class FixtureSupervisor implements SupervisorModelAdapter {
  async run(_input: string, session: Session): Promise<unknown> {
    await session.addItems([
      { role: "user", content: "fixture supervisor turn" } as AgentInputItem,
    ]);
    return {
      intent: "Toggle metronome",
      say: "Metronome ready.",
      commands: [{ capabilityId: "set_metronome", arguments: { enabled: true } }],
      needsClarification: false,
      selectedCapabilityIds: ["set_metronome"],
    };
  }
}

export async function runOwnerCockpitIntegration(): Promise<OwnerCockpitIntegrationResult> {
  const root = await mkdtemp(path.join(tmpdir(), "mosh-task-5-integration-"));
  const calls = { evidence: [] as string[], github: [] as string[], app: [] as string[], git: [] as string[], process: [] as string[] };
  const store = new PlaytestStore(root);
  const adapters = fakeAdapters(calls);
  const orchestrator = new OwnerOrchestrator(store, {
    ...adapters,
    repositoryPath: "/fixture/repository",
    worktreeRoot: "/fixture/worktrees",
  });
  const service = new AgentHostService(store, new FixtureSupervisor(), undefined, orchestrator);
  const host = await startAgentHost({ service, capability: CAPABILITY, port: 0 });
  const auth = {
    Authorization: `Bearer ${CAPABILITY}`,
    "Content-Type": "application/json",
  };
  const post = (pathname: string, body: unknown) => fetch(`${host.origin}${pathname}`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(body),
  });

  try {
    if (host.host !== "127.0.0.1") throw new Error(`Host escaped loopback: ${host.host}`);
    const playtest = await json(await post("/v1/playtests", { retainTranscript: false }), 201);
    const playtestId = stringProperty(playtest, "id");
    const supervisor = await json(await post("/v1/supervisor/turns", {
      playtestId,
      message: "Turn on the metronome",
      capabilitySchemas: [{
        id: "set_metronome",
        description: "Set metronome state",
        inputSchema: {
          type: "object",
          properties: { enabled: { type: "boolean" } },
          required: ["enabled"],
          additionalProperties: false,
        },
      }],
      stateDigest: { playing: false, recording: false, metronomeEnabled: false },
      recentResults: [],
      conversationContext: [],
    }), 200);

    const screenshotPath = path.join(root, "window.png");
    await writeFile(screenshotPath, PNG);
    const report = await json(await post("/v1/reports", {
      playtestId,
      kind: "bug",
      title: "Metronome drift",
      body: "The metronome drifts after bar four.",
      evidence: [{
        kind: "screenshot",
        localPath: screenshotPath,
        sha256: SCREENSHOT_SHA,
        metadata: {
          buildSha: BUILD_SHA,
          dirtyDigest: "clean",
          timelinePosition: 8,
          snapshotDigest: "b".repeat(64),
          recentResults: [{ command: "set_metronome", ok: true }],
        },
      }],
    }), 201);
    const reportId = stringProperty(report, "id");
    const beforeApproval = calls.evidence.length + calls.github.length + calls.git.length + calls.process.length;
    if (beforeApproval !== 0) throw new Error("External adapter called before owner approval");

    const approved = await json(await post(`/v1/reports/${reportId}/approve`, {}), 200);
    if (approved.status !== "approved") throw new Error("Approved report did not synchronize");
    const repair = await json(await post(`/v1/reports/${reportId}/repairs`, {}), 201);
    const repairId = stringProperty(repair, "id");

    const replayResponse = await fetch(
      `${host.origin}/v1/playtests/${playtestId}/events?afterSequence=0&windowMs=20`,
      { headers: { Authorization: `Bearer ${CAPABILITY}` } },
    );
    if (replayResponse.status !== 200) throw new Error(`SSE replay failed: ${replayResponse.status}`);
    const replay = await replayResponse.text();
    const streamedEvents = replay.split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => object(JSON.parse(line.slice(6)) as unknown, "SSE event"))
      .map((event) => stringProperty(event, "type"));
    if (!streamedEvents.includes("codex.progress") || !streamedEvents.includes("repair.codex.progress")) {
      throw new Error("SSE replay omitted coordinator or repair progress");
    }

    await json(await post(`/v1/playtests/${playtestId}/close`, { retainTranscript: false }), 200);
    const sessionDirectory = store.sessionDirectory(playtestId);
    const transcriptPurged = await missing(path.join(sessionDirectory, "transcript.json"));
    const sdkSessionPurged = await missing(path.join(sessionDirectory, "sdk-session.json"));
    const reportRetained = !await missing(path.join(sessionDirectory, "reports", `${reportId}.json`));
    const repairRetained = !await missing(path.join(sessionDirectory, "repairs", `${repairId}.json`));
    const persistedEvents = await store.loadEvents(playtestId);
    const auditRetained = persistedEvents.length > 0
      && (await readFile(path.join(sessionDirectory, "events.jsonl"), "utf8")).includes("playtest.closed");
    if (!transcriptPurged || !sdkSessionPurged || !reportRetained || !repairRetained || !auditRetained) {
      throw new Error("Retention policy verification failed");
    }

    return {
      verdict: "passed",
      host: "127.0.0.1",
      externalWrites: {
        beforeApproval,
        evidence: calls.evidence.length,
        github: calls.github.length,
        codexThreads: calls.app.filter((call) => call.startsWith("thread:")).length,
        gitWorktrees: calls.git.length,
        processActions: calls.process.length,
        live: 0,
      },
      supervisor,
      repair: {
        status: repair.status,
        branch: repair.branch,
      },
      events: persistedEvents.map((event) => event.type),
      retention: {
        transcriptPurged,
        sdkSessionPurged,
        reportRetained,
        repairRetained,
        auditRetained,
      },
    };
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
}
