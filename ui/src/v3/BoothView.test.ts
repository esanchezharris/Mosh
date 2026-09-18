import { describe, expect, it } from "vitest";
import { boothClipFor } from "./BoothView";
import type { Clip } from "../types";

const clip = (id: string, over: Partial<Clip> = {}): Clip =>
  ({ id, name: id, type: "wave", start: 0, length: 2, offset: 0, hasRenderLayer: false, ...over }) as Clip;

describe("boothClipFor", () => {
  const chords = clip("chords");
  const comp = clip("take", { numTakes: 2 });
  const midi = clip("notes", { type: "midi", notes: [] });

  it("prefers the lifecycle's landed take, then the comp carrying takes, then a wave clip, then anything", () => {
    expect(boothClipFor({ clips: [chords, comp] }, "take")?.id).toBe("take");
    expect(boothClipFor({ clips: [chords, comp] }, null)?.id).toBe("take");        // the transport-toggle stop case
    expect(boothClipFor({ clips: [midi, chords] }, null)?.id).toBe("chords");
    expect(boothClipFor({ clips: [midi] }, null)?.id).toBe("notes");
    expect(boothClipFor({ clips: [] }, null)).toBeUndefined();
    expect(boothClipFor(undefined, "take")).toBeUndefined();
  });

  it("does not let a stale lastTakeClipId from another track win (anti-vacuity)", () => {
    expect(boothClipFor({ clips: [chords] }, "elsewhere")?.id).toBe("chords");
  });
});
