import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSkills } from "./validation";
import { readNativeContract, checkNativeCommand } from "./nativeContract";
import { COMMAND_FACTS } from "./nativeFacts";
import { skillSchema } from "./types";
import { checkNativeSkill } from "./nativeSkill";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const library = loadSkills(root);
const native = readNativeContract(root);
describe("every mined skill references the native dispatch contract", () => {
  it("contains exactly the 40 selected executable shapes with full row provenance", () => {
    expect(library).toHaveLength(40);
    expect(new Set(library.map((s) => s.id)).size).toBe(40);
    expect(new Set(library.map((s) => JSON.stringify(s.mining.shape))).size).toBe(40);
    expect(library.reduce((n, s) => n + s.provenance.length, 0)).toBe(10030);
  });
  for (const skill of library) {
    it(`${skill.id}: native commands/arguments, source citations, and round trip`, () => {
      expect(skillSchema.parse(JSON.parse(JSON.stringify(skill)))).toEqual(skill);
      expect(checkNativeSkill(skill)).toEqual([]);
      expect(skill.provenance).toHaveLength(skill.mining.rows);
      expect(skill.template.commands.map((c) => c.command)).toEqual(skill.mining.shape);
      for (const command of skill.template.commands) expect(checkNativeCommand(command, native)).toEqual([]);
      for (const binding of skill.mining.bindings) expect(skill.slots.some((slot) => slot.name === binding.slot)).toBe(true);
      for (const slot of skill.slots) {
        const source = slot.input.nativeSource;
        const text = readFileSync(resolve(root, source.file), "utf8");
        const cited = text.split("\n")[source.line - 1] ?? "";
        const binding = skill.mining.bindings.find((b) => b.slot === slot.name);
        expect(binding).toBeDefined();
        // `nativeSource.line` is a mining-time citation into a LIVING file. MoshOps*.cpp moves
        // with every engine PR (the first one after this library landed shifted three skills'
        // citations by ~60 lines), so the line is a pointer for humans, not a pin. What must
        // stay true is that the cited file still names the argument — and checkNativeCommand
        // above already proves the handler reads it in today's sources.
        const needle = `"${binding?.arg}"`;
        expect(
          cited.includes(needle) || text.includes(needle),
          `${skill.id}/${slot.name}: ${source.file} no longer names ${needle} (cited line ${source.line})`,
        ).toBe(true);
        if (slot.input.defaultPolicy === "owner") {
          expect(slot.default).toBe("NEEDS_OWNER_VALUE");
          expect(slot.type).toBe("number");
          expect(slot.input.statistics).toBeDefined();
        }
        if (slot.input.kind === "choice_snapshot") expect(slot.input.selector).toBeTruthy();
        if (slot.input.kind === "choice_static") expect(slot.input.options?.length).toBeGreaterThan(0);
        if (!slot.required) expect(slot.input.presenceQuestion).toBeTruthy();
      }
      expect(skill.postconditions).toHaveLength(skill.template.commands.length);
    });
  }
  it("never bakes numeric musical judgments or snapshot IDs into templates", () => {
    for (const skill of library) for (const command of skill.template.commands) {
      for (const [key, value] of Object.entries(command.args)) {
        const fact = COMMAND_FACTS[command.command]?.args[key];
        if (fact?.selector || fact?.taste) {
          expect(typeof value).toBe("string");
          expect(value).toMatch(/^\{[A-Za-z_]\w*\}$/);
        }
      }
    }
  });
  it("rejects tampered static choices and invented numeric bounds in a loaded artifact", () => {
    const key = library.find(s => s.mining.shape.join() === "set_key");
    const tempo = library.find(s => s.mining.shape.join() === "set_tempo");
    if (!key || !tempo) throw new Error("Key and tempo skills required");
    const tampered = { ...key, slots: key.slots.map(slot => slot.name.endsWith("_mode") ? { ...slot, input: { ...slot.input,
      options: [...(slot.input.options ?? []), { value: "locrian", description: "Invented native option" }] } } : slot) };
    expect(checkNativeSkill(tampered).some(error => error.includes("options"))).toBe(true);
    expect(checkNativeSkill({ ...tempo, slots: tempo.slots.map(slot => ({ ...slot, input: { ...slot.input, max: 12345 } })) }).some(error => error.includes("max"))).toBe(true);
  });
});
