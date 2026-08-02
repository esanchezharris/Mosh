import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer as createNodeServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import {
  AgentHostService,
  OpenAIUnavailableError,
  OrchestrationUnavailableError,
} from "./service.js";

const createPlaytestInput = z.object({ retainTranscript: z.boolean().optional() }).strict();
const closePlaytestInput = z.object({ retainTranscript: z.boolean().optional() }).strict();
const routeId = z.uuid();
const repairCompletionInput = z.object({
  redEvidencePath: z.string().min(1),
  greenEvidencePath: z.string().min(1),
  diagnosticsPath: z.string().min(1),
  bundlePath: z.string().min(1),
  buildPath: z.string().min(1),
  sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
  draftPrUrl: z.url(),
  draft: z.literal(true),
  merged: z.literal(false),
}).strict();
const repairLaunchInput = z.object({ buildPath: z.string().min(1) }).strict();
const repairRollbackInput = z.object({ reason: z.string().trim().min(1).max(2_000) }).strict();

export interface AgentHostServerOptions {
  service: AgentHostService;
  capability?: string;
  port?: number;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value)}\n`);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 1_000_000) throw new Error("Request body exceeds 1 MB");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function authorized(request: IncomingMessage, capability: string): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(header.slice(7));
  const expected = Buffer.from(capability);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function errorStatus(error: unknown): number {
  if (error instanceof OpenAIUnavailableError) return 503;
  if (error instanceof OrchestrationUnavailableError) return 503;
  if (error instanceof z.ZodError || error instanceof SyntaxError) return 400;
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return 404;
  const code = (error as { code?: unknown }).code;
  if (code === "approval_required") return 403;
  if (code === "repair_active" || code === "dirty_base" || code === "base_sha_mismatch") return 409;
  if (code === "github_sync_required" || code === "checkpoint_missing") return 409;
  if (code === "repair_build_mismatch" || code === "repair_swap_state") return 409;
  if (code === "repair_main_transfer_required" || code === "repair_dirty_worktree") return 409;
  return 500;
}

function errorBody(error: unknown): unknown {
  if (error instanceof OpenAIUnavailableError) {
    return { error: { code: error.code, message: error.message, retryable: true } };
  }
  if (error instanceof OrchestrationUnavailableError) {
    return { error: { code: error.code, message: error.message, retryable: false } };
  }
  if (error instanceof z.ZodError) {
    return { error: { code: "invalid_request", message: "Request validation failed", issues: error.issues } };
  }
  const status = errorStatus(error);
  const typedCode = (error as { code?: unknown }).code;
  return {
    error: {
      code: typeof typedCode === "string"
        ? typedCode
        : status === 404 ? "not_found" : status === 400 ? "invalid_request" : "internal_error",
      message: status === 500 ? "Internal server error" : (error as Error).message,
    },
  };
}

export async function startAgentHost(options: AgentHostServerOptions) {
  const capability = options.capability ?? randomBytes(32).toString("base64url");
  await options.service.initialize();
  const server = createNodeServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/health" && request.method === "GET") {
        sendJson(response, 200, { status: "ready", version: 1 });
        return;
      }
      if (url.pathname.startsWith("/v1/") && !authorized(request, capability)) {
        sendJson(response, 401, { error: { code: "unauthorized", message: "Bearer capability required" } });
        return;
      }

      if (url.pathname === "/v1/playtests" && request.method === "POST") {
        sendJson(response, 201, await options.service.createPlaytest(createPlaytestInput.parse(await readBody(request))));
        return;
      }
      const closeMatch = url.pathname.match(/^\/v1\/playtests\/([^/]+)\/close$/);
      if (closeMatch && request.method === "POST") {
        const body = closePlaytestInput.parse(await readBody(request));
        sendJson(response, 200, await options.service.closePlaytest(routeId.parse(closeMatch[1]), body.retainTranscript));
        return;
      }
      if (url.pathname === "/v1/supervisor/turns" && request.method === "POST") {
        sendJson(response, 200, await options.service.supervisorTurn(await readBody(request)));
        return;
      }
      if (url.pathname === "/v1/realtime/client-secret" && request.method === "POST") {
        await readBody(request);
        sendJson(response, 200, await options.service.mintRealtimeSecret());
        return;
      }
      if (url.pathname === "/v1/reports" && request.method === "POST") {
        sendJson(response, 201, await options.service.createReport(await readBody(request)));
        return;
      }
      const reportsMatch = url.pathname.match(/^\/v1\/playtests\/([^/]+)\/reports$/);
      if (reportsMatch && request.method === "GET") {
        sendJson(response, 200, await options.service.listReports(routeId.parse(reportsMatch[1])));
        return;
      }
      const approveMatch = url.pathname.match(/^\/v1\/reports\/([^/]+)\/approve$/);
      if (approveMatch && request.method === "POST") {
        await readBody(request);
        sendJson(response, 200, await options.service.approveReport(routeId.parse(approveMatch[1])));
        return;
      }
      const repairsMatch = url.pathname.match(/^\/v1\/reports\/([^/]+)\/repairs$/);
      if (repairsMatch && request.method === "POST") {
        await readBody(request);
        sendJson(response, 201, await options.service.createRepair(routeId.parse(repairsMatch[1])));
        return;
      }
      const coordinateMatch = url.pathname.match(/^\/v1\/reports\/([^/]+)\/coordinate$/);
      if (coordinateMatch && request.method === "POST") {
        await readBody(request);
        await options.service.coordinateReport(routeId.parse(coordinateMatch[1]));
        sendJson(response, 202, { status: "started" });
        return;
      }
      const completeMatch = url.pathname.match(/^\/v1\/repairs\/([^/]+)\/complete$/);
      if (completeMatch && request.method === "POST") {
        sendJson(response, 200, await options.service.completeRepair(
          routeId.parse(completeMatch[1]),
          repairCompletionInput.parse(await readBody(request)),
        ));
        return;
      }
      const launchMatch = url.pathname.match(/^\/v1\/repairs\/([^/]+)\/launch$/);
      if (launchMatch && request.method === "POST") {
        const body = repairLaunchInput.parse(await readBody(request));
        sendJson(response, 200, await options.service.launchRepairBuild(
          routeId.parse(launchMatch[1]),
          body.buildPath,
        ));
        return;
      }
      const rollbackMatch = url.pathname.match(/^\/v1\/repairs\/([^/]+)\/rollback$/);
      if (rollbackMatch && request.method === "POST") {
        const body = repairRollbackInput.parse(await readBody(request));
        sendJson(response, 200, await options.service.rollbackRepair(
          routeId.parse(rollbackMatch[1]),
          body.reason,
        ));
        return;
      }
      const eventsMatch = url.pathname.match(/^\/v1\/playtests\/([^/]+)\/events$/);
      if (eventsMatch && request.method === "GET") {
        const playtestId = routeId.parse(eventsMatch[1]);
        await options.service.store.loadSession(playtestId);
        const events = await options.service.store.loadEvents(playtestId);
        const afterSequence = Math.max(0, Number(url.searchParams.get("afterSequence") ?? 0) || 0);
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const lastId = request.headers["last-event-id"];
        const lastIndex = typeof lastId === "string" ? events.findIndex((event) => event.id === lastId) : -1;
        const replay = lastIndex >= 0
          ? events.slice(lastIndex + 1)
          : events.filter((event) => event.sequence > afterSequence);
        for (const event of replay) {
          response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }
        const listener = (event: unknown) => {
          const audit = event as { id: string; type: string; sequence: number };
          if (audit.sequence <= afterSequence) return;
          response.write(`id: ${audit.id}\nevent: ${audit.type}\ndata: ${JSON.stringify(event)}\n\n`);
        };
        options.service.events.on(playtestId, listener);
        request.on("close", () => options.service.events.off(playtestId, listener));
        const windowMs = Math.min(1_000, Math.max(0, Number(url.searchParams.get("windowMs") ?? 0) || 0));
        if (windowMs > 0) {
          setTimeout(() => {
            options.service.events.off(playtestId, listener);
            response.end();
          }, windowMs);
        }
        return;
      }
      sendJson(response, 404, { error: { code: "not_found", message: "Route not found" } });
    } catch (error) {
      sendJson(response, errorStatus(error), errorBody(error));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    capability,
    host: address.address,
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
