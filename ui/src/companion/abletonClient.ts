import { AbletonEnvelopeSchema, type AbletonActionRequest, type AbletonEnvelope } from "./abletonSchema";

export type HttpRequest = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class AbletonHttpClient {
  readonly #authorization: string;
  readonly #request: HttpRequest;

  constructor(token: string, request: HttpRequest = globalThis.fetch.bind(globalThis)) {
    this.#authorization = `Bearer ${token}`;
    this.#request = request;
  }
  async snapshot(): Promise<AbletonEnvelope> {
    return this.#send("/v1/snapshot", { method: "GET" });
  }
  async action(request: AbletonActionRequest): Promise<AbletonEnvelope> {
    return this.#send("/v1/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  }

  async #send(path: string, init: RequestInit): Promise<AbletonEnvelope> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", this.#authorization);
    const response = await this.#request(path, { ...init, headers });
    const external: unknown = await response.json();
    return AbletonEnvelopeSchema.parse(external);
  }
}
