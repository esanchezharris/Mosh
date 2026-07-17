import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

describe("copyText", () => {
  const origClipboard = navigator.clipboard;
  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", { value: origClipboard, configurable: true });
    vi.restoreAllMocks();
  });

  it("returns false for an empty string without touching the clipboard", async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    expect(await copyText("")).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("uses navigator.clipboard.writeText when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    expect(await copyText("/Users/x/mix.wav")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("/Users/x/mix.wav");
  });

  it("falls back to execCommand when navigator.clipboard throws", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const exec = vi.fn().mockReturnValue(true);
    (document as unknown as { execCommand: typeof exec }).execCommand = exec;
    expect(await copyText("/Users/x/mix.wav")).toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("falls back to execCommand when navigator.clipboard is absent", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const exec = vi.fn().mockReturnValue(true);
    (document as unknown as { execCommand: typeof exec }).execCommand = exec;
    expect(await copyText("/Users/x/mix.wav")).toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("returns false when both paths fail", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    (document as unknown as { execCommand: () => boolean }).execCommand = () => false;
    expect(await copyText("/Users/x/mix.wav")).toBe(false);
  });
});
