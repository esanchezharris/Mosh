// Consumer-level coverage for the pendingCollection one-shot (T3 review fix). The
// store-level tests in shellState.test.ts prove the CHANNEL works but never mount
// PluginDock, the one thing that actually READS it — so they cannot catch either way
// the original useState-lazy-initialiser consumer silently dropped the request:
//
//   1. React StrictMode double-invokes a useState initialiser and keeps only the
//      SECOND call's result. The first call (which reads + clears the store) is
//      thrown away, so the effective read is the second call, which sees the store
//      already cleared → undefined seed, drawer never pre-filters.
//   2. PluginDock does not remount when the drawer is already open on the Plugins
//      tab (see LeftDrawer.tsx — it lives inside the `tab === "plugins"` branch of a
//      ternary, not gated on a key). A second `openBrowserTab("plugins", "inst")`
//      while the dock stays mounted never re-runs a mount-time initialiser, so the
//      store gets set and nothing reads it.
//
// Both are proven here against the CURRENT effect-based consumer (GREEN). The RED proof
// against the old useState-initialiser approach (both failure modes reproduced, then
// fixed by switching to the effect-based consumer above) was run locally during that
// fix and is not kept as a permanent skip/xfail in this file.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginDock } from "./PluginBrowser";
import { useStore } from "../store";
import { useShell } from "./shellState";
import { __resetMockForTests } from "../bridge.mock";
import type { AvailablePlugin, BuiltinPlugin } from "../types";

// Seed a non-empty catalog directly so PluginDock's ensurePluginCatalog() effect
// (which fires unconditionally on mount) finds availablePlugins/availableBuiltins
// already non-empty and skips its list_plugins/list_builtins fetches — keeps the
// test deterministic and synchronous, no service round-trip to await.
const SEED_BUILTINS: BuiltinPlugin[] = [
  { type: "synth1", name: "Seed Synth", category: "Synth", isInstrument: true, builtin: true },
  { type: "eq1", name: "Seed EQ", category: "EQ", isInstrument: false, builtin: true },
];
const SEED_PLUGINS: AvailablePlugin[] = [
  { id: "p1", name: "Seed Instrument VST", format: "VST3", manufacturer: "Acme", isInstrument: true },
  { id: "p2", name: "Seed Effect VST", format: "VST3", manufacturer: "Acme", isInstrument: false },
];

describe("PluginDock consumes pendingCollection via an effect (not a mount initialiser)", () => {
  let host: HTMLDivElement;
  let root: Root;
  const q = (id: string, collection?: string) => {
    if (!collection) return host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
    return host.querySelector(`[data-testid="${id}"][data-collection="${collection}"]`) as HTMLElement | null;
  };
  const activeCollectionId = () => q("v2-pb-collection", undefined) && host.querySelector('[data-testid="v2-pb-collection"][aria-selected="true"]')?.getAttribute("data-collection");
  const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); };

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    __resetMockForTests();
    useShell.setState({ browserOpen: false, browserTab: "sounds", pendingCollection: null });
    useStore.setState({ availablePlugins: SEED_PLUGINS, availableBuiltins: SEED_BUILTINS, selectedTrackId: "t1" } as never);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("openBrowserTab('plugins', 'inst') before mount lands the picker on Instruments", async () => {
    useShell.getState().openBrowserTab("plugins", "inst");
    await act(async () => { root.render(React.createElement(PluginDock)); });

    expect(activeCollectionId()).toBe("inst");
    // one-shot: consumed, not left sitting in the store for a later stray read
    expect(useShell.getState().pendingCollection).toBeNull();
  });

  it("a SECOND openBrowserTab('plugins', 'inst') while PluginDock stays mounted also lands on Instruments", async () => {
    // First request, consumed normally.
    useShell.getState().openBrowserTab("plugins", "inst");
    await act(async () => { root.render(React.createElement(PluginDock)); });
    expect(activeCollectionId()).toBe("inst");

    // The user clicks a different chip themselves — their own selection should stick
    // until another explicit request arrives.
    await click(q("v2-pb-collection", "fx")!);
    expect(activeCollectionId()).toBe("fx");

    // Now a SECOND "Add instrument..." request arrives while the dock is already
    // mounted (drawer already open on Plugins — exactly LeftDrawer's non-remounting
    // case). A mount-time useState initialiser can never see this; only a
    // subscribed-effect consumer can.
    await act(async () => { useShell.getState().openBrowserTab("plugins", "inst"); });

    expect(activeCollectionId()).toBe("inst");
    expect(useShell.getState().pendingCollection).toBeNull();
  });

  it("StrictMode double-invocation still lands on Instruments (failure mode 1)", async () => {
    useShell.getState().openBrowserTab("plugins", "inst");
    await act(async () => {
      root.render(React.createElement(React.StrictMode, null, React.createElement(PluginDock)));
    });

    expect(activeCollectionId()).toBe("inst");
    expect(useShell.getState().pendingCollection).toBeNull();
  });

  it("opening with no collection leaves the default 'All Plugins' view untouched", async () => {
    useShell.getState().openBrowserTab("plugins");
    await act(async () => { root.render(React.createElement(PluginDock)); });

    expect(activeCollectionId()).toBe("all");
  });
});
