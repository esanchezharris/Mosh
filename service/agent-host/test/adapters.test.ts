import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CodexAppServerAdapter,
  EdgeFunctionEvidenceAdapter,
  GhGitHubAdapter,
  GitCliAdapter,
  RepairControlAdapter,
  type CommandResult,
  type CommandRunner,
  type JsonRpcTransport,
} from "../src/adapters.js";
import { NativeRepairArtifactPolicy } from "../src/repair-artifact-policy.js";

class FakeRunner implements CommandRunner {
  calls: string[][] = [];
  responses: CommandResult[] = [];

  async run(command: string, args: readonly string[]): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    return this.responses.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
  }
}

describe("private evidence Edge Function adapter", () => {
  it("rejects non-PNG and oversized files before the owner-secret request", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mosh-evidence-"));
    const invalid = path.join(root, "invalid.png");
    await writeFile(invalid, Buffer.from("not png"));
    let requests = 0;
    const adapter = new EdgeFunctionEvidenceAdapter({
      endpoint: "https://project.supabase.co/functions/v1/playtest-evidence",
      ownerSecret: "owner-secret",
      fetch: async () => {
        requests += 1;
        return new Response();
      },
      maxBytes: 12,
    });
    await expect(adapter.uploadPng({
      evidenceId: crypto.randomUUID(),
      playtestId: crypto.randomUUID(),
      reportId: crypto.randomUUID(),
      localPath: invalid,
    })).rejects.toMatchObject({ code: "invalid_png" });
    expect(requests).toBe(0);
  });

  it("sends PNG bytes with immutable identities and returns no owner secret", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mosh-evidence-"));
    const localPath = path.join(root, "window.png");
    await writeFile(localPath, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
    ]));
    const evidenceId = crypto.randomUUID();
    const playtestId = crypto.randomUUID();
    const reportId = crypto.randomUUID();
    let request: Request | undefined;
    const adapter = new EdgeFunctionEvidenceAdapter({
      endpoint: "https://project.supabase.co/functions/v1/playtest-evidence",
      ownerSecret: "owner-secret",
      fetch: async (input, init) => {
        request = new Request(input, init);
        return Response.json({
          evidenceId,
          sha256: "a".repeat(64),
          objectPath: `${playtestId}/${reportId}/${evidenceId}.png`,
          previewUrl: "https://project.supabase.co/storage/v1/object/sign/private",
          previewExpiresAt: "2026-07-30T23:59:00.000Z",
        });
      },
    });

    const result = await adapter.uploadPng({ evidenceId, playtestId, reportId, localPath });

    expect(request?.headers.get("authorization")).toBe("Bearer owner-secret");
    expect(request?.headers.get("content-type")).toBe("image/png");
    expect(request?.headers.get("x-mosh-evidence-id")).toBe(evidenceId);
    expect(JSON.stringify(result)).not.toContain("owner-secret");
    expect(result.objectPath).toBe(`${playtestId}/${reportId}/${evidenceId}.png`);
  });
});

