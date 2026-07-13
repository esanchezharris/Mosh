import { describe, it, expect } from "vitest";
import { lintShader, wrapHtml } from "./sandbox";

describe("lintShader (untrusted GLSL guard)", () => {
  it("accepts a constant-bounded loop", () => {
    expect(lintShader("void main(){ for(int i=0;i<64;i++){} }").ok).toBe(true);
  });
  it("accepts <= cap and rejects > cap", () => {
    expect(lintShader("void main(){ for(int i=0;i<=256;i++){} }").ok).toBe(true);
    expect(lintShader("void main(){ for(int i=0;i<9999;i++){} }").ok).toBe(false);
  });
  it("rejects while loops", () => {
    expect(lintShader("void main(){ while(true){} }").ok).toBe(false);
  });
  it("rejects a loop bounded by a variable (not a constant)", () => {
    expect(lintShader("void main(){ for(int i=0;i<uCount;i++){} }").ok).toBe(false);
  });
  it("rejects a shader with no main()", () => {
    expect(lintShader("float f(){return 1.0;}").ok).toBe(false);
  });
});

describe("wrapHtml (untrusted HTML sandbox)", () => {
  it("always injects a no-network CSP and the kit tokens", () => {
    const doc = wrapHtml("<div>hi</div>", "dark");
    expect(doc).toContain("Content-Security-Policy");
    expect(doc).toContain("connect-src 'none'");
    expect(doc).toContain("--v2-accent");
  });
  it("strips a full document down to its body + styles (our CSP stays in control)", () => {
    const doc = wrapHtml("<html><head><style>.x{color:red}</style></head><body><p>y</p></body></html>", "dark");
    // our single wrapper doctype, not the candidate's
    expect(doc.indexOf("<!doctype html>")).toBe(0);
    expect(doc).toContain(".x{color:red}");
    expect(doc).toContain("<p>y</p>");
  });
});
