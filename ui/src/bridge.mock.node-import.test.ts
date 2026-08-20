import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

describe("bridge.mock raw Node import", () => {
  test("loads without a browser window for CLI evaluation", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--eval", "await import('./src/bridge.mock.ts')"],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
