import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKFLOW_PROFILE_ID,
  WORKFLOW_PROFILE_IDS,
  WORKFLOW_PROFILES,
  getWorkflowProfile,
} from "./workflowProfiles";

describe("v2 workflow-profile registry", () => {
  it("contains only the Mosh and FL profiles with complete capability rows", () => {
    expect(WORKFLOW_PROFILE_IDS).toEqual(["mosh", "fl"]);
    expect(Object.keys(WORKFLOW_PROFILES).sort()).toEqual(["fl", "mosh"]);

    const statuses = new Set(["supported", "divergence", "deferred"]);
    for (const profile of Object.values(WORKFLOW_PROFILES)) {
      expect(profile.id).toBeTruthy();
      expect(profile.label).toBeTruthy();
      expect(["native", "beta"]).toContain(profile.maturity);
      expect(profile.v2Available).toBe(true);
      expect(profile.keymapId).toBeTruthy();
      expect(profile.gestureTableId).toBeTruthy();
      expect(typeof profile.strictMouseSupported).toBe("boolean");
      expect(profile.workspaceDefaults).toMatchObject({
        browserOpen: expect.any(Boolean),
        browserTab: expect.any(String),
        rightOpen: expect.any(Boolean),
        sectionZoom: expect.any(String),
        drumWindowOpen: expect.any(Boolean),
      });
      expect(profile.capabilities.length).toBeGreaterThan(0);
      for (const capability of profile.capabilities) {
        expect(capability.id).toBeTruthy();
        expect(capability.status).toEqual(expect.stringMatching(/^(supported|divergence|deferred)$/));
        expect(statuses.has(capability.status)).toBe(true);
      }
    }
  });

  it("publishes the exhaustive FL v1 capability matrix with stable statuses", () => {
    const statuses = Object.fromEntries(
      WORKFLOW_PROFILES.fl.capabilities.map(({ id, status }) => [id, status]),
    );
    expect(statuses).toEqual({
      "shortcut.play-pause": "supported",
      "shortcut.record": "supported",
      "shortcut.open": "supported",
      "shortcut.save": "supported",
      "shortcut.save-as": "supported",
      "shortcut.export-audio": "supported",
      "arrangement.block-tool": "supported",
      "arrangement.split-tool": "supported",
      "arrangement.select-tool": "supported",
      "arrangement.snap-bypass": "supported",
      "view.playlist": "supported",
      "view.channel-rack": "supported",
      "view.piano-roll": "supported",
      "view.mixer": "supported",
      "view.browser": "supported",
      "mouse.arrangement-clip-context": "supported",
      "mouse.arrangement-empty-deselect": "supported",
      "mouse.piano-note-erase": "supported",
      "mouse.piano-empty-deselect": "supported",
      "mouse.drum-step-toggle": "supported",
      "divergence.undo-redo": "divergence",
      "divergence.visual-identity": "divergence",
      "divergence.project-model": "divergence",
      "deferred.step-edit": "deferred",
      "deferred.paint-tool": "deferred",
      "deferred.draw-tool": "deferred",
      "deferred.delete-tool": "deferred",
      "deferred.slip-tool": "deferred",
      "deferred.mute-tool": "deferred",
      "deferred.pattern-song-mode": "deferred",
      "deferred.right-drag-multi-erase": "deferred",
      "deferred.flp-import": "deferred",
    });
    expect(new Set(Object.keys(statuses)).size).toBe(WORKFLOW_PROFILES.fl.capabilities.length);
  });

  it("distinguishes wired, integration-pending, and deferred delivery without overclaiming", () => {
    const rows = WORKFLOW_PROFILES.fl.capabilities;
    const pending = rows.filter((row) => row.delivery === "integration-pending");
    expect(pending.map((row) => row.id)).toEqual([
      "arrangement.snap-bypass",
      "view.playlist",
      "view.channel-rack",
      "view.piano-roll",
      "view.mixer",
      "view.browser",
      "mouse.arrangement-clip-context",
      "mouse.arrangement-empty-deselect",
      "mouse.piano-note-erase",
      "mouse.piano-empty-deselect",
      "mouse.drum-step-toggle",
    ]);
    expect(pending.every((row) => row.status === "supported")).toBe(true);
    expect(pending.every((row) => row.note.includes("integration is pending"))).toBe(true);
    expect(rows.filter((row) => row.delivery === "wired")).toHaveLength(12);
    expect(rows.filter((row) => row.delivery === "integration-pending")).toHaveLength(11);
    expect(rows.filter((row) => row.delivery === "deferred")).toHaveLength(9);
    expect(rows.filter((row) => row.status === "deferred").every((row) => row.delivery === "deferred")).toBe(true);
  });

  it("makes every FL row renderable without prose parsing and cites claimed FL behavior", () => {
    const officialSources = new Set([
      "https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/basics_shortcuts.htm",
      "https://www.image-line.com/fl-studio-learning-content/fl-studio-online-manual/html/playlist.htm",
      "https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/pianoroll.htm",
      "https://www.image-line.com/fl-studio-learning-content/fl-studio-online-manual/html/channelrack.htm",
    ]);
    const sourceOptional = new Set([
      "divergence.visual-identity",
      "divergence.project-model",
      "deferred.flp-import",
    ]);
    const expectedInputs: Record<string, string> = {
      "shortcut.play-pause": "Space",
      "shortcut.record": "R",
      "shortcut.open": "Mod+O",
      "shortcut.save": "Mod+S",
      "shortcut.save-as": "Mod+Shift+S",
      "shortcut.export-audio": "Mod+R",
      "arrangement.block-tool": "Mod+B",
      "arrangement.split-tool": "C",
      "arrangement.select-tool": "E",
      "arrangement.snap-bypass": "Option-drag",
      "view.playlist": "F5",
      "view.channel-rack": "F6",
      "view.piano-roll": "F7",
      "view.mixer": "F9",
      "view.browser": "Alt/Opt+F8",
      "mouse.arrangement-clip-context": "Right-click / Shift+Right-click",
      "mouse.arrangement-empty-deselect": "Right-click empty",
      "mouse.piano-note-erase": "Right-click note",
      "mouse.piano-empty-deselect": "Right-click empty",
      "mouse.drum-step-toggle": "Left-click / Right-click",
      "divergence.undo-redo": "Mod+Z / Mod+Shift+Z",
      "deferred.step-edit": "Mod+E",
      "deferred.paint-tool": "B",
      "deferred.draw-tool": "P",
      "deferred.delete-tool": "D",
      "deferred.slip-tool": "S",
      "deferred.mute-tool": "T",
      "deferred.pattern-song-mode": "L",
      "deferred.right-drag-multi-erase": "Right-drag",
    };
    for (const row of WORKFLOW_PROFILES.fl.capabilities) {
      expect(row).toMatchObject({
        id: expect.any(String),
        label: expect.any(String),
        status: expect.stringMatching(/^(supported|divergence|deferred)$/),
        delivery: expect.stringMatching(/^(wired|integration-pending|deferred)$/),
        surface: expect.any(String),
        scope: expect.stringMatching(/^(safe-default|strict-fl-mouse)$/),
        note: expect.any(String),
      });
      expect(row.label.trim()).not.toBe("");
      expect(row.surface.trim()).not.toBe("");
      expect(row.note.trim()).not.toBe("");
      if (row.id in expectedInputs) expect(row.input).toBe(expectedInputs[row.id]);
      if (!sourceOptional.has(row.id)) expect(officialSources.has(row.sourceUrl ?? "")).toBe(true);
    }
    expect(Object.fromEntries(
      WORKFLOW_PROFILES.fl.capabilities
        .filter((row) => row.input !== undefined)
        .map((row) => [row.id, row.input]),
    )).toEqual(expectedInputs);
    expect(WORKFLOW_PROFILES.fl.capabilities.find((row) => row.id === "arrangement.split-tool")).toMatchObject({
      label: "Split tool",
      input: "C",
    });
    expect(WORKFLOW_PROFILES.fl.capabilities.find((row) => row.id === "view.browser")).toMatchObject({
      label: "Browser / Sample Browser",
      input: "Alt/Opt+F8",
    });
  });

  it("keeps destructive mouse behavior opt-in and reserves deferred Step Edit in registry metadata", () => {
    const strictMouseIds = WORKFLOW_PROFILES.fl.capabilities
      .filter((row) => row.scope === "strict-fl-mouse")
      .map((row) => row.id);
    expect(strictMouseIds).toEqual([
      "mouse.arrangement-clip-context",
      "mouse.arrangement-empty-deselect",
      "mouse.piano-note-erase",
      "mouse.piano-empty-deselect",
      "mouse.drum-step-toggle",
    ]);
    expect(WORKFLOW_PROFILES.fl.reservedKeyCombos).toEqual(["Mod+E"]);
    expect(WORKFLOW_PROFILES.mosh.reservedKeyCombos).toEqual([]);
    type ReservedCombosAreReadonly = typeof WORKFLOW_PROFILES.fl.reservedKeyCombos extends unknown[]
      ? false
      : true;
    const reservedCombosAreReadonly: ReservedCombosAreReadonly = true;
    expect(reservedCombosAreReadonly).toBe(true);
  });

  it("keeps FL behavioral-only and uses the requested resting workspace defaults", () => {
    const mosh = WORKFLOW_PROFILES.mosh;
    const fl = WORKFLOW_PROFILES.fl;
    expect(mosh.maturity).toBe("native");
    expect(fl.maturity).toBe("beta");
    expect(mosh.strictMouseSupported).toBe(false);
    expect(fl.strictMouseSupported).toBe(true);
    expect(mosh.workspaceDefaults).toEqual({
      browserOpen: false,
      browserTab: "sounds",
      rightOpen: true,
      sectionZoom: "16b",
      drumWindowOpen: false,
    });
    expect(fl.workspaceDefaults).toEqual({
      browserOpen: true,
      browserTab: "sounds",
      rightOpen: true,
      sectionZoom: "16b",
      drumWindowOpen: true,
    });
    expect(mosh.visualPolicy).toEqual({ skin: "mosh", branding: "mosh", theme: "preserve" });
    expect(fl.visualPolicy).toEqual({ skin: "mosh", branding: "mosh", theme: "preserve" });
    expect(fl.capabilities.some((row) => row.status === "divergence")).toBe(true);
  });

  it("falls back to the Mosh profile for unknown ids", () => {
    expect(getWorkflowProfile("wat")).toBe(WORKFLOW_PROFILES[DEFAULT_WORKFLOW_PROFILE_ID]);
    expect(getWorkflowProfile("toString")).toBe(WORKFLOW_PROFILES[DEFAULT_WORKFLOW_PROFILE_ID]);
    expect(getWorkflowProfile(undefined)).toBe(WORKFLOW_PROFILES.mosh);
  });
});
