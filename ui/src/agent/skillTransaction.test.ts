// FS-B2a — the pure planner. Its only job is to produce the exact bridge traffic the
// harness sends, deterministically enough that a committed run-script golden can be
// generated from it and replayed against a real engine.

import { describe, expect, it } from "vitest";
import {
  expandSkillTemplate,
  newTransactionId,
  planSkillTransaction,
  transactableSkills,
  untransactableReason,
} from "./skillTransaction";
import { SET_TRACK_LEVEL_SKILL, HOST_PLUGIN_SKILL, REIMAGINE_CLIP_SKILL } from "./skills";

/** Deterministic id source, mirroring how the goldens are generated. */
function fixedIds(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${n++}`;
}

describe("planSkillTransaction", () => {
  it("mints the transaction id FIRST, then one requestId per expanded call", () => {
    const plan = planSkillTransaction(
      SET_TRACK_LEVEL_SKILL,
      { trackId: "t1", db: -6, mute: true },
      fixedIds("id"),
    );

    // The caller owns the transaction id before its first bridge call — that is what makes
    // a lost begin response resolvable by id rather than by inference.
    expect(plan.transactionId).toBe("id-0");
    expect(plan.name).toBe("set_track_level");
    expect(plan.manifest).toEqual([
      { index: 0, requestId: "id-1", command: "set_track_volume" },
      { index: 1, requestId: "id-2", command: "set_track_mute" },
    ]);
  });

  it("each step's envelope metadata matches its manifest entry exactly", () => {
    const plan = planSkillTransaction(
      HOST_PLUGIN_SKILL,
      { trackId: "t1", pluginId: "vital", index: 0, paramIndex: 0, value: 0.5, bypassed: true },
      fixedIds("h"),
    );

    expect(plan.steps.length).toBe(plan.manifest.length);
    plan.steps.forEach((step, i) => {
      const entry = plan.manifest[i];
      expect(step.meta.transactionId).toBe(plan.transactionId);
      expect(step.meta.index).toBe(i);
      expect(step.meta.index).toBe(entry.index);
      expect(step.meta.requestId).toBe(entry.requestId);
      expect(step.call.command).toBe(entry.command);
    });
    // Indices are contiguous from 0 — the engine rejects a manifest that is not.
    expect(plan.manifest.map((e) => e.index)).toEqual([...plan.manifest.keys()]);
  });

  it("request ids are unique within a manifest", () => {
    const plan = planSkillTransaction(
      HOST_PLUGIN_SKILL,
      { trackId: "t1", pluginId: "vital", index: 0, paramIndex: 0, value: 0.5, bypassed: true },
      fixedIds("u"),
    );
    const ids = plan.manifest.map((e) => e.requestId);
    expect(new Set(ids).size).toBe(ids.length);
    // …and no id collides with the transaction id itself.
    expect(ids).not.toContain(plan.transactionId);
  });

  it("an omitted optional slot drops its branch from BOTH manifest and steps", () => {
    const withMute = planSkillTransaction(SET_TRACK_LEVEL_SKILL, { trackId: "t1", db: -6, mute: false }, fixedIds("a"));
    const without = planSkillTransaction(SET_TRACK_LEVEL_SKILL, { trackId: "t1", db: -6 }, fixedIds("b"));

    // mute:false is PRESENT (the branch runs); an omitted mute is not.
    expect(withMute.manifest.map((e) => e.command)).toEqual(["set_track_volume", "set_track_mute"]);
    expect(without.manifest.map((e) => e.command)).toEqual(["set_track_volume"]);
    expect(without.steps.length).toBe(1);
  });

  it("two plans for the same skill never share a transaction id", () => {
    const a = planSkillTransaction(SET_TRACK_LEVEL_SKILL, { trackId: "t1", db: -6 });
    const b = planSkillTransaction(SET_TRACK_LEVEL_SKILL, { trackId: "t1", db: -6 });
    expect(a.transactionId).not.toBe(b.transactionId);
  });

  it("throws rather than planning a call with an unfilled slot", () => {
    expect(() =>
      expandSkillTemplate(
        [{ kind: "command", command: "set_track_volume", args: { trackId: { slot: "nope" } } }],
        { trackId: "t1" },
      ),
    ).toThrow(/unfilled slot "nope"/);
  });

  it("newTransactionId produces distinct, non-empty ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newTransactionId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id.length).toBeGreaterThan(8);
  });
});

describe("SKILL_TRANSACTABILITY accessors", () => {
  it("transactableSkills() excludes the ones with a blocking command", () => {
    const names = transactableSkills().map((s) => s.name);
    expect(names).toContain("set_track_level");
    expect(names).toContain("host_plugin");
    expect(names).not.toContain("reimagine_clip");
    expect(names).not.toContain("arrange_beat");
    expect(names).not.toContain("warp_loop_to_grid");
  });

  it("untransactableReason names the blocking command", () => {
    expect(untransactableReason("set_track_level")).toBeNull();
    expect(untransactableReason(REIMAGINE_CLIP_SKILL.name)).toContain("render_layer");
    expect(untransactableReason("arrange_beat")).toContain("set_metronome");
    expect(untransactableReason("warp_loop_to_grid")).toContain("detect_clip_bpm");
  });

  it("an unknown skill has no verdict and is therefore not transactable", () => {
    expect(untransactableReason("no_such_skill")).toContain("no recorded transactability verdict");
  });
});
