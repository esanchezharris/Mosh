import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingSetup } from "./RecordingSetup";
import { microphonePermissionStatus, requestMicrophonePermission } from "../bridge";

vi.mock("../bridge", () => ({
  microphonePermissionStatus: vi.fn(),
  requestMicrophonePermission: vi.fn(),
}));

const statusMock = vi.mocked(microphonePermissionStatus);
const requestMock = vi.mocked(requestMicrophonePermission);

describe("RecordingSetup", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    statusMock.mockResolvedValue({ status: "not-determined" });
    requestMock.mockResolvedValue({ status: "granted" });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.clearAllMocks();
  });

  it("checks status at launch without requesting microphone access", async () => {
    await act(async () => { root.render(React.createElement(RecordingSetup)); });
    expect(statusMock).toHaveBeenCalledOnce();
    expect(requestMock).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Set up audio recording");
  });

  it("requests microphone access only after the setup button is clicked", async () => {
    await act(async () => { root.render(React.createElement(RecordingSetup)); });
    const button = host.querySelector('[data-testid="recording-setup"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error("recording setup button missing");

    await act(async () => { button.click(); });

    expect(requestMock).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Audio recording is ready");
  });
});
