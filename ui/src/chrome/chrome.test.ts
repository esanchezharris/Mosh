// The chrome seam's contract, in jsdom: MoshMenu opens on its trigger, routes a pick to
// the caller's handler, and closes; MoshTip renders no native title and shows its label
// on hover. The BEHAVIOUR (flip/clamp/Escape/stacking) is Base UI's and is covered in a
// real browser by v2-shell.spec / piano-roll.spec — this file only pins that the wrapper
// wires props through, so future migrations can copy the pattern safely.
//
// React.createElement, not JSX: the repo's vitest include is src/**/*.test.ts only.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MoshMenu, MoshMenuItem } from "./Menu";
import { MoshTip, MoshTipProvider } from "./Tooltip";

const h = React.createElement;

describe("chrome seam", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.querySelectorAll(".v2-menu-panel-floating, .mosh-tip").forEach((n) => n.remove());
  });

  it("MoshMenu opens from its trigger and a pick fires once, then closes", async () => {
    let picked = 0;
    act(() => root.render(
      h(MoshMenu, {
        label: "Add track",
        trigger: h("button", { "data-testid": "trig" }, "open"),
        children: h(MoshMenuItem, { testId: "item-a", onPick: () => picked++, children: "Audio" }),
      }),
    ));
    const trig = host.querySelector('[data-testid="trig"]') as HTMLButtonElement;
    expect(trig.getAttribute("aria-haspopup")).toBe("menu");
    expect(document.querySelector('[data-testid="item-a"]')).toBeNull();

    await act(async () => {
      trig.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const item = document.querySelector('[data-testid="item-a"]') as HTMLButtonElement | null;
    expect(item, "menu did not open").not.toBeNull();
    // role=menuitem comes from the library; the skin keeps it a real button.
    expect(item!.getAttribute("role")).toBe("menuitem");
    expect(item!.tagName).toBe("BUTTON");

    await act(async () => {
      item!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(picked).toBe(1);
    expect(document.querySelector('[data-testid="item-a"]'), "menu did not close after pick").toBeNull();
    // The Root remounts on close (the WKWebView desync guard — see Menu.tsx), so the
    // pre-pick node reference is stale; re-query for post-close state.
    const trig2 = host.querySelector('[data-testid="trig"]') as HTMLButtonElement;
    expect(trig2.getAttribute("aria-expanded")).toBe("false");
  });

  it("a pick remounts the Root, and the SAME menu reopens from the new trigger", async () => {
    let picked = 0;
    act(() => root.render(
      h(MoshMenu, {
        label: "Input",
        trigger: h("button", { "data-testid": "trig2" }, "open"),
        children: h(MoshMenuItem, { testId: "item-b", onPick: () => picked++, children: "Input 1" }),
      }),
    ));
    const trigBefore = host.querySelector('[data-testid="trig2"]') as HTMLButtonElement;
    await act(async () => {
      trigBefore.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const item = document.querySelector('[data-testid="item-b"]') as HTMLButtonElement;
    await act(async () => {
      item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(picked).toBe(1);
    // the close remounted the Root: the trigger is a NEW node (no cross-close residue
    // can persist — the packaged-WKWebView stuck-toggle guard)
    const trigAfter = host.querySelector('[data-testid="trig2"]') as HTMLButtonElement;
    expect(trigAfter).not.toBe(trigBefore);
    // and the same menu reopens cleanly from it
    await act(async () => {
      trigAfter.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.querySelector('[data-testid="item-b"]'), "menu did not reopen after a pick").not.toBeNull();
  });

  it("MoshTip carries no native title and merges onto its trigger", () => {
    // Show/hide on hover is Floating UI's behaviour and needs a real layout engine —
    // it is pinned in a browser by piano-roll.spec ("header controls show the styled
    // tooltip"). Here we pin only the wrapper's own contract: the trigger keeps its
    // element/props and NO native title survives (a leftover title double-tooltips).
    act(() => root.render(
      h(MoshTipProvider, {
        delay: 0,
        children: h(MoshTip, {
          label: "What this does",
          children: h("button", { "data-testid": "tip-trig" }, "hover"),
        }),
      }),
    ));
    const trig = host.querySelector('[data-testid="tip-trig"]') as HTMLButtonElement;
    expect(trig).not.toBeNull();
    expect(trig.tagName).toBe("BUTTON");
    expect(trig.hasAttribute("title"), "native title would double-tooltip").toBe(false);
  });
});
