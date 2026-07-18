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
      workspaceByProfile: { fl: { browserOpen: false, sectionZoom: "32b" } },
      workflowOnboardingDismissed: false,
    }));

    useSettings.getState().hydrate();
    const state = useSettings.getState();
    expect(state.get("workflowProfile")).toBe("fl");
    expect(state.get("strictFlMouse")).toBe(true);
    expect(state.getEffectiveWorkspace("fl")).toEqual({
      browserOpen: false,
      browserTab: "sounds",
      rightOpen: true,
      sectionZoom: "32b",
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
    state.saveWorkspaceOverride("fl", { browserOpen: false, sectionZoom: "32b" });
    state.dismissWorkflowOnboarding();

    expect(useSettings.getState().getEffectiveWorkspace()).toEqual({
      browserOpen: false,
      browserTab: "sounds",
      rightOpen: true,
      sectionZoom: "32b",
      drumWindowOpen: true,
    });
    expect(useSettings.getState().workflowOnboardingDismissed).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}").version).toBe(3);

    useSettings.setState({ template: null, values: {}, keyOverrides: {}, workspaceByProfile: {} });
    useSettings.getState().hydrate();
    expect(useSettings.getState().get("workflowProfile")).toBe("fl");
    expect(useSettings.getState().getEffectiveWorkspace("fl").sectionZoom).toBe("32b");
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
