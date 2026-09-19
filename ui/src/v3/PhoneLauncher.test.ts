import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhoneLauncher } from "./PhoneLauncher";
import { useV3 } from "./shellState";
import { useStore } from "../store";
import type { RemoteStatus } from "../bridge";
import { escapeStackDepth } from "../hooks/escapeStack";

const { QR_DATA_URL, toDataURL } = vi.hoisted(() => {
  const url = "data:image/png;base64,MOCKQR";
  return { QR_DATA_URL: url, toDataURL: vi.fn(async () => url) };
});
vi.mock("qrcode", () => ({ toDataURL, default: { toDataURL } }));

const TOKEN = "9f".repeat(32);
const PAD_URL = `http://192.168.1.80:47873/pad#token=${TOKEN}`;

const paired: RemoteStatus = {
  running: true,
  port: 47873,
  pairing: {
    host: "192.168.1.80", port: 47873, token: TOKEN, expiresAtMs: 1,
    pairingUrl: "mosh://pair?payload=MOCK",
    webUrl: "http://192.168.1.80:47873/web?payload=MOCK",
    padUrl: PAD_URL,
  },
};

describe("v3 Phone launcher", () => {
  let host: HTMLDivElement;
  let root: Root;
  let start: ReturnType<typeof vi.fn>;
  let stop: ReturnType<typeof vi.fn>;
  const original = { start: useStore.getState().startRemotePairing, stop: useStore.getState().stopRemote };

  const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    toDataURL.mockClear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    start = vi.fn(async () => { useStore.setState({ remoteStatus: paired }); });
    stop = vi.fn(async () => { useStore.setState({ remoteStatus: { running: false, port: 0 } }); });
    useStore.setState({ remoteStatus: null, lastError: null, startRemotePairing: start, stopRemote: stop });
    useV3.setState({ phoneOpen: true, mpOpen: false, historyOpen: false });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useV3.setState({ phoneOpen: false });
    useStore.setState({ remoteStatus: null, startRemotePairing: original.start, stopRemote: original.stop });
    expect(escapeStackDepth()).toBe(0);
  });

  it("starts the phone server exactly once and shows the /pad QR, never the mosh:// link", async () => {
    act(() => root.render(React.createElement(PhoneLauncher)));
    await flush();
    act(() => root.render(React.createElement(PhoneLauncher)));   // a re-render must not re-start it
    await flush();

    expect(start).toHaveBeenCalledTimes(1);
    const img = host.querySelector<HTMLImageElement>('[data-testid="v3-phone-qr"]');
    expect(img).not.toBeNull();
    expect(img!.src).toBe(QR_DATA_URL);
    expect(toDataURL).toHaveBeenCalledWith(PAD_URL, expect.anything());
    const url = host.querySelector('[data-testid="v3-phone-url"]');
    expect(url!.textContent).toBe(PAD_URL);
    expect(url!.textContent).toContain("/pad#token=");
    expect(host.textContent).not.toContain("mosh://");
    expect(host.textContent).not.toContain(".local");
  });

  it("does not start a second server when one is already paired", async () => {
    useStore.setState({ remoteStatus: paired });
    act(() => root.render(React.createElement(PhoneLauncher)));
    await flush();
    expect(start).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="v3-phone-url"]')!.textContent).toBe(PAD_URL);
  });

  it("reports the server starting, then the reason it could not", async () => {
    let fail: () => void = () => { throw new Error("the start never ran"); };
    start = vi.fn(() => new Promise<void>((resolve) => {
      fail = () => { useStore.setState({ lastError: "port 47873 is in use" }); resolve(); };
    }));
    useStore.setState({ startRemotePairing: start });
    act(() => root.render(React.createElement(PhoneLauncher)));
    const status = host.querySelector('[data-testid="v3-phone-status"]');
    expect(status).not.toBeNull();
    expect(status!.getAttribute("role")).toBe("status");
    expect(status!.textContent).toBe("Starting the phone server…");
    expect(host.querySelector('[data-testid="v3-phone-qr"]')).toBeNull();

    await act(async () => { fail(); });
    expect(host.querySelector('[data-testid="v3-phone-status"]')!.textContent)
      .toBe("Could not start the phone server: port 47873 is in use");
    expect(host.querySelector('[data-testid="v3-phone-qr"]')).toBeNull();
    act(() => useStore.setState({ lastError: null }));
  });

  it("closes on Escape and leaves the escape stack empty", async () => {
    act(() => root.render(React.createElement(PhoneLauncher)));
    await flush();
    expect(escapeStackDepth()).toBe(1);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(useV3.getState().phoneOpen).toBe(false);
    expect(host.querySelector('[data-testid="v3-phone-modal"]')).toBeNull();
  });

  it("Stop stops the server once and closes the dialog", async () => {
    act(() => root.render(React.createElement(PhoneLauncher)));
    await flush();
    const stopBtn = host.querySelector<HTMLButtonElement>('[data-testid="v3-phone-stop"]');
    expect(stopBtn).not.toBeNull();
    await act(async () => { stopBtn!.click(); });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(useV3.getState().phoneOpen).toBe(false);
  });

  it("is mutually exclusive with the multiplayer and history overlays", () => {
    useV3.setState({ phoneOpen: false, mpOpen: true, historyOpen: true, fileOpen: true, settingsOpen: true });
    act(() => useV3.getState().setPhoneOpen(true));
    expect(useV3.getState()).toMatchObject({ phoneOpen: true, mpOpen: false, historyOpen: false, fileOpen: false, settingsOpen: false });
    act(() => useV3.getState().setMpOpen(true));
    expect(useV3.getState()).toMatchObject({ phoneOpen: false, mpOpen: true });
    act(() => useV3.getState().setPhoneOpen(true));
    act(() => useV3.getState().setHistoryOpen(true));
    expect(useV3.getState()).toMatchObject({ phoneOpen: false, historyOpen: true });
    act(() => useV3.setState({ mpOpen: false, historyOpen: false, fileOpen: false, settingsOpen: false }));
  });
});
