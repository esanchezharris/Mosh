import type { AuditEvent, PlaytestReport, RepairJob } from "./contracts.js";

export type UploadedEvidence = {
  evidenceId: string;
  sha256: string;
  objectPath: string;
  previewUrl: string;
  previewExpiresAt: string;
};

export interface EvidenceAdapter {
  uploadPng(input: {
    evidenceId: string;
    playtestId: string;
    reportId: string;
    localPath: string;
  }): Promise<UploadedEvidence>;
}

export interface GitHubAdapter {
  syncApprovedReport(input: {
    reportId: string;
    playtestId: string;
    kind: PlaytestReport["kind"];
    title: string;
    body: string;
    evidence: ReadonlyArray<UploadedEvidence>;
  }): Promise<
    | { status: "auth_missing" }
    | { status: "synced"; issueNumber: number; issueUrl: string }
  >;
}

export type AppServerEvent = {
  type: "thread" | "turn" | "approval" | "progress";
  data: Readonly<Record<string, unknown>>;
};

export interface AppServerAdapter {
  initialize(): Promise<void>;
  startThread(
    input: { mode: "read-only" | "workspace-write"; cwd: string },
    onEvent?: (event: AppServerEvent) => Promise<void> | void,
  ): Promise<string>;
  startTurn(input: {
    threadId: string;
    prompt: string;
    mode: "read-only" | "workspace-write";
    cwd: string;
  }): Promise<string>;
}

export interface GitAdapter {
  inspectBase(repositoryPath: string): Promise<{ sha: string; clean: boolean }>;
  inspectMain(repositoryPath: string): Promise<{ sha: string }>;
  inspectWorktreeAgainst(worktreePath: string, targetSha: string): Promise<{
    sha: string;
    clean: boolean;
    basedOnTarget: boolean;
  }>;
  createWorktree(input: {
    repositoryPath: string;
    baseSha: string;
    branch: string;
    path: string;
  }): Promise<void>;
  removeWorktree(input: {
    repositoryPath: string;
    path: string;
    branch: string;
  }): Promise<void>;
}

export type RepairCheckpoint = {
  checkpointPath: string;
  priorAppPath: string;
};

export interface RepairArtifactPolicy {
  validateResult(
    worktreePath: string,
    result: NonNullable<RepairJob["result"]>,
  ): Promise<NonNullable<RepairJob["result"]>>;
  validateBuild(worktreePath: string, buildPath: string, sourceSha: string): Promise<string>;
}

export type RepairLaunchContext = {
  repairId: string;
  buildPath: string;
  worktreePath: string;
  sourceSha: string;
  checkpointPath: string;
};

export type PriorAppHandoffContext = {
  checkpointPath: string;
  priorAppPath: string;
  repairId: string;
  buildPath: string;
};

export interface ProcessAdapter {
  checkpoint(): Promise<RepairCheckpoint>;
  stopTransport(): Promise<void>;
  releaseAudio(): Promise<void>;
  handoffRepairBuild(context: RepairLaunchContext): Promise<void>;
  handoffPriorApp(context: PriorAppHandoffContext): Promise<void>;
}

export type EventSink = (
  playtestId: string,
  type: string,
  data: Record<string, unknown>,
) => Promise<AuditEvent>;

export type Dependencies = {
  evidence: EvidenceAdapter;
  github: GitHubAdapter;
  appServer: AppServerAdapter;
  git: GitAdapter;
  processes: ProcessAdapter;
  artifacts: RepairArtifactPolicy;
  repositoryPath: string;
  worktreeRoot: string;
};

export type Emit = (
  playtestId: string,
  type: string,
  data: Record<string, unknown>,
) => Promise<void>;

export function failure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export async function serialized<T>(
  tails: Map<string, Promise<void>>,
  key: string,
  action: () => Promise<T>,
): Promise<T> {
  const preceding = tails.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  tails.set(key, current);
  await preceding;
  try {
    return await action();
  } finally {
    release();
    if (tails.get(key) === current) tails.delete(key);
  }
}
