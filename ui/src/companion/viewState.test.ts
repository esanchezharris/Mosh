import { describe, expect, it } from "vitest";
import { AbletonSnapshotSchema } from "./abletonSchema";
import { abletonView } from "./viewState";

const base = {
  revision: 3,
  connection: "connected",
  transport: "stopped",
  editMarkerBeats: 6,
  activeSource: null,
  passStartBeats: null,
  savedStopBeats: null,
  pendingClip: { id: "pending", name: "Pending", startBeats: 4, endBeats: 6 },
  archiveClips: [{ id: "archive", name: "Archive", startBeats: 1, endBeats: 3 }],
  blockedReason: null,
  ownershipUncertain: false,
};

describe("abletonView", () => {
  it("renders only current-session pending and archive regions in beats", () => {
    // Given
    const snapshot = AbletonSnapshotSchema.parse(base);

    // When
    const view = abletonView(snapshot, false);

    // Then
    expect(view.unit).toBe("beats");
    expect(view.regions).toEqual([{ start: 4, end: 6 }, { start: 1, end: 3 }]);
  });

  it("maps a disconnected snapshot to visible disconnected state", () => {
    // Given
    const snapshot = AbletonSnapshotSchema.parse({ ...base, connection: "disconnected" });

    // When
    const view = abletonView(snapshot, false);

    // Then
    expect(view.statuses).toContain("disconnected");
  });

  it("maps uncertain ownership to visible blocked and pending states", () => {
    // Given
    const snapshot = AbletonSnapshotSchema.parse({
      ...base,
      blockedReason: "pending_ownership_uncertain",
      ownershipUncertain: true,
    });

    // When
    const view = abletonView(snapshot, false);

    // Then
    expect(view.statuses).toEqual(["blocked", "pending"]);
    expect(view.blockedReason).toBe("pending_ownership_uncertain");
  });

  it("shows busy, recording, pending, and playing states without inventing them", () => {
    // Given
    const recording = AbletonSnapshotSchema.parse({ ...base, transport: "recording" });
    const playing = AbletonSnapshotSchema.parse({ ...base, transport: "playing" });

    // When
    const busyView = abletonView(recording, true);
    const playingView = abletonView(playing, false);

    // Then
    expect(busyView.statuses).toEqual(["busy", "recording", "pending"]);
    expect(playingView.statuses).toEqual(["playing", "pending"]);
  });
});
