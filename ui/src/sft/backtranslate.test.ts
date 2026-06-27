import { describe, it, expect } from "vitest";
import {
  extractShape, fillTemplate, validateTemplate, parseInstructions, Backtranslator,
  type BrainChat,
} from "./backtranslate";
import type { RawExample } from "./buildDataset";

const raw = (utterance: string): RawExample => ({
  id: "src#0", sourceId: "src", utterance,
  startCommands: [], targetCommands: [{ command: "set_tempo", args: { bpm: 132 } }],
  goldCommandNames: ["set_tempo"], intent: "ACK_GOT_IT",
});

describe("extractShape", () => {
  it("slots numbers", () => {
    expect(extractShape("set the tempo to 132")).toEqual({ shape: "set the tempo to {0}", tokens: ["132"] });
  });
  it("slots quoted track names without the outer quotes", () => {
    expect(extractShape('add a MIDI clip to the "Symp Piano {FG}" track')).toEqual({
      shape: "add a MIDI clip to the {0} track", tokens: ["Symp Piano {FG}"],
    });
  });
  it("keeps a name that itself contains quotes as ONE generalizing slot", () => {
    // MIDI titles often arrive double-quoted; greedy match → single shape, not per-track.
    expect(extractShape('add a MIDI clip to the ""One Caress"" track')).toEqual({
      shape: "add a MIDI clip to the {0} track", tokens: ['"One Caress"'],
    });
  });
  it("slots time-signatures and decimals", () => {
    expect(extractShape("change to 3/4 time")).toEqual({ shape: "change to {0} time", tokens: ["3/4"] });
    expect(extractShape("set the tempo to 92.02")).toEqual({ shape: "set the tempo to {0}", tokens: ["92.02"] });
  });
  it("handles multiple slots in order", () => {
    const { shape, tokens } = extractShape('pan the "Bass" track 5 left');
    expect(shape).toBe("pan the {0} track {1} left");
    expect(tokens).toEqual(["Bass", "5"]);
  });
});

describe("fillTemplate", () => {
  it("round-trips through a shape", () => {
    const { shape, tokens } = extractShape('add a MIDI clip to the "Keys" track');
    expect(fillTemplate("drop a clip on {0}", tokens)).toBe("drop a clip on Keys");
    expect(fillTemplate(shape, tokens)).toBe("add a MIDI clip to the Keys track");
  });
});

describe("validateTemplate", () => {
  const shape = "set the tempo to {0}";
  it("accepts a natural rewrite that keeps the slot", () => {
    expect(validateTemplate("make it {0} bpm", shape)).toBe(true);
  });
  it("rejects missing or extra slots", () => {
    expect(validateTemplate("make it fast", shape)).toBe(false);
    expect(validateTemplate("set {0} and {1}", shape)).toBe(false);
  });
  it("rejects API/command leakage", () => {
    expect(validateTemplate("call set_tempo with {0}", shape)).toBe(false);
  });
  it("rejects echo of the mechanical seed and overlong text", () => {
    expect(validateTemplate("set the tempo to {0}", shape)).toBe(false);
    expect(validateTemplate("x".repeat(201) + " {0}", shape)).toBe(false);
  });
});

describe("parseInstructions", () => {
  it("parses the object form", () => {
    expect(parseInstructions('{"instructions":["a","b"]}')).toEqual(["a", "b"]);
  });
  it("parses a bare array and strips code fences", () => {
    expect(parseInstructions('```json\n["x","y"]\n```')).toEqual(["x", "y"]);
  });
  it("digs an array out of surrounding prose", () => {
    expect(parseInstructions('sure! ["one", "two"] hope that helps')).toEqual(["one", "two"]);
  });
  it("returns [] on junk", () => {
    expect(parseInstructions("not json at all")).toEqual([]);
    expect(parseInstructions("")).toEqual([]);
  });
});

describe("Backtranslator", () => {
  const mockChat = (instr: string[]): BrainChat => async () => JSON.stringify({ instructions: instr });

  it("produces filled natural clones with the SAME gold commands", async () => {
    const bt = new Backtranslator(mockChat(["make it {0}", "bump tempo to {0}"]), { variants: 2 });
    const extras = await bt.variantsFor(raw("set the tempo to 132"));
    expect(extras.map((e) => e.utterance)).toEqual(["make it 132", "bump tempo to 132"]);
    expect(extras.every((e) => e.goldCommandNames.join() === "set_tempo")).toBe(true);
    expect(extras.every((e) => e.targetCommands.length === 1)).toBe(true);
    expect(new Set(extras.map((e) => e.id)).size).toBe(2); // unique ids
  });

  it("caches per shape — one brain call covers every slice of that shape", async () => {
    let calls = 0;
    const chat: BrainChat = async () => { calls++; return JSON.stringify({ instructions: ["make it {0}"] }); };
    const bt = new Backtranslator(chat, { variants: 1 });
    await bt.variantsFor(raw("set the tempo to 100"));
    await bt.variantsFor(raw("set the tempo to 140"));
    expect(calls).toBe(1); // same shape → cached
    expect(bt.calls).toBe(1);
  });

  it("respects the shared call budget", async () => {
    let calls = 0;
    const chat: BrainChat = async () => { calls++; return JSON.stringify({ instructions: ["yo {0}"] }); };
    const budget = { calls: 1 };
    const bt = new Backtranslator(chat, { variants: 1, budget });
    await bt.variantsFor(raw("set the tempo to 100"));                 // shape A — spends the 1 call
    const extras = await bt.variantsFor(raw('mute the "Bass" track')); // shape B — budget exhausted
    expect(calls).toBe(1);
    expect(extras).toEqual([]);
  });

  it("drops invalid rewrites (slot loss / API leak) but keeps good ones", async () => {
    const bt = new Backtranslator(mockChat(["make it {0}", "drop the slot", "set_tempo {0}"]), { variants: 5 });
    const extras = await bt.variantsFor(raw("set the tempo to 88"));
    expect(extras.map((e) => e.utterance)).toEqual(["make it 88"]);
  });
});
