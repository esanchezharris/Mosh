import type { ControllerView, TimelineRegion } from "./adapter";
import * as nav from "./navMath";

export class MissingElementError extends Error {
  readonly name = "MissingElementError";
  constructor(readonly elementId: string) {
    super(`missing companion element #${elementId}`);
  }
}

export function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new MissingElementError(id);
  return found;
}

export function setSubtitle(first: string, second: string): void {
  const subtitle = element("sub");
  subtitle.replaceChildren(document.createTextNode(first), document.createElement("br"), document.createTextNode(second));
}

function tickFractions(current: ControllerView): readonly number[] {
  if (current.unit === "seconds") {
    return nav.barTicks(current.length, current.tempo ?? 120, current.timeSigNumerator ?? 4);
  }
  const bars = Math.ceil(current.length / 4);
  const step = bars > 48 ? 8 : bars > 16 ? 4 : 1;
  return Array.from({ length: Math.max(0, Math.ceil(bars / step) - 1) }, (_, index) =>
    nav.clamp01(((index + 1) * step * 4) / current.length));
}

function regionLabel(region: TimelineRegion, unit: "seconds" | "beats"): string {
  const prefix = region.kind === "pending" ? "Pending take" : region.kind === "archive" ? "Archived take" : "Region";
  return `${prefix}, ${unit} ${region.start} to ${region.end}`;
}

function disabledReason(current: ControllerView): "recording" | "blocked" | "disconnected" | null {
  if (current.seekEnabled) return null;
  if (current.statuses.includes("recording")) return "recording";
  if (current.statuses.includes("blocked")) return "blocked";
  return "disconnected";
}

export function renderControllerStatus(current: ControllerView, busy: boolean): void {
  const statuses = busy ? ["busy", ...current.statuses.filter((status) => status !== "busy")] : current.statuses;
  element("stateTxt").textContent = statuses.map((status) => status.toUpperCase()).join(" · ");
  document.body.dataset.state = statuses.includes("recording")
    ? "REC"
    : statuses.includes("playing") ? "PLAY" : "PAUSED";
  if (current.mode === "mosh") {
    setSubtitle(`bar ${nav.secToBar(current.position, current.tempo ?? 120).toFixed(1)}`, "mosh live");
  } else {
    setSubtitle(`beat ${current.position.toFixed(1)}`, "ableton live");
  }
  const status = element("toast");
  if (current.mode === "ableton" && current.blockedReason !== undefined) {
    status.textContent = current.blockedReason;
    status.dataset.persistent = "true";
  } else if (status.dataset.persistent === "true") {
    status.textContent = "";
    delete status.dataset.persistent;
  }
}

export function renderNavigator(
  current: ControllerView,
  placePlayhead: (playhead: HTMLElement, fallbackFraction: number) => void,
): void {
  const bar = element("nav");
  const rects = nav.regionRects(current.regions.map((region) => ({ s: region.start, e: region.end })), current.length);
  const regionNodes = current.regions.map((region, index) => {
    const node = document.createElement("div");
    const rect = rects[index];
    node.className = `region region-${region.kind}`;
    node.dataset.kind = region.kind;
    node.setAttribute("role", "img");
    node.setAttribute("aria-label", regionLabel(region, current.unit));
    node.style.left = `${(rect?.left ?? 0) * 100}%`;
    node.style.width = `${(rect?.width ?? 0) * 100}%`;
    return node;
  });
  const tickNodes = tickFractions(current).map((fraction) => {
    const node = document.createElement("div");
    node.className = "tick";
    node.style.left = `${fraction * 100}%`;
    return node;
  });
  const playhead = document.createElement("div");
  playhead.id = "playhead";
  placePlayhead(playhead, nav.playheadFrac(current.position, current.length));
  bar.replaceChildren(...regionNodes, ...tickNodes, playhead);
  const reason = disabledReason(current);
  const unitLabel = current.unit === "beats" ? "Beat" : "Second";
  const locked = reason === null ? "" : `; seek locked ${reason === "recording" ? "while recording" : `— ${reason}`}`;
  bar.setAttribute("role", "slider");
  bar.setAttribute("aria-label", "Arrangement navigator");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", String(current.length));
  bar.setAttribute("aria-valuenow", String(current.position));
  bar.setAttribute("aria-valuetext", `${unitLabel} ${current.position} of ${current.length}${locked}`);
  bar.setAttribute("aria-disabled", String(!current.seekEnabled));
  if (reason === null) {
    delete bar.dataset.disabledReason;
    delete bar.dataset.disabledLabel;
  } else {
    bar.dataset.disabledReason = reason;
    bar.dataset.disabledLabel = reason === "recording" ? "SEEK LOCKED · RECORDING" : `SEEK LOCKED · ${reason.toUpperCase()}`;
  }
}
