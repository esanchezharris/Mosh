import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  codedError,
  parseJson,
  type CommandResult,
  type CommandRunner,
} from "./command-runner.js";
import type {
  EvidenceAdapter,
  GitAdapter,
  GitHubAdapter,
  ProcessAdapter,
  RepairCheckpoint,
  RepairLaunchContext,
} from "./orchestration.js";
import { NativeRepairArtifactPolicy } from "./repair-artifact-policy.js";

export { NodeCommandRunner } from "./command-runner.js";
export type { CommandResult, CommandRunner } from "./command-runner.js";

const edgeResponse = z.object({
  evidenceId: z.uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  objectPath: z.string().min(1),
  previewUrl: z.url(),
  previewExpiresAt: z.iso.datetime({ offset: true }),
});

export class EdgeFunctionEvidenceAdapter implements EvidenceAdapter {
  private readonly maxBytes: number;

  constructor(private readonly options: {
    endpoint: string;
    ownerSecret: string;
    fetch?: typeof fetch;
    maxBytes?: number;
  }) {
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  }

  async uploadPng(input: {
    evidenceId: string;
    playtestId: string;
    reportId: string;
    localPath: string;
  }) {
    const bytes = await readFile(input.localPath);
    if (bytes.length > this.maxBytes) {
      throw codedError("evidence_too_large", "PNG evidence exceeds the upload limit");
    }
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length < signature.length
      || signature.some((byte, index) => bytes[index] !== byte)) {
      throw codedError("invalid_png", "Evidence must be a PNG image");
    }
    const response = await (this.options.fetch ?? fetch)(this.options.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.ownerSecret}`,
        "Content-Type": "image/png",
        "X-Mosh-Evidence-Id": input.evidenceId,
        "X-Mosh-Playtest-Id": input.playtestId,
        "X-Mosh-Report-Id": input.reportId,
      },
      body: bytes,
    });
    if (!response.ok) {
      throw codedError("evidence_upload_failed", `Evidence upload failed (${response.status})`);
    }
    const parsed = edgeResponse.parse(await response.json());
    const expectedPath = `${input.playtestId}/${input.reportId}/${input.evidenceId}.png`;
    if (parsed.evidenceId !== input.evidenceId || parsed.objectPath !== expectedPath) {
      throw codedError("evidence_identity_mismatch", "Edge Function changed immutable evidence identity");
    }
    return parsed;
  }
}

const issueList = z.array(z.object({
  number: z.number().int().positive(),
  url: z.url(),
}));
const issueView = z.object({
  number: z.number().int().positive(),
  url: z.url(),
  comments: z.array(z.object({ body: z.string() })),
});

function marker(kind: "report" | "session", id: string): string {
  return `<!-- mosh-playtest-${kind}:${id} -->`;
}

export class GhGitHubAdapter implements GitHubAdapter {
  constructor(
    private readonly runner: CommandRunner,
    private readonly repository: string,
  ) {}

  async syncApprovedReport(input: Parameters<GitHubAdapter["syncApprovedReport"]>[0]) {
    const auth = await this.runner.run("gh", ["auth", "status"]);
    if (auth.exitCode !== 0) return { status: "auth_missing" as const };
    if (input.kind === "note") return this.syncNote(input);
    const reportMarker = marker("report", input.reportId);
    const existing = await this.findIssue(reportMarker);
    if (existing) return { status: "synced" as const, issueNumber: existing.number, issueUrl: existing.url };
    return this.createIssue(input.title, this.renderBody(input, reportMarker));
  }

  private async syncNote(input: Parameters<GitHubAdapter["syncApprovedReport"]>[0]) {
    const sessionMarker = marker("session", input.playtestId);
    const existing = await this.findIssue(sessionMarker);
    const session = existing
      ? { status: "synced" as const, issueNumber: existing.number, issueUrl: existing.url }
      : await this.createIssue(`Playtest notes ${input.playtestId.slice(0, 8)}`, sessionMarker);
    const viewed = await this.runner.run("gh", [
      "issue", "view", String(session.issueNumber), "--repo", this.repository,
      "--json", "number,url,comments",
    ]);
    if (viewed.exitCode !== 0) throw codedError("github_failed", "Could not inspect playtest notes issue");
    const issue = issueView.parse(parseJson(viewed.stdout));
    const reportMarker = marker("report", input.reportId);
    if (!issue.comments.some((comment) => comment.body.includes(reportMarker))) {
      const comment = await this.runner.run("gh", [
        "issue", "comment", String(issue.number), "--repo", this.repository,
        "--body", this.renderBody(input, reportMarker),
      ]);
      if (comment.exitCode !== 0) throw codedError("github_failed", "Could not append playtest note");
    }
    return { status: "synced" as const, issueNumber: issue.number, issueUrl: issue.url };
  }

  private async findIssue(searchMarker: string) {
    const result = await this.runner.run("gh", [
      "issue", "list", "--repo", this.repository, "--state", "all",
      "--search", searchMarker, "--json", "number,url", "--limit", "1",
    ]);
    if (result.exitCode !== 0) throw codedError("github_failed", "Could not search GitHub issues");
    return issueList.parse(parseJson(result.stdout))[0];
  }

  private async createIssue(title: string, body: string) {
    const created = await this.runner.run("gh", [
      "issue", "create", "--repo", this.repository, "--title", title, "--body", body,
    ]);
    if (created.exitCode !== 0) throw codedError("github_failed", "Could not create GitHub issue");
    const url = created.stdout.trim();
    const number = Number.parseInt(url.split("/").at(-1) ?? "", 10);
    if (!URL.canParse(url) || !Number.isInteger(number) || number <= 0) {
      throw codedError("github_invalid_response", "gh issue create returned an invalid URL");
    }
    return { status: "synced" as const, issueNumber: number, issueUrl: url };
  }

  private renderBody(
    input: Parameters<GitHubAdapter["syncApprovedReport"]>[0],
    identityMarker: string,
  ): string {
    const evidence = input.evidence.map((item) =>
      `- Evidence ${item.evidenceId}: ${item.previewUrl} (SHA-256 ${item.sha256})`).join("\n");
    return [
      identityMarker,
      `Playtest: ${input.playtestId}`,
      "",
      input.body,
      ...(evidence ? ["", "Evidence:", evidence] : []),
    ].join("\n");
  }
}

export {
  CodexAppServerAdapter,
  LazyCodexAppServerAdapter,
  StdioJsonRpcTransport,
  codexChildEnvironment,
  spawnCodexAppServer,
} from "./codex-app-server.js";
export type {
  CodexSpawn,
  JsonRpcTransport,
  RequestId,
  StdioChild,
} from "./codex-app-server.js";

export class GitCliAdapter implements GitAdapter {
  constructor(private readonly runner: CommandRunner) {}

  async inspectBase(repositoryPath: string): Promise<{ sha: string; clean: boolean }> {
    const [head, status] = await Promise.all([
      this.runner.run("git", ["-C", repositoryPath, "rev-parse", "HEAD"]),
      this.runner.run("git", ["-C", repositoryPath, "status", "--porcelain=v1", "--untracked-files=normal"]),
    ]);
    if (head.exitCode !== 0 || status.exitCode !== 0) {
      throw codedError("git_failed", "Could not inspect repair base");
    }
    const sha = head.stdout.trim();
    if (!/^[a-f0-9]{40}$/.test(sha)) throw codedError("git_invalid_sha", "Git returned an invalid base SHA");
    return { sha, clean: status.stdout.length === 0 };
  }

  async createWorktree(input: {
    repositoryPath: string;
    baseSha: string;
    branch: string;
    path: string;
  }): Promise<void> {
    const result = await this.runner.run("git", [
      "-C", input.repositoryPath, "worktree", "add", "-b", input.branch, input.path, input.baseSha,
    ]);
    if (result.exitCode !== 0) throw codedError("git_worktree_failed", "Could not create repair worktree");
  }

  async removeWorktree(input: { repositoryPath: string; path: string }): Promise<void> {
    const result = await this.runner.run("git", [
      "-C", input.repositoryPath, "worktree", "remove", "--force", input.path,
    ]);
    if (result.exitCode !== 0) throw codedError("git_worktree_cleanup_failed", "Could not remove repair worktree");
  }
}

const checkpointResult = z.object({
  checkpointPath: z.string().min(1),
  priorAppPath: z.string().min(1),
});

export class RepairControlAdapter implements ProcessAdapter {
  constructor(
    private readonly runner: CommandRunner,
    private readonly helperPath: string,
    private readonly artifactPolicy = new NativeRepairArtifactPolicy(),
  ) {}

  async checkpoint(): Promise<RepairCheckpoint> {
    const result = await this.action("checkpoint");
    return checkpointResult.parse(parseJson(result.stdout));
  }

  async stopTransport(): Promise<void> { await this.action("stop-transport"); }
  async releaseAudio(): Promise<void> { await this.action("release-audio"); }
  async closeMosh(): Promise<void> { await this.action("close-mosh"); }
  async launchRepairBuild(context: RepairLaunchContext): Promise<void> {
    const buildPath = await this.artifactPolicy.validateBuild(
      context.worktreePath,
      context.buildPath,
      context.sourceSha,
    );
    if (buildPath !== context.buildPath) {
      throw codedError("repair_build_mismatch", "Repair helper launch path changed after validation");
    }
    await this.action("launch-repair", buildPath);
  }
  async closeRepairBuild(): Promise<void> { await this.action("close-repair"); }
  async restoreCheckpoint(checkpointPath: string): Promise<void> {
    await this.action("restore-checkpoint", checkpointPath);
  }
  async launchPriorApp(appPath: string): Promise<void> {
    await this.action("launch-prior", appPath);
  }

  private async action(name: string, argument?: string): Promise<CommandResult> {
    const result = await this.runner.run(this.helperPath, argument ? [name, argument] : [name]);
    if (result.exitCode !== 0) {
      throw codedError("repair_process_failed", `Repair process action failed: ${name}`);
    }
    return result;
  }
}
