import { z } from "zod";

export type StdioChild = {
  stdin: { write(line: string): boolean };
  stdout: {
    setEncoding(encoding: string): void;
    on(event: "data", listener: (chunk: string) => void): unknown;
  };
  stderr: { resume(): void };
  once(event: "exit", listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
};

type PendingRpc = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

export type ServerRequest = {
  id: RequestId;
  method: string;
  params: unknown;
};

export type RequestId = string | number;

export interface JsonRpcTransport {
  request(method: string, params: unknown): Promise<unknown>;
  onNotification(listener: (method: string, params: unknown) => void): () => void;
  onServerRequest(listener: (request: ServerRequest) => Promise<unknown>): () => void;
}

const rpcEnvelope = z.object({
  id: z.union([z.string(), z.number().int()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export class StdioJsonRpcTransport implements JsonRpcTransport {
  private nextId = 1;
  private readonly pending = new Map<RequestId, PendingRpc>();
  private readonly listeners = new Set<(method: string, params: unknown) => void>();
  private requestListener: ((request: ServerRequest) => Promise<unknown>) | undefined;
  private buffer = "";

  constructor(private readonly child: StdioChild) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.accept(chunk));
    child.once("exit", () => {
      for (const pending of this.pending.values()) {
        pending.reject(codedError("codex_app_server_stopped", "Codex app-server stopped"));
      }
      this.pending.clear();
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onServerRequest(listener: (request: ServerRequest) => Promise<unknown>): () => void {
    this.requestListener = listener;
    return () => {
      if (this.requestListener === listener) this.requestListener = undefined;
    };
  }

  private write(envelope: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(envelope)}\n`);
  }

  private accept(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) void this.acceptLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private async acceptLine(line: string): Promise<void> {
    let decoded: unknown;
    try {
      decoded = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    const envelope = rpcEnvelope.safeParse(decoded);
    if (!envelope.success) return;
    const { id, method, params, result, error } = envelope.data;
    if (id !== undefined && method) {
      if (!this.requestListener) {
        this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
        return;
      }
      try {
        const response = await this.requestListener({ id, method, params });
        this.write({ jsonrpc: "2.0", id, result: response });
      } catch (requestError) {
        const rpcError = requestError as Error & { rpcCode?: number };
        this.write({
          jsonrpc: "2.0",
          id,
          error: { code: rpcError.rpcCode ?? -32603, message: rpcError.message },
        });
      }
      return;
    }
    if (id !== undefined) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (error) pending.reject(codedError("codex_rpc_error", error.message));
      else pending.resolve(result);
      return;
    }
    if (method) {
      for (const listener of this.listeners) listener(method, params);
    }
  }
}
