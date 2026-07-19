// M4 (item 3) — savePatternCard.ts against the REAL agent_memory_* mock contract
// (mirrors writePreference.test.ts's / usesTracking.test.ts's posture).

import { describe, it, expect, beforeEach } from "vitest";
import { __resetMockForTests, mockExecute } from "../../bridge.mock";
import { saveDrumPatternCard, saveLyricFrameworkCard, type ExecFn } from "./savePatternCard";
import type { DrumPatternCard, LyricFrameworkCard } from "./patternCards";
import type { CommandResult } from "../../types";

const exec: ExecFn = (command, args) => mockExecute<CommandResult>({ command, args });

const drumCard = (over: Partial<DrumPatternCard> = {}): DrumPatternCard => ({
  name: "My groove", pattern: "kick: x...x...x...x...", stepsPerBar: 16, bars: 1,
  tags: ["saved"], source: "saved", uses: 0, ...over,
});
const frameworkCard = (over: Partial<LyricFrameworkCard> = {}): LyricFrameworkCard => ({
  name: "My flow", grid: "1/16", rhymeStrictness: "slant",
  frame: [{ role: "verse", syllables: 8, stress: "xXxxxXxx", rhyme: "A" }],
  tags: [], source: "saved", uses: 0, ...over,
});

beforeEach(() => __resetMockForTests());

describe("saveDrumPatternCard", () => {
  it("writes as an EXPLICIT global drum_pattern and returns the new record's ts", async () => {
    const res = await saveDrumPatternCard(exec, drumCard());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(typeof res.ts).toBe("number");

    const read = await mockExecute<CommandResult<{ items: { ts: number; explicit: boolean; item: DrumPatternCard }[] }>>(
      { command: "agent_memory_read", args: { scope: "global", kind: "drum_pattern" } },
    );
    const items = read.data?.items ?? [];
    expect(items).toHaveLength(1);
    expect(items[0].explicit).toBe(true);
    expect(items[0].item.name).toBe("My groove");
    expect(items[0].ts).toBe(res.ts);
  });

  it("propagates a write failure as an error result", async () => {
    // An invalid `item` (empty string) fails validation on the mock/native side.
    const badExec: ExecFn = async (command, args) =>
      command === "agent_memory_write" ? { ok: false, error: "missing or invalid 'item'" } : exec(command, args);
    const res = await saveDrumPatternCard(badExec, drumCard());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("item");
  });
});

describe("saveLyricFrameworkCard", () => {
  it("writes as an EXPLICIT global lyric_framework and returns the new record's ts", async () => {
    const res = await saveLyricFrameworkCard(exec, frameworkCard());
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const read = await mockExecute<CommandResult<{ items: { explicit: boolean; item: LyricFrameworkCard }[] }>>(
      { command: "agent_memory_read", args: { scope: "global", kind: "lyric_framework" } },
    );
    const items = read.data?.items ?? [];
    expect(items).toHaveLength(1);
    expect(items[0].explicit).toBe(true);
    expect(items[0].item.name).toBe("My flow");
  });

  it("the style-corpus safety wall rejects a card carrying leaked lyric text BEFORE writing anything", async () => {
    const sneaky = frameworkCard({ frame: [{ role: "verse", syllables: 8, stress: "x", rhyme: "A" }] });
    // Simulate a corrupted/misused caller smuggling a `text` field onto the card.
    const leaked = { ...sneaky, text: "actual lyric line leaked here" } as unknown as LyricFrameworkCard;

    const res = await saveLyricFrameworkCard(exec, leaked);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.toLowerCase()).toContain("lyric text");

    const read = await mockExecute<CommandResult<{ items: unknown[] }>>(
      { command: "agent_memory_read", args: { scope: "global", kind: "lyric_framework" } },
    );
    expect(read.data?.items).toEqual([]); // nothing was written
  });
});
