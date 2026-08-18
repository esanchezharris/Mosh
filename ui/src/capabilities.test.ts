import { describe, expect, it } from "vitest";
import { AI_SETUP_HINT, isTransformPreview, trainingPreviewLabel, trainingBlockers, transcriptionMenuEnabled } from "./capabilities";
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
  it("does NOT call a real local fine-tune a preview", () => {
    // local_pmetal drives the bundled trainer and produces a .safetensors the
    // render path loads unmodified — labelling that "preview" would be a lie,
    // and it is the whole point of the local trainer landing.
    expect(trainingPreviewLabel({ ...full, trainingBackend: "local_pmetal" })).toBeNull();
  });
  it("still labels an unrecognised backend as preview", () => {
    // Fail closed: an unknown backend is more likely a stub than a real one.
    expect(trainingPreviewLabel({ ...full, trainingBackend: "something_new" })).toBe("preview");
  });
});

describe("trainingBlockers", () => {
  it("is empty when nothing is blocking", () => {
    expect(trainingBlockers(full)).toEqual([]);
    expect(trainingBlockers(null)).toEqual([]);
  });
  it("surfaces why a real backend still cannot train", () => {
    const blocked = { ...full, trainingBackend: "local_pmetal",
                      trainingBlockers: ["SA3 base checkpoint not found (set MOSH_SA3_BASE_DIT…)"] };
    expect(trainingBlockers(blocked)).toHaveLength(1);
    expect(trainingBlockers(blocked)[0]).toContain("MOSH_SA3_BASE_DIT");
    // A blocked-but-real backend is still not a "preview" — it is a real
    // trainer missing an asset, and the UI must say that instead.
    expect(trainingPreviewLabel(blocked)).toBeNull();
  });
});
