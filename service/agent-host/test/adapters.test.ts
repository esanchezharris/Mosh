import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CodexAppServerAdapter,
  EdgeFunctionEvidenceAdapter,
  GhGitHubAdapter,
  type CommandResult,
  type CommandRunner,
  type JsonRpcTransport,
} from "../src/adapters.js";

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
});

describe("Codex app-server JSON-RPC adapter", () => {
  it("initializes current protocol and starts constrained coordinator and repair threads", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const transport: JsonRpcTransport = {
      request: async (method, params) => {
        requests.push({ method, params });
        if (method === "thread/start") return { thread: { id: `thread-${requests.length}` } };
        if (method === "turn/start") return { turn: { id: "turn-1" } };
        return {};
      },
      onNotification: () => () => undefined,
    };
    const adapter = new CodexAppServerAdapter(transport);
    await adapter.initialize();
    const coordinator = await adapter.startThread({ mode: "read-only", cwd: "/repo" });
    const repair = await adapter.startThread({ mode: "workspace-write", cwd: "/worktree" });
    await adapter.startTurn({ threadId: repair, prompt: "repair only this report" });

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
        params: { cwd: "/worktree", sandbox: "workspace-write", approvalPolicy: "on-request" },
      },
      {
        method: "turn/start",
        params: { threadId: repair, input: [{ type: "text", text: "repair only this report" }] },
      },
    ]);
  });
});
