import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkNativeCommand, readNativeContract } from "./nativeContract";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "mosh-native-contract-"));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    const file = join(root, "src/moshops", name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return root;
}

describe("native skill command contract", () => {
  it("finds a wrapped handler in another translation unit without adjacent key leakage", () => {
    // Given
    const root = fixture({
      "MoshOps.cpp": 'if (name == "set_tempo") { return wrapper(name, args, cmdTempo(args)); }',
      "MoshOps.Tempo.cpp": `
        juce::var MoshOps::cmdTempo(const juce::var& args) {
          const auto text = "} args.getProperty(\\\"stringKey\\\", 0)";
          const auto raw = R"note(} args.getProperty("rawKey", 0))note";
          /* } args.getProperty("commentKey", 0); */
          if (args.hasProperty("bpm")) { return args.getProperty("bpm", 120); }
          return {};
        }
        static void neighboring(const juce::var& args) { args.getProperty("neighborKey", 0); }
      `,
    });
    // When
    const command = readNativeContract(root).get("set_tempo");
    // Then
    expect(command?.handler).toBe("cmdTempo");
    expect(command?.args).toEqual(["bpm"]);
    expect(command?.unresolved).toEqual([]);
    expect(command?.sources).toContainEqual({ file: "src/moshops/MoshOps.Tempo.cpp", line: 2 });
  });

  it("follows renamed arguments into an included helper at the correct parameter position", () => {
    // Given
    const root = fixture({
      "MoshOps.cpp": `#include "Options.h"
        if (name == "set_options") return cmdOptions(args);
        juce::var MoshOps::cmdOptions(const juce::var& args) { return parseOptions(4, args); }
      `,
      "Options.h": `inline juce::var parseOptions(int count, const juce::var& input) {
        return input.getProperty("enabled", false);
      }
      inline juce::var adjacent(const juce::var& input) { return input.getProperty("wrong", 0); }`,
    });
    // When
    const command = readNativeContract(root).get("set_options");
    // Then
    expect(command?.args).toEqual(["enabled"]);
    expect(command?.unresolved).toEqual([]);
    expect(command?.sources).toContainEqual({ file: "src/moshops/Options.h", line: 1 });
  });

  it("rejects unknown commands and arguments", () => {
    // Given
    const root = fixture({ "MoshOps.cpp": `if (name == "tempo") return cmdTempo(args);
      juce::var MoshOps::cmdTempo(const juce::var& args) { return args.getProperty("bpm", 120); }` });
    const catalog = readNativeContract(root);
    // When
    const results = [
      checkNativeCommand({ command: "tempo", args: { bpm: 100 } }, catalog),
      checkNativeCommand({ command: "tempo", args: { beats: 100 } }, catalog),
      checkNativeCommand({ command: "missing", args: {} }, catalog),
    ];
    // Then
    expect(results[0]).toEqual([]);
    expect(results[1]).toEqual([expect.stringContaining("beats")]);
    expect(results[2]).toEqual([expect.stringContaining("missing")]);
  });

  it.each([
    ["dynamic property", 'return args.getProperty(key, 0);'],
    ["missing helper", 'return missingHelper(args);'],
    ["unsupported object access", 'return args.getDynamicObject();'],
  ])("rejects unresolved extraction for %s", (_name, body) => {
    // Given
    const root = fixture({ "MoshOps.cpp": `if (name == "unknown") return cmdUnknown(args);
      juce::var MoshOps::cmdUnknown(const juce::var& args) { ${body} }` });
    const catalog = readNativeContract(root);
    // When
    const errors = checkNativeCommand({ command: "unknown", args: {} }, catalog);
    // Then
    expect(errors.length).toBeGreaterThan(0);
    expect(catalog.get("unknown")?.unresolved.length).toBeGreaterThan(0);
  });

  it("throws when the dispatch cannot be extracted", () => {
    // Given
    const root = fixture({ "MoshOps.cpp": '// if (name == "fake") return cmdFake(args);' });
    // When / Then
    expect(() => readNativeContract(root)).toThrow(/dispatch/i);
  });

  it("rejects a dispatched handler without a definition", () => {
    // Given
    const root = fixture({ "MoshOps.cpp": 'if (name == "missing") return cmdMissing(args);' });
    const catalog = readNativeContract(root);
    // When
    const errors = checkNativeCommand({ command: "missing", args: {} }, catalog);
    // Then
    expect(errors).toEqual([expect.stringContaining("handler cmdMissing")]);
  });

  it("throws for an unbalanced handler body", () => {
    // Given
    const root = fixture({ "MoshOps.cpp": `if (name == "broken") return cmdBroken(args);
      juce::var MoshOps::cmdBroken(const juce::var& args) { return args.getProperty("bpm", 120);` });
    // When / Then
    expect(() => readNativeContract(root)).toThrow(/unclosed/);
  });

  it("rejects an ambiguous helper instead of collecting a neighboring overload", () => {
    // Given
    const root = fixture({ "MoshOps.cpp": `if (name == "ambiguous") return cmdAmbiguous(args);
      juce::var MoshOps::cmdAmbiguous(const juce::var& args) { return readOptions(args); }
      juce::var readOptions(const juce::var& input) { return input.getProperty("first", 0); }
      juce::var readOptions(juce::var& input) { return input.getProperty("second", 0); }` });
    const catalog = readNativeContract(root);
    // When
    const errors = checkNativeCommand({ command: "ambiguous", args: {} }, catalog);
    // Then
    expect(errors).toEqual([expect.stringContaining("unresolved helper readOptions")]);
  });

  it.each(["real::parse", "service.parse", "service->parse", "other::ignoreUnused", "service.logLine"])(
    "rejects an unresolved qualified call to %s instead of matching an unrelated name",
    (call) => {
      // Given
      const root = fixture({ "MoshOps.cpp": `if (name == "qualified") return cmdQualified(args);
        juce::var MoshOps::cmdQualified(const juce::var& args) { return ${call}(args); }
        namespace wrong { juce::var parse(const juce::var& input) { return input.getProperty("foreignKey", 0); } }` });
      const catalog = readNativeContract(root);
      // When
      const errors = checkNativeCommand({ command: "qualified", args: {} }, catalog);
      // Then
      expect(errors.length).toBeGreaterThan(0);
      expect(catalog.get("qualified")?.args).not.toContain("foreignKey");
    },
  );

  it("accepts juce::ignoreUnused without treating it as a command argument reader", () => {
    // Given
    const root = fixture({ "MoshOps.cpp": `if (name == "empty") return cmdEmpty(args);
      juce::var MoshOps::cmdEmpty(const juce::var& args) { juce::ignoreUnused(args); return {}; }` });
    // When
    const catalog = readNativeContract(root);
    // Then
    expect(checkNativeCommand({ command: "empty", args: {} }, catalog)).toEqual([]);
    expect(catalog.get("empty")?.args).toEqual([]);
  });

  it("resolves the native command shapes required by the training shortlist", () => {
    // Given
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const commands = [
      "set_tempo", "set_time_signature", "add_midi_clip", "add_note", "split_clip", "remove_note",
      "move_clip", "trim_clip", "build_skeleton_from_clip", "duplicate_clip", "move_section", "set_key",
      "set_master_volume", "set_clip_gain", "add_test_tone_clip", "save", "rename_clip", "set_track_type",
      "redo", "remove_section", "undo", "open_plugin_editor", "set_input_monitor", "set_master_pan",
      "set_track_pan", "remove_track", "set_clip_mute", "set_metronome", "rename_track", "create_annotation",
      "create_section", "rename_section", "set_track_volume", "remove_clip", "set_transport", "load_drum_kit",
      "create_track", "arm_track", "set_track_solo", "set_track_mute",
    ];
    // When
    const catalog = readNativeContract(root);
    // Then
    expect(catalog.size).toBeGreaterThanOrEqual(190);
    for (const name of commands) {
      expect(catalog.has(name), name).toBe(true);
      expect(catalog.get(name)?.unresolved, name).toEqual([]);
    }
    expect(catalog.get("set_time_signature")?.args).toEqual(["denominator", "numerator"]);
    expect(catalog.get("save")?.args).toEqual([]);
    expect(catalog.get("set_tempo")?.args).toEqual(["bpm"]);
    expect(catalog.get("set_key")?.args).toEqual(["mode", "tonic"]);
  });
});
