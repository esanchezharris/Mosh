import { describe, it, expect, vi } from "vitest";
import { buildSessionDigest, polishSessionSummary } from "./sessionSummary";
import type { SessionLogEntry } from "./sessionLog";

const e = (command: string, args: Record<string, unknown> = {}, ok = true): SessionLogEntry => ({ command, args, ok });

describe("buildSessionDigest", () => {
  it("returns empty string for an empty log", () => {
    expect(buildSessionDigest([])).toBe("");
  });

  it("filters out noisy/bookkeeping commands entirely", () => {
    const log = [
      e("get_snapshot"), e("batch_begin"), e("batch_end"), e("undo"), e("redo"),
      e("save"), e("set_transport"), e("agent_memory_write"), e("agent_memory_read"),
      e("list_plugins"), e("remember_preference"),
    ];
    expect(buildSessionDigest(log)).toBe("");
  });

  it("filters out failed commands", () => {
    const log = [e("create_track", { name: "Hats" }, false)];
    expect(buildSessionDigest(log)).toBe("");
  });

  // Regression: store.ts's init() fires enable_all_meters unconditionally on every page
  // load — a producer never chose to run it, so it must never surface in a "what did the
  // producer do this session" digest (see the NOISY_EXACT comment for the full story —
  // this exact gap caused a stray real brainChat call on the FIRST project switch of an
  // otherwise-idle session, which broke an unrelated e2e safety assertion).
  it("filters out enable_all_meters (fires automatically at app init, not a producer choice)", () => {
    const log = [e("enable_all_meters"), e("enable_all_meters")];
    expect(buildSessionDigest(log)).toBe("");
  });

  it("describes a real command via describeCommand's own vocabulary", () => {
    const log = [e("create_track", { name: "Hats" })];
    const digest = buildSessionDigest(log);
    expect(digest).toBe("- Added track \"Hats\"");
  });

  it("dedupes repeats into a ×N count, most-frequent first, ties broken by first occurrence", () => {
    const log = [
      e("create_track", { name: "A" }),
      e("create_track", { name: "B" }),
      e("set_track_volume", { trackId: "1", db: -3 }),
      e("set_track_volume", { trackId: "1", db: -3 }),
      e("set_track_volume", { trackId: "1", db: -3 }),
    ];
    const digest = buildSessionDigest(log);
    const lines = digest.split("\n");
    expect(lines[0]).toContain("×3");
    expect(lines[0]).toContain("Set track volume");
  });

  it("caps at maxLines (default 4)", () => {
    const log = Array.from({ length: 10 }, (_, i) => e("create_track", { name: `T${i}` }));
    const digest = buildSessionDigest(log);
    expect(digest.split("\n")).toHaveLength(4);
  });

  it("respects a custom maxLines", () => {
    const log = Array.from({ length: 10 }, (_, i) => e("create_track", { name: `T${i}` }));
    expect(buildSessionDigest(log, 2).split("\n")).toHaveLength(2);
  });
});

describe("polishSessionSummary", () => {
  it("returns the digest unchanged when it's already empty (no chat call)", async () => {
    const chat = vi.fn();
    expect(await polishSessionSummary("", chat)).toBe("");
    expect(chat).not.toHaveBeenCalled();
  });

  it("returns the chat's polished text on success", async () => {
    const chat = vi.fn(async () => ({ content: "Built out a Hats track and turned it down a touch." }));
    const digest = "- Created track \"Hats\"\n- Set track 1 volume to -3.0 dB";
    expect(await polishSessionSummary(digest, chat)).toBe("Built out a Hats track and turned it down a touch.");
  });

  it("falls back to the raw digest when chat throws", async () => {
    const chat = vi.fn(async () => { throw new Error("brain unavailable"); });
    const digest = "- Created track \"Hats\"";
    expect(await polishSessionSummary(digest, chat)).toBe(digest);
  });

  it("falls back to the raw digest when chat returns an empty reply", async () => {
    const chat = vi.fn(async () => ({ content: "   " }));
    const digest = "- Created track \"Hats\"";
    expect(await polishSessionSummary(digest, chat)).toBe(digest);
  });
});