describe("authenticated gh adapter", () => {
  it("leaves missing authentication pending without attempting an issue write", async () => {
    const runner = new FakeRunner();
    runner.responses.push({ exitCode: 1, stdout: "", stderr: "not logged in" });
    const adapter = new GhGitHubAdapter(runner, "owner/repo");
    expect(await adapter.syncApprovedReport({
      reportId: crypto.randomUUID(),
      playtestId: crypto.randomUUID(),
      kind: "bug",
      title: "Broken loop",
      body: "Loop skips.",
      evidence: [],
    })).toEqual({ status: "auth_missing" });
    expect(runner.calls).toHaveLength(1);
  });

  it("reuses a report issue marker instead of creating a duplicate", async () => {
    const runner = new FakeRunner();
    runner.responses.push(
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: JSON.stringify([{ number: 41, url: "https://github.invalid/41" }]), stderr: "" },
    );
    const adapter = new GhGitHubAdapter(runner, "owner/repo");
    const result = await adapter.syncApprovedReport({
      reportId: "11111111-1111-4111-8111-111111111111",
      playtestId: crypto.randomUUID(),
      kind: "blocker",
      title: "Cannot record",
      body: "Record never starts.",
      evidence: [],
    });
    expect(result).toEqual({ status: "synced", issueNumber: 41, issueUrl: "https://github.invalid/41" });
    expect(runner.calls.some((call) => call.includes("create"))).toBe(false);
  });

  it("does not append the same minor-note marker twice to a session issue", async () => {
    const runner = new FakeRunner();
    runner.responses.push(
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: JSON.stringify([{ number: 9, url: "https://github.invalid/9" }]), stderr: "" },
      { exitCode: 0, stdout: JSON.stringify({ number: 9, url: "https://github.invalid/9", comments: [{ body: "<!-- mosh-playtest-report:22222222-2222-4222-8222-222222222222 -->" }] }), stderr: "" },
    );
    const adapter = new GhGitHubAdapter(runner, "owner/repo");
    await adapter.syncApprovedReport({
      reportId: "22222222-2222-4222-8222-222222222222",
      playtestId: "33333333-3333-4333-8333-333333333333",
      kind: "note",
      title: "Count-in",
      body: "Try a softer count-in.",
      evidence: [],
    });
    expect(runner.calls.some((call) => call.includes("comment"))).toBe(false);
  });

  it("recovers an issue create accepted remotely when the local gh result is ambiguous", async () => {
    const reportId = "44444444-4444-4444-8444-444444444444";
    let remoteIssue = false;
    let creates = 0;
    const runner: CommandRunner = {
      run: async (_command, args) => {
        if (args[0] === "auth") return { exitCode: 0, stdout: "", stderr: "" };
        if (args[1] === "list") {
          return {
            exitCode: 0,
            stdout: JSON.stringify(remoteIssue
              ? [{ number: 51, url: "https://github.invalid/51" }]
              : []),
            stderr: "",
          };
        }
        creates += 1;
        remoteIssue = true;
        return { exitCode: 1, stdout: "", stderr: "transport closed after acceptance" };
      },
    };
    const adapter = new GhGitHubAdapter(runner, "owner/repo");
    const input = {
      reportId,
      playtestId: crypto.randomUUID(),
      kind: "bug" as const,
      title: "Ambiguous create",
      body: "Create may have succeeded.",
      evidence: [],
    };
    await expect(adapter.syncApprovedReport(input)).rejects.toMatchObject({ code: "github_failed" });
    await expect(adapter.syncApprovedReport(input)).resolves.toMatchObject({
      status: "synced",
      issueNumber: 51,
    });
    expect(creates).toBe(1);
  });

  it("recovers a note comment accepted remotely when the local gh result is ambiguous", async () => {
    const reportId = "55555555-5555-4555-8555-555555555555";
    let remoteComment = false;
    let comments = 0;
    const runner: CommandRunner = {
      run: async (_command, args) => {
        if (args[0] === "auth") return { exitCode: 0, stdout: "", stderr: "" };
        if (args[1] === "list") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ number: 9, url: "https://github.invalid/9" }]),
            stderr: "",
          };
        }
        if (args[1] === "view") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              number: 9,
              url: "https://github.invalid/9",
              comments: remoteComment
                ? [{ body: `<!-- mosh-playtest-report:${reportId} -->` }]
                : [],
            }),
            stderr: "",
          };
        }
        comments += 1;
        remoteComment = true;
        return { exitCode: 1, stdout: "", stderr: "transport closed after acceptance" };
      },
    };
    const adapter = new GhGitHubAdapter(runner, "owner/repo");
    const input = {
      reportId,
      playtestId: "66666666-6666-4666-8666-666666666666",
      kind: "note" as const,
      title: "Ambiguous comment",
      body: "Comment may have succeeded.",
      evidence: [],
    };
    await expect(adapter.syncApprovedReport(input)).rejects.toMatchObject({ code: "github_failed" });
    await expect(adapter.syncApprovedReport(input)).resolves.toMatchObject({
      status: "synced",
      issueNumber: 9,
    });
    expect(comments).toBe(1);
  });
});

describe("repair git branch boundary", () => {
  it("refuses branch cleanup outside the owned codex/playtest namespace before running git", async () => {
    const runner = new FakeRunner();
    const adapter = new GitCliAdapter(runner);

    await expect(adapter.removeWorktree({
      repositoryPath: "/repo",
      path: "/worktrees/repair",
      branch: "main",
    })).rejects.toMatchObject({ code: "git_branch_refused" });

    expect(runner.calls).toEqual([]);
  });
});

