// What the "Add AI tools" card offers, from the snapshot (what is on disk) and the installer
// status (what it is doing): docs/AI-TOOLS-OPTIONAL-BRIEF-2026-11-02.md §5.4.

import { describe, expect, it } from "vitest";
import { parseAiToolsInstallStatus } from "../bridge";
import type { AiToolsSnapshot } from "../types";
import { aiToolsSetupView, aiToolsSize, offerAiTools } from "./aiToolsSetup";

const OFF: AiToolsSnapshot = { state: "off", pack: { python: "missing", sketch: "missing", transcribe: "missing" }, sa3: false, pythonSource: "" };
const MANAGED: AiToolsSnapshot = { state: "on", pack: { python: "ok", sketch: "ok", transcribe: "ok" }, sa3: false, pythonSource: "managed" };
const OWNER: AiToolsSnapshot = { state: "on", pack: { python: "ok", sketch: "ok", transcribe: "ok" }, sa3: true, pythonSource: "sa3" };
const st = (v: Record<string, unknown>) => parseAiToolsInstallStatus({ available: true, state: "idle", sizeEstimateMb: 850, ...v });

describe("aiToolsSetupView", () => {
  it("a friend's Mac: Install, with the size stated before the click", () => {
    const v = aiToolsSetupView(OFF, st({}));
    expect(v).toMatchObject({ phase: "off", status: "Not installed", size: "About 0.8 GB", canInstall: true, canCancel: false, canRemove: false });
    expect(offerAiTools(v)).toBe(true);
  });

  it("installing names the running step and offers Cancel only", () => {
    const v = aiToolsSetupView(OFF, st({ state: "installing", step: "sketch",
      steps: [{ id: "python", status: "done" }, { id: "sketch", status: "running" }] }));
    expect(v).toMatchObject({ phase: "installing", status: "Installing Beatbox → beat…", canInstall: false, canCancel: true, canRemove: false });
    expect(v.steps.map((s) => `${s.label}:${s.status}`)).toEqual(["Python:done", "Beatbox → beat:running", "Transcription:pending"]);
  });

  it("a failure keeps native's friend copy and the log tail, and offers Try again", () => {
    const v = aiToolsSetupView(OFF, st({ state: "failed", error: "Couldn't install the beatbox tool.", detail: "error: x" }));
    expect(v).toMatchObject({ phase: "failed", canInstall: true, error: "Couldn't install the beatbox tool.", detail: "error: x" });
    expect(offerAiTools(v)).toBe(true);
  });

  it("installed by Mosh: Remove; missing transcription: finish installing", () => {
    expect(aiToolsSetupView(MANAGED, st({ state: "done" }))).toMatchObject({ phase: "on", status: "On", canInstall: false, canRemove: true });
    const partial = aiToolsSetupView({ ...MANAGED, pack: { ...MANAGED.pack, transcribe: "missing" } }, st({}));
    expect(partial).toMatchObject({ phase: "partial", canInstall: true, canRemove: true });
    expect(offerAiTools(partial)).toBe(false);
  });

  it("the owner's own setup is never offered Install or Remove", () => {
    const v = aiToolsSetupView(OWNER, st({}));
    expect(v).toMatchObject({ phase: "external", status: "On (set up outside Mosh)", canInstall: false, canRemove: false });
    expect(offerAiTools(v)).toBe(false);
  });

  it("a snapshot without aiTools (an older backend) reads as present, so nothing is offered", () => {
    expect(offerAiTools(aiToolsSetupView(undefined, st({})))).toBe(false);
  });

  it("a build that can't add them says why and offers nothing", () => {
    const v = aiToolsSetupView(OFF, parseAiToolsInstallStatus({ available: false, state: "unavailable", error: "This build of Mosh can't add AI tools." }));
    expect(v).toMatchObject({ phase: "unavailable", status: "This build of Mosh can't add AI tools.", canInstall: false, canRemove: false });
    expect(offerAiTools(v)).toBe(false);
    expect(aiToolsSetupView(OFF, parseAiToolsInstallStatus(undefined)).status).toBe("This build of Mosh can't add AI tools.");
  });

  it("sizes", () => {
    expect(aiToolsSize(850)).toBe("About 0.8 GB");
    expect(aiToolsSize(0)).toBe("About 0.8 GB");
    expect(aiToolsSize(2048)).toBe("About 2.0 GB");
  });
});
