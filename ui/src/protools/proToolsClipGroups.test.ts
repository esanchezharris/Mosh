import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetMockForTests, mockSnapshot } from "../bridge.mock";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";
import {
  activeClipGroupForClip,
  handleProToolsClipGroupShortcut,
  proToolsClipListEntries,
  proToolsClipSelection,
} from "./proToolsClipGroups";

const original = useStore.getState();

describe("Pro Tools clip groups", () => {
  let project: Snapshot;
  let exec: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    __resetMockForTests();
    project = await mockSnapshot<Snapshot>();
    const first = project.tracks[0]?.clips[0];
    const second = project.tracks[1]?.clips[0];
    if (!first || !second) throw new Error("clip-group fixture clips are missing");
    project.clipGroups = [{
      id: "group-1",
      name: "Rhythm Group",
      clipIds: [first.id, second.id],
      active: true,
    }];
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    useStore.setState({ snapshot: project, selection: new Set<string>(), exec });
  });

  afterEach(() => {
    useStore.setState({
      snapshot: original.snapshot,
      selection: original.selection,
      exec: original.exec,
    });
  });

  it("expands selection from any active member to the complete clip group", () => {
    const first = project.tracks[0]?.clips[0];
    const second = project.tracks[1]?.clips[0];
    if (!first || !second) throw new Error("clip-group fixture clips are missing");

    expect(activeClipGroupForClip(project, first.id)?.id).toBe("group-1");
    expect(proToolsClipSelection(project, first.id)).toEqual([first.id, second.id]);
  });

  it("collapses active members into one Clips List group row", () => {
    const entries = proToolsClipListEntries(project);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      kind: "group",
      name: "Rhythm Group",
      memberCount: 2,
    });
    expect(entries[1]).toMatchObject({ kind: "clip", name: "chords" });
  });

  it("maps Command/Control+Option+G, U, and R to clip-group commands", async () => {
    const first = project.tracks[0]?.clips[0];
    const second = project.tracks[1]?.clips[0];
    if (!first || !second) throw new Error("clip-group fixture clips are missing");

    project.clipGroups = [];
    useStore.setState({ selection: new Set([first.id, second.id]) });
    const group = new KeyboardEvent("keydown", { key: "g", metaKey: true, altKey: true, cancelable: true });
    expect(handleProToolsClipGroupShortcut(group)).toBe(true);
    expect(group.defaultPrevented).toBe(true);
    expect(exec).toHaveBeenLastCalledWith("create_clip_group", {
      clipIds: [first.id, second.id],
    });

    project.clipGroups = [{ id: "group-1", name: "Rhythm Group", clipIds: [first.id, second.id], active: true }];
    useStore.setState({ selection: new Set([second.id]) });
    const ungroup = new KeyboardEvent("keydown", { key: "u", ctrlKey: true, altKey: true, cancelable: true });
    expect(handleProToolsClipGroupShortcut(ungroup)).toBe(true);
    expect(exec).toHaveBeenLastCalledWith("ungroup_clip_group", { clipId: second.id });

    const regroup = new KeyboardEvent("keydown", { key: "r", metaKey: true, altKey: true, cancelable: true });
    expect(handleProToolsClipGroupShortcut(regroup)).toBe(true);
    expect(exec).toHaveBeenLastCalledWith("regroup_clip_group", {});
  });

  it("does not claim the shortcut when there is no valid grouping target", () => {
    project.clipGroups = [];
    const event = new KeyboardEvent("keydown", { key: "g", metaKey: true, altKey: true, cancelable: true });
    expect(handleProToolsClipGroupShortcut(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});
