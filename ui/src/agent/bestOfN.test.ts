import { describe, expect, it, vi } from "vitest";
import { maybeEscalate, maybeValidatorRetry, firstValidationError } from "./bestOfN";
import { buildManifest, classifyCommands, serializeCatalog, TASTE_COMMANDS } from "./policy";
import type { BrainReply } from "./brainCore";
import type { Snapshot } from "../types";

const SNAP = {
  tracks: [
    { id: "track_1", name: "Piano", clips: [{ id: "clip_1" }, { id: "clip_2" }] },
    { id: "track_2", name: "Bass", clips: [] },
  ],
  sections: [{ id: "sec_1" }],
} as unknown as Snapshot;

const note = (clip = "clip_1") => ({ command: "add_note", args: { clipId: clip, pitch: 60, start: 0, length: 1 } });
const tasteReply: BrainReply = { intent: "ACK_GOT_IT", say: "on it", commands: [note(), note()] };
const messages = [{ role: "system", content: "SYS" }, { role: "user", content: "melody please" }];

describe("policy", () => {
  it("classifies taste vs corrective by majority", () => {
    expect(classifyCommands([note()])).toBe("taste");
    expect(classifyCommands([{ command: "rename_track", args: {} }])).toBe("corrective");
    // mixed: 1 taste of 3 → corrective (no cloud burn on a rename with a note tweak)
    expect(classifyCommands([note(), { command: "rename_track" }, { command: "save" }])).toBe("corrective");
    expect(classifyCommands([])).toBe("corrective");
  });
  it("taste set covers the program's three families", () => {
    for (const c of ["add_note", "set_render_param", "move_clip", "create_section"]) {
      expect(TASTE_COMMANDS.has(c)).toBe(true);
    }
  });
  it("buildManifest extracts live id sets", () => {
    expect(buildManifest(SNAP)).toEqual({
      trackIds: ["track_1", "track_2"], clipIds: ["clip_1", "clip_2"],
      sectionIds: ["sec_1"], annotationIds: [],
    });
    expect(buildManifest(null).trackIds).toEqual([]);
  });
  it("serializeCatalog mirrors commands.ts (source of truth by construction)", () => {
    const cat = serializeCatalog();
    const addNote = cat.find((c) => c.command === "add_note");
    expect(addNote?.args.find((a) => a.name === "clipId")).toEqual({ name: "clipId", type: "string", required: true });
    expect(addNote?.args.find((a) => a.name === "velocity")?.required).toBe(false);
    expect(cat.length).toBeGreaterThan(50);
  });
});

describe("maybeEscalate", () => {
  const okResponse = {
    ok: true, degraded: false, firstIndex: 1, tieBreak: false,
    candidates: [{ say: "better", intent: "ACK_GOT_IT", commands: [note("clip_2")], score: 1 }],
  };

  it("escalates a taste reply and returns the top candidate", async () => {
    const escalate = vi.fn().mockResolvedValue(okResponse);
    const r = await maybeEscalate("melody please", tasteReply, SNAP, messages, { enabled: () => true, escalate });
    expect(r?.escalated).toBe(true);
    expect(r?.reply.commands).toEqual([note("clip_2")]);
    expect(r?.firstIndex).toBe(1);
    // the payload carries the verbatim messages + manifest + catalog + candidate #0
    const payload = escalate.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.messages).toBe(messages);
    expect((payload.first as { commands: unknown[] }).commands).toEqual(tasteReply.commands);
    expect((payload.manifest as { clipIds: string[] }).clipIds).toContain("clip_1");
  });

  it("flag off / corrective / no commands → null (no bridge call)", async () => {
    const escalate = vi.fn();
    expect(await maybeEscalate("x", tasteReply, SNAP, messages, { enabled: () => false, escalate })).toBeNull();
    expect(await maybeEscalate("x", { intent: "ACK_GOT_IT", commands: [{ command: "rename_track" }] }, SNAP, messages,
      { enabled: () => true, escalate })).toBeNull();
    expect(await maybeEscalate("x", { intent: "HUH", say: "which?" }, SNAP, messages,
      { enabled: () => true, escalate })).toBeNull();
    expect(escalate).not.toHaveBeenCalled();
  });

  it("degraded / error / empty-top → null (single-shot stands)", async () => {
    for (const resp of [
      Promise.resolve({ ...okResponse, degraded: true }),
      Promise.resolve({ ok: true, degraded: false, candidates: [{ commands: [] }] }),
      Promise.reject(new Error("service down")),
    ]) {
      const r = await maybeEscalate("x", tasteReply, SNAP, messages,
        { enabled: () => true, escalate: () => resp as Promise<unknown> });
      expect(r).toBeNull();
    }
  });

  it("times out to null instead of hanging the turn", async () => {
    const never = () => new Promise<unknown>(() => undefined);
    const r = await maybeEscalate("x", tasteReply, SNAP, messages,
      { enabled: () => true, escalate: never, timeoutMs: 20 });
    expect(r).toBeNull();
  });
});

describe("maybeValidatorRetry", () => {
  const bad: BrainReply = { intent: "ACK_GOT_IT", commands: [{ command: "rename_track", args: { trackId: "t1" } }] };
  const goodJson = JSON.stringify({ intent: "ACK_GOT_IT", say: "fixed",
    commands: [{ command: "rename_track", args: { trackId: "t1", name: "Keys" } }] });

  it("finds the exact validation failure", () => {
    expect(firstValidationError(bad.commands!)).toContain("rename_track");
    expect(firstValidationError([{ command: "save", args: {} }])).toBeNull();
  });

  it("re-prompts once with the failure, archives the pair, returns the corrected reply", async () => {
    const chat = vi.fn().mockResolvedValue({ content: goodJson });
    const archive = vi.fn().mockResolvedValue(undefined);
    const r = await maybeValidatorRetry("rename it", bad, messages, {
      enabled: () => true, chat, archive,
      parse: (c) => JSON.parse(c) as BrainReply,
    });
    expect(r?.commands?.[0].args).toEqual({ trackId: "t1", name: "Keys" });
    const retryPrompt = (chat.mock.calls[0][0] as { content: string }[]).at(-1)!.content;
    expect(retryPrompt).toContain("failed validation");
    expect(retryPrompt).toContain("rename_track");
    expect(archive).toHaveBeenCalledOnce();
    expect((archive.mock.calls[0][0] as { source: string }).source).toBe("corrective-retry");
  });

  it("valid reply / taste reply / still-bad retry → null, no archive", async () => {
    const archive = vi.fn();
    const deps = { enabled: () => true, chat: vi.fn().mockResolvedValue({ content: "{}" }), archive,
      parse: () => ({ intent: "ACK_GOT_IT" }) as BrainReply };
    expect(await maybeValidatorRetry("x", { intent: "A", commands: [{ command: "save", args: {} }] }, messages, deps)).toBeNull();
    expect(await maybeValidatorRetry("x", tasteReply, messages, deps)).toBeNull();
    expect(await maybeValidatorRetry("x", bad, messages, deps)).toBeNull(); // retry parsed to no commands
    expect(archive).not.toHaveBeenCalled();
  });
});
