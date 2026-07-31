import { spawn as nodeSpawn } from "node:child_process";
import { z } from "zod";
import type { AppServerAdapter, AppServerEvent } from "./orchestration.js";
import {
  StdioJsonRpcTransport,
  type JsonRpcTransport,
  type ServerRequest,
  type StdioChild,
} from "./json-rpc-transport.js";

export { StdioJsonRpcTransport } from "./json-rpc-transport.js";
export type { JsonRpcTransport, StdioChild } from "./json-rpc-transport.js";

export type CodexSpawn = (
  command: string,
  args: readonly string[],
  options: { stdio: ["pipe", "pipe", "pipe"]; env: NodeJS.ProcessEnv },
) => StdioChild;

const runtimeEnvironmentKeys = [
  "PATH",
  "HOME",
  "TMPDIR",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

export function codexChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(runtimeEnvironmentKeys.flatMap((key) => {
    const value = source[key];
    return typeof value === "string" ? [[key, value]] : [];
  }));
}

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

const approvalRequest = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  itemId: z.string().min(1),
  startedAtMs: z.number(),
}).passthrough();

const threadStarted = z.object({
  thread: z.object({ id: z.string().min(1) }),
  cwd: z.string().min(1),
  model: z.string().min(1),
  modelProvider: z.string().min(1),
  approvalPolicy: z.string(),
  approvalsReviewer: z.string().min(1),
  sandbox: z.discriminatedUnion("type", [
    z.object({ type: z.literal("readOnly"), networkAccess: z.literal(false) }),
    z.object({
      type: z.literal("workspaceWrite"),
      networkAccess: z.literal(false),
      writableRoots: z.array(z.string()),
      excludeTmpdirEnvVar: z.literal(true),
      excludeSlashTmp: z.literal(true),
    }),
  ]),
}).passthrough();
const turnStarted = z.object({ turn: z.object({ id: z.string().min(1) }) });

function policyFailure(): Error & { code: string } {
  return codedError("codex_policy_mismatch", "Codex app-server returned an unsafe effective policy");
}

export class CodexAppServerAdapter implements AppServerAdapter {
  private initialized = false;
  private readonly eventListeners = new Map<
    string,
    (event: AppServerEvent) => Promise<void> | void
  >();

  constructor(private readonly transport: JsonRpcTransport) {
    transport.onServerRequest((request) => this.handleServerRequest(request));
    transport.onNotification((method, params) => this.handleNotification(method, params));
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.transport.request("initialize", {
      clientInfo: { name: "mosh-owner-cockpit", title: "Mosh Owner Cockpit", version: "1" },
      capabilities: { experimentalApi: false },
    });
    this.initialized = true;
  }

  async startThread(
    input: { mode: "read-only" | "workspace-write"; cwd: string },
    onEvent?: (event: AppServerEvent) => Promise<void> | void,
  ): Promise<string> {
    if (!this.initialized) await this.initialize();
    const result = threadStarted.parse(await this.transport.request("thread/start", {
      cwd: input.cwd,
      sandbox: input.mode,
      approvalPolicy: input.mode === "read-only" ? "never" : "on-request",
    }));
    if (result.cwd !== input.cwd) throw policyFailure();
    if (input.mode === "read-only") {
      if (result.approvalPolicy !== "never" || result.sandbox.type !== "readOnly") {
        throw policyFailure();
      }
    } else {
      if (result.approvalPolicy !== "on-request"
        || result.sandbox.type !== "workspaceWrite"
        || result.sandbox.writableRoots.length !== 1
        || result.sandbox.writableRoots[0] !== input.cwd) {
        throw policyFailure();
      }
    }
    if (onEvent) this.eventListeners.set(result.thread.id, onEvent);
    return result.thread.id;
  }

  async startTurn(input: {
    threadId: string;
    prompt: string;
    mode: "read-only" | "workspace-write";
    cwd: string;
  }): Promise<string> {
    const params: Record<string, unknown> = {
      threadId: input.threadId,
      input: [{ type: "text", text: input.prompt }],
    };
    if (input.mode === "workspace-write") {
      params.sandboxPolicy = {
        type: "workspaceWrite",
        networkAccess: false,
        writableRoots: [input.cwd],
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      };
    }
    const result = turnStarted.parse(await this.transport.request("turn/start", params));
    return result.turn.id;
  }

  private async handleServerRequest(request: ServerRequest): Promise<unknown> {
    const supported = new Set([
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
    ]);
    if (!supported.has(request.method)) {
      throw Object.assign(new Error("Method not found"), { rpcCode: -32601 });
    }
    const parsed = approvalRequest.safeParse(request.params);
    if (!parsed.success) {
      throw Object.assign(new Error("Invalid approval request"), { rpcCode: -32602 });
    }
    const permissions = request.method === "item/permissions/requestApproval";
    await this.eventListeners.get(parsed.data.threadId)?.({
      type: "approval",
      data: {
        requestId: request.id,
        method: request.method,
        threadId: parsed.data.threadId,
        turnId: parsed.data.turnId,
        itemId: parsed.data.itemId,
        decision: permissions ? "deny" : "decline",
      },
    });
    return permissions
      ? {
          permissions: { fileSystem: { entries: [] }, network: { enabled: false } },
          scope: "turn",
          strictAutoReview: true,
        }
      : { decision: "decline" };
  }

  private handleNotification(method: string, params: unknown): void {
    if (typeof params !== "object" || params === null || Array.isArray(params)) return;
    const data: Record<string, unknown> = { ...params };
    const threadId = data.threadId;
    if (typeof threadId !== "string") return;
    void this.eventListeners.get(threadId)?.({
      type: method.includes("turn") ? "turn" : method.includes("thread") ? "thread" : "progress",
      data,
    });
  }
}

export function spawnCodexAppServer(options: {
  spawn?: CodexSpawn;
  environment?: NodeJS.ProcessEnv;
} = {}): {
  adapter: CodexAppServerAdapter;
  close(): void;
} {
  const spawnProcess: CodexSpawn = options.spawn ?? ((command, args, spawnOptions) =>
    nodeSpawn(command, [...args], spawnOptions));
  const child = spawnProcess("codex", ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: codexChildEnvironment(options.environment ?? process.env),
  });
  child.stderr.resume();
  return {
    adapter: new CodexAppServerAdapter(new StdioJsonRpcTransport(child)),
    close: () => child.kill("SIGTERM"),
  };
}

export class LazyCodexAppServerAdapter implements AppServerAdapter {
  private process: ReturnType<typeof spawnCodexAppServer> | undefined;

  private adapter(): CodexAppServerAdapter {
    this.process ??= spawnCodexAppServer();
    return this.process.adapter;
  }

  initialize(): Promise<void> {
    return this.adapter().initialize();
  }

  startThread(
    input: { mode: "read-only" | "workspace-write"; cwd: string },
    onEvent?: (event: AppServerEvent) => Promise<void> | void,
  ): Promise<string> {
    return this.adapter().startThread(input, onEvent);
  }

  startTurn(input: {
    threadId: string;
    prompt: string;
    mode: "read-only" | "workspace-write";
    cwd: string;
  }): Promise<string> {
    return this.adapter().startTurn(input);
  }

  close(): void {
    this.process?.close();
    this.process = undefined;
  }
}
