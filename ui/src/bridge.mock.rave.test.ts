import { describe, it, expect, beforeEach } from "vitest";
import { mockExecute, mockSnapshot, __resetMockForTests } from "./bridge.mock";
import type { Snapshot, CommandResult } from "./types";

// Lane B — the RAVE model browser (list_rave_models) + the live insert round-trip. Exercises the
// dev mock the WebView/e2e run against: browse the model library, add a RAVE insert, load a model,
// set the dry/wet mix.

const exec = (command: string, args: Record<string, unknown> = {}) =>
  mockExecute<CommandResult<Record<string, unknown>>>({ command, args });
const snap = () => mockSnapshot<Snapshot>();

describe("mock RAVE model browser + insert (Lane B)", () => {
  beforeEach(() => __resetMockForTests());

  it("list_rave_models returns the model library", async () => {
    const r = await exec("list_rave_models");
    expect(r.ok).toBe(true);
    const models = (r.data as { models?: { name: string }[] }).models ?? [];
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => typeof m.name === "string")).toBe(true);
  });

  it("add a RAVE insert, load a browsed model, set mix", async () => {
    const s = await snap();
    const track = s.tracks[0];
    if (!track) throw new Error("no track in the mock");
    const trackId = track.id;
    const findRave = (snapshot: Snapshot) =>
      snapshot.tracks.find((t) => t.id === trackId)?.plugins?.find((p) => p.rave);

    expect((await exec("add_rave_insert", { trackId })).ok).toBe(true);
    const rave1 = findRave(await snap());
    expect(rave1?.rave).toBeTruthy();
    const idx = rave1?.index ?? 0;

    // load a model from the browser (target = a .ts stem)
    expect((await exec("load_rave_model", { trackId, pluginIndex: idx, target: "guitar" })).ok).toBe(true);
    expect(findRave(await snap())?.rave?.modelLoaded).toBe(true);

    // dry/wet mix
    expect((await exec("set_rave_param", { trackId, index: idx, paramId: "mix", value: 40 })).ok).toBe(true);
    expect(Math.round(findRave(await snap())?.rave?.mix ?? -1)).toBe(40);
  });
});
