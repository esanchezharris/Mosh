import { describe, it, expect, beforeEach } from "vitest";
import { __resetMockForTests, mockExecute } from "../../bridge.mock";
import { __resetMemoryHydrationForTests } from "./hydrate";
import { MEMORY_COMMANDS, handleRememberPreference, rememberPreferenceToolDoc } from "./rememberPreference";
import type { CommandResult } from "../../types";

const exec = (command: string, args: Record<string, unknown> = {}) =>
  mockExecute<CommandResult>({ command, args });

beforeEach(() => {
  __resetMockForTests();
  __resetMemoryHydrationForTests();
});

describe("MEMORY_COMMANDS", () => {
  it("contains exactly the pseudo-command name(s)", () => {
    expect([...MEMORY_COMMANDS]).toEqual(["remember_preference"]);
  });
});

describe("handleRememberPreference", () => {
  it("writes a GLOBAL preference with explicit:false", async () => {
    const r = await handleRememberPreference({ text: "leans on triplet hats" }, exec);
    expect(r).toEqual({ command: "remember_preference", ok: true });

    const read = await exec("agent_memory_read", { scope: "global", kind: "preference" });
    const items = (read.data as { items: { item: unknown; explicit: boolean }[] }).items;
    expect(items[0].item).toBe("leans on triplet hats");
    expect(items[0].explicit).toBe(false);
  });

  it("rejects a missing/empty text with a self-describing error, writing nothing", async () => {
    const r1 = await handleRememberPreference({}, exec);
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/text/i);

    const r2 = await handleRememberPreference({ text: "   " }, exec);
    expect(r2.ok).toBe(false);

    const read = await exec("agent_memory_read", { scope: "global", kind: "preference" });
    expect((read.data as { items: unknown[] }).items).toEqual([]);
  });

  it("propagates a real write failure (e.g. an all-explicit store at cap)", async () => {
    for (let i = 0; i < 500; i++) {
      await exec("agent_memory_write", { scope: "global", kind: "preference", explicit: true, item: `x${i}` });
    }
    const r = await handleRememberPreference({ text: "one more" }, exec);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/explicit/i);
  });

  it("always returns command:\"remember_preference\" regardless of outcome", async () => {
    expect((await handleRememberPreference({ text: "x" }, exec)).command).toBe("remember_preference");
    expect((await handleRememberPreference({}, exec)).command).toBe("remember_preference");
  });
});

describe("rememberPreferenceToolDoc", () => {
  it("documents the exact call shape and is non-empty/deterministic", () => {
    const doc = rememberPreferenceToolDoc();
    expect(doc).toContain("remember_preference");
    expect(doc).toContain('"text"');
    expect(doc).toBe(rememberPreferenceToolDoc()); // deterministic, no randomness/timestamps
  });
});
