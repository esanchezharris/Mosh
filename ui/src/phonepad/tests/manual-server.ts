import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { actionSchema, receiptSchema } from "../src/contract";
import { ready } from "./fixture";

const html = await readFile(new URL("../../../phonepad-dist/index.html", import.meta.url));
const commandSchema = z.object({ requestId: z.string(), action: actionSchema, targetId: z.string().optional(), bar: z.number().optional() });
let state = ready;
const server = createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (request.url === "/pad") { response.setHeader("Content-Type", "text/html"); response.end(html); return; }
  response.setHeader("Content-Type", "application/json");
  if (request.headers.authorization !== `Bearer ${"a".repeat(64)}`) { response.writeHead(401); response.end("{}"); return; }
  if (request.url === "/api/state") { response.end(JSON.stringify(state)); return; }
  if (request.url !== "/api/action" || request.method !== "POST") { response.writeHead(404); response.end("{}"); return; }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  const raw: unknown = JSON.parse(Buffer.concat(chunks).toString());
  const command = commandSchema.safeParse(raw);
  if (!command.success) { response.writeHead(400); response.end("{}"); return; }
  const receipt = receiptSchema.parse({ requestId: command.data.requestId, action: command.data.action,
    status: "completed", detail: `Fixture received ${command.data.action}${command.data.targetId ? ` for ${command.data.targetId}` : ""}. No host action occurred.`,
    submittedMs: 1, completedMs: 2, actionId: "fixture", targetId: command.data.targetId ?? null });
  state = { ...state, receipts: [...state.receipts, receipt], listening: { ...state.listening, bar: command.data.bar ?? state.listening.bar } };
  response.end(JSON.stringify({ version: 1, receipt, state }));
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address !== null && typeof address !== "string") process.stdout.write(`Fixture only: http://127.0.0.1:${address.port}/pad\n`);
});
process.on("SIGINT", () => server.close());
