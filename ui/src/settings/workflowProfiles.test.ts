import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WORKFLOW_PROFILE_ID,
  WORKFLOW_PROFILE_IDS,
  WORKFLOW_PROFILES,
  getWorkflowProfile,
} from "./workflowProfiles";
import { STORAGE_KEY, useSettings } from "./store";

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
      "arrangement.slice-tool": "supported",
      "arrangement.select-tool": "supported",
      "arrangement.snap-bypass": "supported",
      "view.playlist": "supported",
      "view.channel-rack": "supported",
      "view.piano-roll": "supported",
      "view.mixer": "supported",
      "view.plugin-picker": "supported",
      "mouse.arrangement-clip-context": "supported",
      "mouse.arrangement-empty-deselect": "supported",
      "mouse.piano-note-erase": "supported",
      "mouse.piano-empty-deselect": "supported",
      "mouse.drum-step-toggle": "supported",
      "divergence.undo-redo": "divergence",
      "divergence.visual-identity": "divergence",
      "divergence.project-model": "divergence",
      "deferred.step-edit": "deferred",
      "deferred.playlist-tools": "deferred",
      "deferred.pattern-song-mode": "deferred",
      "deferred.right-drag-multi-erase": "deferred",
      "deferred.flp-import": "deferred",
    });
    expect(new Set(Object.keys(statuses)).size).toBe(WORKFLOW_PROFILES.fl.capabilities.length);
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
      "arrangement.slice-tool": "C",
      "arrangement.select-tool": "E",
      "arrangement.snap-bypass": "Option-drag",
      "view.playlist": "F5",
      "view.channel-rack": "F6",
      "view.piano-roll": "F7",
      "view.mixer": "F9",
      "view.plugin-picker": "Alt+F8",
      "mouse.arrangement-clip-context": "Right-click / Shift+Right-click",
      "mouse.arrangement-empty-deselect": "Right-click empty",
      "mouse.piano-note-erase": "Right-click note",
      "mouse.piano-empty-deselect": "Right-click empty",
      "mouse.drum-step-toggle": "Left-click / Right-click",
      "divergence.undo-redo": "Mod+Z / Mod+Shift+Z",
      "deferred.step-edit": "Mod+E",
    };
    for (const row of WORKFLOW_PROFILES.fl.capabilities) {
      expect(row).toMatchObject({
        id: expect.any(String),
        label: expect.any(String),
        status: expect.stringMatching(/^(supported|divergence|deferred)$/),
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

describe("v3 workflow settings persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettings.setState({
      template: null,
      values: {},
      keyOverrides: {},
      workspaceByProfile: {},
      workflowOnboardingDismissed: false,
    });
  });

  it("uses Mosh defaults and keeps onboarding visible for a new install", () => {
    useSettings.getState().hydrate();
    const state = useSettings.getState();
    expect(state.get("workflowProfile")).toBe("mosh");
    expect(state.get("strictFlMouse")).toBe(false);
    expect(state.workspaceByProfile).toEqual({});
    expect(state.workflowOnboardingDismissed).toBe(false);
  });

  it("migrates valid v1/v2 entries to Mosh without inferring FL from legacy values", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 2,
      template: "fl",
      values: { skin: "fl", template: "fl", keymap: "fl", gestureTable: "fl", theme: "dark" },
      keyOverrides: { fl: { "key.undo": "Mod+P" } },
    }));

    useSettings.getState().hydrate();
    const state = useSettings.getState();
    expect(state.get("workflowProfile")).toBe("mosh");
    expect(state.get("skin")).toBe("fl");
    expect(state.template).toBe("fl");
    expect(state.keyOverrides).toEqual({ fl: { "key.undo": "Mod+P" } });
    expect(state.workflowOnboardingDismissed).toBe(true);
  });

  it("preserves a valid v3 profile and layers workspace overrides over defaults", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 3,
      template: null,
      values: { workflowProfile: "fl", strictFlMouse: true, uiShell: "v2" },
      keyOverrides: {},
      workspaceByProfile: { fl: { browserOpen: false, browserTab: "plugins", sectionZoom: "full" } },
      workflowOnboardingDismissed: false,
    }));

    useSettings.getState().hydrate();
    const state = useSettings.getState();
    expect(state.get("workflowProfile")).toBe("fl");
    expect(state.get("strictFlMouse")).toBe(true);
    expect(state.getEffectiveWorkspace("fl")).toEqual({
      browserOpen: false,
      browserTab: "plugins",
      rightOpen: true,
      sectionZoom: "full",
      drumWindowOpen: true,
    });
    expect(state.workflowOnboardingDismissed).toBe(false);
  });

  it("marks existing corrupt storage as seen while falling back safely", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    useSettings.getState().hydrate();
    const state = useSettings.getState();
    expect(state.get("workflowProfile")).toBe("mosh");
    expect(state.get("strictFlMouse")).toBe(false);
    expect(state.workspaceByProfile).toEqual({});
    expect(state.workflowOnboardingDismissed).toBe(true);
  });

  it("falls back to Mosh when a v3 entry names an unknown profile", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 3,
      values: { workflowProfile: "wat" },
      keyOverrides: {},
      workspaceByProfile: {},
      workflowOnboardingDismissed: false,
    }));
    useSettings.getState().hydrate();
    expect(useSettings.getState().get("workflowProfile")).toBe("mosh");
    expect(useSettings.getState().workflowOnboardingDismissed).toBe(false);
  });

  it("scopes v2 key overrides by workflow profile and Classic by legacy keymap", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 3,
      template: null,
      values: { workflowProfile: "mosh", uiShell: "v2", keymap: "fl" },
      keyOverrides: {
        mosh: { "key.undo": "Mod+M" },
        fl: { "key.undo": "Mod+F" },
      },
      workspaceByProfile: {},
      workflowOnboardingDismissed: true,
    }));
    useSettings.getState().hydrate();
    expect(useSettings.getState().get("key.undo")).toBe("Mod+M");
    useSettings.getState().setWorkflowProfile("fl");
    expect(useSettings.getState().get("key.undo")).toBe("Mod+F");
    useSettings.getState().set("uiShell", "classic");
    expect(useSettings.getState().get("key.undo")).toBe("Mod+F");
  });

  it("keeps a migrated legacy FL key bucket inactive in v2 Mosh until Classic is selected", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 2,
      template: "fl",
      values: { skin: "fl", keymap: "fl", gestureTable: "fl" },
      keyOverrides: { fl: { "key.undo": "Mod+F" } },
    }));

    useSettings.getState().hydrate();
    const state = useSettings.getState();
    expect(state.keyOverrides.fl?.["key.undo"]).toBe("Mod+F");
    expect(state.get("workflowProfile")).toBe("mosh");
    expect(state.get("key.undo")).toBe("");

    state.set("uiShell", "classic");
    expect(useSettings.getState().get("key.undo")).toBe("Mod+F");
  });

  it("persists profile workspace overrides and onboarding dismissal", () => {
    const state = useSettings.getState();
    state.setWorkflowProfile("fl");
    state.saveWorkspaceOverride("fl", { browserOpen: false, browserTab: "plugins", sectionZoom: "8b" });
    state.dismissWorkflowOnboarding();

    expect(useSettings.getState().getEffectiveWorkspace()).toEqual({
      browserOpen: false,
      browserTab: "plugins",
      rightOpen: true,
      sectionZoom: "8b",
      drumWindowOpen: true,
    });
    expect(useSettings.getState().workflowOnboardingDismissed).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}").version).toBe(3);

    useSettings.setState({ template: null, values: {}, keyOverrides: {}, workspaceByProfile: {} });
    useSettings.getState().hydrate();
    expect(useSettings.getState().get("workflowProfile")).toBe("fl");
    expect(useSettings.getState().getEffectiveWorkspace("fl").sectionZoom).toBe("8b");
  });

  it("rejects invalid persisted workspace tokens and falls back to profile defaults", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 3,
      template: null,
      values: { workflowProfile: "fl" },
      keyOverrides: {},
      workspaceByProfile: {
        fl: { browserTab: "mystery", sectionZoom: "32b" },
        mosh: { browserTab: "plugins", sectionZoom: "8b" },
      },
      workflowOnboardingDismissed: true,
    }));

    useSettings.getState().hydrate();
    expect(useSettings.getState().workspaceByProfile).toEqual({
      mosh: { browserTab: "plugins", sectionZoom: "8b" },
    });
    expect(useSettings.getState().getEffectiveWorkspace("fl")).toEqual(
      WORKFLOW_PROFILES.fl.workspaceDefaults,
    );
  });

  it("rejects invalid live workspace tokens while preserving valid overrides", () => {
    useSettings.getState().saveWorkspaceOverride("fl", {
      browserTab: "mystery",
      sectionZoom: "32b",
      browserOpen: false,
    } as never);
    expect(useSettings.getState().workspaceByProfile.fl).toEqual({ browserOpen: false });
    expect(useSettings.getState().getEffectiveWorkspace("fl")).toMatchObject({
      browserOpen: false,
      browserTab: "sounds",
      sectionZoom: "16b",
    });
  });

  it("resets to Mosh defaults, clears workspace and key overrides, and keeps onboarding dismissed", () => {
    const state = useSettings.getState();
    state.setWorkflowProfile("fl");
    state.saveWorkspaceOverride("fl", { browserOpen: false });
    state.set("key.undo", "Mod+P");
    state.reset();

    const next = useSettings.getState();
    expect(next.get("workflowProfile")).toBe("mosh");
    expect(next.workspaceByProfile).toEqual({});
    expect(next.keyOverrides).toEqual({});
    expect(next.workflowOnboardingDismissed).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}").version).toBe(3);
  });
});
