import { describe, it, expect } from "vitest";
import { replay, snapshotDiff } from "./verifier";

describe("verifier.replay", () => {
  it("clean-applies a known-good agent sequence", async () => {
    const r = await replay([
      { command: "create_track", args: { name: "Lead" } },
      { command: "add_test_tone_clip", args: { seconds: 4 } },
    ]);
    expect(r.cleanValidate).toBe(true);
    expect(r.cleanApply).toBe(true);
    expect(r.perCommand.every((p) => p.validate === "ok" && p.apply === "ok")).toBe(true);
    expect(r.finalSnapshot.tracks.some((t) => t.name === "Lead")).toBe(true);
  });

  it("fails validation at the offending index (unknown command + missing required arg)", async () => {
    const r = await replay([
      { command: "create_track", args: { name: "Lead" } },
      { command: "no_such_command", args: {} },
      { command: "split_clip", args: { clipId: "x" } }, // missing required 'time'
    ]);
    expect(r.cleanValidate).toBe(false);
    expect(r.cleanApply).toBe(false);
    expect(r.perCommand[0].validate).toBe("ok");
    expect(r.perCommand[1].validate).toMatch(/not an allowed command/);
    expect(r.perCommand[1].apply).toBe("skipped"); // invalid → never sent to the seam
    expect(r.perCommand[2].validate).toMatch(/missing required "time"/);
  });

  it("reports clean-apply failure when a valid-shaped command hits a runtime error", async () => {
    const r = await replay([{ command: "split_clip", args: { clipId: "nonexistent", time: 1 } }]);
    expect(r.cleanValidate).toBe(true); // shape is valid
    expect(r.cleanApply).toBe(false); // mock returns err: clip not found
    expect(r.perCommand[0].apply).toBe("error");
    expect(r.perCommand[0].error).toMatch(/not found/);
  });

  it("applies a startCommands prefix before the verified sequence", async () => {
    const r = await replay([{ command: "create_track", args: { name: "Post" } }], {
      startCommands: [{ command: "create_track", args: { name: "Pre" } }],
    });
    expect(r.cleanApply).toBe(true);
    const names = r.finalSnapshot.tracks.map((t) => t.name);
    expect(names).toContain("Pre"); // from the prefix
    expect(names).toContain("Post"); // from the verified sequence
  });
});

describe("verifier.snapshotDiff", () => {
  it("ignores volatile ids: two independent identical replays are structurally equal", async () => {
    const a = (await replay([{ command: "create_track", args: { name: "X" } }])).finalSnapshot;
    const b = (await replay([{ command: "create_track", args: { name: "X" } }])).finalSnapshot;
    expect(snapshotDiff(a, b).equal).toBe(true);
  });

  it("detects a real structural change (different track count)", async () => {
    const a = (await replay([{ command: "create_track", args: { name: "X" } }])).finalSnapshot;
    const b = (
      await replay([
        { command: "create_track", args: { name: "X" } },
        { command: "create_track", args: { name: "Y" } },
      ])
    ).finalSnapshot;
    const d = snapshotDiff(a, b);
    expect(d.equal).toBe(false);
    expect(d.changes.some((c) => c.path.startsWith("tracks"))).toBe(true);
  });

  it("replay diffs against a target snapshot via opts.target", async () => {
    const target = (await replay([{ command: "create_track", args: { name: "X" } }])).finalSnapshot;
    const r = await replay([{ command: "create_track", args: { name: "X" } }], { target });
    expect(r.diff?.equal).toBe(true);
  });
});
