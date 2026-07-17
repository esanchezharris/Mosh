import { describe, it, expect, vi } from "vitest";
import { commitClipDrag } from "./clipDrag";

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("commitClipDrag — optimistic preview rollback", () => {
  const origStart = 1.0;
  const moved = { start: 2.0, length: 1, offset: 0 };

  it("reverts the preview when move_clip is rejected", async () => {
    const exec = vi.fn().mockResolvedValue({ ok: false });
    const setPreview = vi.fn();
    commitClipDrag("move", moved, origStart, "c1", exec, setPreview);
    expect(exec).toHaveBeenCalledWith("move_clip", { clipId: "c1", start: 2.0 });
    await flush();
    expect(setPreview).toHaveBeenCalledWith(null); // snaps back on failure
  });

  it("keeps the preview when move_clip succeeds (snapshot refresh clears it)", async () => {
    const exec = vi.fn().mockResolvedValue({ ok: true });
    const setPreview = vi.fn();
    commitClipDrag("move", moved, origStart, "c1", exec, setPreview);
    await flush();
    expect(setPreview).not.toHaveBeenCalled();
  });

  it("reverts the preview when trim_clip is rejected", async () => {
    const exec = vi.fn().mockResolvedValue({ ok: false });
    const setPreview = vi.fn();
    const trimmed = { start: 1.0, length: 0.5, offset: 0.2 };
    commitClipDrag("trim-r", trimmed, origStart, "c1", exec, setPreview);
    expect(exec).toHaveBeenCalledWith("trim_clip", { clipId: "c1", start: 1.0, length: 0.5, offset: 0.2 });
    await flush();
    expect(setPreview).toHaveBeenCalledWith(null);
  });

  it("keeps the preview when trim_clip succeeds", async () => {
    const exec = vi.fn().mockResolvedValue({ ok: true });
    const setPreview = vi.fn();
    commitClipDrag("trim-l", { start: 1.2, length: 0.8, offset: 0.2 }, origStart, "c1", exec, setPreview);
    await flush();
    expect(setPreview).not.toHaveBeenCalled();
  });

  it("commits a stretch via stretch_clip (length only)", async () => {
    const exec = vi.fn().mockResolvedValue({ ok: true });
    const setPreview = vi.fn();
    commitClipDrag("stretch", { start: 1.0, length: 3.0, offset: 0 }, origStart, "c1", exec, setPreview);
    expect(exec).toHaveBeenCalledWith("stretch_clip", { clipId: "c1", length: 3.0 });
    await flush();
    expect(setPreview).not.toHaveBeenCalled();
  });

  it("reverts the preview when stretch_clip is rejected", async () => {
    const exec = vi.fn().mockResolvedValue({ ok: false });
    const setPreview = vi.fn();
    commitClipDrag("stretch", { start: 1.0, length: 3.0, offset: 0 }, origStart, "c1", exec, setPreview);
    await flush();
    expect(setPreview).toHaveBeenCalledWith(null);
  });

  it("clears the preview with no command on a negligible move", () => {
    const exec = vi.fn();
    const setPreview = vi.fn();
    commitClipDrag("move", { start: 1.0, length: 1, offset: 0 }, origStart, "c1", exec, setPreview);
    expect(exec).not.toHaveBeenCalled();
    expect(setPreview).toHaveBeenCalledWith(null);
  });
});
