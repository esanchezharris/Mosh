import { beforeEach, describe, expect, it } from "vitest";
import { __resetMockForTests, mockExecute, mockSnapshot } from "./bridge.mock";
import type { CommandResult, Snapshot } from "./types";

const execute = (command: string, args: Record<string, unknown>) =>
  mockExecute<CommandResult>({ command, args });

describe("mock automation curve replacement range", () => {
  beforeEach(() => __resetMockForTests());

  it("removes an old boundary point when a nudge moves that boundary inward", async () => {
    const trackId = (await mockSnapshot<Snapshot>()).tracks[0].id;
    for (const [time, value] of [[1, 0.2], [3, 0.7], [5, 0.4]]) {
      await execute("add_automation_point", {
        trackId, pluginIndex: 100, paramIndex: 0, time, value,
      });
    }

    const result = await execute("write_automation_curve", {
      trackId,
      pluginIndex: 100,
      paramIndex: 0,
      apply: "replace",
      replaceStart: 1,
      replaceEnd: 5,
      points: [{ t: 1.25, v: 0.2 }, { t: 3.25, v: 0.7 }, { t: 5, v: 0.4 }],
    });

    expect(result.ok).toBe(true);
    expect((await mockSnapshot<Snapshot>()).tracks[0].mixerPlugins?.[0].params[0].points)
      .toEqual([{ t: 1.25, v: 0.2 }, { t: 3.25, v: 0.7 }, { t: 5, v: 0.4 }]);
  });

  it("rejects a partial replacement-range contract before mutation", async () => {
    const trackId = (await mockSnapshot<Snapshot>()).tracks[0].id;
    await execute("add_automation_point", {
      trackId, pluginIndex: 100, paramIndex: 0, time: 1, value: 0.2,
    });

    const result = await execute("write_automation_curve", {
      trackId,
      pluginIndex: 100,
      paramIndex: 0,
      apply: "replace",
      replaceStart: 1,
      points: [{ t: 1.25, v: 0.2 }],
    });

    expect(result.ok).toBe(false);
    expect((await mockSnapshot<Snapshot>()).tracks[0].mixerPlugins?.[0].params[0].points)
      .toEqual([{ t: 1, v: 0.2 }]);
  });
});

describe("mock send automation addresses", () => {
  beforeEach(() => __resetMockForTests());

  it("routes all three native-shaped send addresses through generic automation commands", async () => {
    await execute("create_bus", { name: "Vocal Verb" });
    const trackId = (await mockSnapshot<Snapshot>()).tracks[0].id;
    expect((await execute("add_send", { trackId, bus: 0, db: -6 })).ok).toBe(true);

    const created = await mockSnapshot<Snapshot>();
    const send = created.tracks.find((track) => track.id === trackId)?.sends?.[0];
    expect(send?.automation).toEqual({
      pluginIndex: expect.any(Number),
      levelParamIndex: expect.any(Number),
      panParamIndex: expect.any(Number),
      muteParamIndex: expect.any(Number),
    });

    const automation = send!.automation!;
    for (const paramIndex of [
      automation.levelParamIndex,
      automation.panParamIndex,
      automation.muteParamIndex,
    ]) {
      expect((await execute("add_automation_point", {
        trackId,
        pluginIndex: automation.pluginIndex,
        paramIndex,
        time: 1,
        value: 0.75,
      })).ok).toBe(true);
    }

    const updated = await mockSnapshot<Snapshot>();
    const plugin = updated.tracks.find((track) => track.id === trackId)?.mixerPlugins
      ?.find((candidate) => candidate.index === automation.pluginIndex);
    expect(plugin?.params.map((param) => ({
      index: param.index,
      points: param.points,
      discrete: param.discrete,
      states: param.states,
    }))).toEqual([
      { index: automation.levelParamIndex, points: [{ t: 1, v: 0.75 }], discrete: undefined, states: undefined },
      { index: automation.panParamIndex, points: [{ t: 1, v: 0.75 }], discrete: undefined, states: undefined },
      { index: automation.muteParamIndex, points: [{ t: 1, v: 0.75 }], discrete: true, states: 2 },
    ]);
  });
});
