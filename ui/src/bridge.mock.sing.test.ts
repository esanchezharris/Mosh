import { describe, it, expect, beforeEach } from "vitest";
import { mockExecute, mockSnapshot, __resetMockForTests } from "./bridge.mock";
import type { Snapshot, CommandResult } from "./types";

// FMS Phase-3 Stage 2 — the sing render mode flows through the same command/snapshot
// contract as re-imagine/transform: zero new commands, mode:"sing" + adapter:"soulx".
// This exercises the dev mock the WebView/e2e run against (parity with the native path:
// sing without a sheet errors; the skeleton flow marks lines hasScore).

const exec = (command: string, args: Record<string, unknown> = {}) =>
  mockExecute<CommandResult>({ command, args });
const snap = () => mockSnapshot<Snapshot>();
const clipById = async (id: string) =>
  (await snap()).tracks.flatMap((t) => t.clips).find((c) => c.id === id);

describe("mock sing render layer (FMS Phase-3)", () => {
  beforeEach(() => __resetMockForTests());

  it("session exposes the locked-to-self enrollment state", async () => {
    const s = await snap();
    expect(s.session.singVoiceEnrolled).toBe(false);
  });

  it("sing without a lyric sheet errors (native parity, no silent render)", async () => {
    const s = await snap();
    const wave = s.tracks.flatMap((t) => t.clips).find((c) => c.type === "wave");
    expect(wave).toBeTruthy();
    const clipId = wave!.id;
    expect((await exec("create_render_layer", { clipId, adapter: "soulx", mode: "sing" })).ok).toBe(true);
    expect((await clipById(clipId))?.renderLayer?.mode).toBe("sing");
    const r = await exec("render_layer", { clipId });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("lyric sheet");
  });

  it("skeleton flow needs asserted words before sing renders", async () => {
    const s = await snap();
    const track = s.tracks.find((t) => t.clips.some((c) => c.type === "wave"))!;
    const clipId = track.clips.find((c) => c.type === "wave")!.id;

    await exec("build_skeleton_from_clip", { clipId });
    await new Promise((r) => setTimeout(r, 500));            // mock lands async like native
    const t2 = (await snap()).tracks.find((t) => t.id === track.id)!;
    expect(t2.lyricSheet).toBeTruthy();
    expect(t2.lyricSheet!.lines.every((l) => l.hasScore)).toBe(true);
    expect(t2.lyricSheet!.lines.some((l) => l.singable)).toBe(false);

    expect((await exec("create_render_layer", { clipId, adapter: "soulx", mode: "sing" })).ok).toBe(true);
    const flowOnly = await exec("render_layer", { clipId });
    expect(flowOnly.ok).toBe(false);
    expect(String(flowOnly.error)).toContain("asserted words");

    expect((await exec("confirm_skeleton", { trackId: track.id })).ok).toBe(true);
    expect((await exec("complete_lyrics", { trackId: track.id })).ok).toBe(true);
    expect((await exec("accept_lyric_proposal", { trackId: track.id, lineIndex: 0, proposalIndex: 0 })).ok).toBe(true);
    expect((await exec("render_layer", { clipId })).ok).toBe(true);
    const rl = (await clipById(clipId))?.renderLayer;
    expect(rl?.status).toBe("ready");
    expect(rl?.hasArtifact).toBe(true);
    expect((await exec("accept_render", { clipId })).ok).toBe(true);
  });

  it("a typed sheet has no take flow, so assertion alone is still not singable", async () => {
    const s = await snap();
    const track = s.tracks.find((t) => t.clips.some((c) => c.type === "wave"))!;
    const clipId = track.clips.find((c) => c.type === "wave")!.id;
    expect((await exec("create_lyric_sheet", { trackId: track.id })).ok).toBe(true);
    expect((await exec("set_lyric_line", { trackId: track.id, lineIndex: 0, text: "typed by hand no take" })).ok).toBe(true);
    expect((await exec("assert_lyric_line", { trackId: track.id, lineIndex: 0 })).ok).toBe(true);
    const t2 = (await snap()).tracks.find((t) => t.id === track.id)!;
    expect(t2.lyricSheet!.lines.some((l) => l.hasScore)).toBe(false);
    expect(t2.lyricSheet!.lines.some((l) => l.singable)).toBe(false);

    expect((await exec("create_render_layer", { clipId, adapter: "soulx", mode: "sing" })).ok).toBe(true);
    const r = await exec("render_layer", { clipId });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("asserted words");
    const rl = (await clipById(clipId))?.renderLayer;
    expect(rl?.status).not.toBe("ready");
    expect(rl?.hasArtifact).toBeFalsy();
  });

  it("partial coverage: asserted scored lines sing while a hand-added line is skipped", async () => {
    // The real backend SKIPS unscored lines and renders the rest (linesUsed/linesSkipped)
    // — the rejection must only fire at ZERO coverage, never at a mix.
    const s = await snap();
    const track = s.tracks.find((t) => t.clips.some((c) => c.type === "wave"))!;
    const clipId = track.clips.find((c) => c.type === "wave")!.id;
    await exec("build_skeleton_from_clip", { clipId });
    await new Promise((r) => setTimeout(r, 500));
    expect((await exec("confirm_skeleton", { trackId: track.id })).ok).toBe(true);
    expect((await exec("complete_lyrics", { trackId: track.id })).ok).toBe(true);
    expect((await exec("accept_lyric_proposal", { trackId: track.id, lineIndex: 0, proposalIndex: 0 })).ok).toBe(true);
    expect((await exec("accept_lyric_proposal", { trackId: track.id, lineIndex: 1, proposalIndex: 0 })).ok).toBe(true);
    expect((await exec("set_lyric_line", { trackId: track.id, lineIndex: 2, seedText: "typed later" })).ok).toBe(true);
    const lines = (await snap()).tracks.find((t) => t.id === track.id)!.lyricSheet!.lines;
    expect(lines.map((l) => Boolean(l.hasScore))).toEqual([true, true, false]);
    expect(lines.map((l) => Boolean(l.singable))).toEqual([true, true, false]);

    expect((await exec("create_render_layer", { clipId, adapter: "soulx", mode: "sing" })).ok).toBe(true);
    expect((await exec("render_layer", { clipId })).ok).toBe(true);
    const rl = (await clipById(clipId))?.renderLayer;
    expect(rl?.status).toBe("ready");
    expect(rl?.hasArtifact).toBe(true);
  });
});
