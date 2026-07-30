import { describe, expect, it } from "vitest";
import { AGENT_COMMANDS, commandCatalogPrompt } from "./commands";
import {
  CAPABILITY_INDEX,
  DIRECT_SAFE_COMMAND_IDS,
  capabilityCatalogPrompt,
  retrieveCapabilities,
  supervisorCapabilitySchemas,
} from "./capability";

describe("capability retrieval", () => {
  it("builds one deterministic capability record per curated command", () => {
    expect(CAPABILITY_INDEX.map((capability) => capability.id)).toEqual(AGENT_COMMANDS.map((command) => command.command));
    expect(CAPABILITY_INDEX.every((capability) => capability.category.length > 0 && capability.triggers.length > 0)).toBe(true);
    expect(CAPABILITY_INDEX.every((capability) => capability.inputSchema.type === "object")).toBe(true);
  });

  it("always includes direct-safe commands and excludes unrelated unsafe commands", () => {
    const capabilities = retrieveCapabilities("turn on the metronome");
    const ids = new Set(capabilities.map((capability) => capability.id));

    for (const id of DIRECT_SAFE_COMMAND_IDS) expect(ids.has(id)).toBe(true);
    expect(ids.has("remove_track")).toBe(false);
    expect(ids.has("render_layer")).toBe(false);
    expect(ids.has("build_skeleton_from_clip")).toBe(false);
  });

  it("is bounded and stable while adding lexical matches", () => {
    const first = retrieveCapabilities("make a drum pattern with kick and snare", { limit: 14 });
    const second = retrieveCapabilities("make a drum pattern with kick and snare", { limit: 14 });

    expect(first).toEqual(second);
    expect(first).toHaveLength(14);
    expect(first.map((capability) => capability.id)).toContain("add_drum_pattern");
  });

  it("renders a materially smaller supervisor catalog than the benchmark renderer", () => {
    const fullCatalogCharacters = commandCatalogPrompt().length;
    const retrievedCatalog = capabilityCatalogPrompt(retrieveCapabilities("turn on the metronome"));

    expect(retrievedCatalog.length).toBeLessThan(fullCatalogCharacters / 2);
  });

  it("converts only retrieved capability schemas for supervisor input", () => {
    const capabilities = retrieveCapabilities("turn on the metronome");
    const schemas = supervisorCapabilitySchemas(capabilities);

    expect(schemas.map((schema) => schema.id)).toEqual(capabilities.map((capability) => capability.id));
    expect(schemas.some((schema) => schema.id === "remove_track")).toBe(false);
  });
});
