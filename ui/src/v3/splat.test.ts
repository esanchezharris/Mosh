import { describe, expect, it } from "vitest";
import { splatColorwayFor, splatStateFor } from "./splat";
import { V3_COLORWAYS } from "./colorway";

describe("splat glue — the dock avatar follows the shell", () => {
  it("lime and bone wear the splat's own heroes; violet and coral keep the ink body and take the shell accent as the mouth", () => {
    expect(splatColorwayFor("lime")).toBe("encre");
    expect(splatColorwayFor("bone")).toBe("creme");
    expect(splatColorwayFor("violet")).toMatchObject({ hex: "#1B1D1C", accent: "#B8A4FF" });
    expect(splatColorwayFor("coral")).toMatchObject({ hex: "#1B1D1C", accent: "#FF8B7A" });
    // every colorway resolves to something distinct (the avatar is not the same in four folders)
    const ids = V3_COLORWAYS.map((c) => { const v = splatColorwayFor(c); return typeof v === "string" ? v : v.id; });
    expect(new Set(ids).size).toBe(V3_COLORWAYS.length);
  });

  it("mood → state, safest read first", () => {
    expect(splatStateFor({ safe: true, busy: true, listening: true, clarify: true })).toBe("sleep");
    expect(splatStateFor({ safe: false, busy: true, listening: true, clarify: true })).toBe("thinking");
    expect(splatStateFor({ safe: false, busy: false, listening: true, clarify: true })).toBe("wide");
    expect(splatStateFor({ safe: false, busy: false, listening: false, clarify: true })).toBe("notify");
    expect(splatStateFor({ safe: false, busy: false, listening: false, clarify: false })).toBe("idle");
  });

  it("the vendored engine loads and knows every state the glue can ask for", async () => {
    await import("../vendor/agent-sprites/engine.js");
    const api = (globalThis as unknown as { AgentSprites?: { STATES: string[]; STATE_DEFS: Record<string, { duration: number }> } }).AgentSprites;
    expect(api).toBeTruthy();
    for (const s of ["sleep", "thinking", "wide", "notify", "idle", "laugh"]) expect(api!.STATES).toContain(s);
    expect(api!.STATE_DEFS.laugh.duration).toBeGreaterThan(0);
  });
});