describe("native MoshOps repair control", () => {
  it("checkpoints, stops transport, and releases audio through authenticated MoshOps", async () => {
    const runner = new FakeRunner();
    const commands: Array<{ command: string; args: Record<string, unknown>; authorization: string | null }> = [];
    const adapter = new RepairControlAdapter(runner, "/signed/helper", {
      endpoint: "http://127.0.0.1:49152",
      capability: "owner-capability",
      helperTeamId: "AB12CD34EF",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = await request.json() as { command: { command: string; args: Record<string, unknown> } };
        commands.push({ ...body.command, authorization: request.headers.get("authorization") });
        return Response.json({
          ok: true,
          data: {
            ok: true,
            data: body.command.command === "create_repair_checkpoint"
              ? { checkpointPath: "/tmp/checkpoint.tracktionedit", priorAppPath: "/Applications/Mosh.app" }
              : {},
          },
        });
      },
    });

    await expect(adapter.checkpoint()).resolves.toEqual({
      checkpointPath: "/tmp/checkpoint.tracktionedit",
      priorAppPath: "/Applications/Mosh.app",
    });
    await adapter.stopTransport();
    await adapter.releaseAudio();
    expect(commands).toEqual([
      { command: "create_repair_checkpoint", args: {}, authorization: "Bearer owner-capability" },
      { command: "set_transport", args: { action: "stop" }, authorization: "Bearer owner-capability" },
      { command: "release_audio_device", args: {}, authorization: "Bearer owner-capability" },
    ]);
    expect(runner.calls).toEqual([]);
  });

  it("hands the stable repair id to the signed installed-app launcher", async () => {
    const runner = new FakeRunner();
    const artifacts = new NativeRepairArtifactPolicy();
    vi.spyOn(artifacts, "validateBuild").mockResolvedValue("/worktree/build/Mosh.app");
    const adapter = new RepairControlAdapter(runner, "/signed/helper", {
      endpoint: "http://127.0.0.1:49152",
      capability: "owner-capability",
      helperTeamId: "AB12CD34EF",
    }, artifacts);

    await adapter.handoffRepairBuild({
      repairId: "11111111-1111-4111-8111-111111111111",
      buildPath: "/worktree/build/Mosh.app",
      worktreePath: "/worktree",
      sourceSha: "a".repeat(40),
      checkpointPath: "/tmp/checkpoint.tracktionedit",
    });

    expect(runner.calls).toEqual([
      [
        "/usr/bin/codesign",
        "--verify",
        "--strict",
        "--verbose=2",
        "-R=identifier \"MoshRepairHelper\" and certificate leaf[subject.OU] = \"AB12CD34EF\"",
        "/signed/helper",
      ],
      [
        "/signed/helper",
        "handoff-repair",
        "/worktree/build/Mosh.app",
        "/worktree",
        "a".repeat(40),
        "/tmp/checkpoint.tracktionedit",
        "11111111-1111-4111-8111-111111111111",
        String(process.ppid),
      ],
    ]);
  });

  it("hands durable rolled-back repair metadata to the signed prior-app launcher", async () => {
    const runner = new FakeRunner();
    const adapter = new RepairControlAdapter(runner, "/signed/helper", {
      endpoint: "http://127.0.0.1:49152",
      capability: "owner-capability",
      helperTeamId: "AB12CD34EF",
    });

    await adapter.handoffPriorApp({
      checkpointPath: "/tmp/checkpoint.tracktionedit",
      priorAppPath: "/Applications/Mosh.app",
      repairId: "11111111-1111-4111-8111-111111111111",
      buildPath: "/worktree/build/Mosh.app",
    });

    expect(runner.calls).toEqual([
      [
        "/usr/bin/codesign",
        "--verify",
        "--strict",
        "--verbose=2",
        "-R=identifier \"MoshRepairHelper\" and certificate leaf[subject.OU] = \"AB12CD34EF\"",
        "/signed/helper",
      ],
      [
        "/signed/helper",
        "handoff-prior",
        "/tmp/checkpoint.tracktionedit",
        "/Applications/Mosh.app",
        "11111111-1111-4111-8111-111111111111",
        "/worktree/build/Mosh.app",
        String(process.ppid),
      ],
    ]);
  });

  it("rejects a helper that does not satisfy the Mosh team and identifier requirement", async () => {
    const runner = new FakeRunner();
    runner.responses.push({ exitCode: 1, stdout: "", stderr: "designated requirement failed" });
    const artifacts = new NativeRepairArtifactPolicy();
    vi.spyOn(artifacts, "validateBuild").mockResolvedValue("/worktree/build/Mosh.app");
    const adapter = new RepairControlAdapter(runner, "/substituted/helper", {
      endpoint: "http://127.0.0.1:49152",
      capability: "owner-capability",
      helperTeamId: "AB12CD34EF",
    }, artifacts);

    await expect(adapter.handoffRepairBuild({
      repairId: "11111111-1111-4111-8111-111111111111",
      buildPath: "/worktree/build/Mosh.app",
      worktreePath: "/worktree",
      sourceSha: "a".repeat(40),
      checkpointPath: "/tmp/checkpoint.tracktionedit",
    })).rejects.toMatchObject({ code: "repair_helper_identity" });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toContain("-R=identifier \"MoshRepairHelper\" and certificate leaf[subject.OU] = \"AB12CD34EF\"");
  });

  it("surfaces only the bounded helper failure code from a rejected handoff", async () => {
    const runner = new FakeRunner();
    runner.responses.push(
      { exitCode: 0, stdout: "", stderr: "" },
      {
        exitCode: 1,
        stdout: "",
        stderr: '{"ok":false,"code":"caller_chain_invalid","message":"Repair helper validation failed"}\nprivate path',
      },
    );
    const artifacts = new NativeRepairArtifactPolicy();
    vi.spyOn(artifacts, "validateBuild").mockResolvedValue("/worktree/build/Mosh.app");
    const adapter = new RepairControlAdapter(runner, "/signed/helper", {
      endpoint: "http://127.0.0.1:49152",
      capability: "owner-capability",
      helperTeamId: "AB12CD34EF",
    }, artifacts);

    await expect(adapter.handoffRepairBuild({
      repairId: "11111111-1111-4111-8111-111111111111",
      buildPath: "/worktree/build/Mosh.app",
      worktreePath: "/worktree",
      sourceSha: "a".repeat(40),
      checkpointPath: "/tmp/checkpoint.tracktionedit",
    })).rejects.toMatchObject({
      code: "repair_helper_caller_chain_invalid",
      message: "Repair process action failed: handoff-repair",
    });
  });

  it("falls back when the helper failure line exceeds the diagnostic bound", async () => {
    const runner = new FakeRunner();
    runner.responses.push(
      { exitCode: 0, stdout: "", stderr: "" },
      {
        exitCode: 1,
        stdout: "",
        stderr: JSON.stringify({ ok: false, code: "usage", padding: "x".repeat(4_096) }),
      },
    );
    const artifacts = new NativeRepairArtifactPolicy();
    vi.spyOn(artifacts, "validateBuild").mockResolvedValue("/worktree/build/Mosh.app");
    const adapter = new RepairControlAdapter(runner, "/signed/helper", {
      endpoint: "http://127.0.0.1:49152",
      capability: "owner-capability",
      helperTeamId: "AB12CD34EF",
    }, artifacts);

    await expect(adapter.handoffRepairBuild({
      repairId: "11111111-1111-4111-8111-111111111111",
      buildPath: "/worktree/build/Mosh.app",
      worktreePath: "/worktree",
      sourceSha: "a".repeat(40),
      checkpointPath: "/tmp/checkpoint.tracktionedit",
    })).rejects.toMatchObject({ code: "repair_process_failed" });
  });
});

