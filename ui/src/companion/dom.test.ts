import { beforeEach, describe, expect, it } from "vitest";
import type { ControllerView } from "./adapter";
import { renderControllerStatus, renderNavigator } from "./dom";

const abletonView: ControllerView = {
  mode: "ableton",
  unit: "beats",
  revision: 4,
  position: 6,
  length: 12,
  regions: [
    { kind: "pending", start: 4, end: 8 },
    { kind: "archive", start: 0, end: 4 },
  ],
  statuses: ["blocked", "recording", "pending"],
  seekEnabled: false,
  blockedReason: "pending_ownership_uncertain",
};

function mountControllerDom(): void {
  document.body.innerHTML = `
    <div id="stateTxt"></div>
    <div id="sub"></div>
    <div id="toast"></div>
    <div id="nav"></div>`;
}

describe("companion controller rendering", () => {
  beforeEach(mountControllerDom);

  it("keeps an Ableton blocked reason visible in the resting status DOM", () => {
    // Given / When
    renderControllerStatus(abletonView, false);

    // Then
    const toast = document.getElementById("toast");
    expect(toast?.textContent).toBe("pending_ownership_uncertain");
    expect(toast?.dataset.persistent).toBe("true");
  });

  it("renders pending and archive regions with distinct semantic identities", () => {
    // Given / When
    renderNavigator(abletonView, (playhead, fraction) => {
      playhead.style.left = `${fraction * 100}%`;
    });

    // Then
    const regions = Array.from(document.querySelectorAll<HTMLElement>(".region"));
    expect(regions.map((region) => region.dataset.kind)).toEqual(["pending", "archive"]);
    expect(regions.map((region) => region.getAttribute("aria-label"))).toEqual([
      "Pending take, beats 4 to 8",
      "Archived take, beats 0 to 4",
    ]);
  });

  it("exposes and visibly classifies a recording-disabled navigator", () => {
    // Given / When
    renderNavigator(abletonView, () => undefined);

    // Then
    const navigator = document.getElementById("nav");
    expect(navigator?.getAttribute("role")).toBe("slider");
    expect(navigator?.getAttribute("aria-disabled")).toBe("true");
    expect(navigator?.getAttribute("aria-valuetext")).toBe("Beat 6 of 12; seek locked while recording");
    expect(navigator?.dataset.disabledReason).toBe("recording");
  });
});
