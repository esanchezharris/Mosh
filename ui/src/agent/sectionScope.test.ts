import { describe, it, expect } from "vitest";
import { resolveSectionRework, planSectionRework, matchSection, type SectionRework } from "./sectionScope";
import type { Snapshot, Section, Clip } from "../types";

const sec = (id: string, name: string, startBeat: number, endBeat: number): Section => ({ id, name, startBeat, endBeat });
const clip = (id: string, type: Clip["type"], start: number, length: number, extra: Partial<Clip> = {}): Clip =>
  ({ id, name: id, type, start, length, offset: 0, hasRenderLayer: false, ...extra });
const snap = (clips: Clip[], sections: Section[], tempo = 120): Snapshot =>
  ({ session: { tempo, timeSigNumerator: 4, timeSigDenominator: 4 }, tracks: [{ id: "t1", name: "Audio", clips }], sections } as unknown as Snapshot);

// tempo 120 → 0.5 s/beat. Hook beats 24–40 → 12–20 s.
const HOOK = sec("s-hook", "Hook", 24, 40);
const ok = (r: SectionRework | null) => {
  expect(r?.kind).toBe("ok");
  return r as Extract<SectionRework, { kind: "ok" }>;
};

describe("resolveSectionRework", () => {
  it("ignores non-rework requests (falls through to the LLM)", () => {
    expect(resolveSectionRework("play the drums", snap([clip("c1", "wave", 0, 32)], [HOOK]))).toBeNull();
    expect(resolveSectionRework("make the hook louder", snap([clip("c1", "wave", 0, 32)], [HOOK]))).toBeNull();
  });

  it("returns null when there are no sections or no named section matches", () => {
    expect(resolveSectionRework("rework the hook", snap([clip("c1", "wave", 0, 32)], []))).toBeNull();
    expect(resolveSectionRework("rework the bridge", snap([clip("c1", "wave", 0, 32)], [HOOK]))).toBeNull();
    expect(resolveSectionRework("rework the hook", null)).toBeNull();
  });

  it("scopes a render to the section's beat range (clamped to the clip)", () => {
    const r = ok(resolveSectionRework("rework the hook", snap([clip("c1", "wave", 0, 32)], [HOOK])));
    expect(r.section.id).toBe("s-hook");
    expect(r.clip.id).toBe("c1");
    expect(r.regionStart).toBeCloseTo(12);
    expect(r.regionEnd).toBeCloseTo(20);
    expect(r.prompt).toBeUndefined();
  });

  it("clamps the region to the overlapping clip's bounds", () => {
    // Clip only covers 14–18 s; the section is 12–20 s.
    const r = ok(resolveSectionRework("reimagine the hook", snap([clip("c1", "wave", 14, 4)], [HOOK])));
    expect(r.regionStart).toBeCloseTo(14);
    expect(r.regionEnd).toBeCloseTo(18);
  });

  it("picks the wave clip with the largest overlap and ignores MIDI clips", () => {
    const clips = [clip("midi", "midi", 12, 8), clip("small", "wave", 12, 2), clip("big", "wave", 10, 12)];
    const r = ok(resolveSectionRework("rework the hook", snap(clips, [HOOK])));
    expect(r.clip.id).toBe("big");
  });

  it("matches a section by a known alias (chorus → Hook)", () => {
    const r = ok(resolveSectionRework("rework the chorus", snap([clip("c1", "wave", 0, 32)], [HOOK])));
    expect(r.section.id).toBe("s-hook");
  });

  it('handles "redo the hook" (the resolver runs before the fast path, which owns bare "redo")', () => {
    const r = ok(resolveSectionRework("redo the hook", snap([clip("c1", "wave", 0, 32)], [HOOK])));
    expect(r.section.id).toBe("s-hook");
  });

  it("ignores a clip that only grazes the section (sliver overlap → empty)", () => {
    // Clip [11.9, 12.05] overlaps the 12–20 s Hook by only 0.05 s — not "the" section clip.
    const r = resolveSectionRework("rework the hook", snap([clip("g", "wave", 11.9, 0.15)], [HOOK]));
    expect(r?.kind).toBe("empty");
  });

  it("does not extract garbage steers from ordinary connectives (as/like/more)", () => {
    const mk = (t: string) => ok(resolveSectionRework(t, snap([clip("c1", "wave", 0, 32)], [HOOK])));
    expect(mk("rework the hook like the verse").prompt).toBeUndefined();
    expect(mk("rework the hook as it repeats too much").prompt).toBeUndefined();
    expect(mk("switch up the hook more").prompt).toBeUndefined();
    // …but an unambiguous "into/to sound" introducer is still kept.
    expect(mk("rework the hook to sound darker").prompt).toBe("darker");
  });

  it("reports an empty section when nothing overlaps it", () => {
    const r = resolveSectionRework("rework the hook", snap([clip("m", "midi", 12, 8)], [HOOK]));
    expect(r?.kind).toBe("empty");
    if (r?.kind === "empty") expect(r.reason).toMatch(/Hook/);
  });

  it("extracts an optional steer from the tail of the utterance", () => {
    const r = ok(resolveSectionRework("rework the hook into something darker", snap([clip("c1", "wave", 0, 32)], [HOOK])));
    expect(r.prompt).toBe("something darker");
  });

  it("respects tempo when converting beats → seconds", () => {
    // 60 BPM → 1 s/beat, so Hook 24–40 beats → 24–40 s.
    const r = ok(resolveSectionRework("rework the hook", snap([clip("c1", "wave", 0, 64)], [HOOK], 60)));
    expect(r.regionStart).toBeCloseTo(24);
    expect(r.regionEnd).toBeCloseTo(40);
  });
});

