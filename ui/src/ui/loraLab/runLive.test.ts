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
  /** What successive training_job_status reads return; the last one repeats.
   *  `{ fail }` answers the read with that error instead, as native does. */
  let replies: Record<string, unknown>[];
  /** What cancel_training_job answers; `{ fail }` as above. */
  let cancelReply: Record<string, unknown>;

  const polls = () => calls.filter((c) => c.command === "training_job_status").length;
  const byId = (id: string) => host.querySelector(`[data-testid="${id}"]`);
  const tick = (ms = 1000) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    calls = [];
    replies = [];
    cancelReply = { status: "running", cancelRequested: true };
    const answer = (command: string, reply: Record<string, unknown>) =>
      typeof reply.fail === "string"
        ? { ok: false, command, error: reply.fail }
        : { ok: true, command, data: { jobId: "job-1", ...reply } };
    vi.mocked(executeCommand).mockImplementation((async (req: Req) => {
      calls.push(req);
      switch (req.command) {
        case "build_training_corpus":
          return { ok: true, data: { bundlePath: "/mock/training/corpora/corpus-002", sourceCount: 2 } };
        case "submit_training_job":
          return { ok: true, data: { jobId: "job-1" } };
        case "training_job_status":
          return answer(req.command, (replies.length > 1 ? replies.shift() : replies[0])!);
        case "cancel_training_job":
          return answer(req.command, cancelReply);
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
      // No phase: a remote trainer reports none for its whole run, so all that
      // is known is that it is running.
      { status: "running", detail: {} },
      // The local trainer encoding the corpus, before any step.
      { status: "running", detail: { phase: "precompute", precomputed: 3, clips: 10 } },
      { status: "running", detail: { phase: "training", step: 40, totalSteps: 600, etaSeconds: 1200 } },
      // The trainer has exited ("ready" is ITS state, flushed with its last
      // ETA); the job is still running while the service collects the last
      // takes. The ETA from the training poll is kept in the store, so only the
      // phase can hide it.
      { status: "running", detail: { phase: "ready", step: 600, totalSteps: 600, etaSeconds: 1200 } },
      { status: "ready", detail: { phase: "ready", step: 600, totalSteps: 600 } },
    ];

    await tick();
    expect(pill(), "a queued job is waiting for the trainer").toBe("queued");
    await tick();
    expect(pill(), "a running job with no phase is just running").toBe("running");
    expect(byId("lab-eta")).toBeNull();
    await tick();
    expect(pill(), "the local trainer encoding the corpus is preparing").toBe("preparing");
    expect(byId("lab-epochs")?.textContent, "how many clips are encoded so far").toBe("3");
    expect(host.querySelector(".lab-epochs-of")?.textContent).toBe("of 10 clips prepared");
    await tick();
    expect(pill()).toBe("training");
    expect(host.querySelector(".lab-epochs-of")?.textContent, "epochs once training starts").toMatch(/epochs$/);
    expect(byId("lab-eta"), "a training run reporting an ETA shows it").toBeTruthy();
    await tick();
    expect(pill(), "the trainer is done but the job is not").toBe("finishing");
    expect(byId("lab-eta"), "no time left is shown once training is over").toBeNull();
    await tick();
    expect(pill()).toBe("done");
  });

  // The final adapter is published only after the trainer exits, so it arrives in
  // the finished run's result, never in its progress. Reading progress alone left
  // the sheet without the take the run was for (seen on a real local run).
  it("offers the final take once the run is done", async () => {
    const take = (step: number, isFinal = false) => ({ name: `run-1@${isFinal ? "final" : step}`, step, isFinal });
    replies = [
      { status: "running", detail: { phase: "training", step: 12, totalSteps: 24, takes: [take(12)] } },
      { status: "ready", detail: { phase: "ready", step: 24, totalSteps: 24, takes: [take(12), take(24)] },
        result: { takes: [take(12), take(24), take(24, true)] } },
    ];

    await tick();
    expect(byId("lab-take-run-1@12")).toBeTruthy();
    expect(byId("lab-take-run-1@final")).toBeNull();
    await tick();
    expect(byId("lab-run-status")?.textContent).toBe("done");
    const final = byId("lab-take-run-1@final");
    expect(final, "no Final row after the run finished").toBeTruthy();
    expect(final?.textContent).toContain("Final");
    expect(useStore.getState().labTakes.map((t) => t.name).sort(), "each take once")
      .toEqual(["run-1@12", "run-1@24", "run-1@final"]);
  });

  it("counts one approved clip as one clip on the Train button", async () => {
    replies = [{ status: "ready", detail: {} }];
    act(() => useStore.setState({ snapshot: { tracks: [], training: { sources: [{ eligible: true }] } } } as never));
    await tick();
    expect(byId("lab-train")?.querySelector(".lab-go-n")?.textContent).toBe("1 clip");
    act(() => useStore.setState({
      snapshot: { tracks: [], training: { sources: [{ eligible: true }, { eligible: true }, { eligible: false }] } },
    } as never));
    expect(byId("lab-train")?.querySelector(".lab-go-n")?.textContent).toBe("2 clips");
    act(() => useStore.setState({ snapshot: null } as never));
  });

  // The service keeps jobs in memory only. If it dies or restarts mid-run, every
  // later read of the run answers "unknown jobId", and the run must end here, or
  // the Lab polls forever and the producer can never train again without
  // restarting the app.
  it("ends a run the service no longer knows as failed, and stops polling", async () => {
    replies = [{ status: "running", detail: { phase: "training" } }, { fail: "unknown jobId" }];

    await tick();
    expect(byId("lab-stop")).toBeTruthy();
    await tick();
    expect(polls()).toBe(2);
    expect(byId("lab-stop"), "Stop stayed up on a run the service no longer has").toBeNull();
    expect(byId("lab-train"), "Train did not come back").toBeTruthy();
    expect(byId("lab-run-status")?.textContent).toBe("failed");
    expect(useStore.getState().labRun?.error).toMatch(/no longer has this run/);

    await tick(5000);
    expect(polls(), "still polling a run the service no longer has").toBe(2);
  });

  it("keeps a run live through a status read that fails for another reason", async () => {
    replies = [{ status: "running", detail: { phase: "training" } }, { fail: "job lookup failed" }];

    await tick();
    await tick(3000);
    expect(polls(), "a failed read stopped the poll").toBe(4);
    expect(byId("lab-stop"), "a failed read took Stop away from a run that may still be going").toBeTruthy();
    expect(useStore.getState().labRun?.status).toBe("running");
  });

  it("Stop ends the run here when the cancel cannot reach it", async () => {
    replies = [{ status: "running", detail: { phase: "training" } }, { fail: "training service unavailable" }];
    cancelReply = { fail: "training service unavailable" };
    await tick(3000);
    expect(byId("lab-stop")).toBeTruthy();

    await act(async () => { (byId("lab-stop") as HTMLButtonElement).click(); });
    expect(calls.some((c) => c.command === "cancel_training_job")).toBe(true);
    expect(byId("lab-stop"), "Stop did nothing").toBeNull();
    expect(byId("lab-train"), "Train did not come back after Stop").toBeTruthy();
    // Failed, with the reason, never "stopped": nothing confirmed the trainer stopped.
    expect(byId("lab-run-status")?.textContent).toBe("failed");
    expect(useStore.getState().labRun?.error).toMatch(/could not stop this run: training service unavailable/);

    const after = polls();
    await tick(5000);
    expect(polls(), "still polling after Stop gave up on the run").toBe(after);
  });

  it("Stop that reaches the run leaves the end to the service", async () => {
    replies = [{ status: "running", detail: { phase: "training" } }];
    await tick();

    await act(async () => { (byId("lab-stop") as HTMLButtonElement).click(); });
    expect(byId("lab-stop"), "a delivered stop ended the run before the service said so").toBeTruthy();
    expect(useStore.getState().labRun?.status).toBe("running");

    replies = [{ status: "cancelled", detail: { phase: "cancelled" } }];
    await tick();
    expect(byId("lab-run-status")?.textContent).toBe("stopped");
    expect(byId("lab-train")).toBeTruthy();
  });
});