describe("Codex app-server JSON-RPC adapter", () => {
  it("initializes current protocol and starts constrained coordinator and repair threads", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const transport: JsonRpcTransport = {
      request: async (method, params) => {
        requests.push({ method, params });
        if (method === "thread/start") {
          const thread = params as {
            cwd: string;
            sandbox: "read-only" | "workspace-write";
            approvalPolicy: string;
          };
          return {
            thread: { id: `thread-${requests.length}` },
            cwd: thread.cwd,
            model: "gpt-5",
            modelProvider: "openai",
            approvalPolicy: thread.approvalPolicy,
            approvalsReviewer: "user",
            sandbox: thread.sandbox === "read-only"
              ? { type: "readOnly", networkAccess: false }
              : {
                  type: "workspaceWrite",
                  networkAccess: false,
                  writableRoots: [thread.cwd],
                  excludeTmpdirEnvVar: true,
                  excludeSlashTmp: true,
                },
          };
        }
        if (method === "turn/start") return { turn: { id: "turn-1" } };
        return {};
      },
      onNotification: () => () => undefined,
      onServerRequest: () => () => undefined,
    };
    const adapter = new CodexAppServerAdapter(transport);
    await adapter.initialize();
    const coordinator = await adapter.startThread({ mode: "read-only", cwd: "/repo" });
    const repair = await adapter.startThread({ mode: "workspace-write", cwd: "/worktree" });
    await adapter.startTurn({
      threadId: repair,
      prompt: "repair only this report",
      mode: "workspace-write",
      cwd: "/worktree",
    });

    expect(coordinator).toBe("thread-2");
    expect(requests).toEqual([
      {
        method: "initialize",
        params: {
          clientInfo: { name: "mosh-owner-cockpit", title: "Mosh Owner Cockpit", version: "1" },
          capabilities: { experimentalApi: false },
        },
      },
      {
        method: "thread/start",
        params: { cwd: "/repo", sandbox: "read-only", approvalPolicy: "never" },
      },
      {
        method: "thread/start",
        params: {
          cwd: "/worktree",
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          config: {
            sandbox_workspace_write: {
              network_access: false,
              writable_roots: ["/worktree"],
              exclude_tmpdir_env_var: true,
              exclude_slash_tmp: true,
            },
          },
        },
      },
      {
        method: "turn/start",
        params: {
          threadId: repair,
          input: [{ type: "text", text: "repair only this report" }],
          sandboxPolicy: {
            type: "workspaceWrite",
            networkAccess: false,
            writableRoots: ["/worktree"],
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true,
          },
        },
      },
    ]);
  });
});
