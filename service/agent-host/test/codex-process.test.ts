import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  codexChildEnvironment,
  spawnCodexAppServer,
  type CodexSpawn,
  type StdioChild,
} from "../src/codex-app-server.js";

class FakeStream extends EventEmitter {
  setEncoding(): void {}
  resume(): void {}
}

class FakeChild extends EventEmitter implements StdioChild {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly writes: Array<Record<string, unknown>> = [];
  readonly stdin = {
    write: (line: string) => {
      this.writes.push(JSON.parse(line) as Record<string, unknown>);
      return true;
    },
  };

  kill(): boolean {
    this.emit("exit", 0);
    return true;
  }

  reply(id: number, result: unknown): void {
    this.stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  rpcError(id: number, message: string): void {
    this.stdout.emit("data", `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message },
    })}\n`);
  }

  serverRequest(id: number, method: string, params: unknown): void {
    this.stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  }
}

const coordinatorThread = {
  thread: { id: "coordinator-thread" },
  model: "gpt-5",
  modelProvider: "openai",
  cwd: "/repo",
  approvalPolicy: "never",
  approvalsReviewer: "user",
  sandbox: { type: "readOnly", networkAccess: false },
};

const repairThread = {
  ...coordinatorThread,
  thread: { id: "repair-thread" },
  cwd: "/worktree",
  approvalPolicy: "on-request",
  sandbox: {
    type: "workspaceWrite",
    networkAccess: false,
    writableRoots: ["/worktree"],
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  },
};

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Codex child process boundary", () => {
  it("uses an explicit runtime allowlist and excludes every service/provider secret", () => {
    const env = codexChildEnvironment({
      PATH: "/usr/bin",
      HOME: "/Users/owner",
      TMPDIR: "/tmp/private",
      LANG: "en_US.UTF-8",
      MOSH_PLAYTEST_EVIDENCE_OWNER_SECRET: "owner-secret",
      MOSH_OTHER_SECRET: "mosh-secret",
      SUPABASE_SERVICE_ROLE_KEY: "service-role",
      OPENAI_API_KEY: "openai-secret",
      DEEPSEEK_API_KEY: "provider-secret",
      XAI_API_KEY: "provider-secret",
      GH_TOKEN: "github-secret",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/owner",
      TMPDIR: "/tmp/private",
      LANG: "en_US.UTF-8",
    });
  });

