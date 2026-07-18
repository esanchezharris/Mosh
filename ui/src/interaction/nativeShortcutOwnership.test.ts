import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("native Export shortcut ownership", () => {
  it("keeps Export Audio clickable without a native key equivalent", () => {
    const source = readFileSync(resolve(process.cwd(), "../src/app/MenuController.cpp"), "utf8");
    const info = source.match(/case fileExport:\s+result\.setInfo[^\n]+/g) ?? [];
    expect(info).toHaveLength(1);
    expect(info[0]).not.toContain("addDefaultKeypress");
    expect(source).toContain('case fileExport:  fire ("export_audio"); return true;');
  });
});
