import { describe, expect, it } from "vitest";
import { HELP, parseArgs } from "./cli";

describe("offline validator CLI", () => {
  it("documents the workflow and parses explicit input paths", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(HELP).toContain("measure -> mine -> validate -> freeze -> heldout -> report -> verify");
    const args = parseArgs(["measure", "--root", "/tmp/example", "--train", "/tmp/corpus"]);
    expect(args.inputs.root).toBe("/tmp/example");
    expect(args.inputs.train).toBe("/tmp/corpus");
  });
  it("rejects invalid actions, unknown options, missing values and duplicates", () => {
    for (const args of [[], ["train"], ["mine", "--bad", "x"], ["mine", "--root"], ["mine", "--root", "x", "--root", "y"]])
      expect(() => parseArgs(args)).toThrow();
  });
});
