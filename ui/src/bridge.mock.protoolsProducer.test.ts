import { beforeEach, describe, expect, it } from "vitest";
import { __resetMockForTests, mockExecute, mockSnapshot } from "./bridge.mock";
import type { CommandResult, Snapshot } from "./types";

const exec = (command: string, args: Record<string, unknown> = {}) =>
  mockExecute<CommandResult>({ command, args });
const snap = () => mockSnapshot<Snapshot>();

describe("bridge mock Pro Tools producer fixture", () => {
  beforeEach(() => __resetMockForTests());

  it("offers CLA-2A Stereo as a VST3 and loads it onto an audio track", async () => {
    const trackId = (await snap()).tracks.find((track) => track.type === "audio")!.id;
    const catalog = await exec("list_plugins");
    const plugins = (catalog.data as { plugins?: { id: string; name: string; format: string }[] })?.plugins ?? [];
    const cla2a = plugins.find((plugin) => plugin.name === "CLA-2A Stereo");

    expect(cla2a).toMatchObject({ id: "waves-cla-2a-stereo", format: "VST3" });
    expect((await exec("load_plugin", { trackId, pluginId: cla2a!.id })).ok).toBe(true);
    expect((await snap()).tracks.find((track) => track.id === trackId)?.plugins)
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: "CLA-2A Stereo", type: "VST3" })]));
  });

  it("save-as and reload restore the last saved snapshot", async () => {
    await exec("new_project");
    const created = await exec("create_track", { name: "Tonight Vocal", type: "audio" });
    const trackId = (created.data as { trackId: string }).trackId;
    const file = "/mock/sessions/protools-tonight.mosh";

    expect((await exec("save_as", { file })).ok).toBe(true);
    expect((await snap()).session.editFile).toBe(file);

    await exec("rename_track", { trackId, name: "Unsaved Name" });
    expect((await snap()).tracks[0]?.name).toBe("Unsaved Name");

    expect((await exec("reload")).ok).toBe(true);
    const reloaded = await snap();
    expect(reloaded.session.editFile).toBe(file);
    expect(reloaded.tracks).toHaveLength(1);
    expect(reloaded.tracks[0]?.name).toBe("Tonight Vocal");
  });
});
