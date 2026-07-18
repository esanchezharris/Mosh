import { beforeEach, describe, expect, it } from "vitest";
import { STORAGE_KEY, sanitizeWorkspaceOverride, useSettings } from "./store";
import { WORKFLOW_PROFILES } from "./workflowProfiles";

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

  it("sanitizes unknown live input while preserving valid fields", () => {
    expect(sanitizeWorkspaceOverride({
      browserTab: "mystery",
      sectionZoom: "32b",
      browserOpen: false,
    })).toEqual({ browserOpen: false });
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
