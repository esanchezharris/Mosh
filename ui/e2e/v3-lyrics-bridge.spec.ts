import { test, expect, type Page } from "@playwright/test";
import { bootV3 } from "./helpers";

// NO-V3-UI, temporary. The paused Finish-My-Song lyrics commands lost their only UI (the
// retired shells' Lyrics tab) in shell retirement step 3. The owner decided to remove them
// (docs/SHELL-RETIREMENT-PLAN-2026-11-17.md §6.3); they go with friends slice 2 (AI off),
// which removes this file with them. Until then the command contract stays exercised here,
// through the store's exec (the same execute_command path the UI uses), from a V3 boot.

type Res = { ok: boolean; error?: string; data?: Record<string, unknown> };
type Line = { index: number; status?: string; proposals?: unknown[] };
type Trk = { id: string; clips: { id: string; type: string }[]; lyricSheet?: { lines: Line[] } };
type St = { snapshot: { tracks: Trk[] }; exec: (c: string, a?: object) => Promise<Res> };

const exec = (page: Page, command: string, args: object = {}) =>
  page.evaluate(([c, a]) => (window as unknown as { __moshStore: { getState: () => St } })
    .__moshStore.getState().exec(c as string, a as object), [command, args] as const);
const track = (page: Page, id: string) =>
  page.evaluate((tid) => JSON.parse(JSON.stringify((window as unknown as { __moshStore: { getState: () => St } })
    .__moshStore.getState().snapshot.tracks.find((t) => t.id === tid))) as Trk, id);

test("the lyrics commands still answer through the bridge (NO-V3-UI, until slice 2)", async ({ page }) => {
  await bootV3(page);
  const wave = await page.evaluate(() => {
    const s = (window as unknown as { __moshStore: { getState: () => St } }).__moshStore.getState().snapshot;
    const t = s.tracks.find((x) => x.clips.some((c) => c.type === "wave"))!;
    return { trackId: t.id, clipId: t.clips.find((c) => c.type === "wave")!.id };
  });

  expect((await exec(page, "build_lyrics_from_clip", { clipId: wave.clipId })).ok).toBe(true);
  await expect.poll(async () => (await track(page, wave.trackId)).lyricSheet?.lines.length ?? 0).toBeGreaterThan(1);

  const rhymes = await exec(page, "get_rhymes", { word: "flame", strictness: "slant" });
  expect(rhymes.ok).toBe(true);
  expect((await exec(page, "analyze_lyrics", { trackId: wave.trackId })).ok).toBe(true);

  expect((await exec(page, "complete_lyrics", { trackId: wave.trackId })).ok).toBe(true);
  const proposed = (await track(page, wave.trackId)).lyricSheet!.lines.filter((l) => (l.proposals?.length ?? 0) > 0);
  expect(proposed.length).toBeGreaterThan(1);
  const [first, second] = proposed;

  expect((await exec(page, "accept_lyric_proposal", { trackId: wave.trackId, lineIndex: first.index, proposalIndex: 0 })).ok).toBe(true);
  expect((await exec(page, "reject_lyric_proposal", { trackId: wave.trackId, lineIndex: second.index })).ok).toBe(true);
  expect((await exec(page, "fill_lyric_gap", { trackId: wave.trackId, lineIndex: second.index })).ok).toBe(true);
  expect((await exec(page, "regenerate_lyric", { trackId: wave.trackId, lineIndex: second.index })).ok).toBe(true);
  expect((await exec(page, "suggest_next_line", { trackId: wave.trackId, afterIndex: first.index })).ok).toBe(true);

  const stats = await exec(page, "get_lyric_corpus_stats", {});
  expect(stats.ok).toBe(true);
});
