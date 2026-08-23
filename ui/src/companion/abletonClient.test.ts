import { describe, expect, it } from "vitest";
import { AbletonHttpClient, type HttpRequest } from "./abletonClient";
import { AbletonActionRequestSchema } from "./abletonSchema";

const state = {
  revision: 2,
  connection: "connected",
  transport: "stopped",
  editMarkerBeats: 0,
  activeSource: null,
  passStartBeats: null,
  savedStopBeats: null,
  pendingClip: null,
  archiveClips: [],
  blockedReason: null,
  ownershipUncertain: false,
};

describe("AbletonHttpClient", () => {
  it("uses bearer authentication for the snapshot boundary", async () => {
    // Given
    const calls: { readonly input: RequestInfo | URL; readonly init?: RequestInit }[] = [];
    const request: HttpRequest = async (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      return new Response(JSON.stringify({ ok: true, requestId: "", revision: 2, state }));
    };
    const client = new AbletonHttpClient("launch-token", request);

    // When
    await client.snapshot();

    // Then
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("/v1/snapshot");
    expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe("Bearer launch-token");
  });

  it("posts one strict semantic action body", async () => {
    // Given
    const bodies: unknown[] = [];
    const request: HttpRequest = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, requestId: "request-2", revision: 2, state }));
    };
    const client = new AbletonHttpClient("launch-token", request);
    const action = AbletonActionRequestSchema.parse({ requestId: "request-2", expectedRevision: 2, action: "stop" });

    // When
    await client.action(action);

    // Then
    expect(bodies).toEqual([{ requestId: "request-2", expectedRevision: 2, action: "stop" }]);
  });

  it("rejects malformed JSON at the network boundary", async () => {
    // Given
    const request: HttpRequest = async () => new Response(JSON.stringify({ ok: true, revision: 2, state }));
    const client = new AbletonHttpClient("launch-token", request);

    // When / Then
    await expect(client.snapshot()).rejects.toThrow();
  });
});
