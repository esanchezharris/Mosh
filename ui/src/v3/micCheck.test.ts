import { describe, expect, it } from "vitest";
import { MIC_COPY, micFromEngineError, micFromPermission } from "./micCheck";

describe("micFromPermission", () => {
  it("is ok when granted, and for an older bridge that cannot tell (unknown)", () => {
    for (const status of ["granted", "unknown"] as const) {
      expect(micFromPermission(status)).toEqual({ problem: "ok", text: "", audioSettings: false, retry: false });
    }
  });

  it("warns that macOS will ask when not determined, with nothing to retry", () => {
    expect(micFromPermission("not-determined")).toEqual({ problem: "ask", text: MIC_COPY.ask, audioSettings: false, retry: false });
  });

  it("offers Retry for denied", () => {
    expect(micFromPermission("denied")).toEqual({ problem: "denied", text: MIC_COPY.denied, audioSettings: false, retry: true });
  });

  it("offers no Retry for restricted (a policy, not a choice)", () => {
    expect(micFromPermission("restricted"))
      .toEqual({ problem: "restricted", text: MIC_COPY.restricted, audioSettings: false, retry: false });
  });

  it("offers Retry for a prompt nobody answered", () => {
    expect(micFromPermission("timed-out"))
      .toEqual({ problem: "timed-out", text: MIC_COPY["timed-out"], audioSettings: false, retry: true });
  });
});

describe("micFromEngineError", () => {
  it("is ok for an empty, blank or missing error", () => {
    for (const e of ["", "   ", null, undefined]) expect(micFromEngineError(e).problem).toBe("ok");
    expect(micFromEngineError(null).text).toBe("");
  });

  it("reads the permission-off refusal as denied", () => {
    const r = micFromEngineError("Microphone access is off for Mosh. Enable it in System Settings > Privacy & Security > Microphone, then arm the track again.");
    expect(r).toEqual({ problem: "denied", text: MIC_COPY.denied, audioSettings: false, retry: true });
  });

  it("reads the not-available refusal as restricted", () => {
    expect(micFromEngineError("Microphone access is not available on this Mac."))
      .toEqual({ problem: "restricted", text: MIC_COPY.restricted, audioSettings: false, retry: false });
  });

  it("reads the unfinished permission request as timed-out", () => {
    const r = micFromEngineError("The microphone permission request did not finish. Playback remains available; arm the track again to retry.");
    expect(r).toEqual({ problem: "timed-out", text: MIC_COPY["timed-out"], audioSettings: false, retry: true });
  });

  it.each(["No audio input device is available", "no input device"])("reads %j as no-device with Audio settings", (e) => {
    expect(micFromEngineError(e)).toEqual({ problem: "no-device", text: MIC_COPY["no-device"], audioSettings: true, retry: true });
  });

  it("reads an input that did not open in time as device-failed, without echoing the engine text", () => {
    const e = 'Audio input "MacBook Pro Microphone" did not open within 8s. Playback remains available, but recording input is off.';
    const r = micFromEngineError(e);
    expect(r.problem).toBe("device-failed");
    expect(r.audioSettings).toBe(true);
    expect(r.retry).toBe(true);
    expect(r.text.startsWith(MIC_COPY["device-failed"])).toBe(true);
    expect(r.text).toContain("took too long");
    expect(r.text).not.toContain("MacBook Pro Microphone");
  });

  it("reads an input that could not open as device-failed and keeps the engine's reason", () => {
    const e = 'Audio input "X" could not open: boom';
    const r = micFromEngineError(e);
    expect(r).toEqual({ problem: "device-failed", text: `${MIC_COPY["device-failed"]} ${e}`, audioSettings: true, retry: true });
  });

  it.each([
    "The audio input safety probe could not start",
    "The selected audio input setup is invalid or too large",
  ])("reads %j as device-failed pointing at Audio settings", (e) => {
    const r = micFromEngineError(e);
    expect(r.problem).toBe("device-failed");
    expect(r.audioSettings).toBe(true);
    expect(r.retry).toBe(true);
    expect(r.text).toBe(`${MIC_COPY["device-failed"]} Pick another input in Audio settings, then press Retry.`);
  });

  it("passes unknown text through verbatim under the device-failed lead", () => {
    const r = micFromEngineError("  CoreAudio said -50  ");
    expect(r).toEqual({ problem: "device-failed", text: `${MIC_COPY["device-failed"]} CoreAudio said -50`, audioSettings: true, retry: true });
  });
});
