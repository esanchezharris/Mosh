import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const uiDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoDir = dirname(uiDir);
const scratchDirs: string[] = [];

afterEach(() => {
  for (const path of scratchDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("CMake UI build mode", () => {
  it("rebuilds when the packaged free-form option changes without a source edit", () => {
    const root = mkdtempSync(join(tmpdir(), "mosh-cmake-ui-mode-"));
    scratchDirs.push(root);
    const fixtureUi = join(root, "ui");
    const fixtureDist = join(fixtureUi, "dist");
    mkdirSync(join(fixtureUi, "src"), { recursive: true });
    writeFileSync(join(fixtureUi, "src", "index.ts"), "export {};\n");
    writeFileSync(join(fixtureUi, "package.json"), "{}\n");
    writeFileSync(join(fixtureUi, "package-lock.json"), "{}\n");
    writeFileSync(join(fixtureUi, "vite.config.ts"), "export {};\n");
    writeFileSync(join(fixtureUi, "index.html"), "<main></main>\n");

    const fakeNpm = join(root, "npm");
    writeFileSync(fakeNpm, `#!/bin/sh
if [ "$1" = "install" ]; then exit 0; fi
if [ "$1" = "run" ] && [ "$2" = "build" ]; then
  mkdir -p dist
  printf '%s' "$VITE_MOSH_ENABLE_EXPERIMENTAL_AGENT_LOOP" > dist/index.html
  exit 0
fi
exit 64
`);
    chmodSync(fakeNpm, 0o755);

    const runBuild = (enabled: "ON" | "OFF") => spawnSync("cmake", [
      "-DMODE=build",
      `-DMOSH_UI_DIR=${fixtureUi}`,
      `-DMOSH_UI_DIST=${fixtureDist}`,
      `-DNPM_EXECUTABLE=${fakeNpm}`,
      `-DMOSH_ENABLE_EXPERIMENTAL_AGENT_LOOP=${enabled}`,
      "-P",
      join(repoDir, "cmake", "BuildUIFresh.cmake"),
    ], { encoding: "utf8" });

    const enabled = runBuild("ON");
    expect(enabled.status, `${enabled.stdout}\n${enabled.stderr}`).toBe(0);
    expect(readFileSync(join(fixtureDist, "index.html"), "utf8")).toBe("1");

    const disabled = runBuild("OFF");
    expect(disabled.status, `${disabled.stdout}\n${disabled.stderr}`).toBe(0);
    expect(readFileSync(join(fixtureDist, "index.html"), "utf8")).toBe("0");
  });

  it("wires the normal top-level option into the UI build target", () => {
    const topLevel = readFileSync(join(repoDir, "CMakeLists.txt"), "utf8");
    const buildUi = readFileSync(join(repoDir, "cmake", "BuildUI.cmake"), "utf8");

    expect(topLevel).toMatch(/option\(MOSH_ENABLE_EXPERIMENTAL_AGENT_LOOP\b[^\n]*\bON\)/);
    expect(buildUi).toContain('"-DMOSH_ENABLE_EXPERIMENTAL_AGENT_LOOP=${MOSH_ENABLE_EXPERIMENTAL_AGENT_LOOP}"');
  });
});
