import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const uiDir = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = mkdtempSync(join(tmpdir(), "mosh-production-boundary-"));

afterAll(() => rmSync(outputDir, { recursive: true, force: true }));

describe("production build mock boundary", () => {
  it("rejects the legacy e2e mock flag before producing a production artifact", () => {
    const result = spawnSync(
      process.execPath,
      [join(uiDir, "node_modules/vite/bin/vite.js"), "build", "--outDir", outputDir],
      {
        cwd: uiDir,
        encoding: "utf8",
        env: { ...process.env, VITE_MOSH_E2E_MOCK: "1" },
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "VITE_MOSH_E2E_MOCK is forbidden for packaged builds",
    );
  });

  it("rejects ambient NODE_ENV=development before producing a production artifact", () => {
    const result = spawnSync(
      process.execPath,
      [join(uiDir, "node_modules/vite/bin/vite.js"), "build", "--outDir", outputDir],
      {
        cwd: uiDir,
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "development" },
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "NODE_ENV=development is forbidden for packaged builds",
    );
  });

  it("rejects optimized development-mode output outside the explicit e2e mode", () => {
    const result = spawnSync(
      process.execPath,
      [
        join(uiDir, "node_modules/vite/bin/vite.js"),
        "build",
        "--mode",
        "development",
        "--outDir",
        outputDir,
      ],
      {
        cwd: uiDir,
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "production" },
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "development mode is forbidden for packaged builds",
    );
  });
});
