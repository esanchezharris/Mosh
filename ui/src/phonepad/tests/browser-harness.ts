import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { actionSchema, receiptSchema } from "../src/contract";
import type { State } from "../src/contract";
import { ready } from "./fixture";

const commandSchema = z.object({
  version: z.literal(1), requestId: z.string(), sessionId: z.string(),
  projectId: z.string(), authority: z.string(), action: actionSchema,
  targetId: z.string().optional(), bar: z.number().optional(), leadQn: z.number().optional(),
});
export type WireCommand = z.infer<typeof commandSchema>;
export const testToken = "a".repeat(64);

export async function staticServer() {
  const html = await readFile(new URL("../../../phonepad-dist/index.html", import.meta.url));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("Missing test server address");
  return { url: `http://127.0.0.1:${address.port}/pad`, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

export class WireFixture {
  state: State = ready;
  readonly commands: WireCommand[] = [];
  polls = 0;
  stateStatus = 200;
  actionMode: "complete" | "lost" | "accepted" = "complete";
  authValid = true;

  async attach(page: Page): Promise<void> {
    await page.route("**/api/state", async (route) => {
      this.polls += 1;
      this.authValid = this.authValid && route.request().headers()["authorization"] === `Bearer ${testToken}`;
      await route.fulfill({ status: this.stateStatus, json: this.state });
    });
    await page.route("**/api/action", async (route) => {
      this.authValid = this.authValid && route.request().headers()["authorization"] === `Bearer ${testToken}`;
      const raw: unknown = route.request().postDataJSON();
      const command = commandSchema.parse(raw);
      this.commands.push(command);
      if (this.actionMode === "lost") { await route.abort(); return; }
      const receipt = receiptSchema.parse({ requestId: command.requestId, action: command.action,
        status: this.actionMode === "accepted" ? "accepted" : "completed", detail: "Action received", submittedMs: 1,
        completedMs: this.actionMode === "accepted" ? null : 2, actionId: "action-1", targetId: command.targetId ?? null });
      this.state = { ...this.state, receipts: [...this.state.receipts, receipt] };
      await route.fulfill({ json: { version: 1, receipt, state: this.state } });
    });
  }

  completeLast(): void {
    const command = this.commands.at(-1);
    if (command === undefined) throw new TypeError("No command to complete");
    const receipt = receiptSchema.parse({ requestId: command.requestId, action: command.action,
      status: "completed", detail: "Recovered from receipt", submittedMs: 1, completedMs: 2,
      actionId: "action-recovered", targetId: command.targetId ?? null });
    this.state = { ...this.state, receipts: [...this.state.receipts, receipt] };
  }
}
