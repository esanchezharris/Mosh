import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Live Moshi drawer", () => {
  it("hosts the shared production composer and task feedback surfaces", () => {
    const source = readFileSync(resolve(process.cwd(), "src/live/DetailDock.tsx"), "utf8");

    expect(source).toContain('import { AgentComposer } from "../ui/AgentComposer"');
    expect(source).toContain("<AgentDrawer />");
    expect(source).toContain("<ChangeToast />");
    expect(source).toContain("<AgentComposer />");
    expect(source).not.toContain("agent drawer is a stub");
  });
});
