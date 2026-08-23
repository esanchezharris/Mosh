import { AbletonAdapter, MoshAdapter, type AdapterResult, type ControllerAdapter, type ControllerView } from "./adapter";
import { AbletonHttpClient } from "./abletonClient";
import { consumeLaunch, type CompanionLaunch } from "./launch";
import * as layoutModel from "./layout";
import { CompanionNet } from "./net";
import * as nav from "./navMath";
import { NavigatorDragController } from "./navigatorDrag";
import { buttonLabel, mountPadTiles } from "./padView";
import { TileDragController, type EditableTileLayout } from "./tileDrag";
import type { Button } from "./types";
import { disconnectedView } from "./viewState";
import { element, renderControllerStatus, renderNavigator } from "./dom";

class LaunchVariantError extends Error {
  readonly name = "LaunchVariantError";
  constructor(_launch: never) {
    super("unsupported companion launch variant");
  }
}

function createAdapter(launch: CompanionLaunch): ControllerAdapter {
  switch (launch.kind) {
    case "mosh":
      return new MoshAdapter(new CompanionNet(launch.pairing));
    case "ableton":
      return new AbletonAdapter(new AbletonHttpClient(launch.token));
    default:
      throw new LaunchVariantError(launch);
  }
}

let adapter: ControllerAdapter | null = null;
let view: ControllerView | null = null;
let layout = layoutModel.parse(null);
let editing = false;
let navigatorDrag: NavigatorDragController | null = null;
let lastSeekAt = 0;
let polling = false;

function toast(text: string): void {
  element("toast").textContent = text;
}

function applyOrder(): void {
  const current = adapter;
  if (current === null) return;
  const grid = element("pad");
  for (const button of layoutModel.orderForTiles(layout, current.buttons)) {
    const tile = Array.from(grid.children).find(
      (child) => child instanceof HTMLElement && child.dataset.id === button,
    );
    if (tile instanceof HTMLElement) {
      tile.style.gridColumn = `span ${layoutModel.SPAN[button]}`;
      grid.append(tile);
    }
  }
}

function setEditing(value: boolean): void {
  editing = value;
  document.body.classList.toggle("editing", value);
  element("pad").classList.toggle("editing", value);
  toast(value ? "arrange your buttons — done when finished" : "");
}

function applyNavPosition(): void {
  element("navWrap").style.order = layout.navPos === "top" ? "-1" : "2";
  element("pad").style.order = "1";
  element("navPosBtn").textContent = `nav: ${layout.navPos}`;
}

function editorContract(): EditableTileLayout {
  return {
    isEditing: () => editing,
    enterEditing: () => setEditing(true),
    order: () => layoutModel.orderForTiles(layout, adapter?.buttons ?? []),
    setOrder: (order) => {
      layout = { ...layout, order };
    },
    applyOrder,
    save: () => layoutModel.save(localStorage, layout, adapter?.mode ?? "mosh"),
  };
}

function mountPad(): void {
  const current = adapter;
  if (current === null) return;
  const tiles = mountPadTiles(element("pad"), current.buttons, (button) => {
    if (!editing) void press(button);
  });
  const drag = new TileDragController(editorContract());
  tiles.forEach((tile, index) => {
    const button = current.buttons[index];
    if (button !== undefined) drag.attach(tile, button);
  });
  applyOrder();
}

function render(): void {
  const current = view;
  if (current === null) return;
  renderControllerStatus(current, adapter?.isBusy() ?? false);
  for (const child of Array.from(element("pad").children)) {
    if (child instanceof HTMLButtonElement) child.disabled = adapter?.isBusy() ?? false;
  }
  renderNavigator(current, (playhead, fallbackFraction) => {
    if (navigatorDrag === null) playhead.style.left = `${fallbackFraction * 100}%`;
    else navigatorDrag.placePlayhead(playhead, fallbackFraction);
  });
}

function resultText(result: AdapterResult, success: string): string {
  switch (result.kind) {
    case "ok": return success;
    case "busy": return "busy — wait for the current action";
    case "blocked": return result.reason;
    case "error": return result.reason;
  }
}

async function finishAction(pending: Promise<AdapterResult>, success: string): Promise<void> {
  render();
  try {
    const result = await pending;
    toast(resultText(result, success));
    await refresh();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unexpected companion error";
    view = disconnectedView(adapter?.mode ?? "mosh", reason);
    toast(reason);
    render();
  }
}

async function press(button: Button): Promise<void> {
  const current = adapter;
  if (current === null) return;
  await finishAction(current.press(button), buttonLabel(button).toLowerCase());
}

function seekTo(fraction: number, final = false): void {
  const currentAdapter = adapter;
  const currentView = view;
  if (currentAdapter === null || currentView === null) return;
  if (!currentView.seekEnabled) {
    toast(currentView.blockedReason ?? "seek is disabled while recording");
    return;
  }
  const now = Date.now();
  if (final) lastSeekAt = 0;
  if (now - lastSeekAt < 110) return;
  lastSeekAt = now;
  void finishAction(currentAdapter.seek(nav.clamp01(fraction) * currentView.length), "seek");
}

async function refresh(): Promise<void> {
  if (adapter === null || polling) return;
  polling = true;
  try {
    view = await adapter.poll();
    render();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unexpected companion error";
    view = disconnectedView(adapter.mode, reason);
    toast(reason);
    render();
  } finally {
    polling = false;
  }
}

function buildDom(): void {
  element("app").innerHTML = `
    <div id="top"><div id="banner"><div id="stateTxt">DISCONNECTED</div><div id="sub">connecting…</div></div><button id="editBtn" title="arrange" aria-label="Arrange tiles"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 16-.75 4.75L8 20l11-11-4-4L4 16Zm10-10 4 4m-9 9-4-4"/></svg></button></div>
    <div id="navWrap"><div id="nav" aria-disabled="true"><div id="playhead"></div></div></div>
    <div id="pad"></div>
    <div id="editbar"><button id="navPosBtn">nav: bottom</button><span class="hint">drag tiles to rearrange</span><button id="resetBtn">reset</button><button id="doneBtn">done</button></div>
    <div id="toast" role="status" aria-live="polite"></div>`;
  element("editBtn").addEventListener("click", () => setEditing(!editing));
  element("doneBtn").addEventListener("click", () => setEditing(false));
  element("resetBtn").addEventListener("click", () => {
    layout = layoutModel.parse(null);
    applyNavPosition();
    applyOrder();
    layoutModel.save(localStorage, layout, adapter?.mode ?? "mosh");
  });
  element("navPosBtn").addEventListener("click", () => {
    layout = { ...layout, navPos: layout.navPos === "bottom" ? "top" : "bottom" };
    applyNavPosition();
    layoutModel.save(localStorage, layout, adapter?.mode ?? "mosh");
  });
  const bar = element("nav");
  navigatorDrag = new NavigatorDragController(bar, {
    enabled: () => !editing && (view?.seekEnabled ?? true),
    seek: (fraction, final) => seekTo(fraction, final),
    cancel: () => {
      lastSeekAt = 0;
    },
  });
  navigatorDrag.attach();
}

function boot(): void {
  buildDom();
  try {
    const launch = consumeLaunch(location.href, (url) => history.replaceState(null, "", url));
    adapter = createAdapter(launch);
    layout = layoutModel.load(localStorage, adapter.mode);
    applyNavPosition();
    mountPad();
    void refresh();
    window.setInterval(() => void refresh(), 160);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unexpected companion error";
    view = disconnectedView("mosh", reason);
    toast(reason);
    render();
  }
}

boot();
