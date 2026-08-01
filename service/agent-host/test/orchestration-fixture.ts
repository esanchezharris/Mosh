import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentHostService } from "../src/service.js";
import { PlaytestStore } from "../src/persistence.js";
import {
  OwnerOrchestrator,
  type AppServerAdapter,
  type EvidenceAdapter,
  type GitAdapter,
  type GitHubAdapter,
  type ProcessAdapter,
  type RepairArtifactPolicy,
} from "../src/orchestration.js";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

export class OrchestrationFakes {
  evidenceCalls: string[] = [];
  githubCalls: string[] = [];
  appCalls: Array<{ kind: string; value: unknown }> = [];
  gitCalls: string[] = [];
  processCalls: string[] = [];
  clean = true;
  authenticated = true;
  githubTransportFailure = false;
  evidenceSha = "a".repeat(64);
  failWorktree = false;
  failAppAction: "initialize" | "thread" | "turn" | undefined;
  failAppError: (Error & { code?: string }) | undefined;
  failProcessAction: string | undefined;
  failProcessError: (Error & { code?: string }) | undefined;

  evidence: EvidenceAdapter = {
    uploadPng: async (input) => {
      this.evidenceCalls.push(JSON.stringify(input));
      return {
        evidenceId: input.evidenceId,
        sha256: this.evidenceSha,
        objectPath: `${input.playtestId}/${input.reportId}/${input.evidenceId}.png`,
        previewUrl: "https://preview.invalid/signed",
        previewExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
  };

  github: GitHubAdapter = {
    syncApprovedReport: async (input) => {
      this.githubCalls.push(JSON.stringify(input));
      if (!this.authenticated) return { status: "auth_missing" };
      if (this.githubTransportFailure) {
        throw Object.assign(new Error("ambiguous GitHub transport failure"), {
          code: "github_failed",
        });
      }
      return {
        status: "synced",
        issueNumber: input.kind === "note" ? 88 : 42,
        issueUrl: "https://github.invalid/42",
      };
    },
  };

  appServer: AppServerAdapter = {
    initialize: async () => {
      this.appCalls.push({ kind: "initialize", value: null });
      if (this.failAppAction === "initialize") {
        throw this.failAppError
          ?? Object.assign(new Error("injected initialize failure"), { code: "injected" });
      }
    },
    startThread: async (input) => {
      this.appCalls.push({ kind: "thread", value: input });
      if (this.failAppAction === "thread") {
        throw this.failAppError
          ?? Object.assign(new Error("injected thread failure"), { code: "injected" });
      }
      return `${input.mode}-thread`;
    },
    startTurn: async (input) => {
      this.appCalls.push({ kind: "turn", value: input });
      if (this.failAppAction === "turn") {
        throw this.failAppError
          ?? Object.assign(new Error("injected turn failure"), { code: "injected" });
      }
      return "turn-1";
    },
  };

  git: GitAdapter = {
    inspectBase: async () => ({ sha: "1".repeat(40), clean: this.clean }),
    createWorktree: async (input) => {
      this.gitCalls.push(JSON.stringify(input));
      if (this.failWorktree) {
        throw Object.assign(new Error("injected worktree failure"), { code: "injected" });
      }
    },
    removeWorktree: async (input) => {
      this.gitCalls.push(JSON.stringify({ remove: input.path, branch: input.branch }));
    },
  };

  processes: ProcessAdapter = {
    checkpoint: async () => {
      this.processCalls.push("checkpoint");
      return {
        checkpointPath: "/tmp/checkpoint.mosh",
        priorAppPath: "/Applications/Mosh.app",
      };
    },
    stopTransport: async () => { await this.processAction("stop_transport"); },
    releaseAudio: async () => { await this.processAction("release_audio"); },
    handoffRepairBuild: async () => { await this.processAction("handoff_repair"); },
    handoffPriorApp: async () => { await this.processAction("handoff_prior"); },
  };

  artifacts: RepairArtifactPolicy = {
    validateResult: async (_worktreePath, result) => result,
    validateBuild: async (_worktreePath, buildPath) => buildPath,
  };

  private async processAction(name: string): Promise<void> {
    this.processCalls.push(name);
    await new Promise((resolve) => setTimeout(resolve, 2));
    if (this.failProcessAction === name) {
      this.failProcessAction = undefined;
      const error = this.failProcessError
        ?? Object.assign(new Error(`injected ${name} failure`), { code: "injected" });
      this.failProcessError = undefined;
      throw error;
    }
  }
}

export async function orchestrationFixture(options: {
  git?: GitAdapter;
  repositoryPath?: string;
  worktreeRoot?: string;
  buildSha?: string;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "mosh-task4-"));
  const fakes = new OrchestrationFakes();
  const store = new PlaytestStore(root);
  const orchestration = new OwnerOrchestrator(store, {
    evidence: fakes.evidence,
    github: fakes.github,
    appServer: fakes.appServer,
    git: options.git ?? fakes.git,
    processes: fakes.processes,
    artifacts: fakes.artifacts,
    repositoryPath: options.repositoryPath ?? "/repo",
    worktreeRoot: options.worktreeRoot ?? "/worktrees",
  });
  const service = new AgentHostService(store, undefined, undefined, orchestration);
  await service.initialize();
  const playtest = await service.createPlaytest({});
  const imagePath = path.join(root, "window.png");
  await writeFile(imagePath, PNG);
  const report = await service.createReport({
    playtestId: playtest.id,
    kind: "bug",
    title: "Loop jumps",
    body: "At the fourth bar the loop jumps.",
    evidence: [{
      kind: "screenshot",
      localPath: imagePath,
      sha256: "a".repeat(64),
      metadata: {
        buildSha: options.buildSha ?? "1".repeat(40),
        dirtyDigest: "clean",
        snapshotDigest: "c".repeat(64),
        recentResults: [{ ok: false, command: "set_loop" }],
        projectReference: "must-not-leave-host.mosh",
        audioPayload: "must-not-leave-host",
      },
    }],
  });
  return { root, fakes, service, store, orchestration, playtest, report };
}

export const repairResult = {
  redEvidencePath: "/evidence/red.log",
  greenEvidencePath: "/evidence/green.log",
  diagnosticsPath: "/evidence/diagnostics.log",
  bundlePath: "/evidence/repair-bundle",
  buildPath: "/build/Mosh.app",
  sourceSha: "1".repeat(40),
  draftPrUrl: "https://github.invalid/pull/9",
  draft: true as const,
  merged: false as const,
};

export function restartedService(
  store: PlaytestStore,
  fakes: OrchestrationFakes,
): AgentHostService {
  return new AgentHostService(
    store,
    undefined,
    undefined,
    new OwnerOrchestrator(store, {
      evidence: fakes.evidence,
      github: fakes.github,
      appServer: fakes.appServer,
      git: fakes.git,
      processes: fakes.processes,
      artifacts: fakes.artifacts,
      repositoryPath: "/repo",
      worktreeRoot: "/worktrees",
    }),
  );
}

export async function persistedSwapFixture(
  state: "checkpointed" | "stopping" | "rolling_back",
) {
  const context = await orchestrationFixture();
  await context.service.approveReport(context.report.id);
  const repair = await context.service.createRepair(context.report.id);
  const completed = await context.service.completeRepair(repair.id, repairResult);
  await context.store.saveRepair({
    ...completed,
    checkpoint: {
      checkpointPath: "/tmp/checkpoint.mosh",
      priorAppPath: "/Applications/Mosh.app",
    },
    swap: { state, buildPath: "/build/Mosh.app" },
    updatedAt: new Date().toISOString(),
  });
  context.fakes.processCalls.length = 0;
  return { ...context, repair };
}
