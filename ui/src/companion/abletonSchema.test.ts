import { describe, expect, it } from "vitest";
import { AbletonActionRequestSchema, AbletonEnvelopeSchema, AbletonSnapshotSchema } from "./abletonSchema";

const snapshot = {
  revision: 7,
  connection: "connected",
  transport: "stopped",
  editMarkerBeats: 8,
  activeSource: { id: "track-1", name: "Vocal" },
  passStartBeats: 4,
  savedStopBeats: 12,
  pendingClip: { id: "pending-1", name: "Take 1", startBeats: 4, endBeats: 12 },
  archiveClips: [{ id: "archive-1", name: "Take 0", startBeats: 0, endBeats: 4 }],
  blockedReason: null,
  ownershipUncertain: false,
};

describe("AbletonSnapshotSchema", () => {
  it("parses the exact Remote Script snapshot", () => {
    // Given / When
    const parsed = AbletonSnapshotSchema.safeParse(snapshot);

    // Then
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown external snapshot fields", () => {
    // Given
    const external = { ...snapshot, unrelatedClips: [] };

    // When
    const parsed = AbletonSnapshotSchema.safeParse(external);

    // Then
    expect(parsed.success).toBe(false);
  });

  it("rejects a clip whose end precedes its start", () => {
    // Given
    const external = { ...snapshot, pendingClip: { ...snapshot.pendingClip, endBeats: 3 } };

    // When
    const parsed = AbletonSnapshotSchema.safeParse(external);

    // Then
    expect(parsed.success).toBe(false);
  });
});

describe("AbletonEnvelopeSchema", () => {
  it("parses a revision-coherent native success envelope", () => {
    // Given
    const external = { ok: true, requestId: "request-1", revision: 7, state: snapshot };

    // When
    const parsed = AbletonEnvelopeSchema.safeParse(external);

    // Then
    expect(parsed.success).toBe(true);
  });

  it("rejects a success envelope with mismatched revisions", () => {
    // Given
    const external = { ok: true, requestId: "request-1", revision: 6, state: snapshot };

    // When
    const parsed = AbletonEnvelopeSchema.safeParse(external);

    // Then
    expect(parsed.success).toBe(false);
  });

  it("parses a strict native error envelope with an empty state", () => {
    // Given
    const external = { ok: false, requestId: "", revision: 0, state: {}, error: "unauthorized" };

    // When
    const parsed = AbletonEnvelopeSchema.safeParse(external);

    // Then
    expect(parsed.success).toBe(true);
  });
});

describe("AbletonActionRequestSchema", () => {
  it("requires beat position only for seek", () => {
    // Given / When
    const seek = AbletonActionRequestSchema.safeParse({
      requestId: "request-1",
      expectedRevision: 7,
      action: "seek",
      positionBeats: 9.5,
    });
    const stopWithPosition = AbletonActionRequestSchema.safeParse({
      requestId: "request-2",
      expectedRevision: 7,
      action: "stop",
      positionBeats: 9.5,
    });

    // Then
    expect(seek.success).toBe(true);
    expect(stopWithPosition.success).toBe(false);
  });
});
