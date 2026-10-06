import { describe, it, expect, beforeEach } from "vitest";
import { panelKey, resetPanelStateForTests, usePanelState } from "./panelState";

describe("panel minimized state", () => {
  beforeEach(() => resetPanelStateForTests());

  it("keys by the stable item id when there is one, else by the slot", () => {
    expect(panelKey("1013", { itemId: "1042", index: 3 })).toBe("id:1042");
    expect(panelKey("1013", { index: 3 })).toBe("slot:1013:3");
  });

  it("toggles, and persists only the minimized ones", () => {
    const { toggle } = usePanelState.getState();
    toggle("id:1");
    expect(usePanelState.getState().collapsed).toEqual({ "id:1": true });
    expect(JSON.parse(localStorage.getItem("mosh.v3.pluginPanels")!)).toEqual({ "id:1": true });
    toggle("id:1");
    expect(usePanelState.getState().collapsed).toEqual({});
    expect(JSON.parse(localStorage.getItem("mosh.v3.pluginPanels")!)).toEqual({});
  });

  it("survives garbage in storage", () => {
    localStorage.setItem("mosh.v3.pluginPanels", "{not json");
    resetPanelStateForTests();
    localStorage.setItem("mosh.v3.pluginPanels", JSON.stringify(["x"]));
    usePanelState.getState().setCollapsed("id:2", true);
    expect(usePanelState.getState().collapsed).toEqual({ "id:2": true });
  });
});
