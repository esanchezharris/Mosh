import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SESSION_CAPTURE_DEFAULTS_V1,
  buildCaptureLaunchV1,
  parseSessionFoundryArgsV1,
  preflightCaptureV1,
} from "./commands";

describe("session-foundry capture contract", () => {
  it("parses the bounded owner capture command", () => {
    const parsed = parseSessionFoundryArgsV1([
      "capture",
      "--goal",
      "make a new beat",
      "--set",
      "/tmp/new-beat.als",
    ]);

    expect(parsed).toEqual({
      kind: "capture",
      goal: "make a new beat",
      abletonSetPath: "/tmp/new-beat.als",
      maxMinutes: 120,
      chunkMinutes: 15,
    });
  });

  it("rejects relative sets, duplicate flags, and out-of-bounds durations", () => {
    expect(() => parseSessionFoundryArgsV1(["capture", "--goal", "beat", "--set", "beat.als"])).toThrow(
      "absolute",
    );
    expect(() =>
      parseSessionFoundryArgsV1([
        "capture",
        "--goal",
        "beat",
        "--goal",
        "again",
        "--set",
        "/tmp/beat.als",
      ]),
    ).toThrow("duplicate");
    expect(() =>
      parseSessionFoundryArgsV1([
        "capture",
        "--goal",
        "beat",
        "--set",
        "/tmp/beat.als",
        "--max-minutes",
        "121",
      ]),
    ).toThrow("between 1 and 120");
  });

  it("builds a helper launch without audio-device routing variables", () => {
    const launch = buildCaptureLaunchV1(
      {
        kind: "capture",
        goal: "record vocals",
        abletonSetPath: "/tmp/vocals.als",
        maxMinutes: 120,
        chunkMinutes: 15,
      },
      {
        sessionId: "20260823T033000Z-test",
        sessionDirectory: "/tmp/sessions/20260823T033000Z-test",
        repoRoot: "/repo",
        helperOverride: null,
      },
    );

    expect(launch.executable).toBe("swift");
    expect(launch.args).toContain("MoshSessionCapture");
    expect(launch.args).toContain("--session-directory");
    expect(launch.args).toContain("/tmp/sessions/20260823T033000Z-test");
    expect(launch.env).toEqual({});
  });

  it("fails closed below the free-space floor and accepts an owner regular set", async () => {
    const root = await mkdtemp(join(tmpdir(), "mosh-session-foundry-"));
    const setPath = join(root, "beat.als");
    await writeFile(setPath, "ableton");

    const low = await preflightCaptureV1(setPath, async () => SESSION_CAPTURE_DEFAULTS_V1.minimumFreeBytes - 1);
    expect(low).toEqual({ ok: false, code: "insufficient_disk" });

    const ready = await preflightCaptureV1(setPath, async () => SESSION_CAPTURE_DEFAULTS_V1.minimumFreeBytes);
    expect(ready).toEqual({ ok: true });
  });
});
