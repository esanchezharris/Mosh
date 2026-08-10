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
