// A11y guard: the three in-flight "working" clip badges (transcribing… / lyrics… /
// flow…) must announce to screen readers with the shell-wide convention
// `role="status" aria-live="polite"` (matching RightRail / PluginBrowser / ChangeToast /
// TrackLaneList). Without it a build starts with no SR announcement. Same
// createRoot + act render pattern as the sibling Inspector.warp.test.ts; a generic
// (non-wave, non-midi) clip keeps the render hermetic — it skips ClipView's wave-only
// ensurePeaks fetch and the MIDI/drum canvas renderers, leaving just label + badges.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClipView } from "./ClipView";
import { useStore } from "../../store";
import type { Clip, Snapshot } from "../../types";

function blockClip(): Clip {
  return { id: "c1", name: "take", type: "block", start: 0, length: 4, offset: 0, hasRenderLayer: false } as unknown as Clip;
}
function makeSnapshot(): Snapshot {
  return { schemaVersion: 1, session: {}, tracks: [] } as unknown as Snapshot;
}

describe("v2 ClipView working badges — SR announcement", () => {
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
    useStore.setState({ transcribing: {}, buildingLyrics: {}, buildingSkeleton: {} });
  });

  function render() {
    act(() => {
      root.render(React.createElement(ClipView, { clip: blockClip(), trackType: "audio", snapshot: makeSnapshot() }));
    });
  }

  it.each([
    ["clip-transcribing", { transcribing: { c1: true } }],
    ["clip-building-lyrics", { buildingLyrics: { c1: true } }],
    ["clip-building-skeleton", { buildingSkeleton: { c1: true } }],
  ] as const)("the %s badge carries role=status + aria-live=polite", (testid, flags) => {
    act(() => useStore.setState(flags));
    render();
    const badge = host.querySelector(`[data-testid="${testid}"]`);
    expect(badge).not.toBeNull();
    expect(badge!.getAttribute("role")).toBe("status");
    expect(badge!.getAttribute("aria-live")).toBe("polite");
  });
});
