import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PlaytestStore } from "../src/persistence.js";
import { AgentHostService } from "../src/service.js";
import { startAgentHost } from "../src/server.js";
import {
  codexChildEnvironment,
  spawnCodexAppServer,
  StdioJsonRpcTransport,
  type CodexSpawn,
  type RequestId,
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
  private readonly responseWaiters = new Map<RequestId, () => void>();
  readonly stdin = {
    write: (line: string, callback?: (error?: Error | null) => void) => {
      if (this.failWrites) {
        callback?.(new Error("stdin closed"));
        return false;
      }
      const envelope = JSON.parse(line) as Record<string, unknown>;
      this.writes.push(envelope);
      const id = envelope.id;
      if (!envelope.method && (typeof id === "string" || typeof id === "number")) {
        this.responseWaiters.get(id)?.();
        this.responseWaiters.delete(id);
      }
      callback?.();
      return true;
    },
  };
  failWrites = false;

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

  notification(method: string, params: unknown): void {
    this.stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  serverRequest(id: RequestId, method: string, params: unknown): Promise<void> {
    const completed = new Promise<void>((resolve) => {
      this.responseWaiters.set(id, resolve);
    });
    this.stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return completed;
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
    await Promise.all([
      child.serverRequest(91, "item/commandExecution/requestApproval", {
        ...common, command: "rm -rf /", cwd: "/repo",
      }),
      child.serverRequest(92, "item/fileChange/requestApproval", {
        ...common, grantRoot: "/outside",
      }),
      child.serverRequest(93, "item/permissions/requestApproval", {
        ...common,
        cwd: "/repo",
        permissions: { network: { enabled: true } },
      }),
    ]);

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

  it("persists a string-ID approval event and echoes the exact string ID in its response", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mosh-string-request-id-"));
    const store = new PlaytestStore(root);
    const service = new AgentHostService(store);
    await service.initialize();
    const playtest = await service.createPlaytest({});
    const child = new FakeChild();
    const process = spawnCodexAppServer({ spawn: () => child, environment: {} });
    const initializing = process.adapter.initialize();
    child.reply(1, {});
    await initializing;
    const starting = process.adapter.startThread(
      { mode: "read-only", cwd: "/repo" },
      async (event) => {
        await service.emit(playtest.id, `codex.${event.type}`, { ...event.data });
      },
    );
    child.reply(2, coordinatorThread);
    await starting;

    await child.serverRequest("approval-request-alpha", "item/fileChange/requestApproval", {
      threadId: "coordinator-thread",
      turnId: "turn-string",
      itemId: "item-string",
      startedAtMs: 123,
    });
    expect((await store.loadEvents(playtest.id)).at(-1)).toMatchObject({
      type: "codex.approval",
      data: {
        requestId: "approval-request-alpha",
        method: "item/fileChange/requestApproval",
        decision: "decline",
      },
    });
    expect(child.writes.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: "approval-request-alpha",
      result: { decision: "decline" },
    });
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

    await child.serverRequest(94, "item/commandExecution/requestApproval", {
      threadId: "coordinator-thread",
      turnId: "turn-c",
      itemId: "item-c",
      startedAtMs: 123,
    });
    expect(coordinatorEvents).toHaveLength(1);
    expect(repairEvents).toHaveLength(0);
    process.close();
  });

  it("persists and streams only the bounded notification DTO from hostile Codex output", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mosh-hostile-notification-"));
    const store = new PlaytestStore(root);
    const service = new AgentHostService(store);
    await service.initialize();
    const playtest = await service.createPlaytest({});
    const child = new FakeChild();
    const process = spawnCodexAppServer({ spawn: () => child, environment: {} });
    const initializing = process.adapter.initialize();
    child.reply(1, {});
    await initializing;
    const starting = process.adapter.startThread(
      { mode: "read-only", cwd: "/repo" },
      async (event) => {
        await service.emit(playtest.id, `codex.${event.type}`, { ...event.data });
      },
    );
    child.reply(2, coordinatorThread);
    await starting;

    child.notification("turn/progress", {
      threadId: "coordinator-thread",
      turnId: "turn-7",
      itemId: "item-9",
      status: "running",
      count: 4,
      output: "project /Users/owner/song.mosh Bearer hostile-token",
      diff: "OPENAI_API_KEY=sk-hostile-secret",
      content: "data:image/png;base64,AAAA",
      path: "/Users/owner/audio.wav",
      prompt: "private owner prompt",
      image: "A".repeat(100_000),
    });
    await vi.waitFor(async () => {
      expect(await store.loadEvents(playtest.id)).toHaveLength(2);
    });
    const notification = (await store.loadEvents(playtest.id)).at(-1);
    expect(notification).toMatchObject({
      type: "codex.turn",
      data: {
        method: "turn/progress",
        type: "turn",
        threadId: "coordinator-thread",
        turnId: "turn-7",
        itemId: "item-9",
        status: "running",
        count: 4,
      },
    });
    expect(Object.keys(notification?.data ?? {}).sort()).toEqual(
      ["count", "itemId", "method", "status", "threadId", "turnId", "type"].sort(),
    );

    const eventsPath = path.join(store.sessionDirectory(playtest.id), "events.jsonl");
    const durable = await readFile(eventsPath, "utf8");
    expect(durable).not.toMatch(/song\.mosh|audio\.wav|base64|private owner prompt|sk-hostile|Bearer|A{100}/u);

    const host = await startAgentHost({ service, capability: "test-capability", port: 0 });
    const response = await fetch(
      `${host.origin}/v1/playtests/${playtest.id}/events?afterSequence=1&windowMs=1`,
      { headers: { Authorization: "Bearer test-capability" } },
    );
    const stream = await response.text();
    expect(stream).toContain('"method":"turn/progress"');
    expect(stream).not.toMatch(/song\.mosh|audio\.wav|base64|private owner prompt|sk-hostile|Bearer|A{100}/u);
    await host.close();
    process.close();
  });

  it("returns JSON-RPC errors for malformed server requests and rejects pending calls on child exit", async () => {
    const child = new FakeChild();
    const process = spawnCodexAppServer({ spawn: () => child, environment: {} });
    await child.serverRequest(
      71,
      "item/fileChange/requestApproval",
      { itemId: "missing-correlations" },
    );
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

  it("rejects and removes a nonresponding request at its deadline", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const transport = new StdioJsonRpcTransport(child, 25);
    const pending = transport.request("never/replies", {});
    const rejection = expect(pending).rejects.toMatchObject({ code: "codex_rpc_timeout" });

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    vi.useRealTimers();
  });

  it("rejects a failed child-stdin write and leaves later requests usable", async () => {
    const child = new FakeChild();
    const transport = new StdioJsonRpcTransport(child, 100);
    child.failWrites = true;
    await expect(transport.request("write/fails", {})).rejects.toMatchObject({
      code: "codex_rpc_write_failed",
      message: "stdin closed",
    });

    child.failWrites = false;
    const recovered = transport.request("write/works", {});
    child.reply(2, { ok: true });
    await expect(recovered).resolves.toEqual({ ok: true });
  });
});
