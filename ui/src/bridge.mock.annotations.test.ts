import { beforeEach, describe, expect, it } from "vitest";
import { __resetMockForTests, mockExecute, mockSnapshot } from "./bridge.mock";
import type { CommandResult, Snapshot } from "./types";

const exec = (command: string, args: Record<string, unknown> = {}) =>
  mockExecute<CommandResult>({ command, args });
const getSnapshot = () => mockSnapshot<Snapshot>();

describe("mock annotation Memory Location properties", () => {
  beforeEach(() => __resetMockForTests());

  it("persists nested recall properties through create, edit, and undo", async () => {
    const created = await exec("create_annotation", {
      annotationId: "memory-1",
      text: "Vocal pickup",
      beat: 8,
      memoryLocation: {
        editSelection: { start: 2, end: 4, trackIds: ["track-1"] },
        horizontalZoom: 160,
        shownTrackIds: ["track-1"],
      },
    });
    expect(created.ok).toBe(true);
    expect((await getSnapshot()).annotations?.find((annotation) => annotation.id === "memory-1")?.memoryLocation)
      .toEqual({
        editSelection: { start: 2, end: 4, trackIds: ["track-1"] },
        horizontalZoom: 160,
        shownTrackIds: ["track-1"],
      });

    await exec("edit_annotation", { annotationId: "memory-1", memoryLocation: null });
    expect((await getSnapshot()).annotations?.find((annotation) => annotation.id === "memory-1")?.memoryLocation)
      .toBeUndefined();
    await exec("undo", {});
    expect((await getSnapshot()).annotations?.find((annotation) => annotation.id === "memory-1")?.memoryLocation)
      .toEqual(expect.objectContaining({ horizontalZoom: 160 }));

    const rejected = await exec("edit_annotation", {
      annotationId: "memory-1",
      memoryLocation: { horizontalZoom: 0 },
    });
    expect(rejected).toMatchObject({ ok: false });
    expect((await getSnapshot()).annotations?.find((annotation) => annotation.id === "memory-1")?.memoryLocation)
      .toEqual(expect.objectContaining({ horizontalZoom: 160 }));
  });
});
