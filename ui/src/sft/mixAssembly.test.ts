import { describe, expect, it } from "vitest";
import { assembleMix, contentHash, isPopulateClassRow, oversampleRare, rebalanceSelect, rowCommandNames, type ChatRow, type MixRowMeta } from "./mixAssembly";

function row(user: string, commands: Array<{ command: string; args?: object }>): ChatRow {
  return {
    messages: [
      { role: "system", content: "SYS" },
      { role: "user", content: user },
      { role: "assistant", content: JSON.stringify({ intent: "ACK_GOT_IT", commands }) },
    ],
  };
}
const huhRow: ChatRow = {
  messages: [
    { role: "system", content: "SYS" },
    { role: "user", content: "mute the Guitar" },
    { role: "assistant", content: '{"intent":"HUH","say":"which track?"}' },
  ],
};

describe("rowCommandNames / isPopulateClassRow", () => {
  it("parses gold command names", () => {
    expect(rowCommandNames(row("x", [{ command: "set_tempo" }, { command: "add_note" }]))).toEqual(["set_tempo", "add_note"]);
    expect(rowCommandNames(huhRow)).toEqual([]);
  });
  it("populate-class = only add_note/set_note, non-empty", () => {
    expect(isPopulateClassRow(row("x", [{ command: "add_note" }, { command: "add_note" }]))).toBe(true);
    expect(isPopulateClassRow(row("x", [{ command: "add_note" }, { command: "set_note" }]))).toBe(true);
    expect(isPopulateClassRow(row("x", [{ command: "add_midi_clip" }, { command: "add_note" }]))).toBe(false);
    expect(isPopulateClassRow(huhRow)).toBe(false); // HUH rows are never capped
  });
});

describe("assembleMix", () => {
  it("dedupes on exact content, first occurrence wins", () => {
    const a = row("same", [{ command: "set_tempo" }]);
    const { rows, stats } = assembleMix([a, structuredClone(a), huhRow], { populateCap: 10, seed: 1 });
    expect(rows.length).toBe(2);
    expect(stats.deduped).toBe(1);
  });
  it("caps populate-class rows deterministically by seed", () => {
    const pops = Array.from({ length: 20 }, (_, i) => row(`pop ${i}`, [{ command: "add_note", args: { pitch: i } }]));
    const other = row("tempo", [{ command: "set_tempo" }]);
    const r1 = assembleMix([...pops, other], { populateCap: 5, seed: 1 });
    const r2 = assembleMix([...pops, other], { populateCap: 5, seed: 1 });
    const r3 = assembleMix([...pops, other], { populateCap: 5, seed: 2 });
    expect(r1.stats.populateSeen).toBe(20);
    expect(r1.stats.populateKept).toBe(5);
    expect(r1.stats.output).toBe(6);
    const users = (r: typeof r1) => r.rows.map((x) => x.messages[1].content).sort();
    expect(users(r1)).toEqual(users(r2));           // same seed → identical sample
    expect(users(r1)).not.toEqual(users(r3));       // different seed → different sample
    expect(r1.rows.map((x) => x.messages[1].content)).toContain("tempo");
  });
  it("counts per-command once per row", () => {
    const { stats } = assembleMix([row("x", [{ command: "add_note" }, { command: "add_note" }])], { populateCap: 10, seed: 1 });
    expect(stats.perCommand).toEqual({ add_note: 1 });
  });
  it("caps HUH rows deterministically (the r1 defer-gravity lesson)", () => {
    const huhs = Array.from({ length: 30 }, (_, i) => ({
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: `vague ${i}` },
        { role: "assistant", content: '{"intent":"HUH","say":"which one?"}' },
      ],
    }));
    const other = row("tempo", [{ command: "set_tempo" }]);
    const r1 = assembleMix([...huhs, other], { populateCap: 10, huhCap: 5, seed: 1 });
    const r2 = assembleMix([...huhs, other], { populateCap: 10, huhCap: 5, seed: 1 });
    expect(r1.stats.huhSeen).toBe(30);
    expect(r1.stats.huhKept).toBe(5);
    expect(r1.stats.output).toBe(6);
    expect(r1.rows.map((x) => x.messages[1].content).sort()).toEqual(r2.rows.map((x) => x.messages[1].content).sort());
    // uncapped when omitted
    expect(assembleMix([...huhs], { populateCap: 10, seed: 1 }).stats.huhKept).toBe(30);
  });
  it("contentHash differs on any message change", () => {
    expect(contentHash(row("a", [{ command: "save" }]))).not.toBe(contentHash(row("b", [{ command: "save" }])));
  });
});

