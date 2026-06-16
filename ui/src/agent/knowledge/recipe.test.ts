import { describe, it, expect } from "vitest";
import { bindRecipe } from "./recipe";

// bindRecipe resolves the `$token` placeholders a hand-seeded recipe card carries into
// the REAL session ids the base builder captured — so the card stays session-agnostic.
describe("bindRecipe — resolves $token placeholders against the base's real ids", () => {
  it("replaces a $token string value with its binding", () => {
    const out = bindRecipe([{ command: "quantize_notes", args: { clipId: "$hatsClipId", swing: 0.58 } }], { hatsClipId: "c12" });
    expect(out).toEqual([{ command: "quantize_notes", args: { clipId: "c12", swing: 0.58 } }]);
  });

  it("resolves tokens inside array args (e.g. trackIds), leaving non-$ strings alone", () => {
    const out = bindRecipe(
      [{ command: "create_group_track", args: { trackIds: ["$drumTrackId", "$bassTrackId"], name: "Drums" } }],
      { drumTrackId: "t1", bassTrackId: "t2" },
    );
    expect(out[0].args.trackIds).toEqual(["t1", "t2"]);
    expect(out[0].args.name).toBe("Drums");
  });

  it("binds a numeric slot ($paramIndex) to its NUMBER value, not a string", () => {
    const out = bindRecipe(
      [{ command: "add_automation_point", args: { trackId: "$keysTrackId", pluginIndex: "$keysFilterPluginIndex", paramIndex: "$keysFilterParamIndex", time: 0, value: 0.2 } }],
      { keysTrackId: "t3", keysFilterPluginIndex: 0, keysFilterParamIndex: 2 },
    );
    expect(out[0].args).toEqual({ trackId: "t3", pluginIndex: 0, paramIndex: 2, time: 0, value: 0.2 });
  });

  it("leaves an UNBOUND $token as a literal string (so validateCommand trips it, a clear authoring error)", () => {
    const out = bindRecipe([{ command: "set_note", args: { clipId: "$nope" } }], {});
    expect(out[0].args.clipId).toBe("$nope");
  });

  it("does not mutate the input commands", () => {
    const input = [{ command: "x", args: { a: "$k" } }];
    bindRecipe(input, { k: "v" });
    expect(input[0].args.a).toBe("$k");
  });
});
