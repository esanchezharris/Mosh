import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFlp } from "./parseFlp";
import { emitCommands } from "./emit";
import { replayProgram } from "./bindReplay";

// The FLP path needs the PyFLP venv (service/flp/.flp.env) — built by
// service/flp/setup-flp.sh, NOT present in CI. Gate the real-parse test on the
// venv + a real fixture, mirroring the transcribe carve's MOSH_SELFTEST_TRANSCRIBE
// gating. The ungated graceful-fallback path is covered in importFile.test.ts.
const HOME = process.env.HOME ?? "";
const FLP_FIXTURE = join(HOME, "mosh-demo-projects/flp/pyflp-FL-20.8.4.flp");
const FLP_ENV = resolve(dirname(fileURLToPath(import.meta.url)), "../../../service/flp/.flp.env");
const gated = existsSync(FLP_ENV) && existsSync(FLP_FIXTURE);
const maybe = gated ? describe : describe.skip;

maybe("parseFlp (gated on the PyFLP venv)", () => {
  it("parses a real .flp into tracks + notes that clean-apply through the verifier", async () => {
    const ir = parseFlp(FLP_FIXTURE);
    expect(ir.format).toBe("flp");
    expect(ir.session.tracks.length).toBeGreaterThan(0);
    const noteCount = ir.session.tracks.reduce(
      (a, t) => a + t.clips.reduce((b, c) => b + (c.notes?.length ?? 0), 0),
      0,
    );
    expect(noteCount).toBeGreaterThan(0);

    const r = await replayProgram(emitCommands(ir));
    expect(r.cleanValidate).toBe(true);
    expect(r.cleanApply).toBe(true);
  });
});