  it("spawns stdio with the scrubbed env and current initialize/thread/turn policies", async () => {
    const child = new FakeChild();
    let spawnEnv: NodeJS.ProcessEnv | undefined;
    const spawn: CodexSpawn = (_command, _args, options) => {
      spawnEnv = options.env;
      return child;
    };
    const process = spawnCodexAppServer({
      spawn,
      environment: {
        PATH: "/usr/bin",
        HOME: "/Users/owner",
        OPENAI_API_KEY: "never-forward",
        MOSH_PLAYTEST_EVIDENCE_OWNER_SECRET: "never-forward",
      },
    });

    const initializing = process.adapter.initialize();
    expect(child.writes[0]).toMatchObject({ id: 1, method: "initialize" });
    child.reply(1, {});
    await initializing;
    const starting = process.adapter.startThread({ mode: "workspace-write", cwd: "/worktree" });
    child.reply(2, repairThread);
    expect(await starting).toBe("repair-thread");
    const turning = process.adapter.startTurn({
      threadId: "repair-thread",
      prompt: "repair",
      mode: "workspace-write",
      cwd: "/worktree",
    });
    expect(child.writes[2]).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "repair-thread",
        sandboxPolicy: {
          type: "workspaceWrite",
          networkAccess: false,
          writableRoots: ["/worktree"],
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      },
    });
    child.reply(3, { turn: { id: "turn-1" } });
    expect(await turning).toBe("turn-1");
    expect(spawnEnv).toEqual({ PATH: "/usr/bin", HOME: "/Users/owner" });
    process.close();
  });

  it("rejects an effective workspace policy with any extra writable root", async () => {
    const child = new FakeChild();
    const process = spawnCodexAppServer({ spawn: () => child, environment: {} });
    const initializing = process.adapter.initialize();
    child.reply(1, {});
    await initializing;
    const starting = process.adapter.startThread({ mode: "workspace-write", cwd: "/worktree" });
    child.reply(2, {
      ...repairThread,
      sandbox: { ...repairThread.sandbox, writableRoots: ["/worktree", "/repo"] },
    });
    await expect(starting).rejects.toMatchObject({ code: "codex_policy_mismatch" });
    process.close();
  });

  it("correlates and explicitly resolves command, file, and permission approval requests", async () => {
    const child = new FakeChild();
    const process = spawnCodexAppServer({ spawn: () => child, environment: {} });
    const events: unknown[] = [];
    const initializing = process.adapter.initialize();
    child.reply(1, {});
    await initializing;
    const starting = process.adapter.startThread(
      { mode: "read-only", cwd: "/repo" },
      async (event) => { events.push(event); },
    );
    child.reply(2, coordinatorThread);
    await starting;
    const common = {
      threadId: "coordinator-thread",
      turnId: "turn-9",
      itemId: "item-7",
      startedAtMs: 123,
    };
    child.serverRequest(91, "item/commandExecution/requestApproval", {
      ...common, command: "rm -rf /", cwd: "/repo",
    });
    child.serverRequest(92, "item/fileChange/requestApproval", {
      ...common, grantRoot: "/outside",
    });
    child.serverRequest(93, "item/permissions/requestApproval", {
      ...common,
      cwd: "/repo",
      permissions: { network: { enabled: true } },
    });
    await settle();

    expect(events).toEqual([
      {
        type: "approval",
        data: {
          requestId: 91,
          method: "item/commandExecution/requestApproval",
          threadId: "coordinator-thread",
          turnId: "turn-9",
          itemId: "item-7",
          decision: "decline",
        },
      },
      {
        type: "approval",
        data: {
          requestId: 92,
          method: "item/fileChange/requestApproval",
          threadId: "coordinator-thread",
          turnId: "turn-9",
          itemId: "item-7",
          decision: "decline",
        },
      },
      {
        type: "approval",
        data: {
          requestId: 93,
          method: "item/permissions/requestApproval",
          threadId: "coordinator-thread",
          turnId: "turn-9",
          itemId: "item-7",
          decision: "deny",
        },
      },
    ]);
    expect(child.writes.slice(-3)).toEqual([
      { jsonrpc: "2.0", id: 91, result: { decision: "decline" } },
      { jsonrpc: "2.0", id: 92, result: { decision: "decline" } },
      {
        jsonrpc: "2.0",
        id: 93,
        result: {
          permissions: { fileSystem: { entries: [] }, network: { enabled: false } },
          scope: "turn",
          strictAutoReview: true,
        },
      },
    ]);
    process.close();
  });

  it("routes approvals to the callback for their correlated thread only", async () => {
    const child = new FakeChild();
    const process = spawnCodexAppServer({ spawn: () => child, environment: {} });
    const coordinatorEvents: unknown[] = [];
    const repairEvents: unknown[] = [];
    const initializing = process.adapter.initialize();
    child.reply(1, {});
    await initializing;
    const coordinator = process.adapter.startThread(
      { mode: "read-only", cwd: "/repo" },
      (event) => { coordinatorEvents.push(event); },
    );
    child.reply(2, coordinatorThread);
    await coordinator;
    const repair = process.adapter.startThread(
      { mode: "workspace-write", cwd: "/worktree" },
      (event) => { repairEvents.push(event); },
    );
    child.reply(3, repairThread);
    await repair;

    child.serverRequest(94, "item/commandExecution/requestApproval", {
      threadId: "coordinator-thread",
      turnId: "turn-c",
      itemId: "item-c",
      startedAtMs: 123,
    });
    await settle();
    expect(coordinatorEvents).toHaveLength(1);
    expect(repairEvents).toHaveLength(0);
    process.close();
  });

  it("returns JSON-RPC errors for malformed server requests and rejects pending calls on child exit", async () => {
    const child = new FakeChild();
    const process = spawnCodexAppServer({ spawn: () => child, environment: {} });
    child.serverRequest(71, "item/fileChange/requestApproval", { itemId: "missing-correlations" });
    await settle();
    expect(child.writes[0]).toEqual({
      jsonrpc: "2.0",
      id: 71,
      error: { code: -32602, message: "Invalid approval request" },
    });

    const pending = process.adapter.initialize();
    child.emit("exit", 1);
    await expect(pending).rejects.toMatchObject({ code: "codex_app_server_stopped" });
  });

  it("surfaces correlated JSON-RPC errors", async () => {
    const child = new FakeChild();
    const process = spawnCodexAppServer({ spawn: () => child, environment: {} });
    const pending = process.adapter.initialize();
    child.rpcError(1, "bad initialize");
    await expect(pending).rejects.toMatchObject({
      code: "codex_rpc_error",
      message: "bad initialize",
    });
    process.close();
  });
});
