// The chrome seam's contract, in jsdom: MoshTip renders no native title and shows its
// label on hover. The BEHAVIOUR (flip/clamp/stacking) is Base UI's — this file only pins
// that the wrapper wires props through, so future migrations can copy the pattern safely.
//
// React.createElement, not JSX: the repo's vitest include is src/**/*.test.ts only.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    document.body.querySelectorAll(".mosh-tip").forEach((n) => n.remove());
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
