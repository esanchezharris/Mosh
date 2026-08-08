import { describe, it, expect } from "vitest";
import { TEMPLATES, template, templateValues } from "./templates";
import { settingDef, coerceSetting } from "./schema";

// A template is a named bundle of values over the schema. These tests pin that
// every built-in template references only real settings with valid values, so
// "select a template" can never write garbage into the store.

describe("built-in templates", () => {
  it("ships the five DAW built-ins + the live-clone shell bundle", () => {
    expect(TEMPLATES.map((t) => t.name).sort()).toEqual(["ableton", "fl", "live", "logic", "mosh", "protools"]);
  });

  it("references only valid schema ids", () => {
    for (const t of TEMPLATES)
      for (const id of Object.keys(t.values))
        expect(settingDef(id), `${t.name}.${id}`).toBeDefined();
  });

  it("carries only already-valid values (coercion is a no-op)", () => {
    for (const t of TEMPLATES)
      for (const [id, v] of Object.entries(t.values))
        expect(coerceSetting(id, v), `${t.name}.${id}`).toEqual(v);
  });

  it("gives each DAW built-in a distinct skin (the live bundle is the one exception)", () => {
    // The five DAW templates are pure re-skins — distinct skin per template. "live"
    // is NOT a re-skin: it mounts its own shell (ui/src/live), so it reuses the
    // ableton skin and pins uiShell instead.
    const daw = TEMPLATES.filter((t) => t.name !== "live");
    expect(new Set(daw.map((t) => t.values.skin)).size).toBe(daw.length);
  });

  it("the live bundle switches the shell and loads the ableton interaction model", () => {
    const live = template("live");
    expect(live?.values.uiShell).toBe("live");
    expect(live?.values.gestureTable).toBe("ableton");
    expect(live?.values.keymap).toBe("ableton");
  });

  it("pins a panel layout per template (FL = its floating layout)", () => {
    expect(template("mosh")?.values.layout).toBe("mosh");
    expect(template("ableton")?.values.layout).toBe("ableton");
    expect(template("fl")?.values.layout).toBe("fl");
    expect(template("protools")?.values.layout).toBe("protools");
    expect(template("logic")?.values.layout).toBe("logic");
  });
});

describe("template lookup", () => {
  it("returns a template by name and undefined for an unknown one", () => {
    expect(template("ableton")?.values.skin).toBe("ableton");
    expect(template("nope")).toBeUndefined();
  });

  it("templateValues returns a coerced copy for a known template", () => {
    const v = templateValues("fl");
    expect(v.skin).toBe("fl");
    expect(v.theme).toBe("dark");
  });

  it("templateValues returns {} for an unknown template", () => {
    expect(templateValues("nope")).toEqual({});
  });
});