describe("rebalanceSelect (§P7 exposure amendment)", () => {
  const cmd = (names: string[]): MixRowMeta => ({ commands: names, huh: false });
  const neg: MixRowMeta = { commands: [], huh: true, negative: true };
  const gen: MixRowMeta = { commands: [], huh: true };

  it("caps head commands, keeps the tail whole, deterministic by seed", () => {
    const rows = [
      ...Array.from({ length: 10 }, () => cmd(["add_midi_clip"])),
      ...Array.from({ length: 3 }, () => cmd(["undo"])),
    ];
    const r1 = rebalanceSelect(rows, { capPerCommand: 5, negCap: 0, genericHuhCap: 0, seed: 1 });
    const r2 = rebalanceSelect(rows, { capPerCommand: 5, negCap: 0, genericHuhCap: 0, seed: 1 });
    const r3 = rebalanceSelect(rows, { capPerCommand: 5, negCap: 0, genericHuhCap: 0, seed: 7 });
    expect(r1.stats.perCommand).toEqual({ add_midi_clip: 5, undo: 3 });
    expect(r1.keep).toEqual(r2.keep);                      // same seed → identical mask
    expect(r1.keep).not.toEqual(r3.keep);                  // different seed → different sample
    expect(r1.keep.length).toBe(rows.length);
  });

  it("keeps a multi-command row when ANY of its commands is under cap", () => {
    // 5 pure-A rows fill A's cap; the [A,B] row must still be kept for B's sake.
    const rows = [...Array.from({ length: 5 }, () => cmd(["a"])), cmd(["a", "b"])];
    const { keep, stats } = rebalanceSelect(rows, { capPerCommand: 5, negCap: 0, genericHuhCap: 0, seed: 1 });
    expect(keep[5]).toBe(true);
    expect(stats.perCommand.b).toBe(1);
    // A ends at cap or cap+1 depending on visit order — coverage beats the cap,
    // and the overflow is bounded by the multi-command row itself.
    expect([5, 6]).toContain(stats.perCommand.a);
  });

  it("does NOT dedupe — intentional oversample duplicates survive under cap", () => {
    const rows = [cmd(["undo"]), cmd(["undo"]), cmd(["undo"])];
    const { stats } = rebalanceSelect(rows, { capPerCommand: 10, negCap: 0, genericHuhCap: 0, seed: 1 });
    expect(stats.perCommand.undo).toBe(3);
  });

  it("HUH policy: negatives fill negCap first, generic capped separately", () => {
    const rows = [...Array.from({ length: 8 }, () => ({ ...neg })), ...Array.from({ length: 6 }, () => ({ ...gen }))];
    const r1 = rebalanceSelect(rows, { capPerCommand: 100, negCap: 4, genericHuhCap: 2, seed: 1 });
    const r2 = rebalanceSelect(rows, { capPerCommand: 100, negCap: 4, genericHuhCap: 2, seed: 1 });
    expect(r1.stats.huhNegKept).toBe(4);
    expect(r1.stats.huhGenericKept).toBe(2);
    expect(r1.stats.kept).toBe(6);
    expect(r1.keep).toEqual(r2.keep);
  });

  it("rows with no commands and not HUH are kept unconditionally", () => {
    const other: MixRowMeta = { commands: [], huh: false };
    const { keep, stats } = rebalanceSelect([other, cmd(["save"])], { capPerCommand: 1, negCap: 0, genericHuhCap: 0, seed: 1 });
    expect(keep).toEqual([true, true]);
    expect(stats.otherKept).toBe(1);
  });
});

describe("oversampleRare", () => {
  it("duplicates rows of sub-threshold commands, leaves common ones alone", () => {
    const rows = [
      ...Array.from({ length: 150 }, (_, i) => row(`tempo ${i}`, [{ command: "set_tempo" }])),
      row("undo it", [{ command: "undo" }]),
      row("undo again", [{ command: "undo" }]),
    ];
    const { extras, boosted } = oversampleRare(rows, 100, 4);
    expect(extras.length).toBe(6); // 2 undo rows × (4-1)
    expect(boosted).toEqual({ undo: 6 });
    expect(extras.every((r) => rowCommandNames(r).includes("undo"))).toBe(true);
  });
  it("a row mixing rare+common commands is still boosted", () => {
    const rows = [
      ...Array.from({ length: 150 }, (_, i) => row(`t ${i}`, [{ command: "set_tempo" }])),
      row("split then tempo", [{ command: "split_clip" }, { command: "set_tempo" }]),
    ];
    const { extras } = oversampleRare(rows, 100, 3);
    expect(extras.length).toBe(2);
  });
});
