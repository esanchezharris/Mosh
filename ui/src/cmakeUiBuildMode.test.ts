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
  it("rebuilds when either packaged UI option changes without a source edit", () => {
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
  printf '%s:%s' "$VITE_MOSH_ENABLE_EXPERIMENTAL_AGENT_LOOP" "$VITE_MOSH_ENABLE_DEMO_COMPACT_MELODY" > dist/index.html
  exit 0
fi
exit 64
`);
    chmodSync(fakeNpm, 0o755);

    const runBuild = (loop: "ON" | "OFF", demoMelody: "ON" | "OFF") => spawnSync("cmake", [
      "-DMODE=build",
      `-DMOSH_UI_DIR=${fixtureUi}`,
      `-DMOSH_UI_DIST=${fixtureDist}`,
      `-DNPM_EXECUTABLE=${fakeNpm}`,
      `-DMOSH_ENABLE_EXPERIMENTAL_AGENT_LOOP=${loop}`,
      `-DMOSH_ENABLE_DEMO_COMPACT_MELODY=${demoMelody}`,
      "-P",
      join(repoDir, "cmake", "BuildUIFresh.cmake"),
    ], { encoding: "utf8" });

    const build = (loop: "ON" | "OFF", demoMelody: "ON" | "OFF") => {
      const r = runBuild(loop, demoMelody);
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      return readFileSync(join(fixtureDist, "index.html"), "utf8");
    };

    expect(build("ON", "OFF")).toBe("1:0");
    // The demo-melody flag alone must re-trigger the Vite build: the stamp covers
    // BOTH options, so flipping either one without a source edit still rebuilds.
    expect(build("ON", "ON")).toBe("1:1");
    expect(build("OFF", "OFF")).toBe("0:0");
  });

  it("wires the normal top-level option into the UI build target", () => {
    const topLevel = readFileSync(join(repoDir, "CMakeLists.txt"), "utf8");
    const buildUi = readFileSync(join(repoDir, "cmake", "BuildUI.cmake"), "utf8");

    expect(topLevel).toMatch(/option\(MOSH_ENABLE_EXPERIMENTAL_AGENT_LOOP\b[^\n]*\bON\)/);
    expect(buildUi).toContain('"-DMOSH_ENABLE_EXPERIMENTAL_AGENT_LOOP=${MOSH_ENABLE_EXPERIMENTAL_AGENT_LOOP}"');

    // The compact-melody demo lane ships OFF: it is a model-capability crutch, not a
    // product capability (see runTask.ts's COMPACT MELODY header).
    expect(topLevel).toMatch(/option\(MOSH_ENABLE_DEMO_COMPACT_MELODY\b[^\n]*\bOFF\)/);
    expect(buildUi).toContain('"-DMOSH_ENABLE_DEMO_COMPACT_MELODY=${MOSH_ENABLE_DEMO_COMPACT_MELODY}"');
  });
});
