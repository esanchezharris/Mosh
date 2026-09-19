import { actionResponseSchema, stateSchema, tokenSchema } from "./contract";
import type { Command, Token } from "./contract";
import { z } from "zod";

export class TransportError extends Error {
  readonly name = "TransportError";
  constructor(readonly kind: "network" | "auth" | "protocol" | "http" | "rejected", readonly status = 0) {
    super(kind === "auth" ? "Pair again from Mosh." : kind === "rejected" ? "Action rejected by Mosh. Refresh the state before trying again." : `Connection ${kind}${status ? ` (${status})` : ""}.`);
  }
}

export function consumeToken(location: Location, history: History): Token | null {
  const fragment = location.hash;
  if (fragment) history.replaceState(null, "", `${location.pathname}${location.search}`);
  const parsed = tokenSchema.safeParse(new URLSearchParams(fragment.slice(1)).get("token"));
  return parsed.success ? parsed.data : null;
}

export class PadTransport {
  constructor(private readonly token: Token) {}

  async read(signal: AbortSignal) {
    const response = await this.request("/api/state", { signal });
    return this.decode(response, stateSchema);
  }

  async submit(command: Command) {
    const response = await this.request("/api/action", {
      method: "POST", body: JSON.stringify(command),
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(2500),
    });
    return this.decode(response, actionResponseSchema);
  }

  private async request(path: string, options: RequestInit): Promise<Response> {
    try {
      return await fetch(path, {
        ...options, credentials: "omit", cache: "no-store", redirect: "error",
        headers: { ...options.headers, Authorization: `Bearer ${this.token}` },
      });
    } catch (error) {
      if (error instanceof Error) throw new TransportError("network");
      throw error;
    }
  }

  private async decode<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
    if (response.status === 401 || response.status === 403) throw new TransportError("auth", response.status);
    if (!response.ok) throw new TransportError("http", response.status);
    try {
      const value: unknown = await response.json();
      const result = schema.safeParse(value);
      if (result.success) return result.data;
      if (z.object({ error: z.string() }).safeParse(value).success) throw new TransportError("rejected");
      throw new TransportError(response.ok ? "protocol" : "http", response.status);
    } catch (error) {
      if (error instanceof TransportError) throw error;
      if (error instanceof Error) throw new TransportError(response.ok ? "protocol" : "http", response.status);
      throw error;
    }
  }
}
