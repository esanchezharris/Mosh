import { describe, it, expect } from "vitest";
import { importBuffer } from "./importFile";

describe("importBuffer dispatch", () => {
  it("routes .rpp to the RPP parser", () => {
    const ir = importBuffer("x.rpp", Buffer.from("<REAPER_PROJECT 0.1\n  TEMPO 90 4 4\n>\n"));
    expect(ir.format).toBe("rpp");
    expect(ir.session.tempo).toBe(90);
  });

  it("flags .flp as not-yet-implemented without throwing", () => {
    const ir = importBuffer("x.flp", Buffer.from([0, 1, 2]));
    expect(ir.format).toBe("flp");
    expect(ir.unmappable.join(" ")).toMatch(/not implemented/i);
  });

  it("throws on an unsupported extension", () => {
    expect(() => importBuffer("x.cpr", Buffer.from([0]))).toThrow(/unsupported/i);
  });
});
