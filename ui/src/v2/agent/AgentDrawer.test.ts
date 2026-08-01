import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTaskStore, type TaskView } from "../../agent/loop/taskStore";
import { AgentDrawer } from "./AgentDrawer";

function task(outcome?: TaskView["outcome"]): TaskView {
  return {
    ask: "build me a lofi sketch",
    phase: outcome ? "finalizing" : "planning",
    plan: [{ goal: "lay dusty drums" }],
    steps: outcome ? [{ goal: "lay dusty drums", commands: [], results: [], running: false }] : [],
    outcome,
    say: outcome === "error" ? "can't reach my brain" : undefined,
    startedAt: 1,
    endedAt: outcome ? 2 : undefined,
  };
}

describe("AgentDrawer", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useTaskStore.setState({
      current: null,
      last: null,
      history: [],
      drawerOpen: false,
      signal: null,
      sink: null,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function render(current: TaskView | null, last: TaskView | null) {
    act(() => {
      useTaskStore.setState({ current, last, drawerOpen: true });
      root.render(React.createElement(AgentDrawer));
    });
  }

  it.each([
    ["live", task(), null, "Moshi is planning"],
    ["success", null, task("done"), "Moshi done"],
    ["cancelled", null, task("aborted"), "Moshi stopped"],
    ["error", null, task("error"), "Moshi hit a wall"],
  ] as const)("renders the %s task state while its accessibility log is present", (_name, current, last, heading) => {
    render(current, last);
    const drawer = host.querySelector('[role="log"][aria-label="Moshi\'s task"]');
    expect(drawer).not.toBeNull();
    expect(drawer!.textContent).toContain(heading);
    expect(drawer!.textContent).toContain("build me a lofi sketch");
  });

  it("removes and restores both the drawer and its accessibility log", () => {
    render(null, task("error"));
    const close = host.querySelector<HTMLButtonElement>('[data-testid="agent-drawer-close"]')!;

    act(() => close.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(host.querySelector('[data-testid="agent-drawer"]')).toBeNull();
    expect(host.querySelector('[role="log"]')).toBeNull();

    act(() => useTaskStore.getState().setDrawerOpen(true));
    expect(host.querySelector('[data-testid="agent-drawer"]')).not.toBeNull();
    expect(host.querySelector('[role="log"]')).not.toBeNull();
  });
});
