// TPL-001 — mock-bridge parity for new_project { template: "vocal" }.
//
// The template is pure composition of existing commands, so what the UI depends on is
// the SHAPE it leaves behind: Beat, Lead vocal and Ad-libs audio tracks, the Lead armed with
// automatic monitoring, a one-bar count-in, overdub takes, and a four-bar loop from bar 1. An
// unknown template still yields a project and says so, never a silent empty project.

import { describe, it, expect, beforeEach } from "vitest";
import { mockExecute, mockSnapshot, __resetMockForTests } from "./bridge.mock";
import type { CommandResult, Snapshot } from "./types";

const exec = <T = CommandResult>(command: string, args: Record<string, unknown> = {}) =>
  mockExecute<T>({ command, args });
const snap = () => mockSnapshot<Snapshot>();

describe("new_project template:vocal — mock parity", () => {
  beforeEach(() => __resetMockForTests());

  it("leaves a singer one Record press away from a stacked take", async () => {
    const r = await exec("new_project", { template: "vocal" });
    expect(r.ok).toBe(true);
    const d = r.data as { template: string; vocalTrackId: string; backingTrackId: string; loopEnd: number };
    expect(d.template).toBe("vocal");
    const s = await snap();
    const names = s.tracks.map((t) => t.name);
    expect(names).toEqual(["Beat", "Lead vocal", "Lead vocal · Takes", "Ad-libs"]);
    // Passes land on the Lead's Takes lane, which holds the arm.
    expect(s.tracks.find((t) => t.name === "Lead vocal · Takes")!.armed).toBe(true);
    expect(s.tracks.find((t) => t.id === d.vocalTrackId)!.armed).toBe(false);
    expect(s.session.countInBars).toBe(1);
    expect(s.session.project?.recordOptions?.overdub).toBe(true);
    expect(s.transport.looping).toBe(true);
    expect(s.transport.loopEnd).toBeCloseTo(d.loopEnd, 6);
    expect(d.loopEnd).toBeGreaterThan(0);
  });

  it("reports an unknown template instead of silently making an empty project", async () => {
    const r = await exec("new_project", { template: "nope" });
    expect(r.ok).toBe(true);
    expect((r.data as { templateError?: string }).templateError).toMatch(/unknown template/);
  });
});
