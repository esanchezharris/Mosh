// SURF-1 — the per-line rhyme palette. The surface that carries the bench's most
// confident number into the product: a 40-word palette contains the word the original
// artist actually used 80% of the time, vs .433 for the top pick. Until this shipped the
// palette existed ONLY inside the generator's prompt, so the human never saw it.
//
// Each guard below names the sabotage that must turn it red:
//   * asks for exactly 40         — maxN is a measured INTERIOR maximum (24→.387,
//                                   40→.413, 100→.320, 200→.267). Change it to 100 and
//                                   the product silently leaves the peak. Red-proved.
//   * never fetches unprompted    — get_rhymes blocks the UI thread by design
//                                   (MoshOps::cmdGetRhymes). A speculative fetch on
//                                   render/focus freezes the shell; asserts zero calls
//                                   before the click.
//   * a word PLACES an end word   — the whole point is one click, not a reading list.
//                                   Asserts set_lyric_line commits the chosen word as
//                                   the line's final token.
//   * asks the sheet's strictness — offering "slant" words while the gate grades
//                                   "perfect" would surface rhymes the engine rejects.
//   * hidden without an anchor    — progressive disclosure: no anchor, nothing to answer.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LyricPanel } from "./LyricPanel";
import { useStore } from "../../store";
import type { CommandResult, LyricAnalysis, LyricLine, LyricSheet, Track } from "../../types";

// A COMPLETE analysis blob — FlowViz renders whenever `analysis` is present and reads
// `words`, so a partial fixture crashes the row rather than exercising the palette.
function analysis(over: Partial<LyricAnalysis> = {}): LyricAnalysis {
  return {
    syllables: 8, target: 8, tol: 1, syllableOk: true, endWord: "day",
    rhymeGroup: "A", rhymeAnchor: "night", rhymeGrade: "slant", rhymeOk: true,
    stress: "XxxX", words: [], hasGap: false, analyzed: "seed", complete: false,
    endInDict: true, ...over,
  };
}

function line(over: Partial<LyricLine> = {}): LyricLine {
  return {
    index: 0, role: "verse", seedText: "chasing paper all ___", text: "",
    status: "seed", locked: false, rhymeGroup: "A", syllableTarget: 8,
    ...over,
  } as unknown as LyricLine;
}
function sheet(lines: LyricLine[]): LyricSheet {
  return {
    id: "ls1", grid: "1/8", language: "en", topic: "", mood: "",
    explicit: "allow", rhymeStrictness: "perfect", specVersion: 1, lines,
  } as unknown as LyricSheet;
}
function track(lines: LyricLine[]): Track {
  return { id: "t1", index: 0, name: "Vocals", type: "audio",
    volumeDb: 0, pan: 0, mute: false, solo: false, clips: [], plugins: [],
    lyricSheet: sheet(lines) } as unknown as Track;
}
// A line phonology has already anchored — the state in which the palette can answer.
const ANCHORED = line({ analysis: analysis() });

describe("SURF-1 per-line rhyme palette", () => {
  let host: HTMLDivElement;
  let root: Root;
  let calls: Array<{ cmd: string; args: Record<string, unknown> }>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    calls = [];
    const exec = vi.fn(async (cmd: string, args: Record<string, unknown>): Promise<CommandResult> => {
      calls.push({ cmd, args });
      if (cmd === "get_rhymes")
        return { ok: true, data: { candidates: [
          { word: "light", syllables: 1, grade: "perfect" },
          { word: "right", syllables: 1, grade: "perfect" },
        ] } } as unknown as CommandResult;
      return { ok: true, data: {} } as unknown as CommandResult;
    });
    useStore.setState({ exec } as never);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = (t: Track) => act(() => { root.render(React.createElement(LyricPanel, { track: t })); });
  const q = <T extends Element>(sel: string) => host.querySelector(sel) as T | null;

  it("stays hidden until phonology has an anchor, and never fetches unprompted", () => {
    render(track([line()]));                       // no analysis ⇒ no anchor
    expect(q('[data-testid="lyric-palette-0"]')).toBeNull();
    render(track([ANCHORED]));
    expect(q('[data-testid="lyric-palette-0"]')).not.toBeNull();
    // get_rhymes BLOCKS the UI thread — nothing may call it on render.
    expect(calls.filter((c) => c.cmd === "get_rhymes")).toHaveLength(0);
  });

  it("asks for exactly 40 words, at the sheet's own strictness", async () => {
    render(track([ANCHORED]));
    await act(async () => { q<HTMLButtonElement>('[data-testid="lyric-palette-0"]')!.click(); });
    const got = calls.filter((c) => c.cmd === "get_rhymes");
    expect(got).toHaveLength(1);
    // 40 is the measured peak, not a layout choice; "perfect" is the sheet's setting.
    expect(got[0].args).toMatchObject({ word: "night", strictness: "perfect", maxN: 40 });
  });

  it("places a clicked word as the line's end word (one click, not a reading list)", async () => {
    render(track([ANCHORED]));
    await act(async () => { q<HTMLButtonElement>('[data-testid="lyric-palette-0"]')!.click(); });
    const word = q<HTMLButtonElement>('[data-testid="lyric-palette-word-0-light"]');
    expect(word).not.toBeNull();
    await act(async () => { word!.click(); });
    const set = calls.filter((c) => c.cmd === "set_lyric_line");
    expect(set).toHaveLength(1);
    // The trailing gap becomes the chosen word; the rest of the bar is untouched.
    expect(set[0].args).toMatchObject({ trackId: "t1", lineIndex: 0,
                                        seedText: "chasing paper all light" });
  });

  it("replaces the final WORD when the bar has no trailing gap", async () => {
    render(track([line({
      seedText: "chasing paper all day", text: "chasing paper all day",
      analysis: analysis({ rhymeGrade: "none", rhymeOk: false }),
    })]));
    await act(async () => { q<HTMLButtonElement>('[data-testid="lyric-palette-0"]')!.click(); });
    await act(async () => { q<HTMLButtonElement>('[data-testid="lyric-palette-word-0-right"]')!.click(); });
    const set = calls.filter((c) => c.cmd === "set_lyric_line");
    expect(set[0].args).toMatchObject({ text: "chasing paper all right" });
  });

  it("announces a failed lookup and offers no words", async () => {
    const exec = vi.fn(async (cmd: string): Promise<CommandResult> =>
      (cmd === "get_rhymes"
        ? { ok: false, error: "phonology service unavailable" }
        : { ok: true, data: {} }) as unknown as CommandResult);
    useStore.setState({ exec } as never);
    render(track([ANCHORED]));
    await act(async () => { q<HTMLButtonElement>('[data-testid="lyric-palette-0"]')!.click(); });
    const err = q('[data-testid="lyric-palette-err-0"]');
    expect(err?.getAttribute("role")).toBe("alert");
    expect(q('[data-testid="lyric-palette-list-0"]')).toBeNull();
  });
});
