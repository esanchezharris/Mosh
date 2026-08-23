import { describe, expect, it } from "vitest";
import { AbletonActionRequestSchema, AbletonEnvelopeSchema, AbletonSnapshotSchema } from "./abletonSchema";
import { AbletonAdapter, type AbletonBoundary } from "./adapter";

function snapshotAt(revision: number) {
  return AbletonSnapshotSchema.parse({
    revision,
    connection: "connected",
    transport: "stopped",
    editMarkerBeats: revision,
    activeSource: null,
    passStartBeats: null,
    savedStopBeats: null,
    pendingClip: null,
    archiveClips: [],
    blockedReason: null,
    ownershipUncertain: false,
  });
}

function success(requestId: string, revision: number) {
  return AbletonEnvelopeSchema.parse({ ok: true, requestId, revision, state: snapshotAt(revision) });
}

describe("AbletonAdapter revision serialization", () => {
  it("keeps an action revision when an older deferred poll resolves afterward", async () => {
    // Given
    let releasePoll: ((value: unknown) => void) | undefined;
    const deferredPoll = new Promise<unknown>((resolve) => {
      releasePoll = resolve;
    });
    let pollCount = 0;
    const requests: unknown[] = [];
    const boundary: AbletonBoundary = {
      snapshot: () => {
        pollCount += 1;
        return pollCount === 1 ? Promise.resolve(success("", 9)) : deferredPoll;
      },
      action: (external) => {
        const request = AbletonActionRequestSchema.parse(external);
        requests.push(request);
        return Promise.resolve(success(request.requestId, request.expectedRevision + 1));
      },
    };
    const adapter = new AbletonAdapter(boundary, () => `request-${requests.length + 1}`);
    await adapter.poll();

    // When
    const pendingPoll = adapter.poll();
    await adapter.press("stop");
    releasePoll?.(success("", 9));
    const view = await pendingPoll;
    await adapter.press("stop");

    // Then
    expect(view.revision).toBe(10);
    expect(AbletonActionRequestSchema.parse(requests[1]).expectedRevision).toBe(10);
  });

  it("rejects a stale action response without replacing the newer snapshot", async () => {
    // Given
    const requests: unknown[] = [];
    const boundary: AbletonBoundary = {
      snapshot: () => Promise.resolve(success("", 10)),
      action: (external) => {
        const request = AbletonActionRequestSchema.parse(external);
        requests.push(request);
        return Promise.resolve(success(request.requestId, 9));
      },
    };
    const adapter = new AbletonAdapter(boundary, () => `request-${requests.length + 1}`);
    await adapter.poll();

    // When
    const result = await adapter.press("stop");
    await adapter.press("stop");

    // Then
    expect(result).toEqual({ kind: "error", reason: "stale_response" });
    expect(AbletonActionRequestSchema.parse(requests[1]).expectedRevision).toBe(10);
  });
});
