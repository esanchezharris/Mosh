// Three asymmetries closed: rename_bus / remove_bus / set_master_plugin_param.
//
// None of these needed anything built from scratch — each was a control missing from a
// panel that already had its siblings. create_bus sat in the Sends section with no rename
// or remove beside it; the master rack could load, bypass, reorder and remove a plugin but
// not touch a single one of its parameters.
//
// The one that carries real weight is the bus delete. cmdRemoveBus deletes the return track
// AND sweeps the matching send off every track in the project — the mock reproduces that
// sweep faithfully — so it is confirm-gated, and the test below proves the sweep is what
// the copy warns about rather than taking the wording on trust.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Inspector } from "./inspector/Inspector";
import { MasterCard } from "./RightRail";
import { useStore } from "../store";
import { useShell } from "./shellState";
import { mockExecute, __resetMockForTests } from "../bridge.mock";
import type { CommandResult, Snapshot } from "../types";

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return { ...actual, onEvent: vi.fn(() => () => {}) };
});
// Heavy sibling panels pull the classic Dock / lyrics / drum-window stores.
vi.mock("../ui/Dock", () => ({ Rack: () => null, GenDrawer: () => null }));
vi.mock("./inspector/LyricPanel", () => ({ LyricPanel: () => null }));
vi.mock("../ui/dock/useFloatingWindow", () => ({ useDrumWindow: { getState: () => ({ open: () => {} }) } }));
vi.mock("../ui/Meter", () => ({ Meter: () => null, MasterMeter: () => null }));

const exec = (command: string, args: Record<string, unknown> = {}) =>
  mockExecute<CommandResult>({ command, args });

describe("bus rename/remove + master plugin params", () => {
  let host: HTMLDivElement;
  let root: Root;
  const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); };
  const refresh = async () => { await act(async () => { await useStore.getState().refresh(); }); };

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    __resetMockForTests();
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await refresh();
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  const openInspectorMix = async () => {
    const s = useStore.getState().snapshot as Snapshot;
    const track = s.tracks.find((t) => !t.isReturn && !t.isGroup)!;
    useStore.setState({ selectedTrackId: track.id } as never);
    useShell.setState({ inspectorTab: "mix" } as never);
    await act(async () => { root.render(React.createElement(Inspector)); });
    return track;
  };

  it("a bus can be renamed from the panel that creates one", async () => {
    await exec("create_bus", {});
    await refresh();
    await openInspectorMix();

    const bus = (useStore.getState().snapshot as Snapshot).buses![0];
    const name = q(`v2-bus-name-${bus.bus}`)!;
    await act(async () => { name.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });

    const input = q(`v2-bus-rename-${bus.bus}`) as HTMLInputElement;
    expect(input, "double-click did not open a rename field").toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "Plate");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await refresh();
    expect((useStore.getState().snapshot as Snapshot).buses![0].name).toBe("Plate");
  });

  it("an empty rename is ignored rather than blanking the bus", async () => {
    await exec("create_bus", {});
    await refresh();
    await openInspectorMix();
    const bus = (useStore.getState().snapshot as Snapshot).buses![0];
    const before = bus.name;

    await act(async () => { q(`v2-bus-name-${bus.bus}`)!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    const input = q(`v2-bus-rename-${bus.bus}`) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "   ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await refresh();
    expect((useStore.getState().snapshot as Snapshot).buses![0].name).toBe(before);
  });

  it("deleting a bus asks first, and cancelling changes nothing", async () => {
    await exec("create_bus", {});
    await refresh();
    await openInspectorMix();
    const bus = (useStore.getState().snapshot as Snapshot).buses![0];

    await click(q(`v2-bus-remove-${bus.bus}`)!);
    expect(q("v2-bus-remove-confirm"), "deleted a project-wide bus on one click").toBeTruthy();

    const cancel = [...host.querySelectorAll(".confirm-actions button")].find((b) => /cancel/i.test(b.textContent ?? ""))!;
    await click(cancel);
    await refresh();
    expect((useStore.getState().snapshot as Snapshot).buses).toHaveLength(1);
  });

  it("confirming removes the bus AND the sends pointing at it, on every track", async () => {
    await exec("create_bus", {});
    await refresh();
    const s0 = useStore.getState().snapshot as Snapshot;
    const bus = s0.buses![0];
    // Two different tracks send to it — the sweep is the part a producer cannot undo by
    // simply re-adding the bus, and it is what the confirm copy promises.
    const targets = s0.tracks.filter((t) => !t.isReturn && !t.isGroup).slice(0, 2);
    for (const t of targets) await exec("add_send", { trackId: t.id, bus: bus.bus, db: 0 });
    await refresh();
    expect((useStore.getState().snapshot as Snapshot).tracks.filter((t) => (t.sends?.length ?? 0) > 0)).toHaveLength(2);

    await openInspectorMix();
    await click(q(`v2-bus-remove-${bus.bus}`)!);
    const go = [...host.querySelectorAll(".confirm-actions button")].find((b) => /delete bus/i.test(b.textContent ?? ""))!;
    await click(go);
    await refresh();

    const s1 = useStore.getState().snapshot as Snapshot;
    expect(s1.buses ?? []).toHaveLength(0);
    expect(s1.tracks.some((t) => (t.sends ?? []).some((x) => x.bus === bus.bus)), "left an orphan send behind").toBe(false);
  });

  it("the master rack can move a plugin parameter, not just load and bypass one", async () => {
    const before = (useStore.getState().snapshot as Snapshot).master?.plugins ?? [];
    await exec("load_master_plugin", { pluginId: "ott" });   // a bus compressor, as you would
    await refresh();
    const plugins = (useStore.getState().snapshot as Snapshot).master!.plugins!;
    expect(plugins.length, "mock did not load a master plugin to test against").toBeGreaterThan(before.length);
    const target = plugins[plugins.length - 1];
    const param = (target.params ?? [])[0];
    expect(param, "master plugin carries no params — nothing to prove").toBeTruthy();

    await act(async () => { root.render(React.createElement(MasterCard)); });
    // Collapsed by default: the rack's job is the chain, and eight sliders per row buries it.
    expect(q(`v2-master-param-${param.index}`)).toBeFalsy();
    await click(q("v2-master-plugin-params-toggle")!);

    const slider = q(`v2-master-param-${param.index}`) as HTMLInputElement;
    expect(slider).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(slider, "0.75");
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await refresh();
    const after = (useStore.getState().snapshot as Snapshot).master!.plugins!.find((p) => p.index === target.index)!;
    expect(after.params!.find((p) => p.index === param.index)!.value).toBeCloseTo(0.75, 5);
  });
});
