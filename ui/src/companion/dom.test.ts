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
    <div id="toast" role="status" aria-live="polite"></div>
    <div id="navWrap">
      <div id="nav"></div>
      <div id="navRegions"></div>
    </div>`;
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

  it("describes pending and archive regions outside the slider descendants", () => {
    // Given / When
    renderNavigator(abletonView, (playhead, fraction) => {
      playhead.style.left = `${fraction * 100}%`;
    });

    // Then
    const navigator = document.getElementById("nav");
    const descriptions = document.getElementById("navRegions");
    const regions = Array.from(descriptions?.children ?? []);
    expect(navigator?.getAttribute("aria-describedby")).toBe("navRegions");
    expect(navigator?.contains(descriptions)).toBe(false);
    expect(regions.map((region) => region.getAttribute("data-kind"))).toEqual(["pending", "archive"]);
    expect(regions.map((region) => region.textContent)).toEqual([
      "Pending take, beats 4 to 8",
      "Archived take, beats 0 to 4",
    ]);
    const visualRegions = Array.from(document.querySelectorAll("#nav .region"));
    expect(visualRegions.every((region) => region.getAttribute("aria-hidden") === "true")).toBe(true);
  });

  it("exposes and visibly classifies a recording-disabled navigator", () => {
    // Given / When
    renderNavigator(abletonView, () => undefined);

    // Then
    const navigator = document.getElementById("nav");
    expect(navigator?.getAttribute("role")).toBe("slider");
    expect(navigator?.tabIndex).toBe(0);
    expect(navigator?.getAttribute("aria-disabled")).toBe("true");
    expect(navigator?.getAttribute("aria-valuetext")).toBe("Beat 6 of 12; seek locked while recording");
    expect(navigator?.dataset.disabledReason).toBe("recording");
  });

  it("does not mutate the live region when the blocked reason is unchanged", async () => {
    // Given
    renderControllerStatus(abletonView, false);
    const toast = document.getElementById("toast");
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    if (toast !== null) {
      observer.observe(toast, { attributes: true, childList: true, characterData: true, subtree: true });
    }

    // When
    renderControllerStatus(abletonView, false);
    await Promise.resolve();
    observer.disconnect();

    // Then
    expect(toast?.textContent).toBe("pending_ownership_uncertain");
    expect(mutations).toEqual([]);
  });
});
