// DURABLE catalog ⇄ backend contract guard.
//
// Parses the C++ command seam (src/moshops/MoshOps.cpp) and asserts that EVERY
// argument the agent catalog (AGENT_COMMANDS) declares is actually read by the
// command's handler. This catches the whole class of "voiced command silently
// no-ops because the catalog declares an arg key the backend never reads" bugs
// (e.g. set_transport `playing` vs `action`) across all ~50 commands — not just
// the ones with a hand-written behavioural test.
//
// How it works (MoshOps.cpp shape, verified):
//   • dispatch:  if (name == "cmd") return cmdHandler (args);
//                or wrapped — if (name == "cmd") return wrapper (name, args, cmdHandler (args));
//                (some ops route the handler through a wrapper, e.g. an MP structural
//                 broadcast — parseDispatch picks the inner cmdXxx(args) either way)
//   • arg reads: args.getProperty ("key", …) / args.hasProperty ("key")
//                (no args["key"] style anywhere in the file)

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { AGENT_COMMANDS, AGENT_COMMAND_MAP } from "./commands";
import { UI_ONLY_COMMANDS } from "./commandClassification";
import {
  SET_TRACK_LEVEL_SKILL,
  SKILL_CATALOG,
  type SkillDefinition,
  type SkillTemplateNode,
  type SkillValue,
} from "./skills";

const here = dirname(fileURLToPath(import.meta.url)); // ui/src/agent
const CPP_PATH = resolve(here, "../../../src/moshops/MoshOps.cpp");
const src = readFileSync(CPP_PATH, "utf8");

// command name → handler function (from the dispatch table). The handler is the
// cmdXxx(args) call — either bare after `return`, or nested inside a wrapper such as
// `return wrapper (name, args, cmdXxx (args));`. `[^;]*?` stays within the single
// dispatch statement (each ends with `;`) and the non-greedy match lands on the inner
// cmdXxx(args) regardless of any wrapper.
export function parseDispatch(cpp: string): Map<string, string> {
  const d = new Map<string, string>();
  for (const m of cpp.matchAll(/if \(name == "([a-z0-9_]+)"\)\s*return [^;]*?(cmd[A-Za-z0-9]+)\s*\(args\)/g))
    d.set(m[1], m[2]);
  return d;
}

const dispatch = parseDispatch(src);

