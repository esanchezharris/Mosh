import { describe, it, expect } from "vitest";
import { __resetMockForTests, mockExecute } from "../bridge.mock";
import type { CommandResult } from "../types";

// §7 cross-song corpus AUTO-accumulation (mock seam). Accepting a proposal feeds the
// persisted "sound like me" corpus; get_lyric_corpus_stats reports counts only (the
// backend-only safety wall). The real write is a non-spawning best-effort POST to
// /style_corpus on accept (proven end-to-end via --run-script); here we exercise the
// command contract the UI relies on.

async function sheetWithProposal(): Promise<string> {
  __resetMockForTests();
  const created = await mockExecute<CommandResult<{ trackId: string }>>({ command: "create_track", args: { name: "Vox" } });
  const trackId = created.data?.trackId ?? "";
  await mockExecute<CommandResult>({ command: "create_lyric_sheet", args: { trackId } });
  await mockExecute<CommandResult>({ command: "set_lyric_line", args: { trackId, lineIndex: 0, seedText: "they counted me out ___ ___", rhymeGroup: "A" } });
  await mockExecute<CommandResult>({ command: "complete_lyrics", args: { trackId } });
  return trackId;
}

describe("style corpus accumulation (mock seam)", () => {
  it("starts empty", async () => {
    __resetMockForTests();
    const r = await mockExecute<CommandResult<{ lines: number }>>({ command: "get_lyric_corpus_stats", args: {} });
    expect(r.ok).toBe(true);
    expect(r.data?.lines).toBe(0);
  });

  it("grows by one each time a proposal is accepted", async () => {
    const trackId = await sheetWithProposal();
    await mockExecute<CommandResult>({ command: "accept_lyric_proposal", args: { trackId, lineIndex: 0, proposalIndex: 0 } });
    const r1 = await mockExecute<CommandResult<{ lines: number }>>({ command: "get_lyric_corpus_stats", args: {} });
    expect(r1.data?.lines).toBe(1);
  });

  it("resets between mock sessions (deterministic)", async () => {
    const trackId = await sheetWithProposal();
    await mockExecute<CommandResult>({ command: "accept_lyric_proposal", args: { trackId, lineIndex: 0, proposalIndex: 0 } });
    __resetMockForTests();
    const r = await mockExecute<CommandResult<{ lines: number }>>({ command: "get_lyric_corpus_stats", args: {} });
    expect(r.data?.lines).toBe(0);
  });
});
