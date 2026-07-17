import { describe, expect, it } from "vitest";
import { AI_SETUP_HINT, isTransformPreview, trainingPreviewLabel, transcriptionMenuEnabled } from "./capabilities";
import type { ServiceCapabilities } from "./types";

const full: ServiceCapabilities = {
  transcribe: true, skeleton: true, whisper: true, phonology: true,
  transformReal: true, trainingBackend: "fake",
};
const guest: ServiceCapabilities = {
  transcribe: false, skeleton: false, whisper: false, phonology: false,
  transformReal: false, trainingBackend: "fake",
};

describe("transcriptionMenuEnabled", () => {
  it("enabled when transcribe is installed", () => {
    expect(transcriptionMenuEnabled(full)).toBe(true);
  });
  it("disabled on a guest Mac with no transcribe venv", () => {
    expect(transcriptionMenuEnabled(guest)).toBe(false);
  });
  it("treats unresolved capabilities (null/undefined) as enabled — never flash-disables", () => {
    expect(transcriptionMenuEnabled(null)).toBe(true);
    expect(transcriptionMenuEnabled(undefined)).toBe(true);
  });
  it("is independent of skeleton/whisper/phonology — transcribe alone gates it", () => {
    expect(transcriptionMenuEnabled({ ...full, skeleton: false, whisper: false, phonology: false })).toBe(true);
  });
  it("AI_SETUP_HINT names the fix", () => {
    expect(AI_SETUP_HINT).toContain("setup-guest.sh");
  });
});

describe("isTransformPreview", () => {
  it("false when a real RAVE model is installed", () => {
    expect(isTransformPreview(full)).toBe(false);
  });
  it("true on a guest Mac with no RAVE models", () => {
    expect(isTransformPreview(guest)).toBe(true);
  });
  it("hides the label (false) when capabilities are unresolved — avoids a wrong flash", () => {
    expect(isTransformPreview(null)).toBe(false);
    expect(isTransformPreview(undefined)).toBe(false);
  });
});

describe("trainingPreviewLabel", () => {
  it("labels the fake backend as preview", () => {
    expect(trainingPreviewLabel(full)).toBe("preview");
    expect(trainingPreviewLabel(guest)).toBe("preview");
  });
  it("shows nothing once a real remote backend is configured", () => {
    expect(trainingPreviewLabel({ ...full, trainingBackend: "remote_http" })).toBeNull();
  });
  it("shows nothing while capabilities are unresolved", () => {
    expect(trainingPreviewLabel(null)).toBeNull();
    expect(trainingPreviewLabel(undefined)).toBeNull();
  });
});
