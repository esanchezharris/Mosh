// The "Add AI tools" card against the dev mock's installer (bridge.mock.ts), which walks
// the same steps and sends the same ai_tools events as native: the Settings row, the dock's
// offer button and its dialog (docs/AI-TOOLS-OPTIONAL-BRIEF-2026-11-02.md §5.4).

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __mockAiToolsOffForTests, __resetMockForTests } from "../bridge.mock";
import { useStore } from "../store";
import { AiToolsLauncher, AiToolsOfferButton, AiToolsSettings } from "./AiToolsCard";
import { useV3 } from "./shellState";

let host: HTMLDivElement;
let root: Root;
const el = <T extends HTMLElement = HTMLElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`);
const must = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const e = el<T>(id);
  if (!e) throw new Error(`missing ${id}`);
  return e;
};
const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const click = async (id: string) => { await act(async () => { must(id).click(); }); await flush(); };

async function mount(...nodes: React.ReactElement[]) {
  await act(async () => { root.render(React.createElement(React.Fragment, null, ...nodes)); });
  await flush();
}

beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  __resetMockForTests();
  __mockAiToolsOffForTests();
  useStore.getState().init();
  await useStore.getState().refresh();
  useV3.setState({ aiToolsOpen: false });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  __resetMockForTests();
  vi.useRealTimers();
});

describe("Settings → AI tools", () => {
  it("installs with progress, then offers Remove, which turns them off again", async () => {
    await mount(React.createElement(AiToolsSettings));
    expect(must("v3-ai-tools-state").textContent).toBe("Not installed");
    expect(host.textContent).toContain("About 0.8 GB");
    expect(el("v3-ai-tools-remove")).toBeNull();

    await click("v3-ai-tools-settings-install");
    expect(must("v3-ai-tools-state").textContent).toBe("Installing Python…");
    expect(el("v3-ai-tools-settings-cancel")).not.toBeNull();
    await flush(300);
    expect(must("v3-ai-tools-state").textContent).toBe("Installing Beatbox → beat…");
    await flush(1000);
    expect(must("v3-ai-tools-state").textContent).toBe("On");
    expect(useStore.getState().snapshot?.aiTools?.state).toBe("on");

    await click("v3-ai-tools-remove");
    await flush(50);
    expect(must("v3-ai-tools-state").textContent).toBe("Not installed");
    expect(useStore.getState().snapshot?.aiTools?.state).toBe("off");
  });

  it("Cancel stops the install and leaves Install on offer", async () => {
    await mount(React.createElement(AiToolsSettings));
    await click("v3-ai-tools-settings-install");
    await flush(300);
    await click("v3-ai-tools-settings-cancel");
    expect(must("v3-ai-tools-state").textContent).toBe("Not installed");
    expect(el("v3-ai-tools-settings-install")).not.toBeNull();
  });
});

describe("the dock's offer", () => {
  it("opens the setup card as a dialog; Not now closes it", async () => {
    await mount(React.createElement(AiToolsOfferButton), React.createElement(AiToolsLauncher));
    expect(el("v3-ai-tools-modal")).toBeNull();
    await click("v3-ai-tools-offer");
    expect(useV3.getState().aiToolsOpen).toBe(true);
    expect(el("v3-ai-tools-card")).not.toBeNull();
    expect(el("v3-ai-tools-install")).not.toBeNull();
    await click("v3-ai-tools-close");
    expect(el("v3-ai-tools-modal")).toBeNull();
  });
});

describe("?mockFault=ai-install-fail", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
    vi.resetModules();
  });

  it("shows native's friend copy and the log tail; Try again finishes", async () => {
    window.history.replaceState({}, "", "/?mockFault=ai-install-fail&mockAiTools=off");
    vi.resetModules();
    const mock = await import("../bridge.mock");
    const card = await import("./AiToolsCard");
    const store = (await import("../store")).useStore;
    mock.__resetMockForTests();
    store.getState().init();
    await store.getState().refresh();
    await mount(React.createElement(card.AiToolsCard, { onClose: () => {} }));

    await click("v3-ai-tools-install");
    await flush(1000);
    expect(must("v3-ai-tools-card").dataset.phase).toBe("failed");
    expect(must("v3-ai-tools-error").textContent).toContain("Couldn't install the beatbox tool. Check your internet and try again.");
    expect(must("v3-ai-tools-detail").textContent).toContain("librosa");
    expect(must("v3-ai-tools-install").textContent).toBe("Try again");
    expect(host.querySelector('[data-step="python"]')?.getAttribute("data-status")).toBe("done");

    await click("v3-ai-tools-install");
    await flush(1000);
    expect(must("v3-ai-tools-card").dataset.phase).toBe("on");
    expect(el("v3-ai-tools-done")).not.toBeNull();
  });
});
