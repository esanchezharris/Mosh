// Task 1 — RED-first pin for the `teach-moshi` CLI wire contract: exact flags, duplicates,
// missing values, unknown flags, unknown commands, and the stable JSON envelope shape.

import { describe, expect, it } from "vitest";
import { parseTeachMoshiArgsV1, runTeachMoshiV1 } from "./commands";
import type { CommandHandlerResultV1, TeachMoshiDepsV1 } from "./contracts";

describe("parseTeachMoshiArgsV1 — valid commands", () => {
  it("parses init with only --goal", () => {
    expect(parseTeachMoshiArgsV1(["init", "--goal", "park backgrounds"])).toEqual({
      ok: true,
      value: { command: "init", goal: "park backgrounds" },
    });
  });

  it("parses init with --goal and --id", () => {
    expect(parseTeachMoshiArgsV1(["init", "--goal", "park backgrounds", "--id", "park-backgrounds"])).toEqual({
      ok: true,
      value: { command: "init", goal: "park backgrounds", id: "park-backgrounds" },
    });
  });

  it("parses gc --apply", () => {
    expect(parseTeachMoshiArgsV1(["gc", "--apply"])).toEqual({ ok: true, value: { command: "gc", apply: true } });
  });

  it("parses gc with no flags, defaulting apply to false", () => {
    expect(parseTeachMoshiArgsV1(["gc"])).toEqual({ ok: true, value: { command: "gc", apply: false } });
  });

  it("parses add-source", () => {
    expect(parseTeachMoshiArgsV1(["add-source", "--draft", "owner-x", "--card", "/tmp/card.json"])).toEqual({
      ok: true,
      value: { command: "add-source", draftId: "owner-x", cardPath: "/tmp/card.json" },
    });
  });

  it("parses approve", () => {
    expect(
      parseTeachMoshiArgsV1([
        "approve",
        "--draft",
        "owner-x",
        "--review-sha",
        "abc123",
        "--attestation",
        "/tmp/att.json",
      ]),
    ).toEqual({
      ok: true,
      value: { command: "approve", draftId: "owner-x", reviewSha: "abc123", attestationPath: "/tmp/att.json" },
    });
  });

  it("parses rollback", () => {
    expect(parseTeachMoshiArgsV1(["rollback", "--id", "owner-x", "--version", "1.0.1"])).toEqual({
      ok: true,
      value: { command: "rollback", skillId: "owner-x", version: "1.0.1" },
    });
  });
});

describe("parseTeachMoshiArgsV1 — usage failures", () => {
  it("rejects a missing command", () => {
    const result = parseTeachMoshiArgsV1([]);
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown command", () => {
    const result = parseTeachMoshiArgsV1(["frobnicate"]);
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown flag", () => {
    const result = parseTeachMoshiArgsV1(["init", "--goal", "x", "--bogus", "y"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe("unknown_flag");
  });

  it("rejects a duplicate flag", () => {
    const result = parseTeachMoshiArgsV1(["init", "--goal", "x", "--goal", "y"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe("duplicate_flag");
  });

  it("rejects a flag with a missing value at end of argv", () => {
    const result = parseTeachMoshiArgsV1(["init", "--goal"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe("missing_value");
  });

  it("rejects a missing required flag", () => {
    const result = parseTeachMoshiArgsV1(["init"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe("missing_required_flag");
  });
});

describe("runTeachMoshiV1 — envelope and exit codes", () => {
  function depsWith(overrides: Partial<TeachMoshiDepsV1>): TeachMoshiDepsV1 {
    const fail = async (): Promise<CommandHandlerResultV1> => ({ ok: false, code: "io_error", message: "unused" });
    return {
      init: fail,
      "add-source": fail,
      "add-reference": fail,
      validate: fail,
      certify: fail,
      "record-evidence": fail,
      review: fail,
      approve: fail,
      install: fail,
      rollback: fail,
      revoke: fail,
      "refresh-source": fail,
      "revoke-source": fail,
      gc: fail,
      status: fail,
      ...overrides,
    };
  }

  it("emits one ok:false object and exits 2 for an unknown command", async () => {
    const execution = await runTeachMoshiV1(["frobnicate"], depsWith({}));
    expect(execution.exitCode).toBe(2);
    expect(execution.envelope).toMatchObject({ schemaVersion: 1, ok: false });
  });

  it("exits 0 with the handler's result on success", async () => {
    const execution = await runTeachMoshiV1(
      ["gc"],
      depsWith({ gc: async () => ({ ok: true, result: { plan: [] } }) }),
    );
    expect(execution.exitCode).toBe(0);
    expect(execution.envelope).toEqual({
      schemaVersion: 1,
      ok: true,
      command: "gc",
      result: { plan: [] },
    });
  });

  it("exits 1 with the handler's domain error code on failure", async () => {
    const execution = await runTeachMoshiV1(
      ["gc"],
      depsWith({ gc: async () => ({ ok: false, code: "quota_exceeded", message: "over cap" }) }),
    );
    expect(execution.exitCode).toBe(1);
    expect(execution.envelope).toMatchObject({
      ok: false,
      command: "gc",
      error: { code: "quota_exceeded", message: "over cap" },
    });
  });

  it("exits 1 with a bounded io_error when the handler throws", async () => {
    const execution = await runTeachMoshiV1(
      ["gc"],
      depsWith({
        gc: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(execution.exitCode).toBe(1);
    expect(execution.envelope).toMatchObject({ ok: false, command: "gc", error: { code: "io_error" } });
  });
});