describe("planSectionRework", () => {
  it("emits region-scoped create + render + a loop park, all real commands", () => {
    const r = ok(resolveSectionRework("rework the hook", snap([clip("c1", "wave", 0, 32)], [HOOK])));
    const plan = planSectionRework(r);
    const create = plan.find((c) => c.command === "create_render_layer");
    expect(create?.args).toMatchObject({ clipId: "c1", regionStart: 12, regionEnd: 20 });
    expect(plan.map((c) => c.command)).toContain("render_layer");
    const loop = plan.find((c) => c.command === "set_transport");
    expect(loop?.args).toMatchObject({ loop: true, loopStart: 12, loopEnd: 20 });
    // no pre-existing layer → no remove step
    expect(plan.some((c) => c.command === "remove_render_layer")).toBe(false);
  });

  it("clears an existing layer first so the new region takes", () => {
    const r = ok(resolveSectionRework("rework the hook", snap([clip("c1", "wave", 0, 32, { hasRenderLayer: true })], [HOOK])));
    const plan = planSectionRework(r);
    expect(plan[0]).toEqual({ command: "remove_render_layer", args: { clipId: "c1" } });
  });

  it("includes a prompt step only when a steer was extracted", () => {
    const r = ok(resolveSectionRework("rework the hook into a lush pad", snap([clip("c1", "wave", 0, 32)], [HOOK])));
    const setp = planSectionRework(r).find((c) => c.command === "set_render_param");
    expect(setp?.args).toMatchObject({ clipId: "c1", prompt: "a lush pad" });
  });
});

describe("matchSection", () => {
  it("prefers the longest matching label and is word-boundary aware", () => {
    const sections = [sec("a", "Intro", 0, 8), sec("b", "Hook", 24, 40)];
    expect(matchSection("rework the hook", sections)?.id).toBe("b");
    expect(matchSection("rework the intro", sections)?.id).toBe("a");
    expect(matchSection("rework the verse", sections)).toBeNull();
  });

  it("prefers a literal section NAME over another section's alias collision (order-independent)", () => {
    // "Drop" aliases "hook"; the section literally named "Hook" must win regardless of order.
    expect(matchSection("rework the hook", [sec("d", "Drop", 0, 8), sec("h", "Hook", 24, 40)])?.id).toBe("h");
    expect(matchSection("rework the hook", [sec("h", "Hook", 24, 40), sec("d", "Drop", 0, 8)])?.id).toBe("h");
    // A literal "hook" word beats a longer alias ("introduction") on another section.
    expect(matchSection("rework the hook in the introduction", [sec("h", "Hook", 24, 40), sec("i", "Intro", 0, 8)])?.id).toBe("h");
  });
});
