// Thin HTTP client to the Mosh companion server. Same-origin (the page is served by that
// server), so paths are relative. Auth token comes from the paired URL `payload` (base64 JSON,
// as the existing web companion does) or a raw `?token=` (dev lab-feed). The token rides in the
// POST body — the server's authorizeRequest(body) reads it there.

import type { Cmd, Snap } from "./types";
import type { Plan } from "./commandMap";

export type Pairing = { token: string; host?: string; port?: number };

export function parsePairing(href: string): Pairing {
  const url = new URL(href);
  const payload = url.searchParams.get("payload");
  if (payload) {
    const p = JSON.parse(atob(decodeURIComponent(payload))) as Pairing;
    if (!p?.token) throw new Error("pairing payload has no token");
    return p;
  }
  const token = url.searchParams.get("token"); // dev lab-feed
  if (token) return { token };
  throw new Error("Not paired — scan the Mosh Web QR from the Mac.");
}

export class CompanionNet {
  constructor(private pairing: Pairing) {}

  private async post<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, token: this.pairing.token }),
    });
    const json = (await res.json()) as { ok?: boolean; data?: T; error?: string };
    if (!json.ok) throw new Error(json.error || `${path} failed`);
    return json.data as T;
  }

  snapshot(): Promise<Snap> {
    return this.post<Snap>("/snapshot");
  }

  events(since: number): Promise<{ events?: unknown[]; latestSeq?: number }> {
    return this.post("/events", { since });
  }

  /** Run one command; stamps issuedAtPhoneMs for latency/audit parity with the native app. */
  command(cmd: Cmd): Promise<{ ok?: boolean; error?: string }> {
    const args = { ...cmd.args, issuedAtPhoneMs: Date.now() };
    return this.post("/command", { command: { command: cmd.command, args } });
  }

  /** Run a plan's commands in order; resolves with the last result (or a blocked note). */
  async runPlan(plan: Plan): Promise<{ ok: boolean; note?: string }> {
    if (plan.blockedReason) return { ok: false, note: plan.blockedReason };
    let last: { ok?: boolean; error?: string } = { ok: true };
    for (const cmd of plan.cmds) last = await this.command(cmd);
    return { ok: last.ok !== false, note: last.error };
  }
}