// Slice a handler's source span: from its definition to the next function
// definition (or EOF). This can only ever ATTRIBUTE EXTRA keys (a false pass),
// never drop a real read — so the guard never fails spuriously on brace/string
// edge cases.
function handlerArgKeys(handler: string): Set<string> | null {
  const sig = src.indexOf(`MoshOps::${handler} (`);
  if (sig < 0) return null;
  const next = src.indexOf("\njuce::var MoshOps::", sig + 1);
  const body = src.slice(sig, next < 0 ? undefined : next);
  const keys = new Set<string>();
  for (const m of body.matchAll(/args\.(?:getProperty|hasProperty) ?\("([a-zA-Z0-9_]+)"/g))
    keys.add(m[1]);
  return keys;
}

describe("agent catalog ⇄ MoshOps.cpp argument contract", () => {
  it("found the dispatch table", () => {
    // Sanity: if this drops to ~0 the regex/file moved and every test below is meaningless.
    expect(dispatch.size).toBeGreaterThan(50);
  });

  it("parseDispatch resolves the handler for BOTH bare and wrapper-nested dispatch", () => {
    // The old `return (cmd...)` regex only matched a handler IMMEDIATELY after `return`,
    // so a dispatch that routes the handler through a wrapper — e.g. a structural
    // broadcast — silently dropped out of the table and every arg check for it failed
    // with a spurious "no dispatch entry". This guards the wrapper form.
    const snippet = [
      '    if (name == "set_track_volume")  return cmdSetTrackVolume (args);',
      '    if (name == "set_tempo")         return broadcastStructuralIfActive (name, args, cmdSetTempo (args));',
    ].join("\n");
    const d = parseDispatch(snippet);
    expect(d.get("set_track_volume")).toBe("cmdSetTrackVolume"); // bare form
    expect(d.get("set_tempo")).toBe("cmdSetTempo");              // wrapper-nested (red on the old regex)
  });

  for (const cmd of AGENT_COMMANDS) {
    it(`${cmd.command}: every declared arg is read by its backend handler`, () => {
      const handler = dispatch.get(cmd.command);
      expect(handler, `"${cmd.command}" has no dispatch entry in MoshOps.cpp`).toBeTruthy();
      if (!handler) return;

      const keys = handlerArgKeys(handler);
      expect(keys, `handler ${handler}() not found in MoshOps.cpp`).toBeTruthy();
      if (!keys) return;

      for (const arg of cmd.args)
        expect(
          keys.has(arg.name),
          `${cmd.command}: catalog arg "${arg.name}" is never read by ${handler}() — ` +
            `catalog/seam drift (handler reads: ${[...keys].join(", ") || "nothing"})`,
        ).toBe(true);
    });
  }
});

describe("command classification guard — every native command is deliberately classified", () => {
  // The dispatch table has 203 entries as of the Phase-A audit. A regex rot that
  // silently shrinks the parsed table below the classification universe would make
  // the exhaustiveness test below vacuous — pin a hard floor well above the old
  // >50 sanity check.
  it("the dispatch table is fully parsed (size floor)", () => {
    expect(dispatch.size).toBeGreaterThanOrEqual(190);
  });

  it("every dispatch name is agent-callable OR allowlisted UI-only with a reason", () => {
    const unclassified = [...dispatch.keys()].filter(
      (name) => !AGENT_COMMAND_MAP.has(name) && !(name in UI_ONLY_COMMANDS),
    );
    expect(
      unclassified,
      `new native command(s) are unclassified: ${unclassified.join(", ")} — add each to ` +
        `AGENT_COMMANDS (ui/src/agent/commands.ts) or UI_ONLY_COMMANDS ` +
        `(ui/src/agent/commandClassification.ts) with a one-line reason`,
    ).toEqual([]);
  });

  it("no command is both agent-callable and allowlisted UI-only", () => {
    const overlap = Object.keys(UI_ONLY_COMMANDS).filter((name) => AGENT_COMMAND_MAP.has(name));
    expect(overlap, `classified in BOTH homes: ${overlap.join(", ")}`).toEqual([]);
  });

  it("the allowlist carries no stale entries", () => {
    const stale = Object.keys(UI_ONLY_COMMANDS).filter((name) => !dispatch.has(name));
    expect(stale, `allowlisted but no longer in the dispatch table: ${stale.join(", ")}`).toEqual([]);
  });

  it("every exclusion carries a non-empty reason", () => {
    for (const [name, reason] of Object.entries(UI_ONLY_COMMANDS))
      expect(reason.trim().length, `${name} has an empty reason`).toBeGreaterThan(0);
  });
});

describe("AGT-MEM (M3) — remember_preference stays a pseudo-command, never the real catalog", () => {
  // MEMORY_COMMANDS (memory/rememberPreference.ts) names are intercepted by the
  // executor BEFORE validateCommand and are deliberately NEVER added to
  // AGENT_COMMANDS/commandCatalogPrompt() — the SFT/GEPA/bench prompt must stay
  // byte-stable (see brainCore.ts's buildSystemPrompt contract). This is the guard:
  // if a future change ever adds "remember_preference" (or any future memory
  // pseudo-command) to the real catalog, this fails loudly instead of silently
  // duplicating/contradicting the serve-time-only doc path.
  it("MEMORY_COMMANDS ∩ AGENT_COMMANDS is empty", async () => {
    const { MEMORY_COMMANDS } = await import("./memory/rememberPreference");
    const overlap = [...MEMORY_COMMANDS].filter((name) => AGENT_COMMAND_MAP.has(name));
    expect(overlap, `pseudo-command(s) leaked into the real catalog: ${overlap.join(", ")}`).toEqual([]);
  });

  it("MEMORY_COMMANDS is also not in the native dispatch table (it's a client-only interception, not a real command)", async () => {
    const { MEMORY_COMMANDS } = await import("./memory/rememberPreference");
    const leaked = [...MEMORY_COMMANDS].filter((name) => dispatch.has(name));
    expect(leaked, `pseudo-command(s) leaked into MoshOps.cpp's real dispatch table: ${leaked.join(", ")}`).toEqual([]);
  });
});

function isSlotReference(value: SkillValue): value is { slot: string } {
  return value !== null && typeof value === "object";
}

function assertNever(value: never): never {
  throw new Error(`Unhandled skill template node: ${String(value)}`);
}

function collectSkillContractErrors(skill: SkillDefinition): readonly string[] {
  const errors: string[] = [];
  const slots = new Map(skill.slots.map((slot) => [slot.name, slot]));
  const initiallyPresent = new Set(
    skill.slots.filter((slot) => slot.required).map((slot) => slot.name),
  );

  const walk = (nodes: readonly SkillTemplateNode[], present: ReadonlySet<string>): void => {
    for (const node of nodes) {
      switch (node.kind) {
        case "if_present": {
          if (!slots.has(node.slot))
            errors.push(`${skill.name}: conditional references unknown slot "${node.slot}"`);
          if (node.then.length === 0)
            errors.push(`${skill.name}: conditional "${node.slot}" has no commands`);
          const nestedPresent = new Set(present);
          nestedPresent.add(node.slot);
          walk(node.then, nestedPresent);
          break;
        }
        case "command": {
          const command = AGENT_COMMAND_MAP.get(node.command);
          if (!command) {
            errors.push(`${skill.name}: "${node.command}" is not in AGENT_COMMANDS`);
            break;
          }
          if (!dispatch.has(node.command))
            errors.push(`${skill.name}: "${node.command}" has no MoshOps.cpp dispatch`);

          const commandArgs = new Map(command.args.map((arg) => [arg.name, arg]));
          for (const required of command.args.filter((arg) => arg.required)) {
            if (!Object.prototype.hasOwnProperty.call(node.args, required.name))
              errors.push(`${skill.name}/${node.command}: required arg "${required.name}" is not bound`);
          }

          for (const [argName, value] of Object.entries(node.args)) {
            const arg = commandArgs.get(argName);
            if (!arg) {
              errors.push(`${skill.name}/${node.command}: unknown arg "${argName}"`);
              continue;
            }
            if (!isSlotReference(value)) {
              if (typeof value !== arg.type)
                errors.push(`${skill.name}/${node.command}: literal type does not match arg "${argName}"`);
              continue;
            }

            const slot = slots.get(value.slot);
            if (!slot) {
              errors.push(`${skill.name}/${node.command}: arg "${argName}" references unknown slot "${value.slot}"`);
              continue;
            }
            if (!slot.required && !present.has(slot.name))
              errors.push(`${skill.name}/${node.command}: optional slot "${slot.name}" is not guarded by if_present`);
            if (slot.type !== arg.type)
              errors.push(`${skill.name}/${node.command}: slot "${slot.name}" type does not match arg "${argName}"`);
          }
          break;
        }
        default:
          assertNever(node);
      }
    }
  };
  walk(skill.template, initiallyPresent);
  return errors;
}

describe("skill catalog ⇄ agent catalog ⇄ MoshOps.cpp contract", () => {
  it("has unique, non-empty skill names", () => {
    expect(SKILL_CATALOG.length).toBeGreaterThan(0);
    expect(SKILL_CATALOG).toContain(SET_TRACK_LEVEL_SKILL);
    const names = SKILL_CATALOG.map((skill) => skill.name);
    expect(new Set(names).size).toBe(names.length);
    for (const skill of SKILL_CATALOG) {
      expect(skill.name.trim()).not.toBe("");
      expect(skill.description.trim()).not.toBe("");
    }
  });

  for (const skill of SKILL_CATALOG) {
    it(`${skill.name}: every template branch is statically tied to the real command surface`, () => {
      const slotNames = skill.slots.map((slot) => slot.name);
      expect(new Set(slotNames).size, `${skill.name}: duplicate slot name`).toBe(slotNames.length);
      expect(skill.template.length, `${skill.name}: template is empty`).toBeGreaterThan(0);
      for (const slot of skill.slots) {
        expect(slot.name.trim(), `${skill.name}: empty slot name`).not.toBe("");
        expect(slot.description.trim(), `${skill.name}/${slot.name}: empty slot description`).not.toBe("");
        if (slot.type === "number" && slot.min !== undefined && slot.max !== undefined)
          expect(slot.min, `${skill.name}/${slot.name}: invalid numeric range`).toBeLessThanOrEqual(slot.max);
      }
      expect(collectSkillContractErrors(skill)).toEqual([]);
    });
  }

  it("rejects an optional slot reference outside its enclosing if_present branch", () => {
    const unguarded: SkillDefinition = {
      ...SET_TRACK_LEVEL_SKILL,
      name: "unguarded_optional",
      template: [{
        kind: "command",
        command: "set_track_mute",
        args: { trackId: { slot: "trackId" }, mute: { slot: "mute" } },
      }],
    };

    expect(collectSkillContractErrors(unguarded)).toContain(
      'unguarded_optional/set_track_mute: optional slot "mute" is not guarded by if_present',
    );
  });

  it("tracks optional-slot presence through nested conditionals", () => {
    const nested: SkillDefinition = {
      ...SET_TRACK_LEVEL_SKILL,
      name: "nested_optional",
      template: [{
        kind: "if_present",
        slot: "mute",
        then: [{
          kind: "if_present",
          slot: "mute",
          then: [{
            kind: "command",
            command: "set_track_mute",
            args: { trackId: { slot: "trackId" }, mute: { slot: "mute" } },
          }],
        }],
      }],
    };

    expect(collectSkillContractErrors(nested)).toEqual([]);
  });
});
