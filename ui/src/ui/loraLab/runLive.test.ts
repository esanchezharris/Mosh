// Whether a run is still going is decided by the status the training service
// reports — and the service reports exactly two live ones.
//
// service/server.py moves a training job queued -> running -> ready | error |
// cancelled, and the native relay (MoshOps cmdTrainingJobStatus) passes that
// status through untouched. "precompute" and "training" are PHASES of a running
// job (`detail.phase`), never a status. The Lab used to count only "training" and
// "precompute" as active, so on the native app the first real poll ("queued" or
// "running") ended the 1 s poll and swapped Stop for Train while the run carried
// on for 20-60 minutes, with no progress and no way to stop it from the Lab. The
// dev mock hid it: its job finishes on the first read, so a live status never
// reached the UI.
//
// These drive the real component and the real pollLabRun; only the bridge is
// scripted, replaying the statuses the service actually sends.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../bridge", async () => {
  const actual = await vi.importActual<typeof import("../../bridge")>("../../bridge");
  return { ...actual, executeCommand: vi.fn(), onEvent: vi.fn(() => () => {}) };
});

import { executeCommand } from "../../bridge";
import { useStore } from "../../store";
import { LoraLab } from "../LoraLab";
import { useLoraLab } from "../dock/useLoraLab";

type Req = { command: string; args: Record<string, unknown> };

describe("LoRA Lab — a run stays live for every status the service reports while it runs", () => {
  let host: HTMLDivElement;
  let root: Root;
  let calls: Req[];
  /** What successive training_job_status reads return; the last one repeats. */
  let replies: Record<string, unknown>[];

  const polls = () => calls.filter((c) => c.command === "training_job_status").length;
  const byId = (id: string) => host.querySelector(`[data-testid="${id}"]`);
  const tick = (ms = 1000) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    calls = [];
    replies = [];
    vi.mocked(executeCommand).mockImplementation((async (req: Req) => {
      calls.push(req);
      switch (req.command) {
        case "build_training_corpus":
          return { ok: true, data: { bundlePath: "/mock/training/corpora/corpus-002", sourceCount: 2 } };
        case "submit_training_job":
          return { ok: true, data: { jobId: "job-1" } };
        case "training_job_status":
          return { ok: true, data: { jobId: "job-1", ...(replies.length > 1 ? replies.shift() : replies[0]) } };
        default:
          return { ok: true, data: {} };
      }
    }) as never);

    useStore.getState().resetLab();
    // Opening the Lab fetches capabilities and the library, which spawns the
    // service in the real app — nothing here depends on either.
    useStore.setState({ loadCapabilities: async () => {}, loadLoras: async () => {} } as never);
    useLoraLab.getState().show();

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(React.createElement(LoraLab)));
    await act(async () => { await useStore.getState().startLabRun("ken-02"); });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useLoraLab.getState().close();
    vi.useRealTimers();
    vi.mocked(executeCommand).mockReset();
  });

  it("keeps polling and keeps Stop while the run is reported queued, then running", async () => {
    expect(byId("lab-stop"), "a just-submitted run offers Stop").toBeTruthy();
    replies = [
      { status: "queued", detail: {} },
      // Precompute: the job is running but the trainer has not reported yet.
      { status: "running", detail: {} },
      { status: "running", detail: { phase: "training", step: 40, totalSteps: 600, etaSeconds: 1200 } },
    ];

    for (let n = 1; n <= 4; n++) {
      await tick();
      expect(polls(), `poll ${n} never happened — the Lab stopped watching a live run`).toBe(n);
      expect(byId("lab-stop"), `Stop vanished after poll ${n} (${useStore.getState().labRun?.status})`).toBeTruthy();
      expect(byId("lab-train"), `Train came back after poll ${n} while the run was still going`).toBeNull();
    }
  });

  // ready / error / cancelled are what the service ends a run with. "completed" and
  // "failed" are names it never sends; they are here to pin that only the live
  // statuses keep a run going, so an unexpected status cannot leave the Lab polling.
  it.each(["ready", "error", "cancelled", "completed", "failed"])(
    "stops polling and puts Train back once the run is reported %s",
    async (end) => {
      replies = [{ status: "running", detail: {} }, { status: end, detail: {} }];

      await tick();
      expect(polls()).toBe(1);
      expect(byId("lab-stop"), "Stop vanished while the run was running").toBeTruthy();

      await tick();
      expect(polls()).toBe(2);
      expect(byId("lab-stop"), `Stop stayed up on a run reported ${end}`).toBeNull();
      expect(byId("lab-train"), `no Train after a run reported ${end}`).toBeTruthy();

      await tick(5000);
      expect(polls(), `still polling a run reported ${end}`).toBe(2);
    },
  );

  it("labels the header from the phase a running job is in", async () => {
    const pill = () => byId("lab-run-status")?.textContent;
    replies = [
      { status: "queued", detail: {} },
      { status: "running", detail: {} },
      { status: "running", detail: { phase: "training", step: 40, totalSteps: 600, etaSeconds: 1200 } },
    ];

    await tick();
    expect(pill(), "a queued job is waiting for the trainer").toBe("queued");
    await tick();
    expect(pill(), "running with no trainer report yet is precompute").toBe("preparing");
    expect(byId("lab-eta")).toBeNull();
    await tick();
    expect(pill()).toBe("training");
    expect(byId("lab-eta"), "a training run reporting an ETA shows it").toBeTruthy();
  });
});
