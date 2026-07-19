// Felt-wrong hotkey (⌘⇧F) capture logic — workshop charter 2026-07-19, week-1 item 2.
// "Every 'bench passed but felt wrong' moment becomes a bench task": the capture rows
// are the raw feed for that lane. Pure logic here: the command-diff since the last
// felt-RIGHT waterline (an accept-class command or the previous capture), a compact
// snapshot digest, and the archive row shape (source "felt-wrong" — a NEW lane tag,
// never folded into single-shot SFT surfaces).
import { describe, expect, it, beforeEach } from "vitest";
import {
  buildFeltWrongRow,
  commandsSinceFeltRight,
  snapshotDigest,
  __resetFeltWrongForTests,
} from "./feltWrong";
import type { SessionLogEntry } from "./memory/sessionLog";

const entry = (command: string, ok = true, args: Record<string, unknown> = {}): SessionLogEntry =>
  ({ command, args, ok });

beforeEach(() => __resetFeltWrongForTests());

describe("commandsSinceFeltRight", () => {
  it("returns everything when no accept-class command exists", () => {
    const log = [entry("create_track"), entry("move_clip"), entry("render_layer")];
    expect(commandsSinceFeltRight(log).map((e) => e.command)).toEqual([
      "create_track", "move_clip", "render_layer",
    ]);
  });

  it("cuts at the LAST accept-class command (accept_render / accept_lyric_proposal)", () => {
    const log = [
      entry("move_clip"),
      entry("accept_render"),
      entry("quantize_notes"),
      entry("accept_lyric_proposal"),
      entry("split_clip"),
      entry("undo"),
    ];
    expect(commandsSinceFeltRight(log).map((e) => e.command)).toEqual([
      "split_clip", "undo",
    ]);
  });

  it("advances a waterline on capture so back-to-back captures don't re-report", () => {
    const log = [entry("move_clip"), entry("split_clip")];
    buildFeltWrongRow("drums stiff", log, null);
    expect(commandsSinceFeltRight(log)).toEqual([]);
    const log2 = [...log, entry("trim_clip")];
    expect(commandsSinceFeltRight(log2).map((e) => e.command)).toEqual(["trim_clip"]);
  });

  it("caps the diff at the newest 100 entries", () => {
    const log = Array.from({ length: 150 }, (_, i) => entry(`cmd_${i}`));
    const diff = commandsSinceFeltRight(log);
    expect(diff).toHaveLength(100);
    expect(diff[0].command).toBe("cmd_50");
    expect(diff[99].command).toBe("cmd_149");
  });
});

describe("snapshotDigest", () => {
  it("summarizes tracks/clips/transport without carrying the whole tree", () => {
    const snap = {
      tracks: [
        { id: "1", name: "Drums", clips: [{ id: "c1" }, { id: "c2" }] },
        { id: "2", name: "Bass", clips: [{ id: "c3" }] },
      ],
      transport: { position: 3.25, playing: false },
      session: { name: "demo" },
    };
    expect(snapshotDigest(snap)).toEqual({ tracks: 2, clips: 3, position: 3.25 });
  });

  it("degrades to zeros on a null snapshot", () => {
    expect(snapshotDigest(null)).toEqual({ tracks: 0, clips: 0, position: null });
  });
});

describe("buildFeltWrongRow", () => {
  it("builds the archive row: source tag, version, trimmed tag, diff, digest", () => {
    const log = [entry("accept_render"), entry("move_clip", false, { clipId: "9" })];
    const snap = { tracks: [{ id: "1", clips: [] }], transport: { position: 0 } };
    const row = buildFeltWrongRow("  Hats   Rushed  ", log, snap);
    expect(row.source).toBe("felt-wrong");
    expect(row.v).toBe(1);
    expect(row.tag).toBe("hats rushed");
    expect(row.commandsSince).toEqual([{ command: "move_clip", args: { clipId: "9" }, ok: false }]);
    expect(row.snapshotDigest).toEqual({ tracks: 1, clips: 0, position: 0 });
    expect(row.snapshot).toEqual(snap); // small snapshot rides along
  });

  it("drops the full snapshot above the size gate but keeps the digest", () => {
    const big = {
      tracks: [{ id: "1", clips: [], pad: "x".repeat(300_000) }],
      transport: { position: 1 },
    };
    const row = buildFeltWrongRow("mix mud", [], big);
    expect(row.snapshot).toBeNull();
    expect(row.snapshotDigest.tracks).toBe(1);
  });

  it("rejects an empty tag", () => {
    expect(() => buildFeltWrongRow("   ", [], null)).toThrow();
  });
});
