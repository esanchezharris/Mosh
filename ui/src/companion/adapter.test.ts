import { describe, expect, it } from "vitest";
import { AbletonActionRequestSchema, AbletonEnvelopeSchema, AbletonSnapshotSchema } from "./abletonSchema";
import { AbletonAdapter, MoshAdapter, createRequestId, type AbletonBoundary, type MoshBoundary } from "./adapter";
import type { Plan } from "./commandMap";
import type { Button, Snap } from "./types";

const snapshot = AbletonSnapshotSchema.parse({
  revision: 9,
  connection: "connected",
  transport: "stopped",
  editMarkerBeats: 24,
  activeSource: { id: "source", name: "Vocal" },
  passStartBeats: 16,
  savedStopBeats: 24,
  pendingClip: { id: "pending", name: "Pending", startBeats: 16, endBeats: 24 },
  archiveClips: [{ id: "archive", name: "Archive", startBeats: 8, endBeats: 16 }],
  blockedReason: null,
  ownershipUncertain: false,
});

class FakeAbletonBoundary implements AbletonBoundary {
  readonly requests: unknown[] = [];
  readonly actionResult = AbletonEnvelopeSchema.parse({ ok: true, requestId: "fixed-request", revision: 9, state: snapshot });
  snapshot(): Promise<unknown> {
    return Promise.resolve(AbletonEnvelopeSchema.parse({ ok: true, requestId: "", revision: 9, state: snapshot }));
  }
  action(request: unknown): Promise<unknown> {
    this.requests.push(request);
    return Promise.resolve(this.actionResult);
  }
}

const semanticActions: readonly (readonly [Button, "put" | "keep" | "again" | "hear" | "stop"])[] = [
  ["record", "put"],
  ["keep", "keep"],
  ["again", "again"],
  ["hear", "hear"],
  ["stop", "stop"],
];

describe.each(semanticActions)("AbletonAdapter semantic actions", (button, action) => {
  it(`maps ${button} to one ${action} request with the current revision`, async () => {
    // Given
    const boundary = new FakeAbletonBoundary();
    const adapter = new AbletonAdapter(boundary, () => "fixed-request");

    // When
    await adapter.press(button, snapshot);

    // Then
    expect(boundary.requests).toHaveLength(1);
    expect(AbletonActionRequestSchema.parse(boundary.requests[0])).toEqual({
      requestId: "fixed-request",
      expectedRevision: 9,
      action,
    });
  });
});

describe("AbletonAdapter navigator", () => {
  it("sends a beat-based seek while stopped", async () => {
    // Given
    const boundary = new FakeAbletonBoundary();
    const adapter = new AbletonAdapter(boundary, () => "fixed-request");

    // When
    await adapter.seek(11.5, snapshot);

    // Then
    expect(AbletonActionRequestSchema.parse(boundary.requests[0])).toEqual({
      requestId: "fixed-request",
      expectedRevision: 9,
      action: "seek",
      positionBeats: 11.5,
    });
  });

  it("blocks seek locally while recording", async () => {
    // Given
    const boundary = new FakeAbletonBoundary();
    const adapter = new AbletonAdapter(boundary, () => "fixed-request");
    const recording = AbletonSnapshotSchema.parse({ ...snapshot, transport: "recording" });

    // When
    const result = await adapter.seek(11.5, recording);

    // Then
    expect(result.kind).toBe("blocked");
    expect(boundary.requests).toEqual([]);
  });
});

describe("AbletonAdapter busy protection", () => {
  it("does not send a duplicate tap while an action is pending", async () => {
    // Given
    let release: ((value: unknown) => void) | undefined;
    const pending = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const boundary: AbletonBoundary = {
      snapshot: () => Promise.resolve(AbletonEnvelopeSchema.parse({ ok: true, requestId: "", revision: 9, state: snapshot })),
      action: () => pending,
    };
    const adapter = new AbletonAdapter(boundary, () => "fixed-request");

    // When
    const first = adapter.press("keep", snapshot);
    const second = await adapter.press("keep", snapshot);
    release?.(AbletonEnvelopeSchema.parse({ ok: true, requestId: "fixed-request", revision: 9, state: snapshot }));
    await first;

    // Then
    expect(second).toEqual({ kind: "busy" });
  });
});

describe("AbletonAdapter bridge error status", () => {
  it("keeps script disconnect visible after the HTTP action returns", async () => {
    // Given
    const boundary: AbletonBoundary = {
      snapshot: () => Promise.resolve(AbletonEnvelopeSchema.parse({ ok: true, requestId: "", revision: 9, state: snapshot })),
      action: () => Promise.resolve(AbletonEnvelopeSchema.parse({
        ok: false,
        requestId: "fixed-request",
        revision: 9,
        state: snapshot,
        error: "script_disconnected",
      })),
    };
    const adapter = new AbletonAdapter(boundary, () => "fixed-request");

    // When
    await adapter.press("stop", snapshot);

    // Then
    expect(adapter.view(snapshot).statuses).toContain("disconnected");
    expect(adapter.view(snapshot).blockedReason).toBe("script_disconnected");
  });

  it("maps a stale revision response to visible blocked state", async () => {
    // Given
    const boundary: AbletonBoundary = {
      snapshot: () => Promise.resolve(AbletonEnvelopeSchema.parse({ ok: true, requestId: "", revision: 9, state: snapshot })),
      action: () => Promise.resolve(AbletonEnvelopeSchema.parse({
        ok: false,
        requestId: "fixed-request",
        revision: 9,
        state: snapshot,
        error: "stale_revision",
      })),
    };
    const adapter = new AbletonAdapter(boundary, () => "fixed-request");

    // When
    await adapter.press("stop", snapshot);

    // Then
    expect(adapter.view(snapshot).statuses).toContain("blocked");
    expect(adapter.view(snapshot).blockedReason).toBe("stale_revision");
  });
});

describe("AbletonAdapter request IDs", () => {
  it("generates distinct high-entropy request IDs", () => {
    // Given / When
    const ids = new Set(Array.from({ length: 64 }, () => createRequestId()));

    // Then
    expect(ids.size).toBe(64);
    expect([...ids].every((id) => /^dawn-[0-9a-f]{32}$/.test(id))).toBe(true);
  });
});

describe("MoshAdapter", () => {
  it("preserves the existing six-button command-map behavior", async () => {
    // Given
    const plans: Plan[] = [];
    const moshSnapshot: Snap = {
      tracks: [{ id: "t1", armed: true }],
      transport: { playing: false, recording: false, position: 0 },
      controller: { take: { exists: true, clipId: "c1", start: 4 } },
    };
    const boundary: MoshBoundary = {
      snapshot: () => Promise.resolve(moshSnapshot),
      runPlan: (plan) => {
        plans.push(plan);
        return Promise.resolve({ ok: true });
      },
    };
    const adapter = new MoshAdapter(boundary);
    await adapter.poll();

    // When
    await adapter.press("marker");

    // Then
    expect(adapter.buttons).toEqual(["keep", "again", "hear", "marker", "record", "stop"]);
    expect(plans[0]?.cmds).toEqual([
      {
        command: "mark_take",
        args: { clipId: "c1", position: 0, source: "phone_controller", controllerLabel: "flagged" },
      },
    ]);
  });
});
